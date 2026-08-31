import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { readScoringMutationJson, scoringSecurityErrorResponse } from '@/lib/scoringRequestSecurity';
import { extendScoringRun } from '@/lib/scoringRun';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await readScoringMutationJson(request) as { expiresAt?: unknown };
    if (typeof body.expiresAt !== 'string') return NextResponse.json({ error: 'expiresAt is required' }, { status: 400 });
    const expiresAt = new Date(body.expiresAt);
    if (Number.isNaN(expiresAt.valueOf())) return NextResponse.json({ error: 'expiresAt is invalid' }, { status: 400 });
    const { id } = await context.params;
    return NextResponse.json(await extendScoringRun(prisma, id, expiresAt));
  } catch (error) {
    const securityResponse = scoringSecurityErrorResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'run extension failed' }, { status: 409 });
  }
}
