import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function PATCH(request: Request, context: any) {
  const { id } = await context.params;
  const body = await request.json();
  const { status, tailoringStaged, manualAts, url, description, recommendedResume, scoringStatus, experienceStatus, reqFitScore, reqFitRationale, travelScore, title, company, location } = body; 
  
  const data: any = {};
  if (status !== undefined) {
    data.status = status;
    if (status === 'applied') {
      data.tailoringStaged = false;
    }
  }
  if (tailoringStaged !== undefined) data.tailoringStaged = tailoringStaged;
  if (scoringStatus !== undefined) data.scoringStatus = scoringStatus;
  if (experienceStatus !== undefined) data.experienceStatus = experienceStatus;
  if (reqFitScore !== undefined) data.reqFitScore = reqFitScore;
  if (reqFitRationale !== undefined) data.reqFitRationale = reqFitRationale;
  if (travelScore !== undefined) data.travelScore = travelScore;
  if (title !== undefined) data.title = title;
  if (company !== undefined) data.company = company;
  if (location !== undefined) data.location = location;
  if (manualAts !== undefined) {
    data.manualAts = manualAts;
    data.scoringStatus = 'queued';
    data.scoreAttempts = 0;
  }
  if (url !== undefined) data.url = url;
  if (description !== undefined) {
    data.description = description;
    
    const isTruncated = description.endsWith('...') || description.endsWith('…');
    
    data.scoringStatus = isTruncated ? 'needs_jd' : 'queued';
    data.scoreAttempts = 0;
    
    // Auto-queue for Experience Scoring if it's a full JD
    if (!isTruncated) {
      data.experienceStatus = 'queued';
      data.batchJobId = null;
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
    
    // Auto trigger removed as background processor handles it



    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update job' }, { status: 500 });
  }
}
