# Remaining aggregator matching gaps — November 6, 2026

The earlier zero-write result came from a bounded rotation: 250 stored lookups and 25 live-capable candidates. It did not exhaust the remaining queue. This investigation audited all **496 active, unpinned unresolved candidates across 433 employers**, read the complete stored employer catalogues, and exercised live lookup for **178 candidates with known boards**.

The source audit made 317 ordinary public HTTP requests. Another 179 cards were explicitly deferred after three access refusals on their source host; those were not individually tested. Public employer profiles and published outbound Apply controls were also inspected. No account registration, paid search, access-control bypass, scoring change, or lifecycle change was used.

## Why matches were still being missed

1. **Workday continuation counts.** Workiva, nVent and Solenis returned real continuation rows with `total: 0`. Recovery incorrectly rejected the catalogue. The reader now retains the first count while requiring every distinct promised row and rejecting conflicting positive counts, duplicates and short pages.
2. **Valid posting URLs were rejected.** iCIMS detail paths end in `/job`, Taleo selects a posting with `?job=`, ADP MyJobs uses `c` and `r`, and BrassRing uses a `jobDetails` fragment. The generic URL predicate missed those identities. BrassRing fragments now survive matching normalization. Static ATS-hosted images are rejected. Hireology, Dover, Trakstar Hire, Prevue APS and HiringThing have narrow posting-path recognition.
3. **Recovery omitted existing provider readers.** Complete public lookup now reuses validated acquisition readers for Oracle, UKG, ADP, iCIMS, Dayforce, JazzHR and other supported public formats. It reads all bounded pages and verifies exact candidate details where the catalogue contains only titles. Failure or truncation remains inconclusive.
4. **Unknown boards were skipped before source recovery.** The live pass now examines a source's published Apply controls and employer website, including Himalayas' public company profile. It verifies the destination's employer and posting metadata, or discovers an official careers board and checks its catalogue. Workday discovery now receives the job title and employer it requires.
5. **Saved evidence and crawl policy were conflated.** Geography/yield exclusions no longer erase saved requisitions from ambiguity checks. Excluded evidence requires current confirmation; excluded boards are not reactivated. Explicit retirement remains a hold. Legacy ADP observations with the same numeric job ID on unrelated tenants no longer seed employer boards or reuse another tenant's description.
6. **Workday aliases looked like different jobs.** GN Hearing publishes R30151 through GN-Careers and ReSoundCareers, with different URL suffixes. Recovery verifies each exact live detail and its actual `jobReqId` before collapsing aliases. It also resolves the detail's legal employer through the existing employer rules. Suffix similarity alone is insufficient.
7. **A newer catalogue could hide an older rival.** Stored competing requisitions now remain in both live-board and employer-discovery comparisons. Socure's saved and currently published postings have different IDs; the new code holds that case rather than substituting the current posting.
8. **Production lookup deadlines were too short.** The first deployed C.H. Robinson check failed twice at the scheduled resolver's 15-second limit. Instrumentation on M70 then obtained all seven Workday pages and both exact details in 19.7 seconds, with every response HTTP 200 and normal provider leases intact. The shared catalogue budget is now 30 seconds, including ingestion and scheduled recovery. Explicit shorter caller deadlines still apply, and an interrupted catalogue still cannot produce a match.

## Results and limits

The final normal-path dry runs confirmed six repairs: Unlimited Potential/Bunzl, Textron, CAS, GN Hearing, C.H. Robinson and Jaggaer. Twenty of the initial 496 candidates already had a recognized ATS or verified employer posting. These are classification corrections, not twenty newly recovered links.

Tenvoorde Ford's published Trabajo Apply control reached its exact Hireology posting during the source audit. A later fresh source request returned HTTP 429. Its captured source-to-target evidence can be replayed and the already-observed employer destination verified independently; the normal resolver leaves a rate-limited source retryable.

Dandy's live candidate is held by a permanent board retirement. Socure is held by historical requisition ambiguity. Original source HTTP 404/410 responses do not establish that the employer's job is closed and do not change a card's lifecycle. Rewritten titles, short summaries, missing requisition IDs, unavailable source controls and unsupported/incomplete catalogues remain explicit evidence gaps.

[The complete per-job inventory](audit-evidence/aggregator-matching-gaps-2026-11-06.json) records each of the 496 cards, source access evidence, catalogue coverage, final classification and proposed destination. Its notes distinguish preliminary source probes from the final targeted decisions. Production deployment and preservation receipts are separate from this predeployment audit.

## Validation and operation

Regression coverage includes Workday zero-count continuations and late rivals, exact cross-site requisition verification, employer aliases, source Apply redirects, unavailable rival destinations, foreign employers/countries, historical requisition conflicts, static asset rejection, BrassRing fragments, and ADP tenant identity and one-based pagination. The full suite and production build run before release; the build uses unusable database credentials.

The normal stored/live timer keeps its separate rotating cursors and link-only writes. The live phase now includes bounded source recovery after a catalogue miss. Its service timeout is 40 minutes to accommodate complete 30-second catalogues and bounded source recovery for 25 live candidates. Existing job descriptions, scores, attachments, lifecycle and user-pinned URLs remain protected by the existing write guard.
