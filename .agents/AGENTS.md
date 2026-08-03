
# Deployment & Pi Protocol (Updated)
- We tweak and test the dashboard locally on the Mac first.
- Only once verified working locally do we push changes to the Raspberry Pi.
- **CRITICAL**: UNDER NO CIRCUMSTANCES should you ever change what's going on with the Pi or deploy to it without explicitly asking for and receiving the user's permission first.
- **GitHub Actions Deployment**: Pushing to GitHub automatically triggers the deployment pipeline to the Pi. Therefore, we do NOT need to run `scripts/deploy.sh` manually anymore. Simply push changes to GitHub when a deployment is requested.
- **Hygiene Pass**: When the user requests a "hygiene pass" (or "hygine pass"), it means the code is ready for Pi deployment. You must:
  1. Perform a thorough hygiene check (e.g., run `npm run build`, run tests, check for lint errors).
  2. Fix any issues found during the check.
  3. Once verified clean, commit the changes and push to GitHub to trigger the deployment.

# AI Evaluation
- **NATIVE SCORING ONLY**: All AI evaluation and scoring must be done entirely natively within the chat context using Antigravity subagents (e.g., via a `scoring_manager` orchestrating `job_evaluator` agents). You must NEVER write or use external Python scripts or third-party APIs (like DeepSeek) to evaluate jobs.
- **PINNED V6 AGENTS ONLY**: For production scoring, use the registered `native-scoring-runner-v6`, `scoring-manager-v6`, `context-job-evaluator-v6`, `standard-job-evaluator-v6`, and `wildcard-job-evaluator-v6` definitions. Never use `define_subagent`, recreate an evaluator prompt, or add instructions to a manifest-assigned evaluator prompt.
- **ONE DURABLE REQUEST**: `score pending jobs` or the dashboard button must create/reuse one `NativeScoringRequest`. The deterministic state machine runs negative-only context, A/E, then newly eligible wildcard phases directly from the database; operator JSON export/import is retired.
- **NEGATIVE PREFERENCE CONTEXT ONLY**: Only intentional preference decisions may update Context DB. Experience mismatch, Location mismatch, Expired, applied, interviewing, expired, and archived decisions are always excluded. Context is injected only into A/E aim scoring and may never change experience evidence.
- **IMMUTABLE RUNS**: The state machine prepares versioned V6.3 manifests. Prompt/evidence/context/export/input hashes, job IDs, and optimistic versions are authoritative. Never hand-edit or overwrite a result; use `npm run scoring:quarantine` and a fresh evaluator when a result is invalid.
- **QUALIFICATION GUARDRAILS**: Standard and wildcard scoring use `data/resumes/JosephLamb.CS.resume.docx`, the text-identical SellSig/CS baseline resume. They must decompose mandatory requirements and deterministically cap unsupported mandatory requirements/domain/tenure at 59. Automatic inbox admission requires Aim >= 80 and guarded Experience >= 70.
- **BOUNDED DISMISSAL RECOVERY**: At the one-time Context-to-Standard V6.3 calibration transition, V6.3 may recover no more than 500 stale AI dismissals from the prior 21 days. Any existing V6.3 standard provenance disables another recovery cohort. Current local filters and target/near-miss criteria apply. Never bulk-requeue historical dismissals or include user decisions, expired/applied jobs, tailoring work, or active wildcard jobs.
- **BOUNDED MANAGERS**: A fresh `scoring-manager-v6` may process at most 20 manifest-declared chunks per wave. It must persist one create-only bare-JSON result per chunk and return only a compact receipt.
- **STRICT IMPORT**: Browser JSON export/import is retired. The native runner dry-runs strict validation before every atomic import. Local preparation, permission gating, schema validation, and database application scripts are allowed because they do not evaluate jobs or call an AI service.
- When evaluating/scoring batches of jobs natively in the chat context using a JSON payload, you MUST split the batch into chunks of 5 jobs each.
- **Concurrency**: Maintain a strict concurrency pool of 2 `job_evaluator` subagents. Assign one chunk of 5 jobs per agent. When an agent finishes its chunk, it MUST be killed (to prevent context poisoning) before spinning up a new one to take its place. Aggregate the results once all subagents complete.
- **Travel Scoring**: Agents must be highly conservative when evaluating the travel score. Require explicit, unambiguous evidence of significant travel requirements in the JD before awarding high travel scores, rather than being liberal with assumptions.

# User Persona & Target Roles
- **Target Persona**: The user is a Field Sales / Strategic Account Management professional.
- **Target Roles**: Technical Sales, Sales Manager, District Sales Manager, Field Sales Rep, Field Manager, Account Executive, Account Director, Channel Sales, Distributor Sales, Customer Success (and their variants).
- **DO NOT BLOCK SALES**: Never write filters, code, or local triage blocklists that exclude "Account Executive", "Sales Manager", or general Sales titles (unless explicitly told to block "Inside Sales" or "Retail Sales").
- **CRITICAL**: Do NOT hallucinate that the user is a Product Manager, Software Engineer, or Technical PM. The user wants high-travel, field-based, sales/management roles!

# Local Development
- **Starting the Server**: When the user asks to start the server (e.g., `npm run dev`), ALWAYS use the `run_command` tool with `BypassSandbox: true`. This is strictly required because the server needs access to the host's Tailscale network to connect to the database on the Pi.

# Architecture & Runbooks
- **V6 Scoring Runbook**: For procedures on executing Native Scoring V6.3 batches, refer to `docs/ANTIGRAVITY_V6_SCORING_WALKTHROUGH.md`.
- **V6 Architecture Context**: For the design rules and audit context of V6 Scoring, refer to `.agents/v6_architecture_audit_context.md`.
