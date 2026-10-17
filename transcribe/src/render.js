import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function transcriptTemplatePath() {
  const besideModule = fileURLToPath(new URL('./transcript.html', import.meta.url));
  const candidates = [
    besideModule,
    path.join(process.cwd(), 'src', 'transcript.html'),
    path.join(process.cwd(), 'transcript.html'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || besideModule;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function embedJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (ch) => {
    switch (ch) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        return ch;
    }
  });
}

export function speakerOf(value) {
  if (value == null) return '';
  return String(value);
}

function timeAttribute(paragraph, key) {
  const value = Number(paragraph?.[key]);
  if (!Number.isFinite(value) || value < 0) return '';
  return ` data-${key}="${escapeHtml(String(value))}"`;
}

export function renderParagraphs(paragraphs) {
  const blocks = [];
  let previous = null;
  for (const paragraph of paragraphs || []) {
    const speaker = speakerOf(paragraph?.speaker);
    const text = paragraph?.text == null ? '' : String(paragraph.text);
    const showSpeaker = speaker !== '' && speaker !== previous;
    const label = showSpeaker ? `<p class="speaker">${escapeHtml(speaker)}</p>` : '';
    blocks.push(
      `<section class="block"${timeAttribute(paragraph, 'start')}${timeAttribute(paragraph, 'end')} data-speaker="${escapeHtml(speaker)}">${label}<p class="text">${escapeHtml(text)}</p></section>`,
    );
    previous = speaker;
  }
  return blocks.join('\n');
}

export function renderTranscript({
  title,
  paragraphs,
  originalParagraphs,
  appOrigin,
  transcriptId,
  fileToken,
}) {
  const template = fs.readFileSync(transcriptTemplatePath(), 'utf8');
  const replacements = new Map([
    ['__TITLE__', escapeHtml(title ?? '')],
    ['__BODY__', renderParagraphs(paragraphs)],
    ['__ORIGINAL_JSON__', embedJson(originalParagraphs ?? [])],
    ['__APP_ORIGIN__', escapeHtml(appOrigin ?? '')],
    ['__TRANSCRIPT_ID__', escapeHtml(transcriptId ?? '')],
    ['__FILE_TOKEN__', escapeHtml(fileToken ?? '')],
  ]);
  return template.replace(
    /__TITLE__|__BODY__|__ORIGINAL_JSON__|__APP_ORIGIN__|__TRANSCRIPT_ID__|__FILE_TOKEN__/g,
    (token) => replacements.get(token),
  );
}

export function htmlFileName(driveFileName) {
  const trimmed = String(driveFileName || '').trim();
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = (slash >= 0 ? trimmed.slice(slash + 1) : trimmed) || 'transcript';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem || 'transcript'}.html`;
}
