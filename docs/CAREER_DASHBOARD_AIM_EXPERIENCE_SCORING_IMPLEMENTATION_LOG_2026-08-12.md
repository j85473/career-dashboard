# Career Dashboard Aim and Experience Scoring Implementation Log

This log records cutover evidence and dirty-work disposition for the implementation governed by `CAREER_DASHBOARD_AIM_EXPERIENCE_SCORING_IMPLEMENTATION_PLAN_2026-08-12.md`. It is not a scoring result, deployment approval, or production mutation record.

## Phase 0 safety snapshot — 2026-08-12

- Branch: `main`, upstream `origin/main`, both at `dbc8a8b` before implementation edits.
- Canonical Mac resume and repository mirror both SHA-256 `23ceb1cb09d9ec8d0350ae4da96da018b26517c0f9b58dbe2762f0e44e0ad059`.
- Core Evidence SHA-256 `7214b8a66d49cad0af43fb8ef6fc253c7b7f78e89b104ee8ecfba575dcfed67e`.
- `.agents/scoring-lock.json` absent.
- Native scoring LaunchAgent plist present and disabled. It was not changed.
- Native job/context/local scoring leases: zero. The sole native request is historical and failed, with a stale `activeKey`; no native worker is running. It must be reconciled before cutover.
- The ordinary ingestion pipeline was live. Its pipeline lock and one JD-extraction lease are not scoring work and were not changed.
- Production database, LaunchAgent, Agy grants, external skill, Git remote, and Pi were not mutated.

## Pre-existing dirty-work disposition

| Path | Disposition |
|---|---|
| `.agents/agents/context-job-evaluator-v6/agent.md` | Port compatible preference-safety language into versioned neutral policy/fixtures, then retire from active registration. |
| `.agents/agents/standard-job-evaluator-v6/agent.md` | Port evidence semantics and useful fixtures, then retire from active registration. |
| `scripts/native_scoring_canary.ts` | Port gold fixture identities/order only; retire native execution. |
| `scripts/prepare_native_scoring_phase.ts` | Port neutral hashes/bindings only where they satisfy the manual contract; retire native orchestration. |
| `src/lib/__tests__/candidateEvidenceGaps.test.ts` | Preserve and adapt to staged Experience authority. |
| `src/lib/__tests__/nativeScoringBatch.test.ts` | Harvest neutral contract and evidence cases; native-only coupling may remain unreachable through canary. |
| `src/lib/__tests__/nativeScoringPacket.test.ts` | Port contamination and source-retention fixtures into neutral cleaner tests. |
| `src/lib/__tests__/nativeScoringProfile.test.ts` | Port canonical resume/evidence binding cases. |
| `src/lib/mandatoryRequirements.ts` | Supersede fallback/invented hard requirements; retain only compatible source/logical helpers. |
| `src/lib/nativeScoringBatch.ts` | Port neutral validation semantics deliberately; retain unreachable only through canary. |
| `src/lib/nativeScoringPacket.ts` | Port source contamination protections only where compatible with source-preserving cleaning. |
| Deleted criterion plan and new consolidated plan | Preserve consolidation: the 2026-08-12 plan is the sole design authority. |

No pre-existing dirty file may be reset or broadly checked out during this implementation.

## Implemented locally — 2026-08-12

- Added closed versioned Aim and Experience policies, employer overrides, four strict exchange schemas, worker schemas/prompts, shared canonical fixtures, and deterministic TypeScript/Python arithmetic.
- Added durable manual `ScoringBatch`, `ScoringBatchItem`, and `JobScoringArtifact` models plus staged `JobScoreEvent` lineage/provenance fields in one forward-only migration. Historical native tables and rows remain preserved.
- Added exact batch export/re-download/extend/release, 32 MiB same-origin mutation guards, read-only preview, 15-minute exact-payload HMAC approval, repeated row-locked validation, atomic apply, completed-result idempotency, and protected lifecycle preservation.
- Added independent staged Aim/Experience authority, input-version reconciliation, source/global invalidation, machine-lifecycle recovery, authoritative job/detail/list/search/stats projection, disclosed-travel display caching, and the deterministic Experience evidence-gap register.
- Removed native request creation from pipeline/task/UI/API routes; retired native mutation routes with HTTP 410; replaced the Dashboard controls and stats presentation with the manual exchange.
- Added separate database-free Python Aim and Experience runners. Each semantic worker receives one job in a fresh read-only `codex exec` invocation with Terra Medium by default and bounded Terra High repair only; no runner can access the database, Dashboard import, shell tool, browser, apps, or arbitrary network tools.
- Created and validated `/Users/JosephLamb/.codex/skills/career-dashboard-scoring-protocol/` with a thin launcher contract. No model scoring run was performed.
- Rewrote active repository scoring instructions and added explicit retirement banners to historical V6/native runbooks.

All behavior-affecting policies, exchange schemas, runner protocol, worker prompts, evidence, resume, and employer overrides contribute to the current global input fingerprints. Per-job semantic `inputHash` binds the relevant global fingerprint.

