import 'dotenv/config';

import { Prisma } from '@prisma/client';

import {
  evaluateAuthoritativeGeography,
  hasAuthoritativeMetadata,
} from '../src/lib/authoritativeMetadataGate';
import { recordJobPipelineEvent } from '../src/lib/ingestionControl';
import { prisma } from '../src/lib/prisma';
import { AUTHORITATIVE_SCORE_EVENT_TYPES } from '../src/lib/scoreAuthority';

const HUMAN_LIFECYCLE_EVENTS = ['user_promote', 'user_reject', 'user_lifecycle'];
const STALE_REASON = 'policy-reconciliation:authoritative-geography';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const unknown = process.argv.slice(2).filter((argument) => argument !== '--apply');
  if (unknown.length > 0) throw new Error('Usage: reconcile_inbox_geography.ts [--apply]');

  const rows = await prisma.job.findMany({
    where: { status: 'inbox', tailoringStaged: false },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      url: true,
      source: true,
      sourceId: true,
      status: true,
      updatedAt: true,
      tailoringStaged: true,
      pipelineEvents: {
        where: { eventType: { in: HUMAN_LIFECYCLE_EVENTS } },
        take: 1,
        select: { id: true },
      },
      scoringBatchItems: {
        where: { status: 'leased' },
        take: 1,
        select: { id: true },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const candidates = rows.filter((job) => (
    hasAuthoritativeMetadata(job.source)
    && job.pipelineEvents.length === 0
    && job.scoringBatchItems.length === 0
    && !evaluateAuthoritativeGeography(job).passes
  ));

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — authoritative geography reconciliation`);
  console.log(`  machine-owned Inbox rows inspected: ${rows.length.toLocaleString()}`);
  console.log(`  out-of-scope rows:                  ${candidates.length.toLocaleString()}`);
  for (const job of candidates) {
    console.log(`  ${job.id}  ${job.company} — ${job.title}`);
    console.log(`    ${job.location || '(no stored location)'}`);
    console.log(`    ${evaluateAuthoritativeGeography(job).reason}`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to dismiss only these guarded machine-owned Inbox rows.');
    return;
  }

  let written = 0;
  let invalidatedEvents = 0;
  for (const candidate of candidates) {
    const result = await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Job" WHERE id = ${candidate.id} FOR UPDATE;
      `;
      if (!locked) return { written: 0, invalidated: 0 };

      const current = await tx.job.findUnique({
        where: { id: candidate.id },
        select: {
          id: true,
          title: true,
          location: true,
          url: true,
          source: true,
          sourceId: true,
          status: true,
          updatedAt: true,
          tailoringStaged: true,
          pipelineEvents: {
            where: { eventType: { in: HUMAN_LIFECYCLE_EVENTS } },
            take: 1,
            select: { id: true },
          },
          scoringBatchItems: {
            where: { status: 'leased' },
            take: 1,
            select: { id: true },
          },
        },
      });
      if (!current
        || current.status !== 'inbox'
        || current.updatedAt.valueOf() !== candidate.updatedAt.valueOf()
        || current.tailoringStaged
        || current.pipelineEvents.length > 0
        || current.scoringBatchItems.length > 0
        || !hasAuthoritativeMetadata(current.source)) {
        return { written: 0, invalidated: 0 };
      }

      const verdict = evaluateAuthoritativeGeography(current);
      if (verdict.passes) return { written: 0, invalidated: 0 };
      const staleAt = new Date();
      const staleEvents = await tx.jobScoreEvent.findMany({
        where: {
          jobId: current.id,
          evaluationType: { in: [...AUTHORITATIVE_SCORE_EVENT_TYPES] },
          staleAt: null,
        },
        select: { id: true },
      });
      if (staleEvents.length > 0) {
        const invalidated = await tx.jobScoreEvent.updateMany({
          where: { id: { in: staleEvents.map((event) => event.id) }, staleAt: null },
          data: { staleAt, staleReason: STALE_REASON },
        });
        if (invalidated.count !== staleEvents.length) {
          throw new Error(`A score changed during geography reconciliation for ${current.id}`);
        }
      }

      await tx.job.update({
        where: { id: current.id },
        data: {
          status: 'dismissed',
          scoringStatus: 'skipped',
          experienceStatus: 'queued',
          passReason: verdict.reason.slice(0, 1000),
          scoreError: null,
          aimFitScore: null,
          reqFitScore: null,
          reqFitRationale: null,
          travelScore: null,
          compensation: null,
        },
      });
      await recordJobPipelineEvent({
        eventType: 'prefilter_rejected',
        jobId: current.id,
        stage: 'policy_reconciliation',
        source: current.source,
        sourceId: current.sourceId,
        occurredAt: staleAt,
        identityParts: ['authoritative_geography_v2'],
        details: {
          route: 'reconcile_inbox_geography',
          reason: verdict.reason,
          staleReason: STALE_REASON,
          priorStatus: current.status,
          invalidatedScoreEventIds: staleEvents.map((event) => event.id),
        } as Prisma.InputJsonValue,
      }, tx);
      return { written: 1, invalidated: staleEvents.length };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    written += result.written;
    invalidatedEvents += result.invalidated;
  }

  console.log(`\nDismissed ${written.toLocaleString()} out-of-scope Inbox row(s).`);
  console.log(`Invalidated ${invalidatedEvents.toLocaleString()} authoritative score event(s).`);
  if (written !== candidates.length) {
    console.log(`Skipped ${(candidates.length - written).toLocaleString()} row(s) that changed or became protected.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(`Inbox geography reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
