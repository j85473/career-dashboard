# Career Dashboard Scoring Finish Handoff

> **RETIRED HISTORICAL HANDOFF — DO NOT EXECUTE.** This native-Agy workflow is superseded by `CAREER_DASHBOARD_AIM_EXPERIENCE_SCORING_IMPLEMENTATION_PLAN_2026-08-12.md`. Native Agy is not a fallback or rollback.

Date: 2026-08-09
Workspace: `/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard`

## Objective

Finish the Career Dashboard repair with a compact, deterministic Agy evaluation input, correct evidence semantics, a small manually reviewed canary, and the final GitHub-driven Raspberry Pi activation.

Use **Codex Medium reasoning**. Work token-efficiently, but do not reduce verification quality or bypass safety controls.

## Token-Efficient Operating Contract

- Do not use Codex Ultra.
- Do not spawn subagents unless Joseph explicitly asks for them.
- Read this handoff first, then inspect only the files listed under **Primary files** and any directly required dependencies.
- Do not repeat the exhaustive ingestion, Stats, dashboard, schema, or deployment audits already completed unless a current check fails or the relevant code changes.
- Run focused tests while iterating. Run the full test suite, typecheck, lint, scoring canary, Prisma validation, diff check, and production build only once after the focused work is green.
- Do not run the complete native-scoring backlog synchronously in the Codex task.
- Use Agy Gemini Pro High only for the small canary and later asynchronous scoring. Do not use Agy as a substitute for deterministic parsing or validation.
- Give concise progress updates only when state materially changes.
- If a product-policy ambiguity appears, stop and ask Joseph. Do not silently increase reasoning level, broaden the project, or run for hours.
- Token-efficient means avoiding repeated exploration and duplicated validation. It does **not** mean skipping tests, truth checks, production gates, or rollback safety.

## Current Safe State

- No Agy process is running.
- Persistent Mac Agy watcher is unloaded.
- Production native-scoring request `fbb1bafd-ef31-4d0b-8234-fc2363a01260` was cancelled after its leases were released.
- Both failed scoring attempts imported **zero** `JobScoreEvent` rows and **zero** Context revisions.
- The stopped Pro batch released all 86 standard-job leases. Its artifacts remain preserved under `.agents/eval_runs/`.
- Production strict readiness most recently returned `ready: true` with zero violations, zero active requests, zero job/context/pipeline leases, and zero active scoring orphans.
- Latest queue snapshot: approximately 150 jobs awaiting native scoring and 45 jobs needing better JD extraction.
- Raspberry Pi ingestion cron remains disabled.
- GitHub variable `PI_ACTIVATION_MODE` remains set to `maintenance`.
- Raspberry Pi is still running commit `98d0fab`.
- `origin/main` is `2d42871`; its automatic deployment failed safely before mutation because the old scoring request held the single-flight key. That key is now released.
- Local `main` is at `984a385` and is two commits ahead of `origin/main`:
  - `5e78b8b fix: use Gemini Pro for native scoring`
  - `984a385 fix: fail closed on binary credentials`
- Commit `984a385` contains an incorrect policy that lets missing driver-license evidence reduce Experience. It must not be deployed without the corrective work below.
- The worktree currently has an interrupted, uncommitted V6.10.2 correction in:
  - `.agents/agents/standard-job-evaluator-v6/agent.md`
  - `src/lib/nativeScoringBatch.ts`
- Treat that partial diff as unreviewed. Complete, revise, or replace it deliberately; do not assume it is correct merely because it exists.
- The only scoring resume is `data/resumes/JosephLamb_Resume.docx`, SHA-256 `23ceb1cb09d9ec8d0350ae4da96da018b26517c0f9b58dbe2762f0e44e0ad059`, with the formal title `Field Sales Representative — Channel Sales`.
- Pushing `main` to GitHub triggers the Raspberry Pi deployment. Do not run a separate manual deployment unless the GitHub deployment fails and Joseph authorizes a fallback.

## Correct Product Semantics

### Evidence inventory

