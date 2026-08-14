
# Deployment & Pi Protocol (Updated)
- We tweak and test the dashboard locally on the Mac first.
- Only once verified working locally do we push changes to the Raspberry Pi.
- **CRITICAL**: UNDER NO CIRCUMSTANCES should you ever change what's going on with the Pi or deploy to it without explicitly asking for and receiving the user's permission first.
- **GitHub Actions Deployment**: Pushing to GitHub automatically triggers the deployment pipeline to the Pi. Therefore, we do NOT need to run `scripts/deploy.sh` manually anymore. Simply push changes to GitHub when a deployment is requested.
- **NO AUTOMATIC PUSHES**: Because pushing to GitHub triggers a deployment, NEVER push changes to GitHub automatically. After committing code, ALWAYS stop and ask for the user's explicit permission before running `git push`, UNLESS the user has explicitly requested a "hygiene pass".
- **Hygiene Pass**: When the user requests a "hygiene pass" (or "hygine pass"), it is considered explicit permission to prepare for Pi deployment and push to GitHub. You must:
  1. Perform a thorough hygiene check (e.g., run `npm run build`, run tests, check for lint errors).
  2. Fix any issues found during the check.
  3. Once verified clean, commit the changes.
  4. Check if there are any open pull requests (e.g., from Dependabot) using the `gh` CLI, and review, merge, or close them if appropriate.
  5. Automatically push the changes to GitHub (`git push`) to trigger the deployment. You do NOT need to ask for permission again.

# AI Evaluation
- **SOLE AIM AUTHORITY**: Follow `docs/AIM_SCORING_STABILITY_IMPLEMENTATION_PLAN_2026-08-12.md` for Aim Fit. Compatible Experience and manual-exchange requirements remain in `docs/CAREER_DASHBOARD_AIM_EXPERIENCE_SCORING_IMPLEMENTATION_PLAN_2026-08-12.md`. Older V6/native scoring documents are historical only.
- **MANUAL TWO-STAGE EXCHANGE ONLY**: The Dashboard exports one exact Aim or Experience batch. The personal `$career-dashboard-scoring-protocol` runs the matching repository-owned external runner. The Dashboard then performs a zero-write preview and requires a separate explicit approval before one atomic import.
- **NO DASHBOARD MODEL ORCHESTRATION**: Dashboard, pipeline, cron, route, database, and deployed processes must never call Codex, Agy, OpenAI, Gemini, or another model/API for scoring. Do not create, resume, retry, or reactivate a `NativeScoringRequest`, watcher, V6 agent, or Agy scoring path.
- **AIM V2 COMPLETE-SOURCE BOUNDARY**: Aim workers receive the whole canonical original JD unchanged, question-authorized neutral metadata, and flat factual questions only. Never add an Aim cleaner, summarizer, coverage auditor, retained-block selector, broad evaluator, candidate/resume context, scoring consequence, or Python-owned score arithmetic.
- **SEPARATE STAGES**: Aim is permissive preference triage with closed deterministic consequences and application-owned 0–100 bands; the numeric score is not a hidden Dashboard model gate. Experience is a strict evidence gate: every explicit substantive required criterion must be fully supported; preferred criteria rank only qualified survivors from 80–100. Experience v2 binds the immutable original-JD/Aim-event/extraction source and creates no cleaned-JD artifact.
- **EVIDENCE SAFETY**: Administrative eligibility is score-neutral and excluded. `cannot_evaluate` means approved evidence is silent; `does_not_meet` requires affirmative verified conflict. An explicitly required role-defining credential is substantive and terminal when not established, while remaining `cannot_evaluate` rather than an invented negative biography claim.
- **TRAVEL**: Explicit travel contributes to Aim and remains separately displayed from source text. It never contributes to Experience and must never be inferred from title, territory, or industry.
- **NO FALLBACK**: Native Agy is not a fallback or rollback. If manual exchange safety gates fail, stop and preserve the batch unchanged.
- **MIXED RESULT IMPORT**: A valid v2 artifact may contain complete terminal jobs plus schema-valid safe failures. Preview remains globally applicable; after Joseph separately approves, one serializable transaction imports complete jobs, releases safe-failure leases, and records bounded non-score failure receipts. Artifact-level validation failure remains tokenless and zero-write.
- **FAIL-CLOSED EXPORT GATES**: New Aim and Experience v2 exports are allowed only when their exact runtime gate is the string `true`. A closed gate must create no batch, lease, score event, or reconciliation write.

# User Persona & Target Roles
- **Target Persona**: The user is a multi-state Commercial Growth / Field Sales / Distributor & Channel Management professional.
- **Primary Target Roles**: Territory Sales Manager, Regional Sales Manager, District Sales Manager, Field Sales Manager, Area/Regional Business Manager, Market Execution Manager, Channel Manager, Distributor or Distribution Sales Manager, Partner Manager, Partner Enablement Manager, Strategic/Key/National Account Manager, Account Director, Market Development Manager, Commercial Growth Manager, GTM/Route-to-Market Manager, and field-facing Sales Effectiveness, Sales Enablement, or Commercial Operations roles.
- **Secondary Target Roles**: Balanced Account Executive, consultative Technical Sales, and commercially accountable Customer Success or partner-platform roles when the mandatory qualifications are supported.
- **DO NOT BLOCK SALES**: Never write filters, code, or local triage blocklists that exclude "Account Executive", "Sales Manager", or general Sales titles (unless explicitly told to block "Inside Sales" or "Retail Sales").
- **CRITICAL**: Do NOT hallucinate that the user is a Product Manager, Software Engineer, or Technical PM. The user wants high-travel, field-based, sales/management roles!

# Local Development
- **Starting the Server**: When the user asks to start the server (e.g., `npm run dev`), ALWAYS use the `run_command` tool with `BypassSandbox: true`. This is strictly required because the server needs access to the host's Tailscale network to connect to the database on the Pi.
- **API Key Management**: NEVER overwrite or delete existing API keys in the `.env` file when adding new ones. Always append them to the existing list (e.g., in `RAPIDAPI_KEYS` or similar variables), as they renew monthly and should remain in the rotation pool.

# Architecture & Runbooks
- **Scoring implementation authority**: `docs/CAREER_DASHBOARD_AIM_EXPERIENCE_SCORING_IMPLEMENTATION_PLAN_2026-08-12.md`.
- `docs/ANTIGRAVITY_V6_SCORING_WALKTHROUGH.md` and `.agents/v6_architecture_audit_context.md` are historical evidence only and must not be followed as operating instructions.
