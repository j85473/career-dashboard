# Aggregator-to-employer link recovery audit — November 6, 2026

## Result and release state

The audit found repeatable recovery failures and an incorrect-substitution risk.
The implementation fixes those paths without relaxing employer or geography
checks. This report records the investigation before deployment; its validation
results alone do not establish production activation. Deployment was authorized
after this audit and must be verified against the active release and recovery
reports. Individually verified live link repairs are recorded in the
companion evidence file. Apart from the update timestamp, they preserve every
other Job field, score event and attachment, with a durable metadata-repair
event for each change. Four verified cards received link-only repairs.

## What the production evidence showed

- Seven days of canonical-recovery service logs contained **4,177 repeated
  catalogue-memory-limit failures**. These are failed attempts, not 4,177
  distinct jobs. Large employers repeatedly consumed recovery turns without
  supplying matches.
- At 19:03 UTC, the active non-ATS snapshot contained 776 cards. The recognizer
  did not classify 496 destinations as direct ATS postings: 255 applied, 119
  inbox, 113 pending Aim, and nine interviewing. This is **not a count of 496
  broken aggregator links**: custom employer portals and 11 user-pinned URLs
  are included in that diagnostic population.
- A closer baseline audit of 241 unresolved non-applied cards across 222
  employers produced no match. It found 144 with no retrieved catalogue, 85
  without an exact title candidate, six catalogue-memory failures, and six
  other geography/ambiguity cases. Of those cards, 102 descriptions were under
  1,000 characters. A short rewritten summary often lacks enough identity
  evidence to choose among employer requisitions.
- The protected-browser rotation included about 7,295 unresolved historical
  Himalayas cards. At eight cards per hour, one idealized rotation takes about
  38 days, before failures and other overhead. Historical/dismissed cards were
  consuming the same scarce browser turns as active cards.
- A read-only pass through 487 eligible active cards completed all 429 employer
  groups in 11 minutes 14 seconds without the catalogue-limit failures. This
  pass ran an intermediate candidate before the final requisition, location and
  original-source guards. It proposed two links; review caught and corrected
  the Oracle proposal described below. The intermediate result is evidence of
  retrieval completion, not approval to apply all its proposals.

The audit does not establish a clean historical match-rate trend. Older
ingestion cohorts have had longer to receive recovery, and present-day links
cannot reconstruct the link available at ingestion. The repeated production
failures establish concrete malfunction without overstating that trend.

## Failures and corrections

| User-visible failure | Owning cause | Correction |
| --- | --- | --- |
| Large employers repeatedly fail to recover even a known exact posting. | Retrieval retained every employer description until the 32 MiB safety limit aborted the entire lookup. | Read every bounded page, retain every candidate that can satisfy the same matching rules, and keep all verified board identities. Late competing requisitions remain visible. Link-only lookups omit unused descriptions for short summaries. The safety cap remains. |
| An employer with multiple verified boards is skipped by scheduled recovery. | The scheduled path relied on the singular board field and diverged from ingestion. | Scheduled recovery and ingestion share the same resolver. Live decisions use the complete supported set of verified boards. An unavailable or unsupported board does not become proof of uniqueness. |
| A direct employer application link is present in the source response but is discarded. | Google Jobs used the first application option; JSearch ignored alternate options. | Examine all supplied application options and prefer one unambiguous recognized ATS posting. Conflicting posting identities preserve the original source target. Publisher flags alone are insufficient. |
| Current Workday roles cannot be recovered through the employer API. | There was no complete Workday live-matching path. | Search the verified tenant/site, finish the bounded search, and verify exact candidate details. Changed totals, repeated pages, missing details and foreign employer evidence refuse the match. |
| A first page makes a same-title role look unique. | Single-board lookups did not consistently enforce complete catalogue retrieval. | Single- and multi-board lookup use the same complete reader. SmartRecruiters and Workable pagination are checked; other supported feeds validate completion or refuse truncation. |
| Several links to one Oracle requisition look like competing jobs. | Career-site and locale aliases were counted separately. | Collapse only the same tenant host and exact requisition. Different requisitions and production/test tenants remain distinct. |
| A newer Oracle vacancy can replace the job originally applied to. | Title matching ignored an exact original ATS URL retained in scraped source metadata. | Bind matching to that original posting identity when `URL Source:` metadata names a recognized direct posting. If the original is absent, a newer same-title sibling cannot substitute for it. |
| A clearly identified reprint remains ambiguous. | An explicit employer requisition number was ignored. | A single labelled requisition can disambiguate candidates, while geography and territory checks remain. A conflicting declared requisition cannot win through title/body fallback. |
| A Roseville posting fails because of a display label. | “Twin Cities - Roseville, MN” was interpreted as a different city from Roseville. | Remove only the anchored “Twin Cities” display prefix. Nearby cities and conflicting states remain incompatible. |
| Active Himalayas cards wait behind historical cards or are skipped when the queue changes. | The browser pass scanned all lifecycle states and used a positional offset. | Use the existing active recovery states and a stable ID boundary; checkpoint attempts before network work. Employer discovery uses a stable employer-slug boundary. No card changes lifecycle because it leaves this maintenance queue. |