- The evidence inventory is a positive-evidence memory aid, not an exhaustive list of everything true about Joseph.
- Presence may substantiate a claim.
- Absence means **unknown/not recorded**, never false, missing, or disqualifying.
- Never infer that Joseph lacks a license, credential, ability, work authorization, or other fact merely because the inventory does not mention it.
- Casual conversations, voice-mode remarks, estimates, imperfect recollections, and late-night discussions are contextual leads, not automatically verified facts.
- Casual statements must not silently update the inventory or trigger adversarial reconciliation. Preserve uncertainty and ask later only when the distinction materially affects a real deliverable.
- Canonical documents and facts Joseph deliberately confirms have higher authority than casual recollections.

### Scoring dimensions

- **Experience** evaluates work experience only.
- **Aim** evaluates whether the job matches Joseph's preferences, including work location and work arrangement.
- **Travel** remains separate and should be favorable when the role requires meaningful travel.
- Administrative eligibility facts must never raise or lower Aim, Experience, travel, or pass/fail.
- Administrative facts include ordinary driver's license, driving record/MVR, reliable transportation, personal vehicle, automobile insurance, work authorization, visa sponsorship, background check, drug screen, security clearance, minimum age, immunization/onboarding health checks, physical-capability boilerplate, and ability/willingness to travel.
- Travel percentage and territory still inform `travelScore`; the fact that an applicant must be able to travel does not affect Experience.
- Role-defining professional credentials such as RN, CPA, or Property & Casualty licensure should be surfaced separately as `verification needed` when unknown. They must not be treated as proven by unrelated experience, but inventory silence must not become a false factual claim. Do not let them masquerade as experience.
- If the existing schema cannot represent a separate verification note safely, keep the fact informational and score-neutral for this bounded repair. Do not invent a credential or silently reject the job.

## Agy Input Contract

Agy must not receive the raw job description. Build a deterministic evaluation packet first.

Retain only:

- title and company;
- work location, remote/onsite arrangement, and explicit residency requirements;
- territory and stated travel percentage/frequency;
- core responsibilities that define the job;
- explicitly required experience and tenure;
- explicitly preferred experience;
- specialized domain requirements;
- role-defining qualifications, labeled separately from Experience;
- explicitly stated compensation, kept separate from Experience.

Strip before Agy sees the input:

- EEOC, affirmative-action, and applicant-rights language;
- disability and accommodation notices;
- background-check, drug-screen, MVR, work-authorization, and onboarding boilerplate;
- 401(k), health insurance, PTO, parental leave, wellness, tuition, and other benefits;
- company-culture, employer-brand, and "why join us" marketing;
- application instructions, privacy notices, cookie notices, legal disclaimers, and pay-transparency explanations;
- navigation, related jobs, SEO lists, login portals, browser warnings, scraped HTML debris, and duplicated page furniture;
- administrative eligibility facts from Experience evaluation;
- irrelevant corporate history and generic mission statements.

The deterministic packet should have explicit sections similar to:

```text
ROLE
WORK LOCATION AND TRAVEL
CORE RESPONSIBILITIES
REQUIRED EXPERIENCE
PREFERRED EXPERIENCE
ROLE-DEFINING QUALIFICATIONS
COMPENSATION
```

Fail closed to JD review when the system cannot reliably identify core job content. Do not pass raw content through as a fallback.

## Mixed Requirements

Do not let an administrative clause mask or erase a real experience clause.

For a sentence such as:

```text
Required: 2-3 years of business experience, a valid driver's license, and B2B sales experience.
```

the Experience decision must evaluate the experience-bearing clauses while treating the driver's-license clause as unknown and score-neutral. The stored explanation may disclose that administrative eligibility was not evaluated, but it must not claim Joseph lacks the license or reduce the score.

Prefer deterministic targeted decomposition into experience versus administrative clauses if it can be made reliable. If the existing hash-bound candidate contract must remain unsplit, define and test an explicit score-neutral administrative treatment without falsely marking the whole sentence unsupported.

## Primary Files

Start with these files only:

- `.agents/agents/standard-job-evaluator-v6/agent.md`
- `src/lib/nativeScoringBatch.ts`
- `src/lib/mandatoryRequirements.ts`
- `src/lib/jobDescriptionQuality.ts`
- `scripts/prepare_native_scoring_phase.ts`
- `scripts/direct_import.ts`
- `src/lib/scoringPolicy.ts`
- `src/lib/__tests__/nativeScoringBatch.test.ts`
- `src/lib/__tests__/nativeScoringProfile.test.ts`
- `src/lib/__tests__/mandatoryRequirements.test.ts`
- `src/lib/__tests__/qualificationGolden.test.ts`
- `scripts/native_scoring_canary.ts`
- `docs/CAREER_DASHBOARD_REPAIR_RUNBOOK_2026-08-09.md`

