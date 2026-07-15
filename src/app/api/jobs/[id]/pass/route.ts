import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { applyWildcardDecision, WildcardDecisionError } from '@/lib/wildcardDecision';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  const { reason, scope } = body;
  
  if (typeof reason !== 'string' || !reason.trim()) {
    return NextResponse.json({ error: 'Reason is required' }, { status: 400 });
  }

  try {
    if (scope === 'wildcard') {
      const job = await prisma.$transaction((tx) => applyWildcardDecision(tx, id, 'pass', reason));
      return NextResponse.json({ job });
    }

    // 1. Mark job as passed
    const job = await prisma.job.update({
      where: { id },
      data: { 
        status: 'passed',
        passReason: reason,
        luckyStatus: 'none',
        contextBatched: false,
      }
    });



    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof WildcardDecisionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Failed to pass job' }, { status: 500 });
  }
}
