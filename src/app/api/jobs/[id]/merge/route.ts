import { NextResponse } from 'next/server';

import { assertJobLifecycleInvariants } from '@/lib/jobLifecycleInvariant';
import {
  CardMergeRefused,
  mergeDuplicateCards,
  previewDuplicateCardMerge,
} from '@/lib/jobUrlReconciliation';
import { latestJobScoreEvents } from '@/lib/jobScoreAuthorityQuery';
import { prisma } from '@/lib/prisma';
import { projectJobScoreAuthority } from '@/lib/scoreAuthority';

/** Read-only review used by the focused two-card merge screen. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const withJobId = new URL(request.url).searchParams.get('withJobId') || '';
  if (!withJobId) return NextResponse.json({ error: 'withJobId is required' }, { status: 400 });
  try {
    const review = await prisma.$transaction((tx) => previewDuplicateCardMerge(tx, {
      firstId: id,
      secondId: withJobId,
      preferredId: id,
    }));
    return NextResponse.json(review);
  } catch (error) {
    if (error instanceof CardMergeRefused) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error('Failed to preview duplicate-card merge:', error);
    return NextResponse.json({ error: 'The merge review could not be loaded.' }, { status: 500 });
  }
}

/**
 * Consolidates two cards after Joseph confirms they are the same job. The
 * server recomputes the reviewed plan under lock so a stale browser cannot
 * force the wrong survivor or score result.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const intoJobId = typeof body.intoJobId === 'string' ? body.intoJobId : '';
  const route = body.route === 'paste_link' ? 'paste_link' : 'card_merge';
  if (!intoJobId) return NextResponse.json({ error: 'intoJobId is required' }, { status: 400 });
  try {
    const result = await prisma.$transaction(async (tx) => {
      const merged = await mergeDuplicateCards(tx, { redundantId: id, survivorId: intoJobId, route });
      await assertJobLifecycleInvariants(tx, [id, intoJobId]);
      return merged;
    });
    const latestScores = await latestJobScoreEvents([result.job.id]);
    return NextResponse.json({
      ...result,
      job: projectJobScoreAuthority(result.job, latestScores.get(result.job.id) || null),
    });
  } catch (error) {
    if (error instanceof CardMergeRefused) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error('Failed to merge job cards:', error);
    return NextResponse.json({ error: 'The cards could not be merged.' }, { status: 500 });
  }
}
