# Career Dashboard Aim and Experience Scoring Implementation Plan

**Date:** 2026-08-12

**Workspace:** `/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard`

**Status:** Historical combined design with compatible Experience/manual-exchange requirements retained. Aim v2 is superseded by the audited stability plan below. This document does not authorize scoring runs, database mutation, reconciliation apply, commits, pushes, or deployment.

> **Aim Fit supersession — 2026-08-13:** For Aim Fit, `docs/AIM_SCORING_STABILITY_IMPLEMENTATION_PLAN_2026-08-12.md` supersedes every conflicting Aim design, contract, cleaning, controller, scoring, identity, persistence, import, display, test, calibration, and rollout requirement in this document. Compatible manual-exchange and Experience Fit requirements remain in force; Experience continuity changes are limited to the original-source handoff explicitly required by the Aim stability plan.

> **Cutover implementation note — 2026-08-13:** Active code uses Aim v2 complete-source factual extraction, the application-owned deterministic result builder, split extraction/scoring identities, fail-closed v2 export gates, mixed complete/safe-failure preview and atomic apply, and Experience v2 original-source/Aim-extraction continuity. References below to active Aim cleaning, broad Aim evaluation, cleaned-JD Experience v2 input, native scoring, or all-safe-failure batch rejection are historical and must not be followed.

## 1. Authority, consolidation, and scope

This plan consolidates the scoring scratchpad and the two earlier implementation plans into one coherent specification. When another scoring design document conflicts with this plan, this plan wins. Until Phase 1 updates `.agents/AGENTS.md`, that file inaccurately describes the old production workflow; it is an implementation-cutover dependency, not evidence that native scoring may be resumed.

### Source ledger

| Source | SHA-256 at consolidation | Disposition |
|---|---|---|
| `/Users/JosephLamb/Career Dashboard/AIM_EXPERIENCE_SCORING_SCRATCHPAD_2026-08-11.md` | `351064f43aab39054d4c06c2ea6e5fb3185830af9028f0f933af939bab2de975` | Historical discussion record. Preserved outside the repository, but superseded and non-authoritative. |
| `docs/CAREER_DASHBOARD_CODEX_DESKTOP_SCORING_PIVOT_PLAN_2026-08-10.md` | `14ce67d5b850e3f2327c679de36506d19dd19f8731d63b2dff34481d3d7c6059` | Useful safeguards incorporated here; source file deleted during consolidation. |
| `docs/CAREER_DASHBOARD_CRITERION_SCORING_IMPLEMENTATION_PLAN_2026-08-10.md` | `cfec684754f164347296b402c753a8a0a4f43a4fdddb7b864a0827e696b2c713` | Useful evidence semantics and gap-register design incorporated here; source file deleted during consolidation. |

The following older V6/native-scoring documents remain historical context only. They are not instructions for future scoring work and must receive an explicit retirement banner or be removed when the implementation changes their referenced workflow:

- `docs/CAREER_DASHBOARD_SCORING_FINISH_HANDOFF_2026-08-09.md`
- `docs/ANTIGRAVITY_V6_SCORING_WALKTHROUGH.md`
- `.agents/ANTIGRAVITY_V6_SCORING_WALKTHROUGH.md`
- `.agents/v6_architecture_audit_context.md`
- `docs/PLAN_2026-08-07_repoint_scoring_to_channel_positioning.md`
- `docs/CAREER_DASHBOARD_INGESTION_SCORING_AUDIT_2026-08-02.md`

Historical migrations, score events, native-request records, and audit artifacts are evidence of prior system behavior. Superseding their operating instructions does not authorize deleting their data.

### In scope for the future implementation

- two separate manual scoring stages: Aim Fit, then Experience Fit;
- conservative JD cleaning and coverage auditing;
- versioned Dashboard JSON export and scored-result contracts;
- an external, repository-owned Python runner for each stage;
- a thin personal `$career-dashboard-scoring-protocol` skill for Codex Desktop or Remote;
- deterministic Dashboard validation, score recomputation, preview, approval, and atomic import;
- stage-aware score authority, invalidation, queue state, provenance, and evidence-gap reporting;
- making native Agy scoring unreachable through normal product, package, deployment, and instruction paths;
- calibration fixtures, canary review, and deployment gates.

### Out of scope unless separately authorized

- any Dashboard-to-Codex, Dashboard-to-OpenAI, Dashboard-to-Agy, or other direct model/API integration;
- automatic upload or import by the external runner or skill;
- a combined Aim-plus-Experience external orchestrator;
- reviving Agy as a fallback or rollback;
- autonomous evidence-inventory edits;
- deleting historical scoring rows or dropping native-scoring tables;
- enabling a numeric Aim threshold in the first release;
- changing the canonical resume designation;
- modifying the Mac LaunchAgent or Agy permissions without Joseph's explicit cutover approval;
- pushing to GitHub or deploying to the Raspberry Pi without the separate authority required by repository policy.

## 2. Interpretation of the pivot

The pivot is larger than replacing one model runner with another. It changes the scoring system along three axes.

### Operational pivot

The Dashboard stops being an AI orchestrator. It becomes the trusted queue, snapshot, validation, approval, and persistence boundary. Codex runs outside the Dashboard against an explicitly exported file. There are no model calls, background model requests, or watcher dependencies inside the deployed application.

### Decision pivot

Aim and Experience answer different questions and are intentionally asymmetric:

- **Aim:** Is this role worth continuing to evaluate for Joseph's preferences? It has a short closed hard-stop list, otherwise fails open, and initially records an ungated calibration score.
- **Experience:** Does the approved evidence fully support every explicit substantive hard requirement? It is strict. Every hard requirement must be fully supported. Preferred qualifications rank only the already-qualified survivors.

This replaces the old idea that both dimensions are ordinary weighted scores with numeric pass thresholds. Aim is permissive preference triage; Experience is an evidence gate followed by qualified-survivor ranking.

### Authority pivot

Codex makes source-bound semantic judgments. Python makes a deterministic preview and manages resumable local artifacts. The Dashboard independently validates and recomputes every aggregate, and only the Dashboard may create authoritative score events or change job lifecycle. Python arithmetic is never persistence authority.

The critical boundary is:

> Per-job acceptance and resume exist only in the external runner's local workspace. Dashboard import requires exact membership for the complete stage batch and applies it all-or-nothing after a side-effect-free dry run and a second explicit approval.

## 3. Locked decisions and consolidation refinements

### Locked

1. Aim and Experience are separate stages with the Dashboard between them.
2. The Dashboard never calls a model, Codex, Agy, or an AI API.
3. Joseph uses a thin no-terminal personal skill to run one supplied stage export.
4. Every semantic worker receives one job only in a fresh isolated invocation.
5. JD text is untrusted data, never executable instruction.
6. Cleaned JDs are immutable provenance artifacts and never replace `Job.description`.
7. Aim hard stops are closed, explicit, and fail-open when uncertain.
8. Numeric Aim is calibration-only in the first release and cannot dismiss a job.
9. Travel contributes 15 Aim points and is also retained as a separate explicit travel display; it never contributes to Experience.
10. Experience requires full support for every explicit substantive hard requirement.
11. `cannot_evaluate` is evidence silence; `does_not_meet` requires affirmative verified conflict. They never collapse into one “not supported” outcome.
12. Administrative eligibility is excluded from Aim and Experience scoring.
13. Qualified Experience scores start at 80; preferred criteria contribute at most 20; no preferred criteria means 80, not 100.
14. A failed hard requirement cannot be rescued by preferred qualifications or a number.
15. Candidate evidence is positive support, not an exhaustive biography. A JD and a scoring result cannot add candidate facts.
16. Both imports require exact batch membership, side-effect-free dry run, explicit approval, repeat validation, protected-user-action enforcement, and one database transaction.
17. Native Agy remains disabled and becomes unreachable; it is never the rollback.
18. There is no login-screen work in this project.

### Decision D1 — strict role-defining credentials (resolved 2026-08-12)

Joseph resolved the final open scoring-policy choice: an explicitly required candidate-owned role-defining credential is a strict substantive hard requirement.

Examples include an explicitly required RN, CPA, professional license, or similar candidate-owned credential that is intrinsic to performing the role. These are different from administrative eligibility such as a driver's license, MVR, security clearance, work authorization, background check, or drug screen.

- Verified inventory evidence for the exact credential may produce `direct` and satisfy the requirement.
- If the approved evidence inventory contains no verified record of the credential, the criterion produces `cannot_evaluate`, blocks the hard-requirement gate, and dismisses the job. The rationale states `required credential not established in approved evidence`; it does not make a broader unsupported biographical claim.
- Affirmative verified conflict may produce `does_not_meet` and also dismiss the job.
- There is no verification-only exception and no path for another requirement, preferred qualification, or numeric score to rescue the job.
- Joseph's policy decision is not itself a new evidence-inventory record and does not collapse `cannot_evaluate` into `does_not_meet`. It establishes the same terminal screening outcome for either state while preserving truthful audit semantics.
- Missing strict credentials are terminal screening findings, not open research questions, and are excluded from the active evidence-gap register.

This resolved policy must be encoded in `experience-policy-v1.json`, schemas, fixtures, importer logic, dismissal rationale, and evidence-gap exclusions before Experience scoring is enabled.

### Explicit consolidation refinements

The following safety and representation choices resolve ambiguity or supersede wording in the scratchpad. They were selected during formalization rather than inherited as previously settled Joseph decisions. They remain the recommended specification unless Joseph revises them before authorizing implementation:

- **Rejected scores are null:** an evaluated Aim hard stop or Experience hard-requirement failure creates an authoritative decision event, but no numeric fit score. A numeric Experience score has meaning only for qualified survivors.
- **Safe failure is distinct from interruption:** this deliberately supersedes the scratchpad statement that every missing Experience score means interruption. Evidence uncertainty produces `cannot_evaluate`; an untrustworthy source/result produces a bound `safe_failure`; absence of a final process artifact means technical interruption.
- **Experience ranking is coarse and secondary:** 80–100 reports the share of that posting's preferred criteria supported after qualification. The Dashboard may use it as a coarse secondary ordering among qualified survivors, preserving the scratchpad's ranking intent, but must not present a 96 on one posting as an absolute proof that the job is stronger than an 88 on another. It never gates, rescues, or outranks Joseph's review.
- **Plan-selected operational defaults are versioned:** batch size, canary size, retry counts, timeout, and half-up rounding are implementation defaults selected here. Rounding is a deterministic contract; the operational bounds must be measured during canary and may change only through an explicit protocol/policy version, never mid-batch.

### Intentional calibration decisions that do not block release 1

- Numeric Aim threshold: deliberately absent in v1. A later threshold requires calibration evidence, Joseph's approval, and a new policy version.
- Aim point weights: the v1 bands below are locked for the first calibration run, not permanent truth.
- Batch size: default 20, hard maximum 50; the first reviewed canary is 10 jobs.
- Model: Terra Medium is the intended default; Terra High is a bounded escalation for a genuinely ambiguous artifact. The current installed Codex CLI and available model identifiers must be checked at implementation time; no silent model fallback is allowed.

## 4. Target workflow

