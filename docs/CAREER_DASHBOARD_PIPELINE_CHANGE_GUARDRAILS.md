# Career Dashboard Pipeline Change Guardrails

**Companion to:** [Pipeline Contract](CAREER_DASHBOARD_PIPELINE_CONTRACT.md)
**Purpose:** Prevent a narrowly intended pipeline repair from breaking a different stage, creating stranded jobs, or quietly changing admission semantics.

## 1. When this document applies

Use these guardrails for any change that touches one or more of the following:

- a job's `status`, `scoringStatus`, score-attempt counter, or stage lease;
- discovery/ingestion, source scheduling, provider backoff, deduplication, or JD quality;
- local triage, Aim Fit eligibility, Experience Fit eligibility, exports, previews, imports, or score invalidation;
- pipeline locks, loop supervision, stop/pause behavior, stale-lease cleanup, counters, or history/event records.

It applies equally to an apparently small one-line state change, an emergency recovery script, and a new provider integration. Those changes are all pipeline changes when they can alter a job's next stage.

## 2. Required change packet

Before editing, record these six answers in the pull request, issue, or implementation handoff:

1. **Entry condition:** Which exact lifecycle state, processing state, lease state, and source of truth select the affected jobs?
2. **Exit condition:** What exact state/lease combination will each possible outcome produce?
3. **Owner:** Which existing stage owns the change? If ownership moves, which old owner stops writing it?
4. **Failure semantics:** Is the outcome a closed posting, duplicate, deterministic rejection, retryable operational failure, terminal Action Needed failure, or model-fit rejection?
5. **Idempotency and recovery:** What happens if the request repeats, a process restarts, or the job is edited by a user while work is in flight?
6. **Proof:** Which focused regression test proves the happy path, each changed terminal path, and lease release?

If any answer is unknown, stop at design/read-only investigation. Do not choose a new lifecycle rule opportunistically while implementing a bug fix.

## 3. Non-negotiable rules

### Stage order

The automatic survivor route is:

```text
discovery -> prefilter -> JD-ready/recovery -> local triage -> Aim Fit -> Experience Fit -> Inbox
```

Permitted short-circuits are terminal outcomes only: duplicate, confirmed closure, deterministic prefilter/local rejection, or explicit Action Needed failure. A convenience call from JD recovery to local scoring is permitted only because it still executes local triage; it cannot call Aim/Experience or set Inbox directly.

### State and lease pairing

- Set a claim state and its lease atomically where possible.
- Clear the old lease before placing a job in the next queue.
- Require the expected current state and lease in the update `where` clause, so user edits or another worker cannot be overwritten.
- A stale-lease repair may release only expired leases under the owning stage's documented timeout; it must not reset a live owner.
- Do not use a broad "requeue all failed jobs" query. Requeue only a demonstrable prior false-rejection population or an explicitly selected retry receipt, and preserve human lifecycle decisions.

### Failure meanings

| Meaning | Correct handling | Never substitute with |
| --- | --- | --- |
| Closed posting | `dismissed + skipped`, explicit closed reason | a JD-recovery failure |
| Duplicate | Record/retain source evidence; archive or preserve the canonical job | a new scoring candidate |
| Prefilter or local deterministic rejection | `dismissed + skipped` with the deterministic reason | an Aim/Experience rejection |
| Retryable operational failure | Release lease; bounded retry state and retained error | a dismissal or an infinite retry |
| Terminal operational failure | `failed` and Action Needed | automatic dismissal |
| Aim/Experience non-pass | Imported model decision and dismissed lifecycle projection | "no evidence" or worker error |

### Authority boundaries

- The source/JD/local stages may not claim a role is a good fit; only the manual Aim and Experience imports own the final acceptance decision.
- Aim and Experience imports are separate. An Aim survivor is not an Inbox job.
- Preview is strictly zero-write. Apply is a separate, explicit approval action.
- The job row is current-state projection. Immutable `JobPipelineEvent` and `JobScoreEvent` records are required when explaining history or score authority.
- Source/request errors are not job failure counts. Keep task/provider telemetry separate from job-state telemetry.

## 4. Change-impact map

Use this map to identify the downstream surfaces that must be reviewed and tested when modifying a stage.

