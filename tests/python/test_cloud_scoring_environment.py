from __future__ import annotations

import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from scripts.cloud import check_scoring_environment as cloud
from scripts.scoring_protocol.codex_worker import InstalledModel, WorkerRun


class CloudScoringEnvironmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.requirements = [("exact-model", "medium", False), ("exact-model", "high", True),
                             ("exact-model", "high", False)]
        self.catalog = {"exact-model": InstalledModel(frozenset({"medium", "high"}), 200_000)}

    def test_required_model_and_effort_never_fall_back(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "exact-model/medium; no fallback"):
            cloud.check_catalog({"other-model": self.catalog["exact-model"]}, self.requirements)
        with self.assertRaisesRegex(RuntimeError, "exact-model/high; no fallback"):
            cloud.check_catalog({"exact-model": InstalledModel(frozenset({"medium"}), 200_000)}, self.requirements)

    def run_check(self, *, smoke: bool, failed_worker: bool = False, failed_dependency: bool = False,
                  unavailable_model: bool = False, failed_dashboard: bool = False):
        def command(arguments, **_kwargs):
            if arguments[:2] == ["node", "--version"]:
                return subprocess.CompletedProcess(arguments, 0, "v24.19.0\n", "")
            if "--help" in arguments:
                return subprocess.CompletedProcess(arguments, 0, " ".join(cloud.REQUIRED_FLAGS), "")
            return subprocess.CompletedProcess(arguments, int(failed_dependency), "", "")

        with ExitStack() as stack:
            stack.enter_context(patch.object(cloud.subprocess, "run", side_effect=command))
            stack.enter_context(patch.object(cloud.shutil, "which", return_value="/usr/bin/codex"))
            stack.enter_context(patch.object(cloud, "worker_requirements", return_value=self.requirements))
            stack.enter_context(patch.object(cloud, "installed_models", return_value={} if unavailable_model else self.catalog))
            stack.enter_context(patch.object(cloud, "check_writable"))
            worker = stack.enter_context(patch.object(cloud, "run_worker", return_value=WorkerRun("CLOUD_SCORING_OK", {})))
            if failed_worker:
                worker.side_effect = RuntimeError("synthetic worker failed")
            dashboard = stack.enter_context(patch.object(cloud, "check_dashboard"))
            if failed_dashboard:
                dashboard.side_effect = RuntimeError("Dashboard unavailable")
            report = cloud.check_environment(smoke_workers=smoke,
                                             dashboard_url="http://example.invalid" if failed_dashboard else None,
                                             delivery_dir=Path("/tmp/delivery"))
        return report, worker

    def test_dependency_check_does_not_make_model_calls_or_claim_inference_verified(self) -> None:
        report, worker = self.run_check(smoke=False)
        self.assertEqual(report["status"], "dependencies-verified")
        self.assertFalse(report["workerInferenceVerified"])
        worker.assert_not_called()

    def test_synthetic_check_uses_each_required_isolation_configuration(self) -> None:
        report, worker = self.run_check(smoke=True)
        self.assertEqual(report["status"], "workers-verified")
        self.assertTrue(report["workerInferenceVerified"])
        self.assertEqual([(call.kwargs["model"], call.kwargs["effort"], call.kwargs["memory_enabled"])
                          for call in worker.call_args_list], self.requirements)
        for call in worker.call_args_list:
            self.assertIn("CLOUD_SCORING_OK", call.kwargs["prompt"])
            self.assertEqual(call.kwargs["phase"], "environment_check")

    def test_dependency_failure_prevents_model_calls(self) -> None:
        report, worker = self.run_check(smoke=True, failed_dependency=True)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["checks"][0]["status"], "failed")
        worker.assert_not_called()

    def test_missing_exact_model_prevents_calls(self) -> None:
        report, worker = self.run_check(smoke=True, unavailable_model=True)
        self.assertEqual(report["status"], "blocked")
        self.assertIn("no fallback", report["error"])
        worker.assert_not_called()

    def test_worker_failure_stops_without_retrying_other_configurations(self) -> None:
        report, worker = self.run_check(smoke=True, failed_worker=True)
        self.assertEqual(report["status"], "blocked")
        self.assertFalse(report["workerInferenceVerified"])
        self.assertEqual(worker.call_count, 1)

    def test_unreachable_dashboard_does_not_hide_successful_worker_verification(self) -> None:
        report, _worker = self.run_check(smoke=True, failed_dashboard=True)
        self.assertEqual(report["status"], "blocked")
        self.assertTrue(report["workerInferenceVerified"])
        self.assertTrue(report["dashboardAccessRequested"])
        self.assertFalse(report["dashboardAccessVerified"])

    def test_writable_probe_leaves_no_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "state"
            cloud.check_writable(target)
            self.assertEqual(list(target.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
