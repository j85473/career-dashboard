import { prisma } from '../src/lib/prisma';
import {
  contextRulesForNativeScoring,
  isContextFeedbackEligible,
} from '../src/lib/contextFeedbackPolicy';
import { passesPreFilter } from '../src/lib/jobFiltering';
import {
  NATIVE_SCORING_CHUNK_SIZE,
  NATIVE_SCORING_STANDARD_BATCH_SIZE,
  STANDARD_PROMPT_VERSION,
} from '../src/lib/nativeScoringBatch';
import {
  recentDismissedRecoveryIds,
  RECENT_DISMISSED_RECOVERY_DAYS,
  RECENT_DISMISSED_RECOVERY_LIMIT,
  latestUsablePromptVersions,
  nativeReplaySelectionHash,
  projectedNativeReplayBatchCount,
  staleActiveScoreIds,
  type StandardScoreProvenance,
} from '../src/lib/scoringFreshness';

const DISMISSED_RECOVERY_CAMPAIGN_PROMPT_VERSION = 'standard-job-evaluator-v6.3';

type CountRow = { count: bigint };
type SourceQualityRow = {
  source: string | null;
  jobs: bigint;
  short_descriptions: bigint;
};

function number(value: bigint | undefined): number {
  return value === undefined ? 0 : Number(value);
}

