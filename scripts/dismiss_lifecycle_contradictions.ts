import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Prisma } from '@prisma/client';

import { buildPipelineEventKey } from '../src/lib/ingestionControl';
import { assertJobLifecycleInvariants } from '../src/lib/jobLifecycleInvariant';
import { prisma } from '../src/lib/prisma';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';

const VERSION = 'contradiction-dismissal-v1';

export const DISMISSAL_REASON = 'Dismissed by explicit review of the contradictory-lifecycle cohort.';

/**
 * The rows `reconcile_lifecycle_contradictions` refuses to decide on its own.
 *
 * Each is `pending_af` while carrying a local-triage rejection, an out-of-scope
 * location, or a non-target role — states that should already have resolved to
 * a decision and instead left the job in no queue at all. The reconciliation
 * tool blocks them because it cannot *prove* from stored evidence that the
 * rejection was machine-made, which is the correct default for an automated
 * pass.
 *
 * Joseph reviewed the list on 2026-08-25 and directed that they be dismissed.
 * This records that as an explicit human decision rather than weakening the
 * evidence check that (rightly) declined to infer it.
 */
export const CONTRADICTION_DISMISSAL_COHORT = [
  { id: '70fb8744-920d-441d-a3a6-f72daa40c700', label: 'Merck — Toledo, OH Territory Manager' },
  { id: '2829360a-4b4f-430a-8b93-31ee0b1282f4', label: 'Acosta Group — Google Pixel Sales Specialist' },
  { id: '93a59499-d6be-4536-8ae1-1aa3ef9ee08e', label: 'Honeywell — Sr Territory Manager' },
  { id: '947a34bf-1e12-4e3e-ae73-fccaaf1742d9', label: 'sezzle — Senior Site Reliability Engineer' },
  { id: 'a279e407-c2d6-40c4-b0be-856fb7fd1aa9', label: 'thatch — Operations Lead (Member Support)' },
  { id: '6b794c5a-c2f3-4d95-995a-c10fc2c67478', label: 'Vetcove — Senior Product Manager' },
  { id: '8a42743d-bee9-42a4-a02e-a294cdf3cb41', label: 'Dandy — Senior Manager, Customer Marketing' },
  { id: '67fa2f6c-2f0b-4c09-8b75-c08a833fc469', label: 'Legrand Group Opportunities' },
  { id: '9d88c17b-f396-402b-a196-e1836b6c8aec', label: 'Sellsig — Founding Account Executive' },
] as const;

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const malformed = CONTRADICTION_DISMISSAL_COHORT.filter((spec) => !JOB_ID_PATTERN.test(spec.id));
if (malformed.length > 0) {
  throw new Error(`Malformed job IDs: ${malformed.map((spec) => spec.label).join(', ')}`);
}

type Plan = {
  id: string;
  label: string;
  company: string;
  title: string;
  outcome: 'ready' | 'noop' | 'missing';
  guard: { status: string; scoringStatus: string; updatedAt: string } | null;
};

async function loadPlans(): Promise<Plan[]> {
  const plans: Plan[] = [];
  for (const spec of CONTRADICTION_DISMISSAL_COHORT) {
    const job = await prisma.job.findUnique({
      where: { id: spec.id },
      select: { company: true, title: true, status: true, scoringStatus: true, updatedAt: true },
    });
    if (!job) {
      plans.push({ ...spec, company: '', title: '', outcome: 'missing', guard: null });
      continue;
    }
    plans.push({
      ...spec,
      company: job.company,
      title: job.title,
      outcome: job.status === 'dismissed' ? 'noop' : 'ready',
      guard: {
        status: job.status,
        scoringStatus: job.scoringStatus,
        updatedAt: job.updatedAt.toISOString(),
      },
    });
  }
  return plans;
}

function selectionHash(plans: Plan[]): string {
  return canonicalJsonSha256(plans.map((plan) => ({
    id: plan.id, outcome: plan.outcome, guard: plan.guard,
  })));
}

function parseMode(argv: string[]): { apply: boolean; approved: string | null } {
  if (argv.length === 0) return { apply: false, approved: null };
  if (argv.length !== 3 || argv[0] !== '--apply' || argv[1] !== '--selection-hash'
    || !/^[a-f0-9]{64}$/.test(argv[2])) {
    throw new Error('Usage: dismiss_lifecycle_contradictions.ts [--apply --selection-hash <reviewed-dry-run-hash>]');
  }
  return { apply: true, approved: argv[2] };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { apply, approved } = parseMode(argv);
  const plans = await loadPlans();
  const preview = {
    mode: apply ? 'apply' : 'dry-run',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    selectionHash: selectionHash(plans),
    ready: plans.filter((plan) => plan.outcome === 'ready').length,
    noop: plans.filter((plan) => plan.outcome === 'noop').length,
    missing: plans.filter((plan) => plan.outcome === 'missing').length,
    jobs: plans.map((plan) => ({
      label: plan.label, outcome: plan.outcome, from: plan.guard?.status ?? null,
    })),
    effect: 'Each job moves to dismissed with an explicit user lifecycle event. '
      + 'No score is created or cleared, and every job stays restorable from the '
      + 'Dashboard exactly like any other dismissal.',
    writesPerformed: 0,
  };
  console.log(JSON.stringify(preview, null, 2));

  const missing = plans.filter((plan) => plan.outcome === 'missing');
  if (missing.length > 0) {
    throw new Error(`Cohort entries resolve to no job: ${missing.map((p) => p.label).join(', ')}.`);
  }
  if (!apply) return;
  if (preview.selectionHash !== approved) {
    throw new Error(
      `Selection hash mismatch: reviewed ${approved}; current ${preview.selectionHash}. No writes were attempted.`,
    );
  }

  const results: Array<{ label: string; result: string }> = [];
  for (const plan of plans) {
    if (plan.outcome !== 'ready' || !plan.guard) continue;
    const applied = await prisma.$transaction(async (tx) => {
      const result = await tx.job.updateMany({
        where: {
          id: plan.id,
          status: plan.guard!.status,
          scoringStatus: plan.guard!.scoringStatus,
          updatedAt: new Date(plan.guard!.updatedAt),
        },
        data: { status: 'dismissed', scoringStatus: 'skipped', passReason: DISMISSAL_REASON },
      });
      if (result.count !== 1) return false;
      const eventKey = buildPipelineEventKey({
        eventType: 'user_lifecycle', jobId: plan.id, source: null, identityParts: [VERSION],
      });
      await tx.jobPipelineEvent.upsert({
        where: { eventKey },
        update: {},
        create: {
          eventKey,
          eventType: 'user_lifecycle',
          jobId: plan.id,
          stage: 'lifecycle_reconciliation',
          occurredAt: new Date(),
          details: {
            route: 'dismiss_lifecycle_contradictions',
            version: VERSION,
            priorStatus: plan.guard!.status,
            nextStatus: 'dismissed',
            protected: true,
            actor: 'user',
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await assertJobLifecycleInvariants(tx, [plan.id]);
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
    results.push({ label: plan.label, result: applied ? 'dismissed' : 'blocked_state_changed' });
  }

  console.log(JSON.stringify({ mode: 'apply', version: VERSION, results }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .catch((error: unknown) => {
      console.error(`Contradiction dismissal failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
