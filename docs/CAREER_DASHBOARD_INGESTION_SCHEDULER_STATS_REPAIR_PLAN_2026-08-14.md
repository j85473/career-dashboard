# Career Dashboard Ingestion Scheduler and Stats Repair Plan

Date: 2026-08-14
Status: Implemented and locally validated; production acceptance pending
Project: `/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard`

## 1. Authority boundary

This document defines the intended implementation and validation sequence for
the ingestion scheduler, ATS work allocation, provider circuits, durable task
lifecycle, and the operational Stats view.

This document does not itself authorize a commit, GitHub push, Raspberry Pi
deployment, production data repair, feature-flag change, or live provider call.
Those actions require Joseph's explicit instruction. A future implementation
must preserve unrelated worktree changes and stage only the paths that belong
to this plan.

Production findings in this document are point-in-time evidence from August 14,
2026. They must be refreshed before implementation decisions or production
claims are made.

## 2. Problem statement

The Stats page currently combines fundamentally different conditions under the
single label `due`:

- runnable ingestion work;
- running tasks whose prior eligibility timestamp is old;
- provider-circuit cooldowns;
- daily or monthly budget blocks;
- failed tasks waiting for retry;
- retired task rows;
- and a synthetic scheduler bookkeeping row dated January 1, 1970.

At the same time, the ingestion scheduler has real operational defects:

- successful cadence is calculated from task start rather than completion;
- ATS platform tasks use a 15-minute interval even though sweeps can take hours;
- ATS platforms execute sequentially from a global oldest-1,000-board snapshot;
- a large Workday workload can prevent Workable and other platforms from
  receiving a turn;
- Workday job-description hydration happens inline during board discovery;
- blocked tasks can become eligible before the provider is actually available;
- and provider-circuit writes can lose reliability to transaction conflicts.

The repair must correct both the scheduler behavior and the operator-facing
representation without deleting historical evidence or weakening ingestion
reconciliation.

## 3. Confirmed baseline evidence

The following was observed through read-only production database inspection at
approximately 11:55 AM CDT on August 14, 2026:

- 541 ingestion-task rows satisfied the current `due` predicate.
- 526 of those rows had status `blocked_circuit`.
- Three were `blocked_budget`, three were `failed`, one was `partial`, one was
  `queued`, and seven were `succeeded`.
- The `scheduler:v2:legacy-orchestration` row had `nextRunAt` equal to
  `1970-01-01T00:00:00.000Z`, producing `due 20679d ago` and the December 31
  header date in Chicago time.
- `native-ae-request` remained in `IngestionTask` despite being absent from the
  canonical task catalog.
- `ATS-workable` had remained queued for roughly four days, had never completed,
  and had no watermark.
- The active Workday task had started at approximately 6:51 AM CDT, retained a
  healthy heartbeat and lease, and had reached only 115 of 369 boards roughly
  five hours later.
- Several completed ATS tasks were already overdue when they finished because
  their 15-minute `nextRunAt` was calculated before their multi-hour actions.
- Multiple ATS tasks contained a `providerCircuit.update()` transaction
  conflict/deadlock error even when their main ingestion outcome was successful.

These observations prove that the page has cosmetic classification defects and
that ATS scheduling, provider availability, and task lifecycle also need real
behavioral repair.

## 4. Target invariants

The implementation must establish these invariants:

1. `nextRunAt` means only "not eligible before this timestamp."
2. A successful task's cadence is anchored to its actual completion time.
3. For a successful active task, `nextRunAt >= lastCompletedAt`.
4. A task cannot be claimed while its provider is in a durable circuit or
   budget block.
5. A blocked task's `nextRunAt` is no earlier than the provider's real retry or
   reset time.
6. Only active search tasks are claimable and counted as runnable work.
7. Orchestration and retired tasks cannot affect runnable counts or the next
   runnable timestamp.
8. Every due ATS platform gets a bounded turn even when Workday has a large
   backlog.