```mermaid
flowchart LR
    A["Dashboard: Aim Ready"] --> B["Export exact Aim batch"]
    B --> C["External Aim runner: clean, audit, judge, checkpoint"]
    C --> D["Complete Aim result JSON"]
    D --> E["Dashboard: dry run"]
    E --> F["Joseph explicitly approves"]
    F --> G["Atomic Aim import"]
    G --> H["Aim survivors: Experience Ready"]
    H --> I["Export exact Experience batch"]
    I --> J["External Experience runner: extract, audit, evaluate, checkpoint"]
    J --> K["Complete Experience result JSON"]
    K --> L["Dashboard: dry run"]
    L --> M["Joseph explicitly approves"]
    M --> N["Atomic Experience import"]
    N --> O["Qualified jobs: Inbox"]
```

### Stage 1 — Aim Fit

1. Joseph selects **Export Aim Batch** in the Dashboard.
2. A POST route creates a durable batch and exact per-job leases, then downloads `career-dashboard-aim-export-<batchId>.json`.
3. Joseph supplies that file to `$career-dashboard-scoring-protocol` in Codex Desktop or Remote.
4. The Aim Python entrypoint processes jobs in input order. For each job it runs isolated workers for conservative cleaning, coverage audit, Aim judgment, and targeted repair only when required.
5. The runner writes accepted per-job artifacts atomically to a local task directory. Interrupted runs resume from those artifacts.
6. Only after every batch member has a validator-accepted result does the runner assemble `career-dashboard-aim-results-<batchId>.json`.
7. Joseph uploads the complete result to the Dashboard. The first action is a zero-write preview.
8. A second explicit approval repeats validation and imports the entire Aim batch in one transaction.
9. Hard-stop jobs are dismissed. Survivors retain an Aim score and become Experience Ready. Numeric Aim does not gate v1 survivors.

### Stage 2 — Experience Fit

1. Joseph selects **Export Experience Batch**.
2. The Dashboard exports only current Aim survivors, each bound to its authoritative Aim event and immutable cleaned-JD artifact, plus the approved evidence snapshot and canonical-resume binding.
3. The separate Experience Python entrypoint uses three isolated semantic workers per job: requirement extractor, requirement coverage auditor, and evidence evaluator. Targeted repairs are isolated too.
4. The runner checkpoints accepted per-job artifacts and assembles a complete result only when every batch member validates.
5. The Dashboard previews the complete result with zero writes.
6. A second explicit approval repeats validation and imports the entire Experience batch in one transaction.
7. A job with any hard requirement not fully supported is dismissed with a precise outcome and no numeric Experience score. A qualified job receives 80–100 and moves to Inbox.

### Abandoned, expired, changed, or interrupted batches

- An interrupted external run remains resumable locally. It is not a Dashboard import failure.
- An expired batch remains leased and visibly blocked. Expiry never silently releases jobs.
- Joseph may explicitly extend an unchanged batch or release it.
- If any source input changes while a batch is outside the Dashboard, the batch becomes superseded and cannot import. Joseph explicitly releases it and exports a new batch.
- Re-exporting does not force unchanged jobs to be semantically rerun: the external cache may reuse accepted artifacts only when protocol version and complete semantic `inputHash` match.
- There are no partial receipts, partial Dashboard imports, omitted-job imports, or “apply the good rows” behavior.

## 5. Ownership boundaries

| Component | Owns | Must not own |
|---|---|---|
| Dashboard exporter | candidate selection, source snapshots, policy snapshots, batch identity, hashes, exact membership, leases | semantic scoring, worker invocation |
| External Python runner | deterministic iteration, isolated invocation, local checkpoints, mechanical normalization, retry bounds, preview arithmetic, result assembly | database access, Dashboard import, lifecycle changes, authoritative aggregates |
| Codex workers | semantic cleaning classification, source-bound Aim judgments, requirement extraction, coverage judgment, evidence assessment | commands derived from a JD, source mutation, database writes, aggregate authority |
| Repository validator | schema, sizes, canonical hashes, source/evidence binding, exact coverage/order, arithmetic parity | subjective job judgment, repairing semantic output |
| Dashboard importer | zero-write preview, concurrency checks, independent recomputation, protected-user-action enforcement, approval binding, atomic persistence | model calls, output repair, evidence edits |
| Joseph | export timing, supplied file, model/effort selection when needed, approval, calibration decisions | terminal operation |

## 6. Conservative JD cleaning contract

The cleaner is a source-preserving deletion/classification step, not a summarizer.

### Required retention

Retain every potentially substantive passage about:

- role purpose, duties, ownership, and scope;
- required and preferred experience or qualifications;
- customers, selling motion, account motion, industry, and operating environment;
- location, work arrangement, territory, and travel;
- disclosed base compensation, variable compensation, OTE, currency, period, and geographic variants;
- employer identity or role terms relevant to an Aim hard stop.

### High-confidence removable material

- EEO, applicant-rights, and generic legal boilerplate;
- benefits boilerplate;
- application instructions;
- privacy and cookie notices;
- navigation, duplicated fragments, and scraped-site debris;
- clearly irrelevant employer marketing copy.

When uncertain, keep the content. An oversized cleaned JD is acceptable; omission of a meaningful duty or requirement is not.

### Source preservation

- The cleaner may normalize mechanical whitespace and remove classified spans. It may not paraphrase substantive text.
- The semantic cleaner returns only ordered, source-bound removal spans. Deterministic Python validates those spans and reconstructs `cleanedText`; the model never reproduces the retained JD as output.
- Every retained or removed span must remain traceable to the original JD by source offsets and a source-text hash.
- A cleaned artifact records the original JD hash, cleaned-text hash, removed-span classifications, coverage findings, and repair history.
- A separate coverage worker compares the original and cleaned texts solely for substantive omissions.
- Targeted repair may restore omitted source text. It may not invent a replacement sentence.
- Cleaner repair carries only the prior removal spans and exact validator findings. It does not resend a model-generated `cleanedText` copy.
- `Job.description` remains unchanged. The artifact is a separate immutable record.
- If adequate duties and qualifications cannot be established without guessing, the runner emits a per-job safe failure and continues. Mixed apply imports validated successes and releases that failed item's lease so it remains eligible for a later batch.

## 7. Aim Fit policy v1

Aim evaluates preference fit, not candidate qualification.

### Gate behavior

- Apply hard stops before numeric scoring.
- Reject only when a hard stop is established by explicit JD text, trusted exported job metadata, or a Joseph-approved versioned employer override.
- Ambiguity, missing language, or an unresolved judgment passes the hard-stop layer.
- A hard-stop result uses `decision = rejected_hard_stop`, a closed reason code, source binding, and `aimFitScore = null`.
- A survivor uses `decision = survivor`, receives a 0–100 calibration score, and advances regardless of that number in policy v1.
- Enabling a numeric gate later requires a new policy version. It cannot be activated through a configuration accident.

### Closed hard-stop list

1. **Inside Sales.**
2. **Personal direct hunting above roughly one-third of the role.** This means personal cold calling, self-sourced direct prospecting, direct new-logo acquisition, or personally carrying most of the outbound burden. Channel-generated growth, partner recruitment, co-selling, joint planning, reseller enablement, and channel demand creation are not personal hunting.
3. **Cannot remain based in Minneapolis.** A required residence, commute, onsite presence, or hybrid presence outside the Minneapolis metro is a hard stop. Remote work permitted from Minnesota and Minneapolis-based roles with regional, national, or international travel pass.
4. **Part-time, temporary contract, or 1099 work.**
5. **Consumer-facing store sales or store management.** Field, territory, channel, or partner work involving retail accounts or locations remains eligible.
6. **Faith-based, religiously affiliated, or religious-adjacent employer.**
7. **Direct employment by PepsiCo.**
8. **Direct employment by AT&T.**
9. **Local insurance office or insurance-agency role.**
10. **Disclosed total compensation or OTE entirely below USD 60,000 annually.**

Hard-stop codes are versioned and closed: `inside_sales`, `personal_hunting_over_one_third`, `non_minneapolis_base_required`, `part_time_temporary_contract_or_1099`, `consumer_store_sales`, `religious_employer`, `direct_pepsico_employer`, `direct_att_employer`, `local_insurance_agency`, and `total_comp_below_60000`.

### Hard-stop evidence rules

- Personal hunting rejects when the JD supplies an explicit share above one-third or makes a personally owned majority-outbound burden unmistakable. A generic prospecting duty is not enough.
- Employer hard stops use direct employer identity, not a customer, partner, brand mention, or staffing relationship.
- Faith/religious classification and known employer aliases use `data/scoring/aim-employer-overrides-v1.json`, reviewed by Joseph. The runner does not browse to classify an employer.
- Compensation absent: neutral.
- A disclosed range reaching USD 60,000 or higher passes.
- Base below USD 60,000 with explicit total compensation/OTE at or above USD 60,000 passes.
- Undisclosed commissions, bonuses, and OTE are never invented.
- Non-annual, non-USD, or otherwise non-comparable compensation fails open unless the exported source supplies everything needed for a deterministic conversion policy approved in a later policy version.
- Once compensation passes the hard stop, it contributes no Aim points.

### Historical rejections explicitly removed or softened

- staffing-company employment is not a hard stop;
- Workday is not a hard-stop employer and Workday ATS identity is always score-neutral;
- entry-level language is not a hard stop; disclosed compensation controls;
- no travel is not a hard stop;
- support, implementation, training, and internal operations without commercial ownership are weaker fits, not automatic rejections;
- Sales Operations, Revenue Operations, Sales Enablement, and commercial-strategy roles remain eligible as weaker fits;
- title and seniority do not determine Aim.

Broad upstream occupational filtering may remain a separate, traceable source-ingestion concern for obviously unrelated work such as direct patient care, manual labor, skilled trades, warehouse work, software development, HR/recruiting, and design production. It must not become a second unversioned Aim deny list, and commercial roles selling into an otherwise unrelated industry remain eligible.

### Upstream eligibility and bypass removal

The current upstream/local paths conflict with this policy and are part of the scoring cutover, not an unrelated cleanup:

- `src/lib/jobFiltering.ts` may reject structurally unusable/test listings and the versioned broad non-target occupations above, but it may not enforce personalized Aim hard stops before an auditable Aim event. Move inside-sales, employment-type, consumer-store, Minneapolis-base, employer, hunting, and compensation decisions into Aim.
- Remove staffing-company and entry-level rejection. Narrow retail filtering so field/channel/account work involving retail locations remains eligible. RevOps, Sales Ops, Enablement, support, implementation, training, and strategy remain eligible weaker Aim paths.
- Remove every Prompt Health or other named-company shortcut. `src/lib/priorityOpportunity.ts` may provide a non-authoritative display flag only; it cannot bypass Aim, guarantee a score, route directly to Experience/Inbox, or override cooldown/scoring authority.
- `src/lib/jobScoring.ts` may not create a guaranteed Inbox path or reject the newly softened roles. Any retained local heuristic is upstream discovery metadata only and cannot become Aim/Experience/lifecycle authority.
- `src/lib/cooldownRecovery.ts` restores a job to the correct derived staged lane, never directly to Inbox because of company identity or a failed availability check.
- `src/lib/jobIngestion.ts` must preserve the same boundary wherever it applies `passesPreFilter` or machine initial statuses.

Tests must prove no named company, historical hard-coded preference, local heuristic, recovery path, or ingestion path can skip the two-stage gate.

### Calibration bands

