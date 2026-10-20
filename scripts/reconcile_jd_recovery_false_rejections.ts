import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Prisma } from '../src/lib/prismaClient';
import { prisma } from '../src/lib/prisma';
import {
  buildClosedPostingUpdate, describeJdFailureCause, JD_RECOVERY_MANUAL_REVIEW_REASON,
  planJdRecoveryReconciliation,
} from '../src/lib/jdRecoveryPolicy';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { MANUAL_IMPORT_SOURCE } from '../src/lib/manualImportPolicy';
import { USER_LIFECYCLE_INTENT_EVENT_TYPES } from '../src/lib/userLifecycleAuthority';
import { CLEARED_JD_DEFERRALS } from '../src/lib/jdEnrichmentDeferral';
import { assertJobLifecycleInvariants } from '../src/lib/jobLifecycleInvariant';

const VERSION = 'jd-recovery-reconciliation-v2';
const PREFIX = `${VERSION}:`;
const JD_FAILURE_REASONS = [JD_RECOVERY_MANUAL_REVIEW_REASON,
  'JD recovery failed. Manual review required.',
  'Failed to fetch JD after 3 attempts. Needs manual review.',
  'Error calling Jina. Manual review required.'];

/** A maintenance repair must never change scored, leased, staged, or human-owned
 * work. The same predicates run again atomically at the point of each write. */
export const eligibleJdRepairWhere: Prisma.JobWhereInput = {
  status: { in: ['pending_af', 'inbox'] }, scoringStatus: 'failed',
  OR: [{ scoreError: { startsWith: 'JD recovery rejected:' } }, { passReason: { in: JD_FAILURE_REASONS } }],
  AND: [{ OR: [{ source: null }, { source: { not: MANUAL_IMPORT_SOURCE } }] }],
  tailoringStaged: false, batchJobId: null, jdBatchId: null, afBatchId: null,
  fitScore: null, aimFitScore: null, reqFitScore: null, scoreEvents: { none: {} },
  pipelineEvents: { none: { OR: [
    { eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } },
    { eventKey: { startsWith: PREFIX } },
  ] } },
};

export function parseJdRepairArguments(argv: string[]) {
  let apply = false, retryUnresolved = false, selectionHash: string | null = null;
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--retry-unresolved') retryUnresolved = true;
    else if (arg === '--selection-hash' && /^[a-f0-9]{64}$/.test(argv[i + 1] || '')) selectionHash = argv[++i];
    else if (arg === '--id' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(argv[i + 1] || '')) ids.push(argv[++i]);
    else throw new Error(`Unknown or invalid argument: ${arg}`);
  }
  if (apply && !selectionHash) throw new Error('--apply requires --selection-hash from a reviewed dry run');
  return { apply, retryUnresolved, selectionHash, ids: [...new Set(ids)].sort() };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseJdRepairArguments(argv);
  const candidates = await prisma.job.findMany({
    where: { AND: [eligibleJdRepairWhere, ...(options.ids.length ? [{ id: { in: options.ids } }] : [])] },
    select: { id: true, company: true, title: true, source: true, description: true,
      scoreError: true, passReason: true, status: true, scoringStatus: true, updatedAt: true },
    orderBy: { id: 'asc' },
  });
  const plans = candidates.map(job => ({ job, plan: planJdRecoveryReconciliation(job) }));
  const selectionHash = canonicalJsonSha256({ version: VERSION, retryUnresolved: options.retryUnresolved,
    plans: plans.map(({ job, plan }) => ({ ...job, updatedAt: job.updatedAt.toISOString(), action: plan.action })) });
  const actionable = plans.filter(({ plan }) => plan.action !== 'retry_extraction' || options.retryUnresolved);
  const counts: Record<string, number> = {};
  for (const { job, plan } of plans) {
    const key = `${plan.action}: ${describeJdFailureCause(job.description, plan.quality)}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', version: VERSION,
    selectionHash, candidates: plans.length, queueLocal: actionable.filter(p => p.plan.action === 'queue_local').length,
    confirmedClosed: actionable.filter(p => p.plan.action === 'dismiss_closed').length,
    retryExtraction: actionable.filter(p => p.plan.action === 'retry_extraction').length,
    unresolvedHeld: plans.length - actionable.length, causes: counts, writesPerformed: 0 }, null, 2));
  if (!options.apply) return;
  if (options.selectionHash !== selectionHash) throw new Error('Selection changed since dry run. No writes attempted.');

  let applied = 0;
  const skipped: string[] = [];
  for (const { job, plan } of actionable) {
    const data: Prisma.JobUpdateManyMutationInput = plan.action === 'dismiss_closed'
      ? buildClosedPostingUpdate()
      : { scoringStatus: plan.action === 'queue_local' ? 'queued' : 'needs_jd',
          scoreAttempts: 0, scoreError: null, passReason: null, jdBatchId: null, batchJobId: null,
          ...CLEARED_JD_DEFERRALS };
    const count = await prisma.$transaction(async tx => {
      const updated = await tx.job.updateMany({
        where: { AND: [eligibleJdRepairWhere, { id: job.id, status: job.status, source: job.source,
          scoringStatus: job.scoringStatus, scoreError: job.scoreError, description: job.description,
          passReason: job.passReason, updatedAt: job.updatedAt }] }, data,
      });
      if (updated.count !== 1) return 0;
      await tx.jobPipelineEvent.create({ data: { eventKey: `${PREFIX}${job.id}`,
        eventType: 'jd_recovery_reconciled', stage: 'jd_recovery', jobId: job.id, source: job.source,
        details: { version: VERSION, action: plan.action, selectionHash, previousStatus: job.status,
          previousScoringStatus: job.scoringStatus, previousScoreError: job.scoreError,
          previousPassReason: job.passReason, descriptionSha256: canonicalJsonSha256(job.description) } } });
      await assertJobLifecycleInvariants(tx, [job.id]);
      return 1;
    });
    if (count) applied++; else skipped.push(job.id);
  }
  console.log(JSON.stringify({ mode: 'apply', applied, skipped, scoresChanged: 0 }));
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '')) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
