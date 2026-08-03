import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recomputeLocalScore } from '@/lib/jobScoring';
import { statusAfterScoringInputEdit } from '@/lib/scoringState';
import { contextDecisionAlreadyHandled } from '@/lib/contextFeedbackPolicy';


export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const [job, scoreHistory] = await Promise.all([
    prisma.job.findUnique({ where: { id } }),
    prisma.jobScoreEvent.findMany({
      where: { jobId: id },
      orderBy: { createdAt: 'desc' },
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
        passed: true,
        createdAt: true,
      },
    }).catch(() => []),
  ]);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ job: { ...job, scoreHistory } });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  const { status, tailoringStaged, manualAts, url, canonicalUrl, description, recommendedResume, scoringStatus, experienceStatus, aimFitScore, passReason, reqFitScore, reqFitRationale, travelScore, title, company, location, skipRescore, luckyStatus } = body; 
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
  const scoringInputChanged = titleChanged || companyChanged || locationChanged || descriptionChanged || urlChanged;
  const shouldRescore = scoringInputChanged && skipRescore !== true;
  const manualAtsChanged = manualAts !== undefined && manualAts !== currentJob.manualAts;
  
  const data: Prisma.JobUpdateInput = {};
  const resetAiEvaluation = () => {
    data.aimFitScore = null;
    data.reqFitScore = null;
    data.reqFitRationale = null;
    data.travelScore = null;
    data.passReason = null;
    data.afBatchId = null;
    data.deepseekScoreAttempts = 0;
    data.deepseekScoreError = null;
    data.luckyBatchId = null;
    data.luckyAimFitScore = null;
    data.luckyFitScore = null;
    data.luckyFitCategory = 'unscored';
    data.luckyPassReason = null;
    data.luckyScoreAttempts = 0;
    data.luckyScoreError = null;
    data.luckyStatus = 'none';
  };
  if (status !== undefined) {
    data.status = status;
    if (status === 'applied') {
      data.tailoringStaged = false;
      data.luckyStatus = 'none';
      data.contextBatched = true;
      data.contextBatchId = null;
    } else if (status === 'passed' || status === 'dismissed') {
      data.tailoringStaged = false;
      data.luckyStatus = 'none';
      data.contextBatched = contextDecisionAlreadyHandled(status, passReason);
      data.contextBatchId = null;
    } else if (status === 'interviewing') {
      data.contextBatched = true;
      data.contextBatchId = null;
    } else if (status === 'expired' || status === 'archived') {
      data.tailoringStaged = false;
      data.luckyStatus = 'none';
      data.contextBatched = true;
      data.contextBatchId = null;
    } else {
      // Restoring, bookmarking, promoting, or otherwise moving away from an
      // intentional rejection invalidates any pending negative-context lease.
      data.contextBatched = true;
      data.contextBatchId = null;
    }
  }
  if (luckyStatus !== undefined) data.luckyStatus = luckyStatus;
  
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
  
  if (scoringStatus !== undefined && !skipRescore) data.scoringStatus = scoringStatus;
  if (experienceStatus !== undefined && !skipRescore) data.experienceStatus = experienceStatus;
  if (reqFitScore !== undefined && !skipRescore) data.reqFitScore = reqFitScore;
  if (reqFitRationale !== undefined && !skipRescore) data.reqFitRationale = reqFitRationale;
  if (aimFitScore !== undefined && !skipRescore) data.aimFitScore = aimFitScore;
  if (passReason !== undefined && !skipRescore) data.passReason = passReason;
  if (travelScore !== undefined) data.travelScore = travelScore;
  if (title !== undefined) data.title = title;
  if (company !== undefined) data.company = company;
  if (location !== undefined) data.location = location;
  if (manualAts !== undefined) {
    data.manualAts = manualAts;
  }
  if (url !== undefined) data.url = url;
  if (canonicalUrl !== undefined) data.canonicalUrl = canonicalUrl;
  if (description !== undefined) data.description = description;
  if (recommendedResume !== undefined) data.recommendedResume = recommendedResume;

  if (shouldRescore) {
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
    data.luckyBatchId = null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No valid update fields provided' }, { status: 400 });
  }

  try {
    let job = await prisma.job.update({
      where: { id },
      data
    });
    
    // Cooldown Logic
    if ((status === 'applied' || status === 'interviewing') && job.company) {
      const threeWeeksFromNow = new Date();
      threeWeeksFromNow.setDate(threeWeeksFromNow.getDate() + 21);
      
      // Update normal inbox jobs
      await prisma.job.updateMany({
        where: {
          company: { equals: job.company, mode: 'insensitive' },
          status: 'inbox',
          id: { not: id } // Don't cooldown the job we just applied to
        },
        data: {
          status: 'cooldown',
          cooldownUntil: threeWeeksFromNow
        }
      });
      
      // Update lucky inbox jobs
      await prisma.job.updateMany({
        where: {
          company: { equals: job.company, mode: 'insensitive' },
          luckyStatus: 'inbox',
          id: { not: id }
        },
        data: {
          luckyStatus: 'cooldown',
          cooldownUntil: threeWeeksFromNow
        }
      });
    } else if ((data.status === 'inbox' || data.luckyStatus === 'inbox') && job.company) {
      // If we are moving a job to the inbox, check if there is an existing application
      const activeApplication = await prisma.job.findFirst({
        where: {
          company: { equals: job.company, mode: 'insensitive' },
          status: { in: ['applied', 'interviewing'] },
          id: { not: id }
        }
      });

      if (activeApplication) {
        const threeWeeksFromNow = new Date();
        threeWeeksFromNow.setDate(threeWeeksFromNow.getDate() + 21);
        
        const cooldownData: Prisma.JobUpdateInput = { cooldownUntil: threeWeeksFromNow };
        if (data.status === 'inbox') cooldownData.status = 'cooldown';
        if (data.luckyStatus === 'inbox') cooldownData.luckyStatus = 'cooldown';

        job = await prisma.job.update({
          where: { id },
          data: cooldownData
        });
      }
    }

    // ATS choice affects only the deterministic heuristic. Preserve the
    // native A/E evaluation and the user's lifecycle decision.
    if (manualAtsChanged && !shouldRescore) {
      try {
        job = await recomputeLocalScore(id) || job;
      } catch (error) {
        console.error('Failed to recompute local ATS score:', error);
      }
    }

    // We no longer send 'applied' actions to the Context Profile to prevent 
    // bridge roles from watering down the master archetype.
    
    return NextResponse.json({ job, rescoreQueued: shouldRescore });
  } catch {
    return NextResponse.json({ error: 'Failed to update job' }, { status: 500 });
  }
}
