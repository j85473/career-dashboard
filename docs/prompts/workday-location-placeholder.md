# Recover the real city from Workday's placeholder locations

## Goal

`Job.location` stores Workday's `"2 Locations"` / `"5 Locations"` placeholder for
**7,695 rows**. Parse the real city out of the Workday URL instead, fix it going
forward, and backfill what is safe to backfill.

## Why this matters more than it looks

Two consequences, the second one expensive:

1. `identityFingerprint` is `company|title|location`, so several different cities
   collapse into one fingerprint and look like duplicates. The GFS "Outside Sales
   Representative" group is Youngstown OH, White House TN, Beaumont TX, Mount Airy
   MD and Miami FL sharing a single fingerprint.
2. `localTriageVerdict` judges geography from this field and **deliberately passes
   when the location is absent or unreadable** — missing metadata is not evidence of
   a bad location. So an out-of-state role reads as locationless, clears the
   Minnesota gate, and goes on to consume scoring. 64 of these rows already carry a
   manual Aim score, which is Joseph's own time.

It also blocks `appliedDuplicatePolicy.isUnreliableLocation`, which currently has to
refuse to suppress any row whose location matches `^\d+\s+locations?$`.

## Measured facts (2026-08-19, do not re-derive)

| | |
| --- | --- |
| rows with `location ~* '^[0-9]+ locations?$'` | 7,695 |
| still live (not archived/dismissed/expired) | 212 |
| already manually Aim-scored | 64 |
| have a `/job/<segment>/` city segment in the URL | **7,695 of 7,695** |
| `location = 'Unknown Location'` (separate issue, out of scope) | 5,096 |

All 7,695 are `ATS-workday`. Distribution: 4,071 "2 Locations", 1,199 "3 Locations",
711 "4 Locations", 450 "5 Locations", down a long tail to "51 Locations".

## The defect

`src/lib/jobIngestion.ts`, in the per-platform parsing block (~line 4332):

```ts
} else if (board.platform === "workday") {
  company = board.slug.split("::")[0];
  locationStr = job.locationsText || "Unknown Location";
}
```

`job.locationsText` is Workday's display string. For a single-location requisition
it is a real place; for a multi-location one it is the count.

## Real URL segments — the parser must handle all of these

```
/job/Dallas-TX/NERC-P-C-Engineer_JR617                     -> Dallas, TX
/job/Chicago-IL/Manager--Transmission-Market-A             -> Chicago, IL
/job/Plainville/Global-Manager--Project                    -> Plainville        (no state)
/job/Virtual---California/Key-Account-M                    -> Virtual, California  (remote-in-state)
/job/Phoenix-Office/Development-Engineering-Ma             -> Phoenix           (office label)
/job/Champaign---Hazelwood/Sr-New-Produ                    -> two cities in one segment
/job/111-East-210th-Street/Emergency-Medicine_JR226338     -> a street address, NOT a city
```

## Requirements

1. **Only touch the placeholder case.** If `locationsText` is a real location, keep
   it. Detect the placeholder with `^\d+\s+locations?$` (case-insensitive) — share
   the check with `isUnreliableLocation` in `src/lib/appliedDuplicatePolicy.ts`
   rather than writing a second copy.
2. **Fail closed.** If the segment cannot be read as a place (street address, empty,
   pure digits), leave the existing behaviour rather than inventing a location. A
   wrong city is worse than a known-unknown, because `localTriageVerdict` trusts
   what it is given. Prefer returning `null` and letting the caller keep
   `"Unknown Location"`.
3. **Pure function, unit-tested.** Put the parser in its own module (suggested:
   `src/lib/workdayLocation.ts`) so it can be tested without Prisma or the network.
   Every row in the table above should be a test case, plus the fail-closed cases.
4. **A multi-city segment is not one place.** `Champaign---Hazelwood` should either
   fail closed or return a form that does not claim a single city. Decide, and write
   the reason in a comment.
5. **Backfill script**, dry-run by default with `--apply`, in `scripts/`, following
   the pattern of `scripts/dismiss_applied_duplicates.ts`:
   - Select in Postgres, never `LIKE` + a JS filter — the database is on a Pi across
     Tailscale and shipping row bodies looks hung.
   - Print counts before writing, and print what it will skip.
   - Recomputing `location` changes `identityFingerprint`; recompute and store it
     too, using the existing `generateV4Fingerprint(title, company, location)` from
     `src/lib/jobIngestion.ts`. Do not invent a second fingerprint function.
   - **Do not clear `aimFitScore` / `reqFitScore`.** The export queue selects on
     `aimFitScore: null`, so clearing them puts rows back into a manual batch that
     costs Joseph real time. Report how many backfilled rows are already scored and
     let him decide separately.
   - Consider whether backfilling archived/dismissed rows is worth it at all — 7,483
     of the 7,695 are not live.

## Constraints you must respect

- **`jobIngestion.ts` is read by source-text contract tests.** Before editing it:
  `grep -rln "jobIngestion.ts" src/lib/__tests__ tests/`. Tests match literal source
  strings, so a rename can fail CI even when behaviour is identical. This has blocked
  a Pi deploy before.
- **`npm test` is a deploy gate but is not sufficient.** Also run `npm run build` —
  the Next build type-checks more strictly than `tsc --noEmit` (it rejected a regex
  `s` flag against `"target": "ES2017"` that local `tsc` accepted).
- Baseline before your change: **589 pass, 0 fail**.
- `git commit -am` will not stage new files. Use `git add -A` or name them.
- Prod is a Raspberry Pi that **shares this database**. A migration or data write
  applied locally is already live. There is no separate staging copy.

## Definition of done

- Parser module with tests covering every sample above, including fail-closed cases.
- `jobIngestion.ts` uses it for the Workday placeholder case only.
- Backfill script, dry run reviewed by Joseph before `--apply`.
- `npm test` green (≥589), `npm run build` green.
- Report: how many of the 7,695 parsed cleanly, how many failed closed and why.
