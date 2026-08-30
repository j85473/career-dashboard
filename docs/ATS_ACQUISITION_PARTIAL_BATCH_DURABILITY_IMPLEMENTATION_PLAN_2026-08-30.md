# ATS Acquisition Partial-Batch Durability Implementation Plan

- Date: 2026-08-30
- Status: Phase 0A, Phase 0B, and Phase 1 implemented and validated locally; not committed, pushed, deployed, migrated in production, converted, or activated
- Repository: `/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard`
- Evidence commit: `e461aa5f94d9e5ab37857134f49728bd0799abb5` (`main` and `origin/main` matched)
- Production host inspected read-only: `j85473@192.168.1.208`

## 1. Authority boundary

This document is the implementation handoff for a new chat. It records the
confirmed mechanics of ATS acquisition-side partial-batch congestion and the
recommended permanent design.

The investigation was read-only. It did not implement code, restart a process,
commit, push, deploy, change configuration, or modify production data. Creating
this requested Markdown plan is the only workspace change made by the
investigation.

This plan does not itself authorize a commit, push, Raspberry Pi deployment,
production migration, data conversion, feature-flag change, or live repair. A
future implementation must preserve unrelated worktree changes and stage only
the intended paths. At investigation time, the unrelated untracked file
`scripts_queue_check_tmp.ts` was present and must remain untouched.

All production counts below are point-in-time evidence. Refresh them before an
implementation or release decision. Source line references are anchored to the
evidence commit above; search by symbol after the code moves.

Production was not inferred from a possibly divergent checkout. Read-only
SHA-256 checks matched the deployed and local copies of
`src/lib/atsAcquisition.ts`, `src/lib/atsAcquisitionLoop.ts`,
`src/lib/atsJobEnrichment.ts`, and `src/lib/ingestionTaskCatalog.ts`. The
relevant production environment overrides for selection size, acquisition
concurrency, pages per claim, request timeout, and lease duration were unset, so
the source defaults described below were active.

## 2. Decision summary

The partial batches are generally making real, durable, monotonic progress.
They are not repeatedly replaying their completed listing pages or completed
enrichment prefix under normal operation. The congestion comes from the cost
and scheduling semantics of each small progress unit:

1. One worker claim advances at most two listing pages or 25 enrichment items.
2. Every listing-page checkpoint rewrites the entire accumulated JSON payload.
3. Every single enrichment item, including a no-network marker, rewrites the
   entire payload again.
4. Detail calls are sequential and may each use the 10-second request timeout.
5. All due `fetching` and `partial` boards are selected before any new daily
   board, and a turn may contain 25 resumptions.
6. Four FIFO workers must finish that entire 25-board turn before another
   selection occurs.
7. A clean partial becomes due again after 60 seconds. Slow turns often last
   longer than that, so the same partials are eligible for the next turn.
8. No-request enrichment claims do not update `lastAttemptedAt`; the selector's
   oldest-attempt ordering keeps them near the front.
9. The consumer watermark measures only `queued` and `processing` jobs. Large
   acquisition payloads can therefore consume acquisition capacity while the
   persistence queue correctly reports little or no pressure.

This creates an O(n-squared)-like write-amplification loop on large boards and
allows a few dozen partial batches to occupy most acquisition worker time.
Yesterday, partial claims consumed 85.5% of measured acquisition worker-hours,
while the current distinct-contact metric reached only 2,430 of the 6,200 daily
target. Because detail-only resumptions can set `contactedAt`, true new-cycle
listing coverage was no higher than 2,430 and cannot be reconstructed exactly
from the current receipt schema.

The permanent solution is not a larger chunk, a longer timeout, more workers,
or a fixed resume quota by itself. The recommended design has four coupled
parts:

- an immutable page and item ledger so progress writes are proportional to new
  work rather than total accumulated payload size;
- bounded, independently dispatched work quanta with exact checkpoint and
  fencing semantics;
- an elastic coverage/continuation scheduler that reserves capacity for new
  daily-cohort contacts while guaranteeing fair continuation progress;
- bounded immutable consumer segments with separate acquisition-staging and
  persistence-backlog controls.

## 3. Metric definitions

These grains must remain distinct throughout implementation and validation.

| Term | Definition | Current limitation |
|---|---|---|
| Endpoint identity | Distinct `(slug, platform)` | Correct identity grain for board coverage |
| Attempt receipt | One `AtsBoardCheckAttempt` created for one worker claim | A claim is not a unique endpoint check |
| Current contacted metric | Distinct endpoint whose attempt `contactedAt` falls in the Chicago day | `contactedAt` is also set by detail-only resumptions, so it can overstate true listing-sweep coverage |
| New-cycle listing contact | First listing request for a newly admitted board cycle | Not explicitly represented today; this must become the 6,200/day authority |
| Listing continuation | A later page for an already admitted batch | Required progress, but not a new daily-cohort admission |
| Detail continuation | Enrichment/detail work for an already listed item | Required progress, but not a listing endpoint check |
| Acquisition staging | `fetching`/`partial` page and item data not yet handed to persistence | Not included in the current persistence watermark |
| Persistence backlog | `SUM(jobCount - processingOffset)` for `queued`/`processing` batches | Correct current downstream-pressure metric |
| Synchronized | Acquisition and required enrichment finished and a durable handoff exists | Must remain separate from processing completion |
| Processed | Consumer reconciled all handed-off jobs | Transport or synchronization alone does not prove usable output |

The new design must report at least these daily Chicago-local lifecycle counts:

1. new-cycle listing contacts;
2. any listing endpoint contacts, including continuation pages;
3. listing responses;
4. batches synchronized;
5. segments and jobs processed;
6. failed, deferred, and safety-blocked work.

Do not silently replace historical `contactedAt` charts with a differently
defined metric. Introduce the exact metric with a labeled effective date and
retain the old series as claim-contact telemetry.

## 4. Confirmed production evidence

### 4.1 Closed Chicago day: 2026-08-29

| Lifecycle grain | Receipts | Distinct endpoints | Interpretation |
|---|---:|---:|---|
| Any attempt receipt | 4,654 | 2,433 | Worker claims, including zero-contact claims |
| Actually contacted under current metric | 4,344 | 2,430 | 39.2% of 6,200; shortfall 3,770 |
| Responded | 4,245 | 2,336 | Provider response reached the receipt |
| Synchronized | 2,284 | 2,284 | Acquisition handoff completed that day |
| Partial | 2,078 | 303 | 44.7% of all receipts came from only 303 endpoints |

Those receipts recorded 29,511 provider requests and 3,788 listing pages. Raw
request and page totals are workload measures; neither is unique endpoint
coverage.

The earlier observed value of 2,077 partial receipts was accurate at that check.
One `deliveryhero` claim started at 04:57:42Z, still August 29 in Chicago, and
finalized as `partial` at 05:00:49Z. The append-only row's final outcome became
visible after the earlier snapshot, reconciling the one-row difference.

Of the 303 endpoints that produced partial claims:

- 270 synchronized during the same Chicago day;
- 22 synchronized the following day;
- 11 had not synchronized by the final investigation snapshot;
- 1,782 partial receipts belonged to 292 batches that were later processed;
- 296 partial receipts belonged to the 11 batches still partial.

Therefore 96.4% of those endpoints eventually synchronized by the audit. The
problem is not wholesale loss or restart-from-zero behavior; it is the number
and cost of continuation claims.

There were 1,775 repeat partial claims beyond the first partial receipt for each
endpoint. Those claims account for roughly 80% of the day's 2,221 duplicate
endpoint receipts.

### 4.2 Where acquisition time went

| Partial-claim kind | Claims | Endpoint count | Provider requests | Runtime evidence |
|---|---:|---:|---:|---|
| Listing-page partial | 993 | 301 | 5,252 | 3.76 worker-hours |
| Detail-network-only partial | 899 | 119 | 17,808 | Avg 94.5s; p50 75.3s; p95 220.4s |
| Zero-network enrichment partial | 186 | 52 | 0 | 2.03 worker-hours; avg 39.4s |
| All partials | 2,078 | 303 | — | 29.405 worker-hours; 85.5% of measured acquisition time |
| Synchronized claims | 2,284 | 2,284 | — | 3.717 worker-hours; 10.81% of measured acquisition time |

The zero-network row is decisive: a claim can consume tens of seconds without a
provider call because it serializes and rewrites the full JSON payload once for
each of 25 marker-only items.

From 18:00 through 20:59 CDT, partial claims occupied approximately 3.38, 3.51,
and 3.54 of the theoretical four worker-hours after clipping each attempt to
the hour boundary. First endpoint receipts fell to 65, 50, and 43 per hour.
This is direct evidence of acquisition-worker monopolization during the active
period.

Some hours also had service or pipeline gaps. Partial congestion is the
confirmed dominant capacity drain during active periods, but it should not be
claimed as the sole cause of every missed call in the closed day.

### 4.3 Live partial inventory

The user's earlier production baseline was 24 partial batches holding about
38,812 accumulated jobs, with only 45 jobs of consumer backpressure.

During this investigation, read-only snapshots evolved as follows:

| Snapshot | Partial batches | Accumulated batch `jobCount` | Queued/processing jobs |
|---|---:|---:|---:|
| 10:15:56 CDT | 30 partial plus 1 fetching | 43,610 | 0 |
| 10:19:24 CDT | 29 | 43,396 | 0 |
| 10:26:03 CDT | 27 | 43,842 | 0 |

The partial count fell while stored payload rows rose because some batches
completed while other paginated batches appended more pages. `jobCount` is the
current stored payload length, not remaining work: listing pages increase it,
prequeue compaction can reduce it to retained rows, and completion removes the
batch from the partial inventory. Original fetched count after compaction lives
in the compaction metadata. At one snapshot, the active set still needed 194
known listing quanta and 708 enrichment quanta for already listed items,
excluding enrichment for pages not yet fetched.

