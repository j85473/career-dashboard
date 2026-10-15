import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Prisma } from '@prisma/client';

import {
  evaluateAuthoritativeMetadata,
  hasAuthoritativeMetadata,
} from '../src/lib/authoritativeMetadataGate';
import { recordJobPipelineEvent } from '../src/lib/ingestionControl';
import { assertJobLifecycleInvariants } from '../src/lib/jobLifecycleInvariant';
import { automatedLifecycleIsProtected } from '../src/lib/manualImportPolicy';
import { prisma } from '../src/lib/prisma';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { latestUserLifecycleIntent, USER_LIFECYCLE_INTENT_EVENT_TYPES } from '../src/lib/userLifecycleAuthority';

/**
 * Reconciles the legacy Action Needed rows that accumulated before direct ATS
 * admission evaluated an ATS board's own title, company, and location.
 *
 * This is deliberately narrower than a generic cleanup: a row must still be
 * active, failed, unscored, not tailored, unleased, and free of any user
 * lifecycle instruction. The reclassification keeps its JD failure error,
 * attempt count, score fields, score events, and durable history intact. It
 * only removes the now-known out-of-scope row from the operational queue.
 *
 * Dry-run by default. Applying requires the selection hash printed by the
 * dry-run, so changes in the queue require a new review.
 */

const VERSION = 'authoritative-ats-metadata-reconciliation-v2';
const ACTIVE_STATUSES = ['pending_af', 'inbox'] as const;
const SAMPLE_LIMIT = 15;

