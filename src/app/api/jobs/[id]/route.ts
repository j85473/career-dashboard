import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request, context: any) {
  const { id } = await context.params;
  const job = await prisma.job.findUnique({
    where: { id }
  });
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ job });
}

export async function PATCH(request: Request, context: any) {
  const { id } = await context.params;
  const body = await request.json();
  const { status, tailoringStaged, manualAts, url, description, recommendedResume, scoringStatus, experienceStatus, aimFitScore, passReason, reqFitScore, reqFitRationale, travelScore, title, company, location, skipRescore, luckyStatus } = body; 
  
  const data: any = {};
  if (status !== undefined) {
    data.status = status;
    if (status === 'applied') {
      data.tailoringStaged = false;
    }
  }
  if (luckyStatus !== undefined) data.luckyStatus = luckyStatus;
  if (tailoringStaged !== undefined) data.tailoringStaged = tailoringStaged;
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
    if (!skipRescore) {
      data.scoringStatus = 'scored';
      data.status = 'pending_af';
      data.scoreAttempts = 0;
    }
  }
  if (url !== undefined) data.url = url;
  if (description !== undefined) {
    data.description = description;
    
    const isTruncated = description.endsWith('...') || description.endsWith('…');
    
    if (!skipRescore) {
      data.scoringStatus = isTruncated ? 'needs_jd' : 'scored';
      data.status = 'pending_af';
      data.scoreAttempts = 0;
      
      // Auto-queue for Experience Scoring if it's a full JD
      if (!isTruncated) {
        data.experienceStatus = 'scored';
        data.batchJobId = null;
      }
    }
  }
  if (recommendedResume !== undefined) data.recommendedResume = recommendedResume;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No valid update fields provided' }, { status: 400 });
  }

  try {
    const job = await prisma.job.update({
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
          company: job.company,
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
          company: job.company,
          luckyStatus: 'inbox',
          id: { not: id }
        },
        data: {
          luckyStatus: 'cooldown',
          cooldownUntil: threeWeeksFromNow
        }
      });
    }

    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update job' }, { status: 500 });
  }
}
