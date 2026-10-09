# Controlled first collection for new ATS providers

Prepared by Codex for Joe Lamb, October 8, 2026, America/Chicago. Original design proposal, retained for history. Status clarified October 9, 2026.

**Historical proposal; use the [implemented first-collection behavior](ATS_FIRST_COLLECTION_ADMISSION.md) for current operating rules.** The tenant adapters and shared admission controls were committed in `8c9bdb1` and are included in the M70 release activated October 9 (`abb29c4`, [verified deployment workflow](https://github.com/j85473/career-dashboard/actions/runs/37985647089)). Implementation and deployment do not establish pilot acceptance or permission to release waiting tenants.

The sections below preserve the preimplementation observations, proposed sequence, and acceptance criteria. Statements about missing controls or future implementation describe that earlier snapshot. They are not current instructions to rerun discovery, admit pilots, or raise limits. In particular, the proposed later increases to ten or twenty boards per day remain proposals; the implemented default is five first collections per rolling 24 hours, one unfinished collection, and a 15-minute healthy window. The acquisition release also applies a separate global hold when staging or unfinished listings are too high.

The rollout covers Zoho Recruit and the recommended first expansion batch: Gem, JobScore, JazzHR, Manatal, ClearCompany, and HireHive. No additional aggregators are included.

**Discover the full catalogue of candidate boards, but require separate, durable permission before a board starts its first collection.** Common Crawl coverage and acquisition admission must have separate completion criteria. A deployment, discovery success, retry, or passing clock must not release the waiting catalogue automatically.

## Preimplementation code observations

- The [discovery date rule](../src/lib/atsBoardDiscovery.ts) makes a validated board due immediately. New-board recording creates an active board; reactivation can also make an existing board due immediately.
- The [weekly discovery worker](../src/scripts/discoverATS.ts) and the [full Common Crawl audit](../scripts/audit_ats_common_crawl.ts) both use that path. Successful validation currently writes a schedulable board.
- The [Zoho change](ZOHO_RECRUIT_ACQUISITION_HANDOFF.md) is committed and plugs into ordinary discovery and acquisition. Its verified Thinkbridge board supplied 35 published postings. The adapter returns an entire catalogue without pagination.
- Deployment restores previously enabled discovery services and timers. It does not itself launch a new full scan unconditionally. A resumed full audit expands its pattern inventory when the new patterns are present; the weekly worker can discover them on its next run. Once a board is recorded, ordinary due-board selection can admit it.
- Global admission, backlog watermarks, and listing concurrency controls exist. They protect general pipeline capacity, but they do not assign a separate rollout allowance to a new provider's first collections. The old script that releases a one-day discovery delay is a targeted catch-up tool, not a staged rollout controller.

These are observations from the original research checkout, before the tenant admission implementation; they are not a current production-health measurement.

## Proposed discovery and acquisition stages

| Stage | Allowed work | Evidence required to advance |
| --- | --- | --- |
| Discovered, waiting | Save normalized board identity, source URL, Common Crawl provenance, and checkpoint. No ATS acquisition batch. | Candidate identity and source provenance retained. |
| Verified, waiting | A separately paced validation request may establish employer, catalogue size, feed shape, and description availability. No bulk acquisition admission. | Real tenant, suitable source type, usable posting identity, response shape, and size estimate. |
| First collection admitted | One selected board gets a durable first-pass admission and enters normal ledger processing. | Atomic capacity reservation and current backlog checks pass. |
| First collection in progress | Resume saved listing, compaction, detail, sealing, publication, and persistence work under existing leases and cursors. | No abandoned records, repeating pages, unexplained stalls, or provider-wide pause from malformed individual records. |
| Established board | Enter ordinary workload-aware weekly rotation. | Complete traversal and auditable downstream disposition: eligible records persisted; duplicates and rejected/unavailable records accounted for. |

Discovery completeness means all configured URL patterns and available indices have their receipts. It must not require every discovered board to have entered acquisition. Validation and first collection have separate progress counts. Existing completed Common Crawl checkpoints stay intact when new patterns are added.

Validation must also be paced by provider: a full-feed request can be expensive even when it creates no Job rows. Failed/transient validation remains retryable with durable evidence; intentionally waiting is not a failure, blacklist, or permanent exclusion.

## Proposed initial limits

These are conservative starting settings, not measured capacity estimates. Confirm live staging, detail, publication, persistence, and provider circuits before admitting the first pilot.

| Rollout stage | Newly introduced boards | Unfinished first collections |
| --- | --- | --- |
| Adapter deployment and discovery | Zero automatic starts; all new rollout boards wait. | Existing started work may drain. |
| Named pilots | One known small employer board per provider, beginning with Zoho; admit them sequentially. | One globally across these seven providers. |
| Initial expansion after pilot acceptance | At most five new boards per rolling 24 hours in total, with provider fairness. | One globally. |
| Later expansion after a healthy 24-hour observation window | Raise the total allowance to ten, then twenty per rolling 24 hours through explicit policy changes. | Keep one until evidence supports increasing it. |

Pilot boards should have approximately 5–50 postings where available. Initially hold catalogues above 250 postings or a proposed 5 MiB decoded response limit for size review. Small boards establish correctness; a separately chosen larger board must establish pagination and load behavior before the size allowance grows.

For whole-feed sources, including Zoho, Gem, JobScore, and JazzHR, an unexpectedly large response must not materialize an unlimited number of observations. Use a bounded response reader and a controlled oversize outcome. Preserve any safely committed evidence and explain the hold; do not report a truncated catalogue as a successful complete sweep or silently discard its remainder.

For paginated sources, use small page/time budgets and saved continuation cursors. The board remains in the first-collection limit until its whole pass finishes downstream. The current v2 pipeline traverses listing before subsequent drain phases, so the design must not demand publication after every page without first changing that phase dependency.

## Admission and backpressure requirements

The first-collection policy belongs in the database and must survive restarts and deployment swaps. It needs the managed providers, current rollout stage, per-board admission state, admission timestamps, size allowance, and links to the first batch and completion evidence. Rolling allowances come from durable admission records; they do not reset at midnight or process restart.

Enforce the gate twice: filter waiting boards out of due-board selection, then check the policy and reserve capacity atomically in the transaction that creates the first batch. The database check is the authority across M70 and remote workers. Both legacy and v2 admission must obey it. Continuation of a previously admitted batch must not consume another new-board allowance or be blocked by a pause on new admissions.

Apply it to every route that can introduce a board: weekly discovery, the full audit, pasted links, launch seeds, reactivation, and targeted catch-up scripts. An old worker must not be able to bypass the new policy. Compatibility/deployment checks must reject an admission writer that lacks enforcement before managed providers are enabled.

Do not use a future check date as the permission mechanism: eventually every date expires. Do not reuse parked/failed status, inflate failure counts, permanently exclude waiting boards, or change all existing boards' discovery behavior.

Further admissions require all of the following:

- The existing global admission and staging checks permit new work, with enough item and byte headroom for the next board's bounded estimated load.
- The new-provider backlog is within its separate reserved allowance. Count unfinished first passes through persistence, not only live listing requests.
- Recent measurements show terminal work reaching publication and persistence. Pending detail, terminal-but-unsealed work, and published-but-unpersisted work are not accumulating beyond the rollout budget.
- Listing and detail circuits for the proposed provider permit work. Malformed board/posting data retain their narrow failure scope; genuine rate limits, transport failures, and server failures keep existing protections.

When health deteriorates, stop new admissions and retain all already committed work for normal bounded recovery. Resume release only after a sustained healthy window. Changing the rollout stage requires an explicit policy change; elapsed time alone never increases its limits.

## Proposed Zoho and deployment sequence

1. Implement and verify first-collection admission before deploying the Zoho-enabled acquisition release. Zoho starts with rollout permission closed.
2. Protect existing, never-started Zoho board rows if any are present. Do not rewrite completed boards, existing Jobs/scores, permanent retirements, or unfinished batches. Already admitted work remains drainable and counts toward the rollout's outstanding work.
3. Run or resume Common Crawl discovery for the configured new URL patterns with candidate collection separated from ATS validation and admission. Keep its existing request pacing and durable checkpoints.
4. Admit only the verified Thinkbridge Zoho board as the first pilot after checking live pipeline headroom. Verify the complete path to persisted candidates and auditable dispositions.
5. Add Gem, JobScore, JazzHR, Manatal, ClearCompany, and HireHive behind the same closed-by-default policy. Verify one named pilot for each before allowing automatic releases within the initial five-board allowance.
6. Observe global and provider-specific backlog, failures, and usable output; increase rollout limits only on that evidence.

## Original acceptance criteria

Focused verification must demonstrate that a large discovered catalogue creates no automatic first batches; multiple workers cannot exceed the shared allowance; restarts and midnight do not reset it; pasted links/seeds/reactivation cannot bypass it; and a held new board cannot starve established-board selection.

Also demonstrate that an existing partial batch resumes while new admission is paused, oversized feeds cannot flood observations or claim completion, pagination never repeats or drops records, and the first-pass slot is not released before downstream disposition. Regression checks retain board/posting-scoped malformed payload handling and genuine provider outage protection.

Production acceptance requires a live baseline, admitted-versus-waiting counts, durable first-pass completion evidence, backlog measurements over an observation window, and unchanged pre-existing Job and score authority. Faster listing responses alone do not establish safe expansion.

This plan authorizes no deployment or live discovery run. Its proposed holds apply to new first collections; existing jobs, scores, completed work, and recovery cursors retain their authority.
