# Career Dashboard ingestion and scoring repair runbook

> **SCORING PROCEDURE RETIRED.** The ingestion evidence below remains historical context, but every native-scoring/watch/install/request instruction in this runbook is non-executable and superseded by `CAREER_DASHBOARD_AIM_EXPERIENCE_SCORING_IMPLEMENTATION_PLAN_2026-08-12.md`. Native Agy is not a fallback or rollback.

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

   For the GitHub-driven deployment, set the Actions repository variable
   `PI_ACTIVATION_MODE=maintenance` before pushing the exact reviewed commit.
   The deploy workflow passes that value to `scripts/deploy.sh`; if the variable
   is absent it defaults to `normal`. Keep the variable set until that workflow
   finishes and the maintenance activation is verified, including confirmation
   that the Career Dashboard cron remains disabled. Then restore or delete the
   variable so a later deployment cannot inherit maintenance mode. Do not enable
   cron as part of that cleanup; cron is enabled explicitly only after the final
   strict audit in step 10.

   Maintenance activation accepts only a clean Git commit and transfers only
   Git-tracked files. It removes and verifies the Career Dashboard cron block,
   proves database and process-lock quiescence, stops the old web service,
   builds the staged release on the Pi, and proves quiescence again before the
   backup and migration. It preserves unrelated crontab entries and does not
   reinstall the pipeline trigger after the health check. Materialize the
   configured durable task catalog without starting ingestion or claiming any
   lease:

   ```bash
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail
     cd /opt/career-dashboard
     node scripts/with-env.mjs npm run --silent ingestion:seed-tasks
   '
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

   Run every command through the same layered production-environment loader used
   by the service. Raw `npm run` loads only `.env`; it can silently omit optional
   source credentials stored in another supported production dotenv file.
   Replace each literal `REVIEWED_64_HEX_HASH` only after reviewing that dry
   run's JSON and frozen ID/action export:

   ```bash
   # Typed Context: dry run, review, then immediate confirmed apply.
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail; cd /opt/career-dashboard
     node scripts/with-env.mjs npm run --silent scoring:context:migrate-typed
   '
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail; cd /opt/career-dashboard
     node scripts/with-env.mjs npm run --silent scoring:context:migrate-typed -- --apply --confirm-selection REVIEWED_64_HEX_HASH
   '

   # Queue orphans: dry run, review, then immediate confirmed apply.
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail; cd /opt/career-dashboard
     node scripts/with-env.mjs npm run --silent scoring:repair-queues
   '
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail; cd /opt/career-dashboard
     node scripts/with-env.mjs npm run --silent scoring:repair-queues -- --apply --confirm-selection REVIEWED_64_HEX_HASH
   '

   # Score authority: dry run, review every replay/protect action, then apply.
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail; cd /opt/career-dashboard
     node scripts/with-env.mjs npm run --silent scoring:repair-authority
   '
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail; cd /opt/career-dashboard
     node scripts/with-env.mjs npm run --silent scoring:repair-authority -- --apply --confirm-selection REVIEWED_64_HEX_HASH
   '
   ```

   Stop if the queue dry run omits any ID in the frozen active-orphan export or
   if an authority `preserve_visible_inbox` row does not already have
   `scoringStatus: scored`; neither case has a safe automatic fallback. After
   each apply, require the returned selection hash and counts to match its dry
   run. Re-run queue and authority dry runs after their applies; both must select
   zero rows.
7. Run the strict readiness audit. It must report zero active native requests,
   pipeline locks, ingestion leases, local-scoring leases, JD-extraction leases,
   and native job leases in addition to clean schema, authority, queues, and
   counters:

   ```bash
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail; cd /opt/career-dashboard
     node scripts/with-env.mjs npm run --silent audit:repair-readiness -- --strict --expect-repair-applied --expect-tasks-seeded
   '
   ```

   With `--expect-tasks-seeded`, readiness compares every configured canonical
   task key with the database; a merely nonempty task table is not sufficient.
   Any missing key, lease, counter mismatch, orphan, incomplete-JD pass, schema
   gap, Context scope violation, or canonical-resume mismatch is a stop
   condition. Source-run reconciliation is enforced for durable rows carrying
   checkpoint evidence. Pre-migration rows whose new accounting columns were
   filled only by migration defaults are reported separately as
   `legacyUnreconciledEvidence7d` and `legacyCounterEquationGaps7d`; those
   historical counts are not reconstructed or treated as current invariant
   failures. Any `durableUnreconciledRuns7d` or
   `durableCounterMismatches7d` value above zero is a stop condition.

8. Keep cron and the persistent Mac watcher disabled while the approved local
   replay cohort is drained. First run the read-only cohort projection:

   ```bash
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail; cd /opt/career-dashboard
     node scripts/with-env.mjs npm run --silent scoring:audit
   '
   ```

   `localReplayPreflight.jobIds` must equal the reviewed queue-repair `queued`
   IDs plus authority `rerun_local_then_native` IDs, together with any separately
   approved pre-existing local backlog. Require
   `immutableHumanDecisionJobIds: []` and no more than
   `maximumJobsPerRun`; an unexpected ID is a stop condition. Then trigger the
   local-only route once and wait for the background work to reach `Idle`:

   ```bash
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail
     cd /opt/career-dashboard
     base_url="$(bash scripts/deployment/service-url.sh career-dashboard "")"
     before="$(curl --fail-with-body --silent --show-error "$base_url/api/pipeline/status")"
     node -e '\''const s=JSON.parse(process.argv[1]); if (s.isRunning || s.currentStep === "Error") process.exit(1)'\'' "$before"
     curl --fail-with-body --silent --show-error -X POST "$base_url/api/pipeline/local"

     complete=false
     for _attempt in $(seq 1 720); do
       state="$(curl --fail-with-body --silent --show-error "$base_url/api/pipeline/status")"
       printf "%s\n" "$state"
       state_kind="$(node -e '\''const s=JSON.parse(process.argv[1]); process.stdout.write(s.currentStep === "Error" ? "error" : (!s.isRunning && s.currentStep === "Idle") ? "idle" : "running")'\'' "$state")"
       if [[ "$state_kind" == idle ]]; then complete=true; break; fi
       if [[ "$state_kind" == error ]]; then exit 1; fi
       sleep 5
     done
     [[ "$complete" == true ]]
   '
   ```

   The POST response only means the background pass started. A timeout, `Error`,
   remaining unexpected local IDs, or any lease in the next strict audit is a
   stop condition. Re-run `scoring:audit` and the strict readiness command from
   step 7; `localReplayPreflight.jobIds` must now be empty unless every remaining
   ID has an explicitly reviewed retry disposition.
9. With the local cohort drained and both automatic workers still disabled, run
   `scoring:audit` once more and freeze its `nativeReplayPreflight` object.
   It is the read-only projection of the full global Agy-eligible backlog, not
   only the authority-repair rows and not a promise that one request can drain
   the whole set:

   - review every `contextJobIds` entry;
   - compare `directlyEligibleStandardJobIds` with the repair output;
   - review every `staleInboxRefreshJobIds` and `dismissedRecoveryJobIds` entry;
   - approve the point-in-time union in
     `projectedAllWaveStandardCandidateIds` before creating a request;
   - record `contextBatchSize`, `standardBatchSize`, the projected batch counts,
     snapshot timestamp, and selection hash.

   An Agy request is intentionally global and cannot be restricted to a supplied
   list of repair IDs. If the projection contains unrelated work, either approve
   that full wave explicitly or stop. Immediately before the request, the Mac
   checkout must be the same clean commit deployed to the Pi and its structural
   canary must pass:

   ```bash
   cd '/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard'
   scoring_tree_status="$(git -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all)"
   [[ -z "$scoring_tree_status" ]] || { printf '%s\n' "$scoring_tree_status" >&2; exit 1; }
   git -c core.fsmonitor=false rev-parse HEAD
   node scripts/with-env.mjs npm run --silent scoring:canary
   ```

   Create exactly one request on the Pi. The request repeatedly evaluates the
   global selector through internal batches (at most 100 standard jobs per
   batch), beginning from the approved point-in-time snapshot; the frozen IDs
   are audit evidence, not a request-bound allowlist. Keep ingestion, local
   scoring, cron, the persistent watcher, and all user lifecycle mutations
   quiescent until the one-shot request finishes. For a clean single-flight
   slot, require `created: true`, `resumed: false`, `status: queued`, and
   `phase: queued`; any other result is a stop condition. Also confirm that the
   projected context plus standard batches fit within the watcher's two-hour
   request timeout:

   ```bash
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail; cd /opt/career-dashboard
     node scripts/with-env.mjs npm run --silent scoring:request -- --source repair_20260809
   '
   ```

   While the persistent watcher remains disabled, consume only that request with
   the one-shot watcher on the Mac:

   ```bash
   cd '/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard'
   node scripts/with-env.mjs npm run --silent scoring:watch:once
   ```

   A zero watcher exit is not sufficient: query `/api/scoring/requests` and
   require the same request ID to be `completed`, with no error and no active
   single-flight key. Re-run `scoring:audit` and strict readiness. Both
   `contextJobIds` and `projectedAllWaveStandardCandidateIds` must now be empty.

   Reconcile actual request membership from immutable evidence rather than
   assuming the projection was binding:

   - collect distinct `JobScoreEvent.jobId` values where `requestId` is the
     completed request and `evaluationType = 'standard'`;
   - collect the union of `ContextRuleRevision.sourceJobIds` for that request;
   - separately collect frozen standard IDs that ended in `needs_jd` without a
     score event;
   - require every actual standard/context ID to belong to its corresponding
     frozen set, and require every frozen ID to reconcile to its request-bound
     event or an explicitly reviewed `needs_jd`/actionable state.

   Any actual request-bound ID outside the frozen sets is the enforceable stop
   condition. Require no new V6.5.1/V6.7.1 authority.
10. Restart and verify the persistent Mac watcher first so future requests have a
   claimant. Then, with no active request, run strict readiness and cron enable in
   one fail-closed Pi shell so no stale audit result can be reused:

   ```bash
   # Mac
   cd '/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard'
   node scripts/with-env.mjs npm run --silent scoring:watch:install
   launchctl print "gui/$(id -u)/com.josephlamb.career-dashboard-native-scoring"

   # Pi
   sudo -- runuser -u j85473 -- bash -c '
     set -Eeuo pipefail
     cd /opt/career-dashboard
     node scripts/with-env.mjs npm run --silent audit:repair-readiness -- --strict --expect-repair-applied --expect-tasks-seeded
     bash scripts/deployment/install-crontab-remote.sh /opt/career-dashboard "" career-dashboard enable
     crontab -l
   '
   ```

   The installer must report a verified schedule containing exactly one managed
   `cron:pipeline` trigger. Do not enable cron first: it can create a native
   request before a claimant is running.
11. Use the repository's staged-release workflow throughout so the
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