Codex selects one allowed band per category from source-bound facts. Deterministic code assigns the points.

| Category | Band | Points |
|---|---|---:|
| Core work (40) | exceptional archetype | 40 |
| | strong fit | 34 |
| | acceptable fit | 26 |
| | weaker but eligible | 16 |
| | unclear | 26 |
| Building/autonomy (25) | ground-floor, founder-adjacent, greenfield, or major global ownership | 25 |
| | strong ownership or substantial growth mandate | 19 |
| | some influence and improvement opportunity | 12 |
| | little building or autonomy | 5 |
| | unclear | 12 |
| Product/industry (20) | highly fascinating | 20 |
| | interesting technology | 14 |
| | slight positive, including medical or pharmaceutical | 6 |
| | neutral or unclear | 0 |
| Travel (15) | international travel | 15 |
| | national air travel | 12 |
| | overnight regional travel | 8 |
| | local territory travel | 4 |
| | explicit meaningful travel, mode unspecified | 4 |
| | none or unstated | 0 |

`aimFitScore = corePoints + buildingPoints + productPoints + travelAimPoints` for survivors only.

### Category interpretation

**Core work:** Highest fits include channel-led growth, partner ecosystems, distributor management, indirect selling, and founder-adjacent AI building with broad ownership. Other strong paths include direct B2B farming, named-account growth, commercially accountable Customer Success, and balanced acquisition/account growth with personal direct hunting at or below one-third. Support-heavy Customer Success, RevOps, Sales Ops, enablement, implementation, and internal strategy without commercial ownership are weaker but eligible.

**Building/autonomy:** Highest signals are building a territory, channel, program, function, company, or operating model; genuine founder proximity; meaningful authority to shape the approach; global or cross-market scope; and consequential ambiguity. Substantially growing, restructuring, or improving an existing territory, program, channel, or account base and meaningful freedom to influence strategy/execution are positive. Maintaining a mature book or working in a scripted system is lower but not disqualifying. Startup language earns nothing without substantive building/autonomy evidence.

**Product/industry:** Highest interest includes AI central to an engaging product or problem, such as security, identity, physical AI, AI transformation, and emerging technology. Interesting technology is positive. Medical and pharmaceutical sales receive a small positive. CPG/distribution, POS/payments, HR/payroll/finance/ERP, and other categories without a strong pull are neutral. A generic AI mention does not elevate an uninteresting underlying product.

**Travel:** Use only explicit source language. Choose the highest supported travel mode when more than one is stated. No supported amount of travel is penalized as excessive. Explicit meaningful field travel always receives at least the 4-point `mode_unspecified` band; this includes a percentage or qualitative frequency such as “50% travel” or “frequent travel” when geography/mode is not stated. Never infer travel from a title, territory, industry, or expected company growth. Missing travel is 0 points, not proof that travel is impossible. Exceptional ground-floor/building points can outweigh a zero travel band without inventing a separate compensation bonus.

### Aim-neutral or excluded factors

- direct reports, except that none may be described qualitatively as a barely perceptible preference and never changes points;
- title and seniority;
- remote, hybrid, or onsite arrangement when Minneapolis can remain the base;
- compensation at or above the gate and undisclosed compensation;
- ATS provider;
- employer reputation, perceived benefits, and personal anecdotes;
- administrative eligibility and candidate qualification evidence.

### Gold calibration fixtures

Freeze source snapshots for the following positive anchors when Phase 1 creates fixtures:

| Rank | Job | Job ID | Primary calibration value |
|---:|---|---|---|
| 1 | Human Agency — Chief of Staff — Minneapolis | `35935761-81ab-4516-9e2b-9289dba033f2` | AI-centered founder-adjacent building and broad autonomy |
| 2 | Verkada — National Channel Sales Manager, Midwest | `00d78158-ea26-481a-accc-7344f2b659b2` | physical AI, channel growth, national scope, substantial travel |
| 3 | Sellsig — Customer Success Manager | `39a5c794-d01f-4db5-8dd7-79ea08b7ab6e` | founding-stage function building and commercial ownership outweighed no stated travel |
| 4 | Hoxhunt — Channel Account Manager | `bd49c30b-1be8-4de0-be8f-8e8aaa3e435d` | AI cybersecurity, channel building, autonomy |
| 5 | Deloitte — Channel Sales Manager, Anthropic Alliance | `18ef0796-52e4-466f-be01-ea5a67d75c19` | AI alliance, relationships, autonomy, travel; more matrixed |

Also freeze the pairwise lessons from the scratchpad: Citi over Keeper because travel can overturn a moderate duties advantage; TTE over Capsule due product and travel; 3M medical-device business development over Lyra due autonomy/global scope/travel; Tellius slightly over NICE due strategic post-sale ownership while both remain in a similar strong-fit range; Okta clearly over Miter due identity/security/agentic-AI product interest. A job failing a hard stop, specifically the Channel Partners De'Longhi/Nutribullet role that failed the minimum-compensation gate, must never enter a pairwise scoring fixture.

The fixtures test broad ordering and reason codes, not byte-identical model prose.

## 8. Experience Fit policy v1

Experience evaluates whether approved evidence supports the posting's explicit substantive qualifications. It does not infer Joseph's biography from silence.

### Isolated semantic stages per job

1. **Requirement extractor:** produces source-bound top-level required and preferred criterion trees.
2. **Requirement coverage auditor:** compares the extracted set to the cleaned JD and detects omitted, duplicated, combined, split, or misclassified criteria.
3. **Evidence evaluator:** evaluates the approved criterion set against the exported evidence snapshot.

The coverage auditor cannot silently add criteria. Its findings return to a targeted repair worker; the repaired set must revalidate.

### Criterion structure

Every top-level criterion includes:

- stable criterion ID derived from stage input identity and source binding;
- `required` or `preferred` classification;
- exact source quote and offsets in the cleaned artifact;
- source section and requirement cue;
- logical operator: `single`, `all`, or `any`;
- ordered atomic leaves;
- attached alternatives and equivalence clauses;
- concise normalized meaning used only for comparison and display.

Rules:

- Follow explicit required/minimum/must qualification structure. Do not infer hard requirements from ordinary responsibilities.
- Preserve `A and B` as an `all` group and require both.
- Preserve `A or B` as an `any` group and allow either.
- Keep “or equivalent experience” and similar alternatives attached.
- Do not split a clause when splitting changes its logic.
- Preferred, desired, bonus, and nice-to-have criteria remain preferred.
- The importer rejects duplicate or overlapping source-bound top-level criteria rather than guessing a new denominator.
- Subjective hiring boilerplate such as “excellent communicator,” “self-starter,” “thrives in ambiguity,” “passionate,” “high-energy,” and generic “attention to detail” is deterministically excluded, not evaluated.

### Stored outcome vocabulary

Use the existing precise outcome codes with clear UI labels:

| Code | UI meaning | Evidence rule |
|---|---|---|
| `direct` | Fully supported | approved evidence establishes the complete criterion or a valid alternative |
| `partial` | Partially supported | approved evidence establishes only part or genuinely adjacent function/scope |
| `cannot_evaluate` | Not established in the approved evidence | evidence is silent or insufficient; this is not a negative biography claim |
| `does_not_meet` | Affirmative conflict | verified evidence affirmatively conflicts with the criterion |
| `excluded` | Non-scoring item | deterministic application classification only; a model cannot assign it |

“Not supported” is not a stored outcome because it obscures the difference between unknown and affirmative conflict.

`direct` and `partial` require valid structured support records with approved evidence IDs, the exact evidence field, exact source quote/offsets, and a bounded explanatory note. `does_not_meet` requires a separate structured conflict record with the same exact binding to affirmative evidence. `cannot_evaluate` has no fabricated support or conflict. Rationale must stay within what the exported evidence establishes.

The authoritative support/conflict assertion is the exact evidence selection, not free prose: `{ evidenceId, fieldPath, startCodePoint, endCodePoint, exactQuote, relation }`, where `relation` is a closed enum such as `supports_complete`, `supports_partial`, or `conflicts`. The Dashboard deterministically verifies identity, field, offsets, exact quote, allowed lengths, relation/outcome compatibility, and cardinality. An optional explanatory note is display-only. The Dashboard does not pretend to prove semantic relevance with string matching; Codex owns that source-bound judgment, which is covered by gold fixtures and Joseph's dry-run review.

### Compound outcome rules

For an `all` group:

1. `does_not_meet` if any required leaf has affirmative conflict;
2. otherwise `cannot_evaluate` if any leaf is unknown;
3. otherwise `partial` if any leaf is partial;
4. otherwise `direct`.

For an `any` group:

1. `direct` if any valid alternative is direct;
2. otherwise `partial` if any alternative is partial;
3. otherwise `cannot_evaluate` if any alternative is unknown;
4. otherwise `does_not_meet` only when every valid alternative affirmatively conflicts.

The full leaf detail remains in the event even when a group outcome is derived.

### Hard-requirement gate

- Every explicit substantive required criterion must resolve to `direct` for the job to qualify.
- Required `partial`, `cannot_evaluate`, or `does_not_meet` blocks the job.
- Preferred outcomes never dismiss a job.
- A blocked job uses `decision = hard_requirement_not_fully_supported`, lists each blocking criterion and exact outcome, receives `experienceFitScore = null`, and is dismissed.
- The rationale says the requirement is not fully supported by the approved evidence and preserves the distinction between partial, unknown, and conflict. It makes no broader claim.
- A valid full JD containing no explicit hard requirements passes at 80. The extractor must not invent requirements from duties.

### Degree and functional-equivalence rules

- A generic bachelor's-degree requirement is satisfied by Joseph's verified degree evidence.
- A broad related-field degree requirement is satisfied when Biology/Healthcare Science reasonably falls within the wording.
- An explicitly required specialized degree, such as engineering or accounting, remains a substantive hard requirement.
- Evaluate the actual function rather than rejecting on an industry label alone.
- Sara is genuine SaaS/platform experience for supported rollout, adoption, enablement, workflow, reporting, troubleshooting, and partner-usage functions.
- Sara may support SaaS platform, implementation, adoption, enablement, or functionally matched retention requirements when the evidence and required function align.
- Sara does not create quota-carrying SaaS Account Executive tenure, formal ARR/NRR ownership, subscription-contract ownership, or unrelated SaaS commercial experience.
- Transferability can establish genuine functional equivalence; it cannot inflate adjacent experience into a narrowly scoped hard requirement.

### Administrative exclusions

Exclude administrative eligibility from requirements, outcomes, denominators, pass/fail, Aim, and the evidence-gap register. This includes:

- driver's license, MVR, vehicle, transportation, and insurance;
- work authorization, sponsorship, security clearance, age, and identity checks;
- background checks, drug screens, onboarding conditions, and generic physical boilerplate;
- willingness or ability to travel, territory logistics, and relocation administration.

Resolved Decision D1 governs candidate-owned role-defining credentials; it must not be hidden inside this administrative list or softened into verification-only treatment.

### Qualified-survivor score

Clearing all required criteria establishes a score of 80. Preferred top-level criteria share 20 points equally.

For each preferred criterion, assign deterministic units:

- `direct = 2`;
- `partial = 1`;
- `cannot_evaluate = 0`;
- `does_not_meet = 0`.

For `P > 0` preferred criteria and total units `U`, calculate once with integer half-up rounding:

