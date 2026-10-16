import assert from 'node:assert/strict';
import test from 'node:test';
import { jobView, latestOpenJob, listJobViews } from './jobs.js';
import {
  appendFileCrumb,
  breadcrumbsFor,
  buildBreadcrumbs,
  buildFolderView,
  folderListQuery,
  isTranscribed,
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
