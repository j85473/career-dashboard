import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Prisma, type PrismaClient } from '@prisma/client';

import { currentAimSuppressedJobIds } from '../src/lib/currentAimFailureSuppression';
import { buildPipelineEventKey } from '../src/lib/ingestionControl';
import { assertJobLifecycleInvariants } from '../src/lib/jobLifecycleInvariant';
import { nonManualImportSourceWhere } from '../src/lib/manualImportPolicy';
import { prisma } from '../src/lib/prisma';
import { AUTHORITATIVE_SCORE_EVENT_TYPES } from '../src/lib/scoreAuthority';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { USER_LIFECYCLE_INTENT_EVENT_TYPES } from '../src/lib/userLifecycleAuthority';

const VERSION = 'cooldown-cleanup-quarantine-retry-v1';
const CLEANUP_VERSION = 'cooldown-release-local-rescore-v1';
const QUARANTINE_ERROR = 'Local scoring invariant blocked: legacy_local_fallback_requires_recognized_machine_reason';

type DbClient = PrismaClient | Prisma.TransactionClient;

const candidateSelect = {
  id: true,
  title: true,
  company: true,
  source: true,
  status: true,
  scoringStatus: true,
  scoreAttempts: true,
  scoreError: true,
  aimFitScore: true,
  reqFitScore: true,
  batchJobId: true,
  jdBatchId: true,
  afBatchId: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;

type Candidate = Prisma.JobGetPayload<{ select: typeof candidateSelect }>;

function candidateWhere(currentSuppressionIds: readonly string[]): Prisma.JobWhereInput {
  return {
    status: 'pending_af',
    scoringStatus: 'failed',
    scoreAttempts: { gte: 3 },
    scoreError: QUARANTINE_ERROR,
    aimFitScore: null,
    reqFitScore: null,
    batchJobId: null,
    jdBatchId: null,
    afBatchId: null,
    tailoringStaged: false,
    ...(currentSuppressionIds.length > 0 ? { id: { notIn: [...currentSuppressionIds] } } : {}),
    scoreEvents: { none: { evaluationType: { in: [...AUTHORITATIVE_SCORE_EVENT_TYPES] } } },
    scoringBatchItems: { none: { status: 'leased' } },
    pipelineEvents: {
      none: { eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } },
      some: {
        eventType: 'lifecycle_reconciled',
        stage: 'cooldown_cleanup',
        details: { path: ['version'], equals: CLEANUP_VERSION },
      },
    },
    AND: [nonManualImportSourceWhere()],
  };
}

async function loadCandidates(client: DbClient): Promise<Candidate[]> {
  const currentSuppressionIds = await currentAimSuppressedJobIds(client);
  return client.job.findMany({
    where: candidateWhere(currentSuppressionIds),
    select: candidateSelect,
    orderBy: [{ id: 'asc' }],
  });
}

function selectionHash(candidates: readonly Candidate[]): string {
  return canonicalJsonSha256(candidates.map((candidate) => ({
    id: candidate.id,
    updatedAt: candidate.updatedAt.toISOString(),
    status: candidate.status,
    scoringStatus: candidate.scoringStatus,
    scoreAttempts: candidate.scoreAttempts,
    scoreError: candidate.scoreError,
    aimFitScore: candidate.aimFitScore,
    reqFitScore: candidate.reqFitScore,
  })));
}

function parseMode(argv: string[]): { apply: boolean; approvedSelectionHash: string | null } {
  if (argv.length === 0) return { apply: false, approvedSelectionHash: null };
  if (argv.length !== 3 || argv[0] !== '--apply' || argv[1] !== '--selection-hash'
    || !/^[a-f0-9]{64}$/.test(argv[2])) {
    throw new Error(
      'Usage: retry_cooldown_cleanup_quarantines.ts '
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
        ...candidateWhere(currentSuppressionIds),
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
        scoringStatus: 'failed',
        scoreAttempts: candidate.scoreAttempts,
        scoreError: QUARANTINE_ERROR,
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
        stage: 'cooldown_cleanup_retry',
        source: candidate.source,
        details: {
          route: 'retry_cooldown_cleanup_quarantines',
          version: VERSION,
          reviewedSelectionHash: approvedSelectionHash,
          priorError: QUARANTINE_ERROR,
          target: { status: 'pending_af', scoringStatus: 'queued' },
        } as unknown as Prisma.InputJsonValue,
        occurredAt: new Date(),
      },
    });
    await assertJobLifecycleInvariants(tx, [candidate.id]);
    return { id: candidate.id, result: 'applied', reason: 'queued_for_corrected_local_scoring' };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { apply, approvedSelectionHash } = parseMode(argv);
  const candidates = await loadCandidates(prisma);
  const currentSelectionHash = selectionHash(candidates);
  console.log(JSON.stringify({
    mode: apply ? 'apply-preview' : 'dry-run',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    selectionHash: currentSelectionHash,
    candidates: candidates.length,
    jobs: candidates.map((candidate) => ({
      id: candidate.id,
      company: candidate.company,
      title: candidate.title,
      error: candidate.scoreError,
    })),
    effect: 'The exact cleanup quarantines return to current local scoring after the closure and machine-reason fixes. '
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
  for (const candidate of candidates) results.push(await applyOne(candidate, approvedSelectionHash));
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
      console.error(`Cooldown cleanup quarantine retry failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
