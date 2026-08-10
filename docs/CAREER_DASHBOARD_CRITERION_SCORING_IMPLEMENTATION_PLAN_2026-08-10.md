# Career Dashboard Criterion Scoring Implementation Plan

Date: 2026-08-10
Workspace: `/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard`

## Goal

Replace vague holistic A/E scoring with a deterministic, auditable criterion-by-criterion system. Agy evaluates each atomic job requirement against verified candidate evidence; application code derives the score, salary display, travel display, and a durable evidence-gap register.

Work token-efficiently. Use Medium reasoning, never Ultra, and do not spawn subagents. Inspect only the files named here and direct dependencies. Preserve unrelated local changes. Use focused tests while implementing, then run the full validation gates once. Do not synchronously process the scoring backlog.

This plan is the current authority where it conflicts with `CAREER_DASHBOARD_SCORING_FINISH_HANDOFF_2026-08-09.md`, specifically for criterion scoring, Gemini 3.6 Flash High, the evidence-gap register, travel presentation, and the finish line after pushing. Retain the older handoff's sanitizer, evidence-safety, bounded-canary, and no-raw-JD requirements where they do not conflict.

## Current Worktree Warning

At plan creation, `main` equals `origin/main` at `06e66ea` and the following files already contain uncommitted work that belongs to the current scoring repair:

- `.agents/agents/standard-job-evaluator-v6/agent.md`
- `scripts/native_scoring_canary.ts`
- `src/lib/__tests__/nativeScoringBatch.test.ts`
- `src/lib/__tests__/nativeScoringPacket.test.ts`
- `src/lib/__tests__/nativeScoringProfile.test.ts`
- `src/lib/nativeScoringBatch.ts`
- `src/lib/nativeScoringPacket.ts`

Review and preserve this work. Do not discard, revert, or overwrite it. Confirm the live status before editing because this list is only a snapshot.

## Authoritative Product Decisions

### Atomic criteria

- Deterministically extract individual requirements from the sanitized evaluation packet.
- Do not ask Agy for a holistic 0-100 score.
- Keep each criterion singular. Split bundled requirements when the clauses can be separated without changing meaning.
- Preserve the original wording, source section, source span, stable requirement ID, and whether the criterion is `required` or `preferred`.
- Required and preferred criteria must be scored separately.
- Administrative eligibility is not a scoring criterion.

### Criterion outcomes

Agy must return exactly one evidence outcome for every supplied criterion, in order:

- `direct`: verified evidence directly establishes the complete criterion.
- `partial`: verified evidence is genuinely adjacent or establishes only part of the criterion.
- `cannot_evaluate`: available evidence is silent or insufficient to decide.
- `does_not_meet`: verified evidence affirmatively conflicts with the criterion. Mere inventory or resume silence can never produce this outcome.
- `excluded`: reserved for deterministic application-code classification of administrative eligibility; Agy must not invent or apply it.

Every non-excluded result must include a concise rationale. `direct` and `partial` must cite valid evidence IDs. `cannot_evaluate` and `does_not_meet` must cite no supporting evidence IDs unless a separate conflict-evidence field is deliberately added and validated. Never describe `cannot_evaluate` as a known candidate deficiency.

Role-defining credentials such as RN, CPA, or Property and Casualty licensure are score-neutral verification items when evidence is unavailable. Record them as `cannot_evaluate`, include them in the evidence-gap register, and exclude them from Experience and pass/fail until Joseph confirms them. Ordinary software-product licensing knowledge is not a candidate-owned credential and must be evaluated normally.

### Deterministic scoring

Application code, not Agy, calculates Experience Fit from the criterion outcomes:

- Required criteria contribute 80 percent of the uncapped score.
- Preferred criteria contribute 20 percent.
- Within either group: `direct = 1.0`, `partial = 0.5`, `cannot_evaluate = 0`, and `does_not_meet = 0`.
- If the posting has no preferred criteria, normalize the required portion across the full 100 points.
- A required `partial` caps Experience Fit at 79.
- A required `cannot_evaluate` caps Experience Fit at 69 and prevents a fully-qualified label without claiming failure.
- A required `does_not_meet` caps Experience Fit at 59.
- Preferred outcomes never create a mandatory failure or mandatory cap.
- Excluded administrative items and score-neutral professional-credential verification items are absent from denominators and caps.
- Aim remains a separate preference-fit dimension. Administrative eligibility and qualification evidence must not affect it.

The implementation must deterministically recompute and validate all aggregates. Reject model output when ordered criterion coverage, evidence citations, classifications, or derived fields disagree.

### Evidence semantics

