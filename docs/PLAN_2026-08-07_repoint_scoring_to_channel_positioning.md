# Implementation Plan — Repoint Ingestion & Scoring to the v3 Channel Positioning

> **RETIRED HISTORICAL PLAN — DO NOT EXECUTE.** Its native-scoring instructions are superseded by `CAREER_DASHBOARD_AIM_EXPERIENCE_SCORING_IMPLEMENTATION_PLAN_2026-08-12.md`.

**Created:** 2026-08-07
**Status:** Not started
**Scope:** Ingestion queries, local heuristic, evidence inventory, and the V6 native scoring evaluator.
**Out of scope:** UI, Prisma schema, pipeline orchestration, any Next.js route code.

---

## 0. Why

The résumé was rebuilt on 2026-08-07 and repositioned from "multi-state commercial growth / field sales" to **channel sales / partner management**, with the title claimed as **Channel Account Manager**. The scoring stack still evaluates against the previous résumé and a stale evidence set, so every A/E fit score is being judged against a candidate profile that no longer exists — and one containing at least one claim now known to be false.

Three factual corrections came out of that rebuild and must propagate:

| Correction | Detail |
|---|---|
| **"consecutive 15%+ YoY" is false** | 15% was an annually re-set *mandate*. Actual years ranged from slightly under to 22%+, averaging ~15%. Cumulative retail growth was 156% (5,000 → 12,800+). |
| **DSI-011 overstates fraud reduction** | One *specific fraud type* (mismatched address + no-install) went to near zero, not all fraudulent orders. |
| **Rockstar figures are now independently verified** | The 2017 PBC WI year-end newsletter confirms Oshkosh 52,504 cases / +11.81%, Wisconsin market 303,758 / +4.63%, and the three-branch total of 94,578. |

---

## 1. Prerequisites

1. **Commit or stash the working tree first.** ✅ Done 2026-08-07.
2. **Source résumé:** ✅ Already copied to `data/resumes/Joseph_Lamb_Channel_Sales_Resume_v3.docx`. Mammoth extraction verified — 6,460 chars, contains `Channel Account Manager`, contains no `consecutive 15`.
3. **Master evidence source of truth:** ✅ Already copied to `docs/Candidate_Evidence_Inventory_-_Core_v1.md`. The `.agents/` evidence set is a derived subset of this file.
4. Obey `AGENTS.md`: never add a login screen; read `node_modules/next/dist/docs/` before touching any Next.js code (this plan should require none).

Everything needed is now inside the repo. No external paths are required.

---

## 2. Guardrails that will throw if you get this wrong

These are runtime assertions, not just tests. Read this section before editing anything.

**Résumé binding.** `assertEvaluatorResumeMatches()` (`src/lib/nativeScoringPromptBinding.ts`) compares Section 1 of the standard evaluator prompt against the text extracted from the baseline `.docx`. Comparison canonicalizes by stripping *all* whitespace and dropping contact-pattern lines that appear in the first five lines. Everything else must match exactly. It is called at runtime from `scripts/prepare_native_scoring_phase.ts:511` — a mismatch aborts the scoring phase.

**Evidence mirror.** `prepare_native_scoring_phase.ts` also requires the fenced JSON block under `### Minified Evidence Inventory` inside the evaluator prompt to be canonically identical to `.agents/minified_evidence.json`. Both must be updated together.

**Hardcoded baseline path**, in two places that must stay in sync:
- `scripts/prepare_native_scoring_phase.ts:57` → `baselineResumeFile`
- `src/lib/__tests__/nativeScoringProfile.test.ts:12` → `resumePath`

---

## Phase 1 — Rebind the evaluator to the v3 résumé

*Highest priority. Everything downstream inherits this.*

### 1.1 Add the résumé to the repo — ✅ ALREADY DONE

`data/resumes/Joseph_Lamb_Channel_Sales_Resume_v3.docx` is in place.

> **Decision for the user, not a change to make:** `getAllResumes()` (`src/lib/resume.ts`) loads *every* `.docx` in that directory and the local heuristic picks the best-overlap one for `recommendedResume`. Three stale résumés remain alongside it (`JosephLamb.CS.resume.docx`, `Joseph_Lamb_Core_Commercial_Growth_Resume_v2.docx`, `Joseph_Lamb_Resume.docx`). Leaving them will skew `recommendedResume` toward outdated documents. Flag this; do not delete them unilaterally.

### 1.2 Repoint the baseline path

Update both hardcoded references to `data/resumes/Joseph_Lamb_Channel_Sales_Resume_v3.docx`:

- `scripts/prepare_native_scoring_phase.ts:57`
- `src/lib/__tests__/nativeScoringProfile.test.ts:12`

### 1.3 Replace Section 1 of the evaluator prompt

