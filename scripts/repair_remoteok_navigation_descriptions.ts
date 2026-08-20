import 'dotenv/config';

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prisma } from '../src/lib/prisma';
import { looksLikeRemoteOkNavigationChrome } from '../src/lib/jobDescriptionQuality';
import { recordJobPipelineEvent } from '../src/lib/ingestionControl';
import { withPostingFacts } from '../src/lib/postingFacts';

/**
 * Removes RemoteOK page-navigation captures from stored job descriptions.
 *
 * The affected rows contain the complete RemoteOK navigation shell ("Join
 * Remote OK", "Frontpage", "Dark mode", and related controls) instead of an
 * employer JD. A source-specific gate now prevents new captures; this script
 * repairs the historical rows without deleting their source observations.
 *
 * Active rows are dismissed because the provider record has no trustworthy JD
 * and repeated recovery only retrieves the same page shell. Existing dismissed
 * or archived lifecycle decisions are preserved. Local heuristic projections
 * derived from the polluted text are cleared. Any row with a human decision,
 * tailoring state, manual Aim/Experience score, or active lease is protected
 * and causes apply mode to stop before writing.
 *
 * Dry run by default. `--apply` creates a private JSON backup in the system temp
 * directory before changing anything, then applies concurrency-guarded writes.
 */

const ACTIVE_STATUSES = new Set(['pending_af', 'inbox']);
const REMOTE_OK_NAVIGATION_DISCARD_REASON =
  'RemoteOK page navigation was stored instead of a job description; source record discarded.';

type Candidate = Awaited<ReturnType<typeof loadCandidates>>[number];

function parseArguments(argv: string[]): { apply: boolean } {
  for (const argument of argv) {
    if (argument !== '--apply') {
      throw new Error('Usage: repair_remoteok_navigation_descriptions.ts [--apply]');
    }
  }
  return { apply: argv.includes('--apply') };
}