9. No individual ATS batch can monopolize the scheduler indefinitely.
10. Every observed candidate reconciles to inserted, duplicate, deterministically
    filtered, or processing error.
11. Description-unknown jobs are not rejected for description-dependent reasons.
12. Provider state cannot silently diverge from provider requests because a
    transaction conflict was only logged.
13. Stats task categories are mutually exclusive and reconcile to the active
    search-task total.

## 5. Non-goals

This plan does not redesign Aim Fit, Experience Fit, manual scoring exchange,
job-list ranking, application lifecycle, or resume tailoring. It does not
restore Dashboard-native model calls or `native-ae-request`. It does not delete
historic ingestion tasks, source runs, events, observations, incidents, or
watermarks.

## 6. Phase 1: Characterize the defects before changing behavior

Add regression tests that reproduce the current defects:

- the scheduler bookkeeping row becomes the minimum `nextRunAt`;
- a two-hour successful task with a 15-minute interval finishes overdue;
- a Workday-heavy global selection can exclude Workable indefinitely;
- a task is considered due while its provider has a future `openUntil`;
- a retired catalog task remains visible and claimable;
- provider success/failure updates can surface an unretried Prisma `P2034`;
- and a running task displays its prior eligibility timestamp as its next run.

Capture a fresh read-only production baseline immediately before implementation:

- active, running, runnable, blocked, failed, retired, and orchestration task
  counts;
- oldest runnable task by source;
- due ATS boards by platform;
- task duration and throughput by ATS platform;
- current provider circuits and exact retry times;
- stale leases and counter mismatches;
- and `needs_jd` arrival and drain rates.

The characterization tests must fail for the intended reason before the repair
and pass after it.

## 7. Phase 2: Add an explicit durable task lifecycle

### 7.1 Expand-only schema

Add the following non-destructive fields to `IngestionTask`:

- `taskKind`: string with initial values `search` and `orchestration`;
- `lifecycleStatus`: string with initial values `active` and `retired`;
- `retiredAt`: nullable timestamp.

Add an index supporting:

`taskKind + lifecycleStatus + status + nextRunAt`

Use an additive migration. Do not drop or reinterpret any existing column.

### 7.2 Backfill

The migration or guarded repair must:

- classify `scheduler:v2:legacy-orchestration` as orchestration;
- classify `native-ae-request` as retired;
- classify current canonical ingestion definitions as active search tasks;
- preserve every existing run, event, observation, cursor, and watermark;
- and avoid mutating currently leased rows.

### 7.3 Catalog reconciliation

Extend `scripts/seed_ingestion_tasks.ts` into a catalog reconciliation command:

- `--dry-run` reports additions, reactivations, retirements, and unchanged rows;
- `--apply` applies exactly the previewed catalog membership;
- both modes emit the canonical task-key hash;
- leased/running tasks cannot be retired;
- and a previously retired optional provider is reactivated if it returns to
  the configured catalog.

Task claiming must require `taskKind=search` and `lifecycleStatus=active`.

## 8. Phase 3: Centralize completion-based scheduling

Create one scheduler-owned completion policy in `src/lib/ingestionControl.ts`.
Individual routes must no longer precompute a completion timestamp before their
work begins.

Stop passing a precomputed `taskNextRunAt` through ingestion. Pass the task's
cadence or scheduling policy instead, and calculate the timestamp from the
actual completion time.

Use this outcome matrix:

| Outcome | `nextRunAt` policy |
|---|---|
| Successful or idle | `finishedAt + normal cadence` |
| Partial or failed | `finishedAt + bounded retry delay` |
| Circuit blocked | durable provider `openUntil + deterministic jitter` |
| Daily budget blocked | next UTC daily reset + deterministic jitter |
| Monthly budget blocked | next UTC month boundary + deterministic jitter |
| ATS batch has more due work | `finishedAt + short continuation delay` |
| Retired | never claimable; timestamp ignored |

