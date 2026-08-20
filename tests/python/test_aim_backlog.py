from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from scripts.scoring_protocol.aim_backlog import (
    DashboardApiError,
    RawResponse,
    catastrophic_preview_reason,
    exit_summary,
    normalize_dashboard_url,
    run_backlog,
    save_export,
)
from scripts.scoring_protocol.common import atomic_write_json, load_json


class FakeDashboardClient:
    def __init__(self, queue_count: int, batch_id: str):
        self.base_url = "http://dashboard.test:3000"
        self.queue_count = queue_count
        self.batch_id = batch_id
        self.active = False
        self.apply_calls: list[tuple[dict[str, object], str]] = []

    def aim_queue_count(self) -> int:
        return self.queue_count

    def active_aim_batches(self) -> list[dict[str, object]]:
        return [{"id": self.batch_id, "status": "exported"}] if self.active else []

    def export_aim_batch(self, limit: int) -> RawResponse:
        self.active = True
        body = json.dumps({
            "schemaVersion": "career-dashboard-aim-export-v2",
            "batch": {"id": self.batch_id},
            "jobs": [{"jobId": str(uuid.uuid4()), "ordinal": index} for index in range(limit)],
        }, sort_keys=True).encode("utf-8")
        return RawResponse(body, {"x-scoring-export-sha256": hashlib.sha256(body).hexdigest()})

    def preview_result(self, payload: dict[str, object]) -> dict[str, object]:
        self.active = True
        return {
            "preview": {
                "batchId": self.batch_id,
                "stage": "aim",
                "resultHash": "b" * 64,
                "applicable": True,
                "itemCount": 2,
                "expectedCount": 2,
                "suppliedCount": 2,
                "acceptedCount": 2,
                "safeFailureCount": 0,
                "protectedLifecycleCount": 0,
                "scoreRange": {"minimum": 71, "maximum": 88},
                "decisionCounts": {"scored_survivor": 2},
            },
            "approvalToken": "signed-preview-token",
            "approvalExpiresAt": "2026-08-20T18:15:00.000Z",
        }

    def apply_result(self, payload: dict[str, object], approval_token: str) -> dict[str, object]:
        self.apply_calls.append((payload, approval_token))
        self.active = False
        return {"batchId": self.batch_id, "imported": 2, "released": 0}


class EmptyExporterDashboardClient(FakeDashboardClient):
    def export_aim_batch(self, limit: int) -> RawResponse:
        raise DashboardApiError(409, "no Aim Ready jobs are available")


def fake_run_aim(*, export_path: Path, output_dir: Path, **_: object) -> tuple[Path, dict[str, int]]:
    exported = load_json(export_path)
    batch_id = exported["batch"]["id"]
    result_path = output_dir / f"career-dashboard-aim-results-{batch_id}.json"
    atomic_write_json(result_path, {
        "schemaVersion": "career-dashboard-aim-result-v2",
        "batch": {"id": batch_id},
        "results": [],
        "resultHash": "b" * 64,
    })
    return result_path, {"submitted": len(exported["jobs"]), "accepted": len(exported["jobs"]), "safeFailures": 0}


