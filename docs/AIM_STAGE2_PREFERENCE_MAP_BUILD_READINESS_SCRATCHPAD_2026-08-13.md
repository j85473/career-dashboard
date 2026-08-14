# Aim Stage 2 Preference Map — Build-Readiness Scratchpad

**Started:** 2026-08-13  
**Status:** Design discussion only  
**Implementation authorization:** None

## Purpose and control boundary

This scratchpad is the pre-build list for reconsidering Aim Stage 2 as one
holistic Terra High judgment using Joe's multidimensional preference map and the
complete original job description.

It does not supersede the existing Aim design, authorize implementation, or
establish that every idea below is correct. The new direction must be resolved,
calibrated, and explicitly approved before any scoring code or production policy
changes.

- Do not implement from this scratchpad.
- Do not edit prompts, policies, schemas, runners, imports, database state, or
  production from these notes.
- Do not run calibration or scoring from these notes.
- Do not commit, push, or deploy from these notes.
- Keep Aim Fit separate from Experience Fit. Stage 2 asks whether Joe would
  want the work, not whether Joe is qualified for it.
- Preserve the complete original JD unchanged as the source supplied to Stage 2.
- Preserve the external manual exchange boundary: Dashboard export -> external
  controller -> scored JSON -> zero-write preview -> explicit approval -> atomic
  import.
- Any change from the earlier atomic-question Stage 2 design must be explicit;
  it must not happen through accidental drift in this document.

## Working thesis

Job titles are poor representations of Joe's preferences. Different sales roles
can contain the same attractive or unattractive work motions, while similar
titles can describe completely different jobs.

The proposed Stage 2 therefore gives Terra:

1. the complete unchanged JD;
2. a structured multidimensional map of work motions Joe likes and dislikes;
3. a concise definition of Aim Fit and score anchors; and
4. a minimal output request for one holistic score and rationale.

Terra interprets the actual role across the preference dimensions, then places
the complete job on one final spectrum:

```text
Joe would strongly avoid this <----------> Joe would strongly want this
```

The multidimensional map is the vocabulary for understanding the role. It is
not automatically a deterministic formula, checklist, or set of component
scores.

## Proposed system shape

```text
Complete Dashboard export
        |
        v
Deterministic bounded hard kills
        |
        | survivor only
        v
One Terra High Stage 2 call
  - complete unchanged JD
  - Joe/Joseph preference map
  - Aim definition and score anchors
        |
        v
One holistic Aim score + concise rationale
        |
        v
Deterministic validation and recording
        |
        v
Existing preview, approval, and atomic import boundary
```

## Decisions to resolve before building

### 1. Lock the exact decision Stage 2 answers

- [ ] Write the one-sentence definition of Aim Fit.
- [ ] Confirm that the operative question is conceptually: "Given the actual
  work described, how much would Joe/Joseph want this role?"
- [ ] Confirm that Terra must assume Joe is fully qualified.
- [ ] Explicitly exclude resume match, likelihood of being hired, credentials,
  and missing experience from Aim Fit.
- [ ] Decide whether company reputation, perceived benefits, compensation above
  the hard floor, and application history are excluded, neutral, or permitted.
- [ ] Decide whether career-direction value is part of Aim Fit or whether Aim
  covers only attraction to the work itself.

### 2. Define the preference-map model

- [ ] Decide whether the persisted map is best described as dimensions,
  families, positive/negative regions, or another plain-language structure.
- [ ] Use independent work motions instead of forcing false opposites. For
  example, strategic new-business development and existing-account expansion
  may both be attractive, while high-volume cold outbound is a separate
  unattractive motion.
- [ ] Decide whether every motion needs a signed desirability value `d`, such as
  `-3` through `+3`, or whether ordered language such as strongly attractive,
  attractive, neutral, unattractive, and strongly unattractive is clearer.
- [ ] Define what the magnitude of `d` means. It should represent preference
  intensity, not proof strength, job centrality, or a predetermined point value.
- [ ] Decide whether neutral/context-dependent motions live at `d = 0` or in a
  separate conditional section.
