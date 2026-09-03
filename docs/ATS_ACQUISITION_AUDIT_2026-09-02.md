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

This is most of the post-migration symptom. Workday daily intake:

```
08-31: 47,475   →   09-01: 30,087   →   09-02: 8,528
```

Workday accounts for 4,197 of the 6,508 stalled batches.

### Why it looked like the migration broke something

It largely did not. The M70 move raised concurrency against the same upstream
rate limits, which opened platform circuits more often. Every circuit opening
then converted, through the rule above, into a week-long park. The migration
supplied the trigger; the scheduling rule supplied the damage.

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

### Fixed

The retry decision now consults the same authority as the failure record.
Committed on `fix/ats-pipeline-refusal-scheduling`. Full suite passes (1,269).

**This fix is not yet deployed.** Its live urgency was measured directly: after
releasing the 4,599 parked batches, the running (unfixed) code re-parked 2,502
of them within ninety seconds, some out to 2026-09-10. A data repair cannot hold
against it.

---

## 2. What it costs to run

Separate from the defect, and true on the Pi as well. This is the cost case, not
a bug report.

**Seven days: 348,339 postings acquired, 103 reached a human. 0.03%.**

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
- **~25 one-off repair scripts.** Each is scar tissue from an incident that
  stranded work with no automatic path back.
- **`AtsIngestionSegment` has exactly one status across 21,184 rows:
  `processed`.** There is no durable intermediate segment state, so any
  interruption strands work with nothing to resume from, and recovery is
  necessarily a hand-run script.

---

## 4. Recommendation

**Repair, in this order. Do not rebuild.**

### Now — stops the bleeding

1. **Deploy the committed fix.** Until it ships, the running code re-parks
   released work within ninety seconds.
2. **Re-run the release script after deploying**, not before:
   `node --import tsx scripts/release_pipeline_deferred_ats_batches.ts --apply`
   Dry run by default. Moves `nextAcquireAt` earlier only; releases work behind
   a still-open circuit to that circuit's own reopen instant rather than to now,
   so it does not aim a herd at a platform still refusing us. Touches no batch
   status, no board status, no Job row, and no score.

### Next — stops the recurrence (the actual fix for "20 patches a day")

3. **Make the refusal rule structural instead of remembered.** Route every
   scheduling decision that consults a failure through one function that takes
   the failure's *origin*, so a new call site cannot silently omit the check.
   The predicate exists; what is missing is that nothing forces its use. This is
   the single highest-leverage change in this document.
4. **Give segments a real intermediate state** so an interrupted run resumes
   instead of requiring a repair script. This retires the four
   human-intervention batch statuses and most of the 25 scripts.
5. **Reap batches for boards that will never be read.** 2,591 batches belong to
   blacklisted boards; they are re-claimed forever and can never produce.

### Then — reduces the cost

6. **Run board pruning as a standing program, not an incident response.** Prune
   on language and country, which are stable board properties. Target the 57% of
   intake discarded on those two attributes. The tools already exist
   (`report_ats_board_geography.ts`, `exclude_never_relevant_ats_boards.ts`).
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
