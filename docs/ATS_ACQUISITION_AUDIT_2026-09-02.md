# ATS acquisition audit — 2026-09-02

Written after the M70 migration, in response to "we are making twenty patches a
day to ATS API calls." The question asked was whether to repair the current
system or replace it.

**Answer: repair. Do not rebuild.** The fetching layer is not what is broken.
It moved 348,746 postings in the last seven days, which is more than any
replacement would do in its first month. What is broken is one scheduling rule,
and what is expensive is the set of boards we choose to call. Neither is fixed
by a rewrite, and a rewrite would throw away the part that works.

The reason it *feels* like it needs replacing is real and is addressed in
"Why this keeps happening" below. It is not a code-quality problem.

---

## 1. What is actually wrong

### The defect: a refusal we make ourselves is treated as the board's failure

When a listing request fails, the batch is rescheduled. If the board had already
been demoted, the batch is pushed to that board's next weekly check instead of
the ordinary fifteen-minute retry. The intent is sound: a failing board should
not be re-contacted ninety-six times a day.

The rule was applied to *every* listing error, including the errors that never
reach the board at all:

- `ATS request deferred by circuit_open` — the platform breaker is open, so we
  declined to make the call
- `rate-limited this request` — the platform pushed back on every caller
- provider budget refusals

None of these is evidence about the board. Holding the batch for six and a half
days spares that board nothing, because no request was going to be sent to it.
The measured effect on 2026-09-02:

| Platform | Batches held | Avg hold | Circuit's own reopen |
|---|---|---|---|
| Workday | 2,717 | 156 h | closed (nothing to wait for) |
| Personio | 1,378 | 155 h | 6 h |
| Workable | 504 | 163 h | 6 h |

**4,599 listing batches parked for ~6.5 days behind circuits due to reopen in
six hours.** All 6,508 batches sitting in `fetching` had made zero HTTP
requests, averaged 20.4 hours of age, and held no lease.

The defect starved Workday's lane specifically. Workday accounts for 4,197 of
the 6,508 stalled batches, and its daily intake fell:

```
08-31: 47,475   →   09-01: 30,087   →   09-02: 8,528
```

**Total ATS intake did not fall with it**, and the distinction matters:

```
08-30: 57,397   08-31: 95,721   09-01: 64,171   09-02: 84,085
```

SmartRecruiters rose 14,345 → 36,607 over the same window and absorbed the
freed capacity. So this is a **mix shift, not a throughput outage** — one
platform's work was stranded while others took its lanes. Note also that the
stalled batches were created on 09-01 at 18:59, *after* the 47k → 30k drop, so
they cannot explain that first day's decline; that was the circuits opening,
and the parking is what stopped Workday recovering.

### Why it looked like the migration broke something

The M70 move raised concurrency against the same upstream rate limits, which
opened platform circuits more often. Every circuit opening then converted,
through the rule above, into a week-long park. The migration supplied the
trigger; the scheduling rule supplied the damage. What Joseph was seeing as
"ATS calls not working" was individual platforms going dark for days at a time,
not the pipeline stopping.

### The same mistake, twice, in sibling branches

The commit immediately before this audit fixed exactly this bug in the *drain*
phase — acquired postings frozen for a week because the board they came from had
been demoted after the postings were already in hand. That fix was correct and
scoped to drain. The identical error in the *listing* phase was left in place.

The principle was already written down, and correctly, at
`isAtsBoardLevelFailure`:

> A circuit block, a platform pause, a provider budget refusal and a 429 all mean
> the pipeline declined to make the call [...] None of them is evidence about
> this board.

That predicate already guarded the board's failure record and the demotion
day-count. It did not guard the retry schedule. Three call sites need the same
rule; two had it.

Worth recording, since it narrows the blast radius: the **legacy lane already
gets this right**. It branches on "the request was deferred" and "the platform
throttled us" before it ever reaches the failure schedule, so a refusal there
earns the circuit's own retry time or a 15-minute backoff, never an escalation.
The gap was specific to the v2 retry path. (That lane is also deliberately
dormant — every board still on it is excluded — so it is correct *and* unused.)

### Fixed

The retry decision now consults the same authority as the failure record.
Committed on `fix/ats-pipeline-refusal-scheduling`. Full suite passes (1,269).

**This fix is committed locally on an unpushed branch and is not deployed.**
Deployment runs from the "Deploy to M70" workflow on a push to `main`, so the
branch has to be pushed and merged before any of this reaches production.

Its live urgency was measured directly: after releasing the 4,599 parked
batches, the running (unfixed) code re-parked 2,502 of them within ninety
seconds, some out to 2026-09-10. A data repair cannot hold against it.

The re-parked rows were then checked to confirm the fix actually covers them:

| Error on re-parked rows | Count | Fix releases it? |
|---|---|---|
| `deferred by circuit_open` | 2,676 | yes |
| HTTP 404 / 422 / 403 / 500 / `fetch failed` | 36 | no — genuine board failures, correctly kept on the weekly slot |

**98.7% of the re-parked work is the circuit-blocked subset the fix targets.**
The remaining 36 are boards actually failing, and they should stay parked.

---

