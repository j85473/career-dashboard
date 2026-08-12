# Career Dashboard Ingestion and Scoring Audit

> **HISTORICAL AUDIT ONLY — DO NOT EXECUTE ITS SCORING PROCEDURE.** Native Agy scoring is superseded by `CAREER_DASHBOARD_AIM_EXPERIENCE_SCORING_IMPLEMENTATION_PLAN_2026-08-12.md` and is not a fallback or rollback.

Date: August 2, 2026  
Scope: job ingestion, normalization, candidate resume/evidence, Context DB feedback, standard scoring, wildcard eligibility, active-inbox freshness, and score explanations

Correction: the initial V6.3 production run used `data/resumes/core_resume.txt`, but the intended baseline is the text-identical SellSig/CS resume stored at `data/resumes/JosephLamb.CS.resume.docx`. V6.4 corrects the binding and gives the corrected results distinct score provenance. The V6.3 qualification results below must not be treated as calibrated against the intended resume.

## Executive conclusion

The system was materially too generous about experience fit. This was not simply normal job-search self-doubt.

The largest problem was not broad job discovery. The database generally contains full job descriptions and the newest V6.2 scorer was already much more conservative than V6.1. The dashboard nevertheless continued presenting old, inflated results because active inbox jobs were never invalidated when the scoring policy changed. A second defect made the problem more serious: the import path trusted the evaluator's numeric experience score even when the same evaluation said a mandatory domain or tenure requirement was missing. The prompt's 59-point cap was advisory rather than enforced code.

V6.3 fixes that chain. It uses the complete canonical resume, removes inflated evidence claims, requires structured mandatory-requirement findings, enforces qualification caps in deterministic code, raises automatic inbox admission from 60 to 70 experience points, cleans qualification and location diagnostics out of preference learning, requeues stale active scores, performs a bounded recovery of recent false negatives, and catches an observed aggregator-location normalization error.

The authorized production refresh is now complete. Two durable Agy requests reevaluated the bounded 500-job recent-dismissal cohort and every stale inbox job that remained eligible at atomic claim time. The post-run audit reports 0 stale or missing V6.3 scores in the active inbox. Explicit user promotions and jobs already staged for tailoring remained protected.

## What the live data said

The read-only production audit at `2026-08-02T20:31:42Z` found:

| Signal | Result | Interpretation |
| --- | ---: | --- |
| Jobs in database | 177,949 | Discovery is intentionally broad. |
| Descriptions under 400 characters | 1,159 (0.65%) | Missing/short JDs are not the dominant global problem. |
| Scored, unstaged active-inbox jobs | 173 | These are the jobs most relevant to current review quality. |
| Active-inbox jobs scored by V6.3 | 0 | The new policy has not been run against production. |
| Active-inbox jobs with stale/missing V6.3 provenance | 173 (100%) | The visible inbox cannot be treated as calibrated yet. |
| Recent AI dismissals selected for recovery | 500 (hard cap) | The 21-day target/near-miss pool reaches the configured cap. |
| User rejections labeled `Experience mismatch` | 24 | Direct calibration evidence from actual review behavior. |
| Those previously scored Experience >= 70 | 20 (83.3%) | The old system admitted obvious false positives at supposedly competitive scores. |

Examples of high-scoring experience false positives included:

- Ketch, Enterprise Account Executive (B2B SaaS): Aim 100, Experience 90, despite a direct quota-carrying B2B SaaS requirement.
- Maven AGI, Enterprise Account Executive: Aim 95, Experience 85, despite enterprise software-sales requirements not established by the resume.
- Twilio, Strategic Account Executive 4: Aim 92, Experience 84, despite specialized enterprise CPaaS/API-selling depth.
- AccuWeather, Account Executive: Aim 88, Experience 84.
- Garner Health, Client Success Manager: Aim 88, Experience 82.
- Pano AI, Senior Customer Success Manager: Aim 87, Experience 78.

Those scores repeatedly converted adjacent channel enablement, platform adoption, or partner support into direct SaaS quota ownership, enterprise account ownership, or Customer Success tenure. That conversion is not defensible from the resume.

There was also evidence of the opposite failure. Several older Customer Success jobs were manually promoted by the user even though the Context DB contained a blanket rejection for general CSM and Account Management roles. DailyPay, Dutchie, Repurpose Global, and Podium were examples. The system was simultaneously too generous on qualifications and too restrictive on some role families.

## Root causes

### 1. Stale scores remained active after policy improvements

The standard phase selected only jobs with a null Aim score. A job already admitted to `inbox` by V6.1 or an older scorer remained visible indefinitely, even after V6.2 became substantially more conservative.

This explains the apparent contradiction between recent scoring behavior and dashboard quality:

