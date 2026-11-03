import { Prisma, type PrismaClient } from './prismaClient';
import { operationalQueueWhere } from './operationalQueue';
import { CLEARED_JD_DEFERRALS } from './jdEnrichmentDeferral';
import { latestJobScoreEvents } from './jobScoreAuthorityQuery';
import { resolveStagedScoreAuthority } from './scoreAuthority';
import { isCurrentAimExperienceAnchor } from './aimStage1';
import { aimSourceJdHash, aimTrustedMetadataHash, normalizeAimTrustedMetadata } from './aimIdentity';
import { normalizeScoringText } from './scoringCanonicalJson';
import { assertJobLifecycleInvariants } from './jobLifecycleInvariant';

export type FailureRecoveryStage = 'jd' | 'experience';

/** An explicit per-card action retries only work that never produced a score.
 * No completed stage, lifecycle decision, or input is reset by this operation. */
export async function retryFailedJob(client: PrismaClient, jobId: string, stage: FailureRecoveryStage,
  dependencies = { latestJobScoreEvents, assertJobLifecycleInvariants }) {
  return client.$transaction(async tx => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`failed-job-recovery:${jobId}`}, 0))`);
    const failure: Prisma.JobWhereInput = stage === 'jd'
      ? operationalQueueWhere('jd_failed', [])
      : { scoringStatus: 'failed', scoreError: { startsWith: 'Experience Fit could not score this job:' } };
    const scope: Prisma.JobWhereInput = {
      AND: [failure, { id: jobId, status: 'pending_af', tailoringStaged: false,
        batchJobId: null, jdBatchId: null, afBatchId: null, reqFitScore: null,
        ...(stage === 'jd' ? { fitScore: null, aimFitScore: null, scoreEvents: { none: {} } } : {}),
        scoringBatchItems: { none: { status: 'leased' } },
        pipelineEvents: { none: { eventType: { in: ['user_promote', 'user_reject', 'user_lifecycle'] } } },
      }],
    };
    const job = await tx.job.findFirst({ where: scope });
    if (!job) throw new Error('This failure is no longer retryable, or the job has completed, protected, or leased work.');
    if (stage === 'experience') {
      const bundle = (await dependencies.latestJobScoreEvents([jobId], tx)).get(jobId);
      const authority = bundle ? resolveStagedScoreAuthority(bundle) : null;
      const aim = authority?.currentAim;
      if (!aim?.passed || aim.schemaVersion !== 'career-dashboard-aim-result-v2'
        || !aim.aimFactualExtractionId || !aim.semanticResultHash || authority?.currentExperience) {
        throw new Error('Retry requires a completed Aim result and no completed Experience result.');
      }
      const extraction = await tx.aimFactualExtraction.findUnique({ where: { id: aim.aimFactualExtractionId } });
      if (!isCurrentAimExperienceAnchor(extraction, aimSourceJdHash(normalizeScoringText(job.description || '')))
        || extraction!.trustedMetadataHash !== aimTrustedMetadataHash(normalizeAimTrustedMetadata({
          company: job.company, title: job.title, location: job.location,
        }))) throw new Error('The saved Aim inputs no longer match this posting; an explicit rescore is required.');
    }
    const data: Prisma.JobUpdateManyMutationInput = stage === 'jd'
      ? { scoringStatus: 'needs_jd', scoreAttempts: 0, scoreError: null, passReason: null, ...CLEARED_JD_DEFERRALS }
      : { scoringStatus: 'scored', experienceStatus: 'queued', scoreError: null };
    const changed = await tx.job.updateMany({
      where: { AND: [scope, { updatedAt: job.updatedAt, description: job.description,
        title: job.title, company: job.company, location: job.location,
        aimFitScore: job.aimFitScore, reqFitScore: job.reqFitScore, scoreError: job.scoreError }] },
      data,
    });
    if (changed.count !== 1) throw new Error('The job changed during recovery; refresh and try again.');
    await tx.jobPipelineEvent.create({ data: {
      eventKey: `user-failure-retry:${crypto.randomUUID()}`, eventType: 'user_failure_retry',
      stage: stage === 'jd' ? 'jd_recovery' : 'experience', jobId, source: job.source,
      details: { requestedStage: stage, previousScoringStatus: job.scoringStatus,
        previousScoreError: job.scoreError, previousScoreAttempts: job.scoreAttempts,
        previousPassReason: job.passReason, scoresPreserved: true },
    } });
    await dependencies.assertJobLifecycleInvariants(tx, [jobId]);
    return { jobId, stage, queue: stage === 'jd' ? 'needs_jd' : 'experience_fit', scoresPreserved: true };
  }, { isolationLevel: 'Serializable', timeout: 15_000 });
}
