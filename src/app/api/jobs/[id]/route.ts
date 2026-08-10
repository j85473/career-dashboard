import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recomputeLocalScore } from '@/lib/jobScoring';
import { statusAfterScoringInputEdit } from '@/lib/scoringState';
import { contextDecisionAlreadyHandled } from '@/lib/contextFeedbackPolicy';
import { isPromptHealthPriorityRole } from '@/lib/priorityOpportunity';
import { recordJobPipelineEvent } from '@/lib/ingestionControl';
import { humanLifecycleEvent } from '@/lib/jobLifecycleEvents';
import {
  AUTHORITATIVE_SCORE_EVENT_TYPES,
  projectJobScoreAuthority,
  resolveScoreAuthority,
  scoringInputMutationPolicy,
} from '@/lib/scoreAuthority';
import { invalidateActiveJobScores } from '@/lib/scoreInvalidation';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';


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
        requestId: true,
        aimFitScore: true,
        experienceFitScore: true,
        travelScore: true,
        domainMatch: true,
        requiredDomain: true,
        candidateDomain: true,
        qualificationBasis: true,
        mandatoryRequirementAssessments: true,
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

  const authority = resolveScoreAuthority(scoreHistory);
  const currentScore = authority.currentScore;
  const humanDecisionReason = job.status === 'passed' || /^Promoted by user:/i.test(job.passReason || '')
    ? job.passReason
    : null;

  return NextResponse.json({
    job: {
      ...job,
      // Model-derived scalars are projections of the current immutable event,
      // never a fallback to an older event or an invalidated Job snapshot.
      aimFitScore: currentScore?.aimFitScore ?? null,
      reqFitScore: currentScore?.experienceFitScore ?? null,
      travelScore: currentScore?.travelScore ?? null,
      passReason: humanDecisionReason ?? currentScore?.aimReason ?? null,
      reqFitRationale: currentScore?.experienceReason ?? null,
      compensation: currentScore ? job.compensation : null,
      scoreHistory,
      ...authority,
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
      title: true,
      company: true,
      location: true,
      description: true,
      manualAts: true,
      url: true,
      canonicalUrl: true,
    },
  });
  if (!currentJob) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (description !== undefined && typeof description !== 'string') {
    return NextResponse.json({ error: 'Description must be a string' }, { status: 400 });
  }

  const titleChanged = title !== undefined && title !== currentJob.title;
  const companyChanged = company !== undefined && company !== currentJob.company;
  const locationChanged = location !== undefined && location !== currentJob.location;
  const descriptionChanged = description !== undefined && description !== currentJob.description;
  const urlChanged = url !== undefined && url !== currentJob.url;
  const canonicalUrlChanged = canonicalUrl !== undefined && canonicalUrl !== currentJob.canonicalUrl;
  const scoringInputChanged = titleChanged || companyChanged || locationChanged || descriptionChanged || urlChanged || canonicalUrlChanged;
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
    urlChanged ? 'url' : null,
    canonicalUrlChanged ? 'canonicalUrl' : null,
  ].filter((field): field is string => field !== null);
  const manualAtsChanged = manualAts !== undefined && manualAts !== currentJob.manualAts;
  
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
  
  if (title !== undefined) data.title = title;
  if (company !== undefined) data.company = company;
  if (location !== undefined) data.location = location;
  if (manualAts !== undefined) {
    data.manualAts = manualAts;
  }
  if (url !== undefined) data.url = url;
  if (canonicalUrl !== undefined) data.canonicalUrl = canonicalUrl;
  if (description !== undefined) data.description = description;
  if (shouldQueueRescore) {
    const effectiveDescription = description !== undefined ? description : (currentJob.description || '');
    const needsJobDescription = urlChanged
      || effectiveDescription.length < 400
      || effectiveDescription.endsWith('...')
      || effectiveDescription.endsWith('…');
    resetAiEvaluation();
    data.scoringStatus = needsJobDescription ? 'needs_jd' : 'queued';
    data.experienceStatus = 'queued';
    data.status = statusAfterScoringInputEdit(status ?? currentJob.status);
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
      const [lockedPrior] = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM "Job" WHERE id = ${id} FOR UPDATE;
      `;
      if (!lockedPrior) throw new Error('Job not found');
      let updated = await tx.job.update({ where: { id }, data });

      const invalidation = shouldInvalidateScores
        ? await invalidateActiveJobScores({
          jobId: updated.id,
          source: updated.source,
          sourceId: updated.sourceId,
          changedFields: scoreInvalidationFields,
          route: 'generic_patch',
        }, tx)
        : { invalidatedEventIds: [], staleReason: null };

      // Lifecycle cooldown and the human transition event share this
      // transaction. That prevents an "entered Inbox" event when the company
      // cooldown immediately diverts the requested restore to Cooldown.
      if ((status === 'applied' || status === 'interviewing') && updated.company) {
        const threeWeeksFromNow = new Date();
        threeWeeksFromNow.setDate(threeWeeksFromNow.getDate() + 21);

        const cooldownCandidates = await tx.job.findMany({
          where: {
            company: { equals: updated.company, mode: 'insensitive' },
            status: 'inbox',
            id: { not: id },
          },
          select: { id: true, title: true, company: true },
        });
        const cooldownIds = cooldownCandidates
          .filter((candidate) => !isPromptHealthPriorityRole(candidate))
          .map((candidate) => candidate.id);
        if (cooldownIds.length > 0) {
          await tx.job.updateMany({
            where: { id: { in: cooldownIds } },
            data: { status: 'cooldown', cooldownUntil: threeWeeksFromNow },
          });
        }
      } else if (status === 'inbox' && updated.status === 'inbox' && updated.company && !isPromptHealthPriorityRole(updated)) {
        const activeApplication = await tx.job.findFirst({
          where: {
            company: { equals: updated.company, mode: 'insensitive' },
            status: { in: ['applied', 'interviewing'] },
            id: { not: id },
          },
        });
        if (activeApplication) {
          const threeWeeksFromNow = new Date();
          threeWeeksFromNow.setDate(threeWeeksFromNow.getDate() + 21);
          updated = await tx.job.update({
            where: { id },
            data: { status: 'cooldown', cooldownUntil: threeWeeksFromNow },
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
            route: 'generic_patch',
            reason: typeof passReason === 'string' ? passReason : null,
          },
        }, tx);
      }

      return { job: updated, invalidation };
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
    });
  } catch {
    return NextResponse.json({ error: 'Failed to update job' }, { status: 500 });
  }
}
