import 'dotenv/config';

import { Prisma, type PrismaClient } from '@prisma/client';

import {
  extractJsonLdJobPosting,
  jsonLdLocationString,
  JSON_LD_FETCH_USER_AGENT,
} from '../src/lib/atsApi';
import { generateV4Fingerprint } from '../src/lib/jobIngestion';
import { assertJobLifecycleInvariants } from '../src/lib/jobLifecycleInvariant';
import { recordJobPipelineEvent } from '../src/lib/ingestionControl';
import { prisma } from '../src/lib/prisma';
import { safeExternalFetch } from '../src/lib/safeExternalFetch';
import { canonicalJsonSha256 } from '../src/lib/scoringCanonicalJson';
import { TEAMTAILOR_LOCATION_UNAVAILABLE_REASON } from '../src/lib/teamtailorLocation';
import {
  TEAMTAILOR_LOCATION_REPAIR_ACTIVE_STATUSES,
  planTeamtailorLocationRepair,
  planTeamtailorUnavailableLocationHold,
  type TeamtailorLocationRepairPlan,
} from '../src/lib/teamtailorLocationRepair';
import { USER_LIFECYCLE_INTENT_EVENT_TYPES } from '../src/lib/userLifecycleAuthority';

const VERSION = 'teamtailor-location-recovery-v1';
const CONCURRENCY = 4;
type DbClient = PrismaClient | Prisma.TransactionClient;

