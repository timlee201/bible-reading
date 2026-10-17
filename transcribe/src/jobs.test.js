import assert from 'node:assert/strict';
import test from 'node:test';
import { isSparseTranscript, looksInterleaved, paragraphsFromUtterances, transcriptBody, withOriginalTimes } from './assemblyai.js';
import { paragraphIndexAt, publicCatalog, sessionOrder, sessionTitle, upsertPublishedSession } from './catalog.js';
import { findJob, jobView, latestOpenJob, listJobViews } from './jobs.js';
import { normalizeStoredJob } from './state.js';
import {
  appendFileCrumb,
  breadcrumbsFor,
  buildBreadcrumbs,
  buildFolderView,
  folderListQuery,
  isTranscribed,
  normalizeDriveName,
} from './library.js';

test('job view includes AssemblyAI status and audio duration when the poll already has them', () => {
  const view = jobView({
    status: 'transcribing',
    error: null,
    htmlFileId: null,
    driveFileName: 'talk.m4a',
    assemblyStatus: 'queued',
    audioDuration: 125.4,
    createdAt: '2026-10-15T20:00:00.000Z',
  });
  assert.equal(view.status, 'transcribing');
  assert.equal(view.assemblyStatus, 'queued');
  assert.equal(view.audioDuration, 125.4);
  assert.equal(view.name, 'talk.m4a');
  assert.equal(view.createdAt, '2026-10-15T20:00:00.000Z');
});

test('latest open job is the newest one still uploading, transcribing, or saving', () => {
  const job = latestOpenJob({
    old: { id: 'old', status: 'transcribing', createdAt: '2026-10-15T18:00:00.000Z' },
    done: { id: 'done', status: 'done', createdAt: '2026-10-15T21:00:00.000Z' },
    failed: { id: 'failed', status: 'error', createdAt: '2026-10-15T21:30:00.000Z' },
    current: { id: 'current', status: 'saving', createdAt: '2026-10-15T20:00:00.000Z' },
  });
  assert.equal(job.id, 'current');
  assert.equal(latestOpenJob({ done: { id: 'done', status: 'done', createdAt: '2026-10-15T21:00:00.000Z' } }), null);
});

test('drive rename rejects an empty name or a slash', () => {
  assert.equal(normalizeDriveName('  2015. Session 4.mp4  '), '2015. Session 4.mp4');
  assert.equal(normalizeDriveName(''), null);
  assert.equal(normalizeDriveName('   '), null);
  assert.equal(normalizeDriveName('a/b'), null);
  assert.equal(normalizeDriveName('.'), null);
  assert.equal(normalizeDriveName('..'), null);
});

test('breadcrumbs walk parents up to My Drive', () => {
  assert.deepEqual(buildBreadcrumbs([
    { id: 'year', name: '2024' },
    { id: 'interviews', name: 'Interviews' },
    { id: 'abc123', name: 'My Drive' },
  ], { rootId: 'abc123' }), [
    { id: 'root', name: 'My Drive' },
    { id: 'interviews', name: 'Interviews' },
    { id: 'year', name: '2024' },
  ]);
  assert.deepEqual(breadcrumbsFor('root'), [{ id: 'root', name: 'My Drive' }]);
  assert.equal(folderListQuery('root'), "'root' in parents and trashed = false");
  assert.equal(folderListQuery('folder_1'), "'folder_1' in parents and trashed = false");
});

test('a folder outside My Drive starts at Shared with me', () => {
  assert.deepEqual(buildBreadcrumbs([
    { id: 'notes', name: 'Notes' },
  ], { rootId: 'abc123' }), [
    { id: 'shared', name: 'Shared with me' },
    { id: 'notes', name: 'Notes' },
  ]);
  assert.deepEqual(breadcrumbsFor('shared'), [{ id: 'shared', name: 'Shared with me' }]);
});

test('an open transcript adds the file name as the last breadcrumb', () => {
  const crumbs = appendFileCrumb(buildBreadcrumbs([
    { id: 'fold', name: 'Recordings' },
    { id: 'root-real', name: 'My Drive' },
  ], { rootId: 'root-real' }), { id: 'file-1', name: 'Interview.mp3' });
  assert.deepEqual(crumbs, [
    { id: 'root', name: 'My Drive' },
    { id: 'fold', name: 'Recordings' },
    { id: 'file-1', name: 'Interview.mp3', file: true },
  ]);
});

test('a recording is transcribed when its job is done or a sibling HTML file exists', () => {
  assert.equal(isTranscribed({
    name: 'Interview.mp3',
    driveFileId: 'file-1',
    jobs: {
      old: { id: 'old', driveFileId: 'file-1', status: 'error', createdAt: '2026-10-15T01:00:00.000Z' },
      done: { id: 'done', driveFileId: 'file-1', status: 'done', createdAt: '2026-10-15T02:00:00.000Z' },
    },
    siblingNames: [],
  }), true);
  assert.equal(isTranscribed({
    name: 'Interview.mp3',
    driveFileId: 'file-2',
    jobs: {},
    siblingNames: ['Interview.html', 'Other.html'],
  }), true);
  assert.equal(isTranscribed({
    name: 'Interview.mp3',
    driveFileId: 'file-3',
    jobs: {
      run: { id: 'run', driveFileId: 'file-3', status: 'transcribing', createdAt: '2026-10-15T03:00:00.000Z' },
    },
    siblingNames: [],
  }), false);
});

