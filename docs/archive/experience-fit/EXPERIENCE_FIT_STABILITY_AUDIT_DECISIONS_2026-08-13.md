# Experience Fit Stability Audit — Decision Record

**Date opened:** 2026-08-13  
**Status:** Archived and superseded by the two-pass Experience Fit v2 implementation on 2026-08-13  
**Authority:** This file records Joseph's explicit decisions during the final Experience Fit implementation-plan audit. It is not an implementation plan or implementation authorization.

## Scope and handling rules

- Work through one material product question at a time.
- Record Joseph's decision before advancing to the next question.
- Do not infer an answer from silence, earlier conversational approval, or a recommendation in the design scratchpad.
- Keep unresolved questions visibly marked `OPEN`.
- Separate final product decisions from calibration-only experiments and ordinary implementation mechanics.
- This record does not authorize production-code edits, scoring runs, database changes, imports, commits, pushes, deployments, numeric dismissal thresholds, or Dashboard lifecycle consequences.

## Confirmed boundaries not being reopened in this discussion

- The Dashboard remains a data and approval boundary: Dashboard export -> external database-free controller -> result JSON -> zero-write preview -> explicit approval -> atomic import, if and when an importable production contract is separately approved.
- The Dashboard does not call models. Native Agy/model scoring remains disabled and unreachable.
- Models answer bounded semantic questions only. They do not format JSON, construct schemas, assign weights or scores, apply thresholds, decide pass/fail, or control lifecycle consequences.
- Deterministic script/application code owns parsing, IDs, source spans, validation, schemas, JSON, provenance, caching, retry state, arithmetic, results, and any later-approved consequences.
- The complete canonical original JD is supplied unchanged to the requirement-supplier worker.
- Core Evidence remains the detailed factual authority. EFEI is a separate, deidentified, condensed positive-evidence projection and is not a complete biography.
- A catalog-scoped `no` must never be expressed as a biographical claim.
- Administrative eligibility and travel logistics remain outside E Fit.
- Numeric dismissal thresholds and Dashboard lifecycle consequences remain deferred until stable calibration evidence exists and Joseph separately approves them.
- Planning and audit only; this decision record is not implementation authorization.

## Decision register

### D1 — Meaning of an explicit required-item miss

**Status:** DECIDED

**Scratchpad proposal:** An explicitly required substantive item creates a deterministic E Fit hard-failure flag when the catalog answer is `no` or linked months are below the explicit minimum. The flag has no initial Dashboard lifecycle consequence.

**Audit conflict:** EFEI is intentionally incomplete and contains positive evidence. A catalog `no` establishes only that the current catalog did not supply a match; it does not establish that the candidate lacks the experience. Likewise, role-associated months may establish a supported lower bound, but a value below the JD minimum does not establish an exhaustive tenure deficit unless the underlying evidence is expressly complete for that exact capability.

**Decision:** Use a proof-required gate for an explicitly required substantive qualification.

- An explicit required, mandatory, or minimum qualification is satisfied only when approved evidence positively establishes it.
- Record `required_evidence_not_established` when an explicit required item receives no validated evidence link.
- Record `required_tenure_not_established` when approved evidence does not establish the stated minimum duration.
- These are evidence-sufficiency findings, not biographical claims. They must never be rendered or stored as “the candidate lacks X” or `does_not_meet` solely because the catalog is silent or the documented duration is insufficient.
- A separately reviewed affirmative conflict, when one exists, remains distinguishable from an evidence-not-established result.
- During calibration, the proof-required gate and its reason are recorded as informational outputs only. They do not change a Dashboard status, dismiss or advance a job, create a pipeline pass/reject consequence, or otherwise exercise lifecycle authority.

**Joseph's decision:** Approved option 1, the proof-required gate, on 2026-08-13.

### D2 — Evidence-link worker view and private qualification authority

**Status:** DECIDED

**Scratchpad proposal:** Each model-facing EFEI record contains exactly `efitEvidenceId`, `skill`, and `associatedExperienceMonths`. The evidence-link worker sees this flat, deidentified catalog and answers `yes` or `no`, supplying record IDs for `yes`.

**Audit conflict:** Showing month totals to the semantic linker may invite the worker to judge whether tenure is sufficient, even though deterministic code is supposed to own that comparison. The three-field skill record also cannot safely encode education, credentials, direct people management, ownership, tool-use depth, duration completeness, or other boundary facts without either broadening model authority or overstating the catalog label.