const candidateSelect = {
  id: true,
  title: true,
  company: true,
  description: true,
  location: true,
  url: true,
  source: true,
  sourceId: true,
  status: true,
  scoringStatus: true,
  passReason: true,
  identityFingerprint: true,
  tailoringStaged: true,
  aimFitScore: true,
  reqFitScore: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;

type Candidate = Prisma.JobGetPayload<{ select: typeof candidateSelect }>;
type PlannedRepair = {
  candidate: Candidate;
  target: TeamtailorLocationRepairPlan;
  identityFingerprint: string;
};

function candidateWhere(): Prisma.JobWhereInput {
  return {
    source: 'ATS-teamtailor',
    tailoringStaged: false,
    scoringBatchItems: { none: { status: 'leased' } },
    pipelineEvents: { none: { eventType: { in: [...USER_LIFECYCLE_INTENT_EVENT_TYPES] } } },
    AND: [
      {
        OR: [
          { location: null },
          { location: '' },
          { location: { equals: 'Unknown Location', mode: 'insensitive' } },
        ],
      },
      {
        OR: [
          { status: { in: [...TEAMTAILOR_LOCATION_REPAIR_ACTIVE_STATUSES] } },
          { status: 'archived', passReason: TEAMTAILOR_LOCATION_UNAVAILABLE_REASON },
        ],
      },
    ],
  };
}

async function loadCandidates(client: DbClient): Promise<Candidate[]> {
  return client.job.findMany({
    where: candidateWhere(),
    select: candidateSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

function parseMode(argv: string[]): { apply: boolean; approvedSelectionHash: string | null } {
  if (argv.length === 0) return { apply: false, approvedSelectionHash: null };
  if (argv.length !== 3 || argv[0] !== '--apply' || argv[1] !== '--selection-hash'
    || !/^[a-f0-9]{64}$/.test(argv[2])) {
    throw new Error(
      'Usage: recover_teamtailor_locations.ts '
      + '[--apply --selection-hash <reviewed-dry-run-hash>]',
    );
  }
  return { apply: true, approvedSelectionHash: argv[2] };
}

async function recoverLocation(candidate: Candidate): Promise<string | null> {
  if (!candidate.url) return null;
  try {
    const response = await safeExternalFetch(candidate.url, {
      headers: { 'User-Agent': JSON_LD_FETCH_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const posting = extractJsonLdJobPosting(await response.text());
    return posting ? jsonLdLocationString(posting.jobLocation) : null;
  } catch {
    return null;
  }
}

async function buildPlans(candidates: Candidate[]): Promise<{
  plans: PlannedRepair[];
  unavailable: Candidate[];
}> {
  const plans: PlannedRepair[] = [];
  const unavailable: Candidate[] = [];
  for (let offset = 0; offset < candidates.length; offset += CONCURRENCY) {
    const batch = candidates.slice(offset, offset + CONCURRENCY);
    const locations = await Promise.all(batch.map(recoverLocation));
    for (let index = 0; index < batch.length; index++) {
      const candidate = batch[index];
      const location = locations[index];
      if (!location) {
        if ((TEAMTAILOR_LOCATION_REPAIR_ACTIVE_STATUSES as readonly string[]).includes(candidate.status)) {
          plans.push({
            candidate,
            target: planTeamtailorUnavailableLocationHold(candidate),
            identityFingerprint: candidate.identityFingerprint
              || generateV4Fingerprint(candidate.title, candidate.company, candidate.location || 'Unknown Location'),
          });
        } else {
          unavailable.push(candidate);
        }
        continue;
      }
      plans.push({
        candidate,
        target: planTeamtailorLocationRepair(candidate, location),
        identityFingerprint: generateV4Fingerprint(candidate.title, candidate.company, location),
      });
    }
  }
  return { plans, unavailable };
}

function selectionHash(plans: readonly PlannedRepair[]): string {
  return canonicalJsonSha256(plans.map(({ candidate, target, identityFingerprint }) => ({
    id: candidate.id,
    updatedAt: candidate.updatedAt.toISOString(),
    sourceId: candidate.sourceId,
    priorLocation: candidate.location,
    priorStatus: candidate.status,
    priorScoringStatus: candidate.scoringStatus,
    priorPassReason: candidate.passReason,
    aimFitScore: candidate.aimFitScore,
    reqFitScore: candidate.reqFitScore,
    target,
    identityFingerprint,
  })));
}

async function applyOne(
  planned: PlannedRepair,
  reviewedSelectionHash: string,
): Promise<'applied' | 'blocked'> {
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Job" WHERE id = ${planned.candidate.id} FOR UPDATE
    `;
    if (!locked) return 'blocked';

    const current = await tx.job.findFirst({
      where: {
        id: planned.candidate.id,
        updatedAt: planned.candidate.updatedAt,
        ...candidateWhere(),
      },
      select: candidateSelect,
    });
    if (!current) return 'blocked';
    const currentTarget = planned.target.action === 'hold_for_recovery'
      ? planTeamtailorUnavailableLocationHold(current)
      : planTeamtailorLocationRepair(current, planned.target.location);
    const currentPlan: PlannedRepair = {
      candidate: current,
      target: currentTarget,
      identityFingerprint: currentTarget.action === 'hold_for_recovery'
        ? current.identityFingerprint
          || generateV4Fingerprint(current.title, current.company, current.location || 'Unknown Location')
        : generateV4Fingerprint(current.title, current.company, currentTarget.location),
    };
    if (selectionHash([currentPlan]) !== selectionHash([planned])) return 'blocked';

    const updated = await tx.job.updateMany({
      where: { id: current.id, updatedAt: current.updatedAt },
      data: {
        location: currentPlan.target.location,
        identityFingerprint: currentPlan.identityFingerprint,
        status: currentPlan.target.status,
        scoringStatus: currentPlan.target.scoringStatus,
        passReason: currentPlan.target.passReason,
      },
    });
    if (updated.count !== 1) return 'blocked';

    await recordJobPipelineEvent({
      eventType: currentPlan.target.action === 'archive_out_of_scope'
        || currentPlan.target.action === 'hold_for_recovery'
        ? 'prefilter_rejected'
        : 'lifecycle_reconciled',
      jobId: current.id,
      stage: 'policy_reconciliation',
      source: current.source,
      sourceId: current.sourceId,
      details: {
        route: 'recover_teamtailor_locations',
        version: VERSION,
        reviewedSelectionHash,
        action: currentPlan.target.action,
        priorLocation: current.location,
        recoveredLocation: currentPlan.target.location,
        priorStatus: current.status,
        targetStatus: currentPlan.target.status,
        geographyReason: currentPlan.target.geographyReason || null,
        preservedScores: {
          aimFitScore: current.aimFitScore,
          reqFitScore: current.reqFitScore,
        },
      } as Prisma.InputJsonValue,
      identityParts: [VERSION, reviewedSelectionHash],
    }, tx);
    await assertJobLifecycleInvariants(tx, [current.id]);
    return 'applied';
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
}

async function main(): Promise<void> {
  const { apply, approvedSelectionHash } = parseMode(process.argv.slice(2));
  const candidates = await loadCandidates(prisma);
  const { plans, unavailable } = await buildPlans(candidates);
  const currentSelectionHash = selectionHash(plans);

  const counts = plans.reduce<Record<string, number>>((result, plan) => {
    result[plan.target.action] = (result[plan.target.action] || 0) + 1;
    return result;
  }, {});
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — Teamtailor authoritative location recovery`);
  console.log(`  guarded candidates:                  ${candidates.length.toLocaleString()}`);
  console.log(`  locations recovered:                 ${plans.filter((plan) => plan.target.action !== 'hold_for_recovery').length.toLocaleString()}`);
  console.log(`  detail unavailable (left unchanged): ${unavailable.length.toLocaleString()}`);
  console.log(`  metadata-only updates:                ${(counts.metadata_only || 0).toLocaleString()}`);
  console.log(`  out-of-scope archives:                ${(counts.archive_out_of_scope || 0).toLocaleString()}`);
  console.log(`  held pending location recovery:       ${(counts.hold_for_recovery || 0).toLocaleString()}`);
  console.log(`  restored after recovery:              ${(counts.restore_after_recovery || 0).toLocaleString()}`);
  console.log(`  selection hash:                       ${currentSelectionHash}`);
  for (const { candidate, target } of plans) {
    console.log(`  ${candidate.id}  ${candidate.company} — ${candidate.title}`);
    console.log(`    ${candidate.location || '(no location)'} -> ${target.location}`);
    console.log(`    ${candidate.status} -> ${target.status}; ${target.action}`);
  }

  if (plans.length === 0) {
    console.log('\nNothing to repair.');
    return;
  }

  if (!apply) {
    console.log('\nDry run only. Review the rows above, then re-run with:');
    console.log(`  --apply --selection-hash ${currentSelectionHash}`);
    return;
  }
  if (approvedSelectionHash !== currentSelectionHash) {
    throw new Error(
      `Selection hash mismatch: reviewed ${approvedSelectionHash}; current ${currentSelectionHash}. No writes were attempted.`,
    );
  }

  let applied = 0;
  let blocked = 0;
  for (const plan of plans) {
    const result = await applyOne(plan, currentSelectionHash);
    if (result === 'applied') applied++;
    else blocked++;
  }
  console.log(`\nApplied ${applied.toLocaleString()} location repair(s).`);
  console.log(`Blocked ${blocked.toLocaleString()} row(s) that changed after review.`);
  console.log('Aim/Experience score fields and score events were not modified.');
}

main()
  .catch((error: unknown) => {
    console.error(`Teamtailor location recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
