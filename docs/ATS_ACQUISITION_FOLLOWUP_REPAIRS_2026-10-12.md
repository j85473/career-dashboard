# ATS acquisition follow-up repairs — October 12, 2026

The October 11 release improved Workday request scheduling. The overnight audit
also found incomplete Manatal pages repeatedly retried, provider bursts,
downloaded employer-verification holds, and unfinished maintenance reviews.

Manatal listings now retain postings with a valid identity, title and employer
when their description is empty. Only that posting needs a protected detail-page
request. A missing description remains a durable unavailable outcome for normal
JD recovery. Page counts, continuation bounds and identities remain exact; no
other posting on that page is dropped.

Manatal, Workable, Eightfold, HireHive and Recruitee share a one-second dispatch
spacing gate across processes. This is a conservative application setting, not
a claim about a vendor's published limit. The gate supplements the two provider
slots and employer fence. Cancellation releases its exact lease, and provider
cooldowns are checked before and after pacing. Other providers retain their
request overlap. JobScore's hourly per-board feed interval remains unchanged.

Oracle, UKG and Zoho downloaded items can recover missing employer metadata from
the exact public career site. Oracle customer headers are read as inert HTML;
their primary corporate-home link supplies a metadata lookup, without executing
vendor scripts or deriving a name from a hostname. Oracle's former CX entry is
allowed to redirect to its exact jobsearch site only with Oracle corporate-logo
evidence. The word Brand inside a real employer name no longer makes it an
internal label; Default Brand, branding templates and logo filenames remain
rejected. Unverified or conflicting names keep their existing holds.

The guarded existing-hold command is `scripts/repair_ats_employer_holds.ts`.
Its default is a fresh source-verified dry run for the three exact sites found
by the audit. Applying requires its reviewed selection hash. One serializable
transaction writes only board-scoped verified-source rules and makes the exact
still-published, unleased segments eligible. It checks each segment's prior
cursor, count and retry date and refuses conflicting employer rules. It does
not modify existing jobs, score fields, source items or immutable manifests.

Liveness probes share provider capacity and pacing, respect existing cooldowns,
and cannot publish provider failures. Each provider has at most one active
liveness probe. A refusal defers the remaining probes for that provider as
inconclusive; it is never evidence for retirement. A review has a 45-minute
probe budget, with unfinished probes retained as inconclusive, and each review
arm has an independent deadline. Existing absence, history and retirement
brakes remain authoritative. The weekly discovery timer now treats contention
with an already-running audit as a successful skip. Actual command failures
still fail the service; Common Crawl checkpoints remain intact.

Release through the guarded M70 workflow. Validate source recovery before
applying the existing-hold command, compare pre/post score and score-history
fingerprints, and inspect productive receipts after activation. Do not clear
provider circuits, retry calendars, existing scores or discovery checkpoints.

The full maintenance rerun exposed additional compatibility and race guards.
Liveness now uses acquisition's actual XML/JSON format contract, prepares
public-board configuration before parsing feeds, and binds the exact board
identity. JobScore probes reserve the existing hourly feed interval inside
dispatch capacity. Successful immutable v2 pages and raw/canonical observations
protect a board's history just as legacy receipts do. Retirement rechecks current
status, successful history and active acquisition inside a serializable write;
promotion also refuses to overwrite a status changed during the sweep.

Deployment now reclaims expired provider request reservations after production
work owners have stopped. This covers vendor slots, employer fences and pacing
mutexes left by a killed probe. The atomic expiry predicate preserves renewed
leases; cooldowns, budgets, successful-dispatch times and work receipts remain.