**Decision:** Preserve the canonical three-field EFEI, but withhold duration and all private authority fields from the evidence-link worker.

- Preserve the approved canonical three-field deidentified EFEI catalog.
- Project only `efitEvidenceId` and `skill` to the evidence-link worker.
- The worker answers only whether a supplied skill label explicitly answers the requested capability; it never evaluates tenure sufficiency.
- After a validated link, deterministic code reads `associatedExperienceMonths` and performs any exact duration comparison.
- Maintain a separate private, controller-only provenance and boundary ledger for duration quality, overlap, management/ownership/tool-scope limitations, and other match constraints.
- Maintain a separate private typed qualification-facts authority for education, professional credentials, and reviewed closed-world facts that do not fit the skill-plus-month representation.
- Neither private authority is exposed to the worker. Deterministic code uses it only to validate or constrain the worker's proposed links and to evaluate exact non-skill facts.

**Clarification discussed:** Hiding EFEI month totals from the evidence-link worker does not remove tenure evaluation. The requirement side retains the complete exact JD wording and a controller-derived duration constraint. For a requirement such as “3–5 years of channel sales experience,” the evidence-link worker answers only whether a supplied catalog skill explicitly answers `channel sales experience`. If it links `EFIT-001`, deterministic code privately reads that record's approved month value and compares it with the requirement's minimum: `3 years = 36 months`. The upper end of a requested experience range is not treated as a disqualifying maximum unless the JD explicitly makes it one. Ambiguous duration language that deterministic code cannot safely normalize is recorded as not comparable; it is not delegated to the worker.

**Joseph's decision:** Approved the recommended separation on 2026-08-13. The evidence-link worker sees only `efitEvidenceId` and `skill`. Deterministic code privately reads `associatedExperienceMonths`, applies reviewed scope constraints, resolves typed qualification facts, and performs exact tenure comparisons.

### D3 — Compound requirements, shared tenure, and denominator construction

**Status:** DECIDED

**Scratchpad proposal:** A compound source item may retain one exact parent excerpt while exposing independently testable child facets. The parent is not also scored, but the children appear to participate as separate occurrence rows. A duration or cue shared by the parent remains bound to every applicable child.

**Audit conflict:** Giving every child a full occurrence weight lets one densely written sentence outweigh several simple requirements. It also makes the score depend on how aggressively the supplier splits a sentence. A shared duration may govern the whole compound rather than independently governing every child.

**Decision:** Give each validated source occurrence one total denominator unit and aggregate its child facets within that unit.

- Assign one total denominator unit to each validated source occurrence, regardless of how many child facets it contains.
- Never score both the parent and its children.
- For an `AND` compound, compute the parent occurrence's binary coverage as the mean of its independently tested child results. Example: two of three children established gives that occurrence `2/3` coverage, while the model still returns only binary links for each child.
- For an `OR` compound, one established valid alternative gives the parent occurrence full coverage; use the maximum child result rather than adding alternatives.
- Preserve every child result for audit and for the D1 explicit-required proof gate. If an explicitly required `AND` child is not established, the required-evidence gate is not satisfied even though the parent contributes fractional numeric coverage.
- Apply a shared duration to every child only when the JD syntax unambiguously gives each child that minimum. If the duration applies to the compound as a whole or its scope is ambiguous, record it as parent-scoped or `duration_scope_not_comparable`; do not copy it onto every child.
- Never add separate EFEI durations to manufacture satisfaction of one compound tenure requirement unless a separately reviewed private interval/composite fact explicitly establishes that combined duration without overlap.

**Joseph's decision:** Approved the recommended compound-requirement rule on 2026-08-13.

### D4 — Repeated JD mentions and calibration sensitivity

**Status:** DECIDED FOR CALIBRATION; PRODUCTION RULE DEFERRED

**Scratchpad proposal:** Every genuinely distinct, non-overlapping source occurrence receives a full occurrence weight. Repetition within the JD is treated as job-specific emphasis, while source position has no weight.

**Audit conflict:** Repetition can reflect genuine emphasis, but it can also result from copied boilerplate, duplicated sections, inconsistent drafting, or verbosity. Unlimited raw occurrence weighting can let one repeated concept dominate the denominator and can make semantically equivalent JDs score differently because of writing style.

**Calibration decision:** Test all three repetition treatments from the same accepted evidence answers rather than assuming repeated wording is always meaningful.

