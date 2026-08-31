import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { readScoringMutationJson, scoringSecurityErrorResponse } from '@/lib/scoringRequestSecurity';
import { releaseScoringRun } from '@/lib/scoringRun';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await readScoringMutationJson(request);
    const { id } = await context.params;
    return NextResponse.json(await releaseScoringRun(prisma, id));
  } catch (error) {
    const securityResponse = scoringSecurityErrorResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'run release failed' }, { status: 409 });
  }
}
