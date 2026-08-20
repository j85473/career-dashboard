import 'dotenv/config';

import { prisma } from '../src/lib/prisma';
import { scrapeWorkdayPostingDetail } from '../src/lib/atsApi';
import { generateV4Fingerprint } from '../src/lib/jobIngestion';
import { recordJobPipelineEvent } from '../src/lib/ingestionControl';
import { invalidateActiveJobScores } from '../src/lib/scoreInvalidation';
import { AUTHORITATIVE_SCORE_EVENT_TYPES } from '../src/lib/scoreAuthority';

/**
 * Repairs live ATS-Workday rows whose company is still a hostname shard such
 * as `graco.wd501`.
 *
 * Only Workday's detail-response `hiringOrganization.name` is accepted as a
 * replacement. A readable tenant fallback is useful for new ingestion when a
 * required company field has no better value, but it is not strong enough to
 * rewrite historical data. Closed/unavailable postings therefore fail closed.
 *
 * Company is trusted scoring metadata. The apply path updates only rows with
 * no Aim/Experience score, no active native or JD-recovery marker, no staged
 * tailoring work, and no leased manual-scoring item. Scored or leased rows are
 * reported for an explicit invalidation/re-score decision instead of silently
 * changing their inputs. Dry run by default; `--apply` writes the guarded safe
 * set plus only the scored rows explicitly named with `--rescore-id`.
 */

const TERMINAL_STATUSES = ['archived', 'dismissed', 'expired'];
const CONCURRENCY = 4;

type Arguments = {
  apply: boolean;
  company: string | null;
  limit: number | null;
  rescoreIds: string[];
};

type Candidate = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  url: string | null;
  sourceId: string | null;
  status: string;
  scoringStatus: string;
  aimFitScore: number | null;
  reqFitScore: number | null;
  batchJobId: string | null;
  afBatchId: string | null;
  jdBatchId: string | null;
  tailoringStaged: boolean;
  updatedAt: Date;
  scoringBatchItems: Array<{ id: string }>;
  scoreEvents: Array<{ id: string }>;
};

type Repair = {
  candidate: Candidate;
  company: string;
  identityFingerprint: string;
};

function parseArguments(argv: string[]): Arguments {
  let apply = false;
  let company: string | null = null;
  let limit: number | null = null;
  const rescoreIds: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--apply') {
      apply = true;
      continue;
    }
    if (argument === '--company') {
      const value = argv[++index]?.trim();
      if (!value) throw new Error('--company requires a non-empty value');
      company = value;
      continue;
    }
    if (argument === '--limit') {
      const value = Number.parseInt(argv[++index] || '', 10);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--limit requires a positive integer');
      limit = value;
      continue;
    }
    if (argument === '--rescore-id') {
      const value = argv[++index]?.trim();
      if (!value) throw new Error('--rescore-id requires a job id');
      rescoreIds.push(value);
      continue;
    }
    throw new Error('Usage: repair_workday_company_names.ts [--company NAME] [--limit N] [--rescore-id JOB_ID]... [--apply]');
  }
  return { apply, company, limit, rescoreIds: [...new Set(rescoreIds)] };
}

