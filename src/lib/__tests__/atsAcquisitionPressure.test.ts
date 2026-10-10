import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import {
  ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK, ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK,
  ATS_V2_MAX_UNFINISHED_LISTINGS, evaluateAtsAcquisitionPressure,
} from '../atsAcquisitionPressure';
import { admitAtsV2Board, atsV2StagingSnapshot, findAtsContinuationCandidate } from '../atsAcquisitionLedger';
import { atsV2RuntimeLanePlan } from '../atsAcquisitionDispatcherV2';
import { prisma } from '../prisma';

test('admission stops before hard capacity and counts unfinished listings even with few records', () => {
  const idle = { items: 0, bytes: BigInt(0), unfinishedListings: 0 };
  assert.equal(evaluateAtsAcquisitionPressure(idle).admissionBlocked, false);
  const early = evaluateAtsAcquisitionPressure({ ...idle, items: ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK / 2 });
  assert.equal(early.admissionReason, 'staging');
  assert.equal(early.blocked, false);
  assert.equal(evaluateAtsAcquisitionPressure({ ...idle, bytes: ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK / BigInt(2) }).admissionBlocked, true);
  const unfinished = evaluateAtsAcquisitionPressure({ ...idle, unfinishedListings: ATS_V2_MAX_UNFINISHED_LISTINGS });
  assert.equal(unfinished.admissionReason, 'unfinished_listings');
  assert.equal(unfinished.blocked, false);
  assert.equal(evaluateAtsAcquisitionPressure({ ...idle, items: ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK }).blocked, true);
});

test('eight simultaneous admissions cannot exceed the unfinished listing allowance', async () => {
  const original = prisma.$transaction;
  let active = ATS_V2_MAX_UNFINISHED_LISTINGS - 1;
  let tail = Promise.resolve();
  let admissions = 0;
  prisma.$transaction = (async (run: (client: unknown) => Promise<unknown>, options: { isolationLevel: string }) => {
    assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.ReadCommitted);
    let unlock = () => {};
    const client = {
      $executeRaw: async (parts: TemplateStringsArray) => {
        if (parts.join('').includes('pg_advisory_xact_lock')) {
          const previous = tail;
          tail = new Promise<void>((resolve) => { unlock = resolve; });
          await previous;
        }
      },
      $queryRaw: async () => [{ items: 0, bytes: 0, unfinishedListings: active }],
      atsCompany: { findUnique: async () => ({ acquisitionEngine: 'v2', nextCheckDate: new Date(0), status: 'active', checkDay: 5 }) },
      atsAcquisitionRuntimeGate: { findUnique: async () => ({ admissionState: 'open', v2AuthorityActivatedAt: new Date(0), activatedLedgerVersion: 2, minimumWriterVersion: 3, compatibilityWriterVersion: 3 }) },
      atsIngestionBatch: {
        findFirst: async () => null,
        create: async () => { await Promise.resolve(); active++; admissions++; },
      },
      atsEndpointSweepReceipt: { create: async () => {} },
      atsAcquisitionWorkReceipt: { create: async () => {} },
    };
    try { return await run(client); } finally { unlock(); }
  }) as typeof prisma.$transaction;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => admitAtsV2Board({ slug: `board-${i}`, platform: 'workday' })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(admissions, 1);
    assert.equal(active, ATS_V2_MAX_UNFINISHED_LISTINGS);
  } finally { prisma.$transaction = original; }
});

test('pressure snapshot does not let delayed retries consume active admission slots', async () => {
  let sql = '';
  const client = { $queryRaw: async (query: Prisma.Sql) => {
    sql = query.sql;
    return [{ items: 640, bytes: 1000, unfinishedListings: 32 }];
  } } as unknown as Parameters<typeof atsV2StagingSnapshot>[0];
  const pressure = await atsV2StagingSnapshot(client, new Date('2026-10-09T19:00:00Z'));
  assert.equal(pressure.admissionBlocked, true);
  assert.match(sql, /"nextAcquireAt" IS NULL OR batch\."nextAcquireAt" <=/);
  assert.match(sql, /"acquisitionLeaseExpiresAt" >/);
});

