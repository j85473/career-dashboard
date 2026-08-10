import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { contextDecisionAlreadyHandled } from '@/lib/contextFeedbackPolicy';
import { recordJobPipelineEvent } from '@/lib/ingestionControl';
import { humanLifecycleEvent } from '@/lib/jobLifecycleEvents';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  const { reason } = body;
  
  if (typeof reason !== 'string' || !reason.trim()) {
    return NextResponse.json({ error: 'Reason is required' }, { status: 400 });
  }

  try {
    const job = await prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM "Job" WHERE id = ${id} FOR UPDATE;
      `;
      if (!current) throw new Error('Job not found');
      const updated = await tx.job.update({
        where: { id },
        data: {
          status: 'passed',
          passReason: reason,
          tailoringStaged: false,
          contextBatched: contextDecisionAlreadyHandled('passed', reason),
          contextBatchId: null,
        },
      });
      const lifecycleEvent = humanLifecycleEvent(current.status, 'passed', updated.status);
      if (lifecycleEvent) {
        await recordJobPipelineEvent({
          eventType: lifecycleEvent.eventType,
          jobId: updated.id,
          stage: 'human_decision',
          source: updated.source,
          sourceId: updated.sourceId,
          occurredAt: updated.updatedAt,
          identityParts: ['status_transition', lifecycleEvent.priorStatus, lifecycleEvent.nextStatus, updated.updatedAt.toISOString()],
          details: {
            priorStatus: lifecycleEvent.priorStatus,
            nextStatus: lifecycleEvent.nextStatus,
            enteredInbox: lifecycleEvent.enteredInbox,
            route: 'dedicated_pass',
            reason: reason.trim(),
          },
        }, tx);
      }
      return updated;
    });

    return NextResponse.json({ job });
  } catch {
    return NextResponse.json({ error: 'Failed to pass job' }, { status: 500 });
  }
}