## 2. What it costs to run

Separate from the defect, and true on the Pi as well. This is the cost case, not
a bug report.

**Seven days: 348,339 postings acquired, 123 ever reached a human-facing
status. 0.035%.**

(Counted from status history, so it includes postings reviewed and then
dismissed. 103 are sitting in a human-facing status right now.)

Where the other 99.97% goes:

| Rejected for | Count (7d) | Share |
|---|---|---|
| Location outside searched geography | 160,381 | 46% |
| Not in English | 39,265 | 11% |
| Wrong role family (clinical, hourly, software, finance…) | ~120,000 | ~34% |

**57% of everything downloaded is discarded on two attributes — language and
country — that are properties of the board, not of the posting.** A German
Personio board publishing German-language roles will not produce a Minneapolis
sales role in this cycle or any future one. We currently re-derive that verdict
once per posting, tens of thousands of times per week, having already paid to
download each one.

Supporting numbers:

- 104,417 boards known; 43,163 active
- 21,063 of those active boards (49%) have never produced a single job
- 17,317 active boards (40%) are past the weekly rotation SLO; average age of
  last check is 9.8 days against a 7-day target

Worker capacity, 24 hours: **158,488 claims**, of which ~27,000 were errors that
made no HTTP request and 10,197 were compaction claims doing no work. Roughly
23% of all claims accomplished nothing — largely the defect above, each claim
still costing several round trips against a Prisma pool capped at 9 connections.

The lever here is **board selection**, not fetch filtering. Greenhouse, Lever,
Workable and the rest return the whole board; we cannot ask them for "sales roles
in Minnesota." What we *can* do is stop calling boards that have proven they
publish in the wrong language or the wrong country. The machinery for this
already exists and is well-reasoned — it is simply not being run as a program.

---

## 3. Why this keeps happening

This is the part that matters more than any individual bug, and it is not a
code-quality problem. The code is careful. Comments cite incident dates and
posting counts; the exclusion policy carries a measured statistical argument for
its thresholds. This was not written carelessly.

The failure mode is that **each incident is fixed at the call site where it was
observed, rather than at the concept it violates.** "A refusal we imposed is not
the board's fault" is a single rule that must hold in every place a failure
influences scheduling. It was discovered three times and fixed twice, in
two different files, on two different days — and the third instance became this
week's outage.

The churn confirms the pattern rather than random breakage:

```
ATS commits per week:  W28: 2   W29: 4   W30: 2   W31: 3
                       W32: 1   W34: 8   W35: 24  W36: 31
```

The accelerating curve is the signature of patches that resolve instances
instead of classes. A rewrite would reset this curve to zero and then reproduce
it, because the pressure generating it is the number of independent places a
policy decision can be made — and a new system starts with the same problem
unless that is designed out.

Structural contributors:

- **19 ATS tables and 13,751 lines of ATS library code.** Ten distinct batch
  statuses, of which four (`operator_abandoned`, `reset_processed`,
  `reset_failed`, `interrupted`) record that a human intervened rather than any
  pipeline state.
- **~25 one-off repair scripts**, most of them written to unstick a condition
  that had no automatic path back.
- **The monitoring cannot see the class of failure that keeps happening.** The
  watchdog's stranded-work check is scoped to boards whose status is `active`.
  The weekly-slot rule that caused this outage fires *only* for boards that are
  `parked` or `blacklisted`. The two sets are exactly disjoint, so no amount of
  watchdog running would ever have surfaced this. That is the detection half of
  the same "fixed at the instance, not the class" pattern: the check was written
  against the incident that prompted it rather than against the rule it guards.

### Corrections to earlier drafts of this audit

Two findings in the first draft were wrong and are withdrawn; they are recorded
here rather than deleted, because "we checked and it was fine" is worth as much
as a defect when deciding where to spend effort.

- **Segments do have durable intermediate state.** They carry a real machine —
  `sealed` → `published` → `processed` — with a processing offset, lease
  fencing, and a retry time. All 21,433 rows read `processed` because the
  segment layer is fully keeping up, and zero segments have a pending offset.
  A healthy steady state was misread as missing design. No work needed.
- **The operator batch statuses are not scar tissue.** `operator_abandoned`
  comes from two deliberate operator scripts, and `reset_processed` /
  `reset_failed` from a legitimate reset flow. They record intent, not damage.

---

## 4. Recommendation

**Repair, in this order. Do not rebuild.**

### Now — stops the bleeding

1. **Deploy the fix.** **Done** — merged to `main`, "Deploy to M70" succeeded in
   7m30s.
2. **Release the stranded batches, after the deploy and not before.** **Done** —
   2,678 Workday batches released.

   Measured against the same action taken *before* the deploy, which is the
   cleanest evidence the fix works:

   | | Before fix | After fix |
   |---|---|---|
   | Batches released | 2,717 | 2,678 |
   | Re-parked >12h within ~2 min | 2,502 | 80 |
   | Circuit-blocked rows' new deferral | ~6.5 days | under 1 hour |

   The 80 that still hold a long deferral are all genuine board failures — HTTP
   422, 404, 403, 500, `fetch failed` — which is the rule working as intended.
   The 3,168 circuit-blocked rows now wait for the circuit's own reopen instant
   instead of a week.

   The command, for future use:
   `node --import tsx scripts/release_pipeline_deferred_ats_batches.ts --apply`
   Dry run by default. Moves `nextAcquireAt` earlier only; releases work behind
   a still-open circuit to that circuit's own reopen instant rather than to now,
   so it does not aim a herd at a platform still refusing us. Touches no batch
   status, no board status, no Job row, and no score.