- The evidence inventory is positive evidence, not an exhaustive list of everything true about Joseph.
- Absence means unknown, not false.
- `does_not_meet` requires affirmative, verified conflicting evidence.
- Do not silently add facts to the evidence inventory from Agy output, a job description, a score explanation, or this gap register.
- Inventory changes require Joseph's deliberate confirmation through the established evidence-maintenance process.

### Evidence-gap register

After a validated standard-score import commits, regenerate a durable running report from the latest authoritative standard score event for every job. The report should be named:

`docs/CANDIDATE_EVIDENCE_GAPS.md`

Treat that Markdown file as a generated local runtime artifact and add its exact path to `.gitignore`; routine scoring must not leave unexplained tracked changes. Store deliberate manual status annotations in the tracked file `data/candidate_evidence_gap_annotations.json`. Create that annotation file with an explicit versioned schema and an empty initial entry map.

The database's latest accepted `JobScoreEvent.mandatoryRequirementAssessments` records are the source of truth; do not append blindly to the Markdown file. Regenerate it deterministically so rescoring can remove resolved gaps.

Include only:

- qualification-relevant `cannot_evaluate` criteria;
- score-neutral role-defining credentials awaiting confirmation.

Permanently exclude:

- driver's license, MVR, transportation, vehicle, and insurance;
- work authorization, sponsorship, background checks, drug screens, age, physical boilerplate, and other administrative eligibility;
- travel willingness, explicit travel percentage, and territory;
- salary and compensation;
- criteria classified `does_not_meet`.

Deduplicate by a deterministic normalized concept key. Consolidate obvious wording variants only with bounded, reviewable rules; never use Agy to rewrite the register. Preserve all original criterion text and job provenance beneath the consolidated entry.

Each entry must contain:

- stable concept key and plain-language evidence question;
- status (`Open`, `Answered`, `Inventory Updated`, or `Not Applicable`);
- required/preferred occurrence counts;
- total occurrence count;
- first and latest occurrence dates;
- company, title, job ID, and job URL when available;
- exact original criterion wording;
- latest model, prompt version, evidence hash, and score-event ID.

The generated active register is not itself an evidence authority. A gap leaves the active list only when the latest accepted rescore no longer returns `cannot_evaluate`, or when a separate manual annotation marks it `Not Applicable`. Preserve manual annotations in a small separate data file so regeneration never overwrites them. Fail the report refresh visibly after a successful import rather than rolling back an already committed score transaction.

Provide a standalone command to regenerate and validate the report without scoring. The normal standard import path must call the same implementation after the database transaction succeeds. Routine report generation must never modify the tracked annotation file.

### Salary

- Extract only compensation explicitly stated in the posting's sanitized compensation section.
- Preserve base-versus-OTE distinctions, currency, period, geographic variants, and stated bonus or commission context.
- Never estimate undisclosed compensation.
- Salary is displayed separately and never changes Aim or Experience.

### Travel

- Extract travel deterministically from explicit job-description language before Agy.
- No travel statement means `0%`. Never infer travel from title, industry, territory, or similar jobs.
- Preserve a stated point (`50%`), range (`50-75%`), maximum (`up to 50%`), minimum (`at least 50%`), or qualitative frequency when no percentage is supplied.
- Replace the single travel score display with a horizontal 0-100% range track. For `50-75%`, only the 50-75 segment is filled.
- Point values use a narrow marker or zero-width point treatment at the stated percentage. Ranges occupy only their stated interval.
- The text label must show the JD wording or normalized explicit range. Nothing stated displays `0%`.
- Travel remains separate from Experience and Aim.

## Model Contract

Use Agy Gemini 3.6 Flash High for criterion evaluation. Update the configured model identifier, prompt provenance, tests, canary assertions, and watcher launch contract together. Do not silently fall back to Gemini 3.1 Pro or another model. If the locally available Agy CLI uses a different exact identifier for Gemini 3.6 Flash High, resolve it from local Agy configuration/help without broad internet research and bind that identifier explicitly.

Agy receives only the deterministic sanitized packet, ordered criteria, and trusted evidence packet. It must not receive the raw JD and must not calculate the aggregate score, salary, or travel range.

## Primary Files

Begin with these files and inspect another file only when directly referenced or required by a focused failure:

