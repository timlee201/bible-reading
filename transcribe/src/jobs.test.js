import assert from 'node:assert/strict';
import test from 'node:test';
import { jobView, latestOpenJob } from './jobs.js';

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