In `.agents/agents/standard-job-evaluator-v6/agent.md`, replace everything between `## 1. Candidate Resume` and `## 2. Context Rules & Policy Precedence` with the mammoth-extracted text of the new `.docx`. Generate it rather than retyping it:

```bash
node --import tsx -e "
import * as mammoth from 'mammoth';
const r = await mammoth.extractRawText({ path: 'data/resumes/Joseph_Lamb_Channel_Sales_Resume_v3.docx' });
process.stdout.write(r.value);
" > /tmp/resume_v3.txt
```

Paste that verbatim. Do not hand-edit it afterward — any wording drift breaks the binding.

### 1.4 Update the frozen interpretation block

`### Frozen commercial-growth resume interpretation` (~line 133) references the old positioning. Rewrite for the channel framing. In particular it must no longer imply the candidate's headline claim is consecutive 15%+ growth.

### 1.5 Update Section 3, Target Persona

Currently: *"multi-state Commercial Growth / Field Sales / Distributor & Channel Management professional."*

Change to lead with channel. Primary target roles should be reordered to put **Channel Account Manager, Channel Sales Manager, Partner Account Manager, Distribution Account Manager, Partner Development Manager, Regional Channel Manager** first, with territory/regional/field roles secondary.

Add the industry-preference signal from the targeting work — networking and connected hardware, physical security and access control, telecom and carrier ecosystem, POS and payments, IoT and telematics — as **aim-score** input only. Per the existing "Independent scoring passes" rule, industry preference must never touch `experienceFitScore`.

Preserve the existing `DO NOT BLOCK SALES` and anti-hallucination directives verbatim.

### 1.6 Bump the prompt version

`src/lib/nativeScoringBatch.ts:11` — `STANDARD_PROMPT_VERSION` from `standard-job-evaluator-v6.6.2` to `standard-job-evaluator-v6.7.0`. Update the heading inside `agent.md` to match, plus the assertion in `nativeScoringProfile.test.ts:18`.

### 1.7 Fix the test that asserts the old tagline

`src/lib/__tests__/nativeScoringProfile.test.ts:27` asserts:

```
/MULTI-STATE TERRITORY GROWTH \| DISTRIBUTOR & CHANNEL MANAGEMENT \| B2B FIELD SALES/
```

⚠️ **Whitespace gotcha — this will bite you.** The v3 tagline reads `CHANNEL SALES | DISTRIBUTOR & PARTNER MANAGEMENT | MULTI-STATE TERRITORY GROWTH`, but mammoth extracts it with **multiple spaces around each pipe** (`CHANNEL SALES   |   DISTRIBUTOR…`), because the document uses padded separators. A single-space regex silently fails to match and produces a confusing test error. Use flexible whitespace:

```js
/CHANNEL SALES\s+\|\s+DISTRIBUTOR & PARTNER MANAGEMENT\s+\|\s+MULTI-STATE TERRITORY GROWTH/
```

The same applies to the Core Competencies line, which uses `·` separators with double spaces. This does **not** affect `assertEvaluatorResumeMatches` — that canonicalizer strips all whitespace before comparing — but it does affect any regex written against the raw prompt text.

---

## Phase 2 — Sync the evidence inventory

Eleven entries exist in the master inventory but not in the scoring set. Four of them are the highest-value records in the file — the evaluator is currently structurally unable to credit the candidate's scope or growth because the evidence isn't loaded.

**Missing:** `DSI-022`, `DSI-023`, `DSI-024`, `DSI-025`, `ROC-004`, `ROC-005`, `ROC-006`, `ROC-007`, `TMO-005`, `TMO-006`. (`EDU-002` is retired — do not add.)

### 2.1 Add the entries

Append to **both** `.agents/minified_evidence.json` and the fenced block under `### Minified Evidence Inventory` in `agent.md`, in `{ id, tags, scope_notes }` shape matching existing entries. Source the tags and scope notes from the master inventory columns.

### 2.2 Apply the three corrections

| Entry | Change |
|---|---|
| **DSI-025** | Its scope note currently ends *"…candidate-confirmed consecutive 15%+ year-over-year growth."* **This is false.** Replace with: 15% was an annually re-set mandate; actual years ranged from slightly below to above 22%, averaging ~15%; cumulative retail growth was 156% (5,000 → 12,800+ annual net adds); retail was the smallest of three motions (B2B, D2D, retail) and B2B/D2D results are undocumented. |
| **DSI-011** | Change "reduced fraudulent orders to near zero" to scope it to a **single fraud type** (mismatched address + no-install). Keep the existing prohibition on inventing exact percentages. |
| **ROC-002 / ROC-006 / ROC-007** | Add a note that the 2017 PBC WI year-end newsletter independently verifies 52,504 Oshkosh cases, +11.81% vs. a 4.63% market, and the 94,578 three-branch total. These are documented, not candidate-recalled. |