Seven parked partial batches held 21,725 accumulated jobs. They were Turner &
Townsend, Domino's, Bosch, AECOM, JYSK, H&M Group, and Palo Alto Networks.

### 4.4 Storage and process pressure

At the production snapshot:

- `AtsIngestionBatch` had 251,612 cumulative row updates;
- live batch payload data was about 37.05 MiB;
- its TOAST relation was about 428 MiB;
- total batch-table storage was about 446 MiB;
- current partial payloads accounted for about 30.8 MiB;
- the acquisition child used about 1.47–1.64 GiB RSS and approximately 144% CPU;
- the Pi used about 3.0–3.1 GiB of 3.7 GiB RAM and 1.8–1.9 GiB of 2 GiB swap.

PostgreSQL I/O timing and `pg_stat_statements` were not enabled, so these values
do not prove that every latency spike came exclusively from JSON serialization.
They do confirm severe whole-payload write amplification and process pressure
consistent with the long claim durations.

## 5. Exact congestion mechanics

The current loop is effectively:

```text
select up to 25 boards
  -> fill globally from due fetching/partial boards first
  -> four FIFO workers process the selected queue
  -> each board advances <=2 listing pages OR <=25 enrichment items
  -> every page/item checkpoints by replacing the full JSON payload
  -> wait for all four workers and all 25 selected boards
  -> wait 5 seconds
  -> most clean partials are already due again after their 60-second delay
  -> select the same resume-first population before untouched daily boards
```

### 5.1 Claim creation and batch reuse

- `src/lib/atsAcquisition.ts:835-855` reconciles an expired running attempt for
  the selected board.
- `src/lib/atsAcquisition.ts:857-891` reuses the one active
  `fetching`/`partial` batch or creates a new batch.
- `src/lib/atsAcquisition.ts:942-1015` creates a new
  `AtsBoardCheckAttempt` for every worker claim, even when the claim will make
  no provider request.
- The partial unique indexes in
  `prisma/migrations/20260827160000_ats_split_ingestion_paths/migration.sql:102-113`
  enforce one active acquisition batch and one running attempt per board.

An attempt count therefore measures scheduling claims, not unique endpoint
calls and not newly acquired jobs.

### 5.2 Listing pagination

- `src/lib/atsAcquisition.ts:92-95` defaults to two pages and 25 enrichment
  items per claim.
- `src/lib/atsAcquisition.ts:106-108` fixes Workday at 20 jobs per page and
  SmartRecruiters at 100 jobs per page.
- `src/lib/atsAcquisition.ts:1150-1212` fetches at most two pages, appends them
  to the in-memory array, then rewrites the entire accumulated payload for each
  page checkpoint.
- `src/lib/atsAcquisition.ts:1215-1231` returns `partial` when more pages remain.
- `src/lib/atsAcquisition.ts:1234-1265` commits listing completion before any
  detail request begins.

The current cursor freezes the first non-null provider total and declares the
listing complete on a short page or when `offset >= total`
(`src/lib/atsAcquisition.ts:1172-1178`). The cursor is durable, but the remote
offset-indexed result set is not a snapshot.

### 5.3 Compaction and enrichment

- Exact same-board terminal-observation compaction runs only after listing is
  complete (`src/lib/atsAcquisition.ts:1267-1418` and
  `src/lib/atsPrequeueCompaction.ts:53-180`). It is conservative and must remain
  fail-closed.
- `src/lib/atsAcquisition.ts:1421-1478` walks no more than 25 retained items
  sequentially.
- A detail call may use the full 10-second request timeout
  (`src/lib/atsAcquisition.ts:89-95,1431-1439`). Twenty-five sequential slow
  detail calls can therefore occupy a worker for several minutes.
- A no-detail outcome such as `description_already_present`,
  `title_gate_rejected`, `missing_detail_identity`, or `unsupported_platform`
  still receives a versioned terminal marker in
  `src/lib/atsJobEnrichment.ts:374-563`.
- After every item, including a no-network marker, lines 1453-1477 replace the
  entire jobs array and advance the enrichment cursor in one transaction.
- Only after every retained item has a current marker may the batch become
  `queued` or `processed` (`src/lib/atsAcquisition.ts:1499-1558`). A giant board
  cannot hand bounded ready portions to the otherwise idle consumer.

For a batch with `P` listing pages and `R` retained items after compaction, the
nominal clean-claim count is approximately:

```text
listing claims = ceil(P / 2)
additional enrichment claims = max(0, ceil(R / 25) - 1)
total clean claims = listing claims + additional enrichment claims
actual claims = clean claims + deferrals + transaction/provider failures + interruptions
```

The subtraction reflects that the final listing claim may also enrich its first
25 items.

Examples from production:

- Domino's advertised 24,666 SmartRecruiters jobs: about 247 pages, 124 listing
  claims, and up to 987 enrichment chunks before compaction effects—roughly
  1,110 clean claims in the upper-bound case.
- Panera accumulated roughly 2,735 Workday listings: about 137 pages, 69
  listing claims, plus roughly 110 pre-compaction enrichment chunks.
- The large Workable batch fetched 2,759 jobs and retained about 1,361 after
  exact compaction. At one snapshot it had reached enrichment offset 1,350
  through 54 partial claims; 53 claims made no provider request. Its expense was
  almost entirely marker inspection plus whole-array replacement.

### 5.4 Resume-first selection and the turn barrier

- `src/lib/atsAcquisition.ts:1759-1764` orders due boards by oldest
  `lastAttemptedAt`, then `lastCheckedAt`, `nextCheckDate`, and slug.
- `src/lib/atsAcquisition.ts:1844-1864` permits resumptions to consume the full
  selection limit. New boards get only the capacity left after resumptions.
- `src/lib/atsAcquisition.ts:1898-1973` globally selects all due active partial
  batches across assigned-day, catch-up, and recovery tiers before selecting a
  new board.
- `src/lib/atsAcquisitionLoop.ts:285-365` selects 25 boards, uses four FIFO
  workers, and waits for every worker before completing the turn.
- `src/lib/atsAcquisition.ts:1100-1134` makes a clean partial due again after 60
  seconds. The loop waits only five seconds after a completed turn
  (`src/lib/ingestionTaskCatalog.ts:62-64`).

When 25 or more partials are due, new daily-cohort capacity is zero. Even below
25, resumptions are at the head of the worker queue. A slow partial can keep a
later new board waiting inside the same turn.

There is no acquisition-side wall-clock deadline for the selected turn. The
`ATS_BATCH_WALL_CLOCK_MS` setting belongs to the legacy/parent processing path,
not this child acquisition loop. The child is bounded only by the per-request
timeout, page/item caps, stop signal, and renewable scheduler/attempt leases. A
live turn selected 25 boards and was still finishing after five minutes. The
five-second loop setting applies only after the entire turn returns.

The acquisition child has a four-connection Prisma pool, while the shared
transaction limiter permits only two concurrent interactive transactions
(`src/lib/pipelineWorkerProcess.ts:6-8` and
`src/lib/ingestionConcurrency.ts:14-54`). A detail item normally performs a
request-start marker transaction, a response-marker transaction, and a
whole-payload item checkpoint. Those chatty writes amplify contention even
before the next item starts.

No-request marker work never calls `onRequestStarted`, so it never refreshes
`AtsCompany.lastAttemptedAt`. The oldest-attempt sort can repeatedly favor that
board despite its recent CPU/database work.

There is no maximum clean-partial attempt count. A batch continues generating
new claim receipts until all listing and enrichment work finishes or a failure
schedule temporarily defers the board.

### 5.5 Backpressure is measuring a different stage

- `src/lib/atsAcquisition.ts:1766-1774,1976-1996` deliberately calculates
  persistence backlog only from `queued` and `processing` batches.
- New-board admission pauses at 2,000 remaining consumer jobs and resumes below
  1,000 (`src/lib/atsAcquisition.ts:82-88` and
  `src/lib/atsAcquisitionLoop.ts:285-290`).
- A separate limit allows 100 outstanding batches, but it counts rows rather
  than acquisition items, payload bytes, or predicted work.

This explains why 40,000-plus accumulated partial jobs can coexist with zero or
45 jobs of consumer pressure. It is not evidence that the downstream consumer
caused the congestion.

## 6. Advancement, replay, cursors, and leases

### 6.1 What is confirmed durable

Short-spaced production snapshots showed monotonic progress, including:

- Workable enrichment 1,325 -> 1,347;
- PwC enrichment 1,086 -> 1,100;
- Equinox enrichment 592 -> 609;
- Montefiore Workday listing offset 320 -> 360;
- New Balance listing offset 200 -> 209, followed by listing completion and
  enrichment progress;
- two active batches completing between snapshots.

Across 28 active batches:

- batch `pageCount` exactly equaled the sum of attempt `pageCount` values;
- batch `requestCount` exactly equaled the sum of attempt request counts;
- there were no page or request counter mismatches over 1,024 pages and 6,153
  requests;
- for listing-complete batches, 8,540 current enrichment markers exactly
  matched the durable enrichment offsets: 5,097 represented actual detail
  attempts and 3,443 represented no-detail outcomes.

Concrete listing cursors also matched page sizes:

- Domino's: 56 SmartRecruiters pages, offset 5,600;
- AECOM: 39 SmartRecruiters pages, offset 3,900;
- Bosch: 36 SmartRecruiters pages, offset 3,600;
- clean Workday resumptions advanced two pages and 40 jobs;
- clean SmartRecruiters resumptions advanced two pages and 200 jobs.

