import { Prisma, type PrismaClient } from '@prisma/client';

import { evaluateAuthoritativeMetadata, hasAuthoritativeMetadata } from './authoritativeMetadataGate';
import { currentAimSuppressedJobIds } from './currentAimFailureSuppression';
import { CLOSED_POSTING_REASON } from './jdRecoveryPolicy';
import { latestJobScoreEvents } from './jobScoreAuthorityQuery';
import { passesPreFilter } from './jobFiltering';
import { MANUAL_IMPORT_SOURCE } from './manualImportPolicy';
import {
  inspectOperationalPartition,
  operationalPartitionScopeWhere,
  operationalQueueWhere,
  OPERATIONAL_QUEUE_CATEGORIES,
  type OperationalQueueCategory,
} from './operationalQueue';
import { resolveStagedScoreAuthority } from './scoreAuthority';
import { AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE } from './scoringLifecyclePolicy';
import { currentScoringInputVersions, type CurrentScoringInputVersions } from './scoringInputVersions';
import {
  latestUserLifecycleIntent,
  USER_LIFECYCLE_INTENT_EVENT_TYPES,
  userLifecycleIntentDrift,
  type LatestUserLifecycleIntent,
} from './userLifecycleAuthority';

type DbClient = PrismaClient | Prisma.TransactionClient;

const PROTECTED_TERMINAL_STATUSES = new Set([
  // These states are lifecycle endpoints outside scoring projection. Dismissed,
  // passed, and bookmarked are intentionally absent: without a user event they
  // can be stale automated projections and must still be checked.
  'applied', 'interviewing', 'expired', 'archived', 'cooldown',
]);
const LEGACY_LOCAL_PREFIXES = [
  'Locally triaged out:',
  'Available job information is not in English',
  CLOSED_POSTING_REASON,
] as const;
const MAX_DIAGNOSTICS = 20;

export type LifecycleScoreAuthority = {
  kind: 'aim' | 'experience' | 'legacy' | 'stale' | 'none';
  eventId: string | null;
  passed: boolean | null;
  score: number | null;
};

export type LifecycleInvariantSnapshot = {
  id: string;
  status: string;
  scoringStatus: string;
  source: string | null;
  tailoringStaged: boolean;
  aimFitScore: number | null;
  reqFitScore: number | null;
  passReason: string | null;
  userIntent: LatestUserLifecycleIntent;
  rawScoreEventCount: number;
  inOperationalScope: boolean;
  operationalCategories: OperationalQueueCategory[];
  authority: LifecycleScoreAuthority;
  legacyLocalDecision: boolean;
  legacyLocalReasonRecognized: boolean;
};

export type LifecycleInvariantViolation = {
  jobId: string;
  invariant: string;
  authorityEventId: string | null;
  proposedState: {
    status: string;
    scoringStatus: string;
    tailoringStaged: boolean;
    aimFitScore: number | null;
    reqFitScore: number | null;
  };
};

function violation(
  snapshot: LifecycleInvariantSnapshot,
  invariant: string,
  authorityEventId = snapshot.authority.eventId,
): LifecycleInvariantViolation {
  return {
    jobId: snapshot.id,
    invariant,
    authorityEventId,
    proposedState: {
      status: snapshot.status,
      scoringStatus: snapshot.scoringStatus,
      tailoringStaged: snapshot.tailoringStaged,
      aimFitScore: snapshot.aimFitScore,
      reqFitScore: snapshot.reqFitScore,
    },
  };
}

function expectedStatus(authority: LifecycleScoreAuthority): 'pending_af' | 'inbox' | 'dismissed' | null {
  if (authority.kind === 'experience') return authority.passed ? 'inbox' : 'dismissed';
  if (authority.kind === 'legacy') return authority.passed ? 'inbox' : 'dismissed';
  if (authority.kind !== 'aim') return null;
  return authority.passed
    && authority.score !== null
    && authority.score >= AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE
    ? 'pending_af'
    : 'dismissed';
}

