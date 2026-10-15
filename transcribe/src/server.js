import crypto from 'node:crypto';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { cleanParagraphs, getTranscript } from './assemblyai.js';
import {
  createDrive,
  exchangeCode,
  getAuthUrl,
  readDriveFileText,
  refreshAccessToken,
} from './google.js';
import {
  failJob,
  jobView,
  latestOpenJob,
  loadJob,
  saveVisibleParagraphs,
  submitDriveFile,
  syncJob,
} from './jobs.js';
import { renderTranscript } from './render.js';
import {
  fallbackRefreshToken,
  refreshTokenFromFileToken,
  rememberRefreshToken,
  unseal,
} from './seal.js';
import { loadState, saveState } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function appOrigin() {
  return (process.env.APP_ORIGIN || '').trim().replace(/\/$/, '');
}

function allowedEmail() {
  return (process.env.ALLOWED_EMAIL || '').trim().toLowerCase();
}

function safeError(err) {
  const msg = String(err?.message || err || 'Request failed');
  const redacted = msg
    .replace(/ya29\.[0-9A-Za-z\-_]+/g, '[redacted]')
    .replace(/1\/\/[0-9A-Za-z\-_]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  if (/api[_-]?key|session_secret|webhook_secret|client_secret/i.test(redacted)) {
    return 'Request failed';
  }
  return redacted.slice(0, 300);
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function cookieAttributes(maxAge) {
  const secure = appOrigin().startsWith('https://') ? '; Secure' : '';
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function appendCookie(res, name, value, maxAge) {
  res.append('Set-Cookie', `${name}=${value}; ${cookieAttributes(maxAge)}`);
}

function encodeSession(session) {
  const payload = Buffer.from(JSON.stringify({
    email: session.email,
    accessToken: session.accessToken,
    expiry: session.expiry,
    refreshToken: session.refreshToken,
  })).toString('base64url');
  const mac = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function readSession(req) {
  const raw = parseCookies(req.headers.cookie).session;
  if (!raw || !process.env.SESSION_SECRET) return null;
  const splitAt = raw.lastIndexOf('.');
  if (splitAt <= 0) return null;
  const payload = raw.slice(0, splitAt);
  const mac = raw.slice(splitAt + 1);
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  if (!timingSafeEqualString(mac, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session?.email || !session?.refreshToken) return null;
    return session;
  } catch {
    return null;
  }
}

function emailsMatch(email) {
  return String(email || '').trim().toLowerCase() === allowedEmail() && allowedEmail() !== '';
}

function setSessionCookie(res, session) {
  appendCookie(res, 'session', encodeSession(session), SESSION_MAX_AGE);
}

function clearSessionCookie(res) {
  appendCookie(res, 'session', '', 0);
}

async function freshen(session, res) {
  const expiry = Number(session.expiry) || 0;
  if (session.accessToken && expiry - 60_000 > Date.now()) {
    rememberRefreshToken(session.refreshToken);
    return session;
  }
  const next = await refreshAccessToken(session.refreshToken);
  session.accessToken = next.accessToken;
  session.expiry = next.expiry;
  session.refreshToken = next.refreshToken;
  rememberRefreshToken(session.refreshToken);
  setSessionCookie(res, session);
  return session;
}

function driveFromSession(session) {
  return createDrive({
    refreshToken: session.refreshToken,
    accessToken: session.accessToken,
    expiry: session.expiry,
  });
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function requireSession(req, res, next) {
  const session = readSession(req);
  if (session && !emailsMatch(session.email)) {
    clearSessionCookie(res);
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Forbidden' });
    return res.status(403).type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>Not allowed</title><p>This Google account is not allowed to use this app.</p>');
  }
  if (!session) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/auth/google');
  }
  freshen(session, res).then((fresh) => {
    req.sessionUser = fresh;
    next();
  }).catch((error) => {
    console.error(safeError(error));
    clearSessionCookie(res);
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/auth/google');
  });
}

function transcriptCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin === 'null' || (origin && origin === appOrigin())) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

function authorizeTranscript(req, res, next) {
  const session = readSession(req);
  if (session && emailsMatch(session.email)) {
    freshen(session, res).then((fresh) => {
      req.sessionUser = fresh;
      next();
    }).catch((error) => {
      console.error(safeError(error));
      res.status(401).json({ error: 'Unauthorized' });
    });
    return;
  }
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.fileBearer = match[1];
    req.bearerRefreshToken = refreshTokenFromFileToken(match[1]);
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function webhookAuthorized(req) {
  const expected = process.env.WEBHOOK_SECRET || '';
  const got = req.get('x-webhook-secret') || '';
  if (!expected || !got) return false;
  return timingSafeEqualString(got, expected);
}

function normalizeParagraphs(input) {
  if (!Array.isArray(input)) return null;
  return input.map((paragraph) => ({
    speaker: paragraph && paragraph.speaker != null ? String(paragraph.speaker) : '',
    text: paragraph && paragraph.text != null ? String(paragraph.text) : '',
  }));
}

async function driveForWebhook(sealed) {
  let refreshToken = '';
  if (sealed) {
    try {
      refreshToken = unseal(sealed);
    } catch {
      console.error('webhook seal rejected');
      return null;
    }
  }
  if (!refreshToken) refreshToken = fallbackRefreshToken();
  if (!refreshToken) return null;
  return createDrive({ refreshToken });
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));

  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
  });

  app.get('/auth/google', (req, res) => {
    const state = crypto.randomBytes(16).toString('base64url');
    appendCookie(res, 'oauth_state', state, 600);
    res.redirect(getAuthUrl(state));
  });

  app.get('/auth/callback', asyncHandler(async (req, res) => {
    const expected = parseCookies(req.headers.cookie).oauth_state || '';
    const received = typeof req.query.state === 'string' ? req.query.state : '';
    appendCookie(res, 'oauth_state', '', 0);
    if (!req.query.code || req.query.error || !timingSafeEqualString(received, expected)) {
      return res.status(400).type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>Sign-in</title><p>Sign-in was cancelled. <a href="/auth/google">Try again</a>.</p>');
    }
    const auth = await exchangeCode(req.query.code);
    if (!emailsMatch(auth.email)) {
      clearSessionCookie(res);
      return res.status(403).type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>Not allowed</title><p>This Google account is not allowed to use this app.</p>');
    }
    const drive = createDrive({
      refreshToken: auth.refreshToken,
      accessToken: auth.accessToken,
      expiry: auth.expiry,
    });
    if (!auth.refreshToken) {
      try {
        const existing = await loadState(drive);
        if (existing.refreshToken) auth.refreshToken = existing.refreshToken;
      } catch {
        auth.refreshToken = '';
      }
    }
    if (!auth.refreshToken) {
      clearSessionCookie(res);
      return res.status(400).type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>Sign-in</title><p>Google did not return a refresh token. Remove this app’s access in your Google Account and sign in again.</p>');
    }
    const state = await loadState(drive);
    state.refreshToken = auth.refreshToken;
    await saveState(drive, state);
    rememberRefreshToken(auth.refreshToken);
    setSessionCookie(res, auth);
    res.redirect('/');
  }));

  app.post('/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get('/api/session', requireSession, (req, res) => {
    res.json({
      email: req.sessionUser.email,
      accessToken: req.sessionUser.accessToken,
      pickerApiKey: process.env.GOOGLE_API_KEY || '',
    });
  });

  app.post('/api/jobs', requireSession, asyncHandler(async (req, res) => {
    const fileId = req.body?.fileId;
    if (typeof fileId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      return res.status(400).json({ error: 'fileId is required' });
    }
    const drive = driveFromSession(req.sessionUser);
    try {
      const job = await submitDriveFile(drive, {
        fileId,
        refreshToken: req.sessionUser.refreshToken,
      });
      res.json({ transcriptId: job.id, status: job.status });
    } catch (error) {
      const status = Number(error.status) || 502;
      console.error(safeError(error));
      res.status(status).json({ error: safeError(error) });
    }
  }));

  app.get('/api/jobs/current', requireSession, asyncHandler(async (req, res) => {
    const drive = driveFromSession(req.sessionUser);
    const state = await loadState(drive);
    const job = latestOpenJob(state.jobs);
    if (!job) return res.status(204).end();
    res.json({ transcriptId: job.id, status: job.status });
  }));

  app.get('/api/jobs/:transcriptId', requireSession, asyncHandler(async (req, res) => {
    const transcriptId = req.params.transcriptId;
    if (!/^[a-zA-Z0-9_-]+$/.test(transcriptId)) {
      return res.status(400).json({ error: 'Not found' });
    }
    const drive = driveFromSession(req.sessionUser);
    const job = await syncJob(drive, transcriptId);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(jobView(job));
  }));

  async function handleWebhook(req, res) {
    if (!webhookAuthorized(req)) return res.status(401).end();
    const transcriptId = req.body?.transcript_id || req.body?.transcriptId;
    const status = req.body?.status;
    try {
      const drive = await driveForWebhook(req.params.sealed);
      if (!drive) {
        console.error('webhook: no Drive credentials');
      } else if (typeof transcriptId === 'string' && transcriptId) {
        if (status === 'completed') {
          await syncJob(drive, transcriptId, { assumeCompleted: true });
        } else if (status === 'error') {
          let message = 'Transcription failed';
          try {
            const remote = await getTranscript(transcriptId);
            if (remote.error) message = String(remote.error).slice(0, 300);
          } catch (error) {
            console.error(safeError(error));
          }
          await failJob(drive, transcriptId, message);
        }
      }
    } catch (error) {
      console.error(safeError(error));
    }
    res.status(200).json({ ok: true });
  }

  app.post('/api/webhooks/assemblyai', asyncHandler(handleWebhook));
  app.post('/api/webhooks/assemblyai/:sealed', asyncHandler(handleWebhook));

  app.options('/api/transcripts/:transcriptId/clean', transcriptCors);
  app.options('/api/transcripts/:transcriptId', transcriptCors);

  app.post('/api/transcripts/:transcriptId/clean', transcriptCors, authorizeTranscript, asyncHandler(async (req, res) => {
    const drive = req.sessionUser
      ? driveFromSession(req.sessionUser)
      : createDrive({ refreshToken: req.bearerRefreshToken });
    const { job } = await loadJob(drive, req.params.transcriptId);
    if (!job) return res.status(404).json({ error: 'Not found' });
    if (req.fileBearer && !timingSafeEqualString(req.fileBearer, job.fileToken)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (job.status !== 'done') return res.status(409).json({ error: 'Transcript is not ready' });
    const paragraphs = await cleanParagraphs(job.originalParagraphs || []);
    res.json({ paragraphs });
  }));

  app.put('/api/transcripts/:transcriptId', transcriptCors, authorizeTranscript, asyncHandler(async (req, res) => {
    const paragraphs = normalizeParagraphs(req.body?.paragraphs);
    if (!paragraphs) return res.status(400).json({ error: 'paragraphs must be a list of speaker and text' });
    const drive = req.sessionUser
      ? driveFromSession(req.sessionUser)
      : createDrive({ refreshToken: req.bearerRefreshToken });
    const { job } = await loadJob(drive, req.params.transcriptId);
    if (!job) return res.status(404).json({ error: 'Not found' });
    if (req.fileBearer && !timingSafeEqualString(req.fileBearer, job.fileToken)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const saved = await saveVisibleParagraphs(drive, req.params.transcriptId, paragraphs);
    res.json({ htmlFileId: saved.htmlFileId });
  }));

  app.get('/t/:transcriptId', requireSession, asyncHandler(async (req, res) => {
    const drive = driveFromSession(req.sessionUser);
    const { job } = await loadJob(drive, req.params.transcriptId);
    if (!job) {
      return res.status(404).type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>Not found</title><p>Transcript not found.</p>');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (job.htmlFileId) {
      const html = await readDriveFileText(drive, job.htmlFileId, { supportsAllDrives: true });
      return res.send(html);
    }
    if (job.originalParagraphs?.length) {
      const html = renderTranscript({
        title: job.driveFileName || 'Transcript',
        paragraphs: job.originalParagraphs,
        originalParagraphs: job.originalParagraphs,
        appOrigin: appOrigin(),
        transcriptId: job.id,
        fileToken: job.fileToken,
      });
      return res.send(html);
    }
    return res.status(404).send('<!DOCTYPE html><meta charset="utf-8"><title>Not ready</title><p>Transcript is not ready yet.</p>');
  }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.status(404).type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>Not found</title><p>Not found.</p>');
  });

  app.use((err, req, res, next) => {
    console.error(safeError(err));
    if (res.headersSent) return next(err);
    const status = Number(err.status) || 500;
    if (req.path.startsWith('/api/')) {
      return res.status(status).json({ error: safeError(err) });
    }
    return res.status(status).type('html').send('<!DOCTYPE html><meta charset="utf-8"><title>Error</title><p>Something went wrong.</p>');
  });

  return app;
}

export function start() {
  const port = Number(process.env.PORT) || 8080;
  const app = createApp();
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`listening on ${port}`);
  });
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 31 * 60 * 1000;
  server.keepAliveTimeout = 620 * 1000;
  return server;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  start();
}
