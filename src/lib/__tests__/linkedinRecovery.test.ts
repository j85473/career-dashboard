import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePostingIdentity, isLikelyDuplicatePosting } from '../jobIngestion';
import { conflictingLinkedInObservation, linkedinPostingId, resolveLinkedInObservation } from '../linkedinIdentity';
import { linkedInSearchParams, newLinkedInSearchProgress, readLinkedInSearchProgress, runLinkedInSearch } from '../linkedinSearch';
import { evaluateProviderBudget, providerTaskAvailability } from '../ingestionControl';
import { fetchWithKeyRotation, resetKeyCooldowns } from '../apiFallback';

const epic = { title: 'Quality Manager', company: 'Epic', source: 'LinkedIn (Apify)', sourceId: '4416735155',
  url: 'https://www.linkedin.com/jobs/view/quality-manager-at-epic-4416735155?trk=public_jobs_topcard-title' };
const multitech = { title: 'Channel Marketing Manager', company: 'MultiTech', source: 'LinkedIn', sourceId: '2345204557',
  url: 'https://www.linkedin.com/jobs/view/channel-marketing-manager-at-multitech-4461649452' };
const legacy = { id: 'old-observation', jobId: 'epic-job', sourceId: multitech.sourceId, url: multitech.url,
  job: { ...epic, canonicalUrl: epic.url, fitScore: 98, status: 'applied' } };

test('real Epic and MultiTech postings no longer share identity or match as duplicates', () => {
  assert.notEqual(generatePostingIdentity(epic), generatePostingIdentity(multitech));
  assert.equal(isLikelyDuplicatePosting(epic, multitech), false);
  assert.equal(isLikelyDuplicatePosting(multitech, epic), false);
  const sameLabels = { ...multitech, title: epic.title, company: epic.company, source: epic.source,
    sourceId: epic.sourceId, description: 'same long description '.repeat(100) };
  assert.equal(isLikelyDuplicatePosting({ ...epic, description: sameLabels.description }, sameLabels), false);
});

test('numeric, slugged, regional and guest URLs identify the same public posting', () => {
  for (const url of [
    'https://www.linkedin.com/jobs/view/4461649452',
    'https://linkedin.com/jobs/view/changed-title-4461649452/?tracking=other',
    'https://uk.linkedin.com/jobs/view/channel-marketing-manager-at-multitech-4461649452',
    'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4461649452',
  ]) {
    assert.equal(linkedinPostingId(url), '4461649452');
    assert.equal(generatePostingIdentity({ url }), generatePostingIdentity(multitech));
    assert.equal(isLikelyDuplicatePosting(multitech, { ...multitech, sourceId: 'different-provider-id', url }), true);
  }
  for (const url of ['https://linkedin.com/jobs/view/', 'https://linkedin.com/jobs/view/title-without-id',
    'https://linkedin.com/jobs/search', 'https://linkedin.com.evil.example/jobs/view/4461649452',
    'https://example.com/jobs/view/4461649452', 'bad URL']) assert.equal(linkedinPostingId(url), null);
  assert.equal(generatePostingIdentity({ url: 'https://linkedin.com/jobs/view/title-without-id' }), null);
});

test('only a proved different public posting disqualifies a historical observation', () => {
  assert.equal(conflictingLinkedInObservation(legacy), '4461649452');
  assert.equal(conflictingLinkedInObservation({ ...legacy, job: { url: multitech.url, canonicalUrl: null } }), null);
  assert.equal(conflictingLinkedInObservation({ ...legacy, job: { url: 'https://employer.example/jobs/123', canonicalUrl: null } }), null);
  assert.equal(conflictingLinkedInObservation({ ...legacy, url: null }), null);
});

test('rediscovery escapes the poisoned key without modifying the original job, scores or observation', async () => {
  const original = JSON.stringify(legacy);
  const lookups: string[] = [];
  const result = await resolveLinkedInObservation({ sourceId: multitech.sourceId, incomingUrl: multitech.url,
    find: async (id) => { lookups.push(id); return id === multitech.sourceId ? legacy : null; } });
  assert.equal(result.observation, null);
  assert.equal(result.sourceId, 'linkedin-posting:4461649452');
  assert.equal(result.ignoredObservation, legacy);
  assert.deepEqual(lookups, [multitech.sourceId, 'linkedin-posting:4461649452']);
  assert.equal(JSON.stringify(legacy), original);
  const recovered = { ...legacy, id: 'new-observation', jobId: 'multitech-job', sourceId: result.sourceId,
    job: { ...legacy.job, ...multitech, canonicalUrl: multitech.url } };
  const repeat = await resolveLinkedInObservation({ sourceId: multitech.sourceId, incomingUrl: multitech.url,
    find: async (id) => id === multitech.sourceId ? legacy : recovered });
  assert.equal(repeat.observation?.jobId, 'multitech-job');
  assert.equal(JSON.stringify(legacy), original);
});

test('ambiguous fresh identities cannot move or reuse a historical observation', async () => {
  await assert.rejects(resolveLinkedInObservation({ sourceId: multitech.sourceId, incomingUrl: epic.url,
    find: async () => legacy }), /matching fresh posting URL/);
  await assert.rejects(resolveLinkedInObservation({ sourceId: multitech.sourceId, incomingUrl: multitech.url,
    find: async () => legacy }), /recovery observation conflicts/);
  const untouched = await resolveLinkedInObservation({ sourceId: 'unrelated', find: async () => null });
  assert.equal(untouched.sourceId, 'unrelated');
  assert.equal(untouched.ignoredObservation, null);
});

