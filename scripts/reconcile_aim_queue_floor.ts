import 'dotenv/config';

import { Prisma } from '@prisma/client';

import { recordJobPipelineEvent } from '../src/lib/ingestionControl';
import { assessJobInfoLanguage } from '../src/lib/jobLanguage';
import { prisma } from '../src/lib/prisma';
import { AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE } from '../src/lib/scoringImport';

/**
 * Retroactively applies Experience-queue hygiene to rows already sitting at
 * `pending_af` from before the relevant check existed. Two independent
 * conditions, either one is sufficient to dismiss:
 *
 *  - below the Aim -> Experience floor (`AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE`,
 *    src/lib/scoringImport.ts): the `scored_survivor` Aim score doesn't
 *    justify spending an Experience Fit run on it.
 *  - affirmatively non-English (`assessJobInfoLanguage`,
 *    src/lib/jobLanguage.ts): the same check `passesPreFilter` already
 *    applies at ingestion, re-run here because a language-profile gap can let
 *    a foreign posting through before the gap is closed. Real case: a Finnish
 *    posting (job e4045272) scored by Aim before a Finnish profile existed.
 *
 * Only touches rows a fresh import/ingest would already reject: still at
 * `pending_af`, not staged for tailoring, no human lifecycle decision, no
 * leased manual-scoring item. Nothing about the Aim judgment or its
 * JobScoreEvent is touched — this is a later, Dashboard-owned decision about
 * queue membership, not a correction to Aim's own scoring. Dry run by
 * default; pass --apply to write the guarded set.
 */

const HUMAN_LIFECYCLE_EVENTS = ['user_promote', 'user_reject', 'user_lifecycle'];
const STAGE = 'policy_reconciliation';

type Reason = 'below_score_floor' | 'non_english';

type Row = {
  id: string;
  title: string;
  company: string;
  description: string | null;
  aimFitScore: number | null;
  source: string;
  sourceId: string | null;
  status: string;
  updatedAt: Date;
  tailoringStaged: boolean;
  pipelineEvents: { id: string }[];
  scoringBatchItems: { id: string }[];
};

function matchedReasons(row: Pick<Row, 'title' | 'description' | 'aimFitScore'>): Reason[] {
  const reasons: Reason[] = [];
  if (row.aimFitScore !== null && row.aimFitScore < AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE) {
    reasons.push('below_score_floor');
  }
  if (assessJobInfoLanguage({ title: row.title, description: row.description }).isAffirmativelyNonEnglish) {
    reasons.push('non_english');
  }
  return reasons;
}

function describeReasons(reasons: Reason[], aimFitScore: number | null): string {
  return reasons.map((reason) => (
    reason === 'below_score_floor'
      ? `Aim Fit score ${aimFitScore} is below the ${AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE}-point Experience-queue floor`
      : 'Available job information is not in English'
  )).join('; ');
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const unknown = process.argv.slice(2).filter((argument) => argument !== '--apply');
  if (unknown.length > 0) throw new Error('Usage: reconcile_aim_queue_floor.ts [--apply]');

  const rows = await prisma.job.findMany({
    where: {
      status: 'pending_af',
      tailoringStaged: false,
      aimFitScore: { not: null },
    },
    select: {
      id: true,
      title: true,
      company: true,
      description: true,
      aimFitScore: true,
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
  }) as Row[];

  const matched = rows
    .map((row) => ({ row, reasons: matchedReasons(row) }))
    .filter(({ reasons }) => reasons.length > 0);
  const candidates = matched.filter(({ row }) => row.pipelineEvents.length === 0 && row.scoringBatchItems.length === 0);
  const withheld = matched.filter(({ row }) => row.pipelineEvents.length > 0 || row.scoringBatchItems.length > 0);

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — Experience-queue hygiene reconciliation (floor: ${AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE})`);
  console.log(`  pending_af rows scanned:     ${rows.length.toLocaleString()}`);
  console.log(`  matching at least one rule:  ${matched.length.toLocaleString()}`);
  console.log(`  eligible to dismiss:         ${candidates.length.toLocaleString()}`);
  console.log(`  withheld (human decision or leased): ${withheld.length.toLocaleString()}`);
  for (const { row, reasons } of candidates) {
    console.log(`  ${row.id}  [${reasons.join(',')}]  score ${row.aimFitScore}  ${row.company} — ${row.title}`);
  }
  for (const { row, reasons } of withheld) {
    console.log(`  WITHHELD ${row.id}  [${reasons.join(',')}]  score ${row.aimFitScore}  ${row.company} — ${row.title}`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to dismiss only these guarded rows.');
    return;
  }

  if (candidates.length === 0) {
    console.log('\nNothing to dismiss.');
    return;
  }

  let written = 0;
  let failed = 0;
  for (const { row: candidate } of candidates) {
    let result: number;
    try {
      result = await prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Job" WHERE id = ${candidate.id} FOR UPDATE;
        `;
        if (!locked) return 0;

        const current = await tx.job.findUnique({
          where: { id: candidate.id },
          select: {
            status: true,
            tailoringStaged: true,
            title: true,
            description: true,
            aimFitScore: true,
            updatedAt: true,
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
          || current.status !== 'pending_af'
          || current.updatedAt.valueOf() !== candidate.updatedAt.valueOf()
          || current.tailoringStaged
          || current.pipelineEvents.length > 0
          || current.scoringBatchItems.length > 0) {
          return 0;
        }
        // Recompute fresh rather than trusting the earlier read — a manual
        // rescrape could have changed the description in between.
        const reasons = matchedReasons(current);
        if (reasons.length === 0) return 0;

        await tx.job.update({ where: { id: candidate.id }, data: { status: 'dismissed' } });
        await recordJobPipelineEvent({
          eventType: 'prefilter_rejected',
          jobId: candidate.id,
          stage: STAGE,
          source: candidate.source,
          sourceId: candidate.sourceId,
          occurredAt: new Date(),
          identityParts: ['aim_experience_queue_hygiene_v1'],
          details: {
            route: 'reconcile_aim_queue_floor',
            reason: describeReasons(reasons, current.aimFitScore),
            reasons,
            aimFitScore: current.aimFitScore,
            floor: AIM_EXPERIENCE_QUEUE_MINIMUM_SCORE,
            priorStatus: current.status,
          } as Prisma.InputJsonValue,
        }, tx);
        return 1;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
    } catch (error: unknown) {
      // One slow or lock-contended row must not abort the whole guarded set —
      // each row already committed independently, so the remaining
      // candidates are still worth attempting. Reported, not silently eaten.
      console.error(`  FAILED ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
      failed += 1;
      continue;
    }
    written += result;
  }

  console.log(`\nDismissed ${written.toLocaleString()} row(s) failing Experience-queue hygiene.`);
  const untouched = candidates.length - written - failed;
  if (failed > 0) console.log(`${failed.toLocaleString()} row(s) failed with a transaction error — re-run to retry them.`);
  if (untouched > 0) console.log(`Skipped ${untouched.toLocaleString()} row(s) that changed or became protected during the run.`);
}

main()
  .catch((error: unknown) => {
    console.error(`Experience-queue hygiene reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
