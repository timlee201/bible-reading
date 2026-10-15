import assert from 'node:assert/strict';
import test from 'node:test';
import { jobView } from './jobs.js';

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
