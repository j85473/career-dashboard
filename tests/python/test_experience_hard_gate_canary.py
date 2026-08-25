"""The Experience hard-gate canary corpus, run against the runner-side guard.

The same fixture drives src/lib/__tests__/experienceHardGateCanary.test.ts. The
two enforcement layers must reach the same verdict on every case: a runner that
accepts what the Dashboard will refuse burns a whole batch, and a runner that
refuses what the Dashboard would accept silently loses real mismatches.
"""

import json
import pathlib

import pytest

from scripts.scoring_protocol.experience_runner import parse_hard_gate_output

CANARY_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / "tests"
    / "fixtures"
    / "scoring"
    / "experience-hard-gate-canary-v1.json"
)
CANARY = json.loads(CANARY_PATH.read_text())
CASES = CANARY["cases"]


def _job_description(case: dict) -> str:
    body = "About the role. We are hiring a commercial leader for our North America team."
    if case.get("absentFromJd"):
        return body
    return f"{body}\n\n{case['jdQuote']}\n\nApply on our careers site."


def _model_output(case: dict) -> str:
    return json.dumps({
        "hardRequirementsNotMet": [{
            "requirement": case["requirement"],
            "category": case["category"],
            "jdQuote": case["jdQuote"],
            "absoluteBarCue": case["absoluteBarCue"],
            "inventoryComparison": case["inventoryComparison"],
        }],
    })


def _evaluate(case: dict):
    try:
        return True, parse_hard_gate_output(
            _model_output(case), 20, original_jd=_job_description(case),
        )
    except ValueError as error:
        return False, str(error)


def test_canary_corpus_is_complete():
    assert CANARY["version"] == "experience-hard-gate-canary-v1"
    covered = " | ".join(case["name"].lower() for case in CASES)
    for topic in (
        "citizenship",
        "work authorization",
        "clearance",
        "lifting",
        "loading",
        "ordinary duty",
        "presentation",
        "preferred",
        "positive control",
    ):
        assert topic in covered, f"canary corpus is missing {topic} coverage"
    assert any(case["expect"] == "accept" for case in CASES)


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_canary_case(case):
    accepted, detail = _evaluate(case)

    if case["expect"] == "accept":
        assert accepted, f"expected a hard mismatch, got: {detail}"
        assert len(detail) == 1
        evidence = detail[0]
        assert evidence["category"] == case["category"]
        assert evidence["source"]["exactQuote"] == case["jdQuote"]
        # The span must be usable as code-point offsets by the Dashboard.
        original = _job_description(case)
        start = evidence["source"]["startCodePoint"]
        end = evidence["source"]["endCodePoint"]
        assert original[start:end] == case["jdQuote"]
        return

    if case["expect"] == "notMechanicallyEnforced":
        assert accepted, (
            "this case is documented as prompt-only; the runner now refuses it"
        )
        return

    assert not accepted, "expected the runner guard to refuse this evidence"
    if case.get("rejectLabel"):
        assert f"excluded {case['rejectLabel']} requirement" in detail
