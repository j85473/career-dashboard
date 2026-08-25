from __future__ import annotations

import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from scoring_protocol.aim_identity import source_jd_hash, trusted_metadata_hash  # noqa: E402
from scoring_protocol.codex_worker import WorkerRun  # noqa: E402
from scoring_protocol.common import canonical_sha256, load_json  # noqa: E402
from scoring_protocol.experience_runner import (  # noqa: E402
    parse_hard_gate_output,
    parse_holistic_output,
    run_experience,
)
from scoring_protocol.input_versions import (  # noqa: E402
    _core_evidence_snapshot,
    current_experience_v2_input_versions,
    validate_current_experience_v2_export,
)


def make_export(job_count: int = 1) -> dict[str, object]:
    current = current_experience_v2_input_versions(REPO_ROOT)
    original_jd = "Required: channel sales experience. Active CPA license is required. Original-only content remains available."
    metadata = {"company": "Example", "title": "Channel Manager", "location": "Minneapolis, MN"}
    source_hash = source_jd_hash(original_jd)
    metadata_hash = trusted_metadata_hash(metadata)
    batch = {
        "id": "81111111-1111-4111-8111-111111111111",
        "stage": "experience",
        "createdAt": "2026-08-13T12:00:00.000Z",
        "expiresAt": "2026-08-14T12:00:00.000Z",
        "protocolVersion": "career-dashboard-scoring-protocol-v2",
        "exportSchemaVersion": "career-dashboard-experience-export-v2",
        "policyVersion": current["policyVersion"],
        "manifestHash": "",
    }
    jobs: list[dict[str, object]] = []
    for ordinal in range(job_count):
        job_id = str(uuid.UUID(int=uuid.UUID("83333333-3333-4333-8333-333333333333").int + ordinal))
        aim_event_id = str(uuid.UUID(int=uuid.UUID("84444444-4444-4444-8444-444444444444").int + ordinal))
        extraction_id = str(uuid.UUID(int=uuid.UUID("85555555-5555-4555-8555-555555555555").int + ordinal))
        aim_semantic_hash = f"{ordinal + 1:064x}"
        input_hash = canonical_sha256({
            "kind": "experience_batch_item_input_v2",
            "stage": "experience",
            "protocolVersion": batch["protocolVersion"],
            "exportSchemaVersion": batch["exportSchemaVersion"],
            "globalInputVersionsHash": current["inputVersionsHash"],
            "sourceAimEventId": aim_event_id,
            "aimFactualExtractionId": extraction_id,
            "sourceJdHash": source_hash,
            "trustedMetadataHash": metadata_hash,
            "aimSemanticResultHash": aim_semantic_hash,
            "resumeHash": current["resumeHash"],
            "evidenceHash": current["evidenceHash"],
        })
        jobs.append({
            "jobId": job_id,
            "ordinal": ordinal,
            "submittedUpdatedAt": "2026-08-13T11:00:00.000Z",
            "sourceAimEventId": aim_event_id,
            "aimFactualExtractionId": extraction_id,
            "sourceJdHash": source_hash,
            "originalJd": original_jd,
            "trustedMetadata": metadata,
            "trustedMetadataHash": metadata_hash,
            "aimSemanticResultHash": aim_semantic_hash,
            "inputHash": input_hash,
        })
    batch["manifestHash"] = canonical_sha256({
        "batchId": batch["id"],
        "stage": batch["stage"],
        "schemaVersion": "career-dashboard-experience-export-v2",
        "protocolVersion": batch["protocolVersion"],
        "policyVersion": batch["policyVersion"],
        "items": [
            {"ordinal": job["ordinal"], "jobId": job["jobId"], "inputHash": job["inputHash"]}
            for job in jobs
        ],
    })
    return {
        "schemaVersion": "career-dashboard-experience-export-v2",
        "batch": batch,
        "resume": {
            "filename": "JosephLamb_Resume.docx",
            "hash": current["resumeHash"],
            "extractedText": "Transport-bound resume text is not sent to Experience workers.",
        },
        "evidence": _core_evidence_snapshot(REPO_ROOT),
        "jobs": jobs,
    }


def receipt(phase: str, effort: str, prompt_version: str) -> dict[str, str]:
    return {
        "phase": phase,
        "model": "gpt-5.6-terra",
        "effort": effort,
        "promptVersion": prompt_version,
        "startedAt": "2026-08-13T12:00:00.000Z",
        "completedAt": "2026-08-13T12:00:01.000Z",
        "invocationReceipt": f"codex-thread:test-{phase}",
    }


