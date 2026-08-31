from __future__ import annotations

import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.scoring_protocol.common import (  # noqa: E402
    atomic_write_json,
    canonical_sha256,
    file_sha256,
    load_json,
)
from scripts.scoring_protocol.run_bundle import (  # noqa: E402
    finalize_experience_bundle,
    run_scoring_bundle,
    validate_run_export,
)


def run_export(stage: str, child_count: int = 2) -> dict[str, object]:
    run_id = str(uuid.uuid4())
    children = []
    manifest_children = []
    jobs_per_child = 40 if child_count > 1 else 1
    for ordinal in range(child_count):
        batch_id = str(uuid.uuid4())
        jobs = [{
            "jobId": str(uuid.uuid4()),
            "ordinal": job_ordinal,
            "trustedMetadata": {"company": "Example", "title": f"Role {ordinal}-{job_ordinal}", "location": None},
            "originalJd": f"Required qualification {ordinal}-{job_ordinal}.",
        } for job_ordinal in range(jobs_per_child)]
        child_export = {
            "schemaVersion": f"career-dashboard-{stage}-export-v2",
            "batch": {
                "id": batch_id,
                "stage": stage,
                "manifestHash": f"child-manifest-{ordinal}",
            },
            "evidence": {"evidenceHash": "e" * 64, "facts": []},
            "jobs": jobs,
        }
        export_hash = canonical_sha256(child_export)
        children.append({
            "ordinal": ordinal,
            "batchId": batch_id,
            "jobCount": len(jobs),
            "exportHash": export_hash,
            "export": child_export,
        })
        manifest_children.append({
            "ordinal": ordinal,
            "batchId": batch_id,
            "jobCount": len(jobs),
            "exportHash": export_hash,
            "manifestHash": child_export["batch"]["manifestHash"],
        })
    manifest_hash = canonical_sha256({
        "kind": "scoring_run_manifest_v1",
        "runId": run_id,
        "stage": stage,
        "batchSize": 40,
        "jobCount": child_count * jobs_per_child,
        "batches": manifest_children,
    })
    return {
        "schemaVersion": "career-dashboard-scoring-run-export-v1",
        "run": {
            "id": run_id,
            "stage": stage,
            "batchSize": 40,
            "jobCount": child_count * jobs_per_child,
            "batchCount": child_count,
            "manifestHash": manifest_hash,
        },
        "batches": children,
    }


def fake_result(export_path: Path, output_dir: Path, *, mismatch: bool = False):
    exported = load_json(export_path)
    batch_id = exported["batch"]["id"]
    job_id = exported["jobs"][0]["jobId"]
    decision = {
        "kind": "evaluation",
        "decision": "hard_requirement_mismatch" if mismatch else "qualified",
        "hardRequirementsNotMet": ["Required qualification"] if mismatch else [],
        "hardRequirementEvidence": [],
    }
    result = {
        "resultHash": canonical_sha256({"batchId": batch_id, "jobId": job_id, "decision": decision}),
        "results": [{
            "jobId": job_id,
            "resultHash": canonical_sha256(decision),
            "result": decision,
        }],
    }
    result_path = output_dir / f"fake-{batch_id}.json"
    atomic_write_json(result_path, result)
    return result_path, {"submitted": 1, "accepted": 1, "modelCalls": 1}


