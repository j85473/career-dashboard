import assert from 'node:assert/strict';
import test from 'node:test';
import { dayforceSnapshotMatchesCard, restoredDayforceJob, validateDayforceSnapshot } from '../../../scripts/repair_dayforce_postings';

const url = 'https://jobs.dayforcehcm.com/en-US/pelican/CANDIDATEPORTAL/jobs/6689';
const raw = { id: 'pelican::en-US::pelican::CANDIDATEPORTAL::jobs::6689',
  title: 'Territory Sales Representative', company: 'Pelican Products, Inc.', location: 'Maple Grove, MN, US',
  description: 'Develop dealer and distributor relationships across Minnesota, Wisconsin, Illinois, North Dakota and South Dakota. Manage existing accounts, provide training and drive territory growth. '.repeat(15),
  url, createdAt: '2026-10-14T12:00:00Z' };

test('repair accepts only an immutable snapshot bound to the exact observed source and career site', () => {
  const observation = { sourceId: raw.id, url };
  assert.equal(validateDayforceSnapshot(observation, raw), true);
  assert.equal(validateDayforceSnapshot(observation, { ...raw, id: 'other-source' }), false);
  assert.equal(validateDayforceSnapshot(observation, { ...raw, url: url.replace('/pelican/', '/amphenol/') }), false);
  assert.equal(validateDayforceSnapshot(observation, { ...raw, description: '' }), false);
});

test('restoration uses the lost posting itself and never inherits a merged card score or application', () => {
  const restored = restoredDayforceJob(raw, new Date('2026-10-15T05:50:48Z'), 'restored-id');
  assert.equal(restored.title, raw.title);
  assert.equal(restored.description, raw.description);
  assert.equal(restored.sourceId, raw.id);
  assert.equal(restored.status, 'pending_af');
  assert.equal(restored.scoringStatus, 'queued');
  for (const field of ['fitScore', 'aimFitScore', 'reqFitScore', 'submittedResume', 'batchJobId', 'afBatchId']) {
    assert.equal(field in restored, false, field);
  }
});

test('restored international postings retain their own metadata and pass through normal intake filtering', () => {
  const restored = restoredDayforceJob({ ...raw, location: 'London, England, GB' }, new Date(), 'international');
  assert.equal(restored.status, 'archived');
  assert.equal(restored.scoringStatus, 'skipped');
  assert.match(restored.passReason || '', /location|international|outside/i);
});

test('an earlier source promotion is repaired from the original JD rather than the overwritten source label', () => {
  const description = Array.from({ length: 200 }, (_, i) => `dealer planning territory${i} training growth`).join(' ');
  const jcb = { title: 'Regional Business Manager - CE', company: 'JCB', description };
  assert.equal(dayforceSnapshotMatchesCard(jcb, { ...raw, title: jcb.title, company: 'JCB North America', description: description + ' Additional posting footer.' }), true);
  assert.equal(dayforceSnapshotMatchesCard(jcb, { ...raw, title: 'Kingston - Store Sales Associate', company: 'Running Room' }), false);
  assert.equal(dayforceSnapshotMatchesCard(jcb, { ...raw, title: jcb.title, company: 'Running Room' }), false);
});