async function loadCandidates() {
  const possible = await prisma.job.findMany({
    where: {
      source: 'RemoteOK',
      description: { contains: 'Join Remote OK', mode: 'insensitive' },
    },
    select: {
      id: true,
      title: true,
      company: true,
      source: true,
      sourceId: true,
      status: true,
      scoringStatus: true,
      scoreAttempts: true,
      scoreError: true,
      passReason: true,
      description: true,
      fitScore: true,
      fitCategory: true,
      fitRationale: true,
      recommendedResume: true,
      aimFitScore: true,
      reqFitScore: true,
      tailoringStaged: true,
      batchJobId: true,
      afBatchId: true,
      jdBatchId: true,
      createdAt: true,
      updatedAt: true,
      pipelineEvents: {
        where: { eventType: { in: ['user_promote', 'user_reject', 'user_lifecycle'] } },
        select: { id: true },
        take: 1,
      },
      scoringBatchItems: {
        where: { status: 'leased' },
        select: { id: true },
        take: 1,
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  return possible.filter((job) => looksLikeRemoteOkNavigationChrome(job.description));
}

function protectionReason(job: Candidate): string | null {
  if (job.pipelineEvents.length > 0) return 'human lifecycle decision';
  if (job.tailoringStaged) return 'tailoring staged';
  if (job.aimFitScore != null || job.reqFitScore != null) return 'manual Aim/Experience score';
  if (job.scoringStatus === 'scoring'
    || job.batchJobId != null
    || job.afBatchId != null
    || job.jdBatchId != null
    || job.scoringBatchItems.length > 0) {
    return 'active scoring or extraction lease';
  }
  return null;
}

function descriptionHash(description: string): string {
  return createHash('sha256').update(description).digest('hex');
}

async function createBackup(candidates: Candidate[]): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(tmpdir(), `career-dashboard-remoteok-navigation-backup-${timestamp}.json`);
  await writeFile(path, `${JSON.stringify({ createdAt: new Date().toISOString(), candidates }, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return path;
}

async function main(): Promise<void> {
  const { apply } = parseArguments(process.argv.slice(2));
  const candidates = await loadCandidates();
  const protectedRows = candidates
    .map((job) => ({ job, reason: protectionReason(job) }))
    .filter((entry): entry is { job: Candidate; reason: string } => entry.reason !== null);
  const active = candidates.filter((job) => ACTIVE_STATUSES.has(job.status));
  const scoredLocally = candidates.filter((job) => job.fitScore != null);
  const characters = candidates.reduce((sum, job) => sum + (job.description?.length || 0), 0);

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — RemoteOK navigation-description cleanup`);
  console.log(`  contaminated rows:       ${candidates.length.toLocaleString()}`);
  console.log(`  stored chrome characters:${String(characters.toLocaleString()).padStart(11)}`);
  console.log(`  active rows to dismiss:  ${active.length.toLocaleString()}`);
  console.log(`  local scores to clear:   ${scoredLocally.length.toLocaleString()}`);
  console.log(`  protected rows:          ${protectedRows.length.toLocaleString()}`);

  for (const { job, reason } of protectedRows) {
    console.log(`    protected ${job.id} ${job.company} / ${job.title}: ${reason}`);
  }
  for (const job of active) {
    console.log(`    active ${job.id} ${job.company} / ${job.title}: ${job.scoringStatus}`);
  }

  if (!apply || candidates.length === 0) {
    console.log(apply ? '\nNothing to write.' : '\nDry run. Re-run with --apply to back up and clean these rows.');
    return;
  }
  if (protectedRows.length > 0) {
    throw new Error('Protected rows exist; apply stopped before any write');
  }

  const backupPath = await createBackup(candidates);
  console.log(`\nPrivate pre-cleanup backup: ${backupPath}`);

  let cleaned = 0;
  let dismissed = 0;
  for (const candidate of candidates) {
    const outcome = await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Job" WHERE id = ${candidate.id} FOR UPDATE;
      `;
      if (!locked) return { cleaned: 0, dismissed: 0 };

      const current = await tx.job.findUnique({
        where: { id: candidate.id },
        select: {
          id: true,
          source: true,
          sourceId: true,
          status: true,
          scoringStatus: true,
          description: true,
          aimFitScore: true,
          reqFitScore: true,
          tailoringStaged: true,
          batchJobId: true,
          afBatchId: true,
          jdBatchId: true,
          updatedAt: true,
          pipelineEvents: {
            where: { eventType: { in: ['user_promote', 'user_reject', 'user_lifecycle'] } },
            select: { id: true },
            take: 1,
          },
          scoringBatchItems: {
            where: { status: 'leased' },
            select: { id: true },
            take: 1,
          },
        },
      });
      if (!current
        || current.source !== 'RemoteOK'
        || current.updatedAt.valueOf() !== candidate.updatedAt.valueOf()
        || !current.description
        || !looksLikeRemoteOkNavigationChrome(current.description)) {
        throw new Error(`Candidate changed during cleanup: ${candidate.id}`);
      }
      if (protectionReason({ ...candidate, ...current } as Candidate)) {
        throw new Error(`Candidate became protected during cleanup: ${candidate.id}`);
      }

      const wasActive = ACTIVE_STATUSES.has(current.status);
      const hash = descriptionHash(current.description);
      const occurredAt = new Date();
      await tx.job.update({
        where: { id: current.id },
        data: withPostingFacts(null, {
          status: wasActive ? 'dismissed' : current.status,
          scoringStatus: 'skipped',
          scoreAttempts: 0,
          scoreError: null,
          passReason: wasActive ? REMOTE_OK_NAVIGATION_DISCARD_REASON : candidate.passReason,
          batchJobId: null,
          afBatchId: null,
          jdBatchId: null,
          fitScore: null,
          fitCategory: 'unscored',
          fitRationale: null,
          recommendedResume: null,
          compensation: null,
          travelScore: null,
        }),
      });
      await recordJobPipelineEvent({
        eventType: 'jd_failed',
        jobId: current.id,
        stage: 'jd',
        source: current.source,
        sourceId: current.sourceId,
        occurredAt,
        identityParts: ['remoteok_navigation_cleanup', hash],
        details: {
          route: 'repair_remoteok_navigation_descriptions',
          reason: REMOTE_OK_NAVIGATION_DISCARD_REASON,
          descriptionSha256: hash,
          descriptionLength: current.description.length,
          priorStatus: current.status,
          priorScoringStatus: current.scoringStatus,
          dismissedActiveRow: wasActive,
        },
      }, tx);
      return { cleaned: 1, dismissed: wasActive ? 1 : 0 };
    });
    cleaned += outcome.cleaned;
    dismissed += outcome.dismissed;
  }

  console.log(`\nCleaned ${cleaned.toLocaleString()} RemoteOK description(s).`);
  console.log(`Dismissed ${dismissed.toLocaleString()} active invalid source record(s).`);
  console.log('Source observations and existing dismissed/archived lifecycle decisions were preserved.');
}

main()
  .catch((error: unknown) => {
    console.error(`RemoteOK navigation cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
