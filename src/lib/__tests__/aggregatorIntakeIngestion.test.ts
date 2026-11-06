import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '../prismaClient';
import type { AggregatorIntakeDecision } from '../aggregatorIntake';

test('both real intake routes create no Job or score work for absent, pending, or failed-to-retain arrivals', async () => {
  let jobCreates = 0;
  const candidates: any[] = [], events: any[] = [];
  const empty = async () => [];
  const absent = async () => null;
  let persistFails = false;
  const fake = {
    providerCircuit: { findMany: empty }, companyNameRule: { findMany: empty },
    jobSourceObservation: { findUnique: absent, findFirst: absent },
    job: { findMany: empty, findUnique: absent, findFirst: absent,
      create: async () => { jobCreates++; throw new Error('Unverified intake must not create a Job'); } },
    $queryRaw: empty,
    ingestionSourceRun: { create: async () => ({ id: 'source-run' }), update: async () => ({}) },
    jobPipelineEvent: { upsert: async (args: any) => { events.push(args); return {}; } },
    aggregatorIntakeCandidate: { upsert: async (args: any) => {
      if (persistFails) throw new Error('Retained intake storage unavailable');
      candidates.push(args); return {};
    } },
  };
  (globalThis as unknown as { prisma: PrismaClient }).prisma = fake as unknown as PrismaClient;
  const { ingestJobs, ingestExternalJob } = await import('../jobIngestion');
  const job = { source: 'Himalayas', sourceId: '123', title: 'Channel Sales Manager', company: 'Huntress',
    location: 'Remote, United States', url: 'https://himalayas.app/companies/huntress/jobs/channel-sales-manager',
    description: 'Manage channel partner relationships and sales plans. '.repeat(30) };
  const run = (decision: AggregatorIntakeDecision) => ingestJobs(undefined, undefined, undefined, undefined, 'pending_af', true,
    { useStandard: false, usePaidApis: false, useCareerforce: false, prefetchedAggregatorCandidates: [job],
      requireCanonicalMatch: true, assessAggregatorCandidate: async () => decision });
  assert.equal(await run({ kind: 'expired', reason: 'absent_from_complete_employer_catalogue', boards: [{ platform: 'greenhouse', slug: 'huntress' }] }), 0);
  assert.equal(candidates.at(-1).create.status, 'expired');
  assert.equal(await run({ kind: 'pending', reason: 'live_unavailable' }), 0);
  assert.equal(candidates.at(-1).create.status, 'pending');
  assert.equal(await run({ kind: 'unknown_board' }), 0);
  assert.equal(candidates.at(-1).create.reason, 'no_verified_board');
  for (const decision of [{ kind: 'pending', reason: 'live_unavailable' },
    { kind: 'expired', reason: 'absent_from_complete_employer_catalogue', boards: [] },
    { kind: 'unknown_board' }] as AggregatorIntakeDecision[]) {
    assert.equal(await ingestExternalJob(job, 'pending_af', {
      requireCanonicalMatch: true, assessAggregatorCandidate: async () => decision,
    }), 'filtered');
    assert.equal(candidates.at(-1).create.context.route, 'external');
  }
  persistFails = true;
  await assert.rejects(run({ kind: 'pending', reason: 'live_unavailable' }), /Retained aggregator candidate processing failed/);
  await assert.rejects(ingestExternalJob(job, 'pending_af', {
    assessAggregatorCandidate: async () => ({ kind: 'pending', reason: 'live_unavailable' }),
  }), /Retained intake storage unavailable/);
  assert.equal(jobCreates, 0);
  assert.ok(events.some(event => event.create.eventType === 'canonical_intake_expired'));
  assert.ok(events.some(event => event.create.eventType === 'canonical_intake_pending'));
});
