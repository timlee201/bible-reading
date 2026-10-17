import crypto from 'node:crypto';
import {
  createTranscript,
  getParagraphs,
  getTranscript,
  isSparseTranscript,
  looksInterleaved,
  paragraphsFromUtterances,
  resolveWebhookUrl,
  uploadAudioStream,
} from './assemblyai.js';
import {
  SERIES_ID,
  findPublishedSession,
  normalizeCatalog,
  paragraphsForCatalog,
  paragraphsHaveTimes,
  sessionOrder,
  sessionTitle,
  upsertPublishedSession,
} from './catalog.js';
import { createHtmlFile, getDriveFile, openDriveDownload, shareFileWithAnyone, updateHtmlFile } from './google.js';
import { htmlFileName, renderTranscript } from './render.js';
import { createFileToken, refreshTokenFromFileToken } from './seal.js';
import { loadState, saveState } from './state.js';

const chains = new Map();
const materializeRuns = new Map();

function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  const settled = run.then(() => {}, () => {});
  chains.set(key, settled);
  settled.finally(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });
  return run;
}

function appOrigin() {
  return (process.env.APP_ORIGIN || '').trim().replace(/\/$/, '');
}

function renderJobHtml(job, paragraphs) {
  return renderTranscript({
    title: job.driveFileName || 'Transcript',
    paragraphs,
    originalParagraphs: job.originalParagraphs || [],
    appOrigin: appOrigin(),
    transcriptId: job.id,
    fileToken: job.fileToken,
  });
}

async function writeHtml(drive, job, html) {
  if (job.htmlFileId) {
    await updateHtmlFile(drive, job.htmlFileId, html);
    return job.htmlFileId;
  }
  if (!job.parentFolderId) {
    throw new Error('The recording has no Drive folder to save the transcript into');
  }
  return createHtmlFile(drive, {
    name: htmlFileName(job.driveFileName),
    parentFolderId: job.parentFolderId,
    html,
  });
}

export async function beginUploadJob(drive, fields) {
  const localId = `local_${crypto.randomBytes(9).toString('hex')}`;
  const job = {
    id: localId,
    driveFileId: fields.driveFileId,
    driveFileName: fields.driveFileName,
    parentFolderId: fields.parentFolderId,
    htmlFileId: null,
    fileToken: createFileToken(fields.refreshToken),
    status: 'uploading',
    error: null,
    originalParagraphs: [],
    createdAt: new Date().toISOString(),
  };
  await withLock(localId, async () => {
    const state = await loadState(drive);
    state.jobs[localId] = job;
    if (fields.refreshToken) state.refreshToken = fields.refreshToken;
    await saveState(drive, state);
  });
  return job;
}

export async function commitTranscriptJob(drive, localId, transcriptId) {
  return withLock(transcriptId, async () => {
    const state = await loadState(drive);
    const job = state.jobs[localId];
    if (!job) throw new Error('Upload job disappeared');
    delete state.jobs[localId];
    job.id = transcriptId;
    job.status = 'transcribing';
    job.error = null;
    state.jobs[transcriptId] = job;
    await saveState(drive, state);
    return job;
  });
}

export async function failJob(drive, id, message) {
  const peeked = await loadState(drive);
  const found = findJob(peeked, id);
  const key = found.key || id;
  return withLock(key, async () => {
    const state = await loadState(drive);
    const job = state.jobs[key];
    if (!job) return null;
    if (job.status === 'done' || job.htmlFileId) return job;
    job.status = 'error';
    job.error = message || 'Transcription failed';
    await saveState(drive, state);
    return job;
  });
}

async function paragraphsForCompletedJob(job) {
  const transcriptId = job.followupTranscriptId || job.id;
  if (job.followupTranscriptId) {
    const remote = await getTranscript(transcriptId);
    const collapsed = paragraphsFromUtterances(remote.utterances);
    if (collapsed.length) return collapsed;
  }
  return getParagraphs(transcriptId);
}

