# Fix the Workday location backfill before it withholds real jobs

Follow-up to `docs/prompts/workday-location-placeholder.md`. The parser
(`src/lib/workdayLocation.ts`) is good and its tests pass. **The problem is what
we do with the result.** Do not run `scripts/backfill_workday_locations.ts
--apply` until this is fixed.

## What the dry run showed

171 of 212 live rows parsed, 41 failed closed. But the writes include:

```
5 Locations   -> Ohio USA
5 Locations   -> California USA
3 Locations   -> South Africa
3 Locations   -> Pennsylvania        (title says "… - Baltimore")
2 Locations   -> All Kentucky United States of America
5 Locations   -> United States of America Washington Seattle
```

## Why that is worse than the placeholder

Two verified facts:

1. `src/lib/jobLocationPolicy.ts:81` — `isUnknownOrBroadUSOption` matches
   `\d+ locations?` explicitly. `"5 Locations"` is *already* accepted as
   unknown/broad US, so these rows pass the geography gate today. This was
   deliberate.
2. `src/lib/localTriage.ts` — `acceptableLocationOption` / the surrounding
   comment: a posting is withheld "only when **every** option is out of scope",
   because multi-site listings like "Austin, TX; Eau Claire, WI; Minneapolis, MN"
   are common and rejecting on one out-of-scope option discards Twin Cities roles.

The URL segment is only the **primary** location of N. So writing it as *the*
location turns a permissive unknown into a confident, possibly-wrong single
claim. A requisition open in five cities including Minneapolis, whose primary
segment is Ohio, becomes `"Ohio USA"` and is then withheld. That is a silent
false negative on exactly the roles Joseph wants — the failure mode
`acceptableLocationOption` was written to prevent.

The earlier prompt framed these rows as leaking *past* the gate. That was wrong.
They pass it correctly, and the backfill would break that.

## The fix

Write both facts into the field, using the option separator the codebase already
understands.

`splitLocationOptions` (jobLocationPolicy.ts:10) splits on `/\s+(?:or)\s+|[;/|]/`.
So store:

```
Youngstown, Ohio; 2 Locations
```

- Option 1 (`Youngstown, Ohio`) makes `identityFingerprint` distinct per city,
  which fixes the GFS "Outside Sales Representative" false-duplicate group.
- Option 2 (`2 Locations`) still matches `\d+ locations?`, so
  `isUnknownOrBroadUSOption` accepts it and the gate stays permissive. Nothing
  gets withheld that passes today.

Keep the original placeholder text verbatim as option 2 — do not reformat it, or
the regex stops matching.

## Requirements

1. Put the composition in `src/lib/workdayLocation.ts` as its own exported
   function (e.g. `composeMultiSiteLocation(primary, placeholder)`), unit-tested.
   Both `jobIngestion.ts` and the backfill script must use it — do not build the
   string in two places.
2. **Add a test asserting the composed value still passes the gate.** Import
   `acceptableLocationOption` (or `splitLocationOptions` +
   `isUnknownOrBroadUSOption`) and assert that
   `"Youngstown, Ohio; 2 Locations"` yields an acceptable option. That test is
   the whole point of this change; without it the regression is invisible.
3. Normalize the primary before composing. Current outputs are inconsistent:
   `"Grand Rapids MI United States"`, `"United States of America Washington
   Seattle"`, `"All Kentucky United States of America"`. Prefer `City, ST` or
   `City, State`; if the segment cannot be reduced to something that shape, fail
   closed rather than emitting a word blob.
4. `isUnreliableLocation` in `src/lib/appliedDuplicatePolicy.ts` must treat a
   composed multi-site value as **still unreliable** for suppression purposes —
   the row names one of N places, so it cannot prove two postings are the same
   job. Test that `"Youngstown, Ohio; 2 Locations"` does not suppress.
5. Re-run the backfill dry run and report the new distribution: parsed, failed
   closed, and how many primaries normalized to a clean `City, ST`.

## Constraints

- `jobIngestion.ts` is read by source-text contract tests:
  `grep -rln "jobIngestion.ts" src/lib/__tests__ tests/`.
- Gates: `npm test` (baseline **596 pass, 0 fail**) **and** `npm run build` —
  the build type-checks more strictly than `tsc --noEmit`.
- `git commit -am` does not stage new files. Use `git add -A`.
- Prod is a Raspberry Pi sharing this database. Writes are live immediately.
- Do not clear `aimFitScore` / `reqFitScore`; that puts rows back into a manual
  batch that costs Joseph real time. 11 of the 171 are already scored.

## Definition of done

- Composition function + tests, including the gate-still-passes assertion.
- `jobIngestion.ts` and the backfill script both use it.
- Backfill dry run re-run, output reviewed by Joseph before `--apply`.
- `npm test` ≥596 green, `npm run build` green.

## Running commands while Joseph is away

Run the verification loop yourself — `npm test`, `npm run build`, `tsc --noEmit`,
the git read commands, and the **dry run** of
`scripts/backfill_workday_locations.ts` (no flags). Iterate until both gates are
green, then commit with `git add -A` (not `-am`; it will not stage new files).

**Do not run, under any circumstances, without Joseph present:**

- `--apply` on any script. Prod is a Raspberry Pi sharing this database, so every
  write is live immediately and there is no staging copy.
- `git push`. Pushing triggers the Pi deployment.
- `prisma migrate` / `prisma db push` / `scripts/deploy.sh` / any `ssh`.

Leave the commit unpushed and report what you found. If the dry-run output looks
wrong, stop and write down why rather than working around it — the last round of
this task produced a parser that passed every unit test and would still have
withheld real Minneapolis jobs.
