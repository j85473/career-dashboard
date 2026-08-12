import { NextResponse } from 'next/server';

import { extendScoringBatch } from '@/lib/scoringBatch';
import { prisma } from '@/lib/prisma';
import { readScoringMutationJson, scoringSecurityErrorResponse } from '@/lib/scoringRequestSecurity';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await readScoringMutationJson(request) as { expiresAt?: unknown };
    if (typeof body.expiresAt !== 'string') return NextResponse.json({ error: 'expiresAt is required' }, { status: 400 });
    const expiresAt = new Date(body.expiresAt);
    if (Number.isNaN(expiresAt.valueOf())) return NextResponse.json({ error: 'expiresAt is invalid' }, { status: 400 });
    return NextResponse.json(await extendScoringBatch(prisma, id, expiresAt));
  } catch (error) {
    const securityResponse = scoringSecurityErrorResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'batch extension failed' }, { status: 409 });
  }
}
