import 'dotenv/config';

import { prisma } from '../src/lib/prisma';

/**
 * Retire the Workday catalog entries whose address is missing its pod segment.
 *
 * A real Workday board lives at `{tenant}.{pod}.myworkdayjobs.com` -- the pod is
 * the `wd1`, `wd5`, `wd103` label that says which Workday cluster hosts the
 * tenant. 654 catalog rows carry only the tenant, so every request we build for
 * them resolves a hostname that does not exist. They fail at name resolution in
 * under a second, have never once responded, and have never produced a job.
 *
 * The reason this is a safe permanent exclusion rather than a judgement about
 * the employer is that these are duplicates, not boards. 653 of the 654 already
 * have a pod-bearing twin in the catalog for the same tenant and the same career
 * site, and those twins are the rows that actually work: 3M, Assurant, General
 * Mills' peers, C.H. Robinson, Minnesota State, Thomson Reuters, Graco all crawl
 * fine under their real address. Retiring the pod-less row removes a broken
 * duplicate of a board we already cover; it does not stop us crawling anybody.
 *
 * That is why the twin is a hard precondition below rather than a note. A
 * pod-less row with no twin is the one case where retirement would actually cost
 * coverage, so this script refuses to touch it and reports it for repair.
 * `genmills::GMI_External_Careers` is currently that case.
 *
 * The board's own outstanding batches are closed in the same pass. Exclusion
 * stops new coverage admissions -- the selector only draws boards in the
 * rotation and recovery statuses -- but a batch already open is claimed by batch
 * identity, with no reference to its board's status, so leaving them behind
 * would keep exactly the wasted claims this retirement is meant to end. Closing
 * them discards nothing: every one of them holds zero raw observations and zero
 * canonical occurrences, because none of them ever reached the board.
 */
const VERSION = 'workday-podless-address-retirement-v1';
const OUTSTANDING_BATCH_STATUSES = ['fetching', 'partial', 'synchronized'];
const RETIRABLE_BOARD_STATUSES = ['active', 'parked', 'blacklisted'];

type Candidate = {
  slug: string;
  status: string;
  jobsFound: number;
  twinSlug: string | null;
  twinStatus: string | null;
};

async function loadCandidates(): Promise<Candidate[]> {
  return prisma.$queryRaw<Candidate[]>`
    WITH podless AS (
      SELECT slug, status, "jobsFound",
             split_part(slug, '::', 1) AS tenant,
             split_part(slug, '::', 2) AS site
        FROM "AtsCompany"
       WHERE platform = 'workday'
         AND split_part(slug, '::', 1) NOT LIKE '%.wd%'
         AND (
               status = ANY(${RETIRABLE_BOARD_STATUSES})
               -- Re-runnable: a row this script already excluded is still in scope
               -- so an interrupted pass can finish closing its batches.
               OR (status = 'excluded' AND "excludedReason" LIKE ${'%' + 'workday-podless-address-retirement-v1' + '%'})
             )
    ),
    twin AS (
      SELECT split_part(split_part(slug, '::', 1), '.', 1) AS tenant,
             split_part(slug, '::', 2) AS site,
             slug, status,
             row_number() OVER (
               PARTITION BY split_part(split_part(slug, '::', 1), '.', 1),
                            split_part(slug, '::', 2)
               -- Prefer a twin that is still in rotation, so the reported
               -- evidence names the row that actually covers this employer.
               ORDER BY (status = 'active') DESC, "jobsFound" DESC, slug ASC
             ) AS rank
        FROM "AtsCompany"
       WHERE platform = 'workday'
         AND split_part(slug, '::', 1) LIKE '%.wd%'
    )
    SELECT p.slug, p.status, p."jobsFound",
           t.slug AS "twinSlug", t.status AS "twinStatus"
      FROM podless p
      LEFT JOIN twin t ON t.tenant = p.tenant AND t.site = p.site AND t.rank = 1
     ORDER BY p.slug
  `;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const candidates = await loadCandidates();
  const retirable = candidates.filter((c) => c.twinSlug !== null);
  const orphans = candidates.filter((c) => c.twinSlug === null);

  console.log(`${VERSION}`);
  console.log(`pod-less Workday boards in a retirable status: ${candidates.length}`);
  console.log(`  retirable (pod-bearing twin present):        ${retirable.length}`);
  console.log(`  withheld (no twin -- needs address repair):  ${orphans.length}`);
  for (const orphan of orphans) {
    console.log(`    WITHHELD ${orphan.slug} (status ${orphan.status}) -- find its pod and correct the address`);
  }

  const batches = await prisma.atsIngestionBatch.findMany({
    where: {
      platform: 'workday',
      slug: { in: retirable.map((c) => c.slug) },
      status: { in: OUTSTANDING_BATCH_STATUSES },
    },
    select: { id: true, rawObservationCount: true, canonicalOccurrenceCount: true },
  });
  // Stated as a precondition, not an expectation. If any of these ever did reach
  // the board, closing the batch would strand acquired postings, and this script
  // must stop rather than discard them.
  const carrying = batches.filter((b) => b.rawObservationCount > 0 || b.canonicalOccurrenceCount > 0);
  if (carrying.length > 0) {
    throw new Error(
      `${carrying.length} outstanding batch(es) hold acquired rows; refusing to close them. Inspect before retiring.`,
    );
  }
  console.log(`outstanding batches to close:                  ${batches.length} (all holding zero acquired rows)`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to retire.');
    return;
  }

  const excludedAt = new Date();
  let retired = 0;
  for (const candidate of retirable) {
    if (candidate.status === 'excluded') continue;
    await prisma.atsCompany.update({
      where: { slug_platform: { slug: candidate.slug, platform: 'workday' } },
      data: {
        status: 'excluded',
        excludedAt,
        excludedReason:
          `malformed_address: the Workday pod segment is missing from this board's address, so every request `
          + `resolves a host that does not exist; it has never responded or produced a job. `
          + `Covered by ${candidate.twinSlug} (${candidate.twinStatus}), which carries the real address. (${VERSION})`,
      },
    });
    retired += 1;
  }
  // The lifecycle trigger rejects a v2 status change from a session that has not
  // declared the v2 writer capability, so the close runs inside a transaction
  // that sets it. Transaction-local, so it never outlives this statement.
  const closed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('career_dashboard.ats_v2_writer', '2', true)`;
    const result = await tx.atsIngestionBatch.updateMany({
      where: { id: { in: batches.map((b) => b.id) } },
      data: {
        status: 'operator_abandoned',
        acquisitionPhase: 'operator_abandoned',
        operatorResetAt: excludedAt,
        operatorResetReason: VERSION,
        lastError: VERSION,
        nextAcquireAt: null,
      },
    });
    return result.count;
  });
  console.log(`\nretired boards:  ${retired}`);
  console.log(`closed batches:  ${closed}`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
