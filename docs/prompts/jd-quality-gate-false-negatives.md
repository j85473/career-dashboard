# The JD quality gate is discarding real postings

## What happened

Commit `71e3559` (2026-08-09) added `hasUsableDuties` and
`hasUsableQualifications` to `assessJobDescriptionQuality` in
`src/lib/jobDescriptionQuality.ts`, alongside `MIN_SCORABLE_JD_CHARACTERS = 650`.
A description now has to match a **keyword list** to be considered scorable.

JD recovery success across all sources, rows that actually reached recovery
(`scoringStatus <> 'skipped'`):

```
week        attempted  recovered
Jun 21            745    722 (97%)
Jul 26          1,521  1,400 (92%)
Aug 02            738    604 (82%)
Aug 09          6,579  5,080 (77%)      <- 71e3559 lands
Aug 16          1,252    314 (25%)
```

Failure reasons in the same window — "no usable role duties" appears from
nothing, while Jina failures *fall*:

```
Aug 02:   105  Jina could not extract sufficient markdown
Aug 09: 4,372  JD recovery rejected: no usable role duties
           497  fewer than 650 usable characters
           369  no usable qualifications
            22  Jina could not extract sufficient markdown
```

## The gate is right some of the time and wrong a lot of the time

Sampled rows rejected for "no usable role duties" that **cleared 650 chars**, so
the fetch succeeded and only the keyword list failed them:

**Wrongly rejected — real postings:**
- Sysmex America, "Consultant, Hemostasis Optimization (WI, MN, ND, SD)",
  6,415 chars, CareerForce. A real medical-sales role in Joseph's territory.
- Mackinnon Bruce, "Key Account Manager", 1,040 chars — rejected for
  *no usable qualifications*.
- PlanetScale, "Developer Educator", 3,677 chars.

Common shape: the posting opens with company boilerplate, or states duties in
prose that does not hit the vocabulary.

**Correctly rejected:**
- Warmup PLC, "Your Next Role", 698 chars — a talent-pool page, not a job.
- IBAC, "Title TBD", 5,865 chars — RemoteOK navigation chrome
  ("Join Remote OK / Log in / Frontpage / Dark mode"). Note this is the same
  page-furniture defect already fixed for Adzuna, now appearing in RemoteOK.

Population today:

| | |
| --- | --- |
| rejected for no usable duties/qualifications | 5,417 |
| of those, cleared 650 chars | 3,859 |
| of those, **2,000+ chars** | **2,651** |
| still live | 724 |

## The actual defect

The gate conflates two different things:

1. **"We failed to fetch a description"** — a shell, a login wall, navigation
   chrome. Correctly a recovery failure.
2. **"This description does not use our vocabulary"** — a real posting the
   keyword list does not recognise. Not a recovery failure at all.

Both currently produce `scorable: false`, which routes the row to
failed/needs_jd and takes it out of the pipeline.

## What to change

Do **not** simply widen the regexes. They have already been widened once
(`5960fd8`, Aug 16) and 660 rows were still rejected the following week; a
keyword list will never enumerate how humans write job postings.

Separate the two judgements:

- Keep rejecting on the things that mean *no content was retrieved*: portal
  shells, login/cookie walls, terminal 404/closed signals, and text under the
  650-char minimum. Those are evidence-based.
- For a description that is **substantial** (suggest ≥1,500 chars) and shows no
  shell signal, a missing duties/qualifications keyword must **not** be a
  rejection. Treat it as scorable, or at most route it to human review — but do
  not fail it back into JD recovery, which will re-fetch the same page and reach
  the same verdict forever.
- Keep the keyword signals available as *metadata* (e.g. return them on the
  quality result) so callers can prioritise, without letting them gate.

Preserve `options.structuredSource` behaviour, which already bypasses these
checks for ATS sources.

## Backfill

After the gate is fixed, the ~3,859 rows rejected only by the keyword list
should be re-evaluated **from their stored descriptions** — they were fetched
successfully, so this needs no network calls. Write a dry-run-by-default script
in `scripts/` following `scripts/dismiss_applied_duplicates.ts`:

- Re-run `assessJobDescriptionQuality` over the stored `description`.
- Rows that now pass: clear `scoreError`, set `scoringStatus` back to the queued
  state so local scoring re-judges them.
- **Do not clear `aimFitScore` / `reqFitScore`** — that puts rows into a manual
  batch that costs Joseph real time. Report how many are affected instead.
- Report how many change verdict, and how many remain rejected and why.

## Constraints

- `jobDescriptionQuality.ts` is imported by `jdRecoveryPolicy`,
  `authoritativeMetadataGate`, `jobScoring` and `jobIngestion`. Check the
  source-text contract tests first:
  `grep -rln "jobDescriptionQuality\|jobScoring.ts\|jobIngestion.ts" src/lib/__tests__ tests/`
- Existing tests encode the current behaviour. Where you change a verdict,
  update the test *and* say in the commit why the old expectation was wrong.
- Gates: `npm test` (baseline **605 pass, 0 fail**), `npm run build`.
- `git commit -am` does not stage new files. Use `git add -A`.
- **Do not `git push`** and do not run any `--apply`.
- Prod is a Raspberry Pi sharing this database; writes are live immediately.

## Definition of done

- A substantial, non-shell description is no longer rejected for vocabulary.
- Shell/login/404/too-short rejections still work, with tests.
- Backfill script written, dry run reviewed by Joseph.
- `npm test` ≥605 green, `npm run build` green, commit local and unpushed.
