import { NextResponse } from 'next/server';
import { identifyAts } from '@/lib/atsUtils';
import { validateStandardEvaluation } from '@/lib/deepseekSchemas';
import {
  parseContextProfileVersion,
  parseVersionedEntries,
  versionsMatch,
} from '@/lib/manualEvaluationBatch';
import { prisma } from '@/lib/prisma';
import { passesStandardScoring } from '@/lib/scoringPolicy';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeAts(modelAts: string | null, currentAts: string | null, detectedAts: string): string | null {
  if (currentAts && !['Unknown', 'Unknown ATS'].includes(currentAts)) return currentAts;
  if (detectedAts !== 'Unknown') return detectedAts;
  if (!modelAts) return currentAts;
  const invalid = ['dejobs', 'indeed', 'linkedin', 'glassdoor', 'ziprecruiter'];
  return invalid.some((name) => modelAts.toLowerCase().includes(name)) ? currentAts : modelAts;
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) {
      return NextResponse.json({ error: 'AI output must be a JSON object.' }, { status: 400 });
    }

    const submittedJobs = parseVersionedEntries(body, 'jobScores');
    const submittedContextJobs = parseVersionedEntries(body, 'processedContextJobs');
    const submittedContextProfileUpdatedAt = parseContextProfileVersion(body);
    const [candidateJobs, contextJobs, contextProfile] = await Promise.all([
      prisma.job.findMany({
        where: {
          id: { in: submittedJobs.ids },
          status: { in: ['inbox', 'pending_af'] },
          scoringStatus: 'scored',
          aimFitScore: null,
          afBatchId: null,
        },
        select: {
          id: true,
          status: true,
          manualAts: true,
          url: true,
          updatedAt: true,
        },
      }),
      prisma.job.findMany({
        where: {
          id: { in: submittedContextJobs.ids },
          status: { in: ['passed', 'applied'] },
          contextBatched: false,
        },
        select: { id: true, status: true, updatedAt: true },
      }),
      prisma.contextProfile.findUnique({
        where: { id: 'global' },
        select: { id: true, rulesText: true, updatedAt: true },
      }),
    ]);

    const currentContextProfileUpdatedAt = contextProfile?.updatedAt.toISOString() || null;
    if (!versionsMatch(candidateJobs, submittedJobs)
      || !versionsMatch(contextJobs, submittedContextJobs)
      || currentContextProfileUpdatedAt !== submittedContextProfileUpdatedAt) {
      return NextResponse.json({
        error: 'This offline evaluation batch is stale. Export a fresh batch before importing scores.',
      }, { status: 409 });
    }

    const jobs = candidateJobs;
    const allowedJobIds = new Set(submittedJobs.ids);
    const allowedContextIds = new Set(contextJobs.map((job) => job.id));
    const originalRules = contextProfile?.rulesText || '- No established context rules.';
    const validated = validateStandardEvaluation({
      ...body,
      processedContextJobIds: submittedContextJobs.ids,
    }, allowedJobIds, allowedContextIds, originalRules);
    const model = typeof body.model === 'string' ? body.model.slice(0, 200) : 'manual-import';
    const promptVersion = typeof body.promptVersion === 'string'
      ? body.promptVersion.slice(0, 200)
      : 'manual-import-v2';
    const requestId = typeof body.requestId === 'string' ? body.requestId.slice(0, 200) : null;

    let contextUpdated = false;
    let contextJobsProcessed = 0;
    const nextRules = validated.updatedContextRules || originalRules;
    if (validated.processedContextJobIds.length > 0) {
      const contextResult = await prisma.$transaction(async (tx) => {
        const profileStillCurrent = contextProfile
          ? await tx.contextProfile.count({
            where: { id: contextProfile.id, updatedAt: contextProfile.updatedAt },
          }) === 1
          : await tx.contextProfile.count({ where: { id: 'global' } }) === 0;
        if (!profileStillCurrent) return { changed: false, processed: 0 };

        const expectedJobs = contextJobs.filter((job) => validated.processedContextJobIds.includes(job.id));
        const stillCurrent = await tx.job.count({
          where: {
            contextBatched: false,
            OR: expectedJobs.map((job) => ({
              id: job.id,
              status: job.status,
              updatedAt: job.updatedAt,
            })),
          },
        });
        if (stillCurrent !== expectedJobs.length) return { changed: false, processed: 0 };

        let changed = false;
        if (nextRules.trim() !== originalRules.trim()) {
          if (contextProfile) {
            const updated = await tx.contextProfile.updateMany({
              where: { id: contextProfile.id, updatedAt: contextProfile.updatedAt },
              data: { rulesText: nextRules },
            });
            if (updated.count === 0) return { changed: false, processed: 0 };
          } else {
            await tx.contextProfile.create({ data: { id: 'global', rulesText: nextRules } });
          }
          await tx.contextRuleRevision.create({
            data: {
              contextProfileId: contextProfile?.id || 'global',
              previousRulesText: originalRules,
              newRulesText: nextRules,
              sourceJobIds: validated.processedContextJobIds,
              model,
              promptVersion,
              requestId,
            },
          });
          changed = true;
        }

        const processed = await tx.job.updateMany({
          where: {
            contextBatched: false,
            OR: expectedJobs.map((job) => ({
              id: job.id,
              status: job.status,
              updatedAt: job.updatedAt,
            })),
          },
          data: { contextBatched: true },
        });
        return { changed, processed: processed.count };
      });
      contextUpdated = contextResult.changed;
      contextJobsProcessed = contextResult.processed;
    }

    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    let scoresProcessed = 0;
    for (const score of validated.jobScores) {
      const job = jobsById.get(score.id);
      if (!job) continue;
      const passes = passesStandardScoring(score.aimFitScore, score.experienceFitScore);
      const manualAts = safeAts(score.atsSystem, job.manualAts, identifyAts(job));

      scoresProcessed += await prisma.$transaction(async (tx) => {
        const applied = await tx.job.updateMany({
          where: {
            id: job.id,
            updatedAt: job.updatedAt,
            status: { in: ['inbox', 'pending_af'] },
            scoringStatus: 'scored',
            aimFitScore: null,
            afBatchId: null,
          },
          data: {
            status: passes ? 'inbox' : 'dismissed',
            luckyStatus: passes ? 'none' : 'pending',
            aimFitScore: score.aimFitScore,
            passReason: score.aimFitReason,
            reqFitScore: score.experienceFitScore,
            reqFitRationale: score.experienceFitReason,
            travelScore: score.travelScore,
            scoringStatus: 'scored',
            experienceStatus: 'scored',
            scoreError: null,
            manualAts,
          },
        });
        if (applied.count === 1) {
          await tx.jobScoreEvent.create({
            data: {
              jobId: job.id,
              evaluationType: 'manual',
              model,
              promptVersion,
              requestId,
              aimFitScore: score.aimFitScore,
              experienceFitScore: score.experienceFitScore,
              travelScore: score.travelScore,
              domainMatch: score.domainMatch,
              requiredDomain: score.requiredDomain,
              candidateDomain: score.candidateDomain,
              requiredYearsInDomain: score.requiredYearsInDomain,
              candidateYearsInDomain: score.candidateYearsInDomain,
              passed: passes,
              aimReason: score.aimFitReason,
              experienceReason: score.experienceFitReason,
            },
          });
        }
        return applied.count;
      });
    }

    return NextResponse.json({
      message: 'Validated AI output imported successfully.',
      contextUpdated,
      contextJobsProcessed,
      scoresProcessed,
      omittedJobs: validated.omittedJobIds.length,
      rejectedEntries: validated.rejectedEntries,
      contextUpdateRejected: validated.contextUpdateRejected,
    });
  } catch (error) {
    console.error('Import AI Output failed:', error);
    return NextResponse.json({
      error: 'Failed to import AI output',
      details: error instanceof Error ? error.message : String(error),
    }, { status: 400 });
  }
}
