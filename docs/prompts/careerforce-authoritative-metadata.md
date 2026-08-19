# CareerForce states its own location — treat it as authoritative

## Evidence

After the retroactive triage cleared 736 rows, Action Needed refilled and is
dominated by CareerForce:

```
232  careerforce          14  ATS-lever
 27  ATS-workday          10  ATS-smartrecruiters
 26  Indeed                9  Glassdoor (RapidAPI)
 19  Himalayas             7  ATS-rippling
 15  RemoteOK              7  ATS-breezy
```

`hasAuthoritativeMetadata('careerforce')` is **false** — the source string
matches neither `GLASSDOOR_SOURCE` nor `/^ATS-[a-z0-9_-]+$/` — so CareerForce
takes the aggregator path: JD recovery first, geography gate never.

Running `evaluateAuthoritativeMetadata` over those 232 rows as if it were
authoritative:

```
would be dismissed on metadata alone:  44
would still need JD recovery:         188
rows with an empty location:            0
```

Every dismissal is correct, and they are all **outstate Minnesota**, which the
geography policy deliberately excludes:

```
12  Rochester, MN        2  Owatonna, MN       1  Marshall, MN
 7  Mankato, MN          2  Hibbing, MN        1  Willmar, MN
 7  Duluth, MN           1  Moorhead, MN       4  Software Engineering role
 5  Saint Cloud, MN
```

And the rows it would keep are correct too — Minneapolis, Saint Paul, Woodbury,
Eagan, Brooklyn Park, Shakopee, Maple Plain.

## Why this is safe

The reason aggregators are excluded from the authoritative set is that their
location is a guess until the description resolves — rejecting early would
discard good roles on bad data. That does not apply here. CareerForce is
Minnesota's state job board and `src/scripts/careerForceScraper.ts` reads the
company and location directly off the search card, not from an inferred field.
**Zero of the 232 rows have an empty location**, so the permissiveness the
aggregator path protects is not being used.

## The change

Add CareerForce to `hasAuthoritativeMetadata` in
`src/lib/authoritativeMetadataGate.ts`, alongside `GLASSDOOR_SOURCE` and
`isStructuredAtsSource`.

1. Match the source **case-insensitively** — the scraper writes `'careerforce'`
   (lowercase) via `ingestExternalJob`, unlike the `ATS-*` sources. Define it as
   a named constant next to `GLASSDOOR_SOURCE` rather than inlining a string.
2. Extend the docblock with the reasoning above: it is authoritative because the
   state board publishes the location on the card, and the empty-location count
   is zero. Someone will eventually want to add another source here, and the bar
   should be visible.
3. Do **not** widen it to Indeed, Himalayas, RemoteOK or Dejobs in this pass.
   Those are genuine aggregators and their locations are inferred. If they
   should move later, they need the same evidence gathered first.
4. Add a test asserting `careerforce` is authoritative and that
   Adzuna/Himalayas/TheMuse/Indeed/RemoteOK remain not.

Because all three callers share this function, the change automatically applies
in `jobScoring`, in `batch-jd-submit/route.ts`, and in the retroactive triage
script.

## Afterwards

Run `npm run ats:triage-stuck` (dry run) and report the new count — it should
now include the CareerForce rows. Joseph runs `--apply`.

## What this does NOT fix

188 of the 232 are Twin Cities roles that genuinely need JD recovery, and they
fail because CareerForce apply links resolve to `de.jobsyn.org`, which is now a
client-rendered SPA serving zero text. That is
`docs/prompts/dejobs-spa-recovery.md` and it is the larger remaining problem.

## Constraints

- Gates: `npm test` (baseline **623 pass, 0 fail**) and `npm run build`.
- `git commit -am` does not stage new files. Use `git add -A`.
- **Do not `git push`** and do not run any `--apply`.

## Definition of done

- `hasAuthoritativeMetadata('careerforce')` is true, case-insensitively.
- Test covering both the inclusion and the still-excluded aggregators.
- Docblock states the bar for adding a source.
- Dry-run triage count reported.
- `npm test` ≥623 green, `npm run build` green, commit local and unpushed.