export function inspectJobLifecycleInvariant(
  snapshot: LifecycleInvariantSnapshot,
): LifecycleInvariantViolation[] {
  const violations: LifecycleInvariantViolation[] = [];
  if (snapshot.status === 'pending_af' && snapshot.scoringStatus === 'skipped') {
    violations.push(violation(snapshot, 'pending_af_cannot_be_skipped'));
  }
  if (snapshot.status === 'pending_af' && snapshot.reqFitScore !== null) {
    violations.push(violation(snapshot, 'pending_af_cannot_retain_experience_score'));
  }
  if (snapshot.inOperationalScope && snapshot.operationalCategories.length === 0) {
    violations.push(violation(snapshot, 'active_job_has_no_operational_queue'));
  }
  if (snapshot.inOperationalScope && snapshot.operationalCategories.length > 1) {
    violations.push(violation(snapshot, 'active_job_has_multiple_operational_queues'));
  }
  if (violations.length > 0) return violations;

  if (snapshot.userIntent.kind === 'final') {
    // `superseded` is an automated lifecycle exit taken after the user's
    // decision (Inbox expiry, company cooldown). Only a contradiction that no
    // policy explains is a violation.
    if (userLifecycleIntentDrift(snapshot.userIntent, snapshot) === 'contradicted') {
      return [violation(
        snapshot,
        'latest_user_lifecycle_intent_does_not_match_state',
        snapshot.userIntent.eventId,
      )];
    }
    return [];
  }

  // Manual Import and active Tailoring remain outside machine projection
  // enforcement even when informational scores continue to arrive. A latest
  // rescore is intentionally not protection: it asks current score authority
  // to decide the lifecycle again.
  if (snapshot.source === MANUAL_IMPORT_SOURCE || snapshot.tailoringStaged) return [];

  // Legitimate lifecycle destinations are protected from automated score
  // projection. They are still subject to the scalar and partition checks
  // above, which catch combinations such as pending_af + skipped.
  if (PROTECTED_TERMINAL_STATUSES.has(snapshot.status)) return [];

  const projectedStatus = expectedStatus(snapshot.authority);
  if (projectedStatus && snapshot.status !== projectedStatus) {
    return [violation(snapshot, `current_${snapshot.authority.kind}_authority_requires_${projectedStatus}`)];
  }
  if (projectedStatus) return [];

  // Only when no current score authority exists may a structurally automated
  // legacy dismissal fall back to its stored local-machine reason.
  if (snapshot.legacyLocalDecision) {
    if (snapshot.rawScoreEventCount > 0) {
      return [violation(snapshot, 'legacy_local_fallback_requires_no_score_event')];
    }
    if (!snapshot.legacyLocalReasonRecognized) {
      return [violation(snapshot, 'legacy_local_fallback_requires_recognized_machine_reason')];
    }
  }

  return [];
}

export class JobLifecycleInvariantError extends Error {
  readonly violations: LifecycleInvariantViolation[];

  constructor(violations: LifecycleInvariantViolation[]) {
    const bounded = violations.slice(0, MAX_DIAGNOSTICS);
    super(`Job lifecycle invariant violation: ${JSON.stringify(bounded)}`);
    this.name = 'JobLifecycleInvariantError';
    this.violations = bounded;
  }
}

function recognizedLegacyLocalReason(job: {
  title: string;
  company: string;
  location: string | null;
  description: string | null;
  url: string | null;
  source: string | null;
  passReason: string | null;
}): boolean {
  const reason = job.passReason;
  if (!reason) return false;
  if (LEGACY_LOCAL_PREFIXES.some((prefix) => reason.startsWith(prefix))) return true;
  const prefilter = passesPreFilter({
    title: job.title,
    company: job.company,
    location: job.location || '',
    description: job.description || '',
    url: job.url || '',
  });
  if (!prefilter.passes && prefilter.reason === reason) return true;
  if (!hasAuthoritativeMetadata(job.source)) return false;
  const metadata = evaluateAuthoritativeMetadata(job);
  return !metadata.passes && metadata.reason === reason;
}

