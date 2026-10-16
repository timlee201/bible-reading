import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { folderListQuery } from './library.js';

export const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.appdata',
];

function appOrigin() {
  return (process.env.APP_ORIGIN || '').trim().replace(/\/$/, '');
}

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${appOrigin()}/auth/callback`,
  );
}

export function getAuthUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export async function exchangeCode(code) {
  const auth = oauthClient();
  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  let email = '';
  if (tokens.id_token) {
    const ticket = await auth.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    email = ticket.getPayload()?.email || '';
  }
  if (!email) {
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const { data } = await oauth2.userinfo.get();
    email = data.email || '';
  }
  return {
    email,
    accessToken: tokens.access_token || '',
    refreshToken: tokens.refresh_token || '',
    expiry: tokens.expiry_date || Date.now() + 3500 * 1000,
  };
}

export async function refreshAccessToken(refreshToken) {
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refreshToken });
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error('Could not refresh access');
  return {
    accessToken: token,
    refreshToken: auth.credentials.refresh_token || refreshToken,
    expiry: auth.credentials.expiry_date || Date.now() + 3500 * 1000,
  };
}

export function createDrive({ refreshToken, accessToken, expiry } = {}) {
  const auth = oauthClient();
  auth.setCredentials({
    refresh_token: refreshToken || undefined,
    access_token: accessToken || undefined,
    expiry_date: expiry || undefined,
  });
  return google.drive({ version: 'v3', auth });
}

export async function getDriveFile(drive, fileId) {
  const res = await drive.files.get({
    fileId,
    fields: 'id,name,parents,mimeType',
    supportsAllDrives: true,
  });
  return res.data;
}

export async function openDriveDownload(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true, acknowledgeAbuse: true },
    { responseType: 'stream' },
  );
  return res.data;
}

function mediaBody(text, mimeType) {
  return {
    mimeType,
    body: Readable.from([Buffer.from(text, 'utf8')]),
  };
}

export async function createHtmlFile(drive, { name, parentFolderId, html }) {
  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [parentFolderId],
      mimeType: 'text/html',
    },
    media: mediaBody(html, 'text/html; charset=utf-8'),
    fields: 'id',
    supportsAllDrives: true,
  });
  return res.data.id;
}

export async function renameDriveFile(drive, fileId, name) {
  const res = await drive.files.update({
    fileId,
    requestBody: { name },
    fields: 'id,name',
    supportsAllDrives: true,
  });
  return res.data;
}

export async function trashDriveFile(drive, fileId) {
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
}

export async function updateHtmlFile(drive, fileId, html) {
  await drive.files.update({
    fileId,
    media: mediaBody(html, 'text/html; charset=utf-8'),
    supportsAllDrives: true,
  });
}

export async function listDriveChildren(drive, folderId) {
  const q = folderListQuery(folderId);
  const files = [];
  let pageToken;
  do {
    const params = {
      q,
      pageSize: 200,
      fields: 'nextPageToken, files(id, name, mimeType, trashed)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await drive.files.list(params);
    for (const file of res.data.files || []) files.push(file);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return files;
}

export async function breadcrumbChain(drive, folderId) {
  const rootRes = await drive.files.get({ fileId: 'root', fields: 'id,name' });
  const rootId = rootRes.data.id;
  if (!folderId || folderId === 'root' || folderId === rootId) {
    return { rootId, chain: [{ id: rootId, name: 'My Drive' }] };
  }
  const chain = [];
  const seen = new Set();
  let currentId = folderId;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    if (currentId === rootId) {
      chain.push({ id: rootId, name: 'My Drive' });
      break;
    }
    let meta;
    try {
      meta = await getDriveFile(drive, currentId);
    } catch {
      break;
    }
    chain.push({ id: meta.id, name: meta.name || 'Folder' });
    const parentId = Array.isArray(meta.parents) ? meta.parents[0] : '';
    if (!parentId) break;
    currentId = parentId;
  }
  return { rootId, chain };
}

export async function readDriveFileText(drive, fileId, { supportsAllDrives = false } = {}) {
  const params = { fileId, alt: 'media' };
  if (supportsAllDrives) params.supportsAllDrives = true;
  const res = await drive.files.get(params, { responseType: 'stream' });
  if (typeof res.data === 'string') return res.data.replace(/^\uFEFF/, '');
  if (Buffer.isBuffer(res.data)) return res.data.toString('utf8').replace(/^\uFEFF/, '');
  const chunks = [];
  for await (const chunk of res.data) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
}