## Verification completed locally

- `npx tsc --noEmit`: pass.
- Full `npm test`: 347/347 pass.
- Python `unittest` discovery: 8/8 pass.
- Focused ESLint for new/changed manual-scoring paths: pass.
- `npx prisma format --check` and `npx prisma validate`: pass.
- `npm run build`: pass. Turbopack dynamic-path warnings were scoped with explicit ignore annotations for the generated evidence-gap artifact.
- Read-only `npm run scoring:manual:audit`: correctly reports `ready: false` with three exact blockers: `manual_scoring_schema_missing`, `failed_native_active_key_requires_reconciliation`, and `native_scoring_reachable`. It also confirms zero legacy manual-export leases, zero native job leases, zero nonterminal native requests, and no pipeline native-request creator.
- Official Codex non-interactive/Skills documentation and installed CLI were checked. Installed CLI is `codex-cli 0.146.0`; its local model catalog exposes `gpt-5.6-terra` Medium/High.
- Personal skill validation: `Skill is valid!` using the official validator with pinned temporary PyYAML 6.0.2.

## Intentionally not performed

- No migration was applied to the live/local Dashboard database.
- No 10-job model canary, Dashboard import, recovery apply, Mac LaunchAgent/Agy-grant mutation, commit, push, or Pi deployment was performed.
- Rendered manual-panel QA could not be completed against the running Dashboard because the database has not received the new forward migration; the current server correctly fails closed rather than treating absent manual-scoring tables as usable.

## Approval-gated cutover remainder

The repository still exposes the superseded package commands, V6 hook/script, four V6 agent directories, and underlying native watcher/import/repair entrypoints. Removing those exact historical executables and changing the external LaunchAgent/Agy grants requires Joseph's explicit cutover approval. Until then, `scripts/audit_manual_scoring_readiness.ts` reports native reachability and production enablement is a no-go.

## Approved cutover execution — 2026-08-12

- Removed every package command listed for native request/runner/watcher exposure and legacy score-authority mutation. `scoring:status`, `scoring:audit`, and `audit:repair-readiness` now run the read-only manual audit; `scoring:exchange:validate` is the DB-free exchange validator.
- Removed the native boundary hook and script, the named watcher/request/import/release/repair executables, the native canary, and all four registered V6 scoring-agent directories. Historical database records, migrations, run artifacts, and unreachable native libraries remain preserved.
- Replaced deploy quiescence checks for active native requests with durable manual-batch/lease checks. Retired API routes remain HTTP 410 and the pipeline has no native creation call.
- Applied `20260812170000_manual_scoring_exchange_v1` to the configured Dashboard database. The first attempt rolled back completely when a historical orphaned `JobScoreEvent` prevented validation of a new job foreign key. The corrected migration preserves those rows with a PostgreSQL `NOT VALID` foreign key, which enforces all new inserts/updates without deleting or fabricating historical parents. The reapply succeeded and Prisma reports the schema up to date.
- The migration cleared only `activeKey` values on requests already in `failed` status. The historical failed row remained otherwise unchanged.
- Moved `/Users/JosephLamb/Library/LaunchAgents/com.josephlamb.career-dashboard-native-scoring.plist` to Trash as `com.josephlamb.career-dashboard-native-scoring.plist.retired-20260812T1718Z`. `launchctl` confirms that service is not loaded.
- Revoked exactly four scoring-specific Agy grants: `scoring:request`, `scoring:next`, and read/write access to `.agents/eval_runs`. Eleven unrelated grants remain. A protected pre-change backup is `/private/tmp/antigravity-settings-before-scoring-grant-revocation-20260812T1718Z.json`.
- Rendered the manual exchange at the default desktop viewport and 390 by 844. Aim and Experience stage copy, calibration badges, empty/active batch state, exact re-download, extension, release, upload, and responsive wrapping were visually verified. The preview modal could not be rendered with live results because the external canary stopped before producing a complete result file.

## Ten-job Aim canary — stopped before preview

- Batch ID: `426bf3de-6eaf-4c73-b7d9-761abc025bc1`.
- Exact stored export: `/Users/JosephLamb/Downloads/career-dashboard-aim-export-426bf3de-6eaf-4c73-b7d9-761abc025bc1.json`.
- Membership: 10; export SHA-256: `ae6c26cfb146f77a72e7f02002a03d9d60950bacfa24098a6ebce2475672cc94`; expiry: `2026-08-13T17:19:45.625Z`.
- The database-free personal scoring protocol stopped on job ordinal 0 during `jd_cleaner`. Counts at stop: submitted 10; accepted 0; repaired 0; resumed 0; safe failures 0; interrupted invocations 1; final validator not reached; no result file exists.
- Exact failure: `jd_cleaner Codex invocation failed`; stderr contained repeated `codex_rollout::list: state db discrepancy during find_thread_path_by_id_str_in_subdir: falling_back` warnings and no accepted worker output.
- Per the scoring-protocol skill, no fallback model, manual output repair, automatic retry, upload, preview, or import was attempted. The complete 10-member Aim batch remains visibly leased for exact re-download, explicit extension, or explicit release.

