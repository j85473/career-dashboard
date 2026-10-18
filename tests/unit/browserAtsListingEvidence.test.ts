import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_LISTING_TITLE_POLICY, recordBrowserListingRejection } from '../../src/lib/browserAtsListingEvidence';
import type { Prisma, JobPipelineEvent } from '../../src/lib/prismaClient';

const input = {
  taskId: 'provider-task', source: 'ATS-example', sourceId: 'board:42',
  board: 'https://careers.example.com/jobs', platform: 'example',
  link: { id: '42', title: 'Registered Nurse', url: 'https://careers.example.com/jobs/42' },
  reason: 'Healthcare/Clinical role rejected',
};

function evidenceStore(failure?: string) {
  const events = new Map<string, JobPipelineEvent>();
  const client = {
    jobPipelineEvent: {
      async upsert(args: { where: { eventKey: string }; update: object; create: JobPipelineEvent }) {
        if (failure) throw Object.assign(new Error('Evidence write failed'), { code: failure });
        assert.deepEqual(args.update, {});
        const prior = events.get(args.where.eventKey);
        if (prior) return prior;
        const saved = { ...args.create, id: `event-${events.size + 1}` };
        events.set(args.where.eventKey, saved);
        return saved;
      },
    },
  } as unknown as Pick<Prisma.TransactionClient, 'jobPipelineEvent'>;
  return { client, events };
}

test('listing rejection keeps complete lightweight source evidence without a job disposition', async () => {
  const { client, events } = evidenceStore();
  const event = await recordBrowserListingRejection(input, client);
  assert.equal(events.size, 1);
  assert.equal(event.eventType, 'crawl_listing_rejected');
  assert.equal(event.stage, 'listing');
  assert.equal(event.taskId, input.taskId);
  assert.equal(event.source, input.source);
  assert.equal(event.sourceId, input.sourceId);
  assert.equal(event.jobId, null);
  assert.deepEqual(event.details, {
    ...input.link, board: input.board, platform: input.platform,
    reason: input.reason, policy: BROWSER_LISTING_TITLE_POLICY,
  });
});

test('replayed evidence is idempotent and changed title or reason receives a new immutable event', async () => {
  const { client, events } = evidenceStore();
  const first = await recordBrowserListingRejection(input, client);
  assert.equal(await recordBrowserListingRejection(input, client), first);
  assert.equal(events.size, 1);
  const changedTitle = await recordBrowserListingRejection({ ...input, link: { ...input.link, title: 'Registered Nurse (RN)' } }, client);
  const changedReason = await recordBrowserListingRejection({ ...input, reason: 'A different existing exclusion' }, client);
  assert.notEqual(changedTitle.eventKey, first.eventKey);
  assert.notEqual(changedReason.eventKey, first.eventKey);
  assert.equal(events.size, 3);
  assert.equal((first.details as { title: string }).title, 'Registered Nurse');
});

test('missing evidence schema stops the caller before its listing cursor advances', async () => {
  const { client, events } = evidenceStore('P2021');
  let offset = 0;
  await assert.rejects(async () => {
    await recordBrowserListingRejection(input, client);
    offset++;
  }, /evidence was not saved/);
  assert.equal(offset, 0);
  assert.equal(events.size, 0);
});

test('evidence write failures propagate and successful evidence exists before cursor advancement', async () => {
  const broken = evidenceStore('P1001');
  await assert.rejects(recordBrowserListingRejection(input, broken.client), /Evidence write failed/);
  const healthy = evidenceStore();
  let offset = 0;
  await recordBrowserListingRejection(input, healthy.client);
  assert.equal(healthy.events.size, 1);
  assert.equal(offset, 0);
  offset++;
  assert.equal(offset, 1);
});

test('the evidence writer cannot read or change existing jobs or scores', async () => {
  const existing = Object.freeze({ id: 'protected-job', status: 'inbox', aimFitScore: 91, experienceFitScore: 88 });
  const before = JSON.stringify(existing);
  const { client } = evidenceStore();
  const guarded = new Proxy(client, {
    get(target, key, receiver) {
      assert.equal(key, 'jobPipelineEvent', 'Only append-only event storage is available');
      return Reflect.get(target, key, receiver);
    },
  });
  const event = await recordBrowserListingRejection(input, guarded);
  assert.equal(event.jobId, null);
  assert.equal(JSON.stringify(existing), before);
});

test('incomplete rejection evidence is not persisted', async () => {
  const { client, events } = evidenceStore();
  await assert.rejects(recordBrowserListingRejection({ ...input, reason: '' }, client), /requires/);
  assert.equal(events.size, 0);
});
