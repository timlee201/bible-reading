import crypto from 'node:crypto';
import { createTranscript, getParagraphs, getTranscript, resolveWebhookUrl, uploadAudioStream } from './assemblyai.js';
import { createHtmlFile, getDriveFile, openDriveDownload, updateHtmlFile } from './google.js';
import { htmlFileName, renderTranscript } from './render.js';
import { createFileToken } from './seal.js';
import { loadState, saveState } from './state.js';

const chains = new Map();

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
  return withLock(id, async () => {
    const state = await loadState(drive);
    const job = state.jobs[id];
    if (!job) return null;
    if (job.status === 'done' || job.htmlFileId) return job;
    job.status = 'error';
    job.error = message || 'Transcription failed';
    await saveState(drive, state);
    return job;
  });
}

async function materialize(drive, state, job) {
  if (!job.parentFolderId) {
    job.status = 'error';
    job.error = 'The recording has no Drive folder to save the transcript into';
    await saveState(drive, state);
    return job;
  }
  const paragraphs = await getParagraphs(job.id);
  job.originalParagraphs = paragraphs;
  const html = renderJobHtml(job, paragraphs);
  job.htmlFileId = await writeHtml(drive, job, html);
  job.status = 'done';
  job.error = null;
  await saveState(drive, state);
  return job;
}

export async function syncJob(drive, transcriptId, { assumeCompleted = false } = {}) {
  return withLock(transcriptId, async () => {
    const state = await loadState(drive);
    const job = state.jobs[transcriptId];
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

    if (!assumeCompleted) {
      const remote = await getTranscript(transcriptId);
      if (remote.status === 'error') {
        job.status = 'error';
        job.error = remote.error || 'Transcription failed';
        await saveState(drive, state);
        return job;
      }
      if (remote.status !== 'completed') return job;
    }

    return materialize(drive, state, job);
  });
}

export function jobView(job) {
  return {
    status: job.status,
    error: job.error || null,
    htmlFileId: job.htmlFileId || null,
    name: job.driveFileName || '',
  };
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

export async function loadJob(drive, transcriptId) {
  const state = await loadState(drive);
  return { state, job: state.jobs[transcriptId] || null };
}