class AimBacklogTests(unittest.TestCase):
    def test_dashboard_url_is_restricted_to_an_origin(self) -> None:
        self.assertEqual(normalize_dashboard_url("http://dashboard.test:3000/"), "http://dashboard.test:3000")
        with self.assertRaisesRegex(ValueError, "without a path"):
            normalize_dashboard_url("http://dashboard.test:3000/jobs")

    def test_export_hash_is_verified_before_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            response = RawResponse(b"{}", {"x-scoring-export-sha256": "0" * 64})
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                save_export(response, Path(directory) / "export.json")

    def test_preview_only_run_persists_artifacts_without_applying(self) -> None:
        batch_id = str(uuid.uuid4())
        client = FakeDashboardClient(queue_count=2, batch_id=batch_id)
        with tempfile.TemporaryDirectory() as directory, patch(
            "scripts.scoring_protocol.aim_backlog.run_aim", side_effect=fake_run_aim,
        ):
            root = Path(directory)
            output: list[str] = []
            state_path, state = run_backlog(
                client=client,
                repo_root=root,
                output_dir=root / "results",
                delivery_dir=root / "Desktop",
                run_id=None,
                max_jobs=None,
                interactive_apply=False,
                auto_apply=False,
                model=None,
                effort=None,
                output_function=output.append,
            )

            self.assertEqual(state["status"], "awaiting_approval")
            self.assertEqual(state["appliedJobs"], 0)
            self.assertEqual(state["batches"][0]["status"], "previewed")
            self.assertNotIn("approvalToken", json.dumps(state))
            self.assertEqual(state["batches"][0]["resultArtifact"]["batchId"], batch_id)
            self.assertTrue(state["batches"][0]["resultArtifact"]["verified"])
            self.assertTrue(state["batches"][0]["deliveryVerification"]["byteIdentical"])
            self.assertTrue(state["batches"][0]["deliveryVerification"]["jsonIdentityVerified"])
            self.assertTrue(state_path.exists())
            self.assertEqual(client.apply_calls, [])
            self.assertIn(batch_id, output[0])

            summary = json.loads(exit_summary(state_path, state))
            self.assertEqual(summary["safeFailures"], 0)
            self.assertEqual(summary["decisionCounts"], {"scored_survivor": 2})

    def test_resume_requires_exact_batch_bound_confirmation_before_apply(self) -> None:
        batch_id = str(uuid.uuid4())
        client = FakeDashboardClient(queue_count=2, batch_id=batch_id)
        with tempfile.TemporaryDirectory() as directory, patch(
            "scripts.scoring_protocol.aim_backlog.run_aim", side_effect=fake_run_aim,
        ):
            root = Path(directory)
            state_path, state = run_backlog(
                client=client,
                repo_root=root,
                output_dir=root / "results",
                delivery_dir=root / "Desktop",
                run_id=None,
                max_jobs=None,
                interactive_apply=False,
                auto_apply=False,
                model=None,
                effort=None,
                output_function=lambda _: None,
            )
            run_id = state["runId"]

            _, stopped = run_backlog(
                client=client,
                repo_root=root,
                output_dir=root / "results",
                delivery_dir=root / "Desktop",
                run_id=run_id,
                max_jobs=None,
                interactive_apply=True,
                auto_apply=False,
                model=None,
                effort=None,
                input_function=lambda _: "APPLY wrong-batch",
                output_function=lambda _: None,
            )
            self.assertEqual(stopped["status"], "awaiting_approval")
            self.assertEqual(client.apply_calls, [])

            _, completed = run_backlog(
                client=client,
                repo_root=root,
                output_dir=root / "results",
                delivery_dir=root / "Desktop",
                run_id=run_id,
                max_jobs=None,
                interactive_apply=True,
                auto_apply=False,
                model=None,
                effort=None,
                input_function=lambda _: f"APPLY {batch_id}",
                output_function=lambda _: None,
            )
            self.assertEqual(completed["status"], "completed")
            self.assertEqual(completed["appliedJobs"], 2)
            self.assertEqual(len(client.apply_calls), 1)
            self.assertEqual(client.apply_calls[0][1], "signed-preview-token")
            self.assertTrue(state_path.exists())

    def test_auto_apply_uses_bounded_catastrophic_stop_policy(self) -> None:
        batch_id = str(uuid.uuid4())
        client = FakeDashboardClient(queue_count=2, batch_id=batch_id)
        with tempfile.TemporaryDirectory() as directory, patch(
            "scripts.scoring_protocol.aim_backlog.run_aim", side_effect=fake_run_aim,
        ):
            root = Path(directory)
            _, completed = run_backlog(
                client=client,
                repo_root=root,
                output_dir=root / "results",
                delivery_dir=root / "Desktop",
                run_id=None,
                max_jobs=None,
                interactive_apply=False,
                auto_apply=True,
                model=None,
                effort=None,
                output_function=lambda _: None,
            )
            self.assertEqual(completed["status"], "completed")
            self.assertTrue(completed["autoApplyPolicy"]["enabled"])
            self.assertEqual(len(client.apply_calls), 1)

        catastrophic = {
            "preview": {"acceptedCount": 0, "safeFailureCount": 30},
        }
        self.assertEqual(catastrophic_preview_reason(catastrophic, 30), "no applicable Aim results were produced")
        half_failed = {
            "preview": {"acceptedCount": 15, "safeFailureCount": 15},
        }
        self.assertIn("15 of 30", catastrophic_preview_reason(half_failed, 30) or "")

    def test_visible_queue_is_not_reported_as_drained_when_exporter_returns_empty(self) -> None:
        batch_id = str(uuid.uuid4())
        client = EmptyExporterDashboardClient(queue_count=501, batch_id=batch_id)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path, state = run_backlog(
                client=client,
                repo_root=root,
                output_dir=root / "results",
                delivery_dir=root / "Desktop",
                run_id=None,
                max_jobs=None,
                interactive_apply=False,
                auto_apply=True,
                model=None,
                effort=None,
                output_function=lambda _: None,
            )
            self.assertEqual(state["status"], "blocked_nonexportable")
            self.assertEqual(state["remainingVisibleJobs"], 501)
            self.assertEqual(json.loads(exit_summary(state_path, state))["remainingVisibleJobs"], 501)


if __name__ == "__main__":
    unittest.main()
