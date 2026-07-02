import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const usage = await prisma.usageTracking.findUnique({ where: { date: today } });
    
    if (!usage) {
      return NextResponse.json({
        inputTokens: 0,
        outputTokens: 0,
        cost: 0
      });
    }

    return NextResponse.json({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost: usage.cost
    });
  } catch (error) {
    console.error('Failed to fetch usage:', error);
    return NextResponse.json({ error: 'Failed to fetch usage' }, { status: 500 });
  }
}
