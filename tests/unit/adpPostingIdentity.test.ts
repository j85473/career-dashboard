import assert from 'node:assert/strict';
import test from 'node:test';
import { adpPostingIdentity, adpPostingKey, matchesAdpPosting } from '../../src/lib/adpPostingIdentity';
import { findAdpPostingCandidates, generatePostingIdentity, isDirectAtsReprint, isLikelyDuplicatePosting } from '../../src/lib/jobIngestion';
import { urlPostingIdentity, reconcileJobUrlEdit } from '../../src/lib/jobUrlReconciliation';
import type { Job, Prisma } from '../../src/lib/prismaClient';

const tower = 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=0d986324-3b72-4320-8897-ce85b3aa5b54&ccId=19000101_000001&type=JS&lang=en_US&jobId=588833';
const kwik = tower.replace('0d986324-3b72-4320-8897-ce85b3aa5b54', '23616845-0503-4e0b-8571-384ba630ca8a');

test('Tower and Kwik Chek job 588833 remain distinct even with identical source IDs and descriptions', () => {
  assert.notEqual(generatePostingIdentity({ url: tower }), generatePostingIdentity({ url: kwik }));
  assert.notEqual(urlPostingIdentity(tower), urlPostingIdentity(kwik));
  const common = { title: 'Same role', company: 'Same label', location: 'Remote', description: 'x'.repeat(500), source: 'ATS-adp', sourceId: '588833' };
  assert.equal(isLikelyDuplicatePosting({ ...common, url: tower }, { ...common, url: kwik }), false);
  assert.equal(isLikelyDuplicatePosting({ ...common, url: tower }, { ...common, url: tower.replace('19000101_000001', 'OTHER') }), false);
  assert.equal(isLikelyDuplicatePosting({ ...common, url: tower }, { ...common, url: tower.replace('588833', '588834') }), false);
  assert.equal(isDirectAtsReprint({ ...common, description: 'x'.repeat(1500), url: kwik }, { ...common, description: 'x'.repeat(1500), source: 'Himalayas', url: tower }), false);
});

test('ingestion can still retrieve an older genuine ADP duplicate with a legacy stored hash', async () => {
  const historical = { id: 'old-tower', url: tower, canonicalUrl: tower, postingIdentity: 'legacy-shared-number',
    createdAt: new Date('2025-01-01'), passReason: null };
  const calls: unknown[] = [];
  const store = { job: {
    findMany: async (query: { where: unknown }) => {
      calls.push(query);
      return [historical, { ...historical, id: 'wrong-employer', url: kwik, canonicalUrl: kwik }];
    },
  } } as unknown as Pick<Prisma.TransactionClient, 'job'>;
  const matches = await findAdpPostingCandidates(tower, store);
  assert.deepEqual(matches.map(row => row.id), [historical.id]);
  const lookup = calls.find(query => JSON.stringify(query).includes('0d986324-3b72-4320-8897-ce85b3aa5b54'));
  assert.ok(lookup);
  assert.doesNotMatch(JSON.stringify(lookup), /gte|legacy-shared-number/);
});

test('ADP ignores presentation and tracking while keeping the selected last job number', () => {
  const variants = [tower.replace('&ccId=19000101_000001', ''), tower.replace('en_US', 'es_ES'), `${tower}&utm_source=test`, tower.replace('jobId=588833', 'jobId=100&jobId=588833')];
  for (const url of variants) {
    assert.equal(adpPostingKey(url), adpPostingKey(tower));
    assert.equal(urlPostingIdentity(url), urlPostingIdentity(tower));
    assert.equal(isLikelyDuplicatePosting({ url: tower }, { url }), true);
  }
  assert.notEqual(urlPostingIdentity(`${tower}&jobId=999`), urlPostingIdentity(tower));
  assert.equal(adpPostingIdentity(tower)?.jobId, '588833');
});

test('malformed or ambiguous ADP identities never fall through to shared host plus number', () => {
  for (const url of [tower.replace(/cid=[^&]+/, 'cid=bad'), `${tower}&cid=23616845-0503-4e0b-8571-384ba630ca8a`, `${tower}&ccId=OTHER`, tower.replace('jobId=588833', 'jobId='), tower.replace('/recruitment.html', '/other.html'), tower.replace('https:', 'ftp:')]) {
    assert.equal(adpPostingIdentity(url), null);
    assert.equal(generatePostingIdentity({ url }), null);
    assert.equal(urlPostingIdentity(url), null);
  }
});

test('legacy stored identities cannot make a different employer a pasted-link duplicate', () => {
  const legacy = { url: kwik, canonicalUrl: kwik, postingIdentity: 'old-shared-adp-number' };
  const before = structuredClone(legacy);
  assert.equal(matchesAdpPosting(legacy, tower), false);
  assert.equal(matchesAdpPosting(legacy, kwik), true);
  assert.equal(matchesAdpPosting({ url: null, canonicalUrl: kwik }, kwik), true);
  assert.equal(matchesAdpPosting({ url: tower, canonicalUrl: kwik }, tower), false);
  assert.deepEqual(legacy, before);
});

test('editing a Tower link cannot merge a Kwik Chek card, even when legacy hashes collide', async () => {
  const current = { id: 'tower', url: null, canonicalUrl: null, company: 'TOWER LABORATORIES LTD.', title: 'Strategic Partnerships Manager - Remote', location: 'Remote, Centerbrook, CT, US', status: 'applied', scoringStatus: 'scored', fitScore: 86, aimFitScore: 90, updatedAt: new Date(), passReason: null } as Job;
  const unrelated = { ...current, id: 'kwik', url: kwik, canonicalUrl: kwik, company: 'Kwik Chek Food Stores', postingIdentity: urlPostingIdentity(tower) };
  const rows = new Map([[current.id, structuredClone(current)], [unrelated.id, structuredClone(unrelated)]]);
  const before = structuredClone(unrelated);
  const tx = {
    $queryRaw: async () => [], $executeRaw: async () => 0,
    job: {
      findMany: async () => [rows.get('kwik')],
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Job> }) => {
        assert.equal(where.id, 'tower');
        const row = { ...rows.get(where.id)!, ...data }; rows.set(where.id, row); return row;
      },
    },
  } as unknown as Prisma.TransactionClient;
  const result = await reconcileJobUrlEdit(tx, { id: current.id, url: tower, expectedUpdatedAt: current.updatedAt });
  assert.equal(result.job.id, 'tower');
  assert.equal(result.job.status, 'applied');
  assert.equal(result.job.aimFitScore, 90);
  assert.equal(result.job.postingIdentity, urlPostingIdentity(tower));
  assert.deepEqual(rows.get('kwik'), before);
});
