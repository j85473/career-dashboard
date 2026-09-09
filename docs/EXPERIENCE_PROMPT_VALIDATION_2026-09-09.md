# Experience Fit failure prevention — September 9, 2026

The historical missing-score failures were predominantly explicit model refusals:
19 of 20 saved answers declined to assign a candidate-fit score, while one
explained the experience match without giving a number. Parsing more formats
cannot supply a score that the model never produced.

Both Experience prompts now explain that Joseph is requesting career guidance
about his own experience to decide whether to pursue the job. The holistic
prompt requests one integer on the first line (`Experience Fit Score: NN/100`),
followed by the documented alignment and gaps. It also explicitly carries the
existing rule that travel and administrative eligibility are score-neutral.

Explicit refusal and missing-score answers retain the existing `output_unusable`
safe-failure code but receive distinct operator-facing explanations. Refusals
that mention an example score or a 0–100 scale cannot become evaluations.
An explanation that declines to give a *higher* score remains a valid assessment.
Existing accepted plain-text and JSON score formats remain supported.

## Validation

- `python3 -m pytest -q tests/python`: 109 passed, including the hard-gate corpus,
  source continuity, no-retry behavior, refusal/omission receipts, low scores,
  and conflicting scores.
- `npm test`: 1,427 passed, including existing-score preservation and imports.
- `npm run lint` and `npm run build`: passed.
- Offline replay: all 1,664 saved successful holistic answers retained the same
  parsed score. The 20 historical missing-score outputs were correctly separated
  into 19 refusals and one omission. No saved result was edited.
- Python runner and TypeScript export input identities agree for the final
  prompts: `a9ba202a7666f15684738db74005e3322d6479df09c348966f219d9273a61d82`.

Joseph explicitly authorized sending the historical job descriptions and his
existing evidence to the usual OpenAI Codex scorer for a local calibration.
The final prompt test used `gpt-5.6-terra`: high effort for the 20 historical
holistic cases and medium effort for four synthetic hard-gate controls.

- All 20 historical cases returned the requested score line and an explanation,
  with no refusals or omissions. Scores ranged from 42 to 94; meaningful
  industry, ownership, and leadership gaps remained visible in the explanations.
- Required CPA licensure and a required minimum of ten years in semiconductor
  fabrication remained hard mismatches with exact quoted evidence.
- Preferred CPA licensure and a waivable experience range remained outside the
  hard gate.
- An initial calibration surfaced administrative conditions in one explanation.
  After stating their existing neutrality explicitly, all 24 cases were tested
  again against the final prompts; the final explanations did not repeat that
  administrative-gap issue.

The final non-importable calibration report is retained locally at
`data/scoring/results/.calibration/20260909-experience-prompts-final/report.json`.
Its SHA-256 is
`051f8a6e24733199443770e207c1dc295554fd51ad75069bc43494da87d8ecc2`.
Raw answers and worker receipts accompany that local report. This is a
single-run failure-prevention check, not proof that future model refusals are
impossible or that numeric judgments are deterministic.

## Scope and release behavior

The change affects new Experience work. Existing scores, completed batches,
failure checkpoints, job lifecycle, qualification rules, configured model,
efforts, and one-attempt-per-phase policy are preserved. No scoring batch was
retried or imported during validation, and no failure was requeued. The
Dashboard continues to export work for the external Mac runner; deployment
does not enable model scoring on the server.
