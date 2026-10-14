# Athena discovery handoff repair

This change repairs the committed, undeployed Athena handoff. It does not
deploy, enable AWS access, or alter job lifecycle decisions or existing scores.

1. **Entry:** Only the durable Common Crawl audit's unfinished pattern/index
   checkpoints and the configured patterns' missing historical receipts select
   work. Both worker services continue to share the discovery lock.
2. **Exit:** A successful page commits candidates with its own source cursor.
   Only exhausted results earn an index receipt. Temporary AWS read failures
   retain the query and cursor; confirmed failed/cancelled queries or expired
   managed results permit a fresh submission attempt.
3. **Owner:** The audit worker owns discovery receipts and cursors. Existing
   validation and first-collection admission retain their responsibilities.
4. **Failures:** Source errors retain checkpoint-specific backoff and remain
   operational failures. They never become posting closures or fit decisions.
5. **Recovery:** The legacy page field remains exclusively the direct API's
   next page; Athena uses its separate result token. A request token is saved
   before AWS submission and reused after uncertain responses or database
   failures. Existing receipts and candidates remain intact. Coverage is
   determined by exact platform, pattern, and index receipts from completed
   runs, including when hosts are replaced without changing the pattern count.
   Saved patterns remain part of an unfinished run. Once that run finishes,
   the same invocation checks for missing historical or newly published work.
6. **Proof:** Regression tests exercise both source-switch directions,
   transient status/result errors, terminal query replacement, managed result
   expiry, uncertain submission and checkpoint-write failure, candidate/cursor
   atomicity, and historical coverage after pattern replacement or expansion.

The new nullable request-token column is additive. The prior Athena commit has
not been deployed, so production's existing page offsets are direct-API offsets
and need no data rewrite. An unfinished partition may be read by both sources;
candidate deduplication preserves prior discoveries. No completion receipt or
candidate is deleted during reader switching or query replacement.

Validation: the full suite passes with 2,146 passing tests and 7 skips.
TypeScript, lint for the changed runtime/tests, the production build, Prisma
schema validation, and the expand-only check for both pending Athena migrations
pass. Recovery tests use simulated AWS/database failures; no live worker switch
or production migration was performed.

## M70 credential and predeployment verification - 2026-10-14

The dedicated `cc-ats-discovery-worker` IAM user has one scoped customer policy
and no console password. It can query only `cc-ats-discovery-pilot`, read the
`ccindex.ccindex` metadata, and read/list the public Common Crawl index prefix.
Its credential and Athena settings are installed in
`/etc/career-dashboard/athena-discovery.env`, owned by `root:root` with mode
`0600`. Systemd will load that file with the new service definitions. The
temporary credential download was removed after installation.

The exact repaired reader and pinned AWS SDK were tested from a temporary
runtime on M70 as the `career-dashboard` user. Query
`b5f736d5-09d1-4ad3-83ec-d7bde9813c35` succeeded against
`CC-MAIN-2026-34` and `job-boards.greenhouse.io`, scanning 239,855,035 bytes.
The first two result pages returned 999 and 1,000 URLs; heading removal and
continuation were verified. Repeating the persisted request token returned
the same execution. Managed encrypted results, the existing 52,428,800,000-byte
scan ceiling, and projected table configuration were verified. Access to the
`primary` workgroup and account-wide IAM reads was denied.

The root-only receipt is
`/var/lib/career-dashboard/athena-predeploy-verification.json`. The temporary
SDK/runtime was removed. The active release remains `7861e5c`; the discovery
service remains running with its existing environment files. No release,
migration, worker restart, or job import was performed by this setup.

## Live legacy collection compatibility

The first activation exposed an existing Eightfold checkpoint at
`CC-MAIN-2008-2009-index`. The URL index covers main crawls from 2013 onward;
older CDX-only catalog collections must retain direct API reads and backoff.
The worker now selects that source per index, preserving the independent
cursor and requiring actual direct-source exhaustion for a receipt. A mapping
error or nonexistent Athena partition cannot satisfy historical coverage.
This compatibility correction has no additional migration.