## Current verification and production blocker

- `npx tsc --noEmit`: pass.
- Full `npm test`: 325/325 pass after retiring native-only executable/hook tests and updating deployment quiescence assertions.
- Python `unittest` discovery: 8/8 pass.
- Full ESLint: zero errors and five pre-existing/known unused-code warnings in `jobFiltering.ts` and `jobScoring.ts`.
- `npx prisma validate`: pass; `prisma migrate status`: database schema up to date.
- `npm run build`: pass.
- Rendered UI route/API traffic returned HTTP 200 for both stage panels and active-batch state.
- A clean post-migration audit initially reported `ready: true`. At `2026-08-12T17:16:13.402Z`, the still-running older Pi deployment created native request `29982017-dc67-447b-80e5-14ec4dbbcc13` with source `pipeline`, status/phase `queued`, `activeKey = global`, attempt 0, and no claim, heartbeat, worker, or error. The disabled/removed Mac runner cannot claim it.
- Final readiness therefore correctly reports `active_native_request` and `ready: false`. Local code cannot create or process that request; eliminating its production creator requires separate Git/Pi deployment authority, and cancelling the newly queued row requires separate explicit request-state authority. Neither action was inferred or performed.

## Completion-audit hardening and deployment authorization

- Joseph subsequently authorized both exact remaining actions: cancel only native request `29982017-dc67-447b-80e5-14ec4dbbcc13`, and perform the repository hygiene commit/push that starts the existing GitHub-driven Pi deployment. Aim and Experience imports remain separately approval-gated.
- Corrected the Aim import lineage so the newly created immutable `JobScoringArtifact` is bound to both the imported `JobScoreEvent.cleanedJdArtifactId` and its `ScoringBatchItem.cleanedArtifactId`.
- Changed staged compensation display projection to use the immutable Aim event `compensationAssessment`, including explicit base-versus-total wording, instead of trusting the mutable legacy `Job.compensation` cache.
- Added isolated transaction tests proving zero-write preview, exact HMAC preview binding and expiry, forced mid-transaction rollback with zero persisted writes, atomic Aim apply, cleaned-artifact lineage, exact idempotent replay, divergent replay rejection, byte-identical stored re-download, retained leases through supersession, whole-batch release, and the migration's concurrent batch/lease cardinality constraints.
- Focused completion-audit gates: `npx tsc --noEmit` passed; six new batch/import tests passed; seven staged authority tests passed.
- Installed a new random 96-character `SCORING_APPROVAL_SECRET` in the Pi's preserved `/opt/career-dashboard/.env` without printing its value. Production activation now requires the setting and enforces the same minimum 32-byte bound as preview/apply.
- Post-hardening full gates: 334/334 TypeScript tests passed after the deployment-policy repair; Python remained 8/8; build, typecheck, Prisma format/validate, and full lint all passed with zero errors and the same five unrelated unused-code warnings.
- Through a temporary read-only SSH database tunnel, Prisma reported all 10 migrations applied and input reconciliation reported no stale Aim events, Experience events, artifacts, superseded batches, requeued jobs, or Action Needed jobs. Readiness still has exactly the expected authorized blocker: native request `29982017-dc67-447b-80e5-14ec4dbbcc13` remains active until the new production release removes its creator.
- Initial GitHub deployment run `31623508416` failed safely before backup, migration, or activation because the expand-only checker rejected the migration's already-applied bounded `UPDATE` that clears `activeKey` only on terminally failed historical native requests. The failed stage was removed and the old service remained healthy.
- The deploy checker now permits only that exact reconciliation statement; a queued-status near miss remains rejected. The checker passes all 10 migrations, and the focused deployment/typecheck suite passes 19/19.
- Repair commit `14954e2` deployed successfully in GitHub run `31623992440`. The active Pi importer hash matched the commit, the retired watcher file was absent, the scoring approval secret passed its length check, systemd restarted cleanly, and `/api/health` reported database/schema/migration healthy.
- Cancelled only native request `29982017-dc67-447b-80e5-14ec4dbbcc13`; it moved from untouched queued attempt 0 to `cancelled`, cleared `activeKey`, and remained absent from readiness after the new pipeline ran. Production readiness then reported `ready: true` with zero violations.
- A post-deploy reconciliation dry run correctly identified that the final EOF cleanup had changed the four Aim prompt byte hashes after export. No scoring retry or reconciliation write was attempted. Restoring one intentional terminal blank line to exactly those four prompts reproduces the stored batch `aimInputVersionsHash` `61f19e6d008ece8e630933e199bf5d9b882396ac1fee2dab93027105a115a402`; path-scoped `.gitattributes` entries keep `git diff --check` strict everywhere else.

## Span-only cleaner v2 correction — 2026-08-12