- Preserve and validate every distinct source occurrence for provenance.
- For the first calibration, compute three deterministic views from the same accepted factual vector:
  1. `raw_occurrence` — every validated distinct occurrence receives full weight, matching the scratchpad proposal;
  2. `unique_concept` — equivalent occurrences contribute one total unit;
  3. `capped_repeat` — the first occurrence receives full weight and later occurrences receive only a bounded total emphasis increment.
- Designate `raw_occurrence` as the provisional primary calibration view only if Joseph wants to preserve the scratchpad's starting hypothesis; the other two remain required distortion diagnostics.
- Do not select the production repetition rule until the locked calibration corpus shows whether repetition improves or degrades ranking, positive-anchor protection, and verbose-JD invariance.
- Models never decide that repetition is important and never assign the weights. Source occurrence identity, concept grouping, and all three calculations are controller-owned and auditable.

**Joseph's decision:** Approved the recommended calibration direction on 2026-08-13. Use `raw_occurrence` as the provisional starting comparison and always report `unique_concept` and `capped_repeat` beside it. This does not approve any of the three as the production rule. Select the production treatment only after Joseph reviews understandable job-level examples and calibration results.

### D5 — Experience expectations expressed as job duties

**Status:** DECIDED

**Scratchpad tension:** The requirement supplier is told not to invent qualifications from ordinary duties, but the calibration section calls for testing requirements expressed as duties. Real postings often state important experience expectations only under “What you will do,” without repeating them under “Qualifications.”

**Audit concern:** Excluding every duty can miss the actual work the candidate must be able to perform. Counting every duty can turn routine task descriptions into assumed hiring requirements and punish detailed JDs.

**Decision:** Concrete duty-based capabilities participate in the numeric E Fit score, but duty wording alone does not create a proof-required gate.

- Count a duty in the E Fit numeric score only when it describes a concrete, experience-matchable capability the person would actually need to perform, such as managing channel partners, leading implementations, owning strategic accounts, or administering Salesforce.
- Do not let a duty become an explicit proof-required gate unless the JD separately marks it required, mandatory, minimum, or otherwise clearly states it as a candidate qualification.
- Exclude vague expectations, personality language, aspirations, outcomes without a candidate capability, and administrative material.
- Preserve whether each scored item came from an explicit qualification or a duty so calibration can show Joseph the effect of including duty-based capabilities.
- During calibration, also compute an explicit-qualifications-only diagnostic. Do not finalize the production treatment if duty inclusion materially distorts known-fit examples.

**Joseph's decision:** Approved the recommended duty treatment on 2026-08-13.

### D6 — JD with no scorable substantive requirements

**Status:** DECIDED

**Scratchpad gap:** The formula explains how to normalize when only the required bucket or only the preferred bucket exists, but it does not define the case where no substantive experience items remain after validation and exclusions.

**Audit concern:** Assigning `0` would imply a mismatch; assigning `100` would imply full support; assigning `80` would recreate an arbitrary legacy baseline. None is supported when there is nothing to measure.

**Decision:** Route the unscorable job to a dedicated human-decision queue with no numeric score.

- Return `score: null` with result code `no_scorable_requirements`.
- Record that the supplied JD did not contain enough substantive, assessable experience material to calculate E Fit.
- Produce no proof-required failure flag unless a separately validated explicit required item exists; if one exists, then the JD did contain a scorable item and this empty case does not apply.
- Give the result a `needs_review` disposition rather than treating the job as a fit or mismatch.
- Surface these jobs in a new sub-tab under Log named `E Fit Manual Review`.
- The numeric score is irrelevant for this path and remains `null`.
- `E Fit Manual Review` is a temporary human-decision queue, not a third final outcome between tailoring and dismissal.
- The system does not automatically advance or dismiss the job while it awaits review. Joseph resolves it by taking one of two existing terminal workflow actions: stage it for tailoring or dismiss it.

**Joseph's decision:** Joseph selected the `E Fit Manual Review` workflow on 2026-08-13 and clarified that he will either stage the job for tailoring or dismiss it; there is no scored or lasting intermediate outcome.

### D7 — Where calibration results live

**Status:** DECIDED

**Repository conflict:** The current Experience importer cannot safely accept calibration results. It writes the authoritative `reqFitScore`, requires a Boolean pass/fail value, may change job status to Inbox or Dismissed, records `ae_pass` or `ae_reject`, feeds score authority and Stats, and refreshes the legacy evidence-gap report. Merely promising not to use those consequences would not make the path safe.

**Product choice:**