def hard_mismatch_output(**overrides: str) -> str:
    entry = {
        "requirement": "Active CPA license — Joe does not hold this credential.",
        "category": "role_defining_credential",
        "jdQuote": "Active CPA license is required.",
        "absoluteBarCue": "required",
        "inventoryComparison": "The exhaustive evidence inventory contains no active CPA credential.",
    }
    entry.update(overrides)
    return json.dumps({"hardRequirementsNotMet": [entry]})


class ExperienceSourceContinuityV2Tests(unittest.TestCase):
    def test_v2_export_binds_current_source_without_cleaned_artifact(self) -> None:
        exported = make_export()
        validate_current_experience_v2_export(exported, REPO_ROOT)  # type: ignore[arg-type]
        job = exported["jobs"][0]  # type: ignore[index]
        self.assertIn("originalJd", job)
        self.assertNotIn("cleanedText", job)
        self.assertNotIn("cleanedArtifactId", job)

        tampered = json.loads(json.dumps(exported))
        tampered["jobs"][0]["inputHash"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "transport input hash mismatch"):
            validate_current_experience_v2_export(tampered, REPO_ROOT)

    def test_two_pass_runner_uses_original_jd_and_full_evidence(self) -> None:
        exported = make_export()
        observed: list[dict[str, object]] = []

        def worker(**kwargs: object) -> WorkerRun:
            observed.append(kwargs)
            phase = str(kwargs["phase"])
            if phase == "experience_hard_gate":
                output = "No hard requirements identified."
                prompt_version = "experience-hard-gate-v1"
                effort = "medium"
            else:
                output = "82/100. Strong channel and distributor alignment; less direct enterprise SaaS experience."
                prompt_version = "experience-holistic-v1"
                effort = "high"
            return WorkerRun(output=output, raw_output=output, receipt=receipt(phase, effort, prompt_version))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "experience-export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.experience_runner.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.experience_runner.run_worker", side_effect=worker
            ):
                output_path, counts = run_experience(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            result = load_json(output_path)

        self.assertEqual(counts["accepted"], 1)
        evaluation = result["results"][0]["result"]
        self.assertEqual(evaluation["decision"], "scored")
        self.assertEqual(evaluation["experienceFitScore"], 82)
        self.assertEqual([entry["effort"] for entry in observed], ["medium", "high"])
        for entry in observed:
            prompt = str(entry["prompt"])
            self.assertIn(exported["jobs"][0]["originalJd"], prompt)  # type: ignore[index]
            self.assertIn(str(exported["evidence"]["evidenceHash"]), prompt)  # type: ignore[index]
            self.assertNotIn("Transport-bound resume text", prompt)
            self.assertIsNone(entry["schema"])

    def test_hard_mismatch_stops_before_holistic_call_and_scores_zero(self) -> None:
        exported = make_export()
        calls = 0

        def worker(**kwargs: object) -> WorkerRun:
            nonlocal calls
            calls += 1
            output = hard_mismatch_output()
            return WorkerRun(
                output=output,
                raw_output=output,
                receipt=receipt("experience_hard_gate", "medium", "experience-hard-gate-v1"),
            )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "experience-export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.experience_runner.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.experience_runner.run_worker", side_effect=worker
            ):
                output_path, _ = run_experience(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            result = load_json(output_path)

        evaluation = result["results"][0]["result"]
        self.assertEqual(calls, 1)
        self.assertEqual(evaluation["decision"], "hard_requirement_mismatch")
        self.assertEqual(evaluation["experienceFitScore"], 0)
        self.assertEqual(evaluation["hardRequirementEvidence"][0]["category"], "role_defining_credential")
        self.assertEqual(evaluation["hardRequirementEvidence"][0]["source"]["exactQuote"], "Active CPA license is required.")
        self.assertIsNone(evaluation["pass2RawOutput"])

    def test_runner_accepts_fifty_ordered_checkpointed_jobs(self) -> None:
        exported = make_export(50)

        def worker(**kwargs: object) -> WorkerRun:
            output = hard_mismatch_output()
            return WorkerRun(
                output=output,
                raw_output=output,
                receipt=receipt("experience_hard_gate", "medium", "experience-hard-gate-v1"),
            )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "experience-export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.experience_runner.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.experience_runner.run_worker", side_effect=worker
            ):
                output_path, counts = run_experience(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            result = load_json(output_path)

        self.assertEqual(counts["submitted"], 50)
        self.assertEqual(counts["accepted"], 50)
        self.assertEqual(counts["safeFailures"], 0)
        self.assertEqual(len(result["results"]), 50)
        self.assertEqual(result["results"][-1]["ordinal"], 49)
        self.assertEqual([item["jobId"] for item in result["results"]], [job["jobId"] for job in exported["jobs"]])

    def test_runner_rejects_fifty_one_jobs_before_model_work(self) -> None:
        exported = make_export(51)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "experience-export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.experience_runner.run_worker") as worker:
                with self.assertRaisesRegex(ValueError, "too many items"):
                    run_experience(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            worker.assert_not_called()

    def test_plain_output_parsers_are_tolerant_but_require_substance(self) -> None:
        original_jd = "Active CPA license is required."
        self.assertEqual(parse_hard_gate_output('{"hardRequirementsNotMet": []}'), ([], []))
        parsed, discarded = parse_hard_gate_output(hard_mismatch_output(), original_jd=original_jd)
        self.assertEqual(discarded, [])
        self.assertEqual(parsed[0]["category"], "role_defining_credential")
        self.assertEqual(parsed[0]["source"], {
            "startCodePoint": 0,
            "endCodePoint": len(original_jd),
            "exactQuote": original_jd,
        })
        with self.assertRaisesRegex(ValueError, "structured evidence JSON"):
            parse_hard_gate_output("Yes\n1. CPA license — no credential in the inventory", original_jd=original_jd)
        self.assertEqual(parse_holistic_output("Expertise Fit Score: 77\nStrong adjacent experience.")[0], 77)
        with self.assertRaisesRegex(ValueError, "recognizable"):
            parse_holistic_output("Strong adjacent experience, but I forgot the score.")

    def test_hard_gate_parser_rejects_missing_evidence_and_excluded_categories(self) -> None:
        original_jd = "Active CPA license is required."
        missing_fields = json.dumps({"hardRequirementsNotMet": [{"requirement": "CPA"}]})
        with self.assertRaisesRegex(ValueError, "missing structured evidence"):
            parse_hard_gate_output(missing_fields, original_jd=original_jd)

        excluded_cases = (
            ("U.S. citizenship is required.", "U.S. citizenship is required."),
            ("Loading equipment is required.", "Loading equipment is required."),
            ("Strong communication skills are required.", "Strong communication skills are required."),
            ("You will prepare required reports.", "You will prepare required reports."),
            ("SaaS experience is preferred but not required.", "SaaS experience is preferred but not required."),
        )
        for requirement, quote in excluded_cases:
            output = hard_mismatch_output(
                requirement=requirement,
                category="role_specific_experience",
                jdQuote=quote,
                absoluteBarCue="required",
            )
            with self.subTest(requirement=requirement):
                # Discarded, not fatal: an excluded category is not a hard
                # requirement, which is the same conclusion as finding none.
                bound, discarded = parse_hard_gate_output(output, original_jd=quote)
                self.assertEqual(bound, [])
                self.assertTrue(any("excluded" in reason for reason in discarded), discarded)

    def test_an_unusable_hard_gate_assertion_falls_through_to_scoring(self) -> None:
        """A rejected assertion must not cost the job its score.

        The first post-fix production run released 18 of 91 items, 12 of them
        because one assertion failed a check — six where the only stated reason
        was a preferred qualification or a lifting requirement. Those jobs have
        no valid hard requirement, which means they should be scored, not
        thrown away.
        """
        exported = make_export()
        calls = 0

        def worker(**kwargs: object) -> WorkerRun:
            nonlocal calls
            calls += 1
            output = hard_mismatch_output(inventoryComparison="not found")
            return WorkerRun(
                output=output,
                raw_output=output,
                receipt=receipt("experience_hard_gate", "medium", "experience-hard-gate-v1"),
            )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "experience-export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.experience_runner.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.experience_runner.run_worker", side_effect=worker
            ):
                output_path, counts = run_experience(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            result = load_json(output_path)

        # Two worker calls: the hard gate, then the holistic pass it now reaches.
        self.assertEqual(calls, 2)
        self.assertEqual(counts["safeFailures"], 1)
        # The holistic worker was handed a hard-gate output, so it still fails
        # to yield a score — but it was reached, which is the point.
        self.assertEqual(result["results"][0]["result"]["kind"], "safe_failure")
        self.assertEqual(result["results"][0]["result"]["code"], "output_unusable")
        self.assertIn("0-100 score", result["results"][0]["result"]["detail"])


if __name__ == "__main__":
    unittest.main()
