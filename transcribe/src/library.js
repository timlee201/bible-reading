import { htmlFileName } from './render.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ACTIVE = new Set(['uploading', 'transcribing', 'saving']);

export function normalizeDriveName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 255) return null;
  if (name === '.' || name === '..') return null;
  if (/[\\/\u0000-\u001f]/.test(name)) return null;
  return name;
}

export function normalizeFolderId(value) {
  if (value == null || value === '' || value === 'root') return 'root';
  if (value === 'shared') return 'shared';
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) return null;
  return value;
}

export function folderListQuery(folderId) {
  if (folderId === 'shared') return 'sharedWithMe = true and trashed = false';
  const id = !folderId || folderId === 'root' ? 'root' : String(folderId).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${id}' in parents and trashed = false`;
}

export function isMediaMime(mimeType) {
  return typeof mimeType === 'string' && (mimeType.startsWith('audio/') || mimeType.startsWith('video/'));
}

export function buildBreadcrumbs(chain, { rootId } = {}) {
  const nodes = Array.isArray(chain) ? chain : [];
  if (nodes.length === 0) return [{ id: 'root', name: 'My Drive' }];
  const ordered = [];
  let reachedRoot = false;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (!node || typeof node.id !== 'string' || !node.id) continue;
    if (node.id === 'root' || (rootId && node.id === rootId)) {
      reachedRoot = true;
      ordered.length = 0;
      ordered.push({ id: 'root', name: 'My Drive' });
      continue;
    }
    ordered.push({ id: node.id, name: node.name || 'Folder' });
  }
  if (!reachedRoot) return [{ id: 'shared', name: 'Shared with me' }, ...ordered];
  if (!ordered.length || ordered[0].id !== 'root') ordered.unshift({ id: 'root', name: 'My Drive' });
  return ordered;
}

export function breadcrumbsFor(folderId, chain, rootId) {
  if (folderId === 'shared') return [{ id: 'shared', name: 'Shared with me' }];
  if (!folderId || folderId === 'root') return [{ id: 'root', name: 'My Drive' }];
  return buildBreadcrumbs(chain, { rootId });
}

export function appendFileCrumb(breadcrumbs, file) {
  const crumbs = (breadcrumbs || []).map((crumb) => ({ ...crumb }));
  if (!file || !file.name) return crumbs;
  crumbs.push({ id: file.id || '', name: file.name, file: true });
  return crumbs;
}

function jobsForFile(jobs, driveFileId) {
  if (!driveFileId) return [];
  return Object.values(jobs || {}).filter((job) => job && job.driveFileId === driveFileId && job.id);
}

export function relevantJob(jobs, driveFileId) {
  const matches = jobsForFile(jobs, driveFileId);
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const rank = (job) => (ACTIVE.has(job.status) ? 0 : job.status === 'done' ? 1 : 2);
    const byRank = rank(a) - rank(b);
    if (byRank) return byRank;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return matches[0];
}

export function doneJob(jobs, driveFileId) {
  const matches = jobsForFile(jobs, driveFileId).filter((job) => job.status === 'done');
  matches.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return matches[0] || null;
}

export function isTranscribed({ name, driveFileId, jobs, siblingNames }) {
  if (doneJob(jobs, driveFileId)) return true;
  return (siblingNames || []).includes(htmlFileName(name));
}

export function describeMediaFile(file, { jobs, siblingNames, siblingIds } = {}) {
  const job = relevantJob(jobs, file.id);
  const finished = doneJob(jobs, file.id);
  const expected = htmlFileName(file.name);
  const siblingId = siblingIds && siblingIds[expected] ? siblingIds[expected] : null;
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType || '',
    transcribed: Boolean(finished) || (siblingNames || []).includes(expected),
    transcriptId: finished ? finished.id : null,
    htmlFileId: (finished && finished.htmlFileId) || siblingId || null,
    jobStatus: job ? job.status : null,
    jobId: job ? job.id : null,
  };
}

function byName(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
}

export function buildFolderView({ id, breadcrumbs, files, jobs }) {
  const siblingNames = [];
  const siblingIds = {};
  const folders = [];
  const media = [];
  for (const file of files || []) {
    if (!file || !file.id || file.trashed) continue;
    if (file.mimeType === FOLDER_MIME) {
      folders.push({ id: file.id, name: file.name || 'Folder' });
      continue;
    }
    if (isMediaMime(file.mimeType)) {
      media.push(file);
      continue;
    }
    if (typeof file.name === 'string' && file.name.endsWith('.html')) {
      siblingNames.push(file.name);
      if (!siblingIds[file.name]) siblingIds[file.name] = file.id;
    }
  }
  folders.sort(byName);
  media.sort(byName);
  return {
    id,
    breadcrumbs: breadcrumbs || [],
    folders,
    files: media.map((file) => describeMediaFile(file, { jobs, siblingNames, siblingIds })),
  };
}
