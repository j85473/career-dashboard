# Career Dashboard ingestion and scoring repair runbook

This runbook controls the August 9, 2026 ingestion, scoring, search, travel,
and Stats repair. It is intentionally fail-closed: local implementation and
validation may proceed autonomously, but production data changes, commit,
push, and Raspberry Pi deployment require Joseph's explicit approval after the
pre-deployment evidence bundle is reviewed.

## Non-negotiable authority

- The only scoring resume is `data/resumes/JosephLamb_Resume.docx`, copied from
  the Workday/canonical resume.
- Expected SHA-256:
  `23ceb1cb09d9ec8d0350ae4da96da018b26517c0f9b58dbe2762f0e44e0ad059`.
- The formal DSI title is `Field Sales Representative — Channel Sales`.
  Channel account management is a supported function when canonical evidence
  establishes it; it is not a second held title and cannot create title-tenure
  evidence.
- Existing score events are immutable evidence. A defective evaluation is
  invalidated with additive provenance and replaced by a new score event.
- Applied, interviewing, cooldown, tailoring, and human-rejected decisions are
  never automatically reopened or overwritten.
- The Career Dashboard must not acquire a login screen.

## Metric and event contract

Every ingestion task has exactly one source, normalized query family,
geography lane, time window, and mode. Its candidate denominator must satisfy:

```text
seen = inserted + duplicate + filtered + processing_error
```

Provider/request failures are not job candidates and are excluded from that
equation. A provider outage is one incident that may affect many tasks; the UI
must show both the incident and the affected-task count without presenting each
task failure as an independent outage.

Pipeline movement is measured from immutable `JobPipelineEvent` rows. Canonical
event types are:

- `ingested`
- `duplicate`
- `prefilter_rejected`
- `jd_ready`
- `jd_failed`
- `local_pass`
- `local_reject`
- `ae_pass`
- `ae_reject`
- `user_promote`
- `user_reject`
- `processing_error`
- `score_invalidated`
- `score_replay_queued`

An event needs a stable idempotency key, event timestamp, job when applicable,
source/task provenance when applicable, and structured metadata for the reason
or version. A job enters `inbox` only through `ae_pass` or `user_promote`.
Initial ingestion survivors use `pending_af`.

## Search contract

Search coverage is deterministic across these geography lanes:

1. `msp_metro` — Minneapolis-Saint Paul and the 55405 home radius.
2. `minnesota` — Minnesota jobs without an incompatible work-base condition.
3. `upper_midwest` — regional work compatible with a Minneapolis residence.
4. `us_remote` — United States remote work regardless of travel territory.

The work-base decision and travel-territory decision are separate. Explicit
nonlocal residence, commute, onsite, hybrid, or state-restricted requirements
remain hard vetoes. Western, national, or international travel territory does
not make an otherwise US-remote role ineligible.

Search tasks advance from their last successful watermark and use a bounded
overlap window for late-arriving records. A failed or interrupted task retains
its prior successful watermark and resumes from its durable cursor. Duplicate
density cannot terminate pagination by itself. Query-independent feeds run
once per scheduled interval, not once per title phrase.

## JD and scoring contract

- Portal shells, authentication pages, cookie-only pages, expired postings,
  truncated descriptions, and content without usable duties or qualifications
  are incomplete JDs.
- An empty `mandatoryRequirementAssessments` array cannot produce
  `qualificationBasis=direct`, `mandatoryRequirementsMet=true`, or a pass.
- Every pass assesses at least one material function or qualification.
- Formal title/tenure, W-2 people leadership, budget or P&L authority,
  enterprise/national-account ownership, credentials, and specialized-domain
  tenure require direct canonical evidence. Adjacency never becomes direct
  merely because several evidence records are present.
- Travel is a positive target dimension but does not change Experience.
- Context rules are typed, scoped, source-provenanced, conflict-checked, and
  retireable. Context may affect Aim; it may not manufacture Experience.

## Source-canary policy

New sources remain canaries until they demonstrate incremental eligible yield.
Each source must publish request counts, candidates seen, unique inserts,
duplicates, deterministic rejects, local survivors, A/E passes, high-travel
survivors, freshness, latency, and cost or quota consumption.

Initial canaries are:

- CareerOneStop Jobs V2/NLx, enabled only when
  `CAREERONESTOP_USER_ID` and `CAREERONESTOP_API_TOKEN` are configured.
- Himalayas filtered Search API, at most once per source refresh interval and
  retaining the required source attribution.
- We Work Remotely's official sales-and-marketing RSS feed, retaining link
  attribution.

Remote OK is not enabled without a separate data-quality gate. Unofficial
LinkedIn, Indeed, and Glassdoor wrappers remain isolated behind explicit
budgets and persistent circuit breakers.

## Local validation sequence

