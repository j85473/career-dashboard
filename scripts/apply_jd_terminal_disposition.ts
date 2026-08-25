import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Prisma } from '@prisma/client';

import { currentAimSuppressedJobIds } from '../src/lib/currentAimFailureSuppression';
import { buildPipelineEventKey } from '../src/lib/ingestionControl';
import { classifyTerminalJdFailure } from '../src/lib/jdTerminalDisposition';
import { assertJobLifecycleInvariants } from '../src/lib/jobLifecycleInvariant';
import { automatedLifecycleIsProtected } from '../src/lib/manualImportPolicy';
import { operationalQueueWhere } from '../src/lib/operationalQueue';
import { prisma } from '../src/lib/prisma';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { latestUserLifecycleIntent, USER_LIFECYCLE_INTENT_EVENT_TYPES } from '../src/lib/userLifecycleAuthority';

const VERSION = 'jd-terminal-disposition-v1';

export const DISMISS_REASON = 'Job description could not be retrieved after bounded recovery. '
  + 'The posting was closed, a login wall, or a portal shell.';
export const UNPROVEN_DISMISS_REASON = 'Job description could not be retrieved and the stored '
  + 'evidence does not establish why. Dismissed by explicit disposition policy.';

type Plan = {
  id: string;
  company: string;
  title: string;
  disposition: string;
  cause: string;
  action: 'dismiss' | 'requeue';
  blockers: string[];
  guard: { status: string; scoringStatus: string; updatedAt: string };
};

/**
 * Applies the terminal JD disposition Joseph approved: postings whose
 * description can never be retrieved are dismissed, and postings that carry
 * real text which merely fell short of the quality floor go back for another
 * JD attempt.
 *
 * Dry-run by default. A dismissal removes a job from Action Needed and from
 * view, so nothing runs without a reviewed selection hash. Jobs carrying an
 * explicit user decision, staged tailoring, or a Manual Import source are never
 * touched — those are the user's, not the policy's.
 */
function planFor(job: {
  id: string;
  company: string;
  title: string;
  status: string;
  scoringStatus: string;
  scoreError: string | null;
  passReason: string | null;
  description: string | null;
  source: string | null;
  tailoringStaged: boolean;
  updatedAt: Date;
  pipelineEvents: Array<{ id: string; eventType: string; occurredAt: Date; details: Prisma.JsonValue }>;
}): Plan | null {
  const classification = classifyTerminalJdFailure(job);
  if (!classification) return null;

  const blockers: string[] = [];
  if (latestUserLifecycleIntent(job.pipelineEvents).kind === 'final') blockers.push('explicit_user_event_veto');
  if (job.tailoringStaged) blockers.push('tailoring_staged');
  if (automatedLifecycleIsProtected(job)) blockers.push('manual_import_protected');

  return {
    id: job.id,
    company: job.company,
    title: job.title,
    disposition: classification.disposition,
    cause: classification.cause,
    action: classification.disposition === 'presently_recoverable' ? 'requeue' : 'dismiss',
    blockers,
    guard: {
      status: job.status,
      scoringStatus: job.scoringStatus,
      updatedAt: job.updatedAt.toISOString(),
    },
  };
}

function dataFor(plan: Plan): Prisma.JobUpdateManyMutationInput {
  if (plan.action === 'requeue') {
    // Real posting text was retrieved; it just fell short. Send it back for
    // another JD attempt rather than deciding anything about the job.
    return {
      scoringStatus: 'needs_jd',
      scoreAttempts: 0,
      scoreError: null,
      passReason: null,
      jdBatchId: null,
      batchJobId: null,
    };
  }
  return {
    status: 'dismissed',
    scoringStatus: 'skipped',
    scoreAttempts: 0,
    scoreError: null,
    jdBatchId: null,
    batchJobId: null,
    passReason: plan.disposition === 'unproven' ? UNPROVEN_DISMISS_REASON : DISMISS_REASON,
  };
}