```text
preferredPoints = floor((20 * U + P) / (2 * P))
experienceFitScore = 80 + preferredPoints
```

This avoids Python banker's rounding and must produce identical TypeScript and Python fixtures. The Dashboard recomputes the formula and rejects a mismatched runner preview.

If `P = 0`, `experienceFitScore = 80` and the explanation states `no preferred qualifications stated`. A single fully supported preferred criterion can produce 100; this score is within-posting preferred-coverage ranking, not a globally normalized measure of job strength.

There is no separate numeric Experience cutoff. Only the hard gate determines qualification. A rejected job has no pseudo-score from 0–79.

### Evidence authority and canonical resume binding

- The current repository evidence-authority mirror is `docs/Candidate_Evidence_Inventory_-_Core_v1.md`. At consolidation its SHA-256 was `7214b8a66d49cad0af43fb8ef6fc253c7b7f78e89b104ee8ecfba575dcfed67e`; Phase 0 must revalidate that it is still the approved current mirror rather than treating this snapshot hash as permanent.
- `src/lib/scoringEvidence.ts` must deterministically parse and validate the current Core Evidence records into the structured export snapshot. The source-file hash and canonical structured-snapshot hash are both bound into the Experience export.
- The approved structured evidence snapshot derived from that authority is the operational support authority for the batch. The evidence inventory currently embedded in `.agents/agents/standard-job-evaluator-v6/agent.md` is a derived historical copy and must not become a competing authority.
- Each support or conflict record references an exported evidence ID and bounded claim that the validator can verify against that snapshot.
- The canonical resume is exported and hash-bound as an immutable identity/provenance cross-check, but an uncited resume phrase cannot silently become a new evidence record.
- The current designated repository resume is `data/resumes/JosephLamb_Resume.docx`, SHA-256 `23ceb1cb09d9ec8d0350ae4da96da018b26517c0f9b58dbe2762f0e44e0ad059`; Phase 0 must revalidate it against the global designation.
- Phase 0 verifies that repository mirror byte-for-byte against the sole globally designated resume on Joseph's Mac and records the approved hash in the versioned production contract. The deployed Pi exports only the verified repository mirror/hash; it is not expected to read Joseph's Mac Desktop at runtime and it has no fallback.
- At implementation/cutover time, the Mac-side designation check verifies the global path and SHA-256, while the production exporter verifies the approved repository mirror against that recorded hash. Neither side may fall back to the first database resume, a historical resume, or a same-named file with different bytes.
- If the canonical resume is missing or its bytes differ from the designated hash, Experience export stops and asks Joseph to designate the current copy.
- A scoring result cannot edit the evidence inventory, resume, ContextProfile, preferences, source JD, or employer overrides.

## 9. Travel and compensation representation

The current policy intentionally supersedes older language saying Travel is numerically separate from Aim.

### Travel has two representations

1. **Aim preference contribution:** one of the 15/12/8/4/0 travel bands contributes to the Aim total.
2. **Explicit source display:** retain the JD's actual point, range, maximum, minimum, or qualitative travel wording independently for UI and audit.

The structured travel assessment contains:

- source quote and offsets;
- kind: `point`, `range`, `up_to`, `at_least`, `qualitative`, or `unstated`;
- minimum and maximum percent when explicitly available;
- normalized qualitative frequency when no percentage exists;
- selected Aim travel band and points.

Nothing stated means `unstated`, no percentage assertion, and 0 Aim travel points. It is not proof of zero travel. The UI may display “Not stated” rather than inventing `0%`.

Do not overload the same persisted number with both travel percentage and Aim points. `aimAssessments.travel.points` stores preference points; the structured travel assessment stores source meaning. Any legacy `travelScore` cache must be documented as a derived display cache or deprecated.

Travel never affects Experience qualification. Travel willingness is administrative and excluded from Experience.

### Compensation

The structured compensation assessment copies only explicit source language and preserves base versus OTE/total, currency, period, geographic variants, and variable-pay context. It drives only the Aim minimum-compensation hard stop described above and display. It never contributes positive Aim points or Experience points and never invents undisclosed compensation.

## 10. Reliability and failure semantics

### Local per-job checkpoints

- Each accepted worker artifact is written atomically in a batch-specific local task directory.
- Cache identity includes protocol version, worker/prompt version, stage, full job `inputHash`, and relevant policy/evidence hashes.
- Resume skips only validator-accepted artifacts with an exact cache identity.
- Artifacts from a superseded input may remain for audit but cannot be rebound to a changed input.
- Accepted local artifacts do not create Dashboard state and are not authoritative scores.

### Bounded repair ladder

For each failed semantic artifact:

1. normalize harmless mechanical issues deterministically without changing meaning;
2. run at most one fresh targeted Terra Medium repair with only the affected job, failed output, and exact validator errors;
3. if the remaining issue is genuinely semantic or a suspected omission, run at most one fresh Terra High targeted repair;
4. record a bound per-job safe failure if it still fails, then continue to the next job.

Never rerun an unchanged prompt against an unchanged failure. Each invocation has a bounded timeout, no shell interpolation, and no persistent cross-job context. The initial implementation should use a ten-minute invocation timeout, configurable only through the runner's versioned protocol settings.

### Semantic uncertainty, safe failure, and interruption

- **Aim ambiguity:** use the defined unclear band and fail open. This is a normal evaluated result.
- **Experience evidence silence:** use `cannot_evaluate`. For a hard requirement it blocks the job; for a preferred criterion it earns zero. This is a normal evaluated result.
- **Affirmative conflict:** use `does_not_meet` only with verified conflict evidence.
- **Safe failure:** use only when the source/coverage/result cannot be made structurally trustworthy without guessing or a bounded worker invocation fails. The runner records the failure and continues. Preview proposes no score or lifecycle mutation for that job; approved apply releases its lease back to the stage queue.
- **Technical interruption:** reserved for a process-level failure that prevents the runner from producing complete per-job outcomes. Resume the external runner from accepted local checkpoints.

A healthy mixed run can report “30 submitted, 29 accepted, 1 safe failure.” It produces a complete 30-item result: 29 scores are importable and the failed item is releasable for retry.

## 11. Versioned exchange contracts

Phase 1 creates four authoritative JSON Schema files:

- `data/scoring/schemas/aim-export-v1.schema.json`
- `data/scoring/schemas/aim-result-v1.schema.json`
- `data/scoring/schemas/experience-export-v1.schema.json`
- `data/scoring/schemas/experience-result-v1.schema.json`

All parsers reject unknown keys, unknown enum values, malformed or oversized fields, duplicate IDs, omitted members, extra members, and unknown schema/protocol/policy versions.

### Contract bounds

- Complete request/result payload: at most 32 MiB before parsing.
- Batch items: 1–50.
- Normalized original JD per item: at most 250,000 Unicode code points; cleaned text cannot be longer than its source.
- Top-level criteria per job: at most 128; total atomic leaves: at most 256.
- Removed/retained source spans or evidence bindings per job: at most 1,024 each.
- Criterion text, source quote, evidence quote, and normalized explanation: at most 10,000 code points each.
- Rationale, explanatory claim, safe-failure detail, and repair error: at most 2,000 code points each.
- IDs/version/model/prompt labels: at most 200 printable code points and constrained by schema-specific patterns.
- Raw model logs, chain of thought, arbitrary tool transcripts, and binary attachments are never part of an exchange file.

If a legitimate input exceeds a bound, export or preview fails visibly with a closed code. Nothing is truncated and the bound changes only through a new schema version.

### Canonical encoding and hashes

- Parse against the exact schema, then canonicalize with RFC 8785 JSON Canonicalization Scheme and UTF-8.
- Use lowercase hexadecimal SHA-256.
- Canonical timestamps are UTC RFC 3339 with milliseconds: `YYYY-MM-DDTHH:mm:ss.sssZ`.
- Do not use floating-point values in scoring inputs or outputs. Points and evidence units are integers.
- Before source-text hashing, normalize valid Unicode to NFC, convert CRLF and bare CR to LF, and reject NUL or invalid Unicode; preserve every other character and whitespace. Hash the normalized UTF-8 bytes.
- Source spans use zero-based, half-open Unicode code-point offsets into that normalized text. The exported quote must equal the exact code-point slice. JavaScript must not use raw UTF-16 code-unit offsets for this contract.
- `inputHash` covers the complete per-job semantic input, including relevant policy, source, preference, artifact, resume, and evidence hashes. It excludes volatile display timestamps and batch-specific identity such as batch ID, ordinal, creation time, and expiry so an unchanged semantic worker artifact can be reused after an explicit release and re-export.
- `manifestHash` covers the ordered batch identity, stage, versions, and ordered item IDs/input hashes.
- `resultHash` is the SHA-256 of the canonical result payload with its own `resultHash` field omitted.
- TypeScript and Python must share golden canonicalization and hash fixtures.
- Hashes bind lineage; they do not require byte-identical model rationale.

### Common batch invariants

- Stage is exactly `aim` or `experience`.
- Default export limit is 20; hard maximum is 50.
- Export creation is POST-only because it leases jobs.
- Every job has a stable ordinal, UUID, `submittedUpdatedAt`, source hashes, and complete input snapshot.
- A complete result contains every leased job exactly once in original order.
- Each per-job result is a closed union of `evaluation` or `safe_failure`. A `safe_failure` still echoes the full job/batch binding and a closed failure code, but contains no score or lifecycle proposal. Mixed preview remains applicable: only evaluations are imported, while safe-failure leases are released.
- No truncation may remove a source clause. An over-limit JD is a visible export failure, not a shortened input.
- An Experience batch binds the exact current Aim event and cleaned artifact for each job.
- Exports are self-contained for their stage and do not require database access by the external runner.

### Aim export v1

Required envelope sections:

- `schemaVersion = career-dashboard-aim-export-v1`;
- `batch`: ID, stage, creation/expiry, protocol version, Aim policy version, manifest hash;
- `preferences`: exact versioned Aim policy snapshot hash and trusted employer-override snapshot;
- ordered `jobs`: job identity, ordinal, optimistic timestamp, company/title/location/source URL, complete original JD, canonical source JD hash, metadata hash, and input hash.

Candidate resume and evidence are not Aim inputs and are not exported in the Aim file.

### Aim result v1

Required envelope sections:

- exact batch/version/manifest echoes;
- runner and per-worker provenance, including model identifier, effort, prompt version, timestamps, and invocation receipt;
- one ordered result per job;
- conservative cleaned-JD artifact with source/cleaned hashes, removed spans, coverage audit, and repair history;
- one state for every hard stop with code, `present`/`absent`/`unclear`, rationale, and trusted source binding;
- Aim decision;
- allowed rubric-band decisions and runner preview points;
- structured travel and compensation assessments;
- per-job result hash and full-file result hash.

For a hard stop, rubric points and `aimFitScore` are null. For a survivor, all four bands are present and sum to the runner's preview score.

### Experience export v1

Required envelope sections:

- `schemaVersion = career-dashboard-experience-export-v1`;
- batch identity, stage, creation/expiry, protocol version, Experience policy version, manifest hash;
- canonical resume filename, hash, and extracted text;
- approved structured evidence snapshot, evidence hash, and evidence schema version;
- ordered jobs with identity, ordinal, optimistic timestamp, authoritative Aim event ID/hash, cleaned artifact ID/hash/text, source JD hash, and complete input hash.

