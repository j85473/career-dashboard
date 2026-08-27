import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recomputeLocalScore } from '@/lib/jobScoring';
import { statusAfterScoringInputEdit } from '@/lib/scoringState';
import { contextDecisionAlreadyHandled } from '@/lib/contextFeedbackPolicy';
import { recordJobPipelineEvent } from '@/lib/ingestionControl';
import { humanLifecycleEvent } from '@/lib/jobLifecycleEvents';
import {
  AUTHORITATIVE_SCORE_EVENT_TYPES,
  projectJobScoreAuthority,
  scoringInputMutationPolicy,
} from '@/lib/scoreAuthority';
import { invalidateActiveJobScores } from '@/lib/scoreInvalidation';
import { assertJobLifecycleInvariants } from '@/lib/jobLifecycleInvariant';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';
import { suppressLiveAppliedDuplicates } from '@/lib/appliedDuplicateStore';
import {
  appliedIdentityFingerprint,
  shouldMaintainAppliedIdentity,
} from '@/lib/appliedDuplicateIdentity';
import {
  automatedLifecycleIsProtected,
  normalizeManualImportMetadata,
} from '@/lib/manualImportPolicy';
import { parkSameCompanyInboxJobs, resolveInboxAdmission } from '@/lib/companyCooldown';


