# Read schema.org JobPosting JSON-LD before falling back to Jina

## Why

Breezy postings arrive with **0-character descriptions** — its list endpoint
carries no body — so every one depends on JD recovery. Same for the other
platforms with no detail fetch.

Breezy has no JSON detail route (verified: `/json/{id}` 302s, `/p/{id}.json`
returns HTML). But its posting page embeds a **schema.org `JobPosting` JSON-LD
block**, which is a web standard rather than a Breezy feature.

Verified live on `seeknow.breezy.hr/p/46cc4db5ad98-contractor-development-lead`:

```
<script type="application/ld+json">  @type: JobPosting

description         3,726 chars of prose
hiringOrganization  { name: "Seek Now" }        <- real name, not the slug "Seeknow"
jobLocation         { address: { addressLocality: "Louisville",
                                 addressRegion: "KY", addressCountry: "US" } }
employmentType      "FULL_TIME"
datePosted          "2026-07-23"
```

The list endpoint (`https://{slug}.breezy.hr/json`) gives
`id, friendly_id, name, url, published_date, type, location, department,
salary, company, locations` — enough to build the detail URL, and it carries
`salary` too.

## The change — generic, not Breezy-specific

Add a JSON-LD `JobPosting` extractor to `src/lib/atsApi.ts` and try it inside
`scrapeAtsApi` **before** any Jina fallback. All three callers (ingestion, local
scoring, JD recovery) already route through that function, so every source
benefits — this is the same shared-function pattern as the dejobs and
CareerForce fixes.

Requirements:

1. **Parse defensively.** A page may contain several `ld+json` blocks; the value
   may be a single object, an array, or use `@graph`. Select the entry whose
   `@type` is `JobPosting` (which can itself be a string or an array). Ignore
   blocks that fail to parse rather than throwing.
2. **`description` is HTML inside JSON** — run it through the existing
   `cleanHtmlText`, not a bare tag strip.
3. **Validate before returning.** Run the full `assessJobDescriptionQuality`
   gate on the result. This is the rule that caught the isolved portal shell:
   never accept an extraction because a field existed or a length looked right.
4. **Use the structured fields to correct stored values**, as the Rippling and
   dejobs fixes do: `hiringOrganization.name` for company (Breezy currently
   derives it from the slug — `Seeknow` instead of `Seek Now`), and
   `jobLocation.address` for `addressLocality, addressRegion` — join as
   `"Louisville, KY"` so `splitLocationOptions` and the geography gate read it
   correctly. Only overwrite when the stored value is missing or clearly worse;
   never overwrite a good location with a country-only value.
5. **Breezy wiring**: add the detail fetch in `jobIngestion.ts` following the
   smartrecruiters/workable/bamboohr pattern (only when `!rawDescription`),
   building the URL from the list item's `url` or `friendly_id`. Also carry the
   list's `salary` field into the posted-facts path if it is unambiguous, using
   the same rules as the Rippling `payRangeDetails` work.

## Report before assuming reach

Before wiring extra platforms, measure it: for the rows currently in Action
Needed, how many of their URLs serve a parseable `JobPosting` JSON-LD block? A
short read-only script over a sample is enough. That number decides whether this
is a Breezy fix or a general replacement for a chunk of Jina traffic — say which
it turned out to be rather than claiming the broad win.

Also report whether teamtailor, pinpoint, personio and recruitee pages carry the
same block.

## Constraints

- `atsApi.ts` and `jobIngestion.ts` are read by source-text contract tests:
  `grep -rln "atsApi\|jobIngestion.ts" src/lib/__tests__ tests/`
- Add a parser test using the real block shape above, including the
  array/`@graph` variants and a page with no JobPosting block.
- Gates: `npm test` (baseline **634 pass, 0 fail**) and `npm run build`.
- `git commit -am` does not stage new files. Use `git add -A`.
- **Do not `git push`** and do not run any `--apply`.

## Definition of done

- Generic JSON-LD JobPosting extractor in `scrapeAtsApi`, quality-gated.
- Breezy detail fetch wired at ingestion; company and location corrected.
- Measured answer on how widely the JSON-LD block is available.
- `npm test` ≥634 green, `npm run build` green, commit local and unpushed.
