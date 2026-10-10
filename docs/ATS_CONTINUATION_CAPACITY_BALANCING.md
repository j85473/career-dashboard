# ATS continuation capacity under staging pressure

The October 7, 2026 live audit found that the acquisition service was running with all eight shared slots while staging prevented new-board admission. In the sampled 15 minutes, listing continuation recorded 13,729 items of progress while enrichment terminalized 5,350 items. At 11:00 Chicago time, 217,583 staged items were still in incomplete listing traversals and 111,325 were in enrichment. Three listing claims and five enrichment claims were active. The timing-based starvation rule did not enforce its intended one-producer limit.

When staging exceeds its existing item or byte watermark, the runtime plan now enables a shared limit of one live listing claim while any unfinished compaction, enrichment, or sealing batch exists. A transaction-scoped advisory lock serializes listing admissions across hosts. After acquiring that lock, the transaction counts unexpired listing leases and either claims one producer slot or declines it. The claim and work receipt commit together. Read committed isolation ensures a waiter sees the preceding lock holder's committed lease instead of retaining an earlier snapshot.

A worker denied a producer slot immediately looks for drain work. Existing in-flight listing requests complete normally; the limit governs new claims and does not cancel or restart work. A continued listing claim that advances into compaction or enrichment naturally releases producer capacity. No worker slots, provider request budgets, staging thresholds, retry delays, existing jobs, scores, or saved observations are changed.

Listing may use spare capacity when there are no unfinished batches in the drain phases. This prevents a backlog made entirely of incomplete listing traversals from deadlocking. If drain work exists but is delayed by a provider retry, the producer cap remains active; unused capacity is not an excuse to grow that backlog without a bound.

The October 10 cohort-fairness repair gives today's active cohort a separate
32-listing allowance while older unfinished listings exceed the global allowance.
The allowance counts downloaded listing work whose retry is due and live listing
claims. Parked recovery work stays retained in the global backlog and volume
counts, but cannot consume this active-cohort allowance. An atomic admission
transaction rechecks the board's status, assigned Chicago weekday, retry date,
and current cohort inventory; older cohorts and recovery boards cannot borrow it.
The existing half-watermark admission thresholds and hard volume limits still
close new intake, including this allowance.

During unfinished-listing pressure, one coverage lane can admit today's boards
and the remaining lanes continue existing work. New coverage and listing
continuations share an atomic two-producer ceiling whenever downstream drain work
exists, leaving six of the eight shared slots available to drain. The existing
one-producer ceiling remains in force under staging-volume pressure. With no
downstream drain inventory, idle capacity can still finish listings. Today's
eligible active continuations now outrank a recently productive older catalog.
When the current-cohort allowance fills, new intake waits for it to drain.
The operator ticker reports the total unfinished inventory and current-cohort
inventory separately, and identifies intake that is limited to today's cohort.

Below unfinished-listing and staging pressure, the existing elastic coverage
planner and listing starvation pacing remain in force. Both balanced and continuation-only distributed workers carry the pressure rule. The Mac installation's release checks include the new capacity helper so an older helper cannot silently accompany a newer dispatcher.

Continuation selection also follows the existing cohort rule within each phase: today's eligible active boards first, other active cohorts second, then recovery boards. Eligibility and retry conditions remain part of every query. This does not bypass a listing/enrichment dependency or a provider backoff.

Focused tests exercise eight concurrent producer attempts, delayed drain inventory, idle-capacity lending when only listing remains, expired leases, cohort priority, and retained eligibility guards. The live read-only selection-plan check completed in about 12 milliseconds. Actual queue-growth and throughput effects must be measured after deployment; these tests and snapshots do not establish a production improvement.
