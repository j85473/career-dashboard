import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { contextDecisionAlreadyHandled } from '@/lib/contextFeedbackPolicy';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  const { reason } = body;
  
  if (typeof reason !== 'string' || !reason.trim()) {
    return NextResponse.json({ error: 'Reason is required' }, { status: 400 });
  }

  try {
    // 1. Mark job as passed
    const job = await prisma.job.update({
      where: { id },
      data: { 
        status: 'passed',
        passReason: reason,
        tailoringStaged: false,
        contextBatched: contextDecisionAlreadyHandled('passed', reason),
        contextBatchId: null,
      }
    });

    return NextResponse.json({ job });
  } catch {
    return NextResponse.json({ error: 'Failed to pass job' }, { status: 500 });
  }
}
