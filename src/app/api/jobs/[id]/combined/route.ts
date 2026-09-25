import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { listCombinedCopies } from '@/lib/sameJobConsolidation';

/** Copies of this job from other sources that were combined into this card. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return NextResponse.json({ copies: await listCombinedCopies(prisma, id) });
  } catch (error) {
    console.error('Failed to list combined copies:', error);
    return NextResponse.json({ error: 'Combined copies could not be loaded.' }, { status: 500 });
  }
}
