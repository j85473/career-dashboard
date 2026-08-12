import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { exportScoringBatch } from '@/lib/scoringExport';
import { reconcileScoringInputVersions } from '@/lib/scoringInputReconciliation';
import { readScoringMutationJson, scoringSecurityErrorResponse } from '@/lib/scoringRequestSecurity';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await readScoringMutationJson(request) as { stage?: unknown; limit?: unknown };
    if (body.stage !== 'aim' && body.stage !== 'experience') return NextResponse.json({ error: 'stage must be aim or experience' }, { status: 400 });
    const limit = body.limit === undefined ? 20 : Number(body.limit);
    await reconcileScoringInputVersions(prisma);
    const { file } = await exportScoringBatch(prisma, body.stage, limit);
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
    const message = error instanceof Error ? error.message : 'scoring export failed';
    return NextResponse.json({ error: message }, { status: /no .* Ready/i.test(message) ? 409 : 400 });
  }
}
