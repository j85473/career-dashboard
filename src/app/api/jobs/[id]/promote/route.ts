import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { recordJobPipelineEvent } from '@/lib/ingestionControl';
import { humanLifecycleEvent } from '@/lib/jobLifecycleEvents';
import { assertJobLifecycleInvariants } from '@/lib/jobLifecycleInvariant';
import { resolveInboxAdmission, recordAppliedRepostAdmission } from '@/lib/companyCooldown';


export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const payload = await request.json().catch(() => ({}));
    const reason = typeof payload.reason === 'string' && payload.reason.trim()
      ? payload.reason.trim()
      : 'Manually promoted by user';
    const resolvedParams = await params;

    const job = await prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<Array<{ status: string; title: string; location: string | null; company: string; source: string | null }>>`
        SELECT status, title, location, company, source FROM "Job" WHERE id = ${resolvedParams.id} FOR UPDATE;
      `;
      if (!current) throw new Error('Job not found');

      const admission = await resolveInboxAdmission({
        jobId: resolvedParams.id,
        title: current.title,
        location: current.location,
        company: current.company,
        source: current.source,
        proposedStatus: 'inbox',
        now: new Date(),
        store: tx,
      });

      const updated = await tx.job.update({
        where: { id: resolvedParams.id },
        data: {
          status: admission.status,
          cooldownUntil: admission.cooldownUntil,
          passReason: admission.passReason || `Promoted by user: ${reason}`,
          contextBatched: true,
          contextBatchId: null,
        }
      });
      const lifecycleEvent = humanLifecycleEvent(current.status, 'inbox', updated.status);
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
            route: 'dedicated_promote',
            reason,
          },
        }, tx);
      }
      await recordAppliedRepostAdmission({ jobId: updated.id, source: updated.source, admission }, tx);
      const affectedJobIds = [updated.id];
      await assertJobLifecycleInvariants(tx, affectedJobIds);
      return updated;
    });

    // We no longer send 'applied' actions to the Context Profile to prevent 
    // bridge roles from watering down the master archetype.
    
    return NextResponse.json({ job });
  } catch (error) {
    console.error("Error promoting job:", error);
    return NextResponse.json({ error: "Failed to promote job" }, { status: 500 });
  }
}
