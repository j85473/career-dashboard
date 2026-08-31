import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';
import { getStoredScoringRun } from '@/lib/scoringRun';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const file = await getStoredScoringRun(prisma, id);
    return new Response(file.exportJson, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'X-Scoring-Export-SHA256': file.exportHash,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'run download failed' }, { status: 404 });
  }
}