- `docs/CAREER_DASHBOARD_SCORING_FINISH_HANDOFF_2026-08-09.md`
- `.agents/agents/standard-job-evaluator-v6/agent.md`
- `src/lib/nativeScoringBatch.ts`
- `src/lib/nativeScoringPacket.ts`
- `src/lib/mandatoryRequirements.ts`
- `src/lib/scoringPolicy.ts`
- `scripts/prepare_native_scoring_phase.ts`
- `scripts/direct_import.ts`
- `scripts/native_scoring_next.ts`
- `scripts/native_scoring_watcher.ts`
- `scripts/native_scoring_canary.ts`
- `src/lib/jobScoreAuthorityQuery.ts`
- `src/lib/__tests__/nativeScoringBatch.test.ts`
- `src/lib/__tests__/nativeScoringPacket.test.ts`
- `src/lib/__tests__/nativeScoringProfile.test.ts`
- `src/lib/__tests__/mandatoryRequirements.test.ts`
- `src/lib/__tests__/qualificationGolden.test.ts`
- `src/components/JobCard.tsx`
- `src/components/ExpandOverlay.tsx`
- `src/types/job.ts`
- `src/app/api/jobs/[id]/route.ts`
- `prisma/schema.prisma` only if the final design truly requires schema changes; prefer the existing score-event JSON authority.

Follow the repository `AGENTS.md`. This Next.js version has local documentation under `node_modules/next/dist/docs/`; read only the directly relevant guide before modifying Next.js UI or route code.

## Implementation Sequence

1. Reconcile the current dirty diff with this plan. Preserve correct sanitizer and positive-only narrative hardening.
2. Change the requirement candidate contract to retain required/preferred classification and atomic provenance.
3. Change the evaluator output from holistic support semantics to the exact criterion outcomes above.
4. Move aggregate Experience scoring, caps, labels, and validation entirely into deterministic application code.
5. Update score-event persistence and dashboard response types without losing historical records.
6. Implement the deterministic evidence-gap materializer, manual annotation file, standalone refresh command, and post-import refresh.
7. Implement explicit compensation preservation and deterministic travel extraction/range representation.
8. Replace the travel-number UI with the horizontal range track and accessible text.
9. Bind Gemini 3.6 Flash High everywhere and bump the final prompt/schema versions once after the contract stabilizes.
10. Update focused parser, scoring, materializer, import, UI, golden, and canary tests.

## Required Focused Tests

Prove at minimum:

- required and preferred criteria remain separate and ordered;
- bundled clauses split without losing their source text or mandatory status;
- every criterion receives exactly one valid outcome;
- inventory silence can produce `cannot_evaluate` but never `does_not_meet`;
- affirmative conflicting evidence is required for `does_not_meet`;
- the 80/20 calculation, no-preferred normalization, and 79/69/59 caps are deterministic;
- administrative eligibility is excluded from scoring and the gap register;
- a professional credential becomes a score-neutral evidence gap;
- gap entries deduplicate deterministically while retaining all job and wording provenance;
- regenerating the report is idempotent;
- a newer direct/partial assessment removes a resolved gap from the active report;
- manual annotations survive regeneration;
- explicit salary is preserved and unstated salary remains null;
- unstated travel is exactly 0 with no inference;
- point, range, up-to, at-least, and qualitative travel statements parse correctly;
- the travel track fills only the stated interval and has an accessible text equivalent;
- raw JD boilerplate never reaches Agy;
- prompt, model, schema, manifest, and hash provenance fail closed when mismatched.

## Bounded Agy Canary

Do not run the full backlog interactively. Use the handoff's existing 8-12-job canary, adding examples that exercise required/preferred weighting, `cannot_evaluate`, `does_not_meet`, salary, and travel ranges.

Run Agy asynchronously with one bounded canary request. Do not narrate the run or repeatedly poll it. Record the request ID, set a reasonable check interval or return time, and inspect it only after that interval. Stop on the first policy or contract defect. Do not burn usage through repeated whole-canary retries.

Before importing, manually review the compact packets and criterion results. The canary passes only if all outputs are evidence-safe, complete, correctly classified, deterministically scored, and free of salary/travel inference.

## Final Validation and Finish Line

After focused work is green, run these gates once:

- full test suite;
- typecheck;
- lint;
- deterministic scoring canary;
- bounded Agy canary if Agy output behavior changed;
- Prisma validation only if Prisma-related code or schema changed;
- `git diff --check`;
- production build;
- final worktree and staged-scope review.

Do not redo unrelated ingestion, Stats, schema, database, or deployment audits unless a relevant check fails or that area was modified.

When every required gate passes:

1. Commit only the intended changes, including the pre-existing scoring-repair work after it has been reviewed and validated.
2. Push `main` to GitHub so the normal Raspberry Pi deployment begins.
3. Stop. Do not monitor GitHub Actions or the Raspberry Pi deployment. Joseph will report a deployment failure if one occurs.

Do not activate or synchronously wait for the full scoring backlog as part of this task. Do not claim the deployment was verified merely because the push succeeded. The task's completion report should contain only the commit hash, pushed branch, tests/canary summary, and any deliberately deferred operational action.