async function materialize(drive, state, job) {
  if (!job.parentFolderId) {
    job.status = 'error';
    job.error = 'The recording has no Drive folder to save the transcript into';
    await saveState(drive, state);
    return job;
  }
  const paragraphs = await paragraphsForCompletedJob(job);
  job.originalParagraphs = paragraphs;
  const html = renderJobHtml(job, paragraphs);
  job.htmlFileId = await writeHtml(drive, job, html);
  job.status = 'done';
  job.error = null;
  await saveState(drive, state);
  return job;
}

function rememberTranscriptFacts(job, remote) {
  if (!remote || typeof remote !== 'object') return;
  if (remote.status === 'queued' || remote.status === 'processing' || remote.status === 'completed' || remote.status === 'error') {
    job.assemblyStatus = remote.status;
  }
  const seconds = Number(remote.audio_duration);
  if (Number.isFinite(seconds) && seconds >= 0) job.audioDuration = seconds;
}

export function findJob(state, transcriptId) {
  const jobs = state?.jobs || {};
  if (jobs[transcriptId]) return { key: transcriptId, job: jobs[transcriptId] };
  for (const [key, job] of Object.entries(jobs)) {
    if (job && job.followupTranscriptId === transcriptId) return { key, job };
  }
  return { key: null, job: null };
}

function refreshForJob(state, job) {
  try {
    if (job.fileToken) return refreshTokenFromFileToken(job.fileToken);
  } catch {
    // A rotated session secret leaves the file token unreadable.
  }
  return state.refreshToken || '';
}

async function maybeRetrySparse(drive, state, job, remote) {
  if (job.followupTranscriptId || !isSparseTranscript(remote) || !remote.audio_url) return false;
  const next = await createTranscript(remote.audio_url, resolveWebhookUrl(refreshForJob(state, job)), {
    multichannel: true,
  });
  if (!next?.id) return false;
  job.followupTranscriptId = next.id;
  job.status = 'transcribing';
  job.error = null;
  job.assemblyStatus = next.status || 'queued';
  await saveState(drive, state);
  return true;
}

function ensureMaterialize(drive, transcriptId) {
  const existing = materializeRuns.get(transcriptId);
  if (existing) return existing;
  const run = withLock(transcriptId, async () => {
    const state = await loadState(drive);
    const job = state.jobs[transcriptId];
    if (!job || job.htmlFileId || job.status === 'done' || job.status === 'error') return job;
    job.status = 'saving';
    return materialize(drive, state, job);
  }).catch((error) => {
    const message = error instanceof Error ? error.message : 'Could not save the transcript';
    console.error('transcript save failed');
    return failJob(drive, transcriptId, message);
  }).finally(() => {
    materializeRuns.delete(transcriptId);
  });
  materializeRuns.set(transcriptId, run);
  return run;
}

async function syncCanonical(drive, key, requestedId, assumeCompleted) {
  let materializeAfter = false;
  const job = await withLock(key, async () => {
    const state = await loadState(drive);
    const job = state.jobs[key];
    if (!job) return null;
    if (job.htmlFileId) {
      if (job.status !== 'done') {
        job.status = 'done';
        job.error = null;
        await saveState(drive, state);
      }
      return job;
    }
    if (!assumeCompleted && job.status === 'error') return job;
    if (job.status === 'uploading') return job;
    if (job.status === 'saving') {
      materializeAfter = true;
      return job;
    }

    const activeId = job.followupTranscriptId || job.id;
    const treatAsCompleted = assumeCompleted && requestedId === activeId;
    let remote;
    try {
      remote = await getTranscript(activeId);
    } catch (error) {
      if (!treatAsCompleted || job.followupTranscriptId) throw error;
      job.status = 'saving';
      await saveState(drive, state);
      materializeAfter = true;
      return job;
    }
    rememberTranscriptFacts(job, remote);
    if (remote.status === 'error') {
      job.status = 'error';
      job.error = remote.error || 'Transcription failed';
      await saveState(drive, state);
      return job;
    }
    if (remote.status !== 'completed') return job;
    try {
      if (await maybeRetrySparse(drive, state, job, remote)) return job;
    } catch (error) {
      console.error('channel retry failed');
    }
    job.status = 'saving';
    await saveState(drive, state);
    materializeAfter = true;
    return job;
  });
  if (materializeAfter && job) {
    const saving = ensureMaterialize(drive, key);
    if (assumeCompleted) await saving;
  }
  return job;
}