export async function assertJobLifecycleInvariants(
  client: DbClient,
  affectedJobIds: readonly string[],
  options: { versions?: CurrentScoringInputVersions } = {},
): Promise<void> {
  const jobIds = [...new Set(affectedJobIds.filter(Boolean))].sort();
  if (jobIds.length === 0) return;

  const jobs = await client.job.findMany({
    where: { id: { in: jobIds } },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      description: true,
      url: true,
      source: true,
      status: true,
      scoringStatus: true,
      tailoringStaged: true,
      passReason: true,
      aimFitScore: true,
      reqFitScore: true,
      pipelineEvents: {
        where: { eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { id: true, eventType: true, occurredAt: true, details: true },
      },
      _count: { select: { scoreEvents: true } },
    },
  });
  const missingIds = jobIds.filter((id) => !jobs.some((job) => job.id === id));
  if (missingIds.length > 0) {
    throw new JobLifecycleInvariantError(missingIds.map((id) => ({
      jobId: id,
      invariant: 'affected_job_missing',
      authorityEventId: null,
      proposedState: {
        status: 'missing', scoringStatus: 'missing', tailoringStaged: false,
        aimFitScore: null, reqFitScore: null,
      },
    })));
  }

  const versions = options.versions || currentScoringInputVersions();
  const currentSuppressionIds = await currentAimSuppressedJobIds(client, jobIds, versions);
  const scopedRows = await client.job.findMany({
    where: { AND: [{ id: { in: jobIds } }, operationalPartitionScopeWhere(currentSuppressionIds)] },
    select: { id: true },
  });
  const scopedIds = new Set(scopedRows.map((job) => job.id));
  const categoryIds = OPERATIONAL_QUEUE_CATEGORIES.reduce<Record<OperationalQueueCategory, string[]>>(
    (result, category) => ({ ...result, [category]: [] }),
    {} as Record<OperationalQueueCategory, string[]>,
  );
  for (const category of OPERATIONAL_QUEUE_CATEGORIES) {
    const rows = await client.job.findMany({
      where: { AND: [{ id: { in: jobIds } }, operationalQueueWhere(category, currentSuppressionIds)] },
      select: { id: true },
    });
    categoryIds[category] = rows.map((job) => job.id);
  }
  const partition = inspectOperationalPartition([...scopedIds], categoryIds);
  const noCategoryIds = new Set(partition.noCategoryJobIds);
  const multipleCategoryById = new Map(
    partition.multipleCategoryJobs.map((entry) => [entry.jobId, entry.categories]),
  );
  const memberships = new Map<string, OperationalQueueCategory[]>();
  for (const id of jobIds) memberships.set(id, []);
  for (const category of OPERATIONAL_QUEUE_CATEGORIES) {
    for (const id of categoryIds[category]) memberships.get(id)?.push(category);
  }

  const bundles = await latestJobScoreEvents(jobIds, client, versions);
  const violations: LifecycleInvariantViolation[] = [];
  for (const job of jobs) {
    const bundle = bundles.get(job.id) || null;
    const resolved = bundle ? resolveStagedScoreAuthority(bundle) : null;
    const authority: LifecycleScoreAuthority = resolved?.currentExperience
      ? {
        kind: 'experience', eventId: resolved.currentExperience.id,
        passed: resolved.currentExperience.passed, score: resolved.currentExperience.experienceFitScore,
      }
      : resolved?.currentAim
        ? {
          kind: 'aim', eventId: resolved.currentAim.id,
          passed: resolved.currentAim.passed, score: resolved.currentAim.aimFitScore,
        }
        : resolved?.currentLegacy
          ? {
            kind: 'legacy', eventId: resolved.currentLegacy.id,
            passed: resolved.currentLegacy.passed, score: resolved.currentLegacy.aimFitScore,
          }
          : resolved && (resolved.aimAuthorityState === 'stale_replay_needed'
            || resolved.experienceAuthorityState === 'stale_replay_needed')
            ? { kind: 'stale', eventId: bundle?.experience?.id || bundle?.aim?.id || bundle?.legacy?.id || null, passed: null, score: null }
            : { kind: 'none', eventId: null, passed: null, score: null };
    const reasonRecognized = recognizedLegacyLocalReason(job);
    violations.push(...inspectJobLifecycleInvariant({
      id: job.id,
      status: job.status,
      scoringStatus: job.scoringStatus,
      source: job.source,
      tailoringStaged: job.tailoringStaged,
      aimFitScore: job.aimFitScore,
      reqFitScore: job.reqFitScore,
      passReason: job.passReason,
      userIntent: latestUserLifecycleIntent(job.pipelineEvents),
      rawScoreEventCount: job._count.scoreEvents,
      inOperationalScope: scopedIds.has(job.id),
      operationalCategories: multipleCategoryById.get(job.id)
        || (noCategoryIds.has(job.id) ? [] : memberships.get(job.id) || []),
      authority,
      legacyLocalDecision: job.status === 'dismissed'
        && job.scoringStatus === 'skipped',
      legacyLocalReasonRecognized: reasonRecognized,
    }));
  }
  if (violations.length > 0) throw new JobLifecycleInvariantError(violations);
}
