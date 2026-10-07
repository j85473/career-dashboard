# ATS throughput changes — October 7, 2026

## Evidence and scope

Read-only M70 samples around 11:20–11:25 America/Chicago showed all eight acquisition lanes active, roughly 90–100% idle CPU over the short sample, and 27 GiB of available memory out of 38 GiB. PostgreSQL already stores its data on NVMe and has an 8 GiB shared buffer allocation. This is evidence of available compute capacity during the sample, not a bandwidth benchmark.

The staging snapshot contained about 326,000 observations. Oracle accounted for about 58,700 pending detail enrichments and 49,000 terminal items waiting for complete segment manifests. A sampled 15-minute window completed 1,169 detail calls and terminalized 1,166 items across 236 enrichment claims; those claims averaged 29.46 seconds. Counts change continuously and should not be treated as present status.

The previous distributed request scheduler allowed only one in-flight request across an entire ATS platform. It also started a detail request's ten-second timeout before that request had cleared its queue, provider checks, and durable dispatch receipt. Separately, sealing revisited every segment after each small enrichment quantum, reading unfinished payloads repeatedly. These waits and repeated reads explain why spare CPU and a fast internet connection alone do not ensure high throughput.

## Changes

- Include the reviewed shared one-listing-claim limit while staging is over its existing threshold and drain work exists. All eight acquisition slots and current thresholds remain unchanged. See `ATS_CONTINUATION_CAPACITY_BALANCING.md`.
- Coalesce runtime planning scans within each dispatcher session and reuse the result for at most one second measured from the start of the scan. A slow or failed refresh does not extend an old result. Fresh coverage admission checks, batch leases, retry eligibility, and provider gates remain authoritative. A pressure change can take up to one second to change the lane mix or enable the producer cap.
- Allow Oracle requests to overlap across two fixed hostname buckets. Each known Oracle tenant host always maps to the same bucket. Each bucket uses an existing durable request mutex, so the deployment has at most two such requests in flight rather than one. Other providers keep their current limits. This is a conservative application setting, not an asserted vendor rate limit.
- Preserve a shared Oracle cooldown: a detail or listing 429 records the platform circuit and Retry-After, and queued requests check provider availability before dispatch. Another in-flight success records telemetry but cannot clear an active Oracle cooldown before its deadline, even if an intervening soft failure changes the error message. Credentials and schema errors on an individual job do not become platform-wide listing failures.
- Give detail queue/control work a separate 45-second deadline and start the network timeout immediately before the fetch. Caller cancellation still interrupts queue and network work. The network deadline also covers response-body parsing.
- Select only complete segments without existing manifests, load their payloads in one bounded read, and insert manifests together. Each pass seals at most ten segments, then yields through the existing checkpoint path. Preserve exact manifest hashes, item counts, generation/claim fences, tail segments, reset-drain behavior, and existing manifests. Incomplete groups remain eligible for future work.
- Avoid the recent-listing lookup when the atomic producer cap or drain-only selection makes that timing hint irrelevant.

No scores, job lifecycle decisions, source observations, staging thresholds, or acquisition slot counts are removed or reset by the throughput changes. Existing retry dates retain their authority. The authorized combined release also includes the weekday workload balancer described in ATS_COHORT_WORKLOAD_BALANCING.md and the matched-description cleanup. The throughput changes themselves do not alter cohort assignments. The balancer changes only guarded future scheduling, as described in its own document.

## Verification and release measurement

The exact parameterized sealing query was prepared and executed read-only against a live Oracle batch. PostgreSQL used the existing item and segment indexes; execution took approximately 2.2 milliseconds. That measures the candidate query only, not an end-to-end speedup. On that 1,112-item batch, an old pass could make 89 segment/item reads; the replacement used one candidate query and no payload read because no new segment was complete.

Behavioral tests cover shared listing capacity, scheduling scan coalescing and expiration, bounded Oracle overlap, queued cancellation, cooldown sharing, independent queue/network deadlines, body timeouts, exact manifest hashes, incomplete and missing items, bounded sealing passes, replay, stale claims, and operator reset drain. Validation passed: 1,851 tests with one platform-specific test skipped, TypeScript, quiet ESLint, and the production build with an intentionally unusable database connection. An independent read-only SQL comparison matched the original selection on eight current batches and five positive/negative fixtures.

After an authorized guarded release restarts the acquisition worker, compare at least two matched 15-minute windows: listing arrivals, terminalized items, sealed/published items, staging slope, provider 429s/timeouts, claim duration, and Dashboard latency. A gain in request concurrency alone is not proof that the backlog is shrinking. Old and new workers should not be mixed: both share a two-request aggregate bound, but an old worker does not know the new per-host bucket assignment.
