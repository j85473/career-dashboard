from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from scoring_protocol.aim_calibration_bridge import (  # noqa: E402
    build_v2_calibration_export,
    run_historical_aim_calibration,
)
from scoring_protocol.common import canonical_sha256, load_json, normalized_text_sha256  # noqa: E402
from scoring_protocol.contracts import validate_export  # noqa: E402
from scoring_protocol.historical_aim_v1 import (  # noqa: E402
    historical_aim_v1_input_hash,
    historical_aim_v1_input_versions,
)
from scoring_protocol.input_versions import validate_current_aim_v2_export  # noqa: E402
from scoring_protocol.codex_worker import WorkerRun  # noqa: E402


def historical_export(source: str = "Lead channel partners.\nTravel up to 50%.") -> dict[str, object]:
    versions = historical_aim_v1_input_versions(REPO_ROOT)
    overrides = load_json(REPO_ROOT / "data/scoring/aim-employer-overrides-v1.json")
    job: dict[str, object] = {
        "jobId": "11111111-1111-4111-8111-111111111111",
        "ordinal": 0,
        "submittedUpdatedAt": "2026-08-12T21:00:00.000Z",
        "company": "Example Co",
        "title": "Channel Manager",
        "location": "Minneapolis, MN",
        "sourceUrl": "https://example.com/job/1",
        "originalJd": source,
        "sourceJdHash": normalized_text_sha256(source),
    }
    job["metadataHash"] = canonical_sha256({
        "company": job["company"],
        "title": job["title"],
        "location": job["location"],
        "sourceUrl": job["sourceUrl"],
    })
    job["inputHash"] = historical_aim_v1_input_hash(job, versions)
    batch: dict[str, object] = {
        "id": "22222222-2222-4222-8222-222222222222",
        "stage": "aim",
        "createdAt": "2026-08-12T22:00:00.000Z",
        "expiresAt": "2026-08-13T22:00:00.000Z",
        "protocolVersion": versions["protocolVersion"],
        "policyVersion": "aim-policy-v1",
        "manifestHash": "",
    }
    batch["manifestHash"] = canonical_sha256({
        "batchId": batch["id"],
        "stage": batch["stage"],
        "schemaVersion": "career-dashboard-aim-export-v1",
        "protocolVersion": batch["protocolVersion"],
        "policyVersion": batch["policyVersion"],
        "items": [{"ordinal": 0, "jobId": job["jobId"], "inputHash": job["inputHash"]}],
    })
    return {
        "schemaVersion": "career-dashboard-aim-export-v1",
        "batch": batch,
        "preferences": {
            "policyHash": versions["aimPolicyHash"],
            "employerOverridesHash": versions["employerOverridesHash"],
            "employerOverrides": overrides,
        },
        "jobs": [job],
    }


