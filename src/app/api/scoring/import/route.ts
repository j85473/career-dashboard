import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { identifyAts } from '@/lib/atsUtils';
import { passesStandardScoring } from '@/lib/scoringPolicy';

function acceptedAts(modelAts: string | null, detectedAts: string): string | null {
  if (detectedAts !== 'Unknown') return detectedAts;
  if (!modelAts) return null;
  const invalid = ['dejobs', 'indeed', 'linkedin', 'glassdoor', 'ziprecruiter'];
  if (invalid.some((name) => modelAts.toLowerCase().includes(name))) return null;
  return modelAts.slice(0, 100);
}

// Helper to process arrays in parallel chunks
async function processInChunks<T>(items: T[], chunkSize: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    await Promise.all(chunk.map(fn));
  }
}

export async function POST(req: Request) {
  try {
    const payload = await req.json();
    const { batchId, standardScores = [], wildcardScores = [], updatedContextRules } = payload;

    if (!batchId) {
      return NextResponse.json({ error: 'batchId is required' }, { status: 400 });
    }

    let standardProcessed = 0;
    let wildcardProcessed = 0;
    let standardInboxAdded = 0;
    let wildcardPendingAdded = 0;
    let wildcardInboxAdded = 0;

    // 1. Process Standard Scores
    if (standardScores.length > 0) {
      const standardIds = standardScores.map((s: { id: string }) => s.id).filter(Boolean);
      const existingJobs = await prisma.job.findMany({
        where: { id: { in: standardIds } },
      });
      const jobMap = new Map(existingJobs.map((j) => [j.id, j]));

      await processInChunks(standardScores, 20, async (score: any) => {
        const job = jobMap.get(score.id);
        if (!job) return;

        const passes = passesStandardScoring(score.aimFitScore, score.experienceFitScore) && score.experienceFitScore >= 85;
        const detectedAts = identifyAts(job);
        const manualAts = acceptedAts(score.atsSystem, detectedAts) || job.manualAts;

        const newStatus = passes || job.source === 'Manual Import' ? 'inbox' : 'dismissed';
        const newLuckyStatus = score.experienceFitScore >= 85 ? 'pending' : 'none';

        if (newStatus === 'inbox') standardInboxAdded++;
        if (newLuckyStatus === 'pending') wildcardPendingAdded++;

        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: newStatus,
            luckyStatus: newLuckyStatus,
            aimFitScore: score.aimFitScore,
            passReason: score.aimFitReason,
            reqFitScore: score.experienceFitScore,
            reqFitRationale: score.experienceFitReason,
            travelScore: score.travelScore,
            afBatchId: null,
            scoringStatus: 'scored',
            experienceStatus: 'scored',
            scoreError: null,
            deepseekScoreError: null,
            manualAts,
            compensation: score.compensation,
          },
        });

        await prisma.jobScoreEvent.create({
          data: {
            jobId: job.id,
            evaluationType: 'standard',
            model: score.model || 'manual-agent-import',
            promptVersion: 'manual-import-v1',
            requestId: batchId,
            aimFitScore: score.aimFitScore,
            experienceFitScore: score.experienceFitScore,
            travelScore: score.travelScore,
            domainMatch: score.domainMatch ?? true,
            requiredDomain: score.requiredDomain ?? null,
            candidateDomain: score.candidateDomain ?? null,
            requiredYearsInDomain: score.requiredYearsInDomain ?? null,
            candidateYearsInDomain: score.candidateYearsInDomain ?? null,
            passed: passes,
            aimReason: score.aimFitReason,
            experienceReason: score.experienceFitReason,
          },
        });

        standardProcessed++;
      });
    }

    // 2. Process Wildcard Scores
    if (wildcardScores.length > 0) {
      const wildcardIds = wildcardScores.map((w: { id: string }) => w.id).filter(Boolean);
      const existingJobs = await prisma.job.findMany({
        where: { id: { in: wildcardIds } },
      });
      const jobMap = new Map(existingJobs.map((j) => [j.id, j]));

      await processInChunks(wildcardScores, 20, async (score: any) => {
        const job = jobMap.get(score.id);
        if (!job) return;

        const passes = score.vibeFitScore >= 85;

        const newLuckyStatus = passes ? 'inbox' : 'dismissed';
        if (newLuckyStatus === 'inbox') wildcardInboxAdded++;

        await prisma.job.update({
          where: { id: job.id },
          data: {
            luckyStatus: newLuckyStatus,
            luckyBatchId: null,
            luckyAimFitScore: score.vibeFitScore,
            luckyPassReason: passes
              ? `Vibe Fit: ${score.vibeFitReason}`
              : `[Wildcard Reject] Vibe Fit: ${score.vibeFitReason}`,
            luckyScoreError: null,
            compensation: score.compensation,
          },
        });

        await prisma.jobScoreEvent.create({
          data: {
            jobId: job.id,
            evaluationType: 'wildcard',
            model: score.model || 'manual-agent-import',
            promptVersion: 'manual-import-v1',
            requestId: batchId,
            aimFitScore: score.vibeFitScore,
            passed: passes,
            aimReason: score.vibeFitReason,
          },
        });

        wildcardProcessed++;
      });
    }

    // 3. Update Context Rules if provided
    let contextUpdated = false;
    if (updatedContextRules && updatedContextRules.trim() !== '') {
      const contextProfile = await prisma.contextProfile.findUnique({ where: { id: 'global' } });
      if (contextProfile && contextProfile.rulesText !== updatedContextRules) {
        await prisma.contextProfile.update({
          where: { id: 'global' },
          data: { rulesText: updatedContextRules },
        });
        contextUpdated = true;
      }
    }

    // 4. Release any remaining leases from this batch
    const releasedAf = await prisma.job.updateMany({
      where: { afBatchId: batchId },
      data: { afBatchId: null },
    });

    const releasedLucky = await prisma.job.updateMany({
      where: { luckyBatchId: batchId },
      data: { luckyBatchId: null, luckyStatus: 'pending' },
    });

    if (standardProcessed === 0 && wildcardProcessed === 0) {
      return NextResponse.json({ error: 'No matching jobs were found in the database to update.' }, { status: 400 });
    }

    return NextResponse.json({
      message: 'Import successful',
      standardProcessed,
      wildcardProcessed,
      standardInboxAdded,
      wildcardPendingAdded,
      wildcardInboxAdded,
      contextUpdated,
      omittedAndReleased: releasedAf.count + releasedLucky.count,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: 'Failed to import scores', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