The listing-completion checkpoint prevents detail work from causing listing
page replay. During enrichment, the item replacement and cursor advance are
atomic. A committed current-version marker is skipped on resume.

Active partial batches do not yet have their final `payloadHash`; that hash is
written at synchronization. For a partial, the durable authorities are the
lease-fenced page count, cursor offset/total, payload occurrence count,
enrichment offset, and current-version marker prefix. Attempt `jobCount` is
cumulative payload size and must not be summed as delta progress.

### 6.2 Honest replay boundary

Normal restarts do not unintentionally replay a committed page within the same
listing generation or a committed enrichment prefix. A hard crash after an
external GET returns but before its checkpoint commits can repeat that one
ambiguous in-flight GET. With a read-only provider GET and no provider-side
commit handshake, exactly-once external execution is not achievable. The
durable guarantee must be stated as:

> No committed page is unintentionally fetched again within one traversal
> generation, and no terminal item is fetched again. At most one explicitly
> identified in-flight GET per killed work claim may be retried, and that retry
> is recorded as ambiguous/adopted work.

An offset-only provider may require a deliberate, separately labeled page
request at the same offset in a **new verification generation**. That is not a
checkpoint retry; it is required reconciliation work caused by the provider's
lack of a stable snapshot. It must be bounded, visible in request budgets, and
kept separate from unintended replay metrics.

The current schema lacks start/end page and item offsets on each attempt, so an
individual ambiguous detail replay cannot be audited directly. The new work
receipt must add that evidence.

### 6.3 Leases are not the primary cause

- Attempt leases default to 30 minutes and renew on request, response, page, and
  item checkpoints (`src/lib/atsAcquisition.ts:96-104,1041-1097,1457-1477`).
- Four running attempts observed in production all had fresh leases.
- No current running attempt was expired.
- Only one trailing-24-hour attempt represented an expired lease; it coincided
  with worker/deployment turnover.
- The systemd service had zero restarts. One attached acquisition child exit
  occurred, but its replacement had run more than ten hours at the final check.

Stale-attempt reconciliation is board-local and happens only after that board is
selected (`src/lib/atsAcquisition.ts:835-855`). A 30-minute orphan can therefore
waste selections through the one-running-attempt unique constraint, but this was
not the source of the observed mass congestion.

### 6.4 Pagination correctness risk

Current Workday and SmartRecruiters traversal uses offsets and a provider total.
The official SmartRecruiters Posting API documents `offset`, `limit`, and
`totalFound`, but no snapshot token. Workday's general REST documentation states
that ordinary REST collections use stable ID ordering, but the public CXS jobs
endpoint used by this repository is a different, undocumented contract and the
current request records no snapshot identity.

If jobs are inserted or removed before the current offset during an hours-long
scan, a durable offset can still duplicate or skip an identity. Production had
some repeated source IDs in active payloads, but this investigation did not
prove that a particular live job was skipped. Treat this as a confirmed design
risk, not a confirmed production loss.

## 7. Secondary retry defect

Current source supplies `{ maxWait: 10_000, timeout: 30_000 }` to every
transaction that rewrites a payload or finalizes a claim
(`src/lib/atsAcquisition.ts:111-125`). The live five-second failures come from
two high-frequency marker transactions that do not pass those options:

- request-start marker: `src/lib/atsAcquisition.ts:1041-1066`;
- response-received marker: `src/lib/atsAcquisition.ts:1069-1097`.

Since the current service activation, 24 stored receipts had a five-second or
invalid-transaction error. Eleven named `AtsIngestionBatch.update`, five named
`AtsCompany.update`, four were commit timeouts, three were transaction-not-found
errors, and one was another company-update error. No receipt reported a
30,000-millisecond deadline. The database stores only error text, not stack or
checkpoint phase, so generic commit failures cannot be assigned to one of the
two callbacks individually.

The failure schedule is:

1. retry after 15 minutes;
2. retry after 60 minutes;
3. park for one day;
4. later failure history may use seven- or thirty-day recovery states.

The batch stays partial and keeps its cursor, but the board-level backoff strands
that partial payload. When it becomes due, it re-enters the global resume-first
population. Explicitly bounding and tagging the two marker transactions is a
necessary containment repair, but it does not remove whole-payload
amplification or scheduler monopoly and is not the permanent solution.

Provider retry behavior is already more granular than those internal failures:
the base platform circuit is checked before an empty batch/attempt is allocated;
a detail-circuit or 429 deferral preserves the pending suffix and exact retry
boundary; and existing job-scoped 403/404 handling writes a terminal unavailable
marker and advances. All provider circuits were closed at the final production
snapshot. Circuit churn and lease expiry therefore did not explain the mass
partial congestion, although the permanent design must preserve these scopes.

## 8. Target invariants

The implementation is complete only when all of these invariants hold:

1. A new-cycle listing contact requires a durable confirmed transport outcome
   and is the authority for the approximately 6,200-per-Chicago-day admission
   target. Pre-call intent and crash-ambiguous dispatch are separate and do not
   satisfy the target.
2. Listing, detail, synchronization, and processing events remain separate.
3. A committed listing page is never fetched again as ordinary continuation in
   the same generation. Deliberate cross-generation verification requests are
   separately labeled, budgeted, and reconciled.
4. A terminal current-version item is never detail-fetched or re-marked again.
5. A crash may retry only explicitly ambiguous in-flight GET work.
6. Every raw fetched observation remains represented and resolves to canonical
   work, labeled verification/drift evidence, or an exact compaction receipt.
   Every canonical item then reaches inserted, exact duplicate,
   deterministically filtered, or processing-error evidence. Compaction does
   not erase the observation receipt.
7. One large board cannot consume all admission capacity.
8. Every eligible partial batch receives bounded continuation service; no board
   receives a second continuation quantum while an eligible peer remains
   unserved in the current round.
9. Progress transactions write only newly received pages, changed item state,
   or a bounded immutable segment—never the entire accumulated board payload.
10. Provider and internal-control retries use separate scopes. An internal
    transaction timeout cannot park a board as if its ATS endpoint failed.
11. Offset drift, short pages before the expected end, divergent page hashes,
    and total changes fail closed into explicit reconciliation; they never
    silently mark a batch complete.
12. Consumer publication is credit-gated and cannot push queued/processing work
    above its configured high watermark.
13. Acquisition staging is bounded independently by item count and bytes; a
    safety block is reported rather than dropping a response or silently waiving
    the daily target.
14. Existing Job lifecycle state and all existing Aim/Experience scores remain
    authoritative and untouched.
15. A feature rollback never resumes from an older JSON payload after the new
    ledger has advanced.

## 9. Recommended permanent architecture

### 9.1 Expand-only durable ledger

Keep `AtsIngestionBatch` as the board-cycle header. Replace its mutable jobs
array as the progress authority with additive page, item, work-receipt, and
segment records. Proposed names may change, but their contracts should not.

#### `AtsIngestionBatch` additions

Add scalar, indexed fields:

- `ledgerVersion`;
- `writerMode` (`legacy`, `converting`, `v2`);
- `acquisitionPhase` (`listing`, `compaction`, `enrichment`, `sealing`,
  `synchronized`);
- `nextAcquireAt`;
- `lastServedAt`;
- `listingGeneration`;
- `listingOffset`;
- `latestObservedTotal`;
- `listingCompletedAt`;
- `rawObservationCount`;
- `canonicalOccurrenceCount`;
- `compactedOccurrenceCount`;
- `terminalItemCount`;
- `sealedItemCount`;
- `publishedItemCount`;
- `acquisitionBytes`;
- `manifestHash`;
- a conversion/claim fencing token and lease fields distinct from consumer
  processing leases.

Add an `acquisitionEngine` marker to `AtsCompany` so the compatibility selector
can exclude v2-managed boards before it creates a legacy batch. Back it with the
database-enforced attempt/writer fence required by the migration sequence; an
application-only `if` is not sufficient protection from an old writer.

`AtsCompany.nextCheckDate` should govern admission of a new weekly board cycle,
not the next quantum of an existing partial. Existing work uses batch/item
`nextAcquireAt` and `nextDetailAt`.

#### `AtsIngestionPage`

Store one immutable **page observation** per listing generation and offset:

- `batchId`, generation, requested offset, requested limit;
- provider-reported offset and total;
- response/item count, response hash, identity-multiset hash;
- request/response timestamps and HTTP status;
- page metadata needed by normalization;
- unique `(batchId, generation, requestedOffset)`;
- an index for batch/generation/offset order.

The page is an observation, not yet canonical consumer work. For ordinary
20-/100-item pages, its occurrence rows may commit in the same transaction. A
provider with an unbounded non-paginated response can return thousands of rows;
for that case, durably store the immutable raw page body/hash once, then
materialize occurrence rows in bounded continuation chunks before declaring the
page/listing complete. Never require one multi-thousand-row coverage
transaction merely to make the response durable.

#### `AtsListingObservation`

Store every raw occurrence from every page generation:

- page ID, page ordinal, generation, provider source ID when available;
- raw hash and immutable raw JSON, or a page-blob slice/reference;
- unique `(pageId, pageOrdinal)`;
- indexes on batch/generation/source ID/raw hash.

Verification generations intentionally observe some of the same provider data
again. These rows are immutable evidence and are never addressed by a mutable
batch-wide observation ordinal.

#### `AtsListingObservationResolution`

Map every listing observation to one explicit result:

- a canonical acquisition item;
- an identical verification observation of an existing canonical item;
- a catalog-drift/transient observation retained in the pass union;
- an exact prequeue-compacted terminal receipt;
- or an unresolved anomaly that prevents listing completion.