Inspect another file only when one of these directly references it or a failing test identifies it.

## Required Implementation

1. Review the interrupted V6.10.2 diff and remove every path where administrative eligibility or missing inventory evidence changes Aim, Experience, travel, qualification aggregates, or pass/fail.
2. Implement the deterministic Agy evaluation-packet sanitizer.
3. Bind the sanitized packet—not the raw JD—to the chunk/manifest hash so the evaluator cannot read omitted boilerplate.
4. Preserve the complete original JD in the database and dashboard for human review; sanitation affects only the evaluator input.
5. Keep professional credentials truthful and separate from Experience. Unknown means verification needed, not candidate failure.
6. Update prompt, parser, canary, and golden tests together. Bump the standard prompt version once to the final reviewed version; do not create a chain of speculative prompt bumps.
7. Add real-posting fixtures proving:
   - EEOC and benefits text never reaches Agy;
   - driver/MVR/transportation does not alter Experience or pass;
   - travel willingness is Experience-neutral while travel percentage still affects travel score;
   - work authorization/background/physical boilerplate is score-neutral;
   - a mixed experience-plus-license sentence still evaluates its experience clauses;
   - missing inventory evidence never becomes a negative factual assertion;
   - a role-defining professional credential is represented as unknown/verification-needed rather than invented or scored as experience;
   - page debris, cookie text, navigation, related jobs, and legal boilerplate are removed;
   - core duties and required/preferred experience remain intact and ordered.

## Canary Contract

Do not launch the 150-job backlog during the interactive Codex task.

Use an 8-12 job canary containing:

- Graco `Manager, Channel Sales`;
- ButterflyMX high-travel remote territory role;
- Radformation high-travel remote/global territory role;
- a driver-license/MVR posting;
- a work-authorization or background-check posting;
- a mixed experience-plus-license requirement;
- a role-defining professional-credential posting;
- a posting dominated by benefits/EEOC/scraped-page boilerplate.

Before any import, manually review the exact sanitized packet and every result. Release criteria:

- no irrelevant boilerplate in Agy input;
- no administrative fact changes Aim, Experience, travel, or pass;
- no inventory absence is described as a known candidate deficiency;
- core requirements remain complete;
- zero deterministic validation failures;
- correct model and prompt provenance;
- no human decision or tailoring-staged job is touched.

If one canary job exposes a policy defect, stop. Do not retry the entire canary repeatedly and do not proceed to the backlog.

## Verification and Rollout

After focused tests are green:

1. Run the full suite, typecheck, lint, scoring canary, Prisma validation, `git diff --check`, and production build once.
2. Confirm the worktree contains only the intended final changes and this handoff file.
3. Commit the final correction. Preserve unrelated user files.
4. Confirm GitHub `PI_ACTIVATION_MODE=maintenance` before pushing.
5. Push `main`; this automatically deploys to the Pi.
6. Monitor the GitHub Actions deployment and verify the exact Pi commit, health endpoint, schema, canonical resume hash, and maintenance state.
7. Run the strict readiness audit. Stop on any violation.
8. Remove or restore the GitHub maintenance variable only after the verified maintenance deployment.
9. Enable the Pi ingestion cron exactly once and verify a single managed block.
10. Install/load the validated Mac watcher using label `com.josephlamb.career-dashboard-native-scoring`.
11. Create a fresh scoring request only after deployment and readiness are complete.
12. Let the validated backlog process asynchronously. Report its request ID and monitoring controls, then end the Codex task rather than waiting synchronously for every score.

## Completion Definition

The work is finished only when:

- the final code follows the evidence and scoring semantics above;
- raw JDs are not sent to Agy;
- the canary passes manual and deterministic review;
- the intended commit is pushed and the GitHub-driven Pi deployment succeeds;
- production health and strict readiness pass;
- ingestion cron and the Mac watcher are enabled exactly once;
- the scoring backlog is safely running asynchronously or is intentionally queued with an explicit reason;
- no incorrect V6.10.1 administrative-penalty result was imported;
- Joseph receives a concise final report with commit, deployment, canary, queue, and rollback evidence.