1. **File-only calibration:** The external controller writes validated, versioned calibration result and comparison files. Joseph reviews them outside the Dashboard. Dashboard import rejects them structurally.
2. **Dashboard calibration workspace:** After zero-write preview and explicit approval, calibration results are stored in a dedicated non-authoritative Dashboard data model and view. They cannot populate `Job.reqFitScore`, set pass/fail authority, change job status, affect queues or Stats, or create `ae_pass`/`ae_reject`. This requires a separate persistence contract and database design.

**Decision:** Calibration inputs, raw worker receipts, factual vectors, results, and comparison reports remain Mac-local files only.

- Store them in an explicitly ignored local calibration namespace.
- They are never uploaded through Dashboard preview/import, persisted to the Dashboard database, used as `Job.reqFitScore` or pass/fail authority, included in Stats or queues, committed to Git, pushed to GitHub, deployed, or copied to the Pi.
- Calibration-purpose result files must be structurally rejected by Dashboard import rather than relying on operator convention.
- Local calibration files retain complete hashes and provenance so they remain auditable and comparable on the Mac.
- This decision does not affect the separately approved `E Fit Manual Review` production workflow for genuinely unscorable JDs.

**Joseph's decision:** Approved Mac-local-only calibration artifacts on 2026-08-13.

### D8 — Technical retry, safe failure, and resume behavior

**Status:** DECIDED FOR CALIBRATION; PRODUCTION BEHAVIOR DEFERRED

**Scratchpad and repository gap:** The redesign requires resumability and safe failures, but it does not settle how many fresh attempts are allowed or when a human must intervene. The current Experience runner repairs model-created JSON using prior output and validator errors, which conflicts with the new plain-answer boundary and can turn the worker into an artifact repairer.

**Calibration decision:** No retries of any kind during testing. Every semantic unit receives exactly one model invocation per calibration run.

- Save every validated question answer immediately under its exact semantic identity, so an interrupted run resumes without re-asking completed questions.
- Record every raw model output exactly as returned, including malformed, unexpected, empty, or semantically invalid output.
- Store the raw output separately from the parser result, validation result, normalized factual value, and deterministic score/result output.
- Preserve an invocation receipt containing the exact input identity, prompt and model provenance, timestamps, completion status, and raw-output hash.
- Preserve parser and validator versions, their accepted/rejected disposition, bounded reason codes, and any source-span or catalog-link checks they performed.
- Preserve every deterministic transformation and its authority version so the audit can trace `model output -> parser result -> validated fact -> score contribution -> final local result` without reconstructing hidden state.
- A failed or invalid output ends that unit for that calibration run as a recorded safe failure. Do not retry, guess, omit it, switch models, repair the answer, or weaken validation.
- Never rerun merely because the answer or resulting score is undesirable.
- A separate forced-fresh calibration run is a new measured observation with its own run ID; it does not replace, overwrite, or conceal the earlier output.
- Resuming an interrupted calibration run may continue units that were never invoked, but it must not reinvoke a unit that already produced an output in that run.
- Production retry and operator-resume behavior will be decided only after calibration shows the actual failure modes. Do not infer it from the calibration no-retry rule.

**Joseph's decision:** On 2026-08-13 Joseph rejected retries during testing and required retention of every model output so model failures can be distinguished from parser, validator, and script failures.

### D9 — Closed-world professional license and certification fact

**Status:** DECIDED

**Scratchpad proposal:** The candidate has no professional licenses or certifications. Therefore an explicitly required, role-defining professional license or certification can be treated as a deterministic required-item failure. Ordinary administrative licenses such as a driver's license remain excluded.

**Audit concern:** The detailed Core Evidence contains a retired absence placeholder that must not be used as proof. Absence from a resume or positive evidence catalog is not affirmative evidence that no license or certification exists. D1 permits a true affirmative conflict only when a separately reviewed closed-world fact establishes it.

**Question for Joseph:** Is it currently accurate and intentionally exhaustive that you hold no professional, occupational, or role-defining licenses or certifications that should satisfy a job qualification? This excludes ordinary administrative eligibility such as a driver's license. If yes, may the private typed qualification authority store that as a Joseph-confirmed closed-world fact, with its confirmation date, so an explicitly required named credential can be distinguished from ordinary EFEI silence?

**Joseph's decision:** On 2026-08-13 Joseph directly confirmed that his only substantive credential is a Bachelor of Science in Biology and that he holds no other professional, occupational, or role-defining license or certification that could satisfy a job qualification. Ordinary administrative credentials such as a driver's license are excluded from this statement and remain outside E Fit.

