import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { contextDecisionAlreadyHandled } from '@/lib/contextFeedbackPolicy';
import { recordJobPipelineEvent } from '@/lib/ingestionControl';
import { humanLifecycleEvent } from '@/lib/jobLifecycleEvents';
import { suppressLiveAppliedDuplicates } from '@/lib/appliedDuplicateStore';
import { appliedIdentityFingerprint } from '@/lib/appliedDuplicateIdentity';
import { isAlreadyAppliedReason } from '@/lib/appliedDuplicatePolicy';
import { assertJobLifecycleInvariants } from '@/lib/jobLifecycleInvariant';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  const { reason } = body;
  
  if (typeof reason !== 'string' || !reason.trim()) {
    return NextResponse.json({ error: 'Reason is required' }, { status: 400 });
  }

  try {
    const mutation = await prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<Array<{
        status: string;
        title: string;
        company: string;
        location: string | null;
      }>>`
        SELECT status, title, company, location FROM "Job" WHERE id = ${id} FOR UPDATE;
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
          ...(isAlreadyAppliedReason(reason)
            ? { identityFingerprint: appliedIdentityFingerprint(current) }
            : {}),
        },
      });
      const suppressedDuplicateIds = await suppressLiveAppliedDuplicates(updated, tx);
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
            actor: lifecycleEvent.actor,
            protected: lifecycleEvent.protected,
            route: 'dedicated_pass',
            reason: reason.trim(),
          },
        }, tx);
      }
      await assertJobLifecycleInvariants(tx, [updated.id, ...suppressedDuplicateIds]);
      return { job: updated, suppressedDuplicateIds };
    });

    return NextResponse.json(mutation);
  } catch {
    return NextResponse.json({ error: 'Failed to pass job' }, { status: 500 });
  }
}