The Experience runner does not replace or reclean the artifact.

### Experience result v1

Required envelope sections:

- exact batch/version/manifest/resume/evidence echoes;
- runner and worker provenance;
- one ordered result per job;
- complete source-bound required/preferred criterion trees;
- coverage-audit result and repair history;
- deterministic exclusions;
- exactly one evidence outcome per atomic leaf plus derived top-level outcome;
- structured support and conflict records;
- decision, blocking criteria, and runner preview score;
- per-job and full-file result hashes.

The Dashboard recomputes logical outcomes, the hard gate, preferred denominator, rounding, score, and lifecycle. Any mismatch rejects the whole file.

## 12. Durable data and score authority

Do not add another mutable Aim/Experience queue-status state machine to `Job`. Queue state is derived from immutable score events plus durable batch leases.

### New durable records

Add three records in `prisma/schema.prisma` with a forward-only migration.

**`ScoringBatch`** stores batch ID, stage, status, schema/protocol/policy versions, export and manifest hashes, relevant preference/resume/evidence hashes, exact manifest snapshot, the complete immutable canonical `exportJson` text and byte length, created/expiry/completed/released timestamps, accepted result hash, and items. `exportHash` is the SHA-256 of the stored UTF-8 `exportJson`, so the exact file can be downloaded again even after source policy/evidence/resume files change.

Allowed persisted statuses are `exported`, `completed`, `released`, and `superseded`. `Expired` is derived when an exported batch's `expiresAt` is in the past; it remains leased until Joseph explicitly extends or releases it. There is no `partially_imported` state and no read request silently mutates expiry state.

**`ScoringBatchItem`** stores batch/job/stage/ordinal, item status, submitted timestamp, source JD hash, input hash, exact input snapshot, source Aim event ID, cleaned artifact ID, accepted result hash/snapshot after import, imported score event ID, and timestamps.

Allowed item statuses are `leased`, `imported`, and `released`. On `ScoringBatchItem`, add a PostgreSQL partial unique index on `jobId` where item status is `leased`, enforcing at most one active item lease per job globally. Separately, on `ScoringBatch`, add a PostgreSQL partial unique index on `stage` where batch status is `exported` or `superseded`, enforcing at most one nonterminal batch per stage. One Aim batch and one Experience batch may coexist, but disjoint concurrent batches of the same stage may not.

Supersession is deliberately batch-level: in one transaction set the batch to `superseded` while every unimported item remains `leased`. Those leases continue to block re-export. Explicit release atomically sets every leased item to `released` and the batch to `released`; only then may those jobs enter a new batch. Completed apply is also batch-atomic: evaluated items become `imported`, safe-failure items become `released`, and the batch becomes `completed` with the exact accepted result hash. Failed jobs become exportable only after that approved transaction commits.

**`JobScoringArtifact`** stores immutable cleaned-JD provenance: job ID, kind `cleaned_jd`, schema and cleaner versions, source JD hash, content hash, cleaned text, removed-span classifications, coverage audit, repair history, producing Aim batch item, stale timestamp/reason, and creation time. It never overwrites the source JD.

Use restrictive foreign keys for audit records. Preserve `NativeScoringRequest` and historical migrations in the first release.

### Extend `JobScoreEvent`

Add or normalize fields for:

- `policyVersion`;
- unique `batchItemId`;
- `sourceAimEventId` on Experience events;
- `cleanedJdArtifactId`;
- `decisionCode`;
- structured Aim assessments;
- structured travel and compensation assessments;
- existing mandatory/preferred requirement assessments;
- input/result hashes, complete `inputBindings` fingerprints, lifecycle projection, and worker provenance.

New `evaluationType` values are `aim_fit` and `experience_fit`. Historical combined values such as `standard` and `ae_fit` remain readable.

Aim events own Aim, hard-stop, travel, compensation, and cleaned-artifact projection. Experience events own qualification decision, criteria, evidence outcomes, and qualified-survivor score.

### Stage-aware authority

Replace the single newest-combined-event resolver in `src/lib/scoreAuthority.ts` and `src/lib/jobScoreAuthorityQuery.ts` with independent staged authority:

1. Rank each event family deterministically by `createdAt DESC, id DESC`.
2. If no staged Aim event exists, preserve the current legacy combined-event read behavior.
3. Once a job has any staged Aim event, it remains in staged mode; never resurrect a legacy combined event.
4. The newest Aim event wins even when stale or input-fingerprint-mismatched. An invalid newest Aim suppresses every older Aim and all legacy combined events.
5. Independently select the newest Experience event even when it is stale, mismatched, or invalid. It suppresses every older Experience event; an older apparently valid result can never reappear.
6. Experience is current only when the newest Experience event is itself non-stale and current-fingerprint-matched, its parent Aim is current, non-stale, fingerprint-matched, and passing, its cleaned artifact is current/non-stale, and its `sourceAimEventId` and artifact ID/hash exactly match that parent.
7. A missing, stale, or mismatched Experience event never hides a current Aim result.
8. Travel and compensation project from Aim; criteria and Experience rationale project from Experience.
9. Mutable `Job.aimFitScore`, `reqFitScore`, `travelScore`, and compensation fields may remain transactionally maintained caches, but no read path may treat them as authority.
10. Immutable human lifecycle decisions always outrank imported lifecycle projections.

### Human lifecycle protection

Extend `src/lib/jobLifecycleEvents.ts` so every explicit user status mutation records immutable actor/provenance, not only promote/reject. Protected user actions include explicit moves to Inbox, `passed`, `dismissed`, `bookmarked`, `applied`, `interviewing`, `expired`, `archived`, or `cooldown`, plus `tailoringStaged = true`. Scoring may refresh historical score displays for those jobs, but cannot change their status, clear tailoring state, or move them between lifecycle lanes. A user explicitly returning a job to `pending_af`/rescore or removing the protected tailoring state creates the corresponding release event.

Before cutover, generate a read-only migration report for preexisting jobs in protected-looking states. Backfill immutable user provenance only where current route data, reasons, or history establish it. Treat ambiguous applied/interviewing/bookmarked/tailoring/archived/expired/cooldown rows as protected by default until Joseph reviews or explicitly releases them; never assume they are machine-owned merely because the old event helper failed to record them.

### Derived user-facing state

| State | Durable condition |
|---|---|
| Aim Ready | eligible job, no current staged Aim, no active batch lease, no protected user lifecycle/tailoring action |
| Aim Exported | active Aim `ScoringBatchItem` lease |
| Experience Ready | current passing Aim and cleaned artifact, no matching current Experience, no active lease |
| Experience Exported | active Experience batch-item lease |
| Action Needed | durable batch expiry/supersession, source invalidity, or lifecycle/provenance conflict; a zero-write preview failure is shown only in that preview session or re-derived on demand |
| Aim Dismissed | current Aim event is a hard-stop rejection and no protected user action overrides it |
| Experience Dismissed | current Experience event fails a hard requirement and no protected user action overrides it |
| Inbox | current Experience event is qualified and no protected user action overrides it |
| Replay Needed | newest required event or artifact is stale |
| Human Protected | immutable user status/tailoring event; imports cannot change lifecycle until the user explicitly releases or requeues it |

### Central invalidation rules

Implement job-local mutation handling in `src/lib/scoreInvalidation.ts` and global/version handling in a new `src/lib/scoringInputVersions.ts`.

| Change | Aim | Cleaned artifact | Experience | Active batch |
|---|---|---|---|---|
| title, company, location, source URL, or JD changes | stale | stale | stale | whole batch superseded; no silent release |
| new scrape or batch JD replacement with changed canonical input | stale | stale | stale | whole batch superseded |
| Aim policy, preference, or employer override changes | stale | remains source-current unless cleaner policy changed | stale by parent-Aim mismatch | whole batch superseded |
| cleaner or coverage policy changes | stale | stale | stale | whole batch superseded |
| evidence inventory changes | unchanged | unchanged | stale | Experience batch superseded |
| canonical resume changes | unchanged | unchanged | stale | Experience batch superseded |
| Experience requirement/evidence policy changes | unchanged | unchanged | stale | Experience batch superseded |
| protected user status/tailoring action | scores remain historical | unchanged | unchanged | whole batch superseded; lifecycle protected |
| explicit full rescore | stale | stale | stale | whole batch superseded |

If a batch becomes superseded, none of it may import. It remains visible until Joseph explicitly releases it. A new export can reuse locally cached results only for unchanged item input hashes.

Every score event/batch stores the relevant policy, preference, employer-override, cleaner, resume, evidence, and schema fingerprints. Every authority read compares those bindings with the current fingerprints and derives `Replay Needed` immediately on mismatch, even if `staleAt` has not yet been persisted. A mandatory `scripts/reconcile_scoring_input_versions.ts` runs during deployment/readiness and before export, preview, or apply; it transactionally persists `staleAt`/reason, marks affected active batches `superseded` while retaining item leases, and projects machine-owned lifecycle back to an active queue. Preference-write routes call the same reconciler. This dual derived-plus-persisted design prevents a missed file watcher or process restart from treating old scores as current.

When a machine-owned current Aim or Experience projection becomes stale, the same transaction resets `Job.status` to `pending_af` only if the current status still equals the machine event's recorded lifecycle projection and no later protected user event/tailoring state exists. The derived staged authority then determines Aim Ready versus Experience Ready. If status/provenance does not match exactly, do not guess; surface Action Needed. This prevents a machine-dismissed job from remaining stranded while preserving every human-owned state.

Before enabling v1, produce a recovery dry run for all non-human-final jobs affected by removed staffing, entry-level, RevOps/enablement, retail overbreadth, direct-AT&T-title, Prompt Health, or other legacy bypass/rejection rules. Report exact IDs, current reason/status, and proposed staged lane. Apply no recovery without Joseph's explicit approval; an approved recovery invalidates legacy machine authority and places the exact jobs into Aim Ready rather than Inbox.

## 13. Import protocol and API

### API surface

Repurpose and add:

- `POST /api/scoring/export` with `{ "stage": "aim" | "experience", "limit": 1..50 }`;
- `POST /api/scoring/import` with `{ "mode": "preview", "payload": ... }`;
- `POST /api/scoring/import` with `{ "mode": "apply", "payload": ..., "approvalToken": "..." }`;
- `GET /api/scoring/batches?stage=aim|experience`;
- `GET /api/scoring/batches/[id]/download` to return the exact stored `exportJson` and `exportHash` without changing state;
- `POST /api/scoring/batches/[id]/extend`;
- `POST /api/scoring/batches/[id]/release`.

GET export remains non-mutating and unsupported. Do not add a login screen.

If a nonterminal batch already exists for the requested stage, POST export creates no leases and returns a conflict containing the existing batch ID and exact-download URL. A failed browser download is recovered through that URL; Joseph does not release and recreate a batch merely because the HTTP response was lost.

The current `src/lib/apiAuth.ts` returns an unconditional development opt-out before its old same-origin branch, so implementation must not describe that branch as active protection. Add a no-login scoring mutation guard, either as a repaired shared primitive or `src/lib/scoringRequestSecurity.ts`, that rejects a missing/mismatched `Origin` against the trusted request/forwarded host, rejects cross-site `Sec-Fetch-Site`, requires the expected content type, and enforces the 32 MiB body ceiling before parsing. Cover the actual Pi reverse-proxy headers in tests. This guard applies to export, preview, apply, extend, and release without restoring Basic auth or a login screen.