Both route-based ingestion and `jobIngestion.finishIngestion()` must use the
same completion helper. Preserve successful watermark advancement and preserve
the rule that partial/failed work retains the last successful watermark.

Add a readiness invariant that reports any successful active task whose
`nextRunAt` is earlier than `lastCompletedAt` beyond a small clock tolerance.

## 9. Phase 4: Make provider availability authoritative

### 9.1 Exact retry time

Extend provider budget decisions to include `retryAt` as well as `reason`:

- `circuit_open`: durable `ProviderCircuit.openUntil`;
- `daily_budget`: next UTC daily reset;
- `monthly_budget`: first UTC instant of the next month;
- provider failure: the failure-policy cooldown.

The task completion helper must use that exact constraint.

### 9.2 Deterministic jitter

Many query tasks share one provider. Apply deterministic task-key-derived jitter
after the shared provider becomes available. Start with a configurable zero to
30-minute window. This avoids waking hundreds of tasks simultaneously while
keeping scheduling repeatable and testable.

### 9.3 Claim-time protection

Before claiming a source task, recheck durable provider availability. A stale
task timestamp must not override an active provider circuit or budget block.

### 9.4 Transaction conflict repair

Create one bounded transaction-retry helper for provider circuit and incident
mutations:

- retry only serialization/write conflicts such as Prisma `P2034`;
- use bounded exponential backoff with jitter;
- stop after a fixed attempt limit;
- and preserve/report the terminal error.

Reduce write contention and semantic flapping:

- do not record provider success once per successful ATS board;
- coalesce routine success to one update per provider/task batch;
- record hard failures immediately;
- prevent an older success from closing a newer failure by conditioning updates
  on event timestamps;
- and classify exhausted provider-state persistence as a task-level partial or
  control failure rather than silently reporting full success.

### 9.5 Correct failure scope

Differentiate these cases:

- one dead or retired ATS board updates only that `AtsCompany`;
- platform-wide 429/rate limiting throttles or opens the platform circuit;
- credentials or provider-wide schema failure opens the provider circuit;
- and quota exhaustion blocks until the real reset.

A single board returning 404 must not open the entire ATS platform circuit.

## 10. Phase 5: Replace monolithic ATS sweeps with fair bounded batches

### 10.1 Fair platform dispatch

Replace the global oldest-1,000-board selection with:

1. Discover all platforms that have due boards.
2. Order platforms using their durable task eligibility and last completion.
3. Select a bounded batch of the oldest due boards for each platform.
4. Run at most one bounded batch per platform during a scheduler pass.
5. Return to the rest of the pipeline before beginning another ATS round.

Use these initial configurable canary values:

- `ATS_BOARD_BATCH_SIZE=25`;
- `ATS_BATCH_WALL_CLOCK_MS=600000`;
- `ATS_CONTINUATION_DELAY_MS=60000`;
- preserve global ATS request concurrency at five initially.

These are rollout starting values, not permanent unreviewed constants.

If a platform still has due boards, schedule a short continuation. If it has no
remaining work, use its normal completion-based cadence.

### 10.2 Durable resume behavior

Continue using `AtsCompany.nextCheckDate` as the authoritative board queue:

- completed boards move into the future;
- failed boards receive their correct backoff;
- unprocessed boards remain due;
- and an interruption resumes from the oldest remaining boards.

Enhance the task cursor with:

- platform;
- selected count;
- completed count;
- remaining due count;
- current board;
- batch start time;
- and last update time.

The cursor is progress evidence, not a replacement for the board queue.

### 10.3 Defer Workday descriptions out of board discovery

Workday listing discovery must stop hydrating every job description inline.

The bounded discovery path should capture:

- source identity;
- title;
- company;
- location;
- canonical job URL;
- posted/updated time when available;
- and enough provenance to resume description recovery.

Resolve known source observations and exact duplicates immediately. Apply only
deterministic title/location hard filters before full description availability.
Do not reject a job because evidence that requires the JD is still unknown.