export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const [job, scoreHistory] = await Promise.all([
    prisma.job.findUnique({ where: { id } }),
    prisma.jobScoreEvent.findMany({
      where: {
        jobId: id,
        evaluationType: { in: [...AUTHORITATIVE_SCORE_EVENT_TYPES] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5,
      select: {
        id: true,
        evaluationType: true,
        model: true,
        promptVersion: true,
        policyVersion: true,
        schemaVersion: true,
        requestId: true,
        resultHash: true,
        batchId: true,
        batchItemId: true,
        decisionCode: true,
        aimFitScore: true,
        experienceFitScore: true,
        travelScore: true,
        domainMatch: true,
        requiredDomain: true,
        candidateDomain: true,
        qualificationBasis: true,
        mandatoryRequirementAssessments: true,
        aimAssessments: true,
        travelAssessment: true,
        compensationAssessment: true,
        inputBindings: true,
        sourceAimEventId: true,
        cleanedJdArtifactId: true,
        workerProvenance: true,
        passed: true,
        aimReason: true,
        experienceReason: true,
        staleAt: true,
        staleReason: true,
        createdAt: true,
      },
    }).catch(() => []),
  ]);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const latestScores = await latestJobScoreEvents([job.id]);
  const projected = projectJobScoreAuthority(job, latestScores.get(job.id) || null);

  return NextResponse.json({
    job: {
      ...projected,
      scoreHistory,
    },
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  const { status, tailoringStaged, manualAts, url, canonicalUrl, description, passReason, title, company, location, skipRescore, forceRescore } = body;
  const currentJob = await prisma.job.findUnique({
    where: { id },
    select: {
      status: true,
      source: true,
      title: true,
      company: true,
      location: true,
      passReason: true,
      identityFingerprint: true,
      description: true,
      manualAts: true,
      url: true,
      canonicalUrl: true,
      tailoringStaged: true,
      updatedAt: true,
    },
  });
  if (!currentJob) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (description !== undefined && typeof description !== 'string') {
    return NextResponse.json({ error: 'Description must be a string' }, { status: 400 });
  }

  const normalizedManualMetadata = normalizeManualImportMetadata({
    source: currentJob.source,
    title: title !== undefined ? title : currentJob.title,
    company: company !== undefined ? company : currentJob.company,
    location: location !== undefined ? location : currentJob.location,
    description: description !== undefined ? description : currentJob.description,
    url: url !== undefined ? url : currentJob.url,
  });
  // Explicit user metadata remains authoritative. Normalization only fills
  // generic/missing fields the request did not itself replace.
  const effectiveTitle = title !== undefined ? title : normalizedManualMetadata.title;
  const effectiveCompany = company !== undefined ? company : normalizedManualMetadata.company;
  const effectiveLocation = location !== undefined ? location : normalizedManualMetadata.location;
  const titleChanged = effectiveTitle !== currentJob.title;
  const companyChanged = effectiveCompany !== currentJob.company;
  const locationChanged = effectiveLocation !== currentJob.location;
  const descriptionChanged = description !== undefined && description !== currentJob.description;
  const urlChanged = url !== undefined && url !== currentJob.url;
  // URLs are transport provenance, not scoring evidence. Replacing an
  // aggregator/tracking link must not stale scores while the scored JD and
  // trusted metadata remain unchanged.
  const scoringInputChanged = titleChanged || companyChanged || locationChanged || descriptionChanged;
  const { shouldInvalidateScores, shouldQueueRescore } = scoringInputMutationPolicy({
    scoringInputChanged,
    forceRescore: forceRescore === true,
    skipRescore: skipRescore === true,
  });
  const scoreInvalidationFields = [
    titleChanged ? 'title' : null,
    companyChanged ? 'company' : null,
    locationChanged ? 'location' : null,
    descriptionChanged ? 'description' : null,
  ].filter((field): field is string => field !== null);
  const manualAtsChanged = manualAts !== undefined && manualAts !== currentJob.manualAts;
  const identityInputChanged = titleChanged || companyChanged || locationChanged;
  const effectiveStatus = status !== undefined ? status : currentJob.status;
  const effectivePassReason = (status === 'passed' || status === 'dismissed') && typeof passReason === 'string'
    ? passReason
    : currentJob.passReason;
  
  const data: Prisma.JobUpdateInput = {};
  const resetAiEvaluation = () => {
    data.aimFitScore = null;
    data.reqFitScore = null;
    data.reqFitRationale = null;
    data.travelScore = null;
    data.compensation = null;
    data.passReason = null;
    data.afBatchId = null;
    data.deepseekScoreAttempts = 0;
    data.deepseekScoreError = null;
  };
  if (status !== undefined) {
    data.status = status;
    if (status === 'applied') {
      data.tailoringStaged = false;
      data.contextBatched = true;
      data.contextBatchId = null;
    } else if (status === 'passed' || status === 'dismissed') {
      data.tailoringStaged = false;
      const decisionReason = typeof passReason === 'string' ? passReason : null;
      data.passReason = decisionReason;
      data.contextBatched = contextDecisionAlreadyHandled(status, decisionReason);
      data.contextBatchId = null;
    } else if (status === 'interviewing') {
      data.contextBatched = true;
      data.contextBatchId = null;
    } else if (status === 'expired' || status === 'archived') {
      data.tailoringStaged = false;
      data.contextBatched = true;
      data.contextBatchId = null;
    } else {
      // Restoring, bookmarking, promoting, or otherwise moving away from an
      // intentional rejection invalidates any pending negative-context lease.
      data.contextBatched = true;
      data.contextBatchId = null;
    }
  }
  if (tailoringStaged !== undefined) {
    if (tailoringStaged === true) {
      const existingStagedJob = await prisma.job.findFirst({
        where: {
          company: currentJob.company,
          tailoringStaged: true,
          id: { not: id },
        },
        select: { id: true, title: true }
      });
      if (existingStagedJob) {
        return NextResponse.json({ error: `You already have a job staged for ${currentJob.company}.` }, { status: 400 });
      }
    }
    data.tailoringStaged = tailoringStaged;
  }
  
  if (titleChanged) data.title = effectiveTitle;
  if (companyChanged) data.company = effectiveCompany;
  if (locationChanged) data.location = effectiveLocation;
  if (manualAts !== undefined) {
    data.manualAts = manualAts;
  }
  if (url !== undefined) data.url = url;
  if (canonicalUrl !== undefined) data.canonicalUrl = canonicalUrl;
  if (description !== undefined) data.description = description;
  if (shouldMaintainAppliedIdentity({
    status: effectiveStatus,
    passReason: effectivePassReason,
    identityInputChanged,
    currentIdentityFingerprint: currentJob.identityFingerprint,
  })) {
    data.identityFingerprint = appliedIdentityFingerprint({
      title: effectiveTitle,
      company: effectiveCompany,
      location: effectiveLocation,
    });
  }
  if (shouldQueueRescore) {
    const effectiveDescription = description !== undefined ? description : (currentJob.description || '');
    const needsJobDescription = urlChanged
      || effectiveDescription.length < 400
      || effectiveDescription.endsWith('...')
      || effectiveDescription.endsWith('…');
    resetAiEvaluation();
    data.scoringStatus = needsJobDescription ? 'needs_jd' : 'queued';
    data.experienceStatus = 'queued';
    data.status = automatedLifecycleIsProtected(currentJob)
      ? (typeof status === 'string' && status ? status : currentJob.status)
      : statusAfterScoringInputEdit(status ?? currentJob.status);
    data.scoreAttempts = 0;
    data.scoreError = null;
    data.jdBatchId = null;
    data.batchJobId = null;
    data.fitScore = null;
    data.fitCategory = 'unscored';
    data.fitRationale = null;
    data.recommendedResume = null;
  }

  // Even when a caller explicitly skips rescoring, a URL replacement must
  // invalidate in-flight workers that are fetching the previous URL.
  if (urlChanged && skipRescore === true) {
    data.jdBatchId = null;
    data.batchJobId = null;
    data.afBatchId = null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No valid update fields provided' }, { status: 400 });
  }

  try {
    const mutation = await prisma.$transaction(async (tx) => {
      const [lockedPrior] = await tx.$queryRaw<Array<{
        status: string;
        tailoringStaged: boolean;
        updatedAt: Date;
      }>>`
        SELECT status, "tailoringStaged", "updatedAt" FROM "Job" WHERE id = ${id} FOR UPDATE;
      `;
      if (!lockedPrior) throw new Error('Job not found');
      if (lockedPrior.updatedAt.valueOf() !== currentJob.updatedAt.valueOf()
        || lockedPrior.status !== currentJob.status
        || lockedPrior.tailoringStaged !== currentJob.tailoringStaged) {
        throw new Error('Job changed after PATCH derivation');
      }
      let updated = await tx.job.update({ where: { id }, data });
      const suppressedDuplicateIds = await suppressLiveAppliedDuplicates(updated, tx);

      const invalidation = shouldInvalidateScores
        ? await invalidateActiveJobScores({
          jobId: updated.id,
          source: updated.source,
          sourceId: updated.sourceId,
          changedFields: scoreInvalidationFields,
          route: 'generic_patch',
        }, tx)
        : { invalidatedEventIds: [], staleReason: null };

      if (shouldQueueRescore) {
        await recordJobPipelineEvent({
          eventType: 'user_rescore',
          jobId: updated.id,
          stage: 'manual_scoring',
          source: updated.source,
          sourceId: updated.sourceId,
          occurredAt: updated.updatedAt,
          identityParts: ['generic_patch', updated.updatedAt.toISOString()],
          details: { route: 'generic_patch', changedFields: scoreInvalidationFields },
        }, tx);
      }

      // Lifecycle cooldown and the human transition event share this
      // transaction. That prevents an "entered Inbox" event when the company
      // cooldown immediately diverts the requested restore to Cooldown.
      const affectedJobIds = [updated.id, ...suppressedDuplicateIds];
      if ((status === 'applied' || status === 'interviewing') && updated.company) {
        affectedJobIds.push(...await parkSameCompanyInboxJobs({
          authorityJobId: updated.id,
          company: updated.company,
          decisionAt: updated.updatedAt,
          now: updated.updatedAt,
          store: tx,
        }));
      } else if (
        status === 'inbox'
        && updated.status === 'inbox'
        && updated.company
      ) {
        const admission = await resolveInboxAdmission({
          jobId: updated.id,
          company: updated.company,
          source: updated.source,
          proposedStatus: 'inbox',
          now: updated.updatedAt,
          store: tx,
        });
        if (admission.status === 'cooldown') {
          updated = await tx.job.update({
            where: { id },
            data: { status: 'cooldown', cooldownUntil: admission.cooldownUntil },
          });
        }
      }

      const lifecycleEvent = humanLifecycleEvent(lockedPrior.status, status, updated.status);
      if (lifecycleEvent) {
        await recordJobPipelineEvent({
          eventType: lifecycleEvent.eventType,
          jobId: updated.id,
          stage: 'human_decision',
          source: updated.source,
          sourceId: updated.sourceId,
          occurredAt: updated.updatedAt,
          identityParts: ['status_transition', lifecycleEvent.priorStatus, lifecycleEvent.nextStatus, updated.updatedAt.toISOString()],
          details: {
            priorStatus: lifecycleEvent.priorStatus,
            nextStatus: lifecycleEvent.nextStatus,
            enteredInbox: lifecycleEvent.enteredInbox,
            actor: lifecycleEvent.actor,
            protected: lifecycleEvent.protected,
            route: 'generic_patch',
            reason: typeof passReason === 'string' ? passReason : null,
          },
        }, tx);
      }
      if (tailoringStaged !== undefined && lockedPrior.tailoringStaged !== updated.tailoringStaged) {
        await recordJobPipelineEvent({
          eventType: 'user_lifecycle',
          jobId: updated.id,
          stage: 'human_decision',
          source: updated.source,
          sourceId: updated.sourceId,
          occurredAt: updated.updatedAt,
          identityParts: ['tailoring_staged', String(lockedPrior.tailoringStaged), String(updated.tailoringStaged), updated.updatedAt.toISOString()],
          details: {
            priorTailoringStaged: lockedPrior.tailoringStaged,
            nextTailoringStaged: updated.tailoringStaged,
            status: updated.status,
            actor: 'user',
            protected: true,
            route: 'generic_patch',
          },
        }, tx);
      }

      await assertJobLifecycleInvariants(tx, affectedJobIds);

      return { job: updated, invalidation, suppressedDuplicateIds };
    });
    let job = mutation.job;

    // ATS choice affects only the deterministic heuristic. Preserve the
    // native A/E evaluation and the user's lifecycle decision.
    if (manualAtsChanged && !shouldQueueRescore) {
      try {
        job = await recomputeLocalScore(id) || job;
      } catch (error) {
        console.error('Failed to recompute local ATS score:', error);
      }
    }

    // We no longer send 'applied' actions to the Context Profile to prevent 
    // bridge roles from watering down the master archetype.
    
    const latestScores = await latestJobScoreEvents([job.id]);
    const authoritativeJob = projectJobScoreAuthority(job, latestScores.get(job.id) || null);
    return NextResponse.json({
      job: authoritativeJob,
      rescoreQueued: shouldQueueRescore,
      scoreInvalidated: mutation.invalidation.invalidatedEventIds.length > 0,
      suppressedDuplicateIds: mutation.suppressedDuplicateIds,
    });
  } catch {
    return NextResponse.json({ error: 'Failed to update job' }, { status: 500 });
  }
}
