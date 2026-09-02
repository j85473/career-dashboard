import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job, Prisma } from '@prisma/client';
import { JobUrlConflict, reconcileJobUrlEdit, urlMetadataConflict, urlPostingIdentity } from '../jobUrlReconciliation';

const directUrl = 'https://jobs.lever.co/patchmypc/e2d946b2-c0e5-4f58-81a4-fb6ce844a114';
const otherUrl = 'https://jobs.lever.co/patchmypc/360a40b7-9c2a-4bf4-bf6f-55aab18a70ff';
function row(overrides: Partial<Job> = {}): Job {
  return { id: 'copy', title: 'Account Manager, Channel Success', company: 'Patch My PC',
    location: 'United States', status: 'inbox', url: 'https://himalayas.app/companies/patch-my-pc/jobs/account-manager-channel-success',
    canonicalUrl: null, postingIdentity: 'old-source-key', source: 'Himalayas', sourceId: 'original-himalayas-id',
    updatedAt: new Date('2026-09-02T15:50:00Z'), tailoringStaged: false, passReason: null,
    aimFitScore: 88, reqFitScore: 81, scoringStatus: 'scored', description: 'Scored description',
    submittedResume: null, ...overrides } as Job;
}
function fixture(rows: Job[]) {
  const saved = new Map(rows.map(r => [r.id, structuredClone(r)]));
  const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
  const events: Array<Record<string, unknown>> = [];
  const movedSources: unknown[] = [];
  let query: unknown;
  const tx = {
    $queryRaw: async () => [],
    job: {
      findMany: async (args: unknown) => { query = args; return rows.filter(r => r.id !== 'copy'); },
      findUnique: async ({ where }: { where: { id: string } }) => saved.get(where.id),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        writes.push({ id: where.id, data });
        const updated = { ...saved.get(where.id)!, ...data };
        saved.set(where.id, updated);
        return updated;
      },
    },
    jobSourceObservation: {
      updateMany: async (args: unknown) => { movedSources.push(args); return { count: 1 }; },
      upsert: async (args: unknown) => { movedSources.push(args); return {}; },
    },
    jobPipelineEvent: { upsert: async ({ create }: { create: Record<string, unknown> }) => { events.push(create); return create; } },
  } as unknown as Prisma.TransactionClient;
  return { tx, saved, writes, events, movedSources, query: () => query };
}

test('posting keys equate tracking and apply URLs, but reject boards and distinguish requisitions', () => {
  assert.equal(urlPostingIdentity(directUrl), urlPostingIdentity(`${directUrl}/apply?utm_source=test`));
  assert.notEqual(urlPostingIdentity(directUrl), urlPostingIdentity(otherUrl));
  for (const url of ['https://jobs.lever.co/patchmypc', 'https://example.com/acme2/jobs', 'https://example.com/jobs/view/12345', 'https://example.com/careers', 'javascript:alert(1)']) assert.equal(urlPostingIdentity(url), null);
});

test('an applied match survives spacing differences and retains both records scores and history', async () => {
  const source = row();
  const target = row({ id: 'applied', status: 'applied', company: 'Patchmypc', url: directUrl, canonicalUrl: directUrl,
    postingIdentity: null, submittedResume: 'my-actual-resume.docx', aimFitScore: 92, reqFitScore: 87 });
  const f = fixture([source, target]);
  const result = await reconcileJobUrlEdit(f.tx, { id: source.id, url: directUrl, expectedUpdatedAt: source.updatedAt });
  assert.equal(result.job.id, 'applied');
  assert.equal(result.consolidatedJobId, 'copy');
  assert.equal(f.saved.get('copy')?.status, 'dismissed');
  assert.equal(result.job.status, 'applied');
  assert.equal(result.job.submittedResume, target.submittedResume);
  for (const original of [source, target]) {
    const saved = f.saved.get(original.id)!;
    for (const key of ['aimFitScore', 'reqFitScore', 'description', 'scoringStatus'] as const) assert.equal(saved[key], original[key]);
  }
  assert.deepEqual(f.writes.find(w => w.id === 'applied')?.data, { postingIdentity: urlPostingIdentity(directUrl) });
  assert.equal(f.events[0].eventType, 'user_lifecycle');
  assert.equal((f.events[0].details as Record<string, unknown>).duplicateOfJobId, 'applied');
  assert.equal(f.movedSources.length, 2);
  assert.ok(!JSON.stringify(f.query()).includes('createdAt'), 'old applications must remain eligible');
});

