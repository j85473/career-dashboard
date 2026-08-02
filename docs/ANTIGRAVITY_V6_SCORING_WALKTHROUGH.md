# Antigravity Native Scoring V6.2 Runbook

V6.2 turns Context DB maintenance, A/E scoring, and wildcard scoring into one durable native-Antigravity request. No operator JSON download/upload and no model API call are part of scoring.

## Operator choices

From the dashboard, click **Score Pending Jobs**. The database records one durable request. If the local Mac watcher is installed and running, it launches the registered Agy runner automatically.

From Agy, select the registered `native-scoring-runner-v6` agent and say:

```text
score pending jobs
```

For a one-shot terminal invocation:

```bash
agy --project REPLACE_WITH_AGY_PROJECT_ID \
  --agent native-scoring-runner-v6 \
  --print "score pending jobs" \
  --print-timeout 2h
```

All three entry points use the same single-flight database request. Repeated clicks or prompts return the existing active request rather than duplicating work.

## Ordered workflow

One request always runs these phases in order:

1. Normalize the Context DB to a negative-only `DO REJECT:` profile and mark excluded lifecycle decisions handled.
2. Process intentional `passed` feedback, at most five decisions per immutable context run.
3. Score all eligible A/E jobs with the exact versioned Context DB snapshot injected into each chunk.
4. Import A/E results atomically; rejected jobs with sufficient experience become wildcard-eligible.
5. Query the database again and score those newly eligible wildcard jobs.
6. Mark the durable request complete and release its single-flight key.

Applied, interviewing, expired, and archived jobs never enter context learning. A `passed` decision with an Expired reason is also excluded. Context output may contain only negative-preference bullets; it cannot add positive preferences, qualifications, or scoring policy.

## V6.2 safety properties

- Only registered `native-scoring-runner-v6`, `scoring-manager-v6`, `context-job-evaluator-v6`, `standard-job-evaluator-v6`, and `wildcard-job-evaluator-v6` agents are used.
- Model evaluation is native to Antigravity. Scoring does not use Gemini, DeepSeek, an SDK, or any third-party model API.
- The runner has two narrow npm-script grants and never uses `--dangerously-skip-permissions` or arbitrary shell commands. The workspace hook issues an exact, one-file `write_file` override only for a create-once result path declared by the active manifest.
- Every immutable run hashes the manager/evaluator prompts, evidence inventory, export snapshot, Context DB snapshot, and every input chunk.
- Standard score provenance stores the Context DB hash and optimistic `updatedAt` version used by A/E.
- Input chunks contain at most five jobs. A manager wave contains at most 20 chunks. At most two evaluators may run concurrently, and every evaluator is killed after its chunk.
- Result writes are create-only. Import requires exact closed schemas, ordered completeness, hashes, leases, and optimistic database versions.
- Context, standard, and wildcard imports are atomic and idempotent. Invalid results are quarantined; immutable artifacts and receipts are preserved.
- Failed preparation releases only the leases created by that attempt. Failed scoring retains its phase and artifacts for **Retry scoring**.

## Local activation (do not run against production without permission)

1. Confirm `DATABASE_URL` points to the intended local/test database.
2. Review and apply the migration:

   ```bash
   npx prisma migrate deploy
   npx prisma generate
   ```

3. Restart Antigravity so it reloads the registered V6.2 agents and `.agents/hooks.json`.
4. Register this exact workspace with the Agy CLI once:

   ```bash
   agy --new-project agents
   ```

   The output must list `native-scoring-runner-v6`. The watcher always launches with that persisted project ID; it never relies on Agy's unrelated default CLI project.
5. Confirm the installed Agy binary. Set `AGY_BIN` only if it is not at `~/.local/bin/agy`.
6. Validate the launchd watcher configuration:

   ```bash
   npm run scoring:watch:install:check
   ```

7. Install and start the Mac watcher only after the migration succeeds:

   ```bash
   npm run scoring:watch:install
   ```

The installer creates `~/Library/LaunchAgents/com.josephlamb.career-dashboard-native-scoring.plist` and refuses to replace a differing existing plist. It adds only three headless grants to the Agy CLI's `~/.gemini/antigravity-cli/settings.json`: the `scoring:request` and `scoring:next` npm-script prefixes plus recursive write access to this workspace's `.agents/eval_runs` directory. The scripts fail closed on every unexpected argument; the workspace hook additionally requires the exact full command, a canonical UUID, the current lock owner, and a create-once result path declared by the active manifest. The persistent results-directory grant is necessary because headless request-review mode does not honor a hook-only `write_file` override reliably. Prefix command grants are necessary because Agy's token matcher stops reliably matching once npm's literal `--` argument separator is included. Re-running the installer safely repairs missing CLI grants when the validated watcher plist already exists. Watcher logs go to `data/runtime/`.

The watcher gives its Agy child a controlled `PATH` beginning with the exact Node runtime that launched the watcher and this project's `node_modules/.bin`. This is required because launchd's default path omits Homebrew, while the fail-closed workspace hook and the two approved npm commands require `node` and `npm`.

For foreground testing without launchd:

```bash
npm run scoring:watch:once
```

This claims at most one queued request and launches the exact registered Agy runner with `shell: false`.

## Monitoring and recovery

The dashboard polls the durable request every five seconds and displays phase, progress, context/A/E/wildcard counts, and the last safe error. Only one request can be active globally.

If a run fails, use **Retry scoring**. The request retains its phase. Existing valid result files remain create-only and are reused; a quarantined or missing chunk is evaluated again.

Manual diagnostics remain available:

```bash
npm run scoring:status
npm run scoring:validate
npm run scoring:context:validate
npm run scoring:quarantine -- --chunk chunk_0000
npm run scoring:quarantine -- --chunk chunk_0000 --apply
npm run scoring:release
npm run scoring:release -- --apply
```

`scoring:release` refuses a batch that already has score events or context revisions. It clears only that exact abandoned batch's leases and preserves artifacts.

## Verification and canary

Before activation:

```bash
npm run scoring:canary
npx tsc --noEmit
npm run lint
npm run build
```

After migration and watcher installation, queue a small production-shaped canary and review every pass plus a reject sample. Include expected passes, aim/experience boundary cases, required-domain gaps, hunter/farmer ambiguity, travel variants, prompt-injection text, intentional negative feedback, an applied job, and an Expired decision. Applied/Expired items must produce no context rule, schemas and completeness must have zero failures, and unsupported mandatory requirements must never pass.

## Production/Pi boundary

This workflow is Mac-side native scoring. Do not install Agy, the watcher, or evaluator agents on the Pi. Do not apply the migration to the Pi, push to GitHub, or deploy until Joseph explicitly authorizes the production activation.

After that separate authorization, use this exact order:

1. Re-run the verification commands above and confirm no scoring lock is active.
2. Use the repository's normal production deployment procedure. It stages and builds the release, creates a PostgreSQL backup, applies expand-only Prisma migrations, activates the dashboard, and requires `/api/health` to succeed. Do not manually migrate first and bypass that backup/health gate.
3. Confirm migration `20260801210000_native_scoring_automation` is applied and `/api/health` returns `ok: true`.
4. On the Mac—not the Pi—restart Antigravity, then run `npm run scoring:watch:install:check` followed by `npm run scoring:watch:install`.
5. Queue the small production-shaped canary described above. Review its Context revision, A/E score-event Context hashes, wildcard transitions, and dashboard completion state before scoring the full backlog.