const now = new Date('2026-09-06T12:00:00Z');
const start = new Date('2026-09-01T12:00:00Z');
const initial = () => newLinkedInSearchProgress('channel account manager', 'msp_metro', start, now);
const row = (id: number) => ({ id, title: 'Channel Account Manager', organization: 'Acme',
  url: `https://www.linkedin.com/jobs/view/${id}`, description_text: 'Channel sales role', locations_derived: ['Minnesota, United States'] });
const page = (from: number, count: number) => Response.json(Array.from({ length: count }, (_, i) => row(from + i)));

test('LinkedIn sends geography and remote preferences separately from job-title terms', () => {
  for (const lane of ['msp_metro', 'minnesota', 'upper_midwest', 'us_remote']) {
    const params = linkedInSearchParams({ ...initial(), lane }, now);
    assert.equal(params.get('title'), 'channel account manager');
    assert.doesNotMatch(params.get('location')!, /55405|\bMN\b/);
    assert.equal(params.get('time_frame'), '7d');
    assert.equal(params.get('source'), 'linkedin');
    assert.equal(params.get('date_created_gte'), start.toISOString());
    assert.equal(params.get('date_created_lt'), now.toISOString());
    assert.equal(params.get('ai_work_arrangement'), lane === 'us_remote' ? 'Remote Solely,Remote OK' : null);
  }
  assert.equal(linkedInSearchParams(initial(), new Date('2026-09-20T12:00:00Z')).get('time_frame'), '6m');
  assert.throws(() => linkedInSearchParams({ ...initial(), lane: 'unknown' }), /Unsupported/);
});

test('cursor continuation resumes after a budget wait with the original time boundaries', async () => {
  let saved = initial();
  let attempts = 0;
  const processed: string[] = [];
  await assert.rejects(runLinkedInSearch({ progress: saved, now: () => now,
    fetchPage: async () => { if (++attempts === 2) throw new Error('LinkedIn request blocked by paced_budget'); return page(1, 20); },
    processJob: async (job) => { processed.push(job.sourceId); }, checkpoint: async (p) => { saved = p; }, diagnose: () => {} }), /paced_budget/);
  const restored = readLinkedInSearchProgress(JSON.parse(JSON.stringify({ linkedin: saved })))!;
  assert.equal(restored.cursor, '20');
  assert.equal(restored.complete, false);
  const finished = await runLinkedInSearch({ progress: restored, now: () => now,
    fetchPage: async (params) => { assert.equal(params.get('cursor'), '20'); assert.equal(params.get('date_created_gte'), start.toISOString()); return page(21, 1); },
    processJob: async (job) => { processed.push(job.sourceId); }, checkpoint: async (p) => { saved = p; }, diagnose: () => {} });
  assert.equal(finished.complete, true);
  assert.equal(new Set(processed).size, 21);
});

test('incomplete processing, cancellation and malformed pages do not advance the checkpoint', async () => {
  for (const response of [Response.json({ data: [] }), Response.json([{}]), new Response('bad JSON'), page(0, 1)]) {
    await assert.rejects(runLinkedInSearch({ progress: initial(), now: () => now, fetchPage: async () => response,
      processJob: async () => {}, checkpoint: async () => { assert.fail('must not advance'); }, diagnose: () => {} }));
  }
  for (const cancel of [false, true]) {
    const abort = new AbortController();
    await assert.rejects(runLinkedInSearch({ progress: initial(), signal: abort.signal, fetchPage: async () => page(1, 1),
      processJob: async () => { if (cancel) abort.abort(); else throw new Error('database write failed'); },
      checkpoint: async () => { assert.fail('must not advance'); }, diagnose: () => {} }));
  }
  assert.equal(readLinkedInSearchProgress({ linkedin: { ...initial(), cursor: '-1' } }), null);
});

test('the bounded turn stays resumable and a valid empty page finishes', async () => {
  const bounded = await runLinkedInSearch({ progress: initial(), maxPages: 1, fetchPage: async () => page(1, 20),
    processJob: async () => {}, checkpoint: async () => {}, diagnose: () => {} });
  assert.equal(bounded.complete, false);
  assert.equal(bounded.cursor, '20');
  const finished = await runLinkedInSearch({ progress: bounded, fetchPage: async () => page(21, 0),
    processJob: async () => {}, checkpoint: async () => {}, diagnose: () => {} });
  assert.equal(finished.complete, true);
});

test('LinkedIn releases 13 requests across the day and the scheduler observes the same pause', () => {
  let used = 0;
  for (let hour = 0; hour < 24; hour++) {
    const at = new Date(Date.UTC(2026, 8, 6, hour));
    while (evaluateProviderBudget({ provider: 'LinkedIn', state: 'closed', dailyLimit: 13, dailyUsed: used, monthlyUsed: used, now: at }).allowed) used++;
    assert.equal(used, Math.floor(13 * (hour + 1) / 24));
  }
  assert.equal(used, 13);
  const record = { state: 'closed', dailyLimit: 13, dailyUsed: 7, monthlyLimit: 400, monthlyUsed: 78, budgetDay: '2026-09-06', budgetMonth: '2026-09' };
  assert.equal(providerTaskAvailability('LinkedIn', record, record, now)?.reason, 'paced_budget');
});

test('LinkedIn transport retries cannot consume its entire daily allowance in one rotation', async () => {
  resetKeyCooldowns();
  let attempts = 0;
  await assert.rejects(fetchWithKeyRotation(Array.from({ length: 23 }, (_, i) => String(i)), async () => {
    attempts++; throw new TypeError('fetch failed');
  }, 'LinkedInJobSearch'), /transport failure/);
  assert.equal(attempts, 3);
});
