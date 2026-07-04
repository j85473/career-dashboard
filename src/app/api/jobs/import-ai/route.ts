import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { updatedContextRules, processedContextJobIds, jobScores } = body;

    let contextUpdated = false;
    let contextJobsProcessed = 0;
    let scoresProcessed = 0;

    // 1. Update Context DB
    if (updatedContextRules && typeof updatedContextRules === 'string') {
      const existing = await prisma.contextProfile.findFirst();
      if (existing) {
        await prisma.contextProfile.update({
          where: { id: existing.id },
          data: { rulesText: updatedContextRules }
        });
      } else {
        await prisma.contextProfile.create({
          data: { rulesText: updatedContextRules }
        });
      }
      contextUpdated = true;
    }

    // 2. Mark Context Jobs as processed
    if (Array.isArray(processedContextJobIds) && processedContextJobIds.length > 0) {
      const res = await prisma.job.updateMany({
        where: { id: { in: processedContextJobIds } },
        data: { contextBatched: true }
      });
      contextJobsProcessed = res.count;
    }

    // 3. Process Job Scores
    if (Array.isArray(jobScores) && jobScores.length > 0) {
      for (const scoreData of jobScores) {
        const jobId = scoreData.id;
        if (!jobId) continue;

        const aimFitScore = Math.round(Number(scoreData.aimFitScore)) || 0;
        const aimFitReason = scoreData.aimFitReason || '';
        const experienceFitScore = Math.round(Number(scoreData.experienceFitScore)) || 0;
        const experienceFitReason = scoreData.experienceFitReason || '';
        const travelScore = Math.round(Number(scoreData.travelScore)) || 0;
        const atsSystem = scoreData.atsSystem;
        
        const passes = aimFitScore >= 7 && experienceFitScore >= 50;

        const currentJob = await prisma.job.findUnique({
          where: { id: jobId },
          select: { status: true, manualAts: true }
        });
        
        if (currentJob) {
          const shouldUpdateStatus = currentJob.status === 'pending_af';
          let manualAts = currentJob.manualAts;
          if (atsSystem && (!manualAts || manualAts === 'Unknown' || manualAts === 'Unknown ATS')) {
            manualAts = atsSystem;
          }
          
          if (passes) {
            await prisma.job.update({
              where: { id: jobId },
              data: {
                ...(shouldUpdateStatus ? { status: 'inbox' } : {}),
                aimFitScore: aimFitScore,
                passReason: aimFitReason,
                reqFitScore: experienceFitScore,
                reqFitRationale: experienceFitReason,
                travelScore: travelScore,
                afBatchId: null,
                scoringStatus: 'scored',
                experienceStatus: 'scored',
                manualAts
              }
            });
          } else {
            await prisma.job.update({
              where: { id: jobId },
              data: {
                ...(shouldUpdateStatus ? { status: 'dismissed' } : {}),
                fitCategory: 'rejected',
                aimFitScore: aimFitScore,
                passReason: aimFitReason,
                reqFitScore: experienceFitScore,
                reqFitRationale: experienceFitReason,
                travelScore: travelScore,
                afBatchId: null,
                scoringStatus: 'scored',
                experienceStatus: 'scored',
                manualAts
              }
            });
          }
          scoresProcessed++;
        }
      }
    }

    return NextResponse.json({ 
      message: 'AI output imported successfully',
      contextUpdated,
      contextJobsProcessed,
      scoresProcessed
    });
  } catch (error: any) {
    console.error('Import AI Output failed:', error);
    return NextResponse.json({ error: 'Failed to import AI output', details: error.message }, { status: 500 });
  }
}
