import { Prisma } from '@prisma/client';

import { prisma } from './prisma';

/**
 * A job's true Inbox entry time — not `createdAt`, which is when the row was
 * first ingested and can predate Inbox entry by weeks while the job sits in
 * earlier pipeline stages (JD recovery, Aim/Experience scoring).
 *
 * Every status transition into Inbox records an immutable pipeline event with
 * `details.enteredInbox: true` — the automated Experience pass (`ae_pass`,
 * scoringImport.ts) and every human promote/restore (`user_promote`,
 * jobLifecycleEvents.ts). The most recent such event is the job's current
 * Inbox entry time; a job created directly at status Inbox (manual import,
 * outreach sync) has no such event, so `createdAt` is correct for it.
 *
 * `j` must be the alias for the `"Job"` table in the surrounding query.
 */
export const INBOX_ENTERED_AT_SQL = Prisma.sql`
  COALESCE(
    (SELECT MAX(e."occurredAt") FROM "JobPipelineEvent" e
     WHERE e."jobId" = j.id AND e.details @> '{"enteredInbox": true}'::jsonb),
    j."createdAt"
  )
`;

export const INBOX_REVIEW_WINDOW_DAYS = 15;

/**
 * Ordered, paginated Inbox job IDs sorted by true Inbox entry time. Used by
 * the "Newest"/"Oldest" Inbox sort, which otherwise falls back to `createdAt`
 * — the original ingestion time, which can predate Inbox entry by weeks.
 * Callers re-fetch the full rows via `findMany({ where: { id: { in } } })`
 * and must re-sort by this array's order themselves; Prisma's `IN` does not
 * preserve input order.
 */
export async function inboxOrderedIds(
  direction: 'asc' | 'desc',
  limit: number,
  offset: number,
): Promise<string[]> {
  const order = direction === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT j.id
    FROM "Job" j
    WHERE j.status = 'inbox' AND j."tailoringStaged" = false
    ORDER BY ${INBOX_ENTERED_AT_SQL} ${order}, j.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map((row) => row.id);
}

/**
 * Dismisses Inbox jobs that have sat past the review window without a
 * decision. Protected by construction: `bookmarked`/`applied`/`interviewing`
 * are different status values, so `status: 'inbox'` already excludes them,
 * and `tailoringStaged` is checked explicitly. A job a human explicitly
 * re-promotes gets a fresh `user_promote` event, which resets its Inbox
 * entry time and therefore its clock — no separate exemption needed.
 */
export async function expireStaleInboxJobs(onProgress?: (msg: string) => void, dryRun = false): Promise<number> {
  onProgress?.(`Checking for Inbox jobs past the ${INBOX_REVIEW_WINDOW_DAYS}-day review window...`);

  const stale = await prisma.$queryRaw<Array<{ id: string; title: string; company: string; enteredInboxAt: Date }>>`
    SELECT j.id, j.title, j.company, ${INBOX_ENTERED_AT_SQL} AS "enteredInboxAt"
    FROM "Job" j
    WHERE j.status = 'inbox' AND j."tailoringStaged" = false
      AND ${INBOX_ENTERED_AT_SQL} < NOW() - INTERVAL '${Prisma.raw(String(INBOX_REVIEW_WINDOW_DAYS))} days'
    ORDER BY "enteredInboxAt" ASC
  `;

  if (stale.length === 0) {
    onProgress?.('No Inbox jobs are past the review window.');
    return 0;
  }

  onProgress?.(`Found ${stale.length} Inbox job(s) past ${INBOX_REVIEW_WINDOW_DAYS} days.`);
  if (dryRun) {
    for (const job of stale) {
      onProgress?.(`  would expire ${job.id}  entered ${job.enteredInboxAt.toISOString()}  ${job.company} — ${job.title}`);
    }
    return stale.length;
  }

  let expired = 0;
  for (const job of stale) {
    // Recheck immediately before writing: a human decision (promote away,
    // bookmark, apply) between the read above and now must win.
    const result = await prisma.job.updateMany({
      where: { id: job.id, status: 'inbox', tailoringStaged: false },
      data: {
        status: 'expired',
        passReason: `Expired: sat in Inbox longer than the ${INBOX_REVIEW_WINDOW_DAYS}-day review window`,
      },
    });
    if (result.count > 0) {
      expired += 1;
      onProgress?.(`Job ${job.id} expired (${INBOX_REVIEW_WINDOW_DAYS}+ days in Inbox).`);
    }
  }
  onProgress?.(`Inbox review-window check complete. Expired ${expired} of ${stale.length} job(s).`);
  return expired;
}
