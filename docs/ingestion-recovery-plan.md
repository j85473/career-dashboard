# Ingestion recovery plan (H3)

Goal: every source either works or visibly reports why, key changes ship by
`git push`, and "idle" stops being indistinguishable from "healthy".

## Where ingestion actually stands

Seven days of `IngestionSourceRun` telemetry, ordered by what it produced:

| source | seen | new | errors | verdict |
|---|---|---|---|---|
| ATS-greenhouse | 523,681 | 2,199 | 33,874 | healthy |
| ATS-lever | 156,833 | 1,681 | 29,899 | healthy |
| ATS-workday | 205,109 | 1,242 | 44,452 | healthy |
| CareerForce | — | 1,201 | 1 | healthy |
| Adzuna | 8,163 | 1,064 | 21 | healthy (503 blips) |
| ATS-ashby | 114,500 | 807 | 5,773 | healthy |
| LinkedIn (Apify) | 1,880 | 329 | 0 | healthy, best ratio |
| ATS-workable | 190 | 40 | **45,233** | rate-limited |
| ATS-bamboohr | 1,278 | 15 | **36,729** | returns HTML |
| Remotive / TheMuse | 6,617 | **0** | 3 | duplicates only |
| Arbeitnow | 0 | 0 | 0 | does nothing, reports success |
| Indeed / JSearch / LinkedIn / Glassdoor | 0 | 0 | 606 | broken |

The headline: **the ATS engine is the workhorse** — roughly 6,000 of ~7,000 new
jobs a week. The paid APIs are marginal by comparison. That reorders the work:
unblocking two ATS platforms is worth more than repairing two paid endpoints,
and both are worth less than being able to see which is which.

The `partial` status on Lever/Greenhouse is **not** a fault — it is per-board
`HTTP 404` from companies that removed their listing page, at an error ratio
between 10% and 50%. Expected at this scale.

---

## Phase 1 — Rotation that recovers (`src/lib/apiFallback.ts`)

`fetchWithKeyRotation` blacklists a key **permanently** on 429/402/403, with no
TTL, for the life of the process. Two keys on the Pi, two throttles, and every
later call throws "All configured API keys are exhausted or missing."

Replace the permanent `Set` with per-key cooldowns (`Map<service, Map<key,
expiresAt>>`), sized from evidence rather than a flat TTL:

- Read RapidAPI's `x-ratelimit-*-reset` headers when present.
- Body containing `MONTHLY` → cool until reset, capped at 30 days.
- Any other 429 → short cooldown (~60s); these are per-minute throttles.
- 403 → long per-service cooldown, still time-bounded.

Nothing is ever permanently dead. When all keys are cooling, the thrown error
names the earliest recovery time, so `IngestionSourceRun.error` stops being a
dead end. Injectable `now` for tests; the module has no test file today.

## Phase 2 — The two ATS platforms (highest volume upside)

**Workable — 45,233 × `HTTP 429` against 190 successful reads.** We hammer their
API with no backoff. Needs per-platform request throttling and honouring
`Retry-After`, so the crawl slows instead of being refused.

**BambooHR — 36,729 × `Unexpected token '<', "<!DOCTYPE "`.** Their endpoint is
serving an HTML page (block, redirect, or login wall) and we parse it as JSON.
Two fixes: check content-type before parsing so a block page reports as blocked
rather than a syntax error, and find why BambooHR serves HTML at all.

Both are major ATS platforms. Unblocking them plausibly adds more volume than
every paid API combined.

## Phase 3 — The two dead paid endpoints (now fully specified)

Resolved empirically by probing with a subscribed key. RapidAPI answers
`404 Endpoint 'X' does not exist` for a missing route, so this is settled, not
inferred:

```
linkedin-job-search-api:  /active-jb-24h 404 · /active-jb 200 ← live jobs
jsearch:                  /search 404 · /job-search 404 · /search-v2 503 ← exists
```

Three edits:

1. LinkedIn `/active-job` → **`/active-jb`** (v1 was retired 3 Aug).
2. LinkedIn `time_frame` `past_24_hours` → **`24h`**, and parse a **bare array** —
   v4 returns `[...]`, our code reads `data.data`, so `jobs` becomes `[]` and the
   loop breaks immediately. This is why LinkedIn has **never** recorded a
   success, independent of the sunset.
3. JSearch `/search` → **`/search-v2`**.

JSearch's backend returns 503 on every endpoint right now, confirmed in
RapidAPI's own console. That is their outage; the path fix stands regardless.

Indeed is genuine monthly quota — no code fix, only Phase 1 making it graceful.

## Phase 4 — Keys ship with the push

Keys cannot be committed; the repo is public. They travel as a **GitHub Actions
secret** injected at deploy:

1. One-time: create `RAPIDAPI_KEYS` holding the union of the Mac's 11 and the
   Pi's 2.