Reconcile generations as a **multiset**, not a set. For a tuple such as
provider identity plus raw hash, the canonical union retains the maximum
multiplicity observed in a complete pass rather than summing identical
verification scans. Same source ID with different raw hashes/location variants
remains distinct. Missing IDs fail open and retain multiplicity. Every raw
observation receives a resolution receipt even when it does not create another
consumer work item.

#### `AtsIngestionItem`

Create canonical work items only after listing-generation reconciliation:

- `batchId`, immutable canonical ordinal, representative observation ID;
- provider source ID when available, raw hash, immutable raw JSON/reference;
- small enrichment overlay JSON rather than a rewritten raw object;
- enrichment version, status, reason, HTTP status, error;
- detail attempt count, `nextDetailAt`, `terminalAt`;
- item claim owner, fence, heartbeat, and lease expiry;
- unique `(batchId, canonicalOrdinal)`;
- indexes on batch/status/nextDetailAt/canonicalOrdinal and source identity.

Do not make `(batchId, sourceId)` unique. Offset drift or provider duplication
can legitimately expose the same identity more than once, and missing identity
must fail open. Preserve occurrences, then reconcile them conservatively.
The live one-response Workable payload illustrated why: 2,759 raw occurrences
contained only 618 shortcodes, including distinct payload/location variants.
Those repetitions were not replayed pages and must not be acquisition-dropped.

#### `AtsAcquisitionWorkReceipt`

Create an append-only receipt per bounded scheduler quantum, or add equivalent
fields to a purpose-specific successor of `AtsBoardCheckAttempt`:

- work type: `coverage_listing`, `listing_continuation`,
  `enrichment_network`, `enrichment_marker`, `seal`, or `publish`;
- start/end listing generation and offsets;
- start/end item ordinals;
- listing and detail request counts;
- items inspected, terminalized, and progressed;
- start/finish/heartbeat/lease/fence;
- yield reason (`page_budget`, `request_budget`, `time_budget`, `circuit`,
  `retry_at`, `complete`, `error`);
- checkpoint/manifest hash;
- explicit transaction phase on failure.

This separates worker scheduling telemetry from endpoint coverage.

#### `AtsEndpointSweepReceipt`

Add a small daily/cycle aggregate for a newly admitted board cycle:

- admission Chicago local day, slug, platform, batch ID;
- admitted, dispatch-intent, contact-confirmed, response, synchronization, and
  processing timestamps;
- state (`admitted`, `dispatching`, `contact_confirmed`, `ambiguous`,
  `responded`, `failed`);
- unique batch relationship and cycle identity;
- outcome and safety-block reason.

The unique sweep row must not suppress separately receipted dispatch retries.
One-to-many listing dispatch attempts belong in work receipts. Persist admission
and dispatch intent before the call, then persist a confirmed transport outcome
(response, timeout, or classified transport failure). A crash between intent
and observable transport outcome is `ambiguous`, does not count as a confirmed
contact, and may retry with a new linked dispatch receipt. Detail calls never
touch the sweep aggregate.

No application can prove the exact socket boundary across a process crash. The
daily authority is therefore distinct endpoints with a durable confirmed
listing transport attempt, not merely pre-call intent. Ambiguous attempts are
reported separately and counted once only after a retry or later outcome
confirms contact.

Materialize that authority as a separate `AtsEndpointDailyContactReceipt` when
transport becomes confirmed. Its `localDay` is derived from `contactConfirmedAt`
in Chicago—not from admission time—and it is unique on
`(localDay, slug, platform, contactKind)`. This handles an admission or ambiguous
retry that crosses local midnight without crediting the wrong day. Only
`contactKind=new_cycle_listing` satisfies the 6,200 admission target; listing
continuation remains visible but cannot substitute for a new cycle.

#### `AtsIngestionSegment`

Store immutable, bounded handoff manifests for contiguous terminal item ranges:

- batch ID, segment ordinal, first/last item ordinal, item count;
- manifest hash and enrichment version;
- status, processing counters, next process time;
- fenced consumer lease and heartbeat;
- unique `(batchId, segmentOrdinal)` and `(batchId, firstOrdinal, lastOrdinal)`.

The segment references item rows; it does not reassemble one giant JSON array.
Existing item-level `atsBatchItemKey` idempotency must remain authoritative for
Job writes.

Store one immutable `segmentSize` on the batch. Segment boundaries are derived
from `segmentOrdinal`, and the database must enforce non-overlap through derived
boundary checks or an exclusion constraint—not application convention alone.
Require `1 <= segment item count <= segmentSize < persistence high watermark`.

Do not drop the legacy `payload`, `metadata`, cursor, existing attempts, or
compaction receipt during migration. No cleanup belongs in this implementation.

### 9.2 Atomic checkpoint protocols

#### New-cycle coverage page

One coverage quantum performs exactly one initial listing request and no detail
work:

1. Atomically claim an eligible board and create its batch/work receipt with a
   fence.
2. Insert/adopt the daily endpoint-sweep admission row and a linked dispatch
   intent in a short explicitly bounded transaction.
3. Make one listing request. Persist response/timeout/transport outcome; an
   expired intent without an outcome becomes ambiguous rather than contacted.
4. In one transaction, insert the immutable page observation and its bounded
   occurrence rows, then compare-and-swap the expected batch generation/offset.
   For an oversized non-paginated response, first commit the immutable raw page
   blob/hash, then materialize observations in bounded fenced chunks.
5. Mark the work receipt's end cursor and yield immediately. The coverage metric
   advances only from a confirmed listing transport attempt.

On an uncertain commit, reread the unique page key. Adopt an identical response
hash and cursor; a divergent hash is catalog drift and must fail closed into a
new reconciliation generation. Never append the same page twice.

#### Listing continuation

Use a dual request/time budget for listing continuation. Start with no more than
five page requests and a 30–60-second soft deadline; stop before the next page
when either limit is reached. A page is 20 Workday or 100 SmartRecruiters items.
This bounds new page dispatches while avoiding hundreds of single-page revisits
for a 24,000-job board. The hard worker-hold/revisit bound additionally includes
one in-flight request and checkpoint overrun. Every page still commits
separately with its observations and cursor CAS, so a later page failure cannot
roll back the committed prefix.

Do not start enrichment until the listing pass reaches an explicit completion
condition and compaction is durably recorded.

#### Exact compaction

Port the current conservative same-board terminal-observation rules unchanged.
Instead of removing a canonical occurrence, resolve it to
`compacted_exact_terminal` and bind the existing receipt fields and identity
hash. Counts must reconcile at both grains:

```text
raw observations across all generations
  = canonical-mapped observations
  + verification/drift/compaction resolution receipts

canonical occurrences
  = retained items for enrichment/persistence
  + exact compacted terminal occurrences
```

Ambiguous, cross-board, missing-identity, incomplete, pending, inbox, or
reviewable observations remain retained.

#### Enrichment

Classify a bounded set of pending item rows with the existing
`preparedDetailPlan` semantics.

- Bulk-terminalize no-network markers in a bounded set-based write. Start load
  testing at 250–500 inspected rows, but enforce the time budget as the final
  authority.
- Start with no more than five actual detail GETs per quantum.
- Use a 30–60-second soft dispatch deadline: finish and checkpoint the current
  request, but do not start another request after the deadline.
- Keep provider-level concurrency conservative. Do not increase detail request
  parallelism until provider quota, 429 rate, and Pi resource evidence support
  it.
- Commit each network result to only that item row with its fence. Terminal
  current-version rows are not claimable again.
- A 403/404 or other existing job-scoped terminal condition retains the current
  explicit unavailable marker. A 429, circuit block, or retryable timeout leaves
  the item pending with `nextDetailAt` and does not advance it as terminal.

#### Segment sealing and publication

After listing and compaction complete, partition retained item ordinals into
deterministic bounded ranges. Start with 25 items to preserve the current
consumer checkpoint grain, then change it only from load evidence. Seal any
complete partition when every item in that partition is terminal; one deferred
item must block only its own partition, not every later terminal range. A
segment manifest is immutable once sealed, and final board reconciliation still
waits for every partition.

Publish a segment only if an atomic credit check proves:

```text
current queued/processing remaining jobs + segment item count <= 2,000
```

Pause publication at the high watermark and resume below 1,000. Enrichment may
continue into sealed-but-unpublished segments while separate acquisition
staging limits permit it. This lets the consumer drain bounded work without a
24,000-job handoff cliff.

The board cycle becomes synchronized only after all listing pages, compaction
rows, required enrichment states, and segment manifests reconcile. It becomes
processed only after all published segments reconcile downstream.

### 9.3 Elastic coverage and continuation scheduler

Replace the 25-board barrier with a continuous, work-conserving dispatcher. As
soon as a worker finishes one quantum, it asks for the next atomically claimed
unit. Keep total acquisition concurrency at four initially.

Use two logical lanes:

1. **Coverage lane:** one-page first contacts for newly admitted board cycles,
   using assigned-day, catch-up, and recovery admission tiers plus platform
   round-robin.
2. **Continuation lane:** listing pages, marker/detail enrichment, sealing, and
   publication for existing batches.

Do not hard-code a permanent 2+2 split. Use an elastic reservation controller:

- default to two coverage slots and two continuation slots;
- choose one to three coverage slots from Chicago-local coverage debt, remaining
  day length, and observed coverage-quantum latency;
- always reserve at least one continuation slot when eligible partial work
  exists;
- raise coverage reservation to three when the projected target completion is
  late;
- lend idle or ahead-of-target coverage capacity to continuation;
- lend an idle, circuit-blocked, or safety-blocked lane's capacity to the other
  lane, while recording why the target lane could not use it;
