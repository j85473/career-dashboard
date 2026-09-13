import { NextResponse } from 'next/server';

import { listHiddenRepeats } from '@/lib/appliedRepeatActions';
import { prisma } from '@/lib/prisma';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return NextResponse.json({ repeats: await listHiddenRepeats(prisma, id) });
  } catch (error) {
    console.error('Failed to list hidden repeats:', error);
    return NextResponse.json({ error: 'Hidden repeats could not be loaded.' }, { status: 500 });
  }
}