| If you change… | Also review… | Typical focused coverage |
| --- | --- | --- |
| Source task identity, cadence, or provider result handling | `IngestionTask` lease/completion, counters, task catalog reconciliation, Stats interpretation | `ingestionControl.test.ts`, task-catalog/scheduler tests |
| Ingestion normalization, duplicate logic, prefilter, or initial state | JD admission, local queue eligibility, pipeline events, score invalidation | ingestion/parser tests, `jobScoring.test.ts`, state-order contract |
| JD quality gate or recovery retry policy | direct ATS intake, Jina fallback, recovery script, local retry path, Action Needed | `jdRecoveryPolicy.test.ts`, `pipelineStageOrderContract.test.ts` |
| Local scoring claim or result state | JD recovery output, stale-lease cleanup, Aim export selection, user lifecycle protection | `jobScoring.test.ts`, `pipelineStageOrderContract.test.ts`, `manualScoringEligibility.test.ts` |
| Aim eligibility/export | local survivor state, leases, stored export identity, preview/apply semantics | `manualScoringEligibility.test.ts`, `scoringExportRouteV2.test.ts` |
| Aim or Experience import/lifecycle projection | score authority, user protection, retry receipts, Inbox admission | `scoringImportV2.test.ts`, import contract tests |
| Pipeline run/stop/supervision | all four loops, shared lock, pause semantics, cleanup, status UI | `ingestionControl.test.ts`, pipeline/state tests |

The listed tests are a minimum impact guide, not permission to skip a focused test that covers the changed function.

## 5. Regression scenarios to retain

Every relevant change must preserve the scenarios below. Add a focused test if one is not already covered.

1. A valid direct ATS description—regardless of English headings or language—reaches local triage when it is not terminal, short, or visibly truncated.
2. A long cookie, login, portal, or error shell cannot reach local scoring or manual scoring.
3. A confirmed closed posting is dismissed once and never consumes JD retries.
4. A recoverable JD failure returns to `needs_jd` with no lingering JD lease; a third failed attempt reaches Action Needed.
5. A recovered JD proceeds through local triage before Aim eligibility. It cannot bypass to Aim or Inbox.
6. A local deterministic rejection is visible as local/prefilter rejection, not as an A/E decision.
7. A local survivor is eligible for Aim only after it is `scored + pending_af`; a local failure is not silently eligible.
8. An Aim survivor remains pending until Experience passes; Experience is the only normal automatic route to Inbox.
9. Repeating a source result or import is idempotent and retains a coherent event trail.
10. A user update during a claim causes the stale guarded write to fail safely and the lease to be released.
11. One provider or one loop failure does not stop JD recovery, local scoring, or stale-lease cleanup.
12. Source counters reconcile as `seen = inserted + duplicates + filtered + processingErrors`, with provider errors reported separately.

## 6. Validation sequence

Run the smallest relevant checks first, then expand only as the touched boundary warrants.

1. `git diff --check` for whitespace and patch integrity.
2. Run the focused unit/contract tests named by the change-impact map.
3. For any state transition change, exercise one fixture for each affected branch: success, retry, terminal failure, and user/lifecycle conflict.
4. For scheduler changes, verify task identity, due selection, completion-based next run, provider retry timing, and a blocked/disabled task.
5. For manual scoring changes, verify stored-export selection, zero-write preview, approval-token apply, input/hash staleness rejection, and user-lifecycle protection.
6. Run TypeScript/lint/build checks in proportion to the affected runtime surface. State clearly when unrelated repository failures remain.
7. Before a production rollout, inspect the deployed migration/service/scheduler state and use the existing guarded deployment path. A successful local test does not establish Pi health.

Do not report a full-pipeline guarantee from one targeted test. Conversely, do not characterize unrelated suite failures as failures of a focused pipeline repair.

## 7. Safe recovery-script rules

Recovery scripts are powerful because they mutate many existing jobs. Treat them as a separate deployment unit.

- Default to dry-run and print the exact selection predicate, counts by planned action, and a small sampled set of job IDs/reasons.
- Use a classifier shared with the live stage whenever possible; do not reimplement the JD or lifecycle semantics in a one-off script.
- Restrict the selection to the demonstrated defect population. Never reset status/attempts because a row merely has a familiar state label.
- Preserve lifecycle-protected jobs, active leases, score authority, and historical events unless the approved repair specifically owns them.
- Make repeated execution safe and report the before/after count for every action.
- Require an explicit approval before the non-dry-run mutation and record the command, predicate, counts, and verification result in the handoff.

## 8. Documentation maintenance rule

When a pipeline change alters any entry condition, exit condition, state meaning, stage owner, retry boundary, or external manual-scoring handoff:

1. Update `CAREER_DASHBOARD_PIPELINE_CONTRACT.md` in the same change.
2. Update/add the corresponding contract test in the same change.
3. State the migration/reconciliation path for jobs already in the old state.
4. In the release note or handoff, name the exact behavior that changed and the behavior explicitly preserved.

This is deliberately lightweight. The goal is not paperwork; it is to make a future "small" repair confront the pipeline edge it could otherwise break.