### Next — stops the recurrence (the actual fix for "20 patches a day")

3. **Make the refusal rule structural instead of remembered.** **Done.** The
   guard moved out of the call site and into the function that applies it, which
   now takes the failure's origin as a required argument. A caller can forget a
   condition; it cannot forget an argument the compiler demands. This rule had
   already been got wrong twice in two phases by callers that simply did not
   apply it, which is why the check belongs in the callee.
4. **Make the watchdog able to see this class of failure.** **Done.** Its
   stranded-work check covered only `active` boards while the rule that strands
   work fires only for `parked` and `blacklisted` ones — exactly disjoint, so no
   amount of running it could have surfaced this. It now also matches a demoted
   board's batch when the failure that parked it was one the pipeline imposed on
   itself, which is the signal that separates a board legitimately waiting for
   its weekly slot from work parked over our own refusal. Detection and repair
   share one predicate so the repair cannot drift from what is reported.

   Validated against the live catalog before the fix deployed: the widened arm
   matched 2,678 batches (2,011 blacklisted, 667 parked) that the old check
   could not see. **Once the dispatcher fix is in, the steady-state reading for
   that arm is zero — zero is healthy here, not a broken check.**
5. ~~**Reap batches for boards that will never be read.**~~ **Withdrawn — there
   is nothing to reap, and reaping would have destroyed live work.**

   The original claim was that 2,662 batches sit on blacklisted boards, are
   re-claimed forever, and can never produce. Checked before implementing:

   - **Every one of the 5,021 batches on blacklisted and parked boards was
     created on 2026-09-01 or 09-02** — the exact window the stranding bug was
     active. This is not an old graveyard; it is recent work that the weekly-slot
     defect froze.
   - **Demoted boards are genuinely still in rotation.** All 24,904 blacklisted
     boards were checked within the last 30 days, and both statuses are
     explicitly coverage-eligible alongside `active`. A demotion slows a board's
     cadence; it does not remove it.

   So these batches are legitimate in-flight work on boards that are still read,
   holding zero requests because of the defect fixed in item 1 — not because
   they are orphaned. Discarding them would have thrown away exactly the work
   the fix exists to release.

   This is the same misreading as the withdrawn segment finding: a population
   that looked permanently stuck was stuck for a reason that has since been
   fixed. The correct action is to watch them drain, not to reap them.

### Then — reduces the cost

6. **Run board pruning as a standing program, not an incident response.** Prune
   on language and country, which are stable board properties. Target the 57% of
   intake discarded on those two attributes.

   **Built.** A weekly review runs each pruning arm in its own dry-run mode,
   totals what they would reclaim, and prints the approved command for each. It
   is read-only by construction, and that is deliberate: every exclusion arm is
   gated behind `--apply --selection-hash <hash>`, where the hash pins the exact
   list a human reviewed. An excluded board is never re-judged, so automating
   the retirement on a timer would defeat the one control that makes it safe.
   The detection is what becomes standing; the irreversible half stays with the
   operator. (`scripts/review_ats_board_pruning.ts`, Monday 07:00 America/Chicago.)

   First run, against the live catalog:

   | Arm | Boards | Postings / rotation | Reversible |
   |---|---|---|---|
   | Unproductive or out of territory | 1,046 | 87,869 | no |
   | Never-relevant geography | 505 | 20,606 | no |
   | Low-yield demotion | 447 | 140,428 | yes |
   | **Total** | **1,998** | **248,903** | |

   The unproductive arm alone reports **10.1 worker-hours per day** reclaimed
   against a 96 worker-hour daily budget.
7. **Re-examine the demoted population.** 46,237 boards (44%) are parked or
   blacklisted. Some fraction were demoted by pipeline-imposed failures during
   past outages — one prior incident demoted 3,780 boards in a day against a
   baseline of 31. That population deserves an audit before it is treated as
   settled fact.

### Explicitly not recommended

- **A rewrite of the fetching layer.** It works. 348,746 postings in seven days.
- **`reset_ats_acquisition_fresh_start.ts`.** It would discard acquisition
  evidence, and nothing in this diagnosis requires it.
- **Raising worker concurrency.** The M70 has the headroom, but the current
  ceiling is upstream rate limits and a 9-connection database pool, not CPU.
  More concurrency opens more circuits, which is what started this.

---

## 5. Open question for the operator

The audit surfaced one judgement that is not the pipeline's to make: **44% of
known boards are currently parked or blacklisted.** If a meaningful share of
those were demoted by our own outages rather than their own behavior, the
rotation is smaller than intended and coverage is correspondingly worse. Whether
to re-judge that population — and on what evidence — is a product decision, not
a repair.
