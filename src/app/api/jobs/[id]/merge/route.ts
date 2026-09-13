import { NextResponse } from 'next/server';

import { assertJobLifecycleInvariants } from '@/lib/jobLifecycleInvariant';
import { CardMergeRefused, mergeDuplicateCards } from '@/lib/jobUrlReconciliation';
import { prisma } from '@/lib/prisma';

/**
 * Folds this card into `intoJobId` after Joseph confirms they are the same job.
 * The target card keeps its status, scores and résumé.
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
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CardMergeRefused) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error('Failed to merge job cards:', error);
    return NextResponse.json({ error: 'The cards could not be merged.' }, { status: 500 });
  }
}
