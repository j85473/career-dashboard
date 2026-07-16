import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const usage = await prisma.usageTracking.findUnique({ where: { date: today } });

    const gemini = {
      inputTokens: usage?.inputTokens || 0,
      outputTokens: usage?.outputTokens || 0,
      cost: usage?.cost || 0,
    };

    return NextResponse.json({
      // Preserve the original top-level fields for existing dashboard consumers.
      ...gemini,
      gemini,
    });
  } catch (error) {
    console.error('Failed to fetch usage:', error);
    return NextResponse.json({ error: 'Failed to fetch usage' }, { status: 500 });
  }
}