const candidateSelect = {
  id: true,
  title: true,
  company: true,
  location: true,
  url: true,
  source: true,
  sourceId: true,
  status: true,
  scoringStatus: true,
  scoreAttempts: true,
  scoreError: true,
  passReason: true,
  tailoringStaged: true,
  fitScore: true,
  aimFitScore: true,
  reqFitScore: true,
  updatedAt: true,
  scoreEvents: {
    take: 1,
    select: { id: true },
  },
  scoringBatchItems: {
    where: { status: 'leased' },
    take: 1,
    select: { id: true },
  },
  pipelineEvents: {
    where: { eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    select: { id: true, eventType: true, occurredAt: true, details: true },
  },
} satisfies Prisma.JobSelect;

type Candidate = Prisma.JobGetPayload<{ select: typeof candidateSelect }>;
type Plan = {
  candidate: Candidate;
  reason: string;
};

function candidateWhere(): Prisma.JobWhereInput {
  return {
    status: { in: [...ACTIVE_STATUSES] },
    scoringStatus: 'failed',
  };
}

function planFor(candidate: Candidate): Plan | null {
  if (!hasAuthoritativeMetadata(candidate.source)
    || automatedLifecycleIsProtected(candidate)
    || candidate.tailoringStaged
    || candidate.scoringBatchItems.length > 0
    || candidate.scoreEvents.length > 0
    || candidate.fitScore !== null
    || candidate.aimFitScore !== null
    || candidate.reqFitScore !== null
    || latestUserLifecycleIntent(candidate.pipelineEvents).kind !== 'none') {
    return null;
  }
  const verdict = evaluateAuthoritativeMetadata(candidate);
  return verdict.passes ? null : { candidate, reason: verdict.reason };
}

function selectionHash(plans: readonly Plan[]): string {
  return canonicalJsonSha256(plans.map(({ candidate, reason }) => ({
    id: candidate.id,
    source: candidate.source,
    sourceId: candidate.sourceId,
    title: candidate.title,
    company: candidate.company,
    location: candidate.location,
    reason,
    status: candidate.status,
    scoringStatus: candidate.scoringStatus,
    scoreAttempts: candidate.scoreAttempts,
    scoreError: candidate.scoreError,
    passReason: candidate.passReason,
    updatedAt: candidate.updatedAt.toISOString(),
  })));
}

function parseArguments(argv: string[]): { apply: boolean; approvedSelectionHash: string | null } {
  if (argv.length === 0) return { apply: false, approvedSelectionHash: null };
  if (argv.length !== 3 || argv[0] !== '--apply' || argv[1] !== '--selection-hash'
    || !/^[a-f0-9]{64}$/.test(argv[2])) {
    throw new Error('Usage: triage_stuck_ats_jobs.ts [--apply --selection-hash <reviewed-dry-run-hash>]');
  }
  return { apply: true, approvedSelectionHash: argv[2] };
}

async function loadPlans(): Promise<{ inspected: number; plans: Plan[] }> {
  const candidates = await prisma.job.findMany({
    where: candidateWhere(),
    select: candidateSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return {
    inspected: candidates.length,
    plans: candidates.map(planFor).filter((plan): plan is Plan => plan !== null),
  };
}

async function applyOne(plan: Plan, reviewedSelectionHash: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Job" WHERE id = ${plan.candidate.id} FOR UPDATE
    `;
    if (!locked) return false;

    const current = await tx.job.findUnique({
      where: { id: plan.candidate.id },
      select: candidateSelect,
    });
    if (!current) return false;
    const currentPlan = planFor(current);
    if (!currentPlan || selectionHash([currentPlan]) !== selectionHash([plan])) return false;

    const updated = await tx.job.updateMany({
      where: {
        id: current.id,
        updatedAt: current.updatedAt,
        status: current.status,
        scoringStatus: current.scoringStatus,
      },
      data: {
        status: 'dismissed',
        scoringStatus: 'skipped',
        passReason: currentPlan.reason,
      },
    });
    if (updated.count !== 1) return false;

    await recordJobPipelineEvent({
      eventType: 'prefilter_rejected',
      jobId: current.id,
      stage: 'policy_reconciliation',
      source: current.source,
      sourceId: current.sourceId,
      details: {
        route: 'triage_stuck_ats_jobs',
        version: VERSION,
        reviewedSelectionHash,
        reason: currentPlan.reason,
        prior: {
          status: current.status,
          scoringStatus: current.scoringStatus,
          scoreAttempts: current.scoreAttempts,
          scoreError: current.scoreError,
          passReason: current.passReason,
        },
        preservedScores: {
          fitScore: current.fitScore,
          aimFitScore: current.aimFitScore,
          reqFitScore: current.reqFitScore,
          scoreEventCount: current.scoreEvents.length,
        },
      } as Prisma.InputJsonValue,
      identityParts: [VERSION, reviewedSelectionHash],
    }, tx);
    await assertJobLifecycleInvariants(tx, [current.id]);
    return true;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { apply, approvedSelectionHash } = parseArguments(argv);
  const { inspected, plans } = await loadPlans();
  const currentSelectionHash = selectionHash(plans);
  const byReason = plans.reduce<Record<string, number>>((result, { reason }) => {
    result[reason] = (result[reason] || 0) + 1;
    return result;
  }, {});

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — authoritative ATS metadata reconciliation`);
  console.log(`  failed Action Needed rows inspected: ${inspected.toLocaleString()}`);
  console.log(`  guarded rows to dismiss:            ${plans.length.toLocaleString()}`);
  console.log(`  selection hash:                      ${currentSelectionHash}`);
  for (const [reason, count] of Object.entries(byReason).sort((left, right) => right[1] - left[1])) {
    console.log(`  ${String(count).padStart(5)}  ${reason}`);
  }
  for (const { candidate, reason } of plans.slice(0, SAMPLE_LIMIT)) {
    console.log(`  ${candidate.id}  ${candidate.company} — ${candidate.title}`);
    console.log(`    ${candidate.location || '(no stored location)'}; ${reason}`);
  }
  if (plans.length > SAMPLE_LIMIT) console.log(`  … ${plans.length - SAMPLE_LIMIT} more guarded row(s)`);

  if (plans.length === 0) return;
  if (!apply) {
    console.log('\nDry run only. Review the exact rows above, then re-run with:');
    console.log(`  --apply --selection-hash ${currentSelectionHash}`);
    return;
  }
  if (approvedSelectionHash !== currentSelectionHash) {
    throw new Error('Selection hash mismatch. No writes were attempted. Run a fresh dry run and review its hash.');
  }

  let dismissed = 0;
  let blocked = 0;
  for (const plan of plans) {
    if (await applyOne(plan, currentSelectionHash)) dismissed++;
    else blocked++;
  }
  console.log(`\nDismissed ${dismissed.toLocaleString()} out-of-scope, machine-owned row(s).`);
  console.log(`Blocked ${blocked.toLocaleString()} row(s) that changed or became protected after review.`);
  console.log('No score fields, score events, JD failure evidence, or user history were removed.');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .catch((error: unknown) => {
      console.error(`ATS metadata reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
