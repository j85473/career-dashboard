import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { retryFailedJob } from '@/lib/failedJobRecovery';
import { readScoringMutationJson, scoringSecurityErrorResponse } from '@/lib/scoringRequestSecurity';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = await readScoringMutationJson(request, 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !('stage' in body)
      || body.stage !== 'jd' && body.stage !== 'experience') {
      return NextResponse.json({ error: 'Choose JD or Experience recovery.' }, { status: 400 });
    }
    const { id } = await params;
    return NextResponse.json(await retryFailedJob(prisma, id, body.stage));
  } catch (error) {
    const security = scoringSecurityErrorResponse(error);
    if (security) return security;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failure recovery could not complete.' }, { status: 409 });
  }
}