- V6.1: 212 passes out of 1,240 standard evaluations (17.1%).
- V6.2: 1 pass out of 21 standard evaluations (4.8%).

The V6.2 sample is small, so it is directional rather than a stable rate. Its one pass was a direct fit—Strategic Territory Manager at Jaeckle Distributors, Aim 95 and Experience 92—while it rejected specialized sales engineering, banking, PBM, medical-device, out-of-territory, and generic operational post-sale roles. The active inbox was still overwhelmingly older provenance.

### 2. Mandatory-requirement caps were not enforced by code

The Prisma score-event model already had fields for domain match and required/candidate domain tenure, and the scoring policy already contained guardrail concepts. The native standard result did not return those fields, and `direct_import.ts` did not apply the guardrails.

An evaluator could therefore say that a role required five years of enterprise B2B SaaS experience, admit that the candidate lacked it, and still return Experience 85. The numeric score won.

V6.3 reverses that authority. Structured qualification facts are validated first; deterministic code owns the final persisted score and pass decision.

### 3. Candidate inputs were inconsistent and sometimes inflated

The native scorer loaded `Joseph_Lamb_Resume.docx`, while the more complete canonical resume lived at `data/resumes/core_resume.txt`. The DOCX omitted Barton Associates and differed from the actual core record.

The evidence inventory also contained tags and scope notes that encouraged overclaiming:

- RevOps and workflow architecture from operational process improvements.
- General Customer Success and SaaS NRR adjacency from distributor adoption and retention work.
- C-suite communication and strategic-account ownership from coordination with Target and Best Buy account managers.
- Technical product ownership from a platform rollout.
- Healthcare-commercial expertise from four months at Barton.
- Professional technical tenure from personal AI and homelab projects.

These are all useful adjacent experiences. They are not interchangeable with direct professional ownership or years in a required domain.

### 4. Context learning mixed preference with qualification diagnostics

`Experience mismatch` and `Location mismatch` decisions were eligible to update the negative Aim profile. Historical context rules then learned statements such as rejecting roles that require domains the candidate lacks. Qualification is job-specific and belongs in Experience scoring; it is not a stable dislike.

The Context DB also contained a blanket rule against general CSM/Account Management jobs. That obscured commercially owned post-sale roles involving retention, expansion, account growth, or strategic partners—the exact kind of transferable opportunity that should be judged individually.

### 5. One concrete ingestion/normalization error bypassed local triage

A Cochlear posting titled `Territory Sales Manager – Texas/Oklahoma` carried `Saint Paul, MN` as aggregator location metadata, while the job text required the candidate to live in Texas or Oklahoma. The old prefilter trusted the local metadata because the territory name and residency language appeared in different text regions.

This is a real ingestion-normalization defect, but it is not representative of the entire corpus. Only 0.65% of all descriptions were under 400 characters. Source quality is uneven, however:

- CareerForce: 729 short descriptions out of 3,977.
- BambooHR: 77 out of 161.
- Indeed: 59 out of 474.
- Greenhouse: 36 out of 86,960.
- Workday: 22 out of 27,409.

The right response is to retain broad discovery, keep full-text extraction, monitor source-level description quality, and hard-reject clear location contradictions—not disable productive ATS sources.

## Implemented fixes

### Qualification policy and explanations

- Raised standard automatic inbox admission to Aim >= 80 and guarded Experience >= 70.
- Defined 60–69 as borderline/minimum-qualified, not competitive enough for automatic admission.
- Expanded the standard output from seven to fourteen fields. Every result must now report:
  - whether all mandatory requirements are met;
  - the exact unmet mandatory requirements;
  - required and candidate domain;
  - domain match;
  - required and candidate years in that domain.
- Added closed-schema and coherence checks. Contradictory results—for example, `domainMatch: true` with no candidate domain—are rejected before import.
- Enforced the final Experience cap in deterministic code. Any unmet mandatory requirement, domain mismatch, or unsupported required tenure caps the persisted score at 59.
- Added explicit persisted rationale prefixes:
  - `QUALIFIED AND COMPETITIVE`
  - `MINIMUM REQUIREMENTS MET, BELOW COMPETITIVE THRESHOLD`
  - `NOT QUALIFIED — unmet mandatory requirement(s)`

Policy replay is deterministic:

| Evaluator output | Guarded result | Automatic inbox |
| --- | ---: | --- |
| Experience 92, mandatory requirement unmet | 59 | No |
| Experience 90, required domain mismatch | 59 | No |
| Experience 88, required five years but candidate tenure unavailable | 59 | No |
| Experience 84, all mandatory/domain/tenure evidence supported | 84 | Yes if Aim >= 80 |

### Resume and evidence integrity