- pace contacts with a token bucket calculated over the actual 23-, 24-, or
  25-hour Chicago day and allow only a bounded catch-up burst.

Capacity evidence supports using two coverage slots as the initial scenario,
but it is not a throughput proof:

- 6,200 contacts per 24-hour day require one contact every 13.94 seconds;
- first claims for 2,534 batches yesterday averaged 5.20 seconds, with p50 2.33,
  p95 21.33, and p99 44.11 seconds;
- one lane continuously operating at the observed p95 would support only about
  4,050 contacts/day;
- two lanes continuously operating at that p95 would support about 8,100/day,
  with the 6,200 target using about 76.5% of that scenario capacity;
- yesterday's partial recovery consumed 29.4 worker-hours; two continuation
  lanes provide 48 worker-hours before the ledger removes most write
  amplification.

Inverting a p95 does not establish long-run service rate; the mean and the
slowest 5% control sustained throughput. Likewise, 29.4 historical partial
worker-hours came from only 2,430 distinct contacts under the old metric.
Restoring 6,200 admissions will create more listing continuation, detail,
marker, segment, and consumer work. The default is acceptable only if the
multiday steady-state simulation and production soak prove arrival rate below
service rate with bounded oldest age in every stage.

Within the continuation lane, use deficit round-robin across platform, phase,
and batch `lastServedAt`:

- one bounded quantum per eligible board per round;
- no board gets a second quantum while an eligible peer is unserved;
- deferred work sets an exact `nextAcquireAt`/`nextDetailAt` and is omitted until
  then;
- age boosts prevent low-volume platforms from starving;
- cost accounting distinguishes listing request, detail request, marker rows,
  and database time rather than treating every claim as equal.

With 29 due partials, two continuation workers, and a 60-second planning
quantum, the nominal revisit estimate is:

```text
ceil(29 / 2) * 60 seconds = 15 minutes, plus claim overrun and bounded jitter
```

The soft dispatch deadline alone is not a hard claim bound because an in-flight
request and its checkpoint must finish. Define and test a hard claim bound as
the soft deadline plus one request timeout, checkpoint timeout, and cancellation
margin. The scheduler must expose both the nominal estimate and the hard revisit
bound calculated from that configured maximum, then alert on violations.

### 9.4 Pagination reconciliation

For every page, persist the requested offset, response hash, identity multiset
hash, and the provider total observed on that response. Do not treat the first
total as immutable truth.

Rules:

1. A short or empty page before the currently expected end is an anomaly and
   retry/reconciliation condition, not silent completion.
2. The same `(batch, generation, offset)` and same hash is an idempotent adopted
   checkpoint.
3. The same key with a different hash is explicit catalog drift; preserve both
   evidence sets by starting a new generation, never overwrite the first page.
4. Total growth extends the pass. Total shrink is recorded and reconciled; it
   must not discard already observed occurrences.
5. Build a manifest from provider identity plus raw hash and occurrence count.
   Missing IDs remain separate occurrences.
6. For offset-only providers without a stable snapshot token, require a
   provider-specific convergence policy. The conservative default is a full
   verification pass and equality of consecutive identity manifests. Merge the
   union of observations across passes.
7. If a busy board does not converge within the configured pass/time budget,
   retain it as `unstable_partial`, keep the union, and schedule another bounded
   verification pass. Do not claim full completeness.

No finite offset algorithm can guarantee a complete snapshot under arbitrary
continuous mutation without provider support. This limitation must remain
visible. The implementation should first probe whether the exact Workday CXS
and SmartRecruiters responses expose a stable sort/cursor or snapshot token; use
one if verified from first-party behavior. Do not infer one from a total field.

The fail-open union deliberately favors not skipping an observed occurrence.
During catalog drift, it can retain a posting that disappeared in a later pass.
That transient/withdrawn occurrence must remain explicit source evidence and be
handled by normal exact-observation/closure semantics; it must not be silently
deleted to make two passes appear equal.

### 9.5 Backpressure and capacity controls

Keep two independent controls:

#### Persistence credit

Continue using queued/processing remaining jobs with the current 2,000/1,000
hysteresis. Make segment admission atomic so concurrent publishers cannot
collectively cross the high watermark.

#### Acquisition staging

Add high/low watermarks for:

- unprocessed item rows;
- immutable raw/enrichment bytes;
- sealed but unpublished jobs;
- oldest staged age;
- database disk and free-space safety margin.

Set production values only after load testing and a one-day shadow forecast.
When staging safety blocks new coverage, keep already admitted work recoverable,
continue eligible drain work, and record exact blocked seconds and reason. Never
make a provider call whose response cannot be durably stored.

Replace the current 100-outstanding-batch count as the primary admission
authority. A one-page coverage fast path can legitimately create more than 100
active cycles while continuation drains them, and one huge batch can dominate
storage while counting as only one. Retain only an emergency batch-count ceiling
derived from measured row/byte capacity; item, byte, age, and disk margins are
the normal gates.

The 6,200 target is an operating SLO, not permission to discard data or exceed a
safety bound. A blocked target must page the operator and remain visibly missed.

### 9.6 Retry, lease, and shutdown behavior

- Use short, work-unit leases derived from the maximum quantum plus checkpoint
  margin rather than a blanket 30-minute ownership window.
- Every commit requires the current fence; a stale owner cannot advance a page,
  item, or segment.
- Reconcile expired work receipts globally at child startup and periodically,
  not only when a particular board is selected.
- Keep the parent invariant that the old child PID closes before a replacement
  starts (`src/lib/pipelineWorkerProcess.ts:194-280`).
- Ensure graceful-stop allowance exceeds the maximum checkpoint duration. The
  current 15-second stop plus 5-second termination grace
  (`src/lib/pipelineWorkerProcess.ts:6-10,157-175`) is shorter than the current
  30-second payload transaction envelope; row-granular transactions should make
  that envelope unnecessary, but shutdown and checkpoint limits must still be
  validated together.
- Internal database/control failures use short internal retry with bounded
  jitter and an acquisition-control backoff. They do not increment provider
  failure state or park `AtsCompany` as if the remote board failed.
- Provider base and detail circuits retain their existing scopes. A circuit
  deferral writes the exact retry time and leaves pending items claimable only
  after it.

As an early containment item, explicitly bound and phase-tag the current
request-start and response-marker transactions. Do not stop the project there.

### 9.7 Telemetry contract

Add durable and Stats/API metrics for:

- first-listing contacts versus 6,200 target and required-by-now trajectory;
- predicted end-of-day coverage and coverage-debt minutes;
- contacts, responses, pages, details, synchronization, and processing as
  separate counters;
- worker-hours, p50/p95/p99 quantum duration, and requests by lane/phase;
- start/end cursor and progress units per work receipt;
- zero-progress and zero-network quanta with reason;
- per-batch known pages/items remaining and oldest eligible age;
- calculated continuation revisit bound and violations;
- total/identity/hash drift by provider;
- staging item/byte/age watermarks;
- sealed, published, queued, processing, and processed segment counts;
- ambiguous in-flight retry/adoption count;
- transaction failures tagged `request_marker`, `response_marker`,
  `page_checkpoint`, `item_checkpoint`, `seal`, `publish`, or `finalizer`;
- provider circuit/defer seconds and safety-block seconds;
- ledger/page/item/segment reconciliation mismatches.

Never use cumulative `attempt.jobCount` as per-attempt progress; it is the total
payload size observed by that claim. Store delta progress explicitly.

### 9.8 Partitioning, archival, and disk growth

An immutable ledger at 6,200 board cycles per day cannot remain an unpartitioned
hot dataset forever. Design page observations, raw observations, work receipts,
and segments for time/batch partitioning from the additive migration onward.

A batch becomes archive-eligible only when:

- listing/canonical/compaction manifests reconcile;
- every segment is processed and its downstream outcomes reconcile;
- no acquisition, detail, conversion, or consumer lease exists;
- the endpoint sweep has final lifecycle timestamps;
- an approved hot-retention interval has elapsed;
- a fresh verifier reproduces the retained manifest and count hashes.

Archival must preserve the `AtsIngestionBatch` summary, endpoint and work
receipts, page/identity multiset hashes, observation-resolution counts, segment
manifests, compaction receipts, `JobSourceObservation`, and `Job` outcomes. Raw
page/observation JSON may move to a compressed cold partition/archive only after
an archive receipt records location, byte count, content hash, and successful
read-back verification.

Initial rollout keeps every legacy and v2 row. Enabling a raw-payload move,
partition detach, or purge automatically removes historical material and
therefore requires a separate explicit product/operations approval. The
implementation must nevertheless include partition keys, archive eligibility,
dry-run inventory/hash reporting, and disk-growth telemetry now; deferring the
physical move must not leave the schema unbounded and unmeasurable.

Before broad rollout, measure bytes per admitted cycle and project 7-, 30-, and
90-day hot/cold growth. Full activation requires either demonstrated disk
headroom for the approved retention window or an enabled, read-back-verified
archive path. Free-space safety always blocks new calls before a response would
be impossible to store.

## 10. Expand-only implementation sequence

Each phase has a stop gate. Do not combine migration, scheduler activation,
legacy conversion, and consumer cutover into one production switch.

### Phase 0A: Reproduce and instrument without behavior change

1. Refresh the read-only production baseline using the metrics in Section 13.
2. Add failing characterization tests for resume monopoly, write amplification,
   detail-only contact overcount, five-second marker failure, and mutable
   pagination.
3. Add transaction-phase and work-kind fields/telemetry without changing
   scheduling behavior.
4. Record current old/new metric series side by side.

Gate: characterization tests fail before their repair; Phase 0A observability
does not alter selection or lifecycle state.

### Phase 0B: Apply narrow containment behavior

