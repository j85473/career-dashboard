# Run Aim and Experience Fit from a phone

This setup runs the repository's existing file-based scoring runners in Codex Cloud.
The laptop can be off. The M70 must remain on for Dashboard access and import.
Scoring itself needs no Dashboard database connection.
Completed, validated runs upload to the Dashboard automatically. Joe does not need
to locate or download a result file; the task returns the Dashboard import receipt.

Prepared source branch: `codex/cloud-fit-scoring`.
Repository: [j85473/career-dashboard](https://github.com/j85473/career-dashboard).
Local preparation is not evidence that cloud model access or VPN access works.

## Create the environment

1. On the web or desktop, start a new Codex task. Select **Work in → Cloud →
   Select environment → Create environment**, or use **Settings → Codex Cloud →
   Environments → Create environment**.
2. Connect GitHub if requested and select `j85473/career-dashboard`. Keep access
   set to **Only me**. Name the environment **Career Dashboard Scoring**.
3. Use the prepared branch once it has been pushed. If the picker doesn't expose
   a branch choice, ask the setup agent to fetch and check out that branch in its
   workspace. Do not merge it into `main`; main pushes deploy production.
4. Paste the setup request below. Supply account authorization only through the
   provider's sign-in or secret controls, not as messages or committed files.
5. Publish only after the dependency check, synthetic workers, and M70 connection pass. Test again
   in a **new task** from the published environment, including branch/skill
   availability after repository refresh.

```text
Prepare a private cloud environment for Career Dashboard Aim/Experience scoring.
Use j85473/career-dashboard, branch codex/cloud-fit-scoring. Fetch and check out
that branch in this workspace if needed. Do not merge, push, or deploy anything.

Read docs/CODEX_CLOUD_SCORING.md and
.agents/skills/career-dashboard-cloud-scoring/SKILL.md.

Use Node.js 24 and Python 3.9 or later. Record
bash scripts/cloud/setup-scoring.sh as the installation command, then run it.
Do not start Next.js, Prisma migrations, ingestion, or a database. Do not load
production .env files or ask for database credentials.

Run python3 scripts/cloud/check_scoring_environment.py --smoke-workers.
Use the existing exact model settings and worker isolation. Do not score real jobs.
If model access or CLI authentication is missing, report that exact blocker and
guide me through the supported sign-in flow. Do not substitute a model or switch
to API billing. Never copy my Mac's Codex authentication cache into the environment.

Configure Tailscale access for automatic result uploads, then run the check with
--dashboard-url http://100.107.116.123:3000.
Report dependency, synthetic-worker, and Dashboard-network results separately.
Completed scoring runs must automatically preview and apply their final validated
result through the public Dashboard import API, after required Experience review.
This is standing import authorization for supplied exports; do not ask me to find
a file or approve each upload. Do not import any real result during environment setup.
   Save the tested setup and tell me when it is ready to publish.
```

## Installation and readiness

The installation script uses locked npm dependencies, skips install lifecycle
scripts, and does not need Prisma generation for the scoring result builder. If
Codex is missing, it installs CLI version `0.146.0`, matching local preparation.
An existing cloud-provided CLI is retained and checked for required flags and model
catalog compatibility. Installation may stop if sign-in or the exact model is
unavailable; this is a setup blocker, not a scored-job failure. Do not repeatedly
install a different CLI or change models to make the check green.

Dependency/catalog check (no model inference):

```bash
python3 scripts/cloud/check_scoring_environment.py
```

Synthetic-worker check (tiny model calls, no jobs, no import):

```bash
python3 scripts/cloud/check_scoring_environment.py --smoke-workers
```

This uses the actual production worker helper for every unique required combination
of model, effort, and memory setting. The current protocols require Medium without
memory, High without memory, and High with memory. It stops at the first failure;
it does not retry workers or alter job checkpoints. Check reports are local runtime
files under the ignored scoring results directory.

The model catalog must expose the exact model names in the repository protocols,
supported efforts, and positive context windows. The setup must support the CLI's
worker-isolation flags. A catalog success alone does not verify authentication for
actual inference. A successful check on the Mac does not verify cloud execution.

The cloud task's own sign-in does not establish that subprocess workers can use it.
Try the provided identity first. If separate sign-in is required, ask the setup
agent to use the supported headless/device-code flow; complete that flow in your
own browser. Keep the environment private. Verify a fresh published task can run
workers too. Do not publish until required access survives the supported lifecycle.
API-key execution would use separate API billing and is not configured here.

## Connect to the M70 with Tailscale

This connection is required for the normal automatic-upload workflow. Scoring can
produce a result without it, but the task is not finished until import succeeds.

1. In the Tailscale admin console, generate an auth key with **Reusable** and
   **Ephemeral** enabled. Use an identity/tag allowed to reach only the intended
   M70 Dashboard service where your network policy supports it.
2. In the cloud environment configuration, edit **Tailscale** and enter the key
   there. Do not paste the key into the setup chat, repository, or this runbook.
3. Ensure the tailnet policy allows that identity to reach `100.107.116.123:3000`.
   The setup does not need SSH or PostgreSQL access.
4. Save, publish/republish, then start a new task and run:

```bash
python3 scripts/cloud/check_scoring_environment.py --smoke-workers --dashboard-url http://100.107.116.123:3000
```

The optional network probe is a GET of `/api/health`. It makes no scoring/import
mutation. It verifies HTTP reachability, not the full preview/apply import flow.
Use the configured HTTP(S) proxy; don't bypass it for the Tailscale address.
Keep the existing Dashboard access model. Do not expose the service publicly or
add a login screen. If the connection fails, keep the result and report that import
is pending. Restore the connection and transfer the same file without rescoring.
Manual download/upload remains available if Joe chooses it as a recovery path.

For internet access, allow the package registries and the Codex authentication and
model endpoints required by the actual cloud runtime. Diagnose a blocked hostname
from the setup result instead of assuming a package-manager preset covers model
traffic. A destination allowlist grants neither authentication nor model access.

## Use it from iPhone

Open Codex in the updated ChatGPT app and select **Career Dashboard Scoring**.
Export the selected stage from the Dashboard. Supply the exact JSON to the cloud
task, using the app's attachment support if available. If JSON attachments aren't
available in that interface, the agent can fetch an **existing** export from the
Dashboard when you supply its exact stored run/batch download URL and VPN access
works. Do not ask it to create another export or pick an arbitrary queued batch.
Existing export links use `/api/scoring/runs/<run-id>/download` or
`/api/scoring/batches/<batch-id>/download`.

```text
Use $career-dashboard-cloud-scoring to run the supplied export's matching stage.
Keep the other stage separate. Complete validation and required Experience review.
Automatically preview and import the final validated result into the Dashboard.
Return the import confirmation and counts. If import fails, retain the result and
tell me what access needs fixing; do not rerun scoring or make me find a file.
```

Canonical results/checkpoints stay in `data/scoring/results/`. Upload copies use
`data/scoring/results/cloud-delivery/`. They are not written to the Mac's Desktop.
The task sends the exact final JSON to the existing preview endpoint, checks the
identity and result counts, and applies it with the returned approval token.
That token is part of the API flow; Joe does not need to approve each transfer.
Experience review must finish before import, and a held review is never uploaded.

The task reports completion only after the Dashboard returns a successful import
receipt, including imported and released counts. If scoring succeeds but import
fails, it reports **scoring complete; Dashboard import pending**, retains the
artifact, and completes delivery after access is restored. Save important output
before task state expires. New tasks have separate files; reopen the same task to
resume an existing run. Neither setup nor publication scores existing jobs.

## Acceptance before relying on laptop-free scoring

- A fresh published task discovers the repository skill and passes synthetic workers.
- A supplied exact export completes through the unchanged runner and validator.
- Experience hard mismatches receive the main agent's required semantic review.
- The exact final result automatically passes preview/apply through the public
  Dashboard API with a saved import receipt; no manual file handling is required.
- A second task still has the expected branch, dependencies, and supported identity.

Official references, checked October 30, 2026:
[Cloud environment setup, mobile use, skills, and VPN](https://learn.chatgpt.com/docs/environments/cloud-environments),
[Codex authentication and headless sign-in](https://learn.chatgpt.com/docs/auth).
