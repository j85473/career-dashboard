import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Prisma, type PrismaClient } from '@prisma/client';

import { currentAimSuppressedJobIds } from '../src/lib/currentAimFailureSuppression';
import { buildPipelineEventKey } from '../src/lib/ingestionControl';
import { assertJobLifecycleInvariants } from '../src/lib/jobLifecycleInvariant';
import { nonManualImportSourceWhere } from '../src/lib/manualImportPolicy';
import { operationalQueueWhere } from '../src/lib/operationalQueue';
import { prisma } from '../src/lib/prisma';
import { AUTHORITATIVE_SCORE_EVENT_TYPES } from '../src/lib/scoreAuthority';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { USER_LIFECYCLE_INTENT_EVENT_TYPES } from '../src/lib/userLifecycleAuthority';

const VERSION = 'cooldown-release-local-rescore-v1';
const RELEASE_STARTED_AT = new Date('2026-08-28T14:38:00.000Z');
const RELEASE_ENDED_AT = new Date('2026-08-28T14:49:00.000Z');
const LEGACY_CREATED_BEFORE = new Date('2026-08-26T00:00:00.000Z');

type DbClient = PrismaClient | Prisma.TransactionClient;

const candidateSelect = {
  id: true,
  title: true,
  company: true,
  source: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  scoringStatus: true,
  fitScore: true,
  fitCategory: true,
  aimFitScore: true,
  reqFitScore: true,
  batchJobId: true,
  jdBatchId: true,
  afBatchId: true,
  statusHistory: {
    where: {
      status: 'pending_af',
      createdAt: { gte: RELEASE_STARTED_AT, lt: RELEASE_ENDED_AT },
    },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: 1,
    select: { createdAt: true },
  },
} satisfies Prisma.JobSelect;

type Candidate = Prisma.JobGetPayload<{ select: typeof candidateSelect }>;

function cohortWhere(currentSuppressionIds: readonly string[]): Prisma.JobWhereInput {
  return {
    ...operationalQueueWhere('aim_fit', currentSuppressionIds),
    createdAt: { lt: LEGACY_CREATED_BEFORE },
    statusHistory: {
      some: {
        status: 'pending_af',
        createdAt: { gte: RELEASE_STARTED_AT, lt: RELEASE_ENDED_AT },
      },
    },
    scoreEvents: {
      none: { evaluationType: { in: [...AUTHORITATIVE_SCORE_EVENT_TYPES] } },
    },
    scoringBatchItems: { none: { status: 'leased' } },
    pipelineEvents: {
      none: { eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } },
    },
    AND: [nonManualImportSourceWhere()],
  };
}

async function loadCandidates(client: DbClient): Promise<Candidate[]> {
  const suppressionIds = await currentAimSuppressedJobIds(client);
  return client.job.findMany({
    where: cohortWhere(suppressionIds),
    select: candidateSelect,
    orderBy: [{ id: 'asc' }],
  });
}

function selectionHash(candidates: readonly Candidate[]): string {
  return canonicalJsonSha256(candidates.map((candidate) => ({
    id: candidate.id,
    updatedAt: candidate.updatedAt.toISOString(),
    releasedAt: candidate.statusHistory[0]?.createdAt.toISOString() || null,
    status: candidate.status,
    scoringStatus: candidate.scoringStatus,
    aimFitScore: candidate.aimFitScore,
    reqFitScore: candidate.reqFitScore,
  })));
}

function parseMode(argv: string[]): { apply: boolean; approvedSelectionHash: string | null } {
  if (argv.length === 0) return { apply: false, approvedSelectionHash: null };
  if (argv.length !== 3 || argv[0] !== '--apply' || argv[1] !== '--selection-hash'
    || !/^[a-f0-9]{64}$/.test(argv[2])) {
    throw new Error(
      'Usage: requeue_cooldown_release_local_scoring.ts '
      + '[--apply --selection-hash <reviewed-dry-run-hash>]',
    );
  }
  return { apply: true, approvedSelectionHash: argv[2] };
}

