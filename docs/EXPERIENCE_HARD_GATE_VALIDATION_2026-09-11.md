# Experience Fit mandatory-language correction — September 11, 2026

The scorer and semantic review disagreed about bare experience durations. The
hard-gate prompt explicitly allowed `N years` and `N+ years` as absolute bars,
and both the Python runner and Dashboard import guard accepted them. Semantic
review required explicit mandatory language. Repeating a batch under those
contradictory rules predictably produced another review hold.

## Result on the reported run

The saved assertions from run `df045c12-ba6f-4990-a5c7-89b162205d99` were replayed
through the corrected runner against their full original job descriptions.
No model was called and no score or review decision was changed.

| Measure | Saved run | Corrected classification replay |
| --- | ---: | ---: |
| Jobs in run | 134 | 134 |
| Hard-stop assertions | 65 | 18 |
| False hard-stop assertions identified by the reported audit | 47 | 0 retained |
| Jobs with at least one hard-stop assertion | 51 | 15 |

All 18 explicitly mandatory assertions remain eligible for hard-gate review.
The other 36 formerly gated jobs would proceed to a fresh holistic assessment:
a 70.6% reduction in jobs requiring hard-stop review on these saved answers.
This is a classification replay, not a new scored batch or a forecast of the
next model run. Whether an asserted inventory gap is actually unsupported
still requires the existing semantic review.

The detailed non-importable replay, including source hashes, original cues,
retained evidence, and discarded reasons, is saved at
`data/scoring/results/.calibration/20260911-hard-gate-replay/report.json`.
The checked-in regression corpus preserves all 65 original assertions and
their surrounding source lines in
`tests/fixtures/scoring/experience-hard-gate-df045c12-v1.json`.

## New behavior

- Bare durations and descriptive qualifications cannot independently force a
  zero. Missing experience remains relevant to the holistic score.
- The prompt requires the actual mandatory wording and prohibits inventing
  `at least` in summaries or borrowing a cue from another qualification.
- Both enforcement layers reject bare duration cues and recognize explicit
  `minimum`, `must have`, `required`, `requires`, `at least`, and `mandatory`.
- For an older answer citing `3+ years` from a clause ending in
  `experience required`, the runner binds the actual word `required` from that
  clause. The original model answer remains intact. A preceding degree
  requirement or a cue in another sentence, semicolon clause, or line cannot
  satisfy this fallback. This preserves the two medical-device assertions in
  the reported run that cited the duration instead of the word `required`.
- Recommended, ideal, preferably, typically, and explicit non-required wording
  are excluded. Surrounding clause text is checked so clipped quotes cannot
  omit these modifiers. Sentence, semicolon, and line boundaries limit this
  context check so separate preferred qualifications do not cancel a valid bar.
- Invalid assertions retain a discard explanation and flow to holistic scoring
  when no valid hard requirement remains. Mixed answers retain only valid
  assertions. There is no extra model pass, retry, or automatic passing score.

These are bounded mechanical checks. They do not resolve every possible
scope ambiguity, AND/OR interpretation, or inventory comparison. The existing
semantic review remains in place for retained hard stops.

## Validation

- Shared Python and TypeScript hard-gate corpus: **111 tests passed in each**.
  Coverage includes all 65 reported assertions plus bare and spelled durations,
  invented cues, borrowed degree cues, separate sentences and bullets,
  clipped modifiers, negation, positive mandatory controls, and Unicode spans.
- Complete Python suite: **198 passed**. The first run, concurrent with other
  checks, hit an unrelated Aim timing assertion that expected four simultaneous
  mock calls and observed two. The unchanged complete suite passed when rerun
  without competing checks; no Aim code or tests were changed.
- Complete TypeScript suite: **1,475 passed**, including score preservation and
  scoring import checks.
- Runner behavior test: a bare-duration assertion receives the supplied
  holistic score of 46, with no safe failure or repair. A mixed answer retains
  the required CPA license and stops at zero after one call.
- `npm run build`: passed. `npm run lint`: zero errors; three existing warnings
  in unrelated files.
- Python runner and TypeScript exporter agree on the new input identity:
  `c4340fbcd282fc3744e70c9f45ab862352b03084a1b782a0510801d2a1f74403`.

## Release and preservation

The initial correction was validated in the local checkout. Joseph then
authorized deployment to M70. The release was prepared in an isolated worktree
from production commit `3065ee044ae88507965a0c59c2df1247be7650dd`; the earlier
Experience refusal and missing-score corrections were already in production.
No unrelated local commits were included.

The correction applies prospectively. It does not change evidence, resume,
existing scores, score authority, lifecycle, queues, completed imports, or the
51 pending review decisions. No Dashboard database access, import, finalization,
push, or deployment was performed.

Deploy the matching Dashboard changes before generating a fresh Experience
export for this corrected Mac runner. The prompt change already participates
in the existing input identity. The withheld draft has no holistic scores for
the 36 newly eligible jobs, so changing its review decisions cannot turn it
into a corrected result. A fresh authorized run is required to produce those
scores; do not rewrite the old export hashes or reuse its zero-score results.

## Production-branch validation

The release check found that Stats still filtered Experience calibration scores
by the current prompt/evidence input version, even though job score authority
already treats that drift as informational. The release removes only that
Experience-version filter. Existing explicit invalidation, latest-event ranking,
and source-Aim bindings remain enforced. This prevents the corrected prompt from
making older Experience scores disappear from Stats totals; it writes no scores.

The exact release branch passed **198 Python tests**, **1,530 TypeScript tests**,
`npm run lint` (zero errors, three existing warnings), and the production build
using an intentionally unusable database URL. The exporter and Mac runner still
agree on the Experience input identity reported above. The two added Stats tests
verify that changing only the Experience version cannot change the SQL or its
bound values, and that the existing invalidation and source bindings remain.

Before deployment, a read-only production snapshot contained **46,717 score
events** with digest `5a1968f832a58cfe3d61460338d8a19c`. Deployment verification
will compare those saved events, check live service health, and execute the
hard-gate corpus against the deployed files. This deployment does not generate
or score a new export and does not approve the withheld run.