function safeToWrite(candidate: Candidate): boolean {
  return candidate.aimFitScore === null
    && candidate.reqFitScore === null
    && candidate.batchJobId === null
    && candidate.afBatchId === null
    && candidate.jdBatchId === null
    && !candidate.tailoringStaged
    && candidate.scoringStatus !== 'scoring'
    && candidate.scoringBatchItems.length === 0
    && candidate.scoreEvents.length === 0;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  console.log(`${args.apply ? 'APPLY' : 'DRY RUN'} — resolving live Workday company labels...`);

  const rows = await prisma.job.findMany({
    where: {
      source: 'ATS-workday',
      status: { notIn: TERMINAL_STATUSES },
      company: args.company
        ? { equals: args.company, mode: 'insensitive' }
        : { contains: '.wd', mode: 'insensitive' },
    },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      url: true,
      sourceId: true,
      status: true,
      scoringStatus: true,
      aimFitScore: true,
      reqFitScore: true,
      batchJobId: true,
      afBatchId: true,
      jdBatchId: true,
      tailoringStaged: true,
      updatedAt: true,
      scoringBatchItems: { where: { status: 'leased' }, take: 1, select: { id: true } },
      scoreEvents: {
        where: {
          evaluationType: { in: [...AUTHORITATIVE_SCORE_EVENT_TYPES] },
          staleAt: null,
        },
        take: 1,
        select: { id: true },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    ...(args.limit ? { take: args.limit } : {}),
  });
  const candidates = rows.filter((row) => /\.wd\d+$/i.test(row.company));

  const repairs: Repair[] = [];
  const missingUrl: Candidate[] = [];
  const detailUnavailable: Candidate[] = [];
  const detailWithoutCompany: Candidate[] = [];

  for (let offset = 0; offset < candidates.length; offset += CONCURRENCY) {
    const batch = candidates.slice(offset, offset + CONCURRENCY);
    const results = await Promise.all(batch.map(async (candidate) => {
      if (!candidate.url) return { candidate, kind: 'missing_url' as const };
      try {
        const detail = await scrapeWorkdayPostingDetail(candidate.url);
        if (!detail || detail.ats !== 'Workday') {
          return { candidate, kind: 'detail_unavailable' as const };
        }
        if (!detail.company) return { candidate, kind: 'no_company' as const };
        return { candidate, kind: 'resolved' as const, company: detail.company };
      } catch {
        return { candidate, kind: 'detail_unavailable' as const };
      }
    }));

    for (const result of results) {
      if (result.kind === 'missing_url') {
        missingUrl.push(result.candidate);
      } else if (result.kind === 'detail_unavailable') {
        detailUnavailable.push(result.candidate);
      } else if (result.kind === 'no_company') {
        detailWithoutCompany.push(result.candidate);
      } else {
        repairs.push({
          candidate: result.candidate,
          company: result.company,
          identityFingerprint: generateV4Fingerprint(
            result.candidate.title,
            result.company,
            result.candidate.location || 'Unknown Location',
          ),
        });
      }
    }
    console.log(`  inspected ${Math.min(offset + batch.length, candidates.length).toLocaleString()}/${candidates.length.toLocaleString()} detail response(s)`);
  }

  const writable = repairs.filter(({ candidate }) => safeToWrite(candidate));
  const withheld = repairs.filter(({ candidate }) => !safeToWrite(candidate));
  const requestedRescores = repairs.filter(({ candidate }) => args.rescoreIds.includes(candidate.id));
  const unresolved = [...missingUrl, ...detailUnavailable, ...detailWithoutCompany];

  const resolvedRescoreIds = new Set(requestedRescores.map(({ candidate }) => candidate.id));
  const missingRescoreIds = args.rescoreIds.filter((id) => !resolvedRescoreIds.has(id));
  if (missingRescoreIds.length > 0) {
    throw new Error(`Requested rescore job(s) were not safely resolved from live Workday detail: ${missingRescoreIds.join(', ')}`);
  }
  const unsupportedRescores = requestedRescores.filter(({ candidate }) => (
    !['pending_af', 'inbox', 'passed'].includes(candidate.status)
    || candidate.scoringStatus === 'scoring'
    || candidate.batchJobId !== null
    || candidate.afBatchId !== null
    || candidate.jdBatchId !== null
    || candidate.tailoringStaged
    || candidate.scoringBatchItems.length > 0
  ));
  if (unsupportedRescores.length > 0) {
    throw new Error(`Requested rescore job(s) are protected, staged, or actively leased: ${unsupportedRescores.map(({ candidate }) => candidate.id).join(', ')}`);
  }

  console.log(`\n  live hostname-label candidates:             ${candidates.length.toLocaleString()}`);
  console.log(`  authoritative company names recovered:      ${repairs.length.toLocaleString()}`);
  console.log(`  eligible unscored/unleased repairs:          ${writable.length.toLocaleString()}`);
  console.log(`  scored or actively leased rows withheld:     ${withheld.length.toLocaleString()}`);
  console.log(`  explicitly selected for repair + rescore:    ${requestedRescores.length.toLocaleString()}`);
  console.log(`  missing posting URL:                          ${missingUrl.length.toLocaleString()}`);
  console.log(`  Workday detail unavailable/closed:            ${detailUnavailable.length.toLocaleString()}`);
  console.log(`  detail omitted hiringOrganization.name:       ${detailWithoutCompany.length.toLocaleString()}`);
  console.log(`  unresolved total (left unchanged):            ${unresolved.length.toLocaleString()}`);

  for (const repair of repairs.slice(0, 40)) {
    const disposition = safeToWrite(repair.candidate) ? 'SAFE' : 'WITHHELD';
    console.log(`  ${disposition} ${repair.candidate.id}: "${repair.candidate.company}" -> "${repair.company}" (${repair.candidate.title})`);
  }
  if (repairs.length > 40) console.log(`  ... and ${repairs.length - 40} more resolved row(s)`);

  for (const candidate of unresolved.slice(0, 20)) {
    console.log(`  UNRESOLVED ${candidate.id}: ${candidate.company} — ${candidate.title}`);
  }
  if (unresolved.length > 20) console.log(`  ... and ${unresolved.length - 20} more unresolved row(s)`);

  if (!args.apply) {
    console.log('\nDry run. Re-run with --apply to write eligible unscored/unleased repairs and any explicit --rescore-id selections.');
    return;
  }

  let written = 0;
  for (const repair of writable) {
    const result = await prisma.job.updateMany({
      where: {
        id: repair.candidate.id,
        source: 'ATS-workday',
        company: repair.candidate.company,
        url: repair.candidate.url,
        updatedAt: repair.candidate.updatedAt,
        status: { notIn: TERMINAL_STATUSES },
        aimFitScore: null,
        reqFitScore: null,
        batchJobId: null,
        afBatchId: null,
        jdBatchId: null,
        tailoringStaged: false,
        scoringStatus: { not: 'scoring' },
        scoringBatchItems: { none: { status: 'leased' } },
        scoreEvents: {
          none: {
            evaluationType: { in: [...AUTHORITATIVE_SCORE_EVENT_TYPES] },
            staleAt: null,
          },
        },
      },
      data: {
        company: repair.company,
        identityFingerprint: repair.identityFingerprint,
      },
    });
    written += result.count;
  }

  let rescored = 0;
  let invalidated = 0;
  for (const repair of requestedRescores) {
    const outcome = await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Job" WHERE id = ${repair.candidate.id} FOR UPDATE;
      `;
      if (!locked) throw new Error(`Requested rescore job disappeared: ${repair.candidate.id}`);

      const current = await tx.job.findUnique({
        where: { id: repair.candidate.id },
        select: {
          id: true, source: true, sourceId: true, company: true, url: true,
          status: true, scoringStatus: true, batchJobId: true, afBatchId: true,
          jdBatchId: true, tailoringStaged: true, updatedAt: true,
          scoringBatchItems: { where: { status: 'leased' }, take: 1, select: { id: true } },
        },
      });
      if (!current
        || current.source !== 'ATS-workday'
        || current.company !== repair.candidate.company
        || current.url !== repair.candidate.url
        || current.updatedAt.valueOf() !== repair.candidate.updatedAt.valueOf()
        || !['pending_af', 'inbox', 'passed'].includes(current.status)
        || current.scoringStatus === 'scoring'
        || current.batchJobId !== null
        || current.afBatchId !== null
        || current.jdBatchId !== null
        || current.tailoringStaged
        || current.scoringBatchItems.length > 0) {
        throw new Error(`Requested rescore job changed or became protected during resolution: ${repair.candidate.id}`);
      }

      const updated = await tx.job.update({
        where: { id: current.id },
        data: {
          company: repair.company,
          identityFingerprint: repair.identityFingerprint,
          status: 'pending_af',
          scoringStatus: 'queued',
          experienceStatus: 'queued',
          batchJobId: null,
          afBatchId: null,
          jdBatchId: null,
          scoreAttempts: 0,
          scoreError: null,
          deepseekScoreAttempts: 0,
          deepseekScoreError: null,
          passReason: null,
          contextBatched: true,
          contextBatchId: null,
          fitScore: null,
          fitCategory: 'unscored',
          fitRationale: null,
          recommendedResume: null,
          aimFitScore: null,
          reqFitScore: null,
          reqFitRationale: null,
          travelScore: null,
          compensation: null,
        },
      });
      const scoreInvalidation = await invalidateActiveJobScores({
        jobId: updated.id,
        source: updated.source,
        sourceId: updated.sourceId,
        changedFields: ['company'],
        route: 'workday_company_repair',
        occurredAt: updated.updatedAt,
      }, tx);
      await recordJobPipelineEvent({
        eventType: 'user_rescore',
        jobId: updated.id,
        stage: 'manual_scoring',
        source: updated.source,
        sourceId: updated.sourceId,
        occurredAt: updated.updatedAt,
        identityParts: ['workday_company_repair', repair.candidate.company, repair.company, updated.updatedAt.toISOString()],
        details: {
          route: 'workday_company_repair',
          changedFields: ['company'],
          priorCompany: repair.candidate.company,
          nextCompany: repair.company,
        },
      }, tx);
      return scoreInvalidation.invalidatedEventIds.length;
    });
    rescored += 1;
    invalidated += outcome;
  }

  console.log(`\nApplied ${written.toLocaleString()} authoritative Workday company-name repair(s).`);
  if (written !== writable.length) {
    console.log(`Skipped ${(writable.length - written).toLocaleString()} row(s) that changed, scored, or became leased during detail fetching.`);
  }
  console.log(`Repaired and requeued ${rescored.toLocaleString()} explicitly selected job(s); invalidated ${invalidated.toLocaleString()} authoritative score event(s).`);
}

main()
  .catch((error: unknown) => {
    console.error(`Workday company-name repair failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
