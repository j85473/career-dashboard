import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getAllResumes } from '@/lib/resume';
import { randomUUID } from 'node:crypto';
import { wildcardFeedbackForPrompt } from '@/lib/wildcardFeedback';

const ELIGIBLE_STATUSES = ['inbox', 'pending_af'];
const STANDARD_BATCH_SIZE = 300;
const WILDCARD_BATCH_SIZE = 100;

function compactText(value: string | null | undefined, maxLength: number): string {
  const text = (value || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (text.length <= maxLength) return text;

  const tailLength = Math.min(4_000, Math.floor(maxLength / 4));
  return `${text.slice(0, maxLength - tailLength)}\n\n[content shortened for token efficiency]\n\n${text.slice(-tailLength)}`;
}

export async function GET() {
  try {
    const resumes = await getAllResumes();
    const coreResume = resumes.find(r => r.name === 'Joseph_Lamb_Resume') || resumes[0];
    if (!coreResume) throw new Error('No resume found.');

    const contextProfile = await prisma.contextProfile.findUnique({
      where: { id: 'global' },
      select: { rulesText: true },
    });
    const contextRules = contextProfile?.rulesText || '- No established context rules.';

    const userPreferences = await prisma.userPreference.findMany({
      where: { NOT: { type: { startsWith: 'wildcard_' } } },
      take: 50,
      orderBy: { createdAt: 'desc' },
      select: { type: true, text: true },
    });

    const wildcardProfileEntity = await prisma.wildcardProfile.findFirst();
    const profileText = wildcardProfileEntity?.profileText || '- No wildcard profile has been established.';
    const promptProfile = wildcardFeedbackForPrompt(profileText);

    // Standard Jobs
    const standardCandidates = await prisma.job.findMany({
      where: {
        status: { in: ELIGIBLE_STATUSES },
        scoringStatus: 'scored',
        jdBatchId: null,
        batchJobId: null,
        afBatchId: null,
        aimFitScore: null,
      },
      take: STANDARD_BATCH_SIZE,
      orderBy: { updatedAt: 'asc' },
      select: { id: true },
    });

    const batchId = `manual_export_${randomUUID()}`;

    if (standardCandidates.length > 0) {
      await prisma.job.updateMany({
        where: {
          id: { in: standardCandidates.map(j => j.id) },
          status: { in: ELIGIBLE_STATUSES },
          scoringStatus: 'scored',
          jdBatchId: null,
          batchJobId: null,
          afBatchId: null,
          aimFitScore: null,
        },
        data: { afBatchId: batchId },
      });
    }

    const standardJobs = await prisma.job.findMany({
      where: { afBatchId: batchId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        title: true,
        company: true,
        location: true,
        description: true,
        updatedAt: true,
      },
    });

    // Wildcard Jobs
    const wildcardCandidates = await prisma.job.findMany({
      where: {
        status: { in: ['pending_af', 'inbox'] },
        luckyStatus: 'pending',
        scoringStatus: 'scored',
        jdBatchId: null,
        batchJobId: null,
        afBatchId: null,
        luckyBatchId: null,
      },
      take: WILDCARD_BATCH_SIZE,
      orderBy: { updatedAt: 'asc' },
      select: { id: true },
    });

    if (wildcardCandidates.length > 0) {
      await prisma.job.updateMany({
        where: {
          id: { in: wildcardCandidates.map(j => j.id) },
          status: { in: ['pending_af', 'inbox'] },
          luckyStatus: 'pending',
          scoringStatus: 'scored',
          jdBatchId: null,
          batchJobId: null,
          afBatchId: null,
          luckyBatchId: null,
        },
        data: { luckyBatchId: batchId, luckyStatus: 'scoring' },
      });
    }

    const wildcardJobs = await prisma.job.findMany({
      where: { luckyBatchId: batchId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        title: true,
        company: true,
        location: true,
        description: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      batchId,
      resume: compactText(coreResume.text, 50000),
      contextRules: compactText(contextRules, 12000),
      userPreferences: userPreferences.map(p => ({ type: p.type, text: compactText(p.text, 1000) })),
      wildcardProfile: compactText(promptProfile.baseProfileText, promptProfile.explicitFeedback ? 8000 : 12000),
      explicitWildcardFeedback: compactText(promptProfile.explicitFeedback, 4000),
      standardJobs: standardJobs.map(job => ({
        id: job.id,
        title: compactText(job.title, 500),
        company: compactText(job.company, 500),
        location: compactText(job.location, 500),
        description: compactText(job.description, 12000),
        submittedUpdatedAt: job.updatedAt.toISOString(),
      })),
      wildcardJobs: wildcardJobs.map(job => ({
        id: job.id,
        title: compactText(job.title, 500),
        company: compactText(job.company, 500),
        location: compactText(job.location, 500),
        description: compactText(job.description, 12000),
        submittedUpdatedAt: job.updatedAt.toISOString(),
      }))
    }, {
      headers: {
        'Content-Disposition': `attachment; filename="scoring_batch_${batchId}.json"`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error: unknown) {
    return NextResponse.json({ error: 'Failed to export', details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