export async function syncJob(drive, transcriptId, { assumeCompleted = false } = {}) {
  const peeked = await loadState(drive);
  const found = findJob(peeked, transcriptId);
  if (!found.job) return null;
  return syncCanonical(drive, found.key, transcriptId, assumeCompleted);
}

const RESUMABLE = new Set(['uploading', 'transcribing', 'saving']);

export function latestOpenJob(jobs) {
  let chosen = null;
  for (const job of Object.values(jobs || {})) {
    if (!job || typeof job.id !== 'string' || !job.id) continue;
    if (!RESUMABLE.has(job.status)) continue;
    if (!chosen || String(job.createdAt || '') > String(chosen.createdAt || '')) chosen = job;
  }
  return chosen;
}

export function jobView(job) {
  const seconds = Number(job.audioDuration);
  return {
    status: job.status,
    error: job.error || null,
    htmlFileId: job.htmlFileId || null,
    name: job.driveFileName || '',
    driveFileId: job.driveFileId || null,
    parentFolderId: job.parentFolderId || null,
    assemblyStatus: job.assemblyStatus || null,
    audioDuration: Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
    createdAt: job.createdAt || null,
  };
}

export function listJobViews(jobs) {
  return Object.values(jobs || {})
    .filter((job) => job && typeof job.id === 'string' && job.id)
    .map((job) => ({
      id: job.id,
      name: job.driveFileName || 'Recording',
      status: job.status || 'error',
      driveFileId: job.driveFileId || null,
      parentFolderId: job.parentFolderId || null,
      htmlFileId: job.htmlFileId || null,
      error: job.status === 'error' ? (job.error || null) : null,
      createdAt: job.createdAt || null,
    }))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export async function submitDriveFile(drive, { fileId, refreshToken }) {
  const meta = await getDriveFile(drive, fileId);
  const parentFolderId = meta.parents?.[0] || '';
  if (!parentFolderId) {
    throw Object.assign(new Error('This file has no parent folder the app can write to'), { status: 400 });
  }
  const job = await beginUploadJob(drive, {
    driveFileId: meta.id,
    driveFileName: meta.name || 'recording',
    parentFolderId,
    refreshToken,
  });
  let stream;
  try {
    stream = await openDriveDownload(drive, meta.id);
    const uploadUrl = await uploadAudioStream(stream);
    const webhookUrl = resolveWebhookUrl(refreshToken);
    const transcript = await createTranscript(uploadUrl, webhookUrl);
    return await commitTranscriptJob(drive, job.id, transcript.id);
  } catch (error) {
    if (stream) {
      stream.on('error', () => {});
      stream.destroy();
    }
    const message = error instanceof Error ? error.message : 'Upload failed';
    await failJob(drive, job.id, message).catch(() => {});
    throw error;
  }
}

export async function saveVisibleParagraphs(drive, transcriptId, paragraphs) {
  return withLock(transcriptId, async () => {
    const state = await loadState(drive);
    const job = state.jobs[transcriptId];
    if (!job) return null;
    const html = renderTranscript({
      title: job.driveFileName || 'Transcript',
      paragraphs,
      originalParagraphs: job.originalParagraphs || [],
      appOrigin: appOrigin(),
      transcriptId: job.id,
      fileToken: job.fileToken,
    });
    job.htmlFileId = await writeHtml(drive, job, html);
    await saveState(drive, state);
    return job;
  });
}

export async function renameJobsForDriveFile(drive, driveFileId, name) {
  const state = await loadState(drive);
  let changed = false;
  for (const job of Object.values(state.jobs || {})) {
    if (!job || job.driveFileId !== driveFileId) continue;
    if (job.driveFileName === name) continue;
    job.driveFileName = name;
    changed = true;
  }
  if (changed) await saveState(drive, state);
}

export async function loadJob(drive, transcriptId) {
  const state = await loadState(drive);
  return { state, job: findJob(state, transcriptId).job };
}

async function storeParagraphTimes(drive, state, job, timed) {
  const saved = job.originalParagraphs || [];
  if (paragraphsHaveTimes(saved) || !paragraphsHaveTimes(timed)) return false;
  if (saved.length !== timed.length) return false;
  job.originalParagraphs = paragraphsForCatalog(saved, timed);
  const html = renderJobHtml(job, job.originalParagraphs);
  job.htmlFileId = await writeHtml(drive, job, html);
  job.status = 'done';
  job.error = null;
  await saveState(drive, state);
  return true;
}

export async function ensureParagraphTimes(drive, transcriptId) {
  return withLock(`times:${transcriptId}`, async () => {
    const state = await loadState(drive);
    const job = findJob(state, transcriptId).job;
    if (!job || job.status !== 'done' || paragraphsHaveTimes(job.originalParagraphs)) return null;
    const timed = await paragraphsForCompletedJob(job);
    const wrote = await storeParagraphTimes(drive, state, job, timed);
    if (!wrote) return null;
    return { html: renderJobHtml(job, job.originalParagraphs), paragraphs: job.originalParagraphs };
  });
}

export async function publishJob(drive, transcriptId, visible) {
  return withLock(`publish:${transcriptId}`, async () => {
    const state = await loadState(drive);
    const job = findJob(state, transcriptId).job;
    if (!job) return null;
    if (job.status !== 'done') {
      const error = new Error('Transcript is not ready');
      error.status = 409;
      throw error;
    }
    if (!job.driveFileId) {
      const error = new Error('This transcript has no recording to publish');
      error.status = 409;
      throw error;
    }
    const timed = paragraphsHaveTimes(job.originalParagraphs)
      ? job.originalParagraphs
      : await paragraphsForCompletedJob(job);
    await storeParagraphTimes(drive, state, job, timed);
    const paragraphs = paragraphsForCatalog(
      Array.isArray(visible) && visible.length ? visible : job.originalParagraphs,
      timed,
    );
    const shared = await shareFileWithAnyone(drive, job.driveFileId);
    const named = sessionOrder(job.driveFileName);
    const existing = findPublishedSession(state.catalog, job.id);
    state.catalog = upsertPublishedSession(state.catalog, {
      id: job.id,
      title: sessionTitle(job.driveFileName),
      order: named != null ? named : existing?.order,
      driveFileId: job.driveFileId,
      mimeType: shared.mimeType || '',
      paragraphs,
    });
    await saveState(drive, state);
    const saved = findPublishedSession(state.catalog, job.id);
    return {
      id: job.id,
      title: saved?.title || sessionTitle(job.driveFileName),
      order: saved?.order ?? null,
      path: `/sessions/${job.id}`,
      seriesPath: `/series/${SERIES_ID}`,
    };
  });
}

export function publishedCatalog(state) {
  return normalizeCatalog(state?.catalog);
}

export async function rebuildIfInterleaved(drive, transcriptId) {
  return withLock(transcriptId, async () => {
    const state = await loadState(drive);
    const found = findJob(state, transcriptId);
    const job = found.job;
    if (!job?.followupTranscriptId || !looksInterleaved(job.originalParagraphs)) return null;
    const remote = await getTranscript(job.followupTranscriptId);
    const paragraphs = paragraphsFromUtterances(remote.utterances);
    if (!paragraphs.length || paragraphs.length >= job.originalParagraphs.length) {
      throw new Error('Could not combine the two channels');
    }
    job.originalParagraphs = paragraphs;
    const html = renderJobHtml(job, paragraphs);
    job.htmlFileId = await writeHtml(drive, job, html);
    job.status = 'done';
    job.error = null;
    await saveState(drive, state);
    return { html, paragraphs };
  });
}