class ScoringRunBundleTests(unittest.TestCase):
    def test_run_validation_binds_manifest_and_unique_jobs(self) -> None:
        exported = run_export("aim")
        with patch("scripts.scoring_protocol.run_bundle.validate_export"):
            run, children = validate_run_export(exported, REPO_ROOT)
        self.assertEqual(run["jobCount"], 80)
        self.assertEqual(len(children), 2)

        exported["batches"][1]["export"]["jobs"][0]["jobId"] = exported["batches"][0]["export"]["jobs"][0]["jobId"]
        exported["batches"][1]["exportHash"] = canonical_sha256(exported["batches"][1]["export"])
        with patch("scripts.scoring_protocol.run_bundle.validate_export"):
            with self.assertRaisesRegex(ValueError, "duplicate job ID"):
                validate_run_export(exported, REPO_ROOT)

    def test_failed_run_resumes_only_incomplete_children_and_completed_replay_is_stable(self) -> None:
        exported = run_export("aim")
        failing_batch = exported["batches"][1]["batchId"]
        calls: list[str] = []

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "START-AIM-FIT-RUN.json"
            output_dir = root / "results"
            delivery_dir = root / "Desktop"
            atomic_write_json(export_path, exported)

            def first_runner(**kwargs):
                batch_id = load_json(kwargs["export_path"])["batch"]["id"]
                calls.append(batch_id)
                if batch_id == failing_batch:
                    raise RuntimeError("injected child failure")
                return fake_result(kwargs["export_path"], kwargs["output_dir"])

            with patch("scripts.scoring_protocol.run_bundle.validate_export"), \
                 patch("scripts.scoring_protocol.run_bundle.validate_result_against_export"), \
                 patch("scripts.scoring_protocol.run_bundle.run_aim_v2", side_effect=first_runner):
                with self.assertRaisesRegex(RuntimeError, "failed child batches"):
                    run_scoring_bundle(
                        export_path=export_path, output_dir=output_dir,
                        delivery_dir=delivery_dir, repo_root=REPO_ROOT,
                    )
            self.assertEqual(sorted(calls), sorted(child["batchId"] for child in exported["batches"]))

            calls.clear()

            def recovery_runner(**kwargs):
                batch_id = load_json(kwargs["export_path"])["batch"]["id"]
                calls.append(batch_id)
                return fake_result(kwargs["export_path"], kwargs["output_dir"])

            with patch("scripts.scoring_protocol.run_bundle.validate_export"), \
                 patch("scripts.scoring_protocol.run_bundle.validate_result_against_export"), \
                 patch("scripts.scoring_protocol.run_bundle.run_aim_v2", side_effect=recovery_runner):
                completed = run_scoring_bundle(
                    export_path=export_path, output_dir=output_dir,
                    delivery_dir=delivery_dir, repo_root=REPO_ROOT,
                )
            self.assertEqual(calls, [failing_batch])
            original_hash = file_sha256(Path(completed["projectOutputPath"]))

            with patch("scripts.scoring_protocol.run_bundle.validate_export"), \
                 patch("scripts.scoring_protocol.run_bundle.run_aim_v2", side_effect=AssertionError("must not rerun")):
                replay = run_scoring_bundle(
                    export_path=export_path, output_dir=output_dir,
                    delivery_dir=delivery_dir, repo_root=REPO_ROOT,
                )
            self.assertTrue(replay["idempotentReplay"])
            self.assertEqual(file_sha256(Path(replay["projectOutputPath"])), original_hash)

    def test_experience_mismatches_require_review_and_finalize_idempotently(self) -> None:
        exported = run_export("experience", child_count=1)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "START-E-FIT-RUN.json"
            output_dir = root / "results"
            delivery_dir = root / "Desktop"
            atomic_write_json(export_path, exported)

            def experience_runner(**kwargs):
                return fake_result(kwargs["export_path"], kwargs["output_dir"], mismatch=True)

            with patch("scripts.scoring_protocol.run_bundle.validate_export"), \
                 patch("scripts.scoring_protocol.run_bundle.validate_result_against_export"), \
                 patch("scripts.scoring_protocol.run_bundle.run_experience", side_effect=experience_runner):
                pending = run_scoring_bundle(
                    export_path=export_path, output_dir=output_dir,
                    delivery_dir=delivery_dir, repo_root=REPO_ROOT,
                )
            self.assertEqual(pending["status"], "awaiting_semantic_review")
            self.assertIsNone(pending["desktopUploadPath"])

            review_path = Path(pending["reviewPath"])
            review = load_json(review_path, integers_only=False)
            tampered = json.loads(json.dumps(review))
            tampered["reviews"][0]["decision"] = "approved"
            tampered["reviews"][0]["originalJd"] = "altered review source"
            atomic_write_json(review_path, tampered)
            with patch("scripts.scoring_protocol.run_bundle.validate_export"), \
                 patch("scripts.scoring_protocol.run_bundle.validate_result_against_export"):
                with self.assertRaisesRegex(ValueError, "exact Experience hard mismatch"):
                    finalize_experience_bundle(
                        draft_path=Path(pending["draftPath"]), review_path=review_path,
                        output_dir=output_dir, delivery_dir=delivery_dir, repo_root=REPO_ROOT,
                    )

            review["reviews"][0]["decision"] = "approved"
            atomic_write_json(review_path, review)
            with patch("scripts.scoring_protocol.run_bundle.validate_export"), \
                 patch("scripts.scoring_protocol.run_bundle.validate_result_against_export"):
                finalized = finalize_experience_bundle(
                    draft_path=Path(pending["draftPath"]), review_path=review_path,
                    output_dir=output_dir, delivery_dir=delivery_dir, repo_root=REPO_ROOT,
                )
            self.assertEqual(finalized["reviewedMismatchCount"], 1)
            result_hash = file_sha256(Path(finalized["projectOutputPath"]))

            replay = finalize_experience_bundle(
                draft_path=Path(pending["draftPath"]), review_path=review_path,
                output_dir=output_dir, delivery_dir=delivery_dir, repo_root=REPO_ROOT,
            )
            self.assertTrue(replay["idempotentReplay"])
            self.assertEqual(file_sha256(Path(replay["projectOutputPath"])), result_hash)


if __name__ == "__main__":
    unittest.main()
