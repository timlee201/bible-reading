import { Readable } from 'node:stream';
import { seal } from './seal.js';

const API = 'https://api.assemblyai.com/v2';
const GATEWAY = 'https://llm-gateway.assemblyai.com/v1/chat/completions';
const CHUNK_SIZE = 20;

function apiKey() {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new Error('ASSEMBLYAI_API_KEY is not set');
  return key;
}

function authHeaders(extra) {
  return {
    authorization: apiKey(),
    ...extra,
  };
}

async function readError(res) {
  return new Error(`AssemblyAI request failed (${res.status})`);
}

let warnedMissingWebhookSecret = false;

export function resolveWebhookUrl(refreshToken) {
  const secret = process.env.WEBHOOK_SECRET || '';
  const explicit = (process.env.WEBHOOK_URL || '').trim();
  if (explicit && !secret) {
    if (!warnedMissingWebhookSecret) {
      warnedMissingWebhookSecret = true;
      console.error('WEBHOOK_URL is set but WEBHOOK_SECRET is empty; webhook not registered');
    }
    return null;
  }
  if (!secret) return null;
  if (explicit) return explicit;
  const origin = (process.env.APP_ORIGIN || '').trim().replace(/\/$/, '');
  if (!origin) return null;
  let hostname = '';
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
    return null;
  }
  return `${origin}/api/webhooks/assemblyai/${seal(refreshToken)}`;
}

export async function uploadAudioStream(nodeStream) {
  const res = await fetch(`${API}/upload`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/octet-stream' }),
    body: Readable.toWeb(nodeStream),
    duplex: 'half',
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!res.ok) throw await readError(res);
  const data = await res.json();
  if (!data.upload_url) throw new Error('AssemblyAI upload did not return a URL');
  return data.upload_url;
}

export async function createTranscript(audioUrl, webhookUrl) {
  const body = {
    audio_url: audioUrl,
    speaker_labels: true,
  };
  if (webhookUrl) {
    body.webhook_url = webhookUrl;
    body.webhook_auth_header_name = 'X-Webhook-Secret';
    body.webhook_auth_header_value = process.env.WEBHOOK_SECRET;
  }
  const res = await fetch(`${API}/transcript`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60 * 1000),
  });
  if (!res.ok) throw await readError(res);
  const data = await res.json();
  if (!data.id) throw new Error('AssemblyAI submit did not return an id');
  return data;
}

export async function getTranscript(transcriptId) {
  const res = await fetch(`${API}/transcript/${encodeURIComponent(transcriptId)}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(60 * 1000),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function getParagraphs(transcriptId) {
  const res = await fetch(`${API}/transcript/${encodeURIComponent(transcriptId)}/paragraphs`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(60 * 1000),
  });
  if (!res.ok) throw await readError(res);
  const data = await res.json();
  return (data.paragraphs || []).map((paragraph) => ({
    speaker: paragraph.speaker == null ? '' : String(paragraph.speaker),
    text: paragraph.text == null ? '' : String(paragraph.text),
  }));
}

function cleanupModel() {
  return process.env.CLEANUP_MODEL || 'claude-sonnet-4-6';
}

function cleanupPrompt(chunk) {
  return [
    'Clean these transcript paragraphs.',
    'Fix punctuation, remove fillers, and fix obvious stumbles.',
    'Do not add facts.',
    'Do not summarize.',
    'Do not merge paragraphs.',
    'Do not split paragraphs.',
    'Keep every speaker string identical to the input.',
    'Keep the same paragraph count and the same order.',
    'Respond with JSON only, in this shape:',
    '{"paragraphs":[{"speaker":"...","text":"..."}]}',
    '',
    'Input paragraphs:',
    JSON.stringify(chunk),
  ].join('\n');
}

function completionText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return '';
}

function stripFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function parseCleanup(text) {
  const stripped = stripFences(text);
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('Cleanup response was not JSON');
    return JSON.parse(stripped.slice(start, end + 1));
  }
}

function speakerOf(value) {
  if (value == null) return '';
  return String(value);
}

function sameShape(input, output) {
  if (!Array.isArray(output) || output.length !== input.length) return false;
  for (let i = 0; i < input.length; i += 1) {
    const item = output[i];
    if (!item || typeof item !== 'object') return false;
    if (speakerOf(item.speaker) !== speakerOf(input[i].speaker)) return false;
    if (typeof item.text !== 'string') return false;
  }
  return true;
}

async function cleanChunk(chunk) {
  let lastError = new Error('Cleanup failed');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(GATEWAY, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          model: cleanupModel(),
          temperature: 0,
          max_tokens: 16000,
          messages: [{ role: 'user', content: cleanupPrompt(chunk) }],
        }),
        signal: AbortSignal.timeout(120 * 1000),
      });
      if (!res.ok) throw await readError(res);
      const payload = await res.json();
      const parsed = parseCleanup(completionText(payload));
      const paragraphs = parsed?.paragraphs;
      if (!sameShape(chunk, paragraphs)) {
        throw new Error('Cleanup changed speakers or paragraph count');
      }
      return paragraphs.map((item) => ({
        speaker: speakerOf(item.speaker),
        text: item.text,
      }));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Cleanup failed');
    }
  }
  throw lastError;
}

export async function cleanParagraphs(paragraphs) {
  const source = paragraphs || [];
  const cleaned = [];
  for (let i = 0; i < source.length; i += CHUNK_SIZE) {
    const chunk = source.slice(i, i + CHUNK_SIZE);
    const next = await cleanChunk(chunk);
    cleaned.push(...next);
  }
  return cleaned;
}