If the listing payload lacks a scorable description, save an eligible survivor
with `scoringStatus=needs_jd`. The existing bounded JD recovery lane must own
full description retrieval. ATS platforms whose listing API already returns a
complete JD can continue producing `queued` jobs directly.

### 10.4 Coverage canary

Before broad Workday deferral is enabled:

- run a bounded Workday canary;
- reconcile every listing candidate to inserted, duplicate, deterministic
  filter, or processing error;
- verify description-unknown candidates are not rejected for JD-dependent
  reasons;
- compare `needs_jd` arrival rate with recovery throughput;
- and keep the canary limited if that queue grows without bound.

Do not trade scheduler freshness for an unbounded JD-recovery backlog.

## 11. Phase 6: Replace the Stats `due` model with availability states

### 11.1 API categories

Change the task portion of `src/app/api/stats/route.ts` to return mutually
exclusive categories:

- `running`;
- `runnableNow`;
- `scheduled`;
- `circuitCooldown`;
- `budgetBlocked`;
- `failedAwaitingRetry`;
- `staleLease`;
- `retired`;
- `orchestration`.

Return these summary fields:

- active search-task count;
- runnable-now count;
- oldest runnable-since timestamp;
- running count;
- stale-lease count;
- circuit-cooldown count;
- budget-blocked count;
- failed count;
- retired count;
- and next future runnable timestamp.

Join task availability to `ProviderCircuit`. Exclude retired and orchestration
rows from runnable counts and future eligibility calculations.

If an additive response transition is needed, retain the old fields for one
release while marking them deprecated in the TypeScript response shape. Remove
them after the new UI is verified.

### 11.2 UI behavior

Replace the single mixed `Due backlog & checkpoints` table with views or
sections for:

- running now;
- runnable backlog;
- provider cooldown and budget blocks;
- recent checkpoints;
- and retired tasks hidden by default.

Display rules:

- running tasks show start time, elapsed time, heartbeat freshness, and progress;
- runnable tasks say `eligible for 14h`, not `due 14h ago`;
- cooldown tasks say `blocked until <time>`;
- scheduled tasks show their future eligibility;
- retired and orchestration tasks do not appear in the default backlog;
- the header says `Next runnable`, not `Next due`;
- truncated tables disclose the shown and total row counts;
- and stale leases remain an explicit danger state.

The scheduler sentinel must never render as `20679d ago`, and it must never
control the header timestamp.

## 12. Phase 7: Guarded one-time data repair

After the additive migration and compatible application code are deployed:

1. Generate a zero-write catalog reconciliation preview.
2. Verify the exact orchestration, retirement, activation, and reactivation set.
3. Refuse to mutate leased tasks.
4. Apply the catalog reconciliation.
5. Rebase unleased blocked tasks to durable provider eligibility.
6. Spread shared-provider retries with deterministic jitter.
7. Preserve all historical rows and watermarks.
8. Leave Workable runnable so the fair scheduler earns a real checkpoint; do
   not fabricate a completion or watermark.

The repair command must print before/after counts and be idempotent.

## 13. Phase 8: Verification

### 13.1 Unit and contract coverage

Add tests for:

- completion-based success cadence;
- partial/failed retry cadence;
- circuit, daily budget, and monthly budget eligibility;
- deterministic reset jitter;
- retired/orchestration claim exclusion;
- catalog retirement and reactivation;
- fairness with 10,000 Workday boards and one Workable board;
- continuation after a wall-clock stop;
- Workday routing to `needs_jd`;
- no JD-dependent rejection while description is unknown;
- provider transaction retry and retry exhaustion;
- an older success not closing a newer failure;
- mutually exclusive Stats categories;
- task-category reconciliation to the active total;
- scheduler/retired exclusion from `nextRunnableAt`;
- running-task progress presentation;
- and truncated-table disclosure.

### 13.2 Database validation

Use a dedicated disposable database, never production, for:

