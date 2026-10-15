import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { renderTranscript } from './render.js';

const template = fs.readFileSync(new URL('./transcript.html', import.meta.url), 'utf8');

function render(overrides = {}) {
  return renderTranscript({
    title: 'Interview.mp3',
    paragraphs: [{ speaker: 'A', text: 'Hello' }],
    originalParagraphs: [{ speaker: 'A', text: 'Hello' }],
    appOrigin: 'http://localhost:8080',
    transcriptId: 'tid-1',
    fileToken: 'file-token',
    ...overrides,
  });
}

function blocks(html) {
  return [...html.matchAll(/<section class="block" data-speaker="([^"]*)">([\s\S]*?)<\/section>/g)];
}

test('HTML-escapes <script>', () => {
  const html = render({
    title: 'Notes <script>.mp3',
    paragraphs: [{ speaker: 'A', text: '<script>alert(1)</script>' }],
    originalParagraphs: [{ speaker: 'A', text: '<script>alert(1)</script>' }],
  });
  assert.match(html, /<p class="text">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
  assert.match(html, /<h1>Notes &lt;script&gt;\.mp3<\/h1>/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  const embedded = html.match(/id="original-paragraphs">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(embedded, /</);
  assert.equal(JSON.parse(embedded)[0].text, '<script>alert(1)</script>');
});

test('speaker label only when the speaker changes', () => {
  const html = render({
    paragraphs: [
      { speaker: 'A', text: 'Hello' },
      { speaker: 'A', text: 'Still me' },
      { speaker: 'B', text: 'Next' },
    ],
    originalParagraphs: [
      { speaker: 'A', text: 'Hello' },
      { speaker: 'A', text: 'Still me' },
      { speaker: 'B', text: 'Next' },
    ],
  });
  const found = blocks(html);
  assert.equal(found.length, 3);
  assert.match(found[0][2], /<p class="speaker">A<\/p>/);
  assert.doesNotMatch(found[1][2], /class="speaker"/);
  assert.match(found[1][2], /<p class="text">Still me<\/p>/);
  assert.match(found[2][2], /<p class="speaker">B<\/p>/);
  assert.equal((html.match(/<p class="speaker">/g) || []).length, 2);
});

test('missing speaker has no label', () => {
  const html = render({
    paragraphs: [
      { speaker: 'A', text: 'Hello' },
      { text: 'No speaker here' },
      { speaker: '', text: 'Also missing' },
      { speaker: null, text: 'Still missing' },
    ],
    originalParagraphs: [],
  });
  const found = blocks(html);
  assert.equal(found.length, 4);
  assert.match(found[0][2], /<p class="speaker">A<\/p>/);
  assert.equal(found[1][1], '');
  assert.equal(found[2][1], '');
  assert.equal(found[3][1], '');
  assert.doesNotMatch(found[1][2], /class="speaker"/);
  assert.doesNotMatch(found[2][2], /class="speaker"/);
  assert.doesNotMatch(found[3][2], /class="speaker"/);
  assert.match(found[1][2], /<p class="text">No speaker here<\/p>/);
});

test('template contains @page size A4', () => {
  assert.match(template, /@page \{ size: A4; margin: 18mm 16mm; \}/);
  const html = render();
  assert.match(html, /@page \{ size: A4; margin: 18mm 16mm; \}/);
  assert.match(html, /window\.print\s*\(\s*\)/);
});

test('toolbar has class no-print', () => {
  assert.match(template, /class="toolbar no-print"/);
  const html = render();
  assert.match(html, /class="toolbar no-print"/);
  assert.match(html, /<button type="button" id="clean">Clean up<\/button>/);
  assert.match(html, /<button type="button" id="revert">Revert<\/button>/);
  assert.match(html, /<button type="button" id="save">Save<\/button>/);
  assert.match(html, /<button type="button" id="print">Print<\/button>/);
  assert.doesNotMatch(html, /innerHTML/);
});

test('original JSON is embedded and is not the visible cleanup', () => {
  const original = [
    { speaker: 'A', text: 'Original line' },
    { speaker: 'B', text: 'Second' },
  ];
  const html = render({
    paragraphs: [
      { speaker: 'A', text: 'Cleaned line' },
      { speaker: 'B', text: 'Second cleaned' },
    ],
    originalParagraphs: original,
    appOrigin: 'https://example.com',
    transcriptId: 'abc',
    fileToken: 'tok_123',
  });
  const embedded = html.match(/id="original-paragraphs">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(embedded), original);
  assert.match(html, /<p class="text">Cleaned line<\/p>/);
  assert.doesNotMatch(html, /<p class="text">Original line<\/p>/);
  assert.match(html, /data-app-origin="https:\/\/example.com"/);
  assert.match(html, /data-transcript-id="abc"/);
  assert.match(html, /data-file-token="tok_123"/);
});