test('folder view lists folders before recordings and marks a sibling HTML file', () => {
  const view = buildFolderView({
    id: 'root',
    breadcrumbs: [{ id: 'root', name: 'My Drive' }],
    files: [
      { id: 'audio', name: 'Interview.mp3', mimeType: 'audio/mpeg' },
      { id: 'html', name: 'Interview.html', mimeType: 'text/html' },
      { id: 'folder', name: 'Archive', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'video', name: 'B-roll.mp4', mimeType: 'video/mp4' },
      { id: 'doc', name: 'notes.txt', mimeType: 'text/plain' },
    ],
    jobs: {
      run: { id: 'run-id', driveFileId: 'video', status: 'uploading', createdAt: '2026-10-15T04:00:00.000Z' },
    },
  });
  assert.deepEqual(view.folders.map((folder) => folder.name), ['Archive']);
  assert.deepEqual(view.files.map((file) => file.name), ['B-roll.mp4', 'Interview.mp3']);
  assert.equal(view.files[1].transcribed, true);
  assert.equal(view.files[1].htmlFileId, 'html');
  assert.equal(view.files[0].transcribed, false);
  assert.equal(view.files[0].jobStatus, 'uploading');
});

test('sidebar job list keeps the recording name and status and drops secrets', () => {
  const listed = listJobViews({
    a: {
      id: 'a',
      driveFileName: 'Interview.mp3',
      status: 'done',
      driveFileId: 'file',
      parentFolderId: 'folder',
      htmlFileId: 'html',
      fileToken: 'secret-token',
      originalParagraphs: [{ text: 'secret' }],
      createdAt: '2026-10-15T01:00:00.000Z',
    },
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'Interview.mp3');
  assert.equal(listed[0].status, 'done');
  assert.equal(listed[0].fileToken, undefined);
  assert.equal(listed[0].originalParagraphs, undefined);
});

test('job view leaves progress fields empty when the transcript has not been loaded', () => {
  const view = jobView({
    status: 'uploading',
    driveFileName: 'talk.m4a',
  });
  assert.equal(view.assemblyStatus, null);
  assert.equal(view.audioDuration, null);
  assert.equal(view.error, null);
  assert.equal(view.htmlFileId, null);
});

test('a long transcript with only a handful of words is sparse', () => {
  assert.equal(isSparseTranscript({
    audio_duration: 4471,
    words: [{}, {}, {}, {}, {}],
    multichannel: false,
  }), true);
  assert.equal(isSparseTranscript({
    audio_duration: 3518,
    words: Array.from({ length: 6706 }, () => ({})),
  }), false);
  assert.equal(isSparseTranscript({ audio_duration: 30, words: [] }), false);
  assert.equal(isSparseTranscript({
    audio_duration: 4000,
    words: [],
    multichannel: true,
  }), false);
});

test('duplicate stereo channels collapse to one speaker', () => {
  const paragraphs = paragraphsFromUtterances([
    { channel: 1, speaker: '1A', start: 0, text: 'And if they are really a help' },
    { channel: 2, speaker: '2A', start: 10, text: 'And if they are really a help' },
    { channel: 1, speaker: '1B', start: 4000, text: 'We spend two sessions' },
    { channel: 2, speaker: '2B', start: 4010, text: 'We spend two sessions' },
  ]);
  assert.deepEqual(paragraphs, [
    { speaker: 'A', text: 'And if they are really a help', start: 0, end: 0 },
    { speaker: 'B', text: 'We spend two sessions', start: 4, end: 4 },
  ]);
});

test('channels collapse when the words match but the breaks do not', () => {
  const paragraphs = paragraphsFromUtterances([
    { channel: 1, speaker: '1A', start: 0, end: 200, text: 'And if' },
    { channel: 1, speaker: '1A', start: 200, end: 700, text: 'they are really a help' },
    { channel: 2, speaker: '2A', start: 0, end: 400, text: 'And if they are' },
    { channel: 2, speaker: '2A', start: 400, end: 700, text: 'really a help' },
  ]);
  assert.deepEqual(paragraphs, [
    { speaker: 'A', text: 'And if they are really a help', start: 0, end: 0.7 },
  ]);
});

test('a pause starts a new paragraph for the same speaker', () => {
  const paragraphs = paragraphsFromUtterances([
    { channel: 1, speaker: '1A', start: 0, end: 400, text: 'Three things' },
    { channel: 1, speaker: '1A', start: 500, end: 900, text: 'in the first three hours' },
    { channel: 1, speaker: '1A', start: 4000, end: 4600, text: 'He forgave people' },
  ]);
  assert.deepEqual(paragraphs, [
    { speaker: 'A', text: 'Three things in the first three hours', start: 0, end: 0.9 },
    { speaker: 'A', text: 'He forgave people', start: 4, end: 4.6 },
  ]);
});

test('channels still collapse when one side hears an extra word', () => {
  const word = (channel, speaker, text, start) => ({
    channel,
    speaker,
    start,
    end: start + 180,
    text,
    words: [{ text, start, end: start + 180 }],
  });
  const paragraphs = paragraphsFromUtterances([
    word(1, '1A', 'Please', 0),
    word(1, '1A', 'turn', 200),
    word(1, '1A', 'to', 400),
    word(1, '1A', 'the', 600),
    word(2, '2A', 'Please', 10),
    word(2, '2A', 'extra', 190),
    word(2, '2A', 'turn', 220),
    word(2, '2A', 'to', 410),
    word(2, '2A', 'the', 610),
  ]);
  assert.deepEqual(paragraphs, [
    { speaker: 'A', text: 'Please turn to the', start: 0, end: 0.78 },
  ]);
});

test('interleaved channel labels are the duplicated stereo pass', () => {
  assert.equal(looksInterleaved([
    { speaker: '1A', text: 'Please' },
    { speaker: '2A', text: 'Please' },
    { speaker: '1A', text: 'turn' },
    { speaker: '2A', text: 'turn' },
    { speaker: '1A', text: 'to' },
    { speaker: '2A', text: 'to' },
  ]), true);
  assert.equal(looksInterleaved([
    { speaker: 'A', text: 'Please turn to the first outline.' },
    { speaker: 'B', text: 'That is the second point.' },
  ]), false);
});

test('distinct channels stay in time order', () => {
  const paragraphs = paragraphsFromUtterances([
    { channel: 2, speaker: '2A', start: 1500, text: 'The budget needs another look today' },
    { channel: 1, speaker: '1A', start: 0, text: 'Good morning everyone and welcome' },
  ]);
  assert.deepEqual(paragraphs, [
    { speaker: '1A', text: 'Good morning everyone and welcome', start: 0, end: 0 },
    { speaker: '2A', text: 'The budget needs another look today', start: 1.5, end: 1.5 },
  ]);
});

test('clean up copies times from the original paragraph', () => {
  assert.deepEqual(withOriginalTimes(
    [{ speaker: 'A', text: 'Um hello', start: 12.5, end: 18 }],
    [{ speaker: 'A', text: 'Hello' }],
  ), [{ speaker: 'A', text: 'Hello', start: 12.5, end: 18 }]);
});

test('a session number becomes the series order', () => {
  assert.equal(sessionTitle('2015. TT. Session 2.mp3'), '2015. TT. Session 2');
  assert.equal(sessionTitle('2015. TT. Session 2'), '2015. TT. Session 2');
  assert.equal(sessionOrder('2015. TT. Session 2.mp3'), 2);
  assert.equal(sessionOrder('Interview.mp3'), null);
  const catalog = upsertPublishedSession(null, {
    id: 'job-2',
    title: '2015. TT. Session 2.mp3',
    order: 2,
    driveFileId: 'file-2',
    mimeType: 'audio/mpeg',
    paragraphs: [{ speaker: 'A', text: 'Please turn', start: 0, end: 3.2 }],
  });
  const again = upsertPublishedSession(catalog, {
    id: 'job-9',
    title: 'Notes.mp3',
    driveFileId: 'file-9',
    paragraphs: [{ speaker: 'A', text: 'Later' }],
  });
  const view = publicCatalog(again);
  assert.deepEqual(view.series[0].sessions.map((session) => session.order), [2, 3]);
  assert.equal(view.series[0].title, "Teacher's Training");
  assert.equal(paragraphIndexAt(catalog.series['teachers-training'].sessions[0].paragraphs, 1.2), 0);
  assert.equal(paragraphIndexAt(catalog.series['teachers-training'].sessions[0].paragraphs, 4), 0);
});

test('a channel retry asks AssemblyAI to transcribe each channel', () => {
  const plain = transcriptBody('https://cdn.example/audio', null);
  assert.equal(plain.speaker_labels, true);
  assert.equal(plain.multichannel, undefined);
  const retry = transcriptBody('https://cdn.example/audio', 'https://app.example/hook', { multichannel: true });
  assert.equal(retry.multichannel, true);
  assert.equal(retry.webhook_url, 'https://app.example/hook');
  assert.equal(retry.speaker_labels, true);
});

test('the followup transcript id is stored and still finds the original job', () => {
  const stored = normalizeStoredJob('mono-id', {
    id: 'mono-id',
    status: 'transcribing',
    followupTranscriptId: 'channel-id',
    driveFileName: 'Session 4.mp3',
  });
  assert.equal(stored.followupTranscriptId, 'channel-id');
  const found = findJob({ jobs: { 'mono-id': stored } }, 'channel-id');
  assert.equal(found.key, 'mono-id');
  assert.equal(found.job.driveFileName, 'Session 4.mp3');
});