- Prisma format, generation, and validation;
- expand-migration policy checks;
- migration from a production-shaped pre-change schema;
- reconciliation dry-run and apply;
- idempotent second apply;
- concurrent provider reservation/success/failure stress testing;
- and proof that the repair preserves leased rows.

### 13.3 Repository validation

Before any deployment:

- run targeted ingestion, Stats, migration, and deployment tests;
- run the full test suite;
- run full lint;
- run the production Next.js build;
- run `git diff --check`;
- inspect the dirty worktree;
- and stage only the intended paths.

Unrelated current modifications and scratch files belong to Joseph and must not
be reformatted, reverted, staged, or absorbed into this work.

## 14. Rollout sequence

Use three separately reviewable deployment units.

### Deployment unit A: Lifecycle and observability

- additive schema migration;
- catalog lifecycle and reconciliation preview;
- Stats availability categories;
- no scheduler behavior change yet.

### Deployment unit B: Scheduling and provider correctness

- completion-based timestamps;
- circuit/budget-aware retries;
- transaction-conflict retry;
- provider-state coalescing and event-order protection.

### Deployment unit C: Fair ATS batching

- bounded per-platform dispatch;
- progress cursor;
- Workday detail deferral;
- `needs_jd` canary and gradual enablement.

Place behavioral changes behind a temporary
`INGESTION_SCHEDULER_V3_ENABLED` feature gate. Deploy initially with the gate
off, verify migration and read compatibility, then enable a controlled canary.

A GitHub push triggers the normal Raspberry Pi deployment. Do not run a second
manual deployment unless the GitHub-driven deployment is verified to have
failed. Verify release, migration, service, cron, scheduler, and application
state before claiming production success.

Rollback uses the feature gate and prior application release. The additive
schema remains compatible and does not require a destructive rollback.

## 15. Production acceptance gates

The repair is complete only after all of the following are verified on the Pi:

- the scheduler row is absent from active and next-runnable calculations;
- `native-ae-request` is retired and unclaimable;
- no successful task has `nextRunAt < lastCompletedAt`;
- no blocked task is scheduled before its real provider eligibility;
- every due ATS platform receives a bounded turn under Workday backlog;
- Workable records a real checkpoint instead of remaining permanently queued;
- ATS task duration respects the batch wall-clock bound, apart from a documented
  graceful completion allowance;
- there are no stale leases;
- there are no unhandled provider-circuit transaction conflicts during a
  24-hour observation window;
- paid-provider counters do not exceed configured budgets;
- Stats availability categories are mutually exclusive and reconcile to the
  active search-task total;
- no synthetic 1970 timestamp or `20679d ago` label remains;
- Workday listing candidates reconcile exactly;
- the `needs_jd` queue is stable or shrinking after Workday deferral;
- release, migration, service, cron, and scheduler heartbeat are verified;
- and at least one complete post-change pipeline cycle is observed before the
  work is described as production-complete.

## 16. Expected implementation map

Primary paths expected to change:

- `prisma/schema.prisma`
- a new additive migration under `prisma/migrations/`
- `src/lib/ingestionControl.ts`
- `src/lib/ingestionTaskCatalog.ts`
- `src/lib/jobIngestion.ts`
- `src/app/api/pipeline/run/route.ts`
- `src/app/api/stats/route.ts`
- `src/components/StatsTab.tsx`
- `scripts/seed_ingestion_tasks.ts`
- `scripts/audit_repair_readiness.ts`
- focused ingestion, Stats, migration, and deployment tests

This is an expected map, not permission to stage every listed file blindly.
Each diff must be tied to an explicit phase and reviewed against the existing
dirty worktree.

## 17. Continuation guidance

A future implementation run should begin by:

1. Reading this file completely.
2. Inspecting current Git status and the committed baseline.
3. Refreshing the production evidence read-only.
4. Confirming the relevant current Next.js documentation before modifying App
   Router code.
5. Turning the phases into a tracked execution plan.
6. Implementing locally through validation without committing, pushing,
   deploying, repairing production data, or enabling production flags unless
   Joseph explicitly authorizes those actions.
