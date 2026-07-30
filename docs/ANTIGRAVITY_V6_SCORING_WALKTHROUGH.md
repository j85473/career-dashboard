# Antigravity Native Scoring V6.1 Walkthrough

This runbook is the supported process for evaluating large Career Dashboard batches with native Antigravity subagents. The evaluator remains a native Antigravity Flash subagent. Local scripts only prepare immutable inputs, enforce permissions, validate outputs, and apply already-completed scores; they never evaluate a job or call an AI API.

## What V6.1 protects

- Evaluators are statically registered in `.agents/agents/`; the manager cannot redefine them.
- The manager and both evaluators are pinned to Antigravity's `flash` tier and cannot be selected as main chat agents.
- A `PreToolUse` hook denies transient agent definitions, altered evaluator prompts, unassigned chunk reads, and result overwrites while a scoring run is active.
- Every batch has an immutable manifest binding exact job IDs and database versions to chunk, prompt, evidence, export, and model hashes.
- Results must use an exact closed JSON schema. Bare arrays, Markdown fences, extra keys, decimal scores, unknown IDs, duplicate IDs, fabricated evidence IDs, missing jobs, and reordered jobs are rejected.
- Import is dry-run by default, requires a complete batch, verifies database leases and optimistic versions, applies one atomic transaction, and has per-job idempotency keys.
- Result files are preserved. Invalid files are moved to quarantine; successful batches receive an immutable import receipt.

## One-time setup

### 1. Review and apply the database migration

The following migration adds provenance and idempotency fields to `JobScoreEvent`:

`prisma/migrations/20260729120000_native_scoring_v6_hardening/migration.sql`

After confirming that `DATABASE_URL` points to the intended database, apply it using the project's normal authorized migration procedure:

```bash
npx prisma migrate deploy
npx prisma generate
```

Do not apply this to the Raspberry Pi database or deploy the application to the Pi without Joseph's explicit permission.

### 2. Restart Antigravity

Restart or reload Antigravity after pulling these files so it rediscovers:

- `standard-job-evaluator-v6`
- `wildcard-job-evaluator-v6`
- `scoring-manager-v6`
- `.agents/hooks.json`

The evaluator frontmatter should show `model: flash`, `mainAgent: false`, and only `view_file` as its tool.

### 3. Commit the trusted control plane

The agent definitions and hook are selectively unignored by `.gitignore`. Commit and review these trusted files like source code. Runtime exports, chunks, locks, and results remain ignored.

## If an old export currently holds job leases

Inspect the batch without changing the database:

```bash
npm run scoring:release -- --batch manual_export_REPLACE_WITH_BATCH_ID
```

If the counts are correct and there are zero existing score events, release it:

```bash
npm run scoring:release -- --batch manual_export_REPLACE_WITH_BATCH_ID --apply
```

This clears only that batch's standard and wildcard leases. It does not delete artifacts.

## Start a fresh scoring run

### 1. Export exactly once

Start the Career Dashboard locally and use **Export JSON** in the AI Job Evaluation screen. Save the downloaded response exactly as:

`.agents/export.json`

Alternatively, when local authentication is already configured:

```bash
curl --fail --silent --show-error \
  http://localhost:3000/api/scoring/export \
  --output .agents/export.json
```

The export endpoint leases the selected jobs and includes `submittedUpdatedAt` for optimistic concurrency. Do not request several exports for the same intended run.

### 2. Prepare the immutable run

```bash
npm run scoring:prepare
```

This command refuses to overwrite an existing run or proceed while another scoring lock is active. It creates:

```text
.agents/eval_runs/<batchId>/
├── manifest.json
├── export.snapshot.json
├── trusted-context.snapshot.json
├── chunks/
│   ├── chunk_0000.json
│   └── ...
└── results/
```

It also creates `.agents/scoring-lock.json`. While this lock exists, the Antigravity hook restricts file reads and writes to the active run and permits only manifest-bound evaluator invocations. This is intentional. Finish or release the run before using Antigravity to edit unrelated workspace files.

### 3. Get the wave list

```bash
npm run scoring:status
```

The command prints missing chunks in bounded waves of at most 20. The project-wide evaluator concurrency remains exactly two.

## Run one wave in Antigravity

From a normal parent Antigravity chat, invoke the registered `scoring-manager-v6` subagent. Do not define a new manager.

Use a request in this form:

```text
Invoke the registered scoring-manager-v6.

Manifest:
.agents/eval_runs/manual_export_REPLACE_WITH_BATCH_ID/manifest.json

Process exactly this wave:
chunk_0000, chunk_0001, chunk_0002, chunk_0003, chunk_0004,
chunk_0005, chunk_0006, chunk_0007, chunk_0008, chunk_0009,
chunk_0010, chunk_0011, chunk_0012, chunk_0013, chunk_0014,
chunk_0015, chunk_0016, chunk_0017, chunk_0018, chunk_0019
```