- Standard and wildcard preparation now load `data/resumes/JosephLamb.CS.resume.docx` as the canonical SellSig/CS baseline resume.
- The complete baked prompts include Barton Associates and match the canonical resume; preparation fails closed if they drift.
- Removed or narrowed unsupported inventory tags and added explicit scope prohibitions so adjacency cannot silently become professional tenure or ownership.
- Added a regression test against the version-controlled evaluator inventory so a clean checkout does not depend on ignored personal artifact files.

### Score freshness

- Added provenance-aware active-score invalidation at the beginning of the standard phase.
- Unreviewed inbox jobs whose latest standard score is missing or not V6.3 are reset to `pending_af` and have obsolete AI scores cleared.
- The production baseline says 173 jobs currently qualify for that reprocessing.
- Jobs already staged for tailoring are excluded.
- Explicit user promotions are excluded. The rescoring policy does not override a conscious manual decision.

### Bounded recent-dismissal recovery

- At the same one-time Context-to-Standard transition, the pipeline examines standard A/E dismissals from the previous 21 days.
- A job must have stale non-passing standard provenance, still pass the current local filter, and either match a target role family or have a meaningful prior near-miss score.
- Recovery is capped at 500 jobs and prioritized by target title, prior Experience score, then prior Aim score.
- User rejections, expired jobs, applications, tailoring work, current V6.3 decisions, and active wildcard jobs are excluded by lifecycle and provenance constraints.
- The selection and request phase transition occur in one database transaction. If it fails, both roll back; once V6.3 standard provenance exists, later requests cannot claim another dismissal cohort.
- The old unbounded `requeue_rejected_jobs.ts` utility was removed.

The read-only production preview selected the full 500-job cap. Its leading candidates included Territory Partner Manager at Nextiva, Account Manager at Taylor Communications, Client Success Manager at DailyPay, and several field/territory sales roles. These are not assumed passes; they are the bounded group whose old negative Context and scoring policy justify one clean V6.3 review.

### Context calibration

- `Experience mismatch`, `Location mismatch`, and `Expired` decisions are marked handled but cannot train Context.
- Qualification-derived legacy Context rules are removed during normalization.
- The blanket CSM/Account Management rule is narrowed to reject post-sale roles dominated by support, training, implementation, or internal operations without commercial ownership, account growth, or strategic partner scope.
- Existing intentional preference rules remain negative-only and continue to affect Aim, never Experience.

### Ingestion/location protection

- Added a prefilter for postings whose title names a nonlocal territory while the description separately requires residence in that territory.
- Added the observed Texas/Oklahoma title plus Saint Paul aggregator metadata as a regression case.
- General Account Executive, Sales Manager, and Customer Success titles remain eligible for responsibility-level scoring; no blanket sales-title block was introduced.

### Repeatable audit tooling

Added a read-only command:

```bash
npm run scoring:audit
```

It reports total and source-level JD quality, active-inbox score freshness, Experience-mismatch calibration samples, Context normalization before/after, and pass behavior by prompt version. It does not write to the database.

## Why this should reduce false positives without becoming too restrictive

The system now separates three different questions:

1. Is the job direction and working arrangement desirable? Aim score and preference-only Context answer this.
2. Does verified evidence satisfy every mandatory requirement? Structured qualification fields and deterministic caps answer this.
3. Is the candidate merely plausible, or competitive enough to spend application time? The 70-point Experience threshold answers this.

The threshold was not raised to 85. Transferable roles with all mandatory requirements supported can still enter at 70–84. Strong target fits remain eligible. Wildcard logic still provides a separate high-confidence path for unusual opportunities, and user promotions remain authoritative. Meanwhile, adjacency alone can no longer satisfy specialized SaaS, medical, engineering, regulatory, enterprise-sales, or domain-tenure requirements.

This is deliberately ruthless about mandatory qualifications and deliberately flexible about job titles.

## Validation completed

The finished implementation passed:

- 97 unit/regression tests, 0 failures.
- Native scoring structural canary.
- TypeScript typecheck.
- ESLint with 0 warnings and 0 errors.
- Next.js 16 production build, including all 38 generated static pages.
- Exact live prompt-to-SellSig/CS DOCX binding for both standard and wildcard evaluators.
- `git diff --check`.

Relevant new regression coverage includes:

- experience threshold boundaries;
- mandatory/domain/tenure score vetoes;
- contradictory structured result rejection;
- stale/missing active-score selection;
- 21-day dismissal recency, current local-filter eligibility, stale provenance, priority ordering, and the 500-job hard cap;
- preservation of manual promotions and tailoring-stage jobs;
- exclusion of diagnostic feedback from Context learning;
- removal/narrowing of legacy Context contamination;
- unsupported evidence-tag prevention;
- aggregator-localized nonlocal territory rejection;
- the permanent no-login rule.

