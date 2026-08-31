import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { exportScoringRun } from '@/lib/scoringExport';
import { readScoringMutationJson, scoringSecurityErrorResponse } from '@/lib/scoringRequestSecurity';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await readScoringMutationJson(request) as { stage?: unknown };
    if (body.stage !== 'aim' && body.stage !== 'experience') return NextResponse.json({ error: 'stage must be aim or experience' }, { status: 400 });
    const { file } = await exportScoringRun(prisma, body.stage);
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
    return NextResponse.json({ error: message }, {
      status: /no .* Ready|already has active scoring work/i.test(message) ? 409 : 400,
    });
  }
}
