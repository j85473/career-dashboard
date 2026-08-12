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