- Root cause analysis of ordinal 5 (`Senior Marketing Partnerships Manager`, Razer) found that the v1 cleaner returned a 5,827-code-point `cleanedText` while its sole declared span implied 6,856 code points. It silently omitted 1,029 additional code points, so the deterministic validator correctly rejected it. Subsequent long structured generations repeatedly ended upstream with `reason: content_filter`; the full unmodified JD succeeded as inert input, and a compact span-only probe succeeded.
- Added `jd-cleaner-v2`: the semantic worker now returns only ordered `removedSpans`. Python validates exact quotes, order, overlap, and non-empty spans, then reconstructs `cleanedText` from the normalized source. Targeted repair carries only prior spans plus validator findings.
- The Dashboard independently reconstructs source-minus-spans during import validation and rejects any inconsistent artifact. Non-completed batches whose global scoring-input version is stale are rejected with an explicit release/re-export requirement; completed exact replay remains readable.
- The v2 cleaner version and prompt bytes participate in the Aim input fingerprint. Python and TypeScript independently produced the same fingerprint: `7665b4270b28a60399cd18811502d8c22fcc375ca265b0b699958ce17b64144a`. The preserved v1 export is now rejected before model work as stale, preventing old checkpoint reuse or mixed-contract results.
- Focused verification: 11/11 Python protocol tests and 14/14 scoring foundation/import tests passed. Full repository tests passed 337/337. Full ESLint completed with zero errors and the same five unrelated existing warnings. Production build and TypeScript compilation passed.
- Isolated live canary against the exact unmodified Razer JD passed: `jd-cleaner-v2`, Terra Medium, one removed span, 7,284 source code points, 6,858 deterministically reconstructed code points, and coverage `complete: true` with zero findings. The canary used a temporary directory and did not touch batch checkpoints, the database, import state, Git, or production.

## Mixed-result continuation and review run — 2026-08-12

- Replaced batch-level fail-stop behavior with per-job terminal outcomes. A bounded worker invocation error is now recorded as `worker_invocation_failed`; coverage and evaluator exhaustion remain `coverage_incomplete` or `result_untrustworthy`. The runner validates and checkpoints the safe failure, continues to the next ordinal, and still produces one complete exact-membership result file.
- Mixed Dashboard preview remains zero-write and approval-bound. Atomic apply imports only validated evaluations, marks their items `imported`, marks safe-failure items `released`, leaves failed jobs and lifecycle state unchanged, and completes the batch with the exact accepted result hash. Exact replay reports imported and released counts without duplicating writes.
- Updated the manual-scoring UI to show the mixed projection, identify failed items as queue releases, and label the approval action with exact import/requeue counts. The dry-run and explicit approval boundary remain intact.
- Verification passed: 12/12 Python protocol tests, 15/15 focused scoring/import tests, 338/338 full TypeScript tests, TypeScript compilation, production build, and ESLint with zero errors and the same five unrelated existing warnings. Python and TypeScript independently produced Aim input fingerprint `efdd2c89daeb2e811fce3b09c0b1e2cdc9282680d40da463484d407a15f2a12c`.
- Released stale batch `ed7cfde9-88bf-4518-b9a8-6db90004d1df` and exported the exact same ten job IDs in replacement batch `8254bed3-cc80-4cb4-92af-97bff7675647`. The full run reached terminal outcomes for all ten jobs and produced validator-valid result hash `ad339f5e9d7f69de181668ca7c254f595e20936f7bb481dc59a97d85697719d1`: three Aim survivors scored 89, 71, and 79; seven safe failures remained scoreless.
- Dashboard zero-write preview independently recomputed the file as applicable with `acceptedCount = 3`, `safeFailureCount = 7`, score range 71–89, and seven `release_failed` projections. No result was applied; the batch remains exported pending Joseph's review and explicit approval.
- Joseph explicitly approved “apply the 3 and requeue the 7.” A fresh preview reasserted the exact result hash and 3/7 projection immediately before one atomic apply. Batch `8254bed3-cc80-4cb4-92af-97bff7675647` completed at `2026-08-12T20:56:57.538Z` with accepted result hash `ad339f5e9d7f69de181668ca7c254f595e20936f7bb481dc59a97d85697719d1`: three items are `imported`, seven are `released`, and the receipt reports `imported = 3`, `released = 7`.
- Post-apply verification found exactly three Aim score events, three independently validated cleaned-JD artifacts, and scores 89, 71, and 79 on the intended jobs. The seven failed jobs remain `pending_af` with null Aim scores, zero imported events, zero current Aim events, and zero active leases; all seven are therefore back in the Aim queue.

## Question-only Aim worker v4 and exact 20-job run — 2026-08-12

- Replaced model-authored JD rewrites, source offsets, score arithmetic,
  thresholds, final decisions, and exchange formatting with deterministic Python
  ownership. Python now segments each normalized JD into stable source blocks,
  reconstructs cleaned text from selected block IDs, resolves exact source
  bindings, applies every policy point/threshold, and builds the final artifact.