class AimCalibrationBridgeTests(unittest.TestCase):
    def test_bridge_run_completes_with_one_retained_output_per_model_call(self) -> None:
        def worker(**kwargs: object) -> WorkerRun:
            effort = str(kwargs["effort"])
            timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            receipt = {
                "phase": "aim_stage2" if effort == "high" else "unit",
                "model": "gpt-5.6-terra",
                "effort": effort,
                "promptVersion": "aim-stage2-holistic-v1" if effort == "high" else "factual-instruction-v2",
                "startedAt": timestamp,
                "completedAt": timestamp,
                "invocationReceipt": f"fixture:{effort}",
            }
            if effort == "high":
                self.assertIs(kwargs["memory_enabled"], True)
                output = "Aim Fit Score: 81\nStrong relationship ownership with limited hunting risk."
            else:
                prompt = str(kwargs["prompt"])
                question_count = sum(1 for line in prompt.splitlines() if re.match(r"^\d+\. ", line))
                output = "\n".join(f"{number}. unsupported" for number in range(1, question_count + 1))
            return WorkerRun(output, receipt, raw_output=output)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "historical-export.json"
            export_path.write_text(json.dumps(historical_export()), encoding="utf-8")
            with patch("scoring_protocol.aim_runner_v2.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.aim_runner_v2.selected_model_context_window", return_value=200_000
            ), patch("scoring_protocol.aim_runner_v2.run_worker", side_effect=worker):
                output_path, calibration_input_path, receipt_path, model_outputs_path, counts = (
                    run_historical_aim_calibration(
                        export_path=export_path,
                        output_dir=root,
                        repo_root=REPO_ROOT,
                        calibration_run_id="bridge-regression",
                    )
                )
            output = load_json(output_path)
            calibration_input = load_json(calibration_input_path)
            bridge_receipt = load_json(receipt_path)
            model_outputs = load_json(model_outputs_path)

        self.assertEqual(calibration_input["schemaVersion"], "career-dashboard-aim-export-v2")
        self.assertEqual(output["artifactPurpose"], "calibration")
        self.assertEqual(output["results"][0]["result"]["score"], 81)
        self.assertEqual(counts["modelCalls"], 2)
        self.assertEqual(bridge_receipt["status"], "completed")
        self.assertEqual(bridge_receipt["modelOutputRecords"], 2)
        self.assertEqual(model_outputs["modelCallCount"], 2)
        self.assertEqual(len(model_outputs["records"]), 2)
        self.assertEqual(
            [record["unit"]["privatePhase"] for record in model_outputs["records"]],
            ["stage1", "holistic_stage2"],
        )

    def test_bridge_preserves_source_metadata_membership_and_transport_exactly(self) -> None:
        original = historical_export()
        validate_export(original, REPO_ROOT, "aim")
        bridged, receipt = build_v2_calibration_export(original, REPO_ROOT)
        validate_export(bridged, REPO_ROOT, "aim")
        validate_current_aim_v2_export(bridged, REPO_ROOT)

        old_job = original["jobs"][0]  # type: ignore[index]
        new_job = bridged["jobs"][0]
        self.assertEqual(new_job["source"]["originalJd"].encode(), old_job["originalJd"].encode())
        self.assertEqual(new_job["trustedMetadata"], {
            "company": old_job["company"],
            "title": old_job["title"],
            "location": old_job["location"],
        })
        self.assertEqual(new_job["transportProvenance"], {"sourceUrl": old_job["sourceUrl"]})
        self.assertEqual(new_job["jobId"], old_job["jobId"])
        self.assertEqual(new_job["submittedUpdatedAt"], old_job["submittedUpdatedAt"])
        self.assertIsNone(new_job["reuse"])
        self.assertEqual(receipt["artifactPurpose"], "calibration")
        self.assertTrue(receipt["sourceBytesPreserved"])
        self.assertTrue(receipt["trustedMetadataPreserved"])
        self.assertFalse(receipt["reuseEmbedded"])

    def test_bridge_rejects_non_v1_input_and_never_normalizes_source_or_metadata_silently(self) -> None:
        original = historical_export()
        wrong_version = deepcopy(original)
        wrong_version["schemaVersion"] = "career-dashboard-aim-export-v2"
        with self.assertRaisesRegex(ValueError, "accepts only"):
            build_v2_calibration_export(wrong_version, REPO_ROOT)

        crlf = historical_export("Line one\r\nLine two")
        with self.assertRaisesRegex(ValueError, "not already v2-canonical"):
            build_v2_calibration_export(crlf, REPO_ROOT)

        padded = historical_export()
        padded_job = padded["jobs"][0]  # type: ignore[index]
        padded_job["company"] = "Example Co\r"
        padded_job["metadataHash"] = canonical_sha256({
            "company": padded_job["company"],
            "title": padded_job["title"],
            "location": padded_job["location"],
            "sourceUrl": padded_job["sourceUrl"],
        })
        versions = historical_aim_v1_input_versions(REPO_ROOT)
        padded_job["inputHash"] = historical_aim_v1_input_hash(padded_job, versions)
        padded["batch"]["manifestHash"] = canonical_sha256({  # type: ignore[index]
            "batchId": padded["batch"]["id"],  # type: ignore[index]
            "stage": "aim",
            "schemaVersion": "career-dashboard-aim-export-v1",
            "protocolVersion": padded["batch"]["protocolVersion"],  # type: ignore[index]
            "policyVersion": "aim-policy-v1",
            "items": [{"ordinal": 0, "jobId": padded_job["jobId"], "inputHash": padded_job["inputHash"]}],
        })
        with self.assertRaisesRegex(ValueError, "metadata is not already v2-canonical"):
            build_v2_calibration_export(padded, REPO_ROOT)


if __name__ == "__main__":
    unittest.main()
