# Automatic ATS cohort workload balancing

This changes future weekday assignments while retaining the existing acquisition scheduler, worker slots, daily coverage target, admission backpressure, recovery rules, jobs, and scores.

New active API boards reserve estimated work on the lightest weekday. Successful discovery still makes the first collection immediately eligible. Subsequent collections follow the persisted weekday. Parked discoveries and browser-only Gusto boards keep their existing assignment behavior.

The daily maintenance job refreshes workload estimates at 00:10 America/Chicago. It uses each board's latest successful processed collection from the last 30 days and recorded acquisition worker time. Recorded turns longer than three minutes are excluded to avoid treating abandoned worker receipts as occupied capacity. Worker time is a relative cost estimate, not a prediction of elapsed completion time. Unmeasured boards use their validated listing volume and the provider's median cost per listing; placeholder volume uses the provider's typical board size. Providers without measurements use the catalog median, or a conservative default before any samples exist.

The maintenance job considers existing-board moves at most once per seven days. It acts only above 15% maximum workload deviation from the weekly mean and requires at least a 5% reduction in squared workload variation. Each review can move at most 100 boards or 2% of the catalog, whichever is smaller. Every applied move is retained in an append-only database review receipt.

An established board can move only when its most recent complete-cycle measurement matches its last processed collection within the last seven days, it has no unfinished batch or live lease, it has no failure/retry count, and its next collection is more than a day away at its normal weekly opening. Longer cooldowns and custom due dates remain untouched. The new slot must be at least four days after its last completed collection and must not postpone its already scheduled collection. A board cannot move again for 28 days. Conditional updates recheck its status, weekday, due date, processing timestamp, retries, and unfinished work before changing it. If concurrent changes leave too little benefit, the moves roll back while the estimate refresh still proceeds.

Discovery reservations and maintenance writes share a short transaction lock. The expensive snapshot query runs outside that lock. Daily refreshes correct estimates as boards complete collections or change status. Missing estimates, or estimates older than 36 hours, fall back to the previous deterministic assignment and do not delay discovery.

The legacy day backfill now repairs only invalid weekdays, preserving every valid persisted assignment. It cannot undo workload-aware placement or later automatic moves.

## Preview and operation

`npm run ats:balance-rotation` prints a fresh read-only preview. `npm run ats:balance-rotation:apply` refreshes estimates and applies eligible moves when the weekly review is due. An offline snapshot may be inspected with `--snapshot file.json`; apply refuses offline snapshots or an overridden observation time.

The normal M70 release initializes estimates and enables the daily timer. Deployment stops its timer and waits for an existing review to finish before swapping releases. Maintenance-mode releases do not enable it, and rollback restores prior timer ownership.

## Initial live-data preview

The October 7, 2026 read-only snapshot contained 64,510 active API boards: 63,978 with recent recorded complete-cycle worker time and 532 using estimates. The initial plan proposed 100 moves, about 0.16% of boards. Estimated squared workload variation fell 55.5%; maximum deviation from the mean fell from 46.8% to 34.1%. These are model results from that snapshot, not an observed throughput improvement. No production assignments were changed by the preview.