### Preview

Preview performs zero database writes. It first has a completed-batch replay branch: after schema/batch/result-hash validation, an exact result hash already stored on a completed batch returns its original idempotent receipt with no token and no writes; a divergent hash is rejected. Otherwise it:

1. parses exact keys and bounded types;
2. verifies known versions;
3. requires one active non-expired, non-superseded batch;
4. requires every leased job exactly once in original order;
5. rejects duplicate, omitted, extra, cross-batch, or partially supplied jobs;
6. recomputes manifest, source, artifact, resume, evidence, preference, input, and result hashes;
7. rejects any job changed after export;
8. validates source spans, criterion coverage, evidence IDs, support/conflict semantics, and administrative exclusions;
9. independently recomputes every component, decision, score, and lifecycle projection;
10. verifies no protected user lifecycle or tailoring action can be overwritten;
11. reports hard stops, hard-requirement blockers, `cannot_evaluate`, affirmative conflicts, score ranges, and proposed lifecycle changes;
12. marks schema, binding, recomputation, or membership errors as non-applicable; represents a valid per-job safe failure as a lease-release projection while leaving successful projections applicable.

On a clean preview, the server returns a 15-minute HMAC approval token binding the stage, batch ID, complete result hash, expected item IDs, proposed transitions, policy versions, and expiry. Add a dedicated `SCORING_APPROVAL_SECRET` deployment setting containing at least 32 random bytes; fail preview/apply closed when it is missing outside tests. The secret never appears in the browser, logs, export, result, or repository. This is payload/preview binding, not a login mechanism.

### Apply

Apply requires the exact payload and token from preview. Under row locks it repeats every validation, then in one Prisma transaction:

1. creates immutable cleaned artifacts and Aim events or Experience events;
2. records exact accepted result snapshots and provenance;
3. transactionally refreshes non-authoritative `Job` caches;
4. applies lifecycle changes only when no protected user action outranks them;
5. marks evaluated batch items imported and safe-failure items released without changing their jobs;
6. marks the batch completed;
7. clears only that completed batch's leases, making released failures eligible for a later export.

Any error writes nothing. The active batch remains available for inspection, retry of the exact file, extension, exact re-download, or explicit release. A completed-batch request with the accepted `resultHash` follows the separate idempotent receipt branch above; a different result for an imported batch is rejected.

Import never rewrites ContextProfile, evidence, preferences, employer overrides, source JDs, or the canonical resume.

## 14. Dashboard experience

Replace native-run controls with a `ScoringExchangePanel` and `ScoringImportPreview`.

### Aim Fit view

- ready, exported, expired/superseded, and current-result counts;
- active batch ID, age, member count, and expiry;
- Export Aim Batch, Import Aim Results, Extend, and Release controls;
- a clear `Calibration — numeric score is not gating` badge;
- hard-stop reason separate from numeric distribution;
- four Aim component bands, source rationale, and explicit travel/compensation display.

### Experience Fit view

- ready, exported, expired/superseded, and current-result counts;
- active batch details and manual exchange controls;
- each required/preferred criterion, source quote, outcome, evidence IDs, and rationale;
- hard-gate decision separate from 80–100 qualified ranking;
- current Aim visible while Experience is pending;
- provenance links to Aim event, cleaned artifact, Experience event, policies, and hashes.

### Preview modal

- exact batch identity and versions;
- expected/supplied/accepted/rejected counts, which must be exact-membership or non-applicable;
- stale/changed/cross-batch findings;
- safe failures;
- pass/fail counts and score distributions;
- `cannot_evaluate` versus `does_not_meet` counts;
- proposed job transitions;
- explicit confirmation that no protected user lifecycle/tailoring action will be overwritten;
- separate **Approve and Apply Entire Batch** action.

Remove Score Pending Jobs, Retry Native Scoring, native heartbeat, wave/chunk progress, and background-scoring status from the production UI.

## 15. Evidence-gap register

After a successful Experience import, regenerate the active register from the latest authoritative current Experience event for every job.

- Generated local artifact: `docs/CANDIDATE_EVIDENCE_GAPS.md`, exact path ignored by Git.
- Tracked manual annotations: `data/candidate_evidence_gap_annotations.json`, with versioned schema and explicit empty initial entry map.
- Source of truth: current accepted Experience assessments, not append-only Markdown.
- Include qualification-relevant `cannot_evaluate` criteria that could be resolved through additional experience documentation.
- Exclude administrative eligibility, travel, compensation, `does_not_meet` conflicts, and missing strict role-defining credentials under resolved Decision D1. Credential findings remain fully visible in the job assessment and dismissal rationale but do not become recurring evidence-gap questions.
- Deterministically deduplicate by a bounded normalized concept key while preserving every original criterion and job provenance.
- Statuses: `Open`, `Answered`, `Inventory Updated`, and `Not Applicable`.
- Include occurrence counts, first/latest dates, company/title/job ID/source URL, exact criterion wording, model/prompt/policy/evidence hashes, and score-event ID.
- The report is not evidence authority and cannot modify the inventory.
- Regeneration reads but never modifies `data/candidate_evidence_gap_annotations.json`; manual annotations survive every refresh byte-for-byte unless Joseph explicitly edits them through a separate validated workflow.
- A gap leaves the active list only when the newest authoritative current Experience rescore no longer yields `cannot_evaluate`, or a surviving manual annotation marks that concept `Not Applicable`. An `Answered` or `Inventory Updated` label alone cannot fabricate resolution without the corresponding authoritative rescore.
- Refresh runs after the score transaction commits. A refresh failure is visible and retryable; it does not roll back committed scores.
- Provide one standalone deterministic regenerate-and-validate command.

## 16. External runners and personal skill

### Repository-owned, database-free tooling

Add:

- `scripts/run_aim_scoring.py`;
- `scripts/run_experience_scoring.py`;
- `scripts/scoring_protocol/common.py`;
- `scripts/scoring_protocol/contracts.py`;
- `scripts/scoring_protocol/codex_worker.py`;
- versioned worker prompts for JD cleaner, JD coverage auditor, Aim evaluator, requirement extractor, requirement coverage auditor, evidence evaluator, and targeted repair;
- Python unit tests and shared TypeScript/Python fixtures.

The two entrypoints stay separate. Shared code is deterministic plumbing, not a combined orchestrator.

Runner requirements:

- no database or Dashboard network access;
- no automatic upload/import;
- exactly one job per worker invocation;
- `subprocess.run([...], shell=False)` or an equally non-interpolating API;
- a worker sandbox with no tool, shell, browser, arbitrary network, or filesystem capability outside the batch task directory. The outer Codex CLI may use only its required authenticated model-service transport; that transport does not grant the semantic worker a web/network tool. Bind this requirement to guarantees actually supported by the installed CLI and stop if they cannot be enforced;
- bounded invocation timeout and repair count;
- exact structured output;
- atomic per-job accepted-artifact writes;
- cache/resume by full versioned `inputHash`;
- targeted validator errors sent only to the affected repair worker;
- hostile JD instructions treated as inert data;
- Python preview arithmetic verified against shared policy JSON;
- complete final result only after every member validates.