1. Explicitly bound the two marker transactions.
2. Phase-tag their failures.
3. Separate internal transaction/control failures from provider/board failure
   scheduling so an internal timeout cannot park a board.
4. Validate the intended retry/lifecycle timing change with focused tests and a
   separately approved canary.

Gate: marker failures remain durable and visible, but no internal database
failure mutates provider circuit state or board failure history.

### Phase 1: Add the ledger schema

1. Add the new scalar batch fields and page-observation, listing-observation,
   observation-resolution, canonical-item, work-receipt, endpoint-sweep, and
   daily-contact, and segment tables in one or more additive Prisma migrations.
2. Add constraints and indexes for idempotent page commits, item ordinals,
   fencing, eligibility, and segment manifests.
3. Keep all legacy fields and readers.
4. Add a database-only verifier for counts, hashes, and unique constraints.
5. Ship a compatibility writer release before any conversion. Both v1 and v2
   claims must honor one database-enforced engine/conversion state and writer
   fence. A batch in `converting` or `v2` must be unclaimable and unwritable by
   the legacy selector/writer, including a pre-v2 application rollback.
6. Add a deployment/readiness gate that refuses an application revision older
   than the compatibility writer once any v2 authority is activated. Prefer a
   database-enforced attempt/payload fence as the final protection; deployment
   convention alone is insufficient.

Gate: migration applies to a production-shaped local database; pre-activation
application rollback remains possible; tests prove a legacy claim cannot race
or write a `converting`/`v2` batch.

### Phase 2: Implement ledger primitives behind a disabled flag

1. Implement atomic initial-page, continuation-page, item-terminalization,
   compaction, segment-seal, and publication operations.
2. Implement uncertain-commit adoption and divergent-hash fail-closed behavior.
3. Add work-unit fencing and global stale-work reconciliation.
4. Implement confirmed-contact sweep/daily receipts and new Stats queries.
5. Verify that the v2 consumer path performs no provider/detail/fallback network
   calls after handoff.

Gate: real-PostgreSQL integration tests and 5,000-/25,000-item load fixtures pass
with linear write volume and bounded transaction duration.

### Phase 3: Shadow the scheduler

1. Run the elastic reservation controller in `would_select` mode only.
2. Compare its coverage debt, lane allocation, platform mix, revisit bound, and
   staging forecast against actual v1 choices.
3. Simulate multiple Chicago days to steady state using full production
   latency/size distributions, 6,200 admissions per day, and at least 100
   preexisting partials. Include every workload created by those admissions:
   listing continuation, verification generations, detail calls, no-network
   markers, compaction, segment sealing/publication, and consumer processing.
4. Require bounded continuation debt, oldest staged/queued age, disk growth,
   and provider request rate after arrivals stabilize; coverage capacity alone
   is not success.
5. Tune token burst, quantum duration, marker batch size, and staging limits from
   evidence.

Gate: shadow output projects at least the required daily contacts while giving
every eligible partial a bounded revisit and staying within staging/persistence
limits.

### Phase 4: Canary new v2 batches

Start with one board at a time and no legacy conversion:

1. a small non-paginated board;
2. the large no-network Workable pattern;
3. a Workday board with many 20-item pages and title-gated details;
4. a SmartRecruiters board with many 100-item pages and detail calls.

For each canary, compare v1 and v2 pure normalization/compaction results from the
same captured immutable provider responses. The v1 comparator must be
non-mutating and make no additional provider or downstream call. Compare source
identities, compaction decisions, enrichment markers, final counts, hashes, and
projected downstream Job outcomes before the one authorized path writes.

Gate: zero data/counter divergence, no unintended same-generation page replay or
terminal-item replay, bounded memory, and bounded database writes. Deliberate
verification-generation requests remain separately receipted.

### Phase 5: Convert active legacy partials safely

Conversion is forbidden until the compatibility writer release is active on all
workers and its database gate is verified. Then:

1. In one database operation, acquire the cross-version writer fence and
   compare-and-swap the batch from legacy to `converting`, conditional on no
   running acquisition attempt or consumer lease. Both selectors must exclude
   `converting` before this phase begins.
2. validate legacy cursor shape, stored count, current-version marker prefix,
   enrichment offset, platform, and compaction marker;
3. reconstruct retained raw ordinals. Compacted metadata records original
   ordinal/source/job state but does **not** retain the discarded raw JSON;
   create explicit `legacy_compacted_receipt` resolution rows with nullable raw
   provenance rather than pretending that payload can be reconstructed;
4. create canonical items for retained payload occurrences and terminal
   resolution receipts for exact legacy compaction;
5. because historical page boundaries are unknowable, create a synthetic
   `legacy_import` page/prefix receipt bound to the legacy payload and cursor
   hash; real later pages use normal immutable receipts;
6. verify fetched = retained + compacted and marker count = enrichment offset;
7. write conversion rows under an inactive ledger generation, verify them, then
   use one short fenced CAS to activate `ledgerVersion=v2` and its generation;
8. retain the full legacy payload, metadata, cursor, and attempts unchanged.

Any mismatch leaves staged rows inactive, returns the batch to legacy only if no
v2 authority was activated, and raises an audit error. Never partially activate.
Once a batch advances under v2, rollback means pause v2 and roll forward with a
compatible v2 binary; never deploy a pre-compatibility writer or route it back
to stale JSON.

Use the large marker-only Workable case as the first meaningful conversion
canary, followed by Workday and SmartRecruiters.

Gate: every converted batch has a deterministic conversion receipt and exact
count/hash reconciliation.

### Phase 6: Activate elastic dispatch and segmented handoff

1. Enable continuous 2+2-default elastic scheduling for v2 batches.
2. Keep at least one continuation worker whenever eligible partial work exists.
3. Enable segment publication under atomic persistence credits.
4. Retain the legacy reader/worker for nonconverted batches, but do not claim the
   v2 hard revisit bound for them unless the legacy claim is also given the same
   page/detail/hard-time budget. Otherwise convert/drain them before enabling
   the strict fairness SLO.
5. Scale canary scope by platform and board size, not all at once.

Gate: Section 13 canary criteria pass for at least 24 hours before broadening.

### Phase 7: Complete rollout and retire only dead code

1. Run v2 across all new board cycles.
2. Drain or safely convert every legacy partial.
3. Keep legacy payloads and receipts through the approved retention period.
4. Remove v1 scheduling/writer code only after a read-only verifier proves no
   active batch depends on it.
5. Do not drop schema columns or data in this project. Any later retention or
   cleanup is a separate reviewed plan.

Gate: seven complete Chicago days meet every production acceptance criterion.

## 11. Exact code areas involved

| Area | Current source locations | Required change |
|---|---|---|
| Batch/page/enrichment constants | `src/lib/atsAcquisition.ts:55-125` | Add bounded quantum, lease, and staging settings; remove whole-payload cost assumptions |
| Batch load, attempt claim, stale lease | `src/lib/atsAcquisition.ts:835-1015` | Add work-unit claims, fences, global stale reconciliation, and endpoint-sweep admission |
| Request/response markers | `src/lib/atsAcquisition.ts:1041-1097` | Explicit transaction bounds, phase tags, listing/detail separation, no board contact contamination from details |
| Partial finalizer | `src/lib/atsAcquisition.ts:1100-1134` | Move continuation eligibility to batch/item `nextAcquireAt`; stop 60-second board recirculation |
| Pagination/page checkpoint | `src/lib/atsAcquisition.ts:1150-1265` | Immutable page observations, raw occurrences, CAS cursor, drift generations, no full-array rewrite |
| Exact prequeue compaction | `src/lib/atsAcquisition.ts:1267-1418`; `src/lib/atsPrequeueCompaction.ts:53-180` | Preserve conservative predicates; mark terminal ledger rows instead of deleting occurrences |
| Enrichment loop/checkpoint | `src/lib/atsAcquisition.ts:1421-1496`; `src/lib/atsJobEnrichment.ts:374-563,639-799` | Bulk no-network markers, bounded detail/time budget, per-item state/fence |
| Synchronization/finalization/retry | `src/lib/atsAcquisition.ts:1499-1755` | Seal/publish segment reconciliation; separate internal and provider failure scopes |
| Resume-first selector | `src/lib/atsAcquisition.ts:1759-1973` | Replace with elastic coverage/continuation claims and deficit round-robin |
| Current backpressure | `src/lib/atsAcquisition.ts:1976-1996` | Retain persistence hysteresis; add atomic segment credits and acquisition staging limits |
| Existing ATS consumer | `src/lib/atsAcquisition.ts:2090-2497` | Consume immutable segments/items and retain cursor/event recovery |
| Turn barrier | `src/lib/atsAcquisitionLoop.ts:234-450` | Continuous dispatcher; no selected-25 `allSettled` barrier |
| Scheduler/env bounds | `src/lib/ingestionTaskCatalog.ts:35-78`; `.env.example` | Add v2 flags, lane, quantum, staging, and canary settings |
| Daily target/calendar | `src/lib/atsRotation.ts:25-34` | Keep `requiredAtsBoardChecksPerDay`; drive exact Chicago-local coverage debt |
| Transaction concurrency | `src/lib/ingestionConcurrency.ts:14-54` | Retain conservative cap initially; measure row-ledger transaction latency before tuning |
| Worker isolation/shutdown | `src/lib/pipelineWorkerProcess.ts:6-10,48-91,157-175,194-280`; `scripts/workers/ats-acquisition.ts:69-98` | Align quantum, lease, heartbeat, and stop grace; preserve child isolation |
| Parent supervision and consumer | `src/app/api/pipeline/run/route.ts:267-390` | Surface lane/ledger telemetry and supervise segment drain without adding network work to parent |
| Prefetched network-free contract | `src/lib/jobIngestion.ts:3021-3044,4997-5000,5131-5157,5715-5724` | Keep prefetched items network-complete; accept segment/item reader |
| Stats daily lifecycle | `src/app/api/stats/route.ts:152-268,1200-1255` | Add first-listing authority, lane/phase metrics, staging, fairness, and exact freshness semantics |
| Schema | `prisma/schema.prisma:158-273` | Add page/observation/resolution/canonical-item/work/sweep/daily-contact/segment models and scalar batch fields |
| Existing split migration | `prisma/migrations/20260827160000_ats_split_ingestion_paths/migration.sql:61-125` | Add a later expand-only migration; do not edit deployed migration history |
| Pipeline contract | `docs/CAREER_DASHBOARD_PIPELINE_CONTRACT.md:177-218` | Document v2 acquisition ledger, segmented handoff, and lifecycle authority |