test('same URL with conflicting US/UK locations refuses all changes', async () => {
  const source = row();
  const f = fixture([source, row({ id: 'uk', url: otherUrl, location: 'United Kingdom', status: 'archived' })]);
  await assert.rejects(reconcileJobUrlEdit(f.tx, { id: source.id, url: otherUrl, expectedUpdatedAt: source.updatedAt }), /location differs/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.movedSources.length, 0);
});

test('no matching requisition updates the URL and key without altering scores or lifecycle', async () => {
  const source = row();
  const f = fixture([source, row({ id: 'different', url: otherUrl })]);
  const result = await reconcileJobUrlEdit(f.tx, { id: source.id, url: `${directUrl}?utm_source=test`, expectedUpdatedAt: source.updatedAt });
  assert.equal(result.consolidatedJobId, null);
  assert.equal(result.job.url, directUrl);
  assert.equal(result.job.canonicalUrl, directUrl);
  assert.equal(result.job.postingIdentity, urlPostingIdentity(directUrl));
  assert.equal(result.job.status, 'inbox');
  assert.equal(result.job.reqFitScore, source.reqFitScore);
});

test('stale edits, ambiguous matches, and protected decisions cannot consolidate', async () => {
  for (const mode of ['stale', 'multiple', 'applied', 'passed', 'cooldown', 'staged', 'combined']) {
    const source = row({ ...(mode === 'staged' ? { tailoringStaged: true } : {}),
      ...(['applied', 'passed', 'cooldown'].includes(mode) ? { status: mode } : {}) });
    const matches = [row({ id: 'target', url: directUrl, status: 'applied' })];
    if (mode === 'multiple') matches.push(row({ id: 'other', url: directUrl }));
    const f = fixture([source, ...matches]);
    await assert.rejects(reconcileJobUrlEdit(f.tx, { id: source.id, url: directUrl,
      expectedUpdatedAt: mode === 'stale' ? new Date(0) : source.updatedAt,
      allowConsolidation: mode !== 'combined' }), JobUrlConflict);
    assert.equal(f.writes.length, 0, mode);
  }
});

test('metadata checks tolerate employer spacing but do not guess across titles or locations', () => {
  assert.equal(urlMetadataConflict(row(), row({ company: 'Patchmypc' })), null);
  assert.equal(urlMetadataConflict(row(), row({ title: 'Account Manager, SMB' })), 'job title');
  assert.equal(urlMetadataConflict(row(), row({ company: 'Another employer' })), 'employer');
});

test('retries return the surviving record without moving history again', async () => {
  const source = row({ status: 'dismissed', passReason: 'Consolidated after URL edit into job target' });
  const f = fixture([source, row({ id: 'target', url: directUrl, status: 'applied' })]);
  const result = await reconcileJobUrlEdit(f.tx, { id: source.id, url: directUrl, expectedUpdatedAt: source.updatedAt });
  assert.equal(result.job.id, 'target');
  assert.equal(f.writes.length, 0);
});

 test('a normal active saved posting can also be the survivor', async () => {
  const source = row();
  const f = fixture([source, row({ id: 'target', url: directUrl, status: 'inbox' })]);
  const result = await reconcileJobUrlEdit(f.tx, { id: source.id, url: directUrl, expectedUpdatedAt: source.updatedAt });
  assert.equal(result.job.id, 'target');
  assert.equal(result.job.status, 'inbox');
  assert.equal(f.saved.get('copy')?.status, 'dismissed');
});
