# Native Antigravity scoring V6.5

> **RETIRED HISTORICAL RECORD — DO NOT EXECUTE.** Native Agy scoring and every command below are superseded by `CAREER_DASHBOARD_AIM_EXPERIENCE_SCORING_IMPLEMENTATION_PLAN_2026-08-12.md`. Use the Dashboard manual Aim/Experience JSON exchange and `$career-dashboard-scoring-protocol`; never start, install, retry, or restore the watcher.

V6.5 runs negative-only Context maintenance and A/E qualification from one durable dashboard request. It does not require JSON download/upload and does not call a model API.

## Workflow

1. The dashboard creates or resumes one `NativeScoringRequest`.
2. Context processes intentional preference rejections only. Applied, interviewing, expired, archived, and non-preference decisions never enter Context.
3. The state machine requeues stale active A/E scores, snapshots the bound resume, evidence inventory, negative Context profile, and jobs, then creates immutable chunks of five.
4. Registered native evaluators return one strict JSON result per chunk. The importer verifies manifest hashes, result shape, job order, optimistic versions, Context version, and evidence IDs before an atomic import.
5. The request completes after A/E has no remaining work.

## Qualification policy

Every mandatory requirement is assessed as `direct`, `adjacent`, or `unsupported` with evidence IDs and an explanation.

- Any unsupported mandatory requirement caps Experience at 59.
- Any credible adjacent mandatory support caps Experience at 79.
- Only all-direct mandatory support may score 80 or higher.
- Inbox admission remains Aim 80+ and guarded Experience 70+.
- Context affects Aim/preferences only and can never create or remove qualification evidence.

The importer stores the overall qualification basis and structured mandatory assessments on `JobScoreEvent` for audit.

## Recovery

Run `npm run scoring:recover-local` for a dry run of recent local/location rejects. After review, `npm run scoring:recover-local:apply` processes the last 21 days in batches of 500, verifies liveness, sends invalid descriptions back to JD recovery, and queues newly eligible jobs. Applied/interviewing and other explicit lifecycle states are outside the candidate query.

## Two-release database contraction

The normal release is expand-only and removes every legacy runtime read/write path. After that release is deployed, run `npm run scoring:contract:check`. It aborts if a legacy request, inbox state, or lease remains. Only then may `npm run scoring:contract:apply` remove the retired columns, profile/query tables, and indexes. Historical `JobScoreEvent` rows are retained.

After the contract succeeds, remove the matching legacy declarations from `prisma/schema.prisma` in the second code release and regenerate Prisma Client.

## Validation

Use `npm test`, `npm run scoring:canary`, `npm run build`, and the expand-only migration checker before deployment. A production-shaped native request should complete Context then A/E with no retired phase or response fields.
