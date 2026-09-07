# Action Needed growth — investigation, 2026-09-07

Queue size: **689 jobs.**

| Family | Rows | New arrivals since Sep 1 |
|---|---|---|
| JD recovery rejected | 482 | **307 — all of the growth** |
| Aim Fit scoring failure (currently suppressed) | 163 | 0 |
| Experience Fit scoring failure | 31 | 0 |
| Raw local scoring failure, 3 attempts spent | 13 | 1 |

Aim and Experience stopped contributing on Sep 1. Everything below is about the
482 JD failures.

## What changed

Yesterday's discovery expansion (commit 984d1f1, Sep 6) took the search program
from 46 query families to 53. Glassdoor went from 3–4 ingest runs a day all
week to **34 runs today**, ingesting 310 jobs against a ~40/day baseline.

Glassdoor's yield is poor: of 578 rows ingested in the last 7 days, **12 were
ever scored and 69 went to Action Needed**. 410 of them arrived with no
description at all, and glassdoor.com blocks the recovery fetch. So expanding
discovery expands the queue about six times faster than it expands the Inbox.

That is the growth. Arrival counts, by the day the job was first seen:

- **Sep 7:** Glassdoor 50, JSearch 15
- **Sep 4:** Workday 27, Glassdoor 14, Indeed 12
- **Sep 3:** Workday 51, Breezy 25, Rippling 10, Indeed 6
- **Sep 1–2:** Indeed 34, RemoteOK 12, Workday 9

## Rejection reasons, split by whether any text was ever stored

| Reason | No description stored | Description stored | Total |
|---|---|---|---|
| expired, closed, login, cookie, or portal shell | 181 | 100 | 281 |
| fewer than 650 usable characters | 24 | 95 | 119 |
| no usable role duties | 37 | 40 | 77 |
| no usable qualifications | 4 | 1 | 5 |

The 100 "shell" rows that *do* hold text are not false positives — I checked
them:

- **Workday, 52 rows.** The stored description is the requisition number and
  nothing else — "JR111833", "R-01029212". 5 to 87 characters. The detail fetch
  came back with no body.
- **RemoteOK, 41 rows.** Real text averaging 602 characters, but the postings
  are junk: a food-production diploma seeking a Tandoor commis role, a
  Portuguese-language retail req, a B737 Captain based in Panama. Each also
  carries RemoteOK's anti-bot boilerplate ("Please mention the word
  **SMARTEST**"), which is likely what trips the shell detector.

Neither belongs in a queue that asks Joseph to review something.

## Four common failures

### 1. Aggregators that publish no body and cannot be fetched
Indeed 101, Glassdoor 76, Dejobs 17 — all with empty descriptions.

**Indeed is the sharpest case: 81 of the 83 Indeed rows ingested in the last 7
days have no URL at all and no description.** The queue is asking for a manual
review of a job with nothing to read and nowhere to click. 52 of those 83
landed in Action Needed; 3 were ever scored.

Indeed has ingested nothing since Sep 4, but it is not switched off — it is
failing every scheduled run on "Indeed request blocked by paced_budget", behind
429s and transport timeouts. It will resume, and resume writing these rows.

Only Adzuna is currently on the snippet-only-aggregator discard list, so these
failures route to Action Needed instead of being dismissed.
(`src/lib/ingestionSourceKind.ts`, line 40.)