**Implementation meaning:** Store this as a dated, Joseph-confirmed private typed qualification fact rather than inferring it from resume or catalog silence. A generic bachelor's-degree requirement can be evaluated against the confirmed degree. An explicitly required named professional license or certification can be treated as an affirmative credential conflict when the private fact and requirement taxonomy establish that it is a credential Joseph does not hold. The model never sees the private fact or applies the consequence.

### D10 — Degree-field and “related field” requirements

**Status:** DECIDED

**Confirmed fact:** Joseph holds a Bachelor of Science in Biology. This must be represented as two independently testable credential facts rather than collapsed into the narrower label “Biology degree”:

- degree level/type: `Bachelor of Science`;
- field/major: `Biology`.

No other degree or substantive credential is available for E Fit.

**Audit concern:** A generic bachelor's or Bachelor of Science requirement is straightforward and must not be narrowed to the Biology major. Postings also often require a degree “in business, engineering, computer science, or a related field.” Letting a model decide whether Biology is “related” would restore evaluator authority. Deterministically treating every “related field” clause as satisfied would overclaim; treating all broad scientific-field language as unsatisfied would undercount the Bachelor of Science credential.

**Decision:** Represent and evaluate the credential as independent degree-type and field facts.

- A requirement for any bachelor's degree or four-year degree is established.
- A requirement for a Bachelor of Science, B.S., BSc, science bachelor's, or equivalent degree type without a narrower named major is established.
- A requirement explicitly naming Biology is established by the field/major fact.
- The reviewed taxonomy treats Biology as establishing these broad field families when the JD uses them without a narrower exclusion: `biology or biological sciences`, `life sciences`, `natural sciences`, `science or scientific disciplines`, and `STEM`.
- A requirement for a different specific field is not established merely because Joseph's degree is a Bachelor of Science. The script evaluates degree type and degree field separately.
- A phrase such as “business, engineering, computer science, or a related field” is not automatically established by the Bachelor of Science degree type. It requires either an explicitly accepted field/alternative in the JD or a reviewed field-family rule.
- Do not ask the model to judge academic-field relatedness. Deterministic code uses a small reviewed degree taxonomy and exact alternatives from the JD.
- During calibration, unexpected `technical field`, `related field`, or other field language that the reviewed taxonomy and explicit JD alternatives cannot resolve enters `E Fit Manual Review` rather than being guessed.

**Joseph's decision:** Approved the two-part credential representation and the five listed field families on 2026-08-13.

**Joseph's clarification:** On 2026-08-13 Joseph emphasized that `Bachelor of Science` is itself a broad degree credential that satisfies many requirements beyond those explicitly asking for a Biology degree. The final rule must preserve that breadth while evaluating any separately stated major/field restriction independently.

### D11 — Meaning and authority of EFEI month totals

**Status:** DECIDED

**Scratchpad proposal:** Each normalized EFEI skill has one reviewed `associatedExperienceMonths` total. Many totals are derived from the duration of roles with which the skill is associated. The deterministic script compares the linked total with an explicit JD tenure minimum.

**Audit concern:** A skill being associated with an 80-month role does not automatically prove documented active use in every one of those months. Conversely, EFEI is not an exhaustive biography, so a reviewed total is not a maximum proving there was no additional experience. Without a defined meaning, the same number could be used too aggressively to satisfy a minimum or incorrectly used as proof of a deficit.

**Decision:** Treat a reviewed EFEI month total as supported E Fit duration under the following boundaries.

- Treat an approved EFEI month total as a reviewed **supported duration for E Fit**, not as an exhaustive maximum and not as a claim of day-by-day continuous use.
- Before a record can satisfy an explicit tenure minimum, its private ledger must document the roles/intervals used, why the skill is supported across those intervals, how overlapping intervals were handled, and Joseph's review status.
- A total that is merely an unreviewed role association may support the capability link but cannot satisfy an explicit numeric tenure minimum until reviewed.
- If the approved supported duration meets or exceeds the JD minimum, the tenure requirement is established.
- If it is below the JD minimum, D1 produces `required_tenure_not_established`; this means the approved evidence did not establish the minimum, not that Joseph definitively lacks additional experience.
- Never add overlapping role months or unrelated skill records to manufacture tenure. A composite duration requires an explicitly reviewed private composite/interval fact.
- Terms such as `continuous`, `recent`, or a combined capability-plus-industry duration require the private ledger to establish that exact scope; a generic skill total alone is insufficient.