## 12. Test plan

### 12.1 Scheduler unit tests

Add deterministic-clock tests for:

- 23-, 24-, and 25-hour Chicago days and local midnight boundaries;
- admission/ambiguous retry crossing midnight and contact credit landing on the
  confirmed Chicago day;
- 6,200 new board cycles plus 24, 29, and 100 large partial batches;
- current p50/p95/p99 coverage latency distributions;
- one static coverage lane missing the target at p95 and two lanes meeting it;
- elastic allocation of one to three coverage slots;
- the invariant that at least one continuation worker remains while eligible
  work exists;
- idle-lane borrowing, behind-target escalation, bounded token burst, and
  staging/provider safety blocks;
- today/catch-up/recovery admission tiers and platform round-robin;
- deficit round-robin: no second quantum before eligible peers;
- nominal and hard-claim revisit bounds and violation telemetry;
- no-request work updating `lastServedAt` so it cannot retain stale-order
  priority.

### 12.2 Page and pagination tests

Use fake Workday and SmartRecruiters providers to cover:

- one-page coverage quantum and no detail call in that quantum;
- continuation obeying both the page-request and time budgets;
- multi-page progress across many claims;
- total growth and shrink;
- short/empty page before the observed total;
- same offset/same hash uncertain-commit adoption;
- same offset/different hash drift generation;
- insertion and deletion before the current offset;
- duplicate and missing source IDs;
- multiset reconciliation across generations without summing verification
  duplicates, while preserving repeated source-ID variants;
- every raw observation resolving to one canonical/verification/drift/
  compaction outcome;
- convergence-pass equality and nonconverging `unstable_partial` behavior;
- crash before dispatch, after dispatch intent, after response/before commit,
  and after commit;
- ambiguous dispatch intent not counting as confirmed contact or suppressing a
  separately receipted retry;
- no unintended same-generation committed-page replay, every deliberate
  verification-generation request labeled, and at most one explicit ambiguous
  in-flight retry.

### 12.3 Item/enrichment tests

- terminal current-version item is skipped;
- 5,000 no-network items progress through bounded bulk writes with zero provider
  calls and linear bytes/updates;
- title-gated, description-present, unsupported, and missing-identity markers;
- 403/404 terminal unavailable behavior;
- 429, open circuit, provider deferral, and request timeout preserve pending
  suffix and exact retry time;
- no more than five detail GETs and no new GET after the quantum deadline;
- item fence prevents a stale owner from committing;
- enrichment version repair does not change already authoritative Jobs or
  scores;
- uncertain item commit adopts a matching terminal row and fails closed on
  divergence.

### 12.4 Compaction and identity tests

- exact same-board terminal observation compacts to a terminal ledger receipt;
- pending, inbox, reviewable, missing-identity, ambiguous, and cross-board rows
  remain retained;
- raw-observation, resolution, canonical, retained, and compacted counts
  reconcile at their separate grains;
- multiple identical source IDs remain represented until conservative
  reconciliation;
- existing compaction hashes and funnel receipts remain stable.

### 12.5 Segment and consumer tests

- out-of-order terminal items seal any complete deterministic partition while a
  deferred item blocks only its own partition;
- immutable segment manifest/hash verification;
- database-enforced non-overlap and segment size below the persistence high
  watermark;
- concurrent publishers cannot exceed 2,000 queued/processing remaining jobs;
- publication resumes only after backlog is at or below 1,000;
- crash after a Job write but before segment cursor/event commit reconciles via
  existing `atsBatchItemKey` idempotency;
- every segment satisfies inserted + duplicate + filtered + processing error =
  segment item count;
- board-level fetched = segment items + exact compacted occurrences;
- synchronized and processed timestamps advance only at their exact lifecycle
  boundaries;
- prefetched segment processing performs zero listing/detail/fallback network
  calls.

### 12.6 Lease, retry, and process tests

- double claim is prevented by unique claim/fence rules;
- legacy and v2 selectors honor the same conversion/writer fence;
- a selected-but-not-started legacy claim cannot race conversion activation;
- a pre-compatibility binary cannot insert an attempt or mutate payload/cursor
  after v2 authority is active;
- global stale-lease reconciliation and safe reclaim;
- old owner cannot commit after lease loss;
- heartbeat remains inside the lease margin;
- graceful stop finishes the current bounded checkpoint;
- forced kill creates at most one ambiguous in-flight GET;
- parent waits for the old PID before replacement;
- request/response marker transaction errors are phase-tagged and never trigger
  provider/board parking;
- provider failures still use the correct board/platform/detail scope.

### 12.7 Real PostgreSQL integration and load tests

Add a guarded integration file such as
`tests/integration/atsAcquisitionLedger.postgres.test.ts` covering:

- unique and partial indexes;
- page/item/segment transaction rollback;
- CAS and fencing races;
- uncertain-commit adoption;
- conversion of listing-incomplete, enrichment-incomplete, compacted, and fully
  ready legacy JSON batches;
- explicit nullable-raw `legacy_compacted_receipt` provenance and inactive
  conversion-generation activation;
- exact count/hash/manifest reconciliation;
- partition keys, archive eligibility, archive content hash/read-back, and disk
  growth projection;
- 5,000- and 25,000-item fixtures;
- linear total bytes written and bounded transaction time;
- memory/RSS behavior without reconstructing a giant array per item.

Performance gates should start with:

- checkpoint transaction p95 below 1 second in the production-shaped fixture;
- hard transaction duration below its configured timeout;
- no O(n-squared) growth in bytes written or batch-table updates as item count
  scales;
- bounded worker RSS well below current 1.5-plus GiB behavior.

Tune final thresholds from a recorded local/Pi canary baseline rather than
loosening them until tests pass.

### 12.8 Existing regressions

Update and retain coverage in:

- `src/lib/__tests__/atsAcquisition.test.ts`;
- `src/lib/__tests__/atsAcquisitionLoop.test.ts`;
- `src/lib/__tests__/atsJobEnrichment.test.ts`;
- `src/lib/__tests__/atsPrequeueCompaction.test.ts`;
- `src/lib/__tests__/atsRotation.test.ts`;
- `src/lib/__tests__/atsProcessIsolationContract.test.ts`;
- `src/lib/__tests__/pipelineWorkerProcess.test.ts`;
- Stats, task-mode, queue, and prefetched-network contract tests.

Run focused tests first, then `npm test`, `npm run lint -- <changed paths>`, a
production build, Prisma migration validation, and the repository's deployment
readiness checks. Local success is not deployment or live proof.

### 12.9 Investigation-time test baseline

The following existing focused suite was run read-only against the evidence
commit:

```bash
node --import tsx --test \
  src/lib/__tests__/atsAcquisition.test.ts \
  src/lib/__tests__/atsAcquisitionLoop.test.ts \
  src/lib/__tests__/atsJobEnrichment.test.ts \
  src/lib/__tests__/atsBatchAccounting.test.ts \
  src/lib/__tests__/atsPrequeueCompaction.test.ts \
  src/lib/__tests__/atsProcessIsolationContract.test.ts \
  src/lib/__tests__/atsBatchPayloadReads.test.ts
```

Result: 80 passed; 0 failed, cancelled, skipped, or todo.

That green baseline validates the current helper and contract behavior; it does
not test the failure this plan must solve end to end. The current suite has no
real-database/fake-provider test that acquires a multi-thousand-job board across
many claims, injects crashes around page/item commits, competes 25-plus partials
against 6,200 new-cycle boards, mutates an offset-paginated result set, or proves
linear write volume.

## 13. Production measurement and acceptance plan

### 13.1 Pre-change baseline

Capture a complete Chicago day and a fresh pre-canary snapshot:

- confirmed daily-contact authority if instrumentation is present; otherwise label
  legacy `contactedAt` as an upper-bound proxy for listing coverage;
- receipts and distinct endpoints by contacted/responded/synchronized/processed;
- new versus resumed claims and listing/detail/no-network work;
- worker-hours and p50/p95/p99 duration by phase;
- per-hour first-contact rate and four-worker utilization;
- page and enrichment cursor deltas per active batch;
- acquisition staging items/bytes and queued/processing remaining jobs;
- provider circuits, deferred seconds, transaction errors, P2024s, lease expiry,
  child exits, RSS/CPU/swap, database/TOAST size;
- oldest partial, known pages/items remaining, and calculated revisit bound.

Use direct SQL in a repeatable-read, read-only transaction with explicit
Chicago boundaries. Do not rely on `/api/stats` without checking
`x-career-stats-cache` and `x-career-stats-age`.

### 13.2 Canary sequence

For each canary platform/board, compare before/after:

- provider request and page counts;
- source identity multiset and raw hashes;
- fetched, retained, compacted, terminal, sealed, published, and processed
  counts;
