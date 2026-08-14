import { NextResponse } from 'next/server';

import { applyScoringImport, previewScoringImport } from '@/lib/scoringImport';
import { prisma } from '@/lib/prisma';
import { readScoringMutationJson, scoringSecurityErrorResponse } from '@/lib/scoringRequestSecurity';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await readScoringMutationJson(request) as { mode?: unknown; payload?: unknown; approvalToken?: unknown };
    if (body.mode !== 'preview' && body.mode !== 'apply') return NextResponse.json({ error: 'mode must be preview or apply' }, { status: 400 });
    if (!body.payload || typeof body.payload !== 'object') return NextResponse.json({ error: 'payload must be a scoring result object' }, { status: 400 });
    const payload = JSON.stringify(body.payload);
    if (body.mode === 'preview') {
      return NextResponse.json(await previewScoringImport(prisma, payload), { headers: { 'Cache-Control': 'no-store' } });
    }
    if (typeof body.approvalToken !== 'string' || !body.approvalToken) return NextResponse.json({ error: 'approvalToken is required for apply' }, { status: 400 });
    return NextResponse.json(await applyScoringImport(prisma, payload, body.approvalToken), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const securityResponse = scoringSecurityErrorResponse(error);
    if (securityResponse) return securityResponse;
    const message = error instanceof Error ? error.message : 'scoring import failed';
    return NextResponse.json({ error: message }, { status: /not found/.test(message) ? 404 : /expired|superseded|non-applicable|changed|replay/.test(message) ? 409 : 400 });
  }
}
