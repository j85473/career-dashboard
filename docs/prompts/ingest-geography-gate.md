# The lane-one gate is missing from the JD recovery route

## The bug, traced end to end

Joseph's Action Needed queue is full of French-Canadian postings from
`Dialogue Fr` (source `ATS-rippling`), each reading
`JD recovery rejected: no usable role duties.`

Running every gate against those real rows shows the filters are **correct**:

```
Physiothérapeute, Cliniques en entreprise
  source=ATS-rippling  status=pending_af/failed  location="Montréal, Canada"
  hasAuthoritativeMetadata(ATS-rippling)  = true
  acceptableLocationOption("Montréal, Canada") = false
  localTriageVerdict            -> pass=false  Location outside the searched geographies
  evaluateAuthoritativeMetadata -> pass=false  Locally triaged out: Location outside …
```

The gate produces exactly the right verdict. It never ran.

`src/lib/jobScoring.ts` (~line 767) applies `evaluateAuthoritativeMetadata`
before `resolveFullDescription`, correctly. But these rows were recovered by a
**different path**: `src/app/api/jobs/batch-jd-submit/route.ts`. That route runs
the language check, then a metadata gate restricted to one source:

```ts
// Glassdoor search already gives us reliable title/company/location metadata.
if (job.source === GLASSDOOR_SOURCE) {
  const metadataFilter = passesPreFilter({ title, company, description: '', location, url });
  ...
}
```

`ATS-rippling` is not Glassdoor, so the row goes straight to recovery, spends a
Jina call on a Montréal posting, fails, and is stamped `JD recovery rejected`.

`authoritativeMetadataGate.ts`'s docblock says the definition lives in one place
"because two callers must agree exactly: `jobScoring` … and
`scripts/triage_stuck_ats_jobs.ts`". It names two callers. This route is the
third, and it was never included.

## The change

In `src/app/api/jobs/batch-jd-submit/route.ts`, replace the Glassdoor-only block
with the shared gate:

```ts
if (hasAuthoritativeMetadata(job.source)) {
  const verdict = evaluateAuthoritativeMetadata({ title, company, location, url });
  if (!verdict.passes) { /* dismiss, same shape as today */ }
}
```

This **subsumes** the Glassdoor case — `hasAuthoritativeMetadata` already
returns true for `GLASSDOOR_SOURCE` — and extends it to every `ATS-*` source,
which is exactly what the gate was written for.

Requirements:

1. Keep the existing dismissal shape (`scoringStatus: 'skipped'`,
   `status: 'dismissed'`, `passReason: verdict.reason`) so a row rejected here
   is indistinguishable from one rejected by local scoring. The reason strings
   must match, since they are user-visible in the Log tab.
2. **Aggregators must keep the post-recovery path.** `hasAuthoritativeMetadata`
   already excludes Adzuna/Himalayas/TheMuse — do not widen it. Their location
   is a guess until the description resolves.
3. Add a test asserting an out-of-scope authoritative posting is dismissed by
   this route **without** a recovery fetch being attempted. That "without
   fetching" assertion is the point — the cost being avoided is a paid call.
4. Update the docblock in `authoritativeMetadataGate.ts` to name all three
   callers, so the next person adding a recovery path sees the contract.

## Cleaning up the existing queue

`scripts/triage_stuck_ats_jobs.ts` already applies this gate retroactively.
After the fix, run it (dry run first) to clear the rows already stuck in Action
Needed. Report how many it dismisses. Do NOT run it with `--apply` yourself —
Joseph runs writes.

## Constraints

- Gates: `npm test` (baseline **609 pass, 0 fail**) and `npm run build`.
- `git commit -am` does not stage new files. Use `git add -A`.
- **Do not `git push`** and do not run any `--apply`.
- Prod is a Raspberry Pi sharing this database; writes are live immediately.

## Definition of done

- The recovery route applies the shared gate for every authoritative source.
- Test proving no fetch is attempted for an out-of-scope authoritative posting.
- Docblock lists all three callers.
- Dry run of the retroactive triage script, with counts reported.
- `npm test` ≥609 green, `npm run build` green, commit local and unpushed.
