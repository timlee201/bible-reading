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

export function transcriptBody(audioUrl, webhookUrl, options = {}) {
  const body = {
    audio_url: audioUrl,
    speaker_labels: true,
  };
  if (options.multichannel) body.multichannel = true;
  if (webhookUrl) {
    body.webhook_url = webhookUrl;
    body.webhook_auth_header_name = 'X-Webhook-Secret';
    body.webhook_auth_header_value = process.env.WEBHOOK_SECRET;
  }
  return body;
}

// A long recording that comes back as a handful of words is usually a stereo
// file whose channels cancel in the default mono mix. Those need a per-channel pass.
export function isSparseTranscript(remote) {
  if (!remote || remote.multichannel) return false;
  const seconds = Number(remote.audio_duration);
  if (!Number.isFinite(seconds) || seconds < 120) return false;
  const words = Array.isArray(remote.words)
    ? remote.words.length
    : String(remote.text || '').trim().split(/\s+/).filter(Boolean).length;
  return words / (seconds / 60) < 2;
}

function utteranceText(utterance) {
  return String(utterance?.text || '').replace(/\s+/g, ' ').trim();
}

function spokenWord(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9']+/g, '');
}

function timedWords(group) {
  const words = [];
  for (const utterance of group) {
    const pieces = Array.isArray(utterance.words) && utterance.words.length
      ? utterance.words
      : [{ text: utteranceText(utterance), start: utterance.start, end: utterance.end }];
    for (const piece of pieces) {
      const raw = String(piece.text || '');
      const tokens = raw.match(/[A-Za-z0-9']+/g) || [];
      tokens.forEach((token, index) => {
        const text = spokenWord(token);
        if (!text) return;
        const start = Number(piece.start);
        const end = Number(piece.end);
        words.push({
          text,
          start: Number.isFinite(start) ? start + index : index,
          end: Number.isFinite(end) ? end : start,
        });
      });
    }
  }
  words.sort((a, b) => a.start - b.start);
  return words;
}

// Word order drifts between channels, so compare words that were spoken at the same time.
function samePerformance(kept, candidate) {
  const left = timedWords(kept);
  const right = timedWords(candidate);
  const longer = Math.max(left.length, right.length);
  const shorterList = left.length <= right.length ? left : right;
  const other = shorterList === left ? right : left;
  if (!longer || shorterList.length / longer < 0.75) return false;
  let cursor = 0;
  let matched = 0;
  for (const word of shorterList) {
    while (cursor < other.length && other[cursor].start < word.start - 700) cursor += 1;
    for (let i = cursor; i < other.length && other[i].start <= word.start + 700; i += 1) {
      if (other[i].text === word.text) {
        matched += 1;
        break;
      }
    }
  }
  return matched / longer >= 0.7;
}

export function looksInterleaved(paragraphs) {
  const items = paragraphs || [];
  let pairs = 0;
  let same = 0;
  for (let i = 1; i < items.length; i += 1) {
    const left = items[i - 1];
    const right = items[i];
    const leftSpeaker = left?.speaker == null ? '' : String(left.speaker);
    const rightSpeaker = right?.speaker == null ? '' : String(right.speaker);
    if (!/^\d+[A-Z]$/.test(leftSpeaker) || !/^\d+[A-Z]$/.test(rightSpeaker)) continue;
    if (leftSpeaker === rightSpeaker) continue;
    pairs += 1;
    if (String(left.text || '').trim().toLowerCase() === String(right.text || '').trim().toLowerCase()) same += 1;
  }
  return pairs >= 4 && same / pairs >= 0.5;
}

function displaySpeaker(utterance, onlyChannel) {
  const speaker = utterance?.speaker == null ? '' : String(utterance.speaker);
  const channel = utterance?.channel == null ? '' : String(utterance.channel);
  if (!onlyChannel) return speaker;
  if (channel && speaker.startsWith(channel)) {
    const rest = speaker.slice(channel.length);
    if (/^[A-Z]$/.test(rest)) return rest;
  }
  if (speaker === channel) return 'A';
  return speaker;
}

export function paragraphsFromUtterances(utterances) {
  const items = (utterances || []).filter((utterance) => utteranceText(utterance));
  const byChannel = new Map();
  for (const utterance of items) {
    const channel = utterance.channel == null ? '' : String(utterance.channel);
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel).push(utterance);
  }
  const keptChannels = [];
  for (const [channel, group] of byChannel) {
    const duplicate = keptChannels.some((kept) => samePerformance(byChannel.get(kept), group));
    if (!duplicate) keptChannels.push(channel);
  }
  const onlyChannel = keptChannels.length === 1;
  const chosen = items
    .filter((utterance) => keptChannels.includes(utterance.channel == null ? '' : String(utterance.channel)))
    .sort((a, b) => (a.start || 0) - (b.start || 0) || String(a.channel).localeCompare(String(b.channel)));
  const paragraphs = [];
  for (const utterance of chosen) {
    const speaker = displaySpeaker(utterance, onlyChannel);
    const text = utteranceText(utterance);
    const previous = paragraphs[paragraphs.length - 1];
    const gap = previous ? (utterance.start || 0) - (previous.end || 0) : 0;
    const longSentence = previous
      && previous.text.split(/\s+/).filter(Boolean).length >= 45
      && /[.!?]["']?$/.test(previous.text);
    if (previous && previous.speaker === speaker && gap < 1600 && !longSentence) {
      previous.text = `${previous.text} ${text}`.trim();
      previous.end = utterance.end || utterance.start || previous.end;
    } else {
      paragraphs.push({
        speaker,
        text,
        end: utterance.end || utterance.start || 0,
      });
    }
  }
  return paragraphs.map((paragraph) => ({ speaker: paragraph.speaker, text: paragraph.text }));
}

export async function createTranscript(audioUrl, webhookUrl, options = {}) {
  const body = transcriptBody(audioUrl, webhookUrl, options);
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
