
# Deployment & Pi Protocol (Updated)
- We tweak and test the dashboard locally on the Mac first.
- Only once verified working locally do we push changes to the Raspberry Pi.
- **CRITICAL**: UNDER NO CIRCUMSTANCES should you ever change what's going on with the Pi or deploy to it without explicitly asking for and receiving the user's permission first.
- **Command Formatting**: Whenever the user asks to deploy to the Pi, do NOT run the command automatically via the terminal tool. Instead, provide a bash snippet containing two specific commands so the user can copy/paste and run it themselves:
  1. `cd '/Users/JosephLamb/AntigravityProjects/Active/Career Dashboard'`
  2. `bash scripts/deploy.sh`

# AI Evaluation
- **NATIVE SCORING ONLY**: All AI evaluation and scoring must be done entirely natively within the chat context using Antigravity subagents (e.g., via a `scoring_manager` orchestrating `job_evaluator` agents). You must NEVER write or use external Python scripts or third-party APIs (like DeepSeek) to evaluate jobs.
- **PINNED V6 AGENTS ONLY**: For production scoring, invoke the registered `scoring-manager-v6`, `standard-job-evaluator-v6`, and `wildcard-job-evaluator-v6` definitions. Never use `define_subagent`, recreate an evaluator prompt, or add instructions to the evaluator's manifest-assigned one-line chunk prompt.
- **IMMUTABLE RUNS**: Prepare scoring with `npm run scoring:prepare`. The resulting manifest, prompt/evidence/input hashes, job IDs, and optimistic versions are authoritative. Never hand-edit or overwrite a chunk result; use `npm run scoring:quarantine` and a fresh evaluator when a result is invalid.
- **BOUNDED MANAGERS**: A fresh `scoring-manager-v6` may process at most 20 manifest-declared chunks per wave. It must persist one create-only bare-JSON result per chunk and return only a compact receipt.
- **STRICT IMPORT**: Browser JSON import is disabled. Run `npm run scoring:validate` and review the dry-run before `npm run scoring:import`. Local preparation, permission gating, schema validation, and database application scripts are allowed because they do not evaluate jobs or call an AI service.
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
- **V6 Scoring Runbook**: For procedures on executing Native Scoring V6 batches, refer to `.agents/ANTIGRAVITY_V6_SCORING_WALKTHROUGH.md`.
- **V6 Architecture Context**: For the design rules and audit context of V6 Scoring, refer to `.agents/v6_architecture_audit_context.md`.