- The cleaner receives one JD block packet and may only select removable block
  IDs. The restore-only coverage reviewer sees only proposed removals. Cleaner or
  reviewer failure retains/restores source text and cannot fail the job.
- The evaluator receives exactly one retained-JD representation. It returns only
  question answers and block IDs. Ordinary model-assessed hard stops allow only
  `present` or `not_specified`; hunting allows only `specified` or
  `not_specified` so Python owns the one-third test. A `not_specified` answer
  carries no evidence and becomes `JD does not specify.` No negative proof is
  requested or accepted.
- Aim checkpoints are namespaced by `aim-question-workers-v4`, preventing the
  explicit legacy-export migration bridge from resuming an older runner result.
  Each fresh worker attempt also removes its prior output file first, preventing
  stale structured output from being mistaken for a new response.
- Python and TypeScript independently produced current Aim input fingerprint
  `811da8d72be46496e4c1ef6aa8b722739b1607a5d1373ca527bff232a1dc85cb`.
  The exact already-exported v2 batch remains accepted only through the pinned
  one-version compatibility bridge; every original per-job hash is still
  recomputed and verified.
- Final local gates passed: 19/19 Python protocol tests, 338/338 TypeScript tests,
  TypeScript compilation, production build, TypeScript exchange validation, and
  diff whitespace validation. ESLint previously completed with zero errors and
  the same five unrelated existing unused-variable warnings.
- Exact batch `24d214d3-3054-4473-be2c-e6258c5a62eb` ran in input order with the
  requested stop condition if ordinals 0-2 all ended in technical safe failure.
  The canary cleared and the complete run finished in 668.626 seconds: submitted
  20, accepted evaluations 20, safe failures 0, repairs 0, resumed checkpoints
  0, and 60 isolated worker invocations. The former recurring failure case at
  ordinal 5 completed normally.
- Final result:
  `/Users/JosephLamb/Desktop/Career Dashboard Scoring/career-dashboard-aim-results-24d214d3-3054-4473-be2c-e6258c5a62eb.json`.
  Exchange `resultHash` is
  `1d62904a6d87b9c894cf4e5ee7af19614d5452b8a7196ce4cfea4a49667001cf`;
  file SHA-256 is
  `c1e0dccefdffc54f6c83bcebb0eb0001bbb8dc205af43c59792bbb949f458d04`.
  It contains 19 hard-stop survivors and one explicit contract-position hard-stop
  rejection. No Dashboard preview, import, database write, commit, push, or
  deployment was performed for this scoring result.
- A repeat-run stability comparison remains an explicit calibration warning, not
  a runner failure: 9 of 19 numeric scores changed between the v3 and v4 clean
  invocations, with one 80-point threshold flip (`Serval`, 85 to 71). The largest
  absolute movement was 14 points. The finished v4 file is contract-valid but
  was intentionally left unapplied pending review of broad fit-band stability.

## Board loading-path verification — 2026-08-12

- Commit `1619436` removed the whole-board scoring-history CTE from discovery,
  count, sort, and paging. Boards now query indexed `Job` projections first and
  consult newest score-event authority only for the returned page. The UI also
  aborts a board request after 15 seconds and renders a visible retryable error.
- Against the running Dashboard, one-row requests for Inbox, Tailoring, Applied,
  Interviewing, Archived, and Travel Watch all returned HTTP 200 with real data
  in 0.074, 1.499, 0.480, 0.436, 2.579, and 3.216 seconds respectively.
- `main` and `origin/main` both point to `1619436`. GitHub Actions run
  `31646783758` successfully deployed that commit to the Raspberry Pi; the
  companion main-push workflow `31646783474` also succeeded.

## Aim Fit stability v2 implementation start — 2026-08-13

- Joseph authorized implementation by directing Codex to follow `docs/AIM_SCORING_STABILITY_IMPLEMENTATION_PLAN_2026-08-12.md`. This authorizes repository implementation and local verification only; it does not authorize model calls, scoring, database mutation, reconciliation apply, commit, push, deployment, or production-state changes.
- The applicable `AGENTS.md` files were re-read. The manual two-stage exchange remains authoritative, Dashboard/native model orchestration remains prohibited, and the Dashboard login prohibition remains unchanged.
- The exact pre-implementation worktree inventory was:

```text
 M data/scoring/schemas/aim-result-v1.schema.json
 M data/scoring/schemas/experience-result-v1.schema.json
 M docs/CAREER_DASHBOARD_AIM_EXPERIENCE_SCORING_IMPLEMENTATION_LOG_2026-08-12.md
 M docs/CAREER_DASHBOARD_AIM_EXPERIENCE_SCORING_IMPLEMENTATION_PLAN_2026-08-12.md
 M scripts/scoring_protocol/cli.py
 M scripts/scoring_protocol/codex_worker.py
 M scripts/scoring_protocol/contracts.py
 M scripts/scoring_protocol/runner.py
 M scripts/scoring_protocol/worker_schemas.py
 M src/components/ScoringLogTab.tsx
 M src/lib/__tests__/scoringFoundation.test.ts
 M src/lib/__tests__/scoringImport.test.ts
 M src/lib/scoringArtifact.ts
 M src/lib/scoringImport.ts
 M src/lib/scoringInputVersions.ts
 M tests/python/test_scoring_protocol.py
?? data/scoring/prompts/aim-evaluator-v2.md
?? data/scoring/prompts/aim-evaluator-v3.md
?? data/scoring/prompts/jd-cleaner-v2.md
?? data/scoring/prompts/jd-cleaner-v3.md
?? data/scoring/prompts/jd-coverage-auditor-v2.md
?? docs/AIM_SCORING_STABILITY_DESIGN_SCRATCHPAD_2026-08-12.md
?? docs/AIM_SCORING_STABILITY_IMPLEMENTATION_PLAN_2026-08-12.md
?? docs/EXPERIENCE_FIT_STABILITY_DESIGN_SCRATCHPAD_2026-08-12.md
?? scripts/scoring_protocol/aim_semantics.py
?? scripts/scoring_protocol/input_versions.py
```

- All listed files are preserved as Joseph's existing scoring work. The Aim v2 implementation will supersede overlapping Aim behavior deliberately, retain compatible mixed-import and worker-isolation work, and leave unrelated Board and Experience work intact.
- Phase 1 declarative authorities now exist without modifying any v1 contract: 7 Stage 1 plus 154 Stage 2 questions, the exact 339-entry crosswalk with 39 keep / 212 merge / 35 replace / 53 remove dispositions, policy v2, runner protocol v2, anonymization policy v1, the neutral factual prompt/response contract, all Aim v2 transport/vector/builder schemas, and Experience v2 source-continuity schemas.
- The registry was mechanically compared to the exact plan wording and order; the crosswalk was mechanically compared entry-by-entry to section 6.2. Policy-reference closure, question usage, authority separation, packet totals, and JSON parsing passed. Ajv 2020 validated each authority document against its schema.
- Python and TypeScript canonical JSON hashing matched exactly: question registry `702fba3a4b678021aad1a1dc5a1a69a329b804da69c1a9511830e9060044f101`, scoring policy `6da9d9d64cf0671f7befdb14ce893287e81e32d01b2ed84aca73a6a26db17362`, runner protocol `dd35502a2152af890edf15f15d2312f09d08a7dcada36c58202c24c7533a48ed`, and packet strategy `1a2337cc04d73e1dd38a021eb6442912b895dd290924775bbc4b34be90974a55`.

## Aim Fit stability v2 Phase 2 — one application-owned builder

- Added schema-checked, hash-bound, deeply frozen TypeScript authority loaders for the exact Aim v2 registry and policy. Added pure RFC-8785-style identity helpers and exact Unicode evidence validation with all-occurrence binding, source ordering, scope/membership checks, evidence cardinality, source authorization, and closed machine guards.
- Extracted shared work-base normalization/classification into `src/lib/jobLocationPolicy.ts`; both ingestion filtering and Aim Stage 1 now consume that authority. Added private deterministic local-employer, required-work-base, and local-insurance consequences with fail-open ambiguity.
- Added deterministic compensation and travel modules. Compensation uses integer cents, explicit USD/US$, deterministic period annualization and conservative coverage/conflict handling; only a complete explicit recurring total-cash upper bound below 6,000,000 cents kills. Travel performs complete-source numeric/no-travel coverage, interval intersection, conflict handling, closed qualitative parsing, the 15/10/5 cascade, and legacy-cache projection.
- Added the pure `buildAimResultFromFactualVector` path and DB-free canonical-stdin/stdout adapter. The builder enforces the closed purpose/scope matrix, authority/source/metadata/vector identities, local-policy and Stage 1 precedence, compensation preflight, Q15 closure, all policy-table routes, positive building deductions, component caps 30/30/25/13/2, integer 0–100 totals, and bands. A transitive dependency test proves the builder graph does not import filesystem, Prisma/database, network, time, or randomness surfaces; adapter/in-process parity also passes.
- Removed the mixed active `scoringPolicy.ts`. Experience scoring now lives in `experienceScoringPolicy.ts`; the old Aim 40/25/20/15 arithmetic is explicitly isolated in `historicalAimScoringPolicy.ts` for v1 replay validation only. No active new-Aim surface imports it.
- Phase 2 focused verification passed 30/30 tests across registry, policy, evidence, identities, shared location, Stage 1, compensation, travel, result building, adapter parity, and filtering. TypeScript compilation passed. Existing historical-v1 import and Experience tests passed 20/20 after authority separation.

## Aim Fit stability v2 Phases 3–7 — controller, persistence, exchange, import, UI, and retirement

