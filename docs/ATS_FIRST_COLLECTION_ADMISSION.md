# Controlled introduction of tenant ATS sources

Gem, JobScore, JazzHR, Manatal, ClearCompany and HireHive join Zoho Recruit in a
shared first-collection rollout. These are tenant-specific public career feeds.
The rollout adds no aggregator sources.

Common Crawl can exhaust every supported historical index and URL pattern while
cataloguing these tenants in a separate waiting inventory. Both the weekly sweep
and the exhaustive audit save that inventory before advancing their checkpoints.
They make no vendor validation requests for the rollout providers. Discovery does
not create an ingestion batch or make the entire inventory eligible for rotation.

The policy starts held. Pilot mode permits only explicitly named tenants; ramp
mode allows the waiting inventory through the same limits. Capacity mode lets the
whole inventory refill available acquisition capacity without a daily quota or a
flat-backlog waiting period. Mode changes are explicit operator actions.

## First-collection conditions

- Pilot/ramp: at most five starts and validation attempts in a rolling 24 hours,
  one unfinished first collection, one ready board ahead, and a 15-minute window
  of low, non-growing backlog. A gap exceeding ten minutes restarts that window.
- Capacity: no daily start or validation quota and no stability delay. Low
  backlog with reserved catalogue headroom permits immediate refill, even while
  the backlog grows. Up to 32 runnable unfinished or immediately ready boards
  feed the existing shared worker pool; this does not increase its slot limit.
  Future-held, failed or review-held work stays saved and retains its first-
  collection state, but does not consume productive refill slots. Retry work
  counts again when due or actively leased. JobScore boards waiting for their
  hourly feed allowance do not block validation of other tenants.
- The existing global acquisition admission gate must be open. The controller
  reserves room for the maximum permitted catalogue before validating or admitting.
- Initially at most 250 jobs per catalogue and 5 MiB per decoded response. A larger
  catalogue waits for size review. Feed growth beyond the allowance during an
  initial collection retains that collection's slot and holds further fetching.
- A single durable validation lease serializes vendor validation across hosts.
  Each controller pass handles up to 16 candidates within a 45-second budget;
  a request already in flight may finish after the budget. Failed, oversized and
  retired tenants yield to the next candidate. Pressure or a policy hold stops
  the pass. Deferred candidates keep their existing retry dates.

Default low-pressure thresholds are fewer than 50,000 staged items, 750 MB staged
bytes and 1,000 runnable jobs pending persistence, including reserved catalogue headroom.
All processing work counts. Published segments and queued legacy batches count
when their retry is due or unset. Future-held persistence remains retained and
reported separately as `heldPersistence`; it begins consuming capacity when its
retry expires. The admission query and publication query share the same UTC-aware
segment predicate, so a held employer-verification retry cannot block pilots
while publication can proceed. No retry time, work status or payload is changed.
Existing runtime low/high-watermark settings remain authoritative when configured.
Listing completion alone does not release admission. The first batch must reach
successful persistence completion with zero unresolved processing errors before
the employer earns established weekly rotation.

Admission is enforced before candidate limits in both schedulers and within the
exact batch-creation transaction. A shared policy row serializes reservations.
Database triggers force new rollout board rows into waiting state and reject an
unreserved batch, including inserts from an older worker. The reservation is tied
to the exact batch ID. A transaction rollback removes the reservation as well.
Already-started boards are grandfathered by the additive migration. Existing jobs,
scores, batches, cursors, retirement decisions and operator pauses are preserved.
Holding the rollout stops new admissions; it permits existing work to finish.

## Provider behavior

Gem, JobScore and JazzHR publish whole feeds. Manatal, ClearCompany and HireHive
use locally reconstructed 20-job pages. Each adapter validates tenant identity,
employer authority, posting identity and full descriptions. Pagination rejects
repeated pages, incomplete continuations and inconsistent totals. JazzHR uses its
public XML export; a status-200 HTML error cannot count as a valid feed.

Malformed payloads and tenant-specific access failures remain board-scoped.
Genuine rate limits, transport failures and server failures keep normal provider
protection. JobScore feed requests have a durable per-tenant one-hour interval
across validation and acquisition. Its first acquisition is due one hour after
validation. Established boards retain normal collection and rotation limits.

## Operation on M70

The first-collection timer refills after each pass with a 15-second delay and up
to five seconds of jitter. Normal
deployment installs and enables it; maintenance deployment leaves it stopped.
Automatic reboot coordination includes the timer and its service.

Run these commands from the active release under the normal production runtime:

```sh
node scripts/with-env.mjs node --import tsx scripts/control_ats_first_collections.ts
node scripts/with-env.mjs node --import tsx scripts/control_ats_first_collections.ts --mode=pilot --pilot=zohorecruit::thinkbridge.zohorecruit.in::Careers --apply
node scripts/with-env.mjs node --import tsx scripts/control_ats_first_collections.ts --mode=held --apply
node scripts/with-env.mjs node --import tsx scripts/control_ats_first_collections.ts --mode=capacity --apply
```

Status reports the policy, current pressure, inventory counts, waiting/admitted
boards and review reasons. Without `--apply`, a policy command previews the change.
Repeat `--pilot=platform::tenant` to permit multiple named pilots. Capacity mode
sets `dailyBoardLimit=0` (unlimited) and `maxUnfinished=32`; pilot/ramp restore the
five-per-day, one-unfinished defaults. Holding preserves the configured values.
Capacity mode checks room in the exact batch-creation transaction and does not
wait for the legacy stability window. Resolving a failed/oversized first
collection still requires operator review; the timer never erases or abandons
saved work to free a slot. The additive capacity migration only expands the
allowed policy values; it does not change the current operator mode.

The seed script catalogues these launch tenants without validating or scheduling
them. The older audit catch-up script can adjust a due date but cannot bypass the
new batch fence. The live adapter verification script is a separate, bounded
read-only check and creates no jobs or first-collection batches.

## Verification

The release includes parser, pagination, response-size, failure-scope and health
window tests. `tests/integration/atsAdmissionCapacity.ts` emits read-only CTE
fixtures for the exact admission and publication queries, tested under UTC and
America/Chicago. `tests/integration/atsFirstCollection.ts` requires a disposable
database named `ats_first_collection_test_*`, prepared from the previous committed
schema. It applies the actual migration, proves simultaneous callers share one
admission, verifies rollback and exact batch binding, and checks persistence
completion, daily limits, the validation lease and JobScore pacing.

`tests/integration/atsFirstCollectionCapacity.ts` uses a separate disposable
database with the current schema. It applies the actual new policy constraints
and existing raw-writer fences, then verifies eight concurrent starts despite
growing staging, more than five validations, retained future-held work, pressure
stop/refill, the operator gate and hourly provider pacing.