The test suite prints expected asynchronous database-sync warnings when run inside the network-restricted local sandbox, but all tests pass. The separate authorized read-only live audit connected successfully.

## Production execution and verification

The user authorized Agy to run the production rescoring before deployment. The durable requests completed as follows:

| Request | Standard results | Wildcard results | Outcome |
| --- | ---: | ---: | --- |
| `efef76fc-4171-4c16-8772-a6cb130b2df5` | 614 evaluated: 47 pass, 567 reject | 23 evaluated: 3 pass, 20 reject | Completed |
| `7b6548cc-6afe-44f0-bdaa-35d04918ea51` | 56 evaluated: 4 pass, 52 reject | 2 evaluated: 1 pass, 1 reject | Completed after one safe retry |
| Combined | 670 evaluated: 51 pass, 619 reject | 25 evaluated: 4 pass, 21 reject | Completed |

The first request atomically recovered the full 500-job recent-dismissal cap and 114 then-eligible stale inbox jobs. Its post-run audit exposed a SQL null-semantics edge case: the stale update's negative `passReason` test did not select rows whose reason was null. The selector was made explicitly null-safe, and dismissal recovery was made globally one-time once any V6.3 standard provenance exists. The follow-up therefore opened no second dismissal cohort. It prepared 12 chunks and evaluated the 56 stale jobs that were still eligible when the transaction claimed them; four of the previously observed 60 candidates had ceased to qualify for the active stale set before claim.

The importer also did what it was designed to do under imperfect model output. It quarantined malformed, incomplete, incoherent, or wrong-persona result chunks before import and regenerated only the affected chunks. On the follow-up, 11 of 12 standard chunks validated; the incomplete final chunk caused a safe request failure, and the same durable request resumed to regenerate that chunk. The standard batch was imported atomically only after all 12 chunks passed validation. No invalid or partial batch was imported.

The final read-only audit at `2026-08-02T21:50:35Z` reported:

- 51 scored, unstaged active-inbox jobs, all 51 on `standard-job-evaluator-v6.3`;
- 0 active-inbox jobs with stale or missing provenance;
- a 0% active-inbox stale-provenance rate;
- `campaignComplete: true` for recent-dismissal recovery and 0 jobs selected for another cohort;
- 619 V6.3 standard rejects and 51 V6.3 standard passes in score history.

No GitHub push or Pi deployment was performed. The production database scoring changes described above were performed through the authorized local Agy runner. Deployment remains a separate explicit action.

After deployment, ongoing calibration should compare:

- user `Experience mismatch` rate among newly surfaced jobs;
- false-positive rate among jobs with Experience >= 70;
- count of user-promoted commercially owned CSM/account roles;
- source-level short-description rates;
- pass rate by V6.3, interpreted with sample size rather than optimized as a goal.

The key success criterion is not a low pass rate by itself. It is that surfaced jobs survive a human mandatory-requirement review, while realistic channel, territory, distributor, account-growth, and commercially owned post-sale roles remain represented.

## Files changed

Core logic:

- `src/lib/scoringPolicy.ts`
- `src/lib/nativeScoringBatch.ts`
- `src/lib/scoringFreshness.ts`
- `src/lib/contextFeedbackPolicy.ts`
- `src/lib/jobFiltering.ts`
- `scripts/direct_import.ts`
- `scripts/prepare_native_scoring_phase.ts`
- `scripts/audit_scoring_calibration.ts`

Evaluator contracts:

- `.agents/agents/standard-job-evaluator-v6/agent.md`
- `.agents/agents/wildcard-job-evaluator-v6/agent.md`
- `.agents/agents/context-job-evaluator-v6/agent.md`
- `.agents/agents/scoring-manager-v6/agent.md`
- `.agents/agents/native-scoring-runner-v6/agent.md`

Tests and documentation:

- `src/lib/__tests__/scoringPolicy.test.ts`
- `src/lib/__tests__/nativeScoringBatch.test.ts`
- `src/lib/__tests__/scoringFreshness.test.ts`
- `src/lib/__tests__/contextFeedbackPolicy.test.ts`
- `src/lib/__tests__/evidenceInventory.test.ts`
- `tests/unit/jobFiltering.test.ts`
- `docs/ANTIGRAVITY_V6_SCORING_WALKTHROUGH.md`
- `PIPELINE_FLOW.md`

## Bottom line

The anxiety had a factual basis: the visible inbox was not calibrated to the current standard, and the historical scorer routinely treated adjacent experience as direct qualification. V6.3 fixes the mechanics that caused that outcome. The authorized refresh is complete and the active inbox now has 0% stale provenance; ongoing user rejection reasons can be used as measurement data without contaminating preferences.