- Added the database-free Aim v2 factual controller with exact current authority validation, complete-source rendering, live model-context discovery, bounded physical splitting, per-job concurrency limit two, isolated medium/medium/high attempts, exact evidence validation, packet checkpointing, Dashboard extraction reuse, policy-only zero-call rescore, partial-scope continuation, separate calibration namespace, bounded safe failures, and Q15 conflict retry/closure.
- Added forward-only AimFactualExtraction and AimScoringFailureReceipt persistence plus v2 authority, extraction, manual-retry, semantic-result, scoring-identity, and lifecycle bindings. Historical v1 batches, events, and cleaned artifacts are left unchanged.
- Reworked export and exchange to use canonical Aim v2 original-source snapshots, independent extraction reuse validation, exact 1–20 membership, bounded canonical artifacts, split extraction/scoring identities, active exact suppression, fail-closed runtime gates, and Experience v2 original-JD/Aim-event/extraction continuity without a new cleaned artifact.
- Reworked preview/apply around one shared pure deterministic projection. Preview is read-only and validates stored export bytes/hash, current authorities, exact job/source snapshots, ordered membership, factual evidence/vector/worker provenance, Experience source spans, and deterministic arithmetic. Apply repeats those checks and locks batch/items/jobs/source events/extractions/manual-retry receipts in one serializable transaction before any write.
- A valid mixed artifact remains preview-applicable. Approved apply imports complete terminal jobs, releases safe-failure items, writes bounded non-score failure receipts, preserves protected lifecycle state, and completes the batch atomically. Import no longer invokes reconciliation before payload/token validation.
- Added v2 band/display ownership, Stage 1/component/evidence/provenance drill-down, runtime-gate status, active failure summaries, and reason-bound one-job retry downloads. Experience retains its independent 80/65 display thresholds.
- Narrowed the structural pre-filter so distribution manager, branch manager, and ambiguous insurance-sales titles reach manual Aim. Nine native product routes remain HTTP 410, obsolete mutating scripts were removed, native Aim batch code has no executable imports, and privacy/reachability audits were added.
- The personal scoring skill now documents complete-source v2 execution and correct mixed-result handling. It remains database-free and cannot upload, import, reconcile, commit, push, or deploy.

## Aim Fit stability v2 Phase 8 local verification and zero-write rollout preview — 2026-08-13

- Privacy-scrubbed provenance for the observed `24d` and `8254` corpora is frozen as source hashes, bounded counts, and case labels only; no source JD text was copied into the repository. Golden export/result fixtures were generated only with deterministic fake workers. No Codex model call or scoring run was made.
- The final local suite passed: 396/396 TypeScript unit tests, 39/39 Python tests, `npx tsc --noEmit`, warning-free `npm run lint`, `npx prisma validate`, `npx prisma generate`, all ten valid Aim v2 golden exchange validations, and the Next.js 16.3 production build with all 41 static pages generated.
- The privacy audit passed all 161 questions and five rendered metadata variants. Its complete rendered Stage 1 and Stage 2 hashes are `9d74c59efb263483cc457dd386ca06bc610271b2e87c72d8d55fd79d655a1a0d` and `2c37c68628d2d1d02fc8c16fa585940dfc48812aabd76167689d6c18ae74baeb`. The reachability audit passed with exactly nine retired HTTP 410 routes across 363 scanned files.
- The input-reconciliation operator command now detects an absent v2 extraction table before invoking Prisma models and returns the bounded read-only blocker `manual_scoring_v2_schema_missing` instead of a Prisma stack trace. Against the configured Dashboard database at `2026-08-13T09:12:15.373Z`, `scoring:inputs:reconcile:dry-run` made no write and reported exactly that blocker because the additive v2 migration is not applied.
- The configured-environment readiness audit at `2026-08-13T09:12:22.513Z` found the historical manual schema ready and the v2 schema absent. It found zero legacy manual-export leases, zero native job leases, zero total Aim leases, zero nonterminal native requests, zero active keys, and zero failed active keys. Package, pipeline, and hook native reachability were all false. Both Aim and Experience v2 export gates were false. The exact readiness violations were `manual_scoring_v2_schema_missing` and `v2_export_gate_closed`; `ready` was correctly false.
- Guarded PostgreSQL fresh-migration, v1-upgrade, and real import integration were not run because they require a separately provisioned exact `/career_dashboard_scoring_v2_verify` database and authorize database mutation. Controlled calibration, migration apply, reconciliation apply, lease release, canary, preview/import, commit, push, deployment, and runtime-gate changes were not authorized and were not performed.

## Aim Fit v2 non-importable 24d calibration smoke test — 2026-08-13