- [ ] Define how ideal-range preferences work when neither extreme is best.
  Travel may be the first important example.
- [ ] Decide how hard aversions differ from ordinary negative preferences. Hard
  kills remain deterministic and must not be smuggled into the Stage 2 map.
- [ ] Establish a rule that absence of an attractive motion is not affirmative
  evidence of an unattractive motion.

### 3. Build the work-motion vocabulary

- [ ] Identify the smallest set of broad dimensions that captures Joe's actual
  preference space without reverting to hundreds of micro-questions.
- [ ] Draft positive and negative anchors inside each dimension.
- [ ] Describe motions in title-independent language.
- [ ] Separate commonly conflated motions, including:
  - strategic new-logo development vs. high-volume cold prospecting;
  - partner-generated growth vs. personal direct hunting;
  - consultative product fluency vs. technical-demo ownership;
  - existing-account expansion vs. low-autonomy maintenance;
  - building a program vs. merely joining an immature company;
  - external relationship ownership vs. internal coordination;
  - leadership/influence vs. formal people management.
- [ ] Check the vocabulary for overlapping synonyms that could cause Terra to
  count one JD fact multiple times.
- [ ] Check for missing attractive motions that appear across different sales,
  partnerships, account, customer, and commercial titles.
- [ ] Check for missing unattractive motions that matter even when the job title
  looks appealing.
- [ ] Decide whether industry and product interest belong in the same map as
  work motions or in a separate contextual section.

### 4. Capture conditional preferences and interactions

- [ ] Record preferences that change with context instead of assigning a false
  universal positive or negative.
- [ ] Define the conditions that make new-business work attractive or draining.
- [ ] Define when technical depth is attractive and when the role becomes
  technical presales/support work Joe would not want.
- [ ] Define when account ownership is attractive and when it becomes repetitive
  maintenance with little authority.
- [ ] Define how travel amount, geography, purpose, and external engagement
  interact.
- [ ] Decide how Terra should treat a role with several strong positives and one
  central strong negative.
- [ ] Decide how reinforcing positives should affect the holistic judgment
  without being mechanically double-counted.

### 5. Define how Terra reads the JD

- [ ] Require Terra to judge the substance of the responsibilities rather than
  infer fit from the title.
- [ ] Require Terra to distinguish central day-to-day work from incidental
  duties, boilerplate, employer branding, and generic sales language.
- [ ] Define an evidence-strength vocabulary, if any: explicit, strongly
  implied, ambiguous, or absent.
- [ ] Decide how much inference is acceptable when the JD describes outcomes but
  not the operating motion used to achieve them.
- [ ] Decide how sparse JDs should score when they show neither strong positives
  nor strong negatives.
- [ ] Decide whether the rationale should point to specific JD language without
  imposing exact-quote machinery on the holistic judgment.
- [ ] Ensure repeated wording does not automatically become repeated preference
  evidence.

### 6. Design the actual Stage 2 prompt

- [ ] Keep the prompt thin enough that Terra performs a holistic judgment rather
  than reenacting the old question bank in prose.
- [ ] Determine the minimal instruction set:
  - Aim Fit definition;
  - assume Joe is qualified;
  - complete unchanged JD;
  - preference map;
  - interpretation rules;
  - score anchors; and
  - minimal output contract.
- [ ] Decide how Joe/Joseph is named so relevant personal memory can be used
  intentionally.
- [ ] State that the explicit map in the prompt controls if memory conflicts.
- [ ] Decide whether memory is optional enrichment or a required part of the
  evaluator identity.
- [ ] Remove unnecessary implementation language, hard-kill details, prior
  calibration history, formulas, component budgets, and lifecycle consequences
  from the model-facing prompt.
- [ ] Decide whether Terra should see any worked examples. If so, use very few
  and ensure they teach interpretation rather than encourage title matching.
- [ ] Review the final prompt for instruction overload and disguised checklists.

### 7. Lock the score meaning

- [ ] Define stable 0-100 anchors in plain language.
- [ ] Decide what score means "Joe should seriously consider applying."
- [ ] Decide what score means genuinely mixed rather than insufficient evidence.
- [ ] Decide whether low-information JDs should produce a middle score, reduced
  confidence, or a separate cannot-evaluate state.