- listing/detail/marker work receipts and cursor endpoints;
- transaction duration/bytes/update count;
- memory and CPU;
- downstream Job and source-observation outcomes;
- provider circuit and rate-limit behavior.

Stop expansion on any lost occurrence, divergent manifest, lifecycle mismatch,
unexpected network call in the consumer, or completed-work replay.

### 13.3 Acceptance criteria

Require all of the following for seven complete Chicago days after broad
activation:

#### Coverage

- At least `requiredAtsBoardChecksPerDay(activeBoards)` distinct **new-cycle
  first-listing contacts** each day; current target is approximately 6,200.
- Contacted, responded, synchronized, and processed counts reported separately.
- Coverage debt returns to zero by local day end. A target prevented by a safety
  gate remains a visible SLO miss with exact blocked seconds/reason.
- No unexplained zero-contact interval while eligible, unblocked coverage work
  exists.

#### Continuation fairness and progress

- At least one continuation worker remains allocated whenever eligible partial
  work exists.
- Maximum eligible-batch wait stays below
  `ceil(dueBatches / continuationWorkers) * hardClaimBound + bounded jitter`.
- Zero consecutive-board fairness violations.
- Every eligible batch's page/item/segment progress is monotonic.
- At the full 6,200/day arrival rate, listing, verification, enrichment,
  sealing, publication, and consumer service rates keep continuation debt and
  oldest age bounded over a multiday steady-state soak. Partial batch count
  alone is not the metric.

#### Durability and correctness

- Zero unintended same-generation refetches of a committed page. Deliberate
  cross-generation verification requests are separately counted, budgeted, and
  tied to drift/convergence evidence.
- Zero detail fetches of a terminal current-version item.
- Only explicit ambiguous in-flight retry/adoption receipts are allowed.
- Zero cursor, marker, page hash, manifest, count, or segment reconciliation
  mismatches.
- Every raw observation resolves to a canonical item, labeled verification/
  drift evidence, or exact compacted terminal receipt. Every canonical item
  reaches retained processing or exact compaction, and every segment item
  reaches inserted, duplicate, filtered, or processing-error evidence.
- Zero changes to existing score authority or application lifecycle caused by
  this migration.

#### Downstream safety

- Segment publication never raises queued/processing remaining work above 2,000
  and resumes only at or below 1,000.
- Every segment is smaller than the persistence high watermark and database
  constraints prove segment ranges do not overlap.
- Consumer arrival/drain rate and oldest queued age show sustainable drain.
- Acquisition item/byte/age staging remains below measured safety caps with
  adequate disk headroom.
- Measured bytes per cycle and 7-/30-/90-day projections fit the approved
  hot/cold retention design; archive read-back/hash verification succeeds where
  archival is enabled.
- No giant-batch publication cliff.

#### Runtime health

- Zero acquisition expired-transaction/P2024 errors in steady state.
- Zero expired live work leases and zero stale-fence commits.
- Checkpoint transaction p95 below the agreed production threshold and hard max
  below configured timeout.
- Worker RSS, CPU, swap, table updates, and TOAST growth stay bounded and scale
  approximately linearly with new work.
- Provider 429/circuit rates do not regress due to the scheduler change.

#### Weekly outcome

- At least 99% of the active catalog receives a valid weekly listing check under
  the existing coverage SLO.
- New-cycle contacts convert through response, synchronization, processing, and
  usable output without hidden partial accumulation.

### 13.4 Read-only query wrapper

Use the following production pattern for validation unless the deployment
runbook provides a newer approved wrapper:

```bash
ssh -o BatchMode=yes j85473@192.168.1.208 \
  'set -a; . /opt/career-dashboard/.env; set +a;
   exec psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -P pager=off' <<'SQL'
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';

-- Read-only validation queries.

ROLLBACK;
SQL
```

Calculate Chicago day bounds explicitly. Prisma timestamps are stored as UTC
`timestamp(3)` values, so avoid implicit `timestamp`/`timestamptz` conversion.

## 14. Rollback and safety rules

- Feature flags may stop new v2 admission, v2 selection, conversion, or segment
  publication independently.
- Stopping a lane must preserve current leases/checkpoints and allow a later
  resume; it must not reset a cursor.
- A converted/advanced v2 batch never falls back to the legacy payload writer.
- Before any conversion, a compatibility release and database-enforced
  writer/attempt fence must make `converting` and `v2` unclaimable by v1. The
  conversion state change and absence of live v1 leases are checked in one CAS,
  not a read-then-write sequence.
- Once any v2 ledger becomes authoritative, deploying a binary older than that
  compatibility release is prohibited and must fail a durable deployment/
  readiness gate. Operational rollback is flag-based pause plus roll-forward to
  a compatible binary, not old-writer reactivation.
- Legacy batches not converted remain readable by the legacy path under the
  fair continuation budget.
- No migration drops a table, column, receipt, payload, marker, score, Job, or
  source observation.
- No automatic repair clears, invalidates, stales, demotes, or requeues existing
  Aim Fit or Experience Fit scores.
- No production conversion operates on a live attempt or consumer lease.
- Conversion rows remain inactive until one final fenced authority CAS; failed
  staging cannot be read as active work.
- Any data mismatch fails closed, leaves the authoritative old representation
  intact, and produces an operator-visible audit record.
- Push, deployment, migration application, and live activation remain separate
  explicit approval gates.

## 15. Implementation checklist for the new chat

The implementing chat should proceed in this order:

1. Read this plan, `AGENTS.md`, the current Next.js agent guide, and
   `docs/CAREER_DASHBOARD_PIPELINE_CONTRACT.md`.
2. Refresh `main`, worktree, current source symbols, and read-only production
   baseline without changing state.
3. Write characterization tests before changing selection or persistence.
4. Present the proposed additive Prisma schema and user-visible consequences
   before implementing it.
5. Implement Phase 0 and Phase 1 only; run focused and full local validation.
6. Review schema, fencing, hash, and rollback invariants before Phase 2.
7. Keep every behavior behind disabled or canary-scoped flags until shadow and
   integration gates pass.
8. Do not deploy merely because local tests pass. Report exact changed paths,
   tests, migrations, unresolved risks, and the proposed canary scope for
   separate approval.

## 16. Remaining questions to resolve during implementation

These are design-validation questions, not reasons to reopen the confirmed root
cause:

1. Does the exact Workday CXS jobs response expose a stable ordering or snapshot
   token that can replace convergence passes?
2. Does SmartRecruiters provide a documented stable order beyond
   offset/limit/totalFound for this public endpoint?
3. What item/byte staging high and low watermarks fit the Pi's disk and measured
   daily listing distribution with safe headroom?
4. What marker bulk size and quantum deadline keep transaction p95 below the
   acceptance threshold on the Pi?
5. What hot-retention window, cold archive location, and eventual purge policy
   should be approved after manifest/downstream reconciliation? The schema and
   dry-run archive verifier are required now; destructive activation is not.
6. What is the smallest canary board set that includes marker-only,
   detail-heavy, offset-paginated, and non-paginated behavior without violating
   provider budgets?

None of these questions justify continuing the current whole-payload writer or
global resume-first selector as the long-term architecture.

## 17. External pagination references

- [SmartRecruiters Posting API endpoints and offset/limit/totalFound paging](https://developers.smartrecruiters.com/docs/endpoints)
- [SmartRecruiters customer API paging overview](https://developers.smartrecruiters.com/docs/customer-overview)
- [Workday REST pagination fundamentals](https://developer.workday.com/documentation/lvb1611857200890/ConceptWorkdayRESTAPIPagination)

These references describe the vendors' general/public paging contracts. They do
not prove that the Workday CXS jobs endpoint used here offers a stable snapshot.

## 18. Local Phase 0/1 implementation record

The implementing chat refreshed the production baseline read-only at
approximately 2026-08-30 16:00 UTC. It observed 1,571 attempted endpoints,
1,566 legacy contacted endpoints, 1,479 responded endpoints, 1,457 synchronized
endpoints, and 1,456 processed endpoints for the Chicago day, plus 25 active
partial acquisition batches retaining 43,754 staging jobs. The read-only
transaction was rolled back. No production row, process, configuration, or
feature flag was changed.

Phase 0 now records claim work kind and internal transaction phase/failure
scope, explicitly bounds the request/response marker transactions, and gives
internal-control failures a short independent retry without mutating board
failure history or provider circuit state. The old contact series remains
visible and is labeled separately from the dormant exact new-cycle and listing-
continuation series.

Phase 1 adds the expand-only page, observation, resolution, item, work-receipt,
endpoint-sweep, daily-contact, segment, and runtime-gate schema. Legacy JSON
fields and readers remain. Application selectors plus database triggers prevent
legacy attempts, payload writes, and consumer lease/counter writes against a
`converting` or `v2` batch. The acquisition worker and deployment migration
step enforce the compatibility-writer runtime gate. The database-only verifier
checks object authorities, counts, integrity hashes, segment reconciliation,
and archive verification receipts without changing data.

The migration applied cleanly to a fresh production-shaped local PostgreSQL
database, matched the formatted Prisma schema with no diff, and passed local
race/fence/segment-bound tests. The full repository test suite, lint, TypeScript,
Prisma validation/generation, production build, and diff checks passed. Phase 2
ledger primitives, scheduling, conversion execution, segment publication,
canarying, deployment, and production activation remain deliberately
unimplemented and require separate approval.

Release decision on 2026-08-30: Joseph explicitly waived the Phase 0B canary
gate and authorized the scoped commit, GitHub push, Raspberry Pi deployment,
and post-deployment monitoring. This waiver permits the narrow containment
behavior to activate across the existing legacy ATS path; it does not authorize
v2 conversion, segment publication, score changes, cleanup, or any feature-flag
activation.
