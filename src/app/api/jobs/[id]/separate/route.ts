import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { SameJobSeparateRefused, separateSameJob } from '@/lib/sameJobConsolidation';

/**
 * Joseph says a copy that was combined automatically is a different job. The
 * id is the combined copy's; it is restored and never combined with that card
 * again.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const result = await prisma.$transaction((tx) => separateSameJob(tx, id), { timeout: 15_000 });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SameJobSeparateRefused) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error('Failed to separate a combined copy:', error);
    return NextResponse.json({ error: 'The copy could not be separated.' }, { status: 500 });
  }
}
