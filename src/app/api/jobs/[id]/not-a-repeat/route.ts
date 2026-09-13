import { NextResponse } from 'next/server';

import { markNotARepeat, NotARepeatRefused } from '@/lib/appliedRepeatActions';
import { prisma } from '@/lib/prisma';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const job = await prisma.$transaction((tx) => markNotARepeat(tx, id));
    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof NotARepeatRefused) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error('Failed to restore a job marked not a repeat:', error);
    return NextResponse.json({ error: 'The job could not be restored.' }, { status: 500 });
  }
}