### 2.3 Keep `evidenceInventory.test.ts` green

`src/lib/__tests__/evidenceInventory.test.ts` fails any entry carrying a tag from its `forbiddenTags` set (`enterprise account ownership`, `CRM administration`, `deal desk ownership`, etc.). Check new entries against that list before committing.

---

## Phase 3 — Ingestion queries

`src/lib/jobSearchQueries.ts` is twelve title strings with no description-language and no industry dimension.

### 3.1 Reorder and extend the title set

Lead with `channel account manager`. Add: `partner development manager`, `regional channel manager`, `channel manager`, `distribution account manager`. Consider demoting `customer sales manager` and `strategic territory manager`, which are low-yield.

### 3.2 Add a description-language query set

The highest-hit-rate searches are body-text phrases, because they only appear in postings written by people who actually run a channel. Add as a separate exported constant:

```
'two-tier distribution', 'sell-through', 'distributor management',
'authorized reseller', 'channel partner program', 'partner enablement',
'indirect channel', 'master agent', 'MDF'
```

**First determine whether the ATS search path supports free-text body queries or title-only matching** — check `src/app/api/pipeline/run/route.ts:62` and `src/lib/atsApi.ts`. If it's title-only, these belong in the local heuristic (Phase 4) instead, not in ingestion.

### 3.3 Update the exact-match test

`src/lib/__tests__/jobSearchQueries.test.ts` asserts the array with `deepEqual`. It will fail; update it to the new set.

---

## Phase 4 — Local heuristic signals

`src/lib/jobScoring.ts`.

### 4.1 `TARGET_TITLE_SIGNALS` (~line 207)

There is no signal for the literal string **"channel account manager"** — the candidate's own claimed title. The generic channel/partner pattern (weight 15) catches it only incidentally. Add an explicit high-weight signal (≥16, on par with strategic/enterprise account leadership).

### 4.2 `COMMERCIAL_GROWTH_SIGNALS` (~line 264)

Missing channel vocabulary. Add: `sell-through`, `two-tier distribution`, `MDF` / `market development funds`, `partner program`, `deal registration`, `authorized reseller`. The existing `distributor/dealer network` and `joint business planning` signals are good and should stay.

### 4.3 Verify hunting penalties don't misfire on channel roles

`huntingPenalty` caps at 70 and `NON_TARGET_TITLE_REJECTS` is aggressive. Channel postings frequently say "recruit new partners" or "partner acquisition," which reads as hunting vocabulary. Confirm partner-recruitment language isn't triggering the hunter cap on otherwise-correct roles.

### 4.4 Location filter — decision required, not a code change

`src/lib/jobFiltering.ts` is tightly scoped to Minneapolis metro plus general-US-remote. The candidate has stated that **high travel is a requirement, not a tolerance**. Field and channel roles are routinely posted from a headquarters city the holder never lives in. Quantify how many otherwise-qualified roles this rejects before changing anything — this is a policy question for the user, not an obvious fix.

---

## Phase 5 — Verification

```bash
npm test                        # full unit suite
npm run scoring:contract:check  # schema/contract validation
npm run scoring:canary          # end-to-end scoring canary
```

Then confirm each of these explicitly:

1. `assertEvaluatorResumeMatches` passes against the v3 `.docx`.
2. The baked evidence block and `.agents/minified_evidence.json` are canonically identical.
3. No occurrence of `consecutive 15` remains anywhere outside `.agents/eval_runs/` (historical run artifacts — leave them alone):
   ```bash
   grep -rn "consecutive 15" --include=*.md --include=*.json --include=*.ts . \
     | grep -v node_modules | grep -v eval_runs
   ```
4. `STANDARD_PROMPT_VERSION` matches the heading in `agent.md`.
5. Run `npm run scoring:request` and inspect several fresh evaluations — confirm the new evidence IDs (`DSI-024`, `DSI-025`) are actually being cited in `experienceFitReason`.

### Rescoring

Existing scores were produced against the old profile and are not comparable. After verification, consider `npm run rescore:recent` (dry run first, then `rescore:recent:apply`), or a broader rescore via the stale-inbox path in the V6 state machine.

---

## Suggested commit sequence

1. `chore: commit in-flight native scoring work` — clear the tree first
2. `feat: rebind V6.7.0 evaluator to channel-sales resume v3`
3. `fix: sync evidence inventory and correct consecutive-15% claim`
4. `feat: expand ingestion queries for channel vocabulary`
5. `feat: add channel signals to local heuristic`

Phases 1 and 2 must land together — the evaluator will refuse to run if the résumé and evidence bindings disagree.