2. `deploy.yml` passes it to `deploy.sh`.
3. `deploy.sh` rewrites the `RAPIDAPI_KEYS=` line in the staged `.env` before the
   service restarts — piped over **stdin**, never argv, so the value never
   appears in the Pi's process list.

Afterwards, rotating keys is: update the secret, push.

## Phase 5 — Health that can tell idle from healthy

The status function returns `success` before ever asking whether work happened:

```ts
if (counts.errors === 0) return 'success';
```

So **Arbeitnow has reported 232 consecutive successes while doing literally
nothing**, and Remotive/TheMuse look healthy while returning 0 new jobs from
6,617 seen. This is the same blind spot that hid the 11-day paid-API outage, one
layer down: the health signal itself is wrong.

- Add an `idle` verdict for zero work with zero errors.
- Surface per-source health (last success, last *productive* run, consecutive
  failures, last error) on the Log or Stats tab.

Without this, any dashboard built in Phase 4 would still show Arbeitnow green.

## Phase 6 — Stats that reconcile

"Killed (Local) 2,302" against "Jobs Ingested 542" on the same row is not a
rendering glitch — the two columns are measured on different denominators, and
several others are measured on the wrong axis entirely.

**1. Ingested and Killed (Local) cannot be compared.**
`ingested = SUM(insertedCount)` counts only *new* rows written.
`killedLocal = SUM(filteredCount)` counts jobs filtered out of everything
*seen* — 523,681 for Greenhouse alone in a week. A row only reconciles as
`seen = inserted + duplicates + filtered + errors`, and `seen` is never shown.

**2. "Killed (Local)" is not local scoring.** `filteredCount` is ingestion-time
title/location filtering. Local heuristic rejection is `scoringStatus =
'skipped'` (198,127 rows). Two unrelated quantities under one label.

**3. The A/E columns are bucketed by `Job.createdAt`.** So "Killed (A/E)" on
8 Aug means *jobs ingested that day which are dismissed right now* — a job
ingested on the 1st and killed on the 8th lands on the 1st. Worse, because the
query reads current status, **every historical row silently rewrites itself** as
jobs move. Yesterday's numbers are not stable.

**4. "Passed (A/E)" contains "Made it to Inbox".** `passedAE` includes
`status = 'inbox'`, so the 6 in the screenshot are inside the 8 — they read as
independent columns. It also counts `archived`, which is not a pass.

**5. "Killed (A/E)" catches local kills.** It counts any dismissed job with a
non-null `aimFitScore`, and the local-scoring dead path also sets
`status = 'dismissed'` after three failed JD fetches.

**6. "Last 30 Days" is not 30 days.** Both raw queries are `LIMIT 30` over
grouped dates with no date filter, so it is "the 30 most recent dates that have
rows" — which spans further back whenever there are gaps.

Also: `getStartOfDayChicago()` is called at line 21 and its result discarded; the
helper is entirely unused.

**Fix**: derive each column from an event with its own timestamp rather than
inferring history from current status. Show `seen` so a row adds up, make the
funnel stages disjoint, label local filtering and local scoring separately, and
bound the window by date rather than row count.

**Decision — forward-only is accepted.** `JobScoreEvent` has real history
(39,125 rows, 2,193 this week), so the scoring columns can be rebuilt truthfully
for past days. `JobStatusHistory` holds only 47 rows, so inbox/passed cannot be
reconstructed. Agreed approach: start recording transitions properly and let
those columns be correct **from the changeover onwards**, rather than
back-filling guesses. Days before the change will read zero for those columns and
should be labelled as such, not left to look like a quiet week.

---

## Deliberately deferred

- **M1** — 31k blacklisted ATS boards, 27k overdue, one-sixth processed per pass.
- **M2** — 497 rows failed with "Jina could not parse JD".
- **Unused subscriptions** — Active Jobs DB, Workday Jobs API (4k+ Workday sites,
  100 jobs/call), and Jobs API are paid for and never called. The Workday one
  overlaps directly with the 13k-board sweep and may be a better answer to M1
  than tuning the crawler.

## Out of scope

No key table in the database, no key-management UI, no persisted cooldown state.
In-memory TTL is correct for one long-running process.

---

## What to expect

- **The push restarts the Pi service**, ending the in-flight board sweep. Safe —
  progress is per-board and it resumes.
- **More keys is not more quota.** At least one of the eleven is already
  monthly-spent. Phase 1 makes exhaustion graceful, not absent.
- **JSearch may stay down** regardless of our fix.

## Verification

1. Pi key count reads 13.
2. `/active-jb` returns jobs through our code path, and LinkedIn records its
   first-ever `success` row with a non-zero insert count.
3. Workable's error count drops by orders of magnitude; BambooHR reports a clear
   blocked state rather than a JSON syntax error.
4. Arbeitnow shows as `idle`, not `success`.