async function loadPlans(): Promise<Plan[]> {
  const suppressed = await currentAimSuppressedJobIds(prisma);
  const jobs = await prisma.job.findMany({
    where: operationalQueueWhere('action_needed', suppressed),
    select: {
      id: true, company: true, title: true, status: true, scoringStatus: true,
      scoreError: true, passReason: true, description: true, source: true,
      tailoringStaged: true, updatedAt: true,
      pipelineEvents: {
        where: { eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { id: true, eventType: true, occurredAt: true, details: true },
      },
    },
    orderBy: { id: 'asc' },
  });
  return jobs.map(planFor).filter((plan): plan is Plan => plan !== null);
}

function selectionHash(plans: Plan[]): string {
  return canonicalJsonSha256(plans.map((plan) => ({
    id: plan.id, action: plan.action, blockers: plan.blockers, guard: plan.guard,
  })));
}

function parseMode(argv: string[]): { apply: boolean; approved: string | null } {
  if (argv.length === 0) return { apply: false, approved: null };
  if (argv.length !== 3 || argv[0] !== '--apply' || argv[1] !== '--selection-hash'
    || !/^[a-f0-9]{64}$/.test(argv[2])) {
    throw new Error('Usage: apply_jd_terminal_disposition.ts [--apply --selection-hash <reviewed-dry-run-hash>]');
  }
  return { apply: true, approved: argv[2] };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { apply, approved } = parseMode(argv);
  const plans = await loadPlans();
  const actionable = plans.filter((plan) => plan.blockers.length === 0);
  const counts = (action: Plan['action']) => actionable.filter((plan) => plan.action === action).length;

  const preview = {
    mode: apply ? 'apply' : 'dry-run',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    terminalJdFailures: plans.length,
    selectionHash: selectionHash(plans),
    willDismiss: counts('dismiss'),
    willRequeue: counts('requeue'),
    blocked: plans.length - actionable.length,
    byCause: Object.entries(actionable.reduce<Record<string, number>>((acc, plan) => {
      const key = `${plan.action}:${plan.cause}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})).sort(),
    effect: 'Dismissed jobs leave Action Needed and are no longer visible as work. '
      + 'Requeued jobs return to the Needs JD queue for another description attempt; '
      + 'no score is created or removed by either path.',
    writesPerformed: 0,
  };
  console.log(JSON.stringify(preview, null, 2));
  if (!apply) return;
  if (preview.selectionHash !== approved) {
    throw new Error(
      `Selection hash mismatch: reviewed ${approved}; current ${preview.selectionHash}. No writes were attempted.`,
    );
  }

  let dismissed = 0;
  let requeued = 0;
  const blockedAtWrite: string[] = [];
  for (const plan of actionable) {
    const applied = await prisma.$transaction(async (tx) => {
      const result = await tx.job.updateMany({
        where: {
          id: plan.id,
          status: plan.guard.status,
          scoringStatus: plan.guard.scoringStatus,
          updatedAt: new Date(plan.guard.updatedAt),
          tailoringStaged: false,
        },
        data: dataFor(plan),
      });
      if (result.count !== 1) return false;
      const eventType = plan.action === 'dismiss' ? 'user_lifecycle' : 'jd_recovery_requeued';
      await tx.jobPipelineEvent.upsert({
        where: {
          eventKey: buildPipelineEventKey({
            eventType, jobId: plan.id, source: null,
            identityParts: [VERSION, plan.action, plan.cause],
          }),
        },
        update: {},
        create: {
          eventKey: buildPipelineEventKey({
            eventType, jobId: plan.id, source: null,
            identityParts: [VERSION, plan.action, plan.cause],
          }),
          eventType,
          jobId: plan.id,
          stage: 'jd',
          occurredAt: new Date(),
          details: {
            route: 'apply_jd_terminal_disposition',
            version: VERSION,
            disposition: plan.disposition,
            cause: plan.cause,
            action: plan.action,
            prior: plan.guard,
            actor: 'user',
            ...(plan.action === 'dismiss' ? { nextStatus: 'dismissed' } : {}),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await assertJobLifecycleInvariants(tx, [plan.id]);
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });

    if (!applied) blockedAtWrite.push(plan.id);
    else if (plan.action === 'dismiss') dismissed += 1;
    else requeued += 1;
  }

  console.log(JSON.stringify({
    mode: 'apply', version: VERSION, dismissed, requeued,
    blockedAtWrite: blockedAtWrite.length, blockedIds: blockedAtWrite.slice(0, 20),
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main()
    .catch((error: unknown) => {
      console.error(`JD terminal disposition failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