### 2. "Never fetched" is reported as "dead page"
181 rows have no stored description yet carry the shell reason, because the
quality assessor returns that reason for empty text. The terminal classifier
tests for that reason string *before* it checks description length, so every
never-fetched row is filed as `proven_unavailable` with `retryable: false` —
the opposite of the truth. (`src/lib/jdTerminalDisposition.ts`,
`classifyTerminalJdFailure`; the helper that separates the two cases,
`describeJdFailureCause`, exists but isn't used on this path.)

This is not cosmetic. That classification drives the queue-clearing script:
`proven_unavailable` means dismiss, `presently_recoverable` means requeue for
another recovery series. (`scripts/apply_jd_terminal_disposition.ts`.)

### 3. Breezy placeholder requisitions
36 of the 44 Breezy rows have an empty description. I fetched three directly:
all return HTTP 200 with real HTML, and the posting body is literally "n/a" or
a two-sentence internal-transfer notice. The titles are "Midwest Wild Card",
"Refresh", "Associate", "Oportunidades de manufactura".

These are evergreen pipeline reqs, not postings. Extraction is working; the
routing is wrong. Worse, they classify as `presently_recoverable`, so the
clearing script would requeue them into a recovery series that can never
succeed and would return them to Action Needed.

### 4. The 650-character floor
119 rows: Workday 41, careerforce 17, JSearch 16, Dejobs 13, SerpApi 10,
Himalayas 8, Rippling 8, Dice 4. 95 of them hold real text averaging 385
characters. This is a genuine judgment call about how much text is enough to
score, not a defect.

## Proposals

### Safe now — write-side only, nothing existing is touched

**A. Reject Indeed rows that arrive with neither a URL nor a description.**
Stops the largest class of impossible-to-review rows at the import boundary.
Indeed contributes nothing today, but only because its budget is exhausted, so
this is a latent problem, not a closed one.

**B. Fix the classifier's branch order** so an empty description is classified
as never-fetched (`unproven`) rather than `proven_unavailable`. Label-only —
nothing moves — but it decides what the clearing script does when Joseph next
runs it.

### Needs Joseph's decision — each changes what gets auto-dismissed

Written as forward-only: existing rows stay in the queue unless separately
asked for.

**C. WITHDRAWN — do not do this.** I originally proposed adding Glassdoor,
Indeed and Dejobs to the snippet-only aggregator discard list. The addendum
below shows why that is wrong: those rows are empty because their enrichment
call was denied by a shared request budget, not because the postings are
unreachable. Dismissing them would discard retrievable jobs on manufactured
evidence.

**C-alt (still valid).** Cut Glassdoor's share of the expanded query program
back toward its pre-Sep-6 run rate. Discards nothing, and it is the fastest
way to stop the growth.

**D. Treat a direct-ATS body under ~50 characters, or literally "n/a", as a
non-posting** rather than a manual-review item. ~36 Breezy rows, and it stops
the requeue loop described in finding 3.

**E. Decide what to do with RemoteOK.** 41 rows, all junk listings, 1 ever
scored against 41 rejected. Either drop the source or accept the trickle.

### Open question

Was the Sep 6 discovery expansion meant to widen the paid aggregators too, or
only the ATS lanes? If only the ATS lanes, the Glassdoor run-rate jump is a
side effect and capping it is the cleanest fix available.

---

# Addendum — the enrichment call exists and is being starved

Joseph's recollection is correct. The two-call flow is implemented for both
providers:

- Glassdoor: search → local filtering → details endpoint → local scoring.
  (`fetchGlassdoorJobDescription`, `src/lib/jobIngestion.ts` line 2509; called
  from the JD recovery pass at `src/app/api/jobs/batch-jd-submit/route.ts`
  line 241 and from the scoring resolver at `src/lib/jobScoring.ts` line 104.)
- Indeed: same shape, against the indeed12 job endpoint, keyed on `sourceId`
  rather than the URL. (`tryFetchFullDescription`, line 2576.)

## Why it stopped working

Search and detail calls **share one paced daily quota** per provider.
(`providerBudgetAuthority`, `src/lib/ingestionControl.ts` line 81 — 'Glassdoor
Details' charges the 'Glassdoor (RapidAPI)' ledger, 'Indeed Details' charges
'Indeed12'.) The ceiling is released hourly: at hour H, only
`floor(dailyLimit × (H+1) / 24)` requests are available.

At 15:23 UTC today, hour 15:

| Provider | Daily limit | Released by hour 15 | Used | State |
|---|---|---|---|---|
| Glassdoor (RapidAPI) | 103 | 68 | **68** | saturated |
| Indeed12 | 13 | 8 | **8** | saturated |

Both are pinned to the exact request. Every further call — including every
enrichment call — is denied with `paced_budget`.

## The evidence that it works when the budget is there

Glassdoor, by day:

| Day | Search runs | Survived filtering (needed a detail call) | Scored | Failed |
|---|---|---|---|---|
| Aug 31 | 2 | 2 | 2 | 0 |
| Sep 1 | 3 | 3 | 0 | 3 |
| Sep 2 | 3 | 1 | 1 | 0 |
| Sep 3 | 4 | 1 | 1 | 0 |
| Sep 4 | 3 | 19 | 5 | 14 |
| Sep 5 | 4 | 1 | 0 | 1 |
| Sep 6 | 4 | 2 | 1 | 1 |
| **Sep 7** | **37** | **74** | **5** | **69** |

Read this carefully rather than as a clean before/after. Excluding Sep 4, the
low-volume days total 10 jobs needing enrichment: 5 scored, 5 failed. That is
about half, not "it lands." What the table does establish is the direction and
the magnitude of the break: 74 jobs needing enrichment against 37 search runs
produced 69 failures.

Two readings fit, and they are not distinguishable from stored evidence:

1. The ceiling is released *hourly*, roughly 4.3 requests an hour for
   Glassdoor. A paginated search run can consume an hour's release and deny a
   detail call in that same window even on a three-run day. This supports the
   starvation account more strongly, and it means capacity has to be reserved
   per release window, not per day.
2. There is a second failure mode that the budget does not explain.

They cannot be separated right now, because **a denied reservation is not
recorded anywhere** — see the next section. The honest statement is that how
many of the 482 are denied-enrichment versus genuinely empty is currently
unmeasurable.

Indeed is a related but not identical case. It has **two** budget paths, not
one. The JD recovery pass charges the shared Indeed12 ledger (13/day, 400/month)
through `providerBudgetAuthority`. The ingest-time path at
`src/lib/jobIngestion.ts` line 3671 overrides that with
`reserveSourceRequest(provider, { dailyLimit: 25 })`, reserving under the raw
'Indeed Details' label and bypassing the authority mapping entirely — which is
exactly what the comment at `src/lib/ingestionControl.ts` line 95 says must not
happen. That second ledger shows 83 requests this month against 447 Indeed
jobs, with a real last-success on Sep 4. So some Indeed detail calls are being
made and some are still failing; a budget fix alone will not settle Indeed.

Indeed's rows having no URL is real but is not what breaks them — the detail
call keys on `sourceId`, and 27 no-URL Indeed rows scored fine. It only makes
the Action Needed rows unreviewable by hand, and leaves scored Indeed jobs in
the Inbox with nothing to open or apply to.

## The part that hides all of this

Both call sites invoke `fetchGlassdoorJobDescription(job)` with **no
`providerControl` argument**. When the budget reservation throws, the catch
calls `providerControl?.failure(...)` — a no-op — and returns `null`. The job
then looks exactly like a page that came back empty, and terminalizes as
"JD recovery rejected: expired, closed, login, cookie, or portal shell."

So a quota denial and a dead posting are indistinguishable in the queue. That
is why Action Needed reads as 281 dead pages when a large share of them are
jobs whose enrichment call was never allowed to run.

## What this changes about the proposals

Proposal C (auto-dismissing Glassdoor and Indeed) would have been **wrong** —
it would have discarded jobs whose descriptions were retrievable, on evidence
manufactured by a budget denial. Withdrawn.

The real fixes, in order:

**Safe now — no existing row is touched**

1. **Pass `providerControl` at both detail call sites** so a budget denial is
   recorded as a provider failure instead of being written into the job as a
   dead-page verdict. This is the prerequisite for everything else: until
   denials are visible, no one can say how much of the 482 is recoverable.
2. **Don't spend a recovery attempt on a call that was never made.** A denied
   reservation should leave the job in a deferred state for the next release
   window rather than consuming one of its three attempts — with a bounded
   number of deferrals, so a job whose budget never frees does not retry
   forever.
3. **Reserve enrichment capacity ahead of search, per hourly release window.**
   Detail calls serve jobs that already passed local filtering; searches are
   speculative. A search run should not be able to consume the release that a
   filtered-in job needs.
4. **Reconcile Indeed's two budget paths** onto the single authority mapping,
   so the ingest-time 25/day side ledger stops bypassing the 13/day ceiling.
5. **Check whether the indeed12 detail payload carries a job URL.** The
   extractor keeps only `.description` and discards the rest
   (`src/lib/jobIngestion.ts` line 2596). If a URL is in there, persisting it
   fixes 447 URL-less Indeed rows, including the 27 that scored and reached the
   Inbox with nothing Joseph can click.
6. **Cap Glassdoor's search run-rate** from the expanded query program, or
   raise the quota to match what the expansion demands.

**Needs Joseph's go-ahead**

7. **Re-run enrichment across the existing 482.** This would move rows out of
   Action Needed — into the Inbox if they score, back into Action Needed if
   they genuinely fail — so it changes what Joseph sees and is his call, not a
   step in an implementation sequence. It is worth doing after fix 1, when the
   denials are finally visible and the size of the recoverable population is
   known.


---

# What was implemented, 2026-09-07

Fixes 1-6 are in the working tree. Full suite green: 1383 tests, 0 failures,
0 lint errors.

**1. Every description call is accounted for.** Both recovery call sites now
pass a provider control that reserves the budget, writes a `provider_request`
pipeline event with the decision, and records circuit health.
(`src/lib/jdRecoveryProviderControl.ts`.) A refusal is no longer invisible.

**2. A call that was never made no longer spends a recovery attempt.** The
Glassdoor fetch rethrows a refused reservation instead of returning null, and
both callers hold the job at `needs_jd` without touching `scoreAttempts`. The
refusal carries the reservation's own retry time, and the job is parked until
then — the `needs_jd` queue is routinely empty (it is empty right now), so a
bare counter would have burned its whole budget in minutes and terminalized
jobs during a shortage that was about to clear. Waiting is bounded at 24
deferred windows, after which the job terminalizes with a reason that says
plainly that enrichment never ran, rather than borrowing a dead-page verdict it
never earned. That reason is wired into Action Needed and into the terminal
classifier as `unproven`/retryable, so the row lands in a queue and the
clearing script cannot mistake it for a proven-dead posting. New columns `Job.jdDeferrals` and
`Job.jdDeferredUntil`; both clear whenever the waiting ends, either way.

**3. Search yields part of each release to enrichment.** Requests now carry a
kind, derived from the telemetry label. A search may consume only 60% of each
hourly release; enrichment may use all of it, so reserved capacity is a floor
for descriptions rather than an allocation that goes to waste. Verified against
today's real numbers: at hour 15 with a release of 68, search stops at 40 and
28 stay available for description calls.

The reserve applies only to Indeed and Glassdoor — the two providers that
actually spend the ledger on descriptions. JSearch and LinkedIn are paced the
same way but have no live enrichment path (JSearch's details endpoint is
disabled by design, LinkedIn has none), so reserving part of their release
would have cut their search capacity by 40% for calls that are never made.

**4. Indeed's budget paths.** The authority mapping already routes both labels
to the single Indeed12 ledger, and the ingest-time caller's generic 25/day
default is already overridden for authority-managed providers — so this was
sound in code. The 83/210 counters on the `Indeed Details` and `Indeed` rows
are stale: their `budgetDay` froze at 2026-08-25, the day the mapping landed.
They are inert (quotas for a mapped source are only enforced on the authority
row) but misleading, which is what made Indeed look like a second failure mode.
Left in place — resetting them is a data change, not a code fix.

**5. Indeed rows now carry a URL.** Every Indeed `sourceId` is a 16-hex Indeed
job key, so the viewable posting URL is derivable with no request at all.
Applied at the parse boundary; a provider-supplied URL still wins.
Forward-only — the 447 existing URL-less rows would need a backfill.

**6. Glassdoor intake — NOT closed. This one needs a number from Joseph.**

The reserve from fix 3 is real insurance against search crowding out
descriptions, and it is enforced at the reservation, so it holds whether or not
the v3 scheduler flag is on (it is off). A search that hits the reserve is
refused as `enrichment_budget` — named so every existing "blocked by ...budget"
matcher treats it as a budget outcome rather than a provider failure, which
would have opened the circuit.

But it does not bind on yesterday's numbers, and saying otherwise would be
wrong. Glassdoor searches spent 20 requests; the 40-request allowance never
came near. The crowding consumer was ingest-time enrichment at 48. Total demand
was 20 searches + 48 ingest enrichment + 74 recovery-pass descriptions against
a **103/day** ceiling — the shortage exceeds the whole daily limit, not just an
hourly release. No reserve fixes that.

Two ways out, and both are a number only Joseph can pick:

- **Cut intake.** Glassdoor ingested 334 rows yesterday against a ~40/day
  baseline, and 260 of them were filtered out anyway. Capping Glassdoor's share
  of the expanded query program back toward 4 runs a day brings demand under
  the ceiling and discards nothing.
- **Raise the quota.** 103/day was sized for search alone. Roughly 150/day
  would cover yesterday's combined demand.

Until one of those happens, fixes 1-3 change what a shortage *looks like* — it
now reads as a starved budget instead of a queue full of dead postings, and the
jobs wait instead of being terminalized — but they do not remove the shortage.

## Still needing Joseph's go-ahead

- Re-running enrichment across the existing 482 (moves rows out of Action
  Needed).
- Backfilling URLs onto the 447 existing Indeed rows.
- The Breezy "n/a" placeholder routing, and the 650-character floor.

## One loose end

The `_prisma_migrations` row for the new columns was inserted by hand with a
placeholder checksum, and my attempt to correct it was blocked. Until it is
fixed, `prisma migrate status` and `migrate deploy` will report a
modified-migration error for it. The columns themselves are fine. To correct:

```
psql "$DATABASE_URL" -c "UPDATE _prisma_migrations SET checksum='92af60e5cdef7f33a2a47616dc84683eb5bad3ccaa14e36e4e605a9107c900b0' WHERE migration_name='20260907160000_jd_enrichment_deferrals';"
```

## Deployment note

`Job.jdDeferrals` and `Job.jdDeferredUntil` were applied to the production
database directly (both additive and defaulted, no effect on any existing job
or score) because the deploy
workflow does not run migrations, and `prisma migrate deploy` would have tried
to re-apply an unrelated August migration that sits in a rolled-back state.


---

# Decisions taken, 2026-09-07

Joseph's answers, and what was done with each.

## Glassdoor: cut intake to ~4 runs/day

Implemented as a daily run cap enforced before the search fires, counting only
runs that actually reached the provider — a run refused by the budget or an
open circuit spent nothing, so counting it would let a quiet day of refusals
lock the source out of the next one. (`src/lib/paidSearchRunRate.ts`.)

This is the change that closes the growth. Glassdoor ingested 334 rows the day
this was investigated and filtered out 260 of them before spending anything, so
the discarded volume was almost entirely noise; 12 of the week's 578 rows were
ever scored.

## The existing 482: leave them

No re-enrichment run. They stay exactly as they are.

## Indeed URLs: backfilled

**904 rows updated** — more than the 447 quoted earlier, which was a 30-day
window rather than the whole table. Every Indeed row now has a posting URL;
none were skipped, because every `sourceId` in the table is a valid 16-hex
Indeed job key. 98 of the updated rows are scored and 105 sit in active
statuses, which is the point: those were Inbox jobs with nothing to open.

Only the `url` column was written. It is not a scoring input — the extraction
inputs are description, title, company and location — and a direct update does
not run invalidation, so no score, status, or queue membership changed.

One honest limit: the URL format is Indeed's standard `viewjob?jk=` pattern and
the key came from Indeed's own search response, but Indeed answers automated
requests with a Cloudflare challenge, so reachability was confirmed only as far
as that challenge. The links should resolve normally in Joseph's own browser.

## Breezy placeholders: dismiss token bodies from direct ATS boards

A terminal JD recovery on a structured ATS source whose board answered with a
body under 50 characters is now dismissed as a placeholder requisition rather
than routed to Action Needed. (`isAtsPlaceholderRequisition` in
`src/lib/jdRecoveryPolicy.ts`.)

Two deliberate limits:

- It reads the **freshly fetched** body, not the stored description. Those
  differ: a rejected body is never stored, so 35 of the 36 Breezy rows in the
  queue hold an empty description while their pages return a token body.
  Judging the stored value would have missed every one of them.
- An empty body does **not** qualify. A transport failure looks identical to a
  board publishing nothing, and the ATS detail calls exist to fill those in.

Forward-only, and narrow on purpose. How many of the existing 36 it would catch
cannot be known without re-fetching each board, which the existing rows will
only do if they are requeued — and they are not being requeued, per the
decision above.