test('existing listings consume continuation capacity before more boards open', async () => {
  const original = prisma.$queryRaw;
  let unfinished = 32;
  prisma.$queryRaw = (async (query: Prisma.Sql | TemplateStringsArray) => ('sql' in query ? query.sql : query.join('')).includes('AS "confirmedContacts"')
    ? [{ confirmedContacts: 100, coverageEligible: 10000, continuationEligible: 100, drainEligible: 0, elapsedFraction: 0.5, remainingDayMs: 10000 }]
    : [{ items: 640, bytes: 1000, unfinishedListings: unfinished }]) as typeof prisma.$queryRaw;
  try {
    const held = await atsV2RuntimeLanePlan(8);
    assert.equal(held.coverageSlots, 0);
    assert.equal(held.continuationSlots, held.totalSlots);
    assert.equal(held.reason, 'finishing_listings');
    unfinished = 8;
    const busy = await atsV2RuntimeLanePlan(8);
    assert.equal(busy.coverageSlots, 1);
    assert.equal(busy.continuationSlots, busy.totalSlots - 1);
  } finally { prisma.$queryRaw = original; }
});

test('productive listing preference retains retry and lease guards', async () => {
  const retryGuard = { acquisitionPhase: 'listing', OR: [{ nextAcquireAt: null }, { nextAcquireAt: { lte: new Date(0) } }] };
  const client = { atsIngestionBatch: { findFirst: async (input: { where: { AND: unknown[]; OR: unknown } }) => {
    assert.equal(input.where.OR, retryGuard.OR);
    if (!input.where.AND) return null;
    assert.deepEqual(input.where.AND[0], { listingOffset: { gt: 0 }, lastError: null, lastServedAt: { gte: new Date('2026-10-09T18:55:00Z') } });
    return { id: 'partially-downloaded', acquisitionPhase: 'listing' };
  } } } as unknown as Parameters<typeof findAtsContinuationCandidate>[0];
  assert.equal((await findAtsContinuationCandidate(client, retryGuard, [], new Date('2026-10-09T19:00:00Z')))?.id, 'partially-downloaded');
});


test('today has a separate bounded allowance without bypassing volume limits', () => {
  const oldBacklog = { items: 25_000, bytes: BigInt(1_000), unfinishedListings: 1_002, cohortUnfinishedListings: 0 };
  const pressure = evaluateAtsAcquisitionPressure(oldBacklog);
  assert.equal(pressure.admissionBlocked, true);
  assert.equal(pressure.cohortAdmissionAllowed, true);
  assert.equal(evaluateAtsAcquisitionPressure({ ...oldBacklog, cohortUnfinishedListings: 32 }).cohortAdmissionAllowed, false);
  assert.equal(evaluateAtsAcquisitionPressure({ ...oldBacklog, items: ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK / 2 }).cohortAdmissionAllowed, false);
  assert.equal(evaluateAtsAcquisitionPressure({ ...oldBacklog, bytes: ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK / BigInt(2) }).cohortAdmissionAllowed, false);
  assert.equal(evaluateAtsAcquisitionPressure({ ...oldBacklog, items: ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK }).cohortAdmissionAllowed, false);
});

test('old backlog reserves one coverage lane and two shared listing slots', async () => {
  const original = prisma.$queryRaw;
  let cohortUnfinishedListings = 0;
  let items = 25_000;
  prisma.$queryRaw = (async (query: Prisma.Sql | TemplateStringsArray) => ('sql' in query ? query.sql : query.join('')).includes('AS "confirmedContacts"')
    ? [{ confirmedContacts: 1, coverageEligible: 10000, continuationEligible: 1000, drainEligible: 8, elapsedFraction: 0.5, remainingDayMs: 10000 }]
    : [{ items, bytes: 1000, unfinishedListings: 1002, cohortUnfinishedListings }]) as typeof prisma.$queryRaw;
  try {
    const balanced = await atsV2RuntimeLanePlan(8);
    assert.equal(balanced.coverageSlots, 1);
    assert.equal(balanced.continuationSlots, balanced.totalSlots - 1);
    assert.equal(balanced.listingConcurrencyLimit, 2);
    assert.equal(balanced.reason, 'cohort_balanced');
    cohortUnfinishedListings = 32;
    const full = await atsV2RuntimeLanePlan(8);
    assert.equal(full.coverageSlots, 0);
    assert.equal(full.listingConcurrencyLimit, 2);
    cohortUnfinishedListings = 0;
    items = ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK / 2;
    const volumeHeld = await atsV2RuntimeLanePlan(8);
    assert.equal(volumeHeld.coverageSlots, 0);
    assert.equal(volumeHeld.listingConcurrencyLimit, 1);
  } finally { prisma.$queryRaw = original; }
});

