# ATS validation failure audit — October 15, 2026

Working public feeds were being held as validation failures because several adapters assumed a narrower response shape than providers actually publish. The repair accepts those supported shapes while retaining board identity, employer evidence, publication state, posting identity, geography and first-collection limits.

## Scope and evidence

The live retry queue was grouped by provider and recorded failure reason. Deterministic samples selected up to three candidates per group, plus Joseph's exact Plug Smart example: **52 candidates across all 20 provider/reason groups and seven providers**. This is a stratified audit, not a claim that every queued candidate was individually retested.

Read-only public page/feed checks were captured at approximately 10:27–10:30 a.m. Central. Saved responses were replayed through the corrected parsers, including checks against the final page URL. The compact results are in [the audit evidence](audit-evidence/ats-validation-failures-2026-10-15.json); response cookies and full job descriptions are omitted.

The replay accepted 21 sampled feeds. Of those, **16 had reproducible parser failures corrected by this change** and five had recovered from temporary failures without requiring another adapter repair. The remaining 31 stayed held for unavailable feeds, access refusal or missing employer evidence. An accepted feed can contain zero jobs; successful board validation does not establish job ingestion or scoring.

## Repairs

| Provider | Reproduced problem | Resulting behavior |
| --- | --- | --- |
| Zoho Recruit | The listing feed can omit `Job_Description` even though the posting page contains the full JD. | Retain the verified published summary, then enrich from the exact posting on the same host and named career page. Require a numeric posting identity and title; reject malformed description values. Keep employer branding from the verified board. |
| Gem | Employer titles such as “Phota Labs Open Roles” and “SynthBee Opportunities” were rejected; one feed contained valid summaries with empty descriptions. | Recognize the observed branding suffixes and retain summaries for exact-posting description recovery. Unrecognized branding and malformed content still fail. |
| Kula | Valid RSS items can contain multiple location blocks, or omit geography for an individual posting. | Preserve all supplied locations under one posting ID. Retain missing geography as unknown without claiming unrestricted remote eligibility. Malformed/conflicting fields still fail. |
| JazzHR | Precision Resource's valid XML feed supplies HTTP links on its own vendor tenant. | Upgrade exact same-tenant vendor links to HTTPS. Reject HTTP links on unrelated tenants, arbitrary custom domains, credentials or nonstandard ports. |
| JobScore | Renamed boards publish a canonical namespace different from their historical slug. | Use a provider-published canonical board link for feed requests and posting validation. Keep existing registered board keys. Reserve the canonical feed's hourly interval before requests, including liveness probes. |
| HireHive | Historical tenant names redirect to a new vendor tenant, producing mismatched branding or HTML from the old API URL. | Require the public board's canonical vendor namespace, then request that tenant's feed. Check that redirects land on the original or verified canonical tenant. Keep registry records separate. |

### Exact Zoho example

[Plug Smart's public careers page](https://plugsmart.zohorecruit.com/jobs/Careers) identifies its employer as **Ameresco** and returns one published listing, **DDC / BAS HVAC Controls Technician**. The feed omits the JD; the exact posting page supplies a readable **2,654-character** description and **Ft Myers, Florida, United States** location. The corrected listing parser and existing exact-posting extractor recover those values from captured public responses. Normal title and geography filtering remains authoritative; this parser proof does not claim that the role is an application match.

### Failures that remain held

- Sampled historical JobScore 404/410 feeds remained unavailable.
- Several JazzHR pages redirected to vendor marketing, while their feeds returned 404; other historical feeds returned 410. A page responding with HTTP 200 alone did not establish a usable feed.
- Kula candidates `neara` and `ao-global-elite` returned 403 from their feeds.
- Zoho `vexigo.zohorecruit.eu::Careers` did not supply public board configuration and its feed returned 403.
- Manatal `itcrowdsource` returned no verified employer branding. Empty descriptions for the sampled `srq` board already pass through the existing Manatal detail-recovery path.
- Some Manatal 429/504 failures had recovered by the audit. Their ordinary retries remain appropriate.

## Validation and release boundary

- Full repository test suite: **2,179 passed, 10 skipped, zero failures** (2,189 total).
- ESLint passed for changed implementation and test files.
- The standard TypeScript check reports three existing `TS2365` errors in unrelated `data/runtime/aim-location-review-20261014/**/apply-review.ts` scratch scripts. A check using the repository configuration with only `data/runtime` additionally excluded passed.
- Regression tests cover summary ingestion, exact-posting enrichment, wrong/closed/ambiguous details, redirects, aliases, canonical conflicts, hourly reservations, legacy URL safety, multiple locations and unknown geography.
- No schema migration, production writes, retry release, board merge, job dismissal, score mutation, push or deployment is included. Existing retry schedules and size-review holds remain in place; the repaired adapters take effect after a separately authorized deployment.