Run the smallest relevant test after each bounded change, then execute the
complete gate from a clean dependency state:

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
node scripts/deployment/check-expand-only.mjs prisma/migrations
npm run scoring:canary
```

Also verify:

1. Prisma migration SQL is expand-only and contains no production row edits.
2. Prisma generation succeeds from `prisma/schema.prisma`.
3. The canonical resume contract rejects both altered bytes and the one-line
   Channel Account Manager variant.
4. The labeled title, JD-quality, location, and travel matrices pass.
5. An ingestion-task restart resumes its cursor and does not advance a failed
   watermark.
6. Every task reconciliation equation balances.
7. One A/E pass creates exactly one inbox event; a job INSERT creates none.
8. Every active job appears in one actionable queue.
9. Shadow replay emits no incomplete-JD pass, noncanonical title claim, or
   deterministic location mismatch.

## Production preparation after approval

Before any production mutation:

1. Stop the Pi pipeline trigger and the Mac native-scoring watcher. Export the
   current Context profile, V6.7.1 event IDs, relevant Job rows,
   active queue/orphan IDs, ingestion state, ATS due counts, and Stats baseline.
2. Record the current Git commit, canonical resume hash, prompt/schema versions,
   migration list, and production database backup path.
3. Run the pre-migration-capable score-authority dry run and compare its exact
   IDs/actions with the frozen export. Do not apply it yet, and do not reuse
   this hash after migration; it is comparison evidence only.
4. Confirm that migrations add schema only, then apply and validate the expand
   migration before starting any new application or worker code. A caught
   missing-table error inside a PostgreSQL transaction can still abort that
   transaction; fail-soft application code is not a substitute for ordering.
5. Generate/validate the matching Prisma client, then activate the new
   application in maintenance mode while the pipeline and scoring watcher
   remain stopped:

   ```bash
   ACTIVATION_MODE=maintenance ./scripts/deploy.sh
   ```

   Maintenance activation accepts only a clean Git commit and transfers only
   Git-tracked files. It removes and verifies the Career Dashboard cron block,
   proves database and process-lock quiescence, stops the old web service,
   builds the staged release on the Pi, and proves quiescence again before the
   backup and migration. It preserves unrelated crontab entries and does not
   reinstall the pipeline trigger after the health check. Materialize the
   configured durable task catalog without starting ingestion or claiming any
   lease:

   ```bash
   sudo -- runuser -u j85473 -- bash -c 'cd /opt/career-dashboard && npm run ingestion:seed-tasks'
   ```

   The command must exit successfully and its JSON must show
   `seededTaskCount == expectedTaskCount`, `providerRequests: 0`, and
   `leasesClaimed: 0`. A mismatch is a stop condition; do not start the
   pipeline to create the missing rows. Run every repair dry run again against
   the expanded schema and review the new selection hashes, including exact
   per-job replay/protect actions.
6. Apply typed-Context bootstrap, queue-orphan repair, and score invalidation /
   replay in that order. For each repair, run its dry run and then immediately
   run its confirmed apply with that exact `--confirm-selection` value before
   moving to the next repair. Do not collect all three hashes first: queue
   repair changes Job provenance and can invalidate an earlier authority hash.
7. Run the strict readiness audit. It must report zero active native requests,
   pipeline locks, ingestion leases, local-scoring leases, JD-extraction leases,
   and native job leases in addition to clean schema, authority, queues, and
   counters:

   ```bash
   npm run audit:repair-readiness -- --strict --expect-repair-applied --expect-tasks-seeded
   ```

   With `--expect-tasks-seeded`, readiness compares every configured canonical
   task key with the database; a merely nonempty task table is not sufficient.
   Any missing key, lease, counter mismatch, orphan, incomplete-JD pass, schema
   gap, Context scope violation, or canonical-resume mismatch is a stop
   condition.

   Only after that command exits successfully, run the exact `Post-audit enable
   command` printed by maintenance activation. Its portable form on the Pi is:

   ```bash
   sudo -- runuser -u j85473 -- bash /opt/career-dashboard/scripts/deployment/install-crontab-remote.sh /opt/career-dashboard '' career-dashboard enable
   ```

   Restart the Mac native-scoring watcher separately after the cron installer
   reports a verified schedule. Do not enable either worker before the audit.
8. Use the repository's staged-release workflow throughout so the
   pre-migration PostgreSQL backup and prior application release are retained.

## Rollback

Application rollback uses the deployment workflow's retained prior release.
Database migrations are additive; disable new readers/writers by rolling the
application back rather than dropping schema. Do not automatically restore the
database backup after activation because doing so could erase writes made after
the backup. If a data repair script partially fails, stop the pipeline, retain
its audit output and idempotency keys, inspect committed rows, and resume only
the unapplied portion.

## Post-deployment acceptance

The repair is complete only after the live Pi verifies:

- canonical resume and prompt hashes;
- durable task and circuit state across a controlled service restart;
- due-only ATS selection;
- visible mid-task checkpoints;
- reconciled task and daily funnel totals;
- automatic single-flight A/E request creation at the documented threshold;
- zero active jobs outside an actionable or terminal state;
- correct Travel Watch ordering and positive styling;
- grouped provider incidents rather than query-level outage inflation; and
- replacement append-only scoring events for the approved replay cohort.

Source superiority is not declared at deployment. Canary sources remain in a
14-day measurement period before promotion, removal, or subscription changes.