At implementation time, inspect the installed CLI help and the official [Codex non-interactive mode documentation](https://learn.chatgpt.com/docs/developer-commands?surface=cli) before fixing command flags. Use stable structured-output and sandbox options supported by the installed version; do not infer flags from an old plan.

### Thin personal skill

Create or update:

`/Users/JosephLamb/.codex/skills/career-dashboard-scoring-protocol/`

with `SKILL.md`, `agents/openai.yaml`, and only the references/scripts needed to launch the repository-owned runner. Follow the official [Codex Skills documentation](https://learn.chatgpt.com/docs/build-skills) at implementation time.

The skill:

1. accepts exactly one explicit Aim or Experience export, or a uniquely identifiable latest unprocessed export;
2. validates the file before model work;
3. dispatches the correct one-stage runner;
4. resumes an exact matching local task when present;
5. writes the complete result to an obvious Finder-visible location;
6. reports stage, batch ID, submitted/accepted/repaired/interrupted counts, validator status, and exact output path.

The skill does not chain stages, access the database, import results, start a Dashboard request, edit evidence, commit, push, or deploy. Terra Medium is the default intention; Terra High is used only for the bounded targeted escalation. Record actual model and effort. Never silently fall back.

## 17. Native Agy retirement

### Safety snapshot to revalidate

At planning time:

- `/Users/JosephLamb/Library/LaunchAgents/com.josephlamb.career-dashboard-native-scoring.plist` exists;
- the launchd service is unloaded and explicitly disabled;
- `.agents/scoring-lock.json` is absent;
- scoring-specific Agy grants remain in `/Users/JosephLamb/.gemini/antigravity-cli/settings.json`.

This is a point-in-time read-only observation, not a durable guarantee. Phase 0 must revalidate it before any cutover. Until the manual workflow is proven, do not start, retry, resume, monitor, load, enable, or use native Agy scoring as fallback.

### Repository changes required in the first release

1. Rewrite the scoring section of `.agents/AGENTS.md`; it currently mandates native-only Agy and says browser JSON exchange is retired. The new instruction must point to this plan and prohibit native reactivation.
2. Remove automatic request creation and related polling from `src/app/api/pipeline/run/route.ts`.
3. Remove/retire the `native-ae-request` ingestion task in `src/lib/ingestionTaskCatalog.ts` while preserving telemetry.
4. Permanently retire native mutation behavior in:
   - `src/app/api/scoring/requests/route.ts`;
   - `src/app/api/scoring/requests/[id]/retry/route.ts`;
   - `src/app/api/scoring/requests/[id]/cancel/route.ts`;
   - `src/app/api/pipeline/context/route.ts`;
   - `src/app/api/pipeline/deepseek/route.ts`.
5. Replace obsolete compatibility behavior/messages in:
   - `src/app/api/jobs/export-ai/route.ts`;
   - `src/app/api/jobs/import-ai/route.ts` if present;
   - `src/app/api/jobs/retry/route.ts`;
   - `src/app/api/scoring/requeue-local/route.ts` if present.
6. Remove native polling/actions/metrics from `src/components/ScoringLogTab.tsx`, `src/components/StatsTab.tsx`, and `src/app/api/stats/route.ts`.
7. Apply the explicit package/script disposition ledger below after neutral validation logic has moved.
8. Remove `AGY_BIN` and `AGY_PROJECT_ID` from `.env.example` when no non-scoring feature requires them.
9. Remove native-request readiness as a production-health requirement in `src/app/api/health/route.ts`.
10. Replace native-request/`afBatchId` quiescence checks in `scripts/deploy.sh` and native readiness in `scripts/audit_repair_readiness.ts` with manual-batch/lease checks.
11. Update `README.md`, `docs/CAREER_DASHBOARD_REPAIR_RUNBOOK_2026-08-09.md`, deployment tests, and every active runbook so no instruction can reinstall or launch the watcher.
12. Remove the `native-scoring-v6-boundary` entry from `.agents/hooks.json` and remove `scripts/antigravity_scoring_hook.mjs`; the current hook executes on tool use and actively enforces the superseded V6 boundary.
13. After harvesting approved fixtures/guardrails, remove the four registered V6 scoring agent directories from `.agents/agents/`: `native-scoring-runner-v6`, `scoring-manager-v6`, `context-job-evaluator-v6`, and `standard-job-evaluator-v6`. Preserve needed content in versioned neutral policy/prompts/tests first; Git history is the archive.
14. Run a repository-wide reachability audit for native/Agy/request/watcher/legacy-score-mutator references and classify every result as removed production path, retained historical migration/data path, or demonstrably unreachable historical code.

Retired mutation routes should return a stable permanent-retirement response such as HTTP 410 and never create, resume, retry, or cancel scoring work.

### Package and legacy-script disposition ledger

Every current `package.json` scoring command receives an explicit first-release disposition:

- **Remove native request/runner exposure:** `scoring:request`, `scoring:next`, `scoring:prepare-phase`, `scoring:quarantine`, `scoring:context:validate`, `scoring:context:import`, `scoring:watch`, `scoring:watch:once`, `scoring:watch:install:check`, `scoring:watch:install`, and `scoring:canary`.
- **Remove legacy database mutation exposure:** `scoring:import`, `scoring:release`, `scoring:repair-authority`, `scoring:repair-queues`, `scoring:recover-local`, `scoring:recover-local:apply`, `scoring:contract:apply`, `rescore:recent`, and `rescore:recent:apply`. Dashboard-approved staged import/release is the only replacement for database-changing score commands.
- **Replace rather than retain:** replace legacy `scoring:validate` with a DB-free `scoring:exchange:validate`; replace `scoring:status` with a read-only manual-batch audit; rewrite `scoring:audit` for staged authority; port `evidence-gaps:refresh` to the new register; and rewrite `audit:repair-readiness` for manual batches/native unreachability.
- **Reclassify non-runtime migrations:** `scoring:context:migrate-typed` and `scoring:contract:check` may remain only under non-scoring historical/migration names after an audit proves they cannot score, import, release, or alter staged authority. Otherwise remove their package exposure.
- **Update pipeline commands:** `ingestion:seed-tasks` must retire `native-ae-request`; `cron:pipeline` must contain no native auto-request path.

Remove or permanently fail-closed the underlying dangerous entrypoints in the same cutover, including `scripts/create_native_scoring_request.ts`, `scripts/native_scoring_next.ts`, `scripts/prepare_native_scoring_phase.ts`, `scripts/native_scoring_watcher.ts`, `scripts/install_native_scoring_watcher.ts`, `scripts/direct_import.ts`, `scripts/import_native_context.ts`, `scripts/release_scoring_batch.ts`, `scripts/prepare_scoring_authority_repair.ts`, `scripts/repair_scoring_queue_orphans.ts`, `scripts/recover_recent_local_rejects.ts`, and `scripts/rescore.ts`. Explicitly audit/classify `scripts/scoring_run_status.ts`, `scripts/quarantine_scoring_result.ts`, `scripts/audit_scoring_calibration.ts`, `scripts/backfill_score_events.ts` if present, `scripts/queue_sellsig_cs_recovery.ts`, and `scripts/contract_wildcard_schema.ts`; no old standard/`ae_fit` repair or backfill may mutate staged authority.

### Dead code retained only through canary

The following may remain temporarily unreachable to preserve history and ease diff reconciliation:

- `NativeScoringRequest` table and migrations;
- `src/lib/nativeScoringRequest.ts`;
- `src/lib/nativeScoringAutoRequest.ts`;
- `src/lib/nativeScoringBatch.ts`;
- `src/lib/nativeScoringLease.ts`;
- `src/lib/nativeScoringPacket.ts`;
- `src/lib/nativeScoringPromptBinding.ts`;
- native-only test fixtures that cannot create work or mutate data.

After a successful manual canary and production verification, remove dead files and native-only tests in a separate cleanup change. Preserve historical database rows unless Joseph separately approves data destruction.

### Mac-level cutover actions

Unloading/removing the LaunchAgent plist and revoking scoring-specific Agy permissions are external mutations. They require Joseph's explicit cutover authorization and must not occur silently inside a deployment script. The cutover checklist must resolve the exact plist/service/grant targets read-only, preserve any logs Joseph wants, remove only those targets, and verify the service cannot load. Rollback disables the manual exchange; it never restores these Agy paths.

## 18. Current dirty-work classification

The worktree contained the following uncommitted user work during consolidation. This is a snapshot, not a license to reset it. Recheck live status before implementation and preserve unrelated changes.

| Path | Planned treatment |
|---|---|
| `.agents/agents/context-job-evaluator-v6/agent.md` | harvest relevant preference/context safety language, then retire from active scoring |
| `.agents/agents/standard-job-evaluator-v6/agent.md` | harvest evidence semantics and useful evaluator fixtures, then retire from active scoring |
| `scripts/native_scoring_canary.ts` | migrate useful gold/canary fixtures; retire native execution |
| `scripts/prepare_native_scoring_phase.ts` | migrate neutral hashing/binding/lease validation where correct; supersede native orchestration |
| `src/lib/__tests__/candidateEvidenceGaps.test.ts` | preserve user changes and adapt to staged Experience authority |
| `src/lib/__tests__/nativeScoringBatch.test.ts` | harvest neutral contract/source/evidence cases; replace native runner coupling |
| `src/lib/__tests__/nativeScoringPacket.test.ts` | preserve contamination and source-retention fixtures in neutral tests |
| `src/lib/__tests__/nativeScoringProfile.test.ts` | preserve canonical-resume/evidence binding cases in neutral tests |
| `src/lib/mandatoryRequirements.ts` | supersede invented/fallback hard-requirement behavior; retain only verified source/logical helpers |
| `src/lib/nativeScoringBatch.ts` | migrate neutral validators deliberately, then retire native state-machine coupling |
| `src/lib/nativeScoringPacket.ts` | migrate source sanitization/contamination protections only where compatible with semantic conservative cleaning |

Do not use `git reset`, broad checkout, or mass deletion to reconcile these files. Inspect each diff and stage only the eventual implementation scope.

## 19. File-by-file implementation sequence

### Phase 0 — decision, safety, and repository freeze

1. Verify that resolved Decision D1 is encoded consistently as a strict dismissal gate and evidence-gap exclusion; do not reopen the verification-only alternative during implementation.
2. Recheck `AGENTS.md`, worktree status/diff, branch/upstream, database target, canonical resume designation/hash, evidence snapshot, running processes, native requests/leases, LaunchAgent state, and Agy grants read-only.
3. Classify every dirty file as port, preserve, supersede, or later-retire; do not edit until its disposition is recorded.
4. Read the relevant Next.js guides under `node_modules/next/dist/docs/` before changing routes, server APIs, or components.
5. Snapshot gold fixture source inputs. Do not score or mutate production data.
6. Stop if native scoring is active, source authority is ambiguous, or the canonical resume binding fails.

### Phase 1 — policy and contracts first

Add:

- `data/scoring/aim-policy-v1.json`;
- `data/scoring/aim-employer-overrides-v1.json`;
- `data/scoring/experience-policy-v1.json`;
- the four versioned schemas under `data/scoring/schemas/`;
- `src/lib/scoringCanonicalJson.ts`;
- `src/lib/scoringExchange.ts`;
- `src/lib/scoringCriteria.ts`;
- `src/lib/scoringEvidence.ts`;
- `src/lib/scoringInputBinding.ts`;
- shared fixtures under `tests/fixtures/scoring/`.

Change `src/lib/scoringPolicy.ts`. Port only compatible neutral logic from native modules. Add TypeScript tests for policy, criteria trees, canonical JSON, hashes, schemas, evidence semantics, and hard-stop codes before route work.

Update `.agents/AGENTS.md` in this phase so no subsequent task follows the superseded native mandate.

### Phase 2 — database and readiness audit

Change `prisma/schema.prisma` and add one forward-only migration for the three new records, immutable export/result payload fields, event lineage/input-binding/lifecycle-projection fields, CHECK constraints, foreign keys, indexes, the `ScoringBatchItem(jobId) WHERE status = 'leased'` partial unique index, and the `ScoringBatch(stage) WHERE status IN ('exported', 'superseded')` partial unique index.

Add `scripts/audit_manual_scoring_readiness.ts` to detect:

- duplicate leases;
- batch/item stage or membership mismatch;
- imported item without a matching event;
- Experience event bound to the wrong Aim event/artifact;
- stale current artifacts or events;
- completed batch with leased items;
- unresolved `manual_export_`, `afBatchId`, or native leases before cutover;
- an active native request or reachable automatic trigger;
- current score events/batches whose stored global input fingerprints differ from the live policy/preference/override/resume/evidence/schema fingerprints;
- protected-looking preexisting lifecycle states without immutable user provenance.

Do not backfill a second queue state table. Do not drop native tables.

### Phase 3 — batch, artifact, approval, and import services

Add:

- `src/lib/scoringBatch.ts`;
- `src/lib/scoringArtifact.ts`;
- `src/lib/scoringImport.ts`;
- `src/lib/scoringApproval.ts`.

Cover row-locked selection, exact batch creation, persisted canonical export/re-download, one-open-batch-per-stage cardinality, whole-batch expiry/extension/release/supersession with retained leases, immutable cleaned artifacts, exact parsers, preview projection, HMAC approval binding, independent recomputation, completed-result idempotent receipt, one-transaction apply, and forced rollback tests.

### Phase 4 — staged authority and invalidation

Change:

- `src/lib/scoreAuthority.ts`;
- `src/lib/jobScoreAuthorityQuery.ts`;
- `src/lib/scoreInvalidation.ts`;
- `src/lib/scoringInputVersions.ts`;
- `src/lib/jobScoring.ts`;
- `src/lib/jobFiltering.ts`;
- `src/lib/priorityOpportunity.ts`;
- `src/lib/cooldownRecovery.ts`;
- `src/lib/jobIngestion.ts`;
- `src/lib/jobLifecycleEvents.ts`;
- `src/lib/candidateEvidenceGaps.ts`;
- `src/lib/jobListQuery.ts`;
- `src/types/job.ts`;
- `src/components/Dashboard.tsx`;
- `src/components/JobCard.tsx`;
- `src/components/ExpandOverlay.tsx`;
- job list/detail/search/scrape/batch-JD/preference routes that read, filter, route, protect, or invalidate scores.

Test current Aim with pending/stale Experience, deterministic newest-stale suppression in both stages, mismatched parents, staged-versus-legacy precedence, source edits during a batch, global file/preference fingerprint mismatch, evidence-only invalidation, machine-dismissal requeue, every protected user lifecycle state, dual-stage card/detail projection, and removal of Prompt Health/staffing/entry-level/RevOps bypasses. Generate the one-time legacy-rule recovery report; no recovery apply is implicit.

### Phase 5 — Aim exchange

Implement Aim export, exact re-download, result preview/apply, cleaned-artifact persistence, hard-stop and rubric recomputation, Aim queue derivation, and Aim UI across `Dashboard.tsx`, `ScoringLogTab.tsx`, `JobCard.tsx`, and `ExpandOverlay.tsx`. Numeric Aim remains ungated. A hard stop is stored with null score and explicit reason.

### Phase 6 — Experience exchange and gap register

Implement Experience export bound to current Aim/artifact, exact re-download, result preview/apply, criterion/evidence validators, strict hard gate, deterministic preferred rounding, Experience queue/UI across the same consumers, and evidence-gap regeneration plus tracked annotations.

### Phase 7 — external runners and skill

Build and test the two Python entrypoints, shared deterministic plumbing, isolated prompts, local checkpoint format, targeted repairs, full-batch result assembly, and the thin external personal skill. Verify current CLI flags and skill structure against installed help and official documentation.

The runner and skill must pass tests without any database connection and must never import.

### Phase 8 — native cutover in the same release

Remove every normal product trigger, auto-request path, watcher/package installer, health/deploy expectation, active runbook instruction, and UI control described in Section 17. Preserve historical data and optionally retain unreachable dead code until canary cleanup.

The manual exchange must not be production-enabled while a native auto-creation path remains reachable.

### Phase 9 — verification and reviewed canary

Run all gates in Section 20. First run fixtures and a no-import Aim preview. Then use the only valid 10-job canary order: Aim export/run/preview → Joseph's explicit Aim approval/apply → Experience export/run/preview for Aim survivors → Joseph's separate explicit Experience approval/apply. Record calibration observations without changing policy v1 mid-batch.

### Phase 10 — deployment and deferred cleanup

Only after local verification and separate deployment authority:

- complete repository hygiene;
- update operational docs;
- commit only intended scope;
- push/deploy only under repository authorization;
- verify production routes, queues, preview/apply, health, and native unreachability;
- later remove unreachable native code/tests in a separate reviewed cleanup;
- never drop historical tables/data without a separate destructive-data decision.

## 20. Required verification

### Deterministic and cross-language

- TypeScript and Python canonical JSON/hash parity;
- all Aim band combinations and score sums;
- hard stop before numeric score;
- Experience `all`/`any`/equivalence outcome derivation;
- integer preferred rounding, including tie cases and uneven denominators;
- no hard requirements = qualified 80;
- no preferred requirements = qualified 80;
- required unknown distinct from affirmative conflict;
- administrative exclusions absent from denominators and gap register;
- structured travel range versus Aim travel points never conflated;
- explicit compensation only.

### Contract and transaction safety

- malformed, extra-key, oversized, duplicate, omitted, extra, reordered, stale, and cross-batch files;
- unknown schema/protocol/policy version;
- mismatched source, artifact, resume, evidence, preference, input, manifest, and result hashes;
- criterion quote/offset mismatch;
- invalid evidence ID or unsupported support/conflict claim;
- result preview score/decision mismatch;
- a mixed batch imports only evaluated items and releases safe-failure items in the same atomic transaction;
- preview proves zero writes;
- apply token binds exact payload and expires;
- apply repeats validation under row locks;
- forced mid-transaction error produces zero writes;
- exact successful replay is idempotent and divergent replay is rejected;
- failed initial download can re-download byte-identical stored export content/hash without changing leases;
- one nonterminal batch per stage and one active item lease per job are enforced under concurrency;
- supersession retains every item lease until one explicit whole-batch release;
- every protected user lifecycle/tailoring action cannot be overwritten;
- expiry and supersession never silently release;
- partial result files are always rejected.

### Cleaner and prompt-injection safety

- benefits/legal/site debris removed without losing duties or qualifications;
- borderline text retained;
- coverage auditor catches a seeded substantive omission;
- repair restores source text without paraphrase;
- hostile JD commands, URLs, tool requests, output-format instructions, and fake system messages remain inert;
- one job cannot contaminate another worker context.

### Authority, queue, and UI

- current Aim is visible while Experience is pending;
- stale Experience does not hide Aim;
- stale newest Aim does not resurrect an older event;
- stale or parent-mismatched newest Experience suppresses every older Experience event;
- legacy combined events remain readable until staged Aim begins;
- source, policy, evidence, and resume invalidation follow the matrix;
- live fingerprint mismatch derives stale immediately and the reconciler persists it before mutation;
- a stale machine dismissal returns to the correct active lane, while applied/interviewing/bookmarked/tailoring and every other protected user action remains untouched;
- Prompt Health and every named company traverse the same stages; staffing, entry-level, RevOps/enablement, and retail-channel roles follow the v1 rules rather than legacy bypasses/denylists;
- batch counts and derived queue state reconcile;
- preview modal clearly separates decisions from scores;
- rendered desktop and narrow-layout inspection for both stage panels and preview;
- Stats reports Aim hard stops/component distributions, Experience hard failures, qualified 80–100 scores, open batch age, and evidence gaps without native metrics.
- evidence-gap regeneration leaves manual annotations byte-identical and removes an active gap only after authoritative resolution or `Not Applicable`.

### Native retirement

- native request/retry/cancel/context/deepseek routes cannot create work;
- pipeline cannot create native requests;
- UI has no native control or polling;
- package scripts cannot install/start the watcher;
- `.agents/hooks.json` cannot invoke the retired V6 boundary and the four V6 scoring agent directories are no longer registered/active;
- no exposed legacy release/import/repair/recovery/backfill command can mutate native or staged score authority;
- health and deploy audits do not require native readiness;
- active repository instructions do not direct an agent to native Agy;
- repository-wide reachability audit has no unexplained production path;
- LaunchAgent/Agy-grant state is rechecked, and any approved removal is separately verified;
- rollback documentation never instructs Agy reactivation.

### Final local gates

- focused unit suites;
- full TypeScript test suite;
- Python unit suite;
- lint/typecheck;
- Prisma validation and migration test;
- production build;
- readiness audit;
- 10-job no-import calibration preview;
- Joseph review of representative hard stops, unclear Aim bands, required `cannot_evaluate`, affirmative conflict, functional equivalence, and preferred-score arithmetic;
- explicit approval before either canary import and before deployment.

## 21. No-go conditions

Stop implementation or cutover when any of the following is true:

- resolved Decision D1 is absent, softened, or represented as anything other than a strict hard-requirement dismissal gate with truthful `cannot_evaluate`/`does_not_meet` semantics;
- the canonical resume is missing or its hash differs from the designated canonical bytes;
- the approved evidence snapshot or its schema is unavailable;
- a dirty user diff cannot be classified without risking unrelated work;
- native scoring, its watcher, or an automatic request path is active or cannot be shown unreachable;
- contract schemas, canonical hashes, or Python/TypeScript arithmetic disagree;
- exact membership, zero-write preview, atomic rollback, or protected-user-action enforcement fails;
- a stage result has a technical omission, changed job, stale binding, or a safe failure that is projected as anything other than an unchanged job plus released lease;
- the Aim evaluator applies a non-versioned hard stop or numeric gate;
- Experience collapses unknown into affirmative failure, invents a hard requirement, or uses preferred criteria to rescue a hard failure;
- any upstream filter, named-company shortcut, local heuristic, cooldown recovery, or legacy status can bypass Aim/Experience or strand a stale machine dismissal;
- current global input fingerprints cannot be reconciled against the bindings on events and batches;
- a Dashboard route or external runner crosses its ownership boundary;
- Joseph has not approved the dry run being applied;
- deployment authority has not been given.

## 22. Rollback

Rollback is operationally simple and does not revive Agy:

1. disable manual export/apply controls while leaving historical events and artifacts readable;
2. stop creating new manual batches;
3. leave active batches blocked until Joseph explicitly releases them;
4. revert read projections to the last known safe application version without deleting staged events;
5. investigate contract/authority defects offline;
6. repair and redeploy the manual workflow under a new version if required.

Never restore a watcher, native request button, automatic pipeline request, or Agy permission as rollback.

## 23. Definition of done

The implementation is complete only when:

- this document remains the sole scoring design authority and all active repository instructions/runbooks reflect it;
- resolved Decision D1 is recorded in versioned policy and tests, including dismissal on an unrecorded explicitly required credential and exclusion from the active evidence-gap register;
- Aim and Experience have separate exports, runners, previews, approvals, imports, events, authority, queues, and UI;
- the Dashboard performs no model calls and the external tooling performs no database writes or imports;
- local per-job resume works without enabling partial Dashboard import;
- conservative cleaning is source-preserving and coverage-audited;
- all hard stops, bands, evidence outcomes, logical criteria, administrative exclusions, and deterministic formulas match this plan;
- numeric Aim is ungated and Experience scoring exists only for qualified survivors;
- Travel contributes to Aim while retaining separate explicit-source display;
- exact membership, canonical binding, side-effect-free preview, explicit approval, atomic apply, idempotency, and protected-user-action enforcement are proven;
- stage-aware authority and invalidation are proven across all consumers;
- global input-version reconciliation, machine-lifecycle requeue, protected user provenance, and legacy-rule recovery are proven;
- the evidence-gap register is deterministic, generated, non-authoritative, and annotation-safe;
- native Agy is unreachable through product, pipeline, package, deployment, health, instruction, and UI paths;
- historical data is preserved and rollback does not reactivate Agy;
- a reviewed 10-job canary passes both stages with Joseph-approved dry runs;
- tests, migration validation, production build, rendered UI QA, readiness audit, documentation, and production verification pass;
- commit, push, and deployment occur only under separate authorization.

All scoring-policy decisions needed for implementation are now resolved. This plan is sufficient to begin implementation after Joseph explicitly authorizes implementation; it is not itself that authorization.

## 24. Aim question-only worker amendment — 2026-08-12

This section supersedes earlier Aim-specific language in this plan that assigns
span arithmetic, score arithmetic, thresholds, source-offset construction, final
decisions, or proof-of-absence work to a model. It does not change the Experience
stage.

- Python segments the source JD into stable, source-ordered block IDs and remains
  the sole owner of exact source offsets, reconstruction, hashes, policy lookup,
  thresholds, points, totals, hard-stop decisions, and final exchange formatting.
- The cleaner receives one JD as a list of those blocks and may only identify
  removable boilerplate block IDs with a classification. It never rewrites the
  JD and never calculates spans.
- The optional coverage reviewer receives only proposed removals and may only
  return block IDs that must be restored. Cleaner or reviewer failure retains or
  restores the source text and is not a scoring failure.
- The Aim evaluator receives exactly one retained-JD packet. It answers closed
  factual and fit questions with block-ID citations for affirmative findings. It
  receives no second JD copy, point schedule, score formula, numeric threshold,
  offset task, or authority to make the final decision.
- Model-assessed hard stops have no negative answer. Ordinary hard stops allow
  only `present` or `not_specified`; the personal-hunting question allows only
  `specified` or `not_specified` because Python owns the one-third threshold.
  The evaluator therefore never searches for or cites proof that a stop is
  absent.
- When the JD does not answer a question, the evaluator returns
  `not_specified` with no evidence. Python records the final outcome as unclear
  with the fixed rationale `JD does not specify.` No worker is asked to prove a
  negative or cite the absence of text.
- Model answers are untrusted semantic inputs. Python validates their vocabulary
  and evidence IDs, derives every policy consequence deterministically, builds
  exact source bindings from the retained blocks, and validates the finished
  artifact before checkpointing it.
- Aim checkpoints are namespaced by the active worker protocol version. The
  explicit one-version export compatibility bridge therefore cannot resume an
  older worker result under the new question-only contract.
- A user-requested initial canary may stop after a configured number of leading
  jobs only when every one produced a technical safe failure. A legitimate
  rejection, hard stop, or low score is an evaluated result and never triggers
  that stop condition.