async function applyOne(
  candidate: Candidate,
  approvedSelectionHash: string,
): Promise<{ id: string; result: 'applied' | 'blocked'; reason: string }> {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Job" WHERE id = ${candidate.id} FOR UPDATE
    `;
    if (!locked) return { id: candidate.id, result: 'blocked', reason: 'job_missing_after_preview' };

    const currentSuppressionIds = await currentAimSuppressedJobIds(tx, [candidate.id]);
    const current = await tx.job.findFirst({
      where: {
        id: candidate.id,
        updatedAt: candidate.updatedAt,
        ...cohortWhere(currentSuppressionIds),
      },
      select: candidateSelect,
    });
    if (!current || selectionHash([current]) !== selectionHash([candidate])) {
      return { id: candidate.id, result: 'blocked', reason: 'state_or_authority_changed_after_preview' };
    }

    const updated = await tx.job.updateMany({
      where: {
        id: candidate.id,
        updatedAt: candidate.updatedAt,
        status: 'pending_af',
        scoringStatus: 'scored',
        aimFitScore: null,
        reqFitScore: null,
        batchJobId: null,
        jdBatchId: null,
        afBatchId: null,
        tailoringStaged: false,
        AND: [nonManualImportSourceWhere()],
      },
      data: {
        scoringStatus: 'queued',
        batchJobId: null,
        jdBatchId: null,
        afBatchId: null,
        scoreAttempts: 0,
        scoreError: null,
      },
    });
    if (updated.count !== 1) {
      return { id: candidate.id, result: 'blocked', reason: 'expected_state_guard_failed' };
    }

    const eventType = 'lifecycle_reconciled' as const;
    const eventKey = buildPipelineEventKey({
      eventType,
      jobId: candidate.id,
      source: candidate.source,
      identityParts: [VERSION, approvedSelectionHash],
    });
    await tx.jobPipelineEvent.upsert({
      where: { eventKey },
      update: {},
      create: {
        eventKey,
        eventType,
        jobId: candidate.id,
        stage: 'cooldown_cleanup',
        source: candidate.source,
        details: {
          route: 'requeue_cooldown_release_local_scoring',
          version: VERSION,
          reviewedSelectionHash: approvedSelectionHash,
          reason: 'Legacy scoreless cooldown release must pass current local scoring before Aim.',
          prior: {
            status: candidate.status,
            scoringStatus: candidate.scoringStatus,
            fitScore: candidate.fitScore,
            fitCategory: candidate.fitCategory,
            aimFitScore: candidate.aimFitScore,
            reqFitScore: candidate.reqFitScore,
          },
          target: { status: 'pending_af', scoringStatus: 'queued' },
        } as unknown as Prisma.InputJsonValue,
        occurredAt: new Date(),
      },
    });
    await assertJobLifecycleInvariants(tx, [candidate.id]);
    return { id: candidate.id, result: 'applied', reason: 'queued_for_current_local_scoring' };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { apply, approvedSelectionHash } = parseMode(argv);
  const candidates = await loadCandidates(prisma);
  const currentSelectionHash = selectionHash(candidates);
  const sourceCounts = Object.entries(candidates.reduce<Record<string, number>>((counts, candidate) => {
    const source = candidate.source || '(unknown)';
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {})).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  console.log(JSON.stringify({
    mode: apply ? 'apply-preview' : 'dry-run',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    cohort: {
      createdBefore: LEGACY_CREATED_BEFORE.toISOString(),
      pendingAimTransitionFrom: RELEASE_STARTED_AT.toISOString(),
      pendingAimTransitionBefore: RELEASE_ENDED_AT.toISOString(),
      requiresNoAuthoritativeScoreEvent: true,
      requiresNoUserLifecycleIntent: true,
      requiresNoActiveScoringLease: true,
    },
    selectionHash: currentSelectionHash,
    candidates: candidates.length,
    sourceCounts,
    jobIds: candidates.map((candidate) => candidate.id),
    effect: 'Each candidate remains pending_af but changes from scoringStatus=scored to queued. '
      + 'The normal local-scoring pipeline then recomputes current local evidence and triage. '
      + 'No Aim or Experience score event is deleted, invalidated, or rewritten.',
    writesPerformed: 0,
  }, null, 2));

  if (!apply) return;
  if (currentSelectionHash !== approvedSelectionHash) {
    throw new Error(
      `Selection hash mismatch: reviewed ${approvedSelectionHash}; current ${currentSelectionHash}. `
      + 'No writes were attempted.',
    );
  }

  const results = [];
  for (const candidate of candidates) {
    results.push(await applyOne(candidate, approvedSelectionHash));
  }
  console.log(JSON.stringify({
    mode: 'apply',
    version: VERSION,
    reviewedSelectionHash: approvedSelectionHash,
    applied: results.filter((result) => result.result === 'applied').length,
    blocked: results.filter((result) => result.result === 'blocked').length,
    results,
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .catch((error: unknown) => {
      console.error(`Cooldown-release local requeue failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
