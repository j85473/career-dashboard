from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from scoring_protocol.codex_worker import DISABLED_FEATURES, build_worker_command  # noqa: E402
from scoring_protocol.common import canonical_json, canonical_sha256, normalize_source_text, with_hash  # noqa: E402
from scoring_protocol.contracts import validate_exchange, validate_schema  # noqa: E402
from scoring_protocol.runner import _compound_outcome, _derive_experience, _stable_criteria, _validate_cleaner  # noqa: E402


def span(source: str, quote: str) -> dict[str, object]:
    start = source.index(quote)
    return {"startCodePoint": start, "endCodePoint": start + len(quote), "exactQuote": quote}


class ScoringProtocolTests(unittest.TestCase):
    def test_python_canonicalization_matches_shared_golden_fixture(self) -> None:
        fixture = json.loads((REPO_ROOT / "tests/fixtures/scoring/canonical-golden-v1.json").read_text())
        self.assertEqual(canonical_json(fixture["input"]), fixture["canonical"])
        self.assertEqual(canonical_sha256(fixture["input"]), fixture["sha256"])

    def test_normalization_uses_nfc_and_lf(self) -> None:
        self.assertEqual(normalize_source_text("Cafe\u0301\r\nnext\rline"), "Café\nnext\nline")
        with self.assertRaisesRegex(ValueError, "NUL"):
            normalize_source_text("bad\x00text")

    def test_worker_command_is_non_interpolating_and_disables_capabilities(self) -> None:
        command = build_worker_command(
            codex_path="/opt/homebrew/bin/codex",
            model="gpt-5.6-terra",
            effort="medium",
            task_dir=Path("/tmp/scoring-task"),
            schema_path=Path("/tmp/scoring-task/schema.json"),
            output_path=Path("/tmp/scoring-task/output.json"),
        )
        self.assertIsInstance(command, list)
        self.assertNotIn("--search", command)
        self.assertIn("--ignore-user-config", command)
        self.assertIn("--ignore-rules", command)
        self.assertEqual(command[command.index("--sandbox") + 1], "read-only")
        disabled = {command[index + 1] for index, value in enumerate(command[:-1]) if value == "--disable"}
        self.assertEqual(disabled, set(DISABLED_FEATURES))

    def test_cleaner_must_be_exact_source_minus_declared_spans(self) -> None:
        source = "Duties. Benefits: snacks. Required: five years."
        removed = span(source, "Benefits: snacks. ") | {"classification": "benefits"}
        output = {"cleanedText": "Duties. Required: five years.", "removedSpans": [removed]}
        self.assertEqual(_validate_cleaner(source, output), output)
        with self.assertRaisesRegex(ValueError, "exactly"):
            _validate_cleaner(source, output | {"cleanedText": "Duties. Required: 5 years."})

    def test_compound_logic_and_preferred_half_up(self) -> None:
        self.assertEqual(_compound_outcome("any", ["cannot_evaluate", "direct"]), "direct")
        self.assertEqual(_compound_outcome("all", ["direct", "partial"]), "partial")
        self.assertEqual(_compound_outcome("all", ["direct", "does_not_meet"]), "does_not_meet")

    def test_experience_derivation_excludes_admin_and_blocks_unknown_credential(self) -> None:
        source = "CPA required. Driver's license required. Tableau preferred."
        raw = [
            {"criterionId": "temp", "classification": "required", "category": "role_defining_credential", "operator": "single", "normalizedMeaning": "CPA", "source": span(source, "CPA required"), "requirementCue": "required", "leaves": [{"leafId": "temp", "normalizedMeaning": "CPA", "source": span(source, "CPA required")}], "alternatives": []},
            {"criterionId": "temp", "classification": "required", "category": "administrative", "operator": "single", "normalizedMeaning": "driver license", "source": span(source, "Driver's license required"), "requirementCue": "required", "leaves": [{"leafId": "temp", "normalizedMeaning": "driver license", "source": span(source, "Driver's license required")}], "alternatives": []},
            {"criterionId": "temp", "classification": "preferred", "category": "substantive", "operator": "single", "normalizedMeaning": "Tableau", "source": span(source, "Tableau preferred"), "requirementCue": "preferred", "leaves": [{"leafId": "temp", "normalizedMeaning": "Tableau", "source": span(source, "Tableau preferred")}], "alternatives": []},
        ]
        criteria = _stable_criteria(raw, "a" * 64, source)
        outcomes = {
            "outcomes": [
                {"criterionId": criterion["criterionId"], "outcome": "cannot_evaluate", "leaves": [{"leafId": leaf["leafId"], "outcome": "cannot_evaluate", "support": [], "conflict": [], "rationale": "not recorded"} for leaf in criterion["leaves"]]}
                for criterion in criteria
            ]
        }
        derived = _derive_experience(criteria, outcomes, [])
        self.assertEqual(derived["decision"], "hard_requirement_not_fully_supported")
        self.assertIsNone(derived["experienceFitScore"])
        self.assertEqual(derived["blockingCriteria"], [{"criterionId": criteria[0]["criterionId"], "outcome": "cannot_evaluate"}])
        self.assertEqual(derived["outcomes"][1]["outcome"], "excluded")

    def test_result_schema_rejects_unknown_keys_and_accepts_hashes(self) -> None:
        schema = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
        with self.assertRaisesRegex(ValueError, "not allowed"):
            validate_schema({"unexpected": True}, schema)

    def test_exchange_hash_validator_detects_tampering(self) -> None:
        item = with_hash({
            "jobId": "11111111-1111-4111-8111-111111111111",
            "ordinal": 0,
            "inputHash": "a" * 64,
            "workers": [{"phase": "jd_cleaner", "model": "gpt-5.6-terra", "effort": "medium", "promptVersion": "jd-cleaner-v1", "startedAt": "2026-08-12T12:00:00.000Z", "completedAt": "2026-08-12T12:00:01.000Z", "invocationReceipt": "test"}],
            "result": {"kind": "safe_failure", "code": "source_unusable", "detail": "fixture"},
        })
        envelope = with_hash({
            "schemaVersion": "career-dashboard-aim-result-v1",
            "batch": {"id": "22222222-2222-4222-8222-222222222222", "stage": "aim", "protocolVersion": "career-dashboard-scoring-protocol-v1", "policyVersion": "aim-policy-v1", "manifestHash": "b" * 64},
            "runner": {"runnerVersion": "career-dashboard-python-runner-v1", "model": "gpt-5.6-terra", "effort": "medium", "promptVersion": "aim-workers-v1", "startedAt": "2026-08-12T12:00:00.000Z", "completedAt": "2026-08-12T12:00:01.000Z", "invocationReceipt": "test"},
            "results": [item],
        })
        validate_exchange(envelope, REPO_ROOT)
        envelope["results"][0]["result"]["detail"] = "tampered"
        with self.assertRaisesRegex(ValueError, "resultHash"):
            validate_exchange(envelope, REPO_ROOT)


if __name__ == "__main__":
    unittest.main()