- Joseph separately authorized one local test with no upload. The sole Desktop input was the exact historical 20-job `24d214d3-3054-4473-be2c-e6258c5a62eb` v1 export, SHA-256 `764ef7f7f040e52a9292ec22e0eb164429251908a35014e55c9947681b74b3cb`. A narrow database-free bridge validated the v1 artifact, preserved all 129,302 original-JD UTF-8 bytes, job membership, timestamps, trusted metadata, and source URLs exactly, embedded no reuse, and bound only this calibration copy to current Aim v2 authorities. It rejects any source or metadata that would require silent normalization.
- Force-fresh run `b8b63abe-6e69-45b1-8fea-74ce2ba5be73` used the separate calibration namespace and `gpt-5.6-terra`; no production checkpoint was read or written. The final 20-member `career-dashboard-aim-result-v2` artifact is schema/hash/binding valid, carries `artifactPurpose: calibration`, is independently rejected by import preview before approval-token creation, and has SHA-256 `69754e9c945c623e61bdd4eab93eb60cb2bcd2dff928603391627a94f8c3498a`.
- The smoke test failed rollout quality gates safely: 4 scored survivors and 16 bounded safe failures after 88 calls. Seven input-bound failures occurred before model invocation because the current email detector matches ordinary employer/recruiter email addresses, although section 8 specifies Joseph's configured personal contacts. Nine transient `evidence_invalid` failures exhausted all three isolated attempts: six at Stage 1, one at compensation preflight, and two during complete extraction.
- Across the 54 distinct factual units invoked, 34 passed on attempt one, 6 on attempt two, 5 on attempt three, and 9 never passed. First-attempt physical-unit acceptance was therefore 34/54, or 62.96%, far below the required 98%; worker outcomes were 45 accepted and 43 evidence-invalid. One run with only four completed jobs cannot evaluate the required repeat-run agreement, band-flip, rank-correlation, or score-difference gates. The four provisional low-band scores were Shift5 Solutions Engineer 15, Prismatic Technical Account Manager 28, Ping Identity Enterprise Sales Director 31, and Ping Identity Senior Sales Engineer 25; they remain calibration-only and are not Dashboard authority.
- Final implementation verification after adding the bridge passed 397/397 TypeScript tests, 41/41 Python tests, typecheck, lint, exchange validation, and `git diff --check`. No Dashboard/database read or write, upload, preview, import, migration, reconciliation, lease change, evidence edit, commit, push, deployment, or second scoring run occurred.

## Experience Fit v2 two-pass reset — 2026-08-13

- Joseph replaced the criterion/EFEI design with a deliberately simple flow: one plain-text Terra Medium hard-requirement gate followed, only for survivors, by one plain-text Terra High holistic Expertise Fit score from 0–100.
- The active runner sends the complete original JD and complete Core Evidence snapshot to both phases. The resume remains transport-bound for continuity but is not used in either Experience prompt. Inventory silence is not treated as proof of a mismatch.
- Terra is accountable for the substantive answer, not JSON shape. The controller tolerantly harvests a recognizable Yes/No hard-gate answer or 0–100 score, preserves both raw responses verbatim, and builds the strict upload artifact itself. There are no schema-repair or semantic-retry model calls.
- A confirmed hard-requirement mismatch deterministically scores 0 and skips the holistic call. All other scores are imported as given; the Dashboard independently applies the existing 70-point pass threshold for inbox versus dismissal.
- The v1 criterion extractor, coverage auditor, evidence evaluator, repair prompt, and policy remain only under `data/scoring/archive/experience-v1` for historical replay. The superseded Experience design and audit scratchpads moved to `docs/archive/experience-fit`.
- This implementation made no model call, scoring run, database mutation, upload, import, migration, commit, push, deployment, or runtime-gate change.

## Independent manual-export controls and equal batch cap — 2026-08-14

- Joseph clarified that Aim Fit and Experience Fit are independently operable queues. A runtime flag for one stage must not enable or disable export from the other stage.
- Removed the Aim and Experience runtime export gates from the API, UI, retry route, environment template, and readiness audit. Either tab can now create its own exact batch whenever that stage has eligible queued jobs.
- Set the v2 export and result contract maximum to 30 jobs for both stages. The UI and API default to 30, and both server-side batch validators enforce the same cap.
- Preserved the database-enforced one-nonterminal-batch-per-stage rule, exact job leases, stored re-download, explicit release, preview, approval, and atomic import boundaries. An active Aim batch does not block an Experience batch, and vice versa.
- Standardized completed-result delivery: the canonical validated JSON now remains under `data/scoring/results/`, while a byte-identical upload copy is atomically published directly to the Desktop as `career-dashboard-<stage>-upload-<batch-id>.json`. The runner reports both paths and does not publish non-importable calibration artifacts as upload copies.
- Renamed new and exact re-downloaded exports to `START-AIM-FIT-<batch-id>.json` and `START-E-FIT-<batch-id>.json`. Attaching or referencing either trigger-named file in Codex is the instruction to run only its matching scoring stage; downloading it alone has no side effect. Legacy export filenames remain accepted when explicitly requested.
- Unified unscorable-job handling across both stages: approved safe failures now release their batch lease, set `scoringStatus` to `failed` with a bounded stage-specific error, and surface under **Action Needed**. Experience failures no longer return to Experience Fit, and the separate Aim failure-suppression panel and retry controls were removed. Existing active Aim failure receipts are included directly in the Action Needed query without a database rewrite.