async function main(): Promise<void> {
  const snapshotGeneratedAt = new Date();
  const [
    totalRows,
    shortRows,
    sourceRows,
    inbox,
    profile,
    experienceMismatchJobs,
    versionGroups,
    contextFeedbackJobs,
    directlyEligibleStandardJobs,
    queuedLocalJobs,
  ] = await Promise.all([
    prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::bigint AS count FROM "Job"`,
    prisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "Job"
      WHERE char_length(coalesce(description, '')) < 400
    `,
    prisma.$queryRaw<SourceQualityRow[]>`
      SELECT source, COUNT(*)::bigint AS jobs,
             COUNT(*) FILTER (WHERE char_length(coalesce(description, '')) < 400)::bigint AS short_descriptions
      FROM "Job"
      GROUP BY source
      ORDER BY COUNT(*) DESC
      LIMIT 12
    `,
    prisma.job.findMany({
      where: {
        status: 'inbox',
        scoringStatus: 'scored',
        tailoringStaged: false,
        aimFitScore: { not: null },
        jdBatchId: null,
        batchJobId: null,
        afBatchId: null,
        fitCategory: { not: 'promoted' },
        pipelineEvents: { none: { eventType: { in: ['user_promote', 'user_reject'] } } },
        OR: [
          { passReason: null },
          { NOT: { passReason: { contains: 'promoted', mode: 'insensitive' } } },
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, passReason: true, tailoringStaged: true },
    }),
    prisma.contextProfile.findUnique({ where: { id: 'global' } }),
    prisma.job.findMany({
      where: { status: 'passed', passReason: { equals: 'Experience mismatch', mode: 'insensitive' } },
      orderBy: { updatedAt: 'desc' },
      select: {
        title: true,
        company: true,
        aimFitScore: true,
        reqFitScore: true,
        updatedAt: true,
      },
    }),
    prisma.jobScoreEvent.groupBy({
      by: ['promptVersion', 'passed'],
      where: { evaluationType: 'standard' },
      _count: { _all: true },
      _avg: { aimFitScore: true, experienceFitScore: true },
      orderBy: { promptVersion: 'asc' },
    }),
    prisma.job.findMany({
      where: {
        status: 'passed',
        contextBatched: false,
        contextBatchId: null,
        passReason: { not: null },
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, status: true, passReason: true },
    }),
    prisma.job.findMany({
      where: {
        scoringStatus: 'scored',
        jdBatchId: null,
        batchJobId: null,
        afBatchId: null,
        tailoringStaged: false,
        NOT: [
          { fitCategory: 'promoted' },
          { passReason: { startsWith: 'Promoted by user:', mode: 'insensitive' } },
          { pipelineEvents: { some: { eventType: { in: ['user_promote', 'user_reject'] } } } },
        ],
        OR: [
          { status: 'pending_af', aimFitScore: null },
          { status: 'inbox', aimFitScore: null },
          { status: 'inbox', aimFitScore: { not: null }, experienceStatus: 'rescore_queued' },
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    }),
    prisma.job.findMany({
      where: {
        scoringStatus: 'queued',
        jdBatchId: null,
        status: { in: ['pending_af', 'inbox'] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        pipelineEvents: {
          where: { eventType: { in: ['user_promote', 'user_reject'] } },
          take: 1,
          select: { id: true },
        },
      },
    }),
  ]);

  const events = inbox.length === 0 ? [] : await prisma.jobScoreEvent.findMany({
    where: { jobId: { in: inbox.map((job) => job.id) }, evaluationType: 'standard' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { jobId: true, promptVersion: true, staleAt: true },
  });
  const latestVersions = latestUsablePromptVersions(events);
  const staleIds = staleActiveScoreIds(inbox, latestVersions, STANDARD_PROMPT_VERSION);
  const currentCount = inbox.filter((job) => latestVersions.get(job.id) === STANDARD_PROMPT_VERSION).length;
  const priorRecoveryCampaignScore = await prisma.jobScoreEvent.findFirst({
    where: { evaluationType: 'standard', promptVersion: DISMISSED_RECOVERY_CAMPAIGN_PROMPT_VERSION },
    select: { id: true },
  });
  const recoveryCutoff = new Date(Date.now() - RECENT_DISMISSED_RECOVERY_DAYS * 24 * 60 * 60 * 1_000);
  const recentStandardEvents = priorRecoveryCampaignScore ? [] : await prisma.jobScoreEvent.findMany({
    where: { evaluationType: 'standard', createdAt: { gte: recoveryCutoff } },
    take: 5_000,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { jobId: true, promptVersion: true, passed: true, createdAt: true, staleAt: true },
  });
  const latestRecentEvents = new Map<string, StandardScoreProvenance>();
  for (const event of recentStandardEvents) {
    if (!latestRecentEvents.has(event.jobId)) latestRecentEvents.set(event.jobId, event);
  }
  const dismissedCandidates = latestRecentEvents.size === 0 ? [] : await prisma.job.findMany({
    where: {
      id: { in: [...latestRecentEvents.keys()] },
      status: 'dismissed',
      scoringStatus: 'scored',
      tailoringStaged: false,
      aimFitScore: { not: null },
      jdBatchId: null,
      batchJobId: null,
      afBatchId: null,
      fitCategory: { not: 'promoted' },
      OR: [
        { passReason: null },
        { NOT: { passReason: { contains: 'promoted', mode: 'insensitive' } } },
      ],
      pipelineEvents: { none: { eventType: { in: ['user_promote', 'user_reject'] } } },
    },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      description: true,
      url: true,
      aimFitScore: true,
      reqFitScore: true,
    },
  });
  const recoveryInput = dismissedCandidates.map((job) => ({
    id: job.id,
    title: job.title,
    aimFitScore: job.aimFitScore,
    reqFitScore: job.reqFitScore,
    localFilterPasses: passesPreFilter({
      title: job.title,
      company: job.company,
      location: job.location || '',
      description: job.description || '',
      url: job.url || '',
    }).passes,
  }));
  const recoveryIds = recentDismissedRecoveryIds(
    recoveryInput,
    latestRecentEvents,
    STANDARD_PROMPT_VERSION,
    recoveryCutoff,
    RECENT_DISMISSED_RECOVERY_LIMIT,
  );
  const recoveryIdSet = new Set(recoveryIds);
  const contextJobIds = contextFeedbackJobs
    .filter((job) => isContextFeedbackEligible(job.status, job.passReason))
    .map((job) => job.id);
  const directlyEligibleStandardJobIds = directlyEligibleStandardJobs.map((job) => job.id);
  const projectedStandardJobIds = [...new Set([
    ...directlyEligibleStandardJobIds,
    ...staleIds,
    ...recoveryIds,
  ])].sort();
  const nativeReplaySelectionComponents = {
    currentPromptVersion: STANDARD_PROMPT_VERSION,
    contextJobIds,
    directlyEligibleStandardJobIds,
    staleInboxRefreshJobIds: staleIds,
    dismissedRecoveryJobIds: recoveryIds,
    projectedAllWaveStandardCandidateIds: projectedStandardJobIds,
  };
  const selectionHash = nativeReplaySelectionHash(nativeReplaySelectionComponents);
  const queuedLocalJobIds = queuedLocalJobs.map((job) => job.id);
  const queuedLocalHumanDecisionJobIds = queuedLocalJobs
    .filter((job) => job.pipelineEvents.length > 0)
    .map((job) => job.id);
  const totalJobs = number(totalRows[0]?.count);
  const shortDescriptions = number(shortRows[0]?.count);
  const calibratedContext = contextRulesForNativeScoring(profile?.rulesText);

  const report = {
    generatedAt: new Date().toISOString(),
    ingestion: {
      totalJobs,
      shortDescriptions,
      shortDescriptionRate: totalJobs === 0 ? 0 : Number((shortDescriptions / totalJobs).toFixed(4)),
      largestSources: sourceRows.map((row) => ({
        source: row.source || '(missing)',
        jobs: number(row.jobs),
        shortDescriptions: number(row.short_descriptions),
      })),
    },
    activeInbox: {
      scoredUnstagedJobs: inbox.length,
      currentPromptVersion: STANDARD_PROMPT_VERSION,
      currentVersionJobs: currentCount,
      staleOrMissingProvenanceJobs: staleIds.length,
      staleOrMissingProvenanceRate: inbox.length === 0 ? 0 : Number((staleIds.length / inbox.length).toFixed(4)),
    },
    recentDismissalRecovery: {
      campaignComplete: Boolean(priorRecoveryCampaignScore),
      windowDays: RECENT_DISMISSED_RECOVERY_DAYS,
      hardLimit: RECENT_DISMISSED_RECOVERY_LIMIT,
      selectedJobs: recoveryIds.length,
      selectedJobIds: recoveryIds,
      samples: dismissedCandidates
        .filter((job) => recoveryIdSet.has(job.id))
        .sort((left, right) => recoveryIds.indexOf(left.id) - recoveryIds.indexOf(right.id))
        .slice(0, 12)
        .map((job) => ({
          title: job.title,
          company: job.company,
          aimFitScore: job.aimFitScore,
          reqFitScore: job.reqFitScore,
        })),
    },
    localReplayPreflight: {
      maximumJobsPerRun: 4_000,
      jobIds: queuedLocalJobIds,
      immutableHumanDecisionJobIds: queuedLocalHumanDecisionJobIds,
    },
    nativeReplayPreflight: {
      semantics: 'point_in_time_all_wave_backlog_not_request_binding',
      selectionHash,
      snapshotGeneratedAt: snapshotGeneratedAt.toISOString(),
      ...nativeReplaySelectionComponents,
      contextBatchSize: NATIVE_SCORING_CHUNK_SIZE,
      projectedContextBatchCount: projectedNativeReplayBatchCount(contextJobIds.length, NATIVE_SCORING_CHUNK_SIZE),
      standardBatchSize: NATIVE_SCORING_STANDARD_BATCH_SIZE,
      projectedStandardBatchCount: projectedNativeReplayBatchCount(
        projectedStandardJobIds.length,
        NATIVE_SCORING_STANDARD_BATCH_SIZE,
      ),
    },
    rejectedAsExperienceMismatch: {
      count: experienceMismatchJobs.length,
      previouslyAtOrAboveNewThreshold: experienceMismatchJobs.filter((job) => (job.reqFitScore || 0) >= 70).length,
      samples: experienceMismatchJobs.slice(0, 12),
    },
    contextCalibration: {
      changed: (profile?.rulesText || '').trim() !== calibratedContext.trim(),
      before: profile?.rulesText || '',
      after: calibratedContext,
    },
    scoringHistory: versionGroups.map((group) => ({
      promptVersion: group.promptVersion,
      passed: group.passed,
      evaluations: group._count._all,
      averageAim: group._avg.aimFitScore,
      averageExperience: group._avg.experienceFitScore,
    })),
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
