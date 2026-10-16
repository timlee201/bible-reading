import { Readable } from 'node:stream';
import { readDriveFileText } from './google.js';

const FILE_NAME = 'transcript-state.json';

function mediaBody(text) {
  return {
    mimeType: 'application/json',
    body: Readable.from([Buffer.from(text, 'utf8')]),
  };
}

function knownAssemblyStatus(status) {
  if (status === 'queued' || status === 'processing' || status === 'completed' || status === 'error') return status;
  return null;
}

function knownAudioDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds;
}

function normalizeJob(id, job) {
  return {
    id: job.id || id,
    driveFileId: job.driveFileId,
    driveFileName: job.driveFileName,
    parentFolderId: job.parentFolderId || '',
    htmlFileId: job.htmlFileId || null,
    fileToken: job.fileToken,
    status: job.status,
    error: job.error || null,
    originalParagraphs: Array.isArray(job.originalParagraphs) ? job.originalParagraphs : [],
    createdAt: job.createdAt,
    assemblyStatus: knownAssemblyStatus(job.assemblyStatus),
    audioDuration: knownAudioDuration(job.audioDuration),
    followupTranscriptId: typeof job.followupTranscriptId === 'string' && job.followupTranscriptId
      ? job.followupTranscriptId
      : null,
  };
}

export function normalizeStoredJob(id, job) {
  return normalizeJob(id, job || {});
}

export async function loadState(drive) {
  const list = await drive.files.list({
    spaces: 'appDataFolder',
    q: "name = 'transcript-state.json' and trashed = false",
    fields: 'files(id, name, modifiedTime)',
    pageSize: 20,
  });
  const files = [...(list.data.files || [])];
  if (!files.length) {
    return { refreshToken: '', jobs: {}, fileId: null };
  }
  files.sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
  const fileId = files[0].id;
  const text = await readDriveFileText(drive, fileId);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Could not read transcript state');
  }
  const jobs = {};
  const rawJobs = parsed.jobs && typeof parsed.jobs === 'object' ? parsed.jobs : {};
  for (const [id, job] of Object.entries(rawJobs)) {
    if (job && typeof job === 'object') jobs[id] = normalizeJob(id, job);
  }
  return {
    refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
    jobs,
    fileId,
  };
}

export async function saveState(drive, state) {
  const payload = JSON.stringify({
    refreshToken: state.refreshToken || '',
    jobs: state.jobs || {},
  });
  if (state.fileId) {
    await drive.files.update({
      fileId: state.fileId,
      media: mediaBody(payload),
    });
    return state.fileId;
  }
  const created = await drive.files.create({
    requestBody: {
      name: FILE_NAME,
      parents: ['appDataFolder'],
      mimeType: 'application/json',
    },
    media: mediaBody(payload),
    fields: 'id',
  });
  state.fileId = created.data.id;
  return state.fileId;
}
