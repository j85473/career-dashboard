# Fetch Rippling job bodies at ingestion instead of paying for JD recovery

## Why

Rippling postings arrive with **no description at all** (`descLen=0`), so every
one of them goes to JD recovery and spends a Jina call — on jobs the pipeline
already has authoritative metadata for. That is the bulk of what filled Action
Needed.

`src/lib/jobIngestion.ts` already does exactly this fetch for other platforms:
workday (~line 4129), smartrecruiters (~4177), workable (~4210), bamboohr
(~4249). Rippling has a list call (~line 3983) and **no detail call**.

The list endpoint cannot help — verified, it returns only:

```
uuid, name, department, url, workLocation
```

## The endpoint (verified 2026-08-19)

```
GET https://ats.rippling.com/api/v1/board/{slug}/jobs/{uuid}
```

Real response for `ampersandbrands/0a25a6aa-900e-4dc0-bb93-64ad26c7b44c`:

| field | value |
| --- | --- |
| `description` | **object**, not a string: `{ company: <html>, role: <html> }` — 445 and 1,892 chars of text respectively |
| `companyName` | `"Lolli & Pops - Hammond's Candies"` |
| `payRangeDetails` | `[{location, currency: "USD", frequency: "YEAR", rangeStart: 70000.0, rangeEnd: 75000.0, isRemote: false}]` |
| `workLocations` | `["Denver, CO"]` (array; the list call gives a single `workLocation` object) |
| `employmentType` | `{label: "SALARIED_FT", id: "Salaried, full-time"}` |

`uuid` is already captured at ingestion — `jobIngestion.ts` line ~4293 sets
`sourceId = String(job.uuid)` for rippling — so no new identifier is needed.

## Requirements

1. **Fetch the detail body for rippling**, following the shape of the existing
   smartrecruiters/workable/bamboohr blocks: only when `!rawDescription`, and
   respecting whatever request budgeting and error handling those use. Do not
   invent a new fetch helper.
2. **`description` is an object.** Concatenate `company` and `role` in that
   order and run the result through the existing `cleanHtmlText`. Do not
   `String(description)` — that yields `[object Object]`, which would sail past
   the 650-character gate as garbage.
3. **Use `companyName` when present.** Rippling currently derives the company
   from the board slug, so `ampersandbrands` displays instead of
   `Lolli & Pops - Hammond's Candies`. Same defect class as Workday storing
   `graco.wd501`. Fall back to the existing slug derivation when absent.
4. **Feed `payRangeDetails` into the existing posted-facts path.** There is
   already a deterministic `postedCompensation` extractor (`derivePostingFacts`)
   — this is structured data that should not have to be regexed out of prose.
   Only use it when currency/frequency are unambiguous; the existing rule that
   a range which cannot credibly be annual is dropped still applies.
5. **Prefer `workLocations` (array) over the list call's single
   `workLocation`.** Join multiple values with `; ` so `splitLocationOptions`
   sees them as separate options — that is what lets a multi-city posting keep
   its Minneapolis option.
6. Do the geography gate work in `docs/prompts/ingest-geography-gate.md`
   **first** if it is not already done. Rejecting an out-of-scope posting for
   free must happen before spending any call, including this cheap one.

## Also worth checking

`breezy`, `teamtailor`, `pinpoint` and `recruitee` also have list calls and no
detail fetch, and Breezy rows are known to store `0ch` descriptions. Do not fix
them in this pass — but report whether their list responses carry a description,
so the same gap can be sized.

## Constraints

- `jobIngestion.ts` is read by source-text contract tests:
  `grep -rln "jobIngestion.ts" src/lib/__tests__ tests/`
- Add a parser test with the real response shape above, especially the
  `{company, role}` object — that is the part most likely to be got wrong.
- Gates: `npm test` (baseline **609 pass, 0 fail**) and `npm run build`.
- `git commit -am` does not stage new files. Use `git add -A`.
- **Do not `git push`** and do not run any `--apply`.

## Definition of done

- Rippling postings arrive with a real description, the real company name, and
  structured pay when present.
- Test covering the `{company, role}` description object.
- A note on whether breezy/teamtailor/pinpoint/recruitee have the same gap.
- `npm test` ≥609 green, `npm run build` green, commit local and unpushed.
