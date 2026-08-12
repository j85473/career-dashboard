import { NextResponse } from 'next/server';

import { releaseScoringBatch } from '@/lib/scoringBatch';
import { prisma } from '@/lib/prisma';
import { readScoringMutationJson, scoringSecurityErrorResponse } from '@/lib/scoringRequestSecurity';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await readScoringMutationJson(request);
    const { id } = await context.params;
    return NextResponse.json(await releaseScoringBatch(prisma, id));
  } catch (error) {
    const securityResponse = scoringSecurityErrorResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'batch release failed' }, { status: 409 });
  }
}