- [ ] Decide whether confidence is useful and, if retained, what it measures.
- [ ] Confirm that Aim bands and Dashboard sorting thresholds agree with the new
  anchors before import is permitted.
- [ ] Avoid giving Terra fake precision instructions that imply a difference
  between 73 and 74 is objectively measurable.

### 8. Lock the output contract

- [ ] Choose the smallest reliably parseable response shape.
- [ ] Require exactly one integer score from 0 through 100.
- [ ] Require a concise holistic rationale explaining the decisive attractive
  and unattractive motions.
- [ ] Decide whether to request one principal positive and one principal concern
  or leave the rationale free-form.
- [ ] Decide whether the script records Terra's rationale verbatim.
- [ ] Decide what constitutes an invalid response.
- [ ] Decide whether invalid output fails safely with no retry or permits one
  formatting-only repair that cannot reconsider the score.
- [ ] Ensure the script never recomputes, reweights, adjusts, or interprets the
  holistic model score.

### 9. Confirm the deterministic boundary

- [ ] Inventory the exact Stage 1 hard kills that survive unchanged.
- [ ] Confirm that a hard-killed job never reaches Terra Stage 2.
- [ ] Keep compensation normalization and the explicit below-$60,000 maximum
  annual total-cash rule deterministic; exactly $60,000 passes and missing or
  non-comparable compensation fails open.
- [ ] Keep hashes, export membership, JD identity, validation, preview, approval,
  atomic import, lifecycle changes, and immutable human decisions code-owned.
- [ ] Decide what evaluator identity must be recorded: model, reasoning effort,
  prompt version, preference-map version, memory-enabled status, and JD hash.
- [ ] Decide whether an unchanged accepted result is reused or whether a fresh
  model judgment is allowed in normal operation.
- [ ] Keep the model outside the Dashboard process and database boundary.

### 10. Resolve memory behavior deliberately

- [ ] Confirm whether the Stage 2 worker will enable Codex memories. The current
  worker disables them, so merely naming Joe/Joseph is not sufficient.
- [ ] Decide which memory scope is acceptable for Aim Fit.
- [ ] Define prohibited leakage from memory, especially qualifications,
  application anecdotes, transient emotions, stale preferences, or unrelated
  personal facts.
- [ ] Decide how explicit prompt preferences override stale or conflicting
  memory.
- [ ] Accept or reject the reproducibility tradeoff introduced by evolving
  memory.
- [ ] Record enough evaluator identity to distinguish memory-enabled and
  memory-disabled results without pretending the full injected memory state is
  perfectly reproducible.
- [ ] Test the prompt both with and without memory to learn whether memory adds
  signal or merely variability.

### 11. Design a real calibration set before implementation

- [ ] Assemble at least 15-20 real JDs Joe already knows how he feels about.
- [ ] Cover strong want, want, mixed, do not want, and strong avoid.
- [ ] Include several misleading titles whose underlying motions reveal the true
  preference.
- [ ] Include roles with genuine conflicts among attractive and unattractive
  motions.
- [ ] Include sparse JDs and verbose JDs.
- [ ] Keep "like but unqualified" examples in the positive Aim group so
  Experience Fit does not contaminate Aim calibration.
- [ ] Record Joe's labels and short reasons before seeing Terra's scores.
- [ ] Lock the preference map and prompt before the test.
- [ ] Run the unchanged evaluator at least twice on the same set.
- [ ] Measure ordering, band agreement, threshold agreement, rationale quality,
  and score movement across fresh runs.
- [ ] Compare memory-enabled and memory-disabled behavior separately rather than
  changing several system authorities within one test.
- [ ] Treat prompt or map revisions as new systems; never call successive fitted
  passes repeatability tests.
- [ ] Reserve a small holdout set that is not used to tune the map or prompt.

### 12. Define correction rules before calibration