The source-provider contracts explicitly expose alternate application links:
[JSearch documentation](https://www.openwebninja.com/api/jsearch) and
[Google Jobs results documentation](https://serpapi.com/google-jobs-results).

## Concrete acceptance cases

- **Capital One — Business Development Manager, Luxury Travel:** previously
  aborted at the catalogue memory limit. Scoped retrieval found its exact
  Workday posting; a complete live Workday search/detail lookup corroborated
  the destination.
- **Kennicott — Account Manager:** the saved source and live employer posting
  both identify Roseville. The narrow display-prefix correction recovers the
  Paycom target without treating other Twin Cities locations as interchangeable.
- **Barracuda — Partner Development Manager:** the source and live Jobvite
  description identify requisition **27-0496**. The aggregator URL says Duluth,
  Georgia, but the employer posting says **Spain**. Repairing its exact link
  does not silently change the card's unknown location, scores or inbox state.
- **Oracle — Sr Customer Success Manager, Oracle Health:** the first broad
  preview proposed newer requisition **347403**. The saved source metadata
  identifies original requisition **338307**. The added guard selects the
  original requisition from the stored catalogue and rejects substitution.
  The employer still serves that exact requisition, now titled “Customer Success
  Executive (Payer) - Oracle Health.” The link was repaired to the original
  identity; the saved application title and scores were preserved. The incorrect
  newer-requisition preview was never applied.
- All six employers that failed the baseline memory check completed their
  scoped lookups. Five still lacked a unique proven candidate; those outcomes
  are refusals to guess, not successful repairs.

## Preservation and operational visibility

Automated writes exclude user-selected canonical links both during selection
and in the compare-and-set write. A concurrent edit refuses the repair.
Scheduled recovery remains link-only. The browser path now explicitly uses the
same link-only plan. No score, score authority, description, application state,
attachment, duplicate relationship, board retirement or scoring queue is reset.

Each completed API/stored pass reports outcome counts and can save a restricted
JSON receipt with per-job outcomes and proposed destinations. Applied scheduled
passes automatically save a report beside their cursor. These distinguish
missing evidence, unsupported/unavailable live catalogues and proven matches.
They provide diagnostic evidence; a zero-match pass alone is not a fault.

## Verification and remaining limits

The regression suite covers late-page ambiguity, large unrelated catalogues,
preserved body-only candidates, tenant boundaries, source-URL binding,
requisition conflicts, location conflicts, complete Workday searches, malformed
or partial employer feeds, alternate application options and preservation guards.
The final full suite passed **3,069 tests**, with **10 skipped and zero failures**;
the production build, focused lint and whitespace checks also passed.
Final test/build results and the exact repaired-card receipts are in the
[compact audit evidence](audit-evidence/aggregator-canonical-recovery-2026-11-06.json).

The full production build is run with an unusable database connection. The
full test suite and focused lint must pass before release. After deployment,
verify the active release and at least one completed recovery pass and its
report; local checks are not proof that production is running the fix.

No matcher can safely infer an employer's missing requisition from an anonymous,
truncated or materially rewritten reprint. Unknown employer boards, unsupported
live adapters, closed originals, conflicting locations and multiple plausible
requisitions remain unresolved until direct evidence exists. The change makes
those limits inspectable while repairing the proven implementation failures.