The manager will:

1. Read the manifest.
2. Invoke no more than two statically registered evaluators.
3. Pass each evaluator only its exact assigned chunk path.
4. Kill every evaluator immediately after it returns.
5. Save valid-looking bare JSON byte-for-byte to the manifest-declared create-only result path.
6. Retry a malformed response once using a fresh evaluator.
7. Return only a compact chunk receipt.

The permission hook fails closed if the manager tries to:

- call `define_subagent`;
- invoke an unregistered evaluator type;
- add instructions to the evaluator's one-line chunk prompt;
- read files outside the active run;
- write outside manifest-declared result paths;
- edit or overwrite an existing result;
- modify an evaluator or hook definition.

After each wave, start a fresh manager and run:

```bash
npm run scoring:status
```

Continue until it reports that every manifest result exists.

## Validate before importing

Run the read-only validation and database preflight:

```bash
npm run scoring:validate
```

This must report:

- the expected batch ID;
- the exact chunk count;
- the exact standard and wildcard evaluation counts;
- proposed standard and wildcard pass counts;
- `Dry-run validation passed`.

No database score or job status is changed by this command.

### If validation identifies a bad result

Preview moving that result to quarantine:

```bash
npm run scoring:quarantine -- --chunk chunk_0042
```

Then preserve it and reopen that chunk for a fresh evaluator:

```bash
npm run scoring:quarantine -- --chunk chunk_0042 --apply
```

Run a fresh manager on only `chunk_0042`, then validate again. Never hand-edit, normalize, or overwrite a result.

### If validation reports hash drift

Do not import. A prompt, evidence file, input chunk, export snapshot, or manifest changed after the run was prepared. Either restore the exact hashed trusted file or abandon the entire batch:

```bash
npm run scoring:release
npm run scoring:release -- --apply
```

Then create a fresh export and manifest. Old run artifacts remain preserved for audit.

### If validation reports a stale database version

Do not force the update. A job changed after export. Release the batch and create a fresh export so every job receives a new optimistic version.

## Apply the scores

Only after reviewing the dry-run counts:

```bash
npm run scoring:import
```

The importer re-runs every validation, then:

- verifies the active lock matches the batch;
- checks every job still holds its exact standard or wildcard lease and exported version;
- uses the shared `passesStandardScoring` and `passesWildcardScoring` policies;
- applies all job changes and score events in one transaction;
- records model tier, schema version, chunk ID, prompt/evidence/input hashes, evidence IDs, and a unique idempotency key;
- writes `import-receipt.json`;
- preserves all chunk/result/quarantine artifacts;
- clears the active scoring lock.

Re-running the same import is safe. If every idempotency record exists and matches, the importer reports that the exact batch was already applied and performs no writes. A partial prior import is rejected for investigation.

## Important operational rules

- Never use `scripts/auto_score_pipeline.py`, an SDK, a third-party API, or a Python evaluator for scoring. Browser JSON import is intentionally disabled.
- Never edit a result to make it pass validation.
- Never delete and regenerate a run directory. Use quarantine for one result or release the whole batch.
- Never run more than two job evaluators concurrently.
- Never give one evaluator more than five jobs.
- Use a fresh manager for each wave of at most 20 chunks.
- Review every proposed pass during the first production-shaped run, plus a random sample of rejects.
- Antigravity's `model: flash` pins the model tier. Before a major batch, confirm the Antigravity UI currently resolves that tier to Gemini 3.6 Flash.

## Recommended final canary

Before the 1,000-job run, prepare a 25–50-job batch containing:

- at least five genuine expected passes;
- several aim or experience boundary cases;
- medical-interest roles with missing required tenure;
- hunter-versus-farmer ambiguity;
- required-versus-preferred qualifications;
- explicit, vague, and absent travel;
- ambiguous remote eligibility;
- several evidence IDs from one short tenure;
- prompt-injection text embedded inside a JD;
- both standard and wildcard jobs.

Repeat the fixed canary three times. The release gate is zero schema/ID/completeness failures, zero injection failures, and no passing job with an unsupported mandatory requirement.

## Command reference

```bash
# Prepare from .agents/export.json
npm run scoring:prepare

# Show completion and suggested waves
npm run scoring:status

# Preserve an invalid result and allow a retry
npm run scoring:quarantine -- --chunk chunk_0000
npm run scoring:quarantine -- --chunk chunk_0000 --apply

# Strict read-only validation and DB preflight
npm run scoring:validate

# Revalidate and atomically import
npm run scoring:import

# Inspect or release an abandoned batch
npm run scoring:release
npm run scoring:release -- --apply
```