- [ ] When a result is wrong, classify the failure before editing anything:
  - Terra misunderstood the role;
  - the preference map omitted a motion;
  - a preference direction or intensity is wrong;
  - a conditional interaction is missing;
  - the score anchors are unclear;
  - memory distorted the judgment; or
  - Terra made a poor holistic decision despite correct understanding.
- [ ] Change only one authority at a time during calibration.
- [ ] Do not add a new preference solely to fix one job unless it represents a
  reusable truth about Joe's preferences.
- [ ] Do not introduce title-specific exceptions.
- [ ] Do not convert every surprising score into another rule.
- [ ] Set a stopping rule so calibration does not become indefinite prompt
  fitting.

### 13. Plan the migration only after the design passes calibration

- [ ] Identify which existing Stage 2 prompts, question registries, policies,
  builders, schemas, and tests would be superseded, retained for history, or
  reused for Stage 1 only.
- [ ] Preserve audit history; do not silently rewrite prior scores as though they
  came from the new evaluator.
- [ ] Version the new preference map, prompt, output schema, and evaluator
  identity independently.
- [ ] Decide whether existing unapplied calibration artifacts remain readable
  but permanently non-importable.
- [ ] Define rollback behavior before enabling the new Stage 2 path.
- [ ] Require zero-write preview and explicit approval for the first scored
  import under the new system.
- [ ] Confirm that no old deterministic Stage 2 weights remain secretly active
  after cutover.

## Candidate preference-map families — provisional only

These are prompts for discussion, not an approved map and not a final count.

1. Building, creation, transformation, and improvement
2. Ownership, autonomy, and decision authority
3. Partner, channel, alliance, and distributor motions
4. Strategic new-business and market-development motions
5. Existing-account growth and relationship ownership
6. Customer engagement, advising, and executive interaction
7. Work texture: strategic/varied vs. scripted/repetitive
8. Technical role: consultative fluency vs. technical execution/support
9. Leadership, influence, and cross-functional leverage
10. Travel, field presence, and external engagement
11. Product, problem, and industry interest
12. Operational burden, administration, and internal process load

The positive and negative anchors inside these families may be more valuable
than the family names. Families exist to prevent omissions and clarify
relationships; Terra should not be required to return twelve sub-scores.

## Explicit anti-goals

- Do not recreate the 342-question system inside one enormous prompt.
- Do not ask Terra to output a score for every dimension unless calibration
  proves that an internal diagnostic view is essential.
- Do not multiply inferred motion scores by deterministic weights and call the
  sum the holistic Aim score.
- Do not infer preference from title alone.
- Do not treat every positive and negative phrase as independent evidence.
- Do not treat silence as dislike.
- Do not let Experience Fit, resume evidence, or hiring probability enter Aim.
- Do not allow memory to override the explicit current preference map.
- Do not tune against only the three jobs used in the August 13 loop.
- Do not claim stability when the prompt, map, model, memory setting, or score
  anchors changed between passes.

## Build-readiness exit criteria

No implementation plan should be written until all of the following are true:

- [ ] Joe has approved the exact Aim Fit definition and exclusions.
- [ ] Joe has approved the preference-map structure and provisional contents.
- [ ] Conditional and ideal-range preferences are represented clearly.
- [ ] The Stage 2 prompt is short enough to preserve holistic judgment.
- [ ] The score anchors and output contract are approved.
- [ ] Memory behavior and its reproducibility tradeoff are explicitly chosen.
- [ ] The deterministic/model authority boundary is explicit.
- [ ] The calibration set, holdout set, measures, and stopping rule are defined.
- [ ] The unchanged design has demonstrated acceptable calibration and fresh-run
  stability without importing results.
- [ ] A separate implementation plan has audited the current mixed worktree and
  named the exact files to retain, replace, or retire.
- [ ] Joe has separately authorized implementation.

## Immediate next design session

Start with the preference map itself, not the prompt wording or code:

1. List the work motions Joe strongly likes.
2. List the work motions Joe strongly dislikes.
3. Group them into broad families without forcing false opposites.
4. Identify conditional preferences and ideal ranges.
5. Assign provisional direction and intensity values only after the language is
   right.
6. Test the map verbally against five contrasting real roles before drafting the
   Stage 2 prompt.

