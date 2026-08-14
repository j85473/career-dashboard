import { NextResponse } from 'next/server';

import { createAimFailureRetryBatch } from '@/lib/aimScoringFailure';
import { getStoredScoringExport } from '@/lib/scoringBatch';
import { buildAimFailureRetryBatchInput } from '@/lib/scoringExport';
import { prisma } from '@/lib/prisma';
import { readScoringMutationJson, scoringSecurityErrorResponse } from '@/lib/scoringRequestSecurity';
import { aimScoringV2ExportEnabled } from '@/lib/scoringRuntimeConfig';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = await readScoringMutationJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => key !== 'reason')
      || typeof (body as Record<string, unknown>).reason !== 'string') {
      return NextResponse.json({ error: 'body must contain only a string reason' }, { status: 400 });
    }
    if (!aimScoringV2ExportEnabled()) {
      return NextResponse.json({ error: 'aim v2 export is disabled' }, { status: 503 });
    }
    const { id } = await params;
    const batch = await createAimFailureRetryBatch(prisma, {
      failureReceiptId: id,
      operatorReason: (body as { reason: string }).reason,
      buildBatchInput: buildAimFailureRetryBatchInput,
    });
    const file = await getStoredScoringExport(prisma, batch.id);
    return new Response(file.exportJson, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'X-Scoring-Export-SHA256': file.exportHash,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const securityResponse = scoringSecurityErrorResponse(error);
    if (securityResponse) return securityResponse;
    const message = error instanceof Error ? error.message : 'Aim failure retry failed';
    const status = /no longer|already|nonterminal|lease/i.test(message) ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