test('cohort admission is atomic across hosts and older/recovery boards cannot spend its allowance', async () => {
  const original = prisma.$transaction;
  const now = new Date('2026-10-10T15:00:00Z');
  let cohort = 31;
  let listings = 0;
  let admissions = 0;
  let tail = Promise.resolve();
  let status = 'active';
  let checkDay = 6;
  prisma.$transaction = (async (run: (client: unknown) => Promise<unknown>) => {
    let unlock = () => {};
    const client = {
      $executeRaw: async (parts: TemplateStringsArray) => {
        if (parts.join('').includes('ats-v2-board-admission')) {
          const previous = tail;
          tail = new Promise<void>((resolve) => { unlock = resolve; });
          await previous;
        }
      },
      $queryRaw: async () => [{ items: 25000, bytes: 1000, unfinishedListings: 1002, cohortUnfinishedListings: cohort }],
      atsCompany: { findUnique: async () => ({ acquisitionEngine: 'v2', nextCheckDate: new Date(0), status, checkDay }) },
      atsAcquisitionRuntimeGate: { findUnique: async () => ({ admissionState: 'open', v2AuthorityActivatedAt: new Date(0), activatedLedgerVersion: 2, minimumWriterVersion: 3, compatibilityWriterVersion: 3 }) },
      atsIngestionBatch: {
        findFirst: async (args: { where: { acquisitionPhase?: unknown } }) => args.where.acquisitionPhase ? { id: 'drain' } : null,
        count: async () => listings,
        create: async () => { await Promise.resolve(); cohort++; listings++; admissions++; },
      },
      atsEndpointSweepReceipt: { create: async () => {} }, atsAcquisitionWorkReceipt: { create: async () => {} },
    };
    try { return await run(client); } finally { unlock(); }
  }) as typeof prisma.$transaction;
  try {
    checkDay = 5;
    assert.equal(await admitAtsV2Board({ slug: 'older-cohort', platform: 'workday', now }), null);
    checkDay = 6; status = 'parked';
    assert.equal(await admitAtsV2Board({ slug: 'recovery', platform: 'workday', now }), null);
    status = 'active'; listings = 2;
    assert.equal(await admitAtsV2Board({ slug: 'no-producer-slot', platform: 'workday', now }), null);
    assert.equal(cohort, 31);
    listings = 0;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => admitAtsV2Board({ slug: `today-${i}`, platform: 'workday', now })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(admissions, 1);
    assert.equal(cohort, 32);
  } finally { prisma.$transaction = original; }
});

test('cohort pressure excludes recovery boards and keeps UTC retry and lease predicates', async () => {
  let captured: Prisma.Sql | undefined;
  const client = { $queryRaw: async (query: Prisma.Sql) => {
    captured = query;
    return [{ items: 25000, bytes: 1000, unfinishedListings: 1002, cohortUnfinishedListings: 0 }];
  } } as unknown as Parameters<typeof atsV2StagingSnapshot>[0];
  const pressure = await atsV2StagingSnapshot(client, new Date('2026-10-10T15:00:00Z'));
  assert.equal(pressure.cohortAdmissionAllowed, true);
  assert.match(captured!.sql, /board.status = 'active' AND board."checkDay" =/);
  assert.ok(captured!.values.includes(6));
});