**Joseph's decision:** Approved the supported-duration interpretation and listed safeguards on 2026-08-13.

### D12 — What counts as a valid EFEI capability link

**Status:** OPEN

**Scratchpad direction:** The evidence-link worker answers whether a supplied EFEI skill explicitly describes experience that answers the requested qualification. A free-form `functional equivalent` outcome is prohibited, but the catalog uses general skill language and must tolerate ordinary JD wording differences.

**Audit concern:** Requiring identical words would miss obvious relationships such as Salesforce satisfying a broad CRM-platform requirement. Allowing general transferability would recreate the evaluator and could turn Salesforce into HubSpot, team leadership into direct people management, or separate SaaS and account-management records into unverified SaaS account-management experience.

**Recommendation under discussion:**

- Allow an exact label match, an ordinary wording/synonym match that preserves the same capability, or a reviewed specific-to-broader hierarchy link.
- A reviewed specific skill may satisfy a broader family requirement: for example, `Salesforce.com` may support `CRM platform experience`.
- A broader family may not satisfy a named specific requirement: generic `CRM Platforms` does not establish `HubSpot` experience.
- Adjacent or merely transferable capabilities do not link: Salesforce does not establish HubSpot; team leadership does not establish direct people management; reporting does not establish Tableau administration.
- Separate catalog records may not be combined to invent an intersection. `Software as a Service (SaaS)` plus `Account Management` does not by itself establish `SaaS Account Management`; that requires one record or a separately reviewed private composite fact supporting the intersection.
- Private scope guards can invalidate a proposed link even when labels look similar, such as end-user tool experience versus administration/implementation or participation versus ownership.
- The worker still returns only a binary link answer and record IDs. Deterministic code applies the reviewed synonym/hierarchy rules and private guards; neither the worker nor the script invents a new functional-equivalence theory during a job run.
- Unexpected relationships are retained as calibration disagreements for Joseph's review. They do not silently expand the taxonomy.

**Joseph's decision:** Pending.

## Remaining questions queued after D1

The exact wording of later questions may change based on earlier decisions.

The initial question set is complete. Completeness audits identified D9-D12 as additional critical factual or semantic boundaries. Continue presenting any further newly discovered critical choice one at a time before drafting the final implementation plan. Production retry/resume behavior remains explicitly deferred until calibration evidence exists.

## Change log

- 2026-08-13: Created the decision record. No product choices have yet been recorded as approved.
- 2026-08-13: D1 decided. Explicit required qualifications use a proof-required, evidence-scoped gate; calibration records the flag without lifecycle consequences.
- 2026-08-13: D2 decided. The evidence-link worker sees EFEI IDs and skill labels only; deterministic code privately owns durations, boundaries, qualification facts, and tenure comparison.
- 2026-08-13: D3 decided. Each source occurrence has one denominator unit; compound children aggregate within it, while explicit required children remain individually subject to the proof-required gate.
- 2026-08-13: D4 decided for calibration only. Test raw, unique-concept, and capped-repeat views together; do not lock a production repetition rule before reviewing real results with Joseph.
- 2026-08-13: D5 decided. Concrete experience-matchable duties affect the numeric score but cannot become proof-required gates without an explicit required or minimum cue.
- 2026-08-13: D6 decided. A JD with no scorable substantive requirements receives no score and enters `E Fit Manual Review`; Joseph then stages it for tailoring or dismisses it.
- 2026-08-13: D7 decided. All calibration artifacts remain Mac-local only and are structurally non-importable, untracked, undeployed, and non-authoritative.
- 2026-08-13: D8 decided for calibration. Each unit gets one invocation with no retry, and the complete raw-to-deterministic audit chain is retained so failures can be attributed to the model, parser, validator, or scoring code.
- 2026-08-13: D9 decided. Joseph directly confirmed a Bachelor of Science in Biology as his only substantive credential and confirmed no other professional, occupational, or role-defining license or certification.
- 2026-08-13: D10 decided. Evaluate Bachelor of Science separately from the Biology major; recognize Biology under the approved biological sciences, life sciences, natural sciences, science disciplines, and broad STEM field families.
- 2026-08-13: D11 decided. Reviewed EFEI months are supported E Fit duration, usable for ordinary tenure minimums but neither exhaustive maxima nor claims of continuous month-by-month use.
