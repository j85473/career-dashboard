from __future__ import annotations

import json
import re
import sys
import tempfile
import time
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
TESTS = Path(__file__).resolve().parent
for entry in (SCRIPTS, TESTS):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

from aim_v2_fixtures import make_aim_v2_export  # noqa: E402
from scoring_protocol.aim_evidence import expected_question_ids  # noqa: E402
from scoring_protocol.aim_identity import factual_vector_hash, packet_plan_hash  # noqa: E402
from scoring_protocol.aim_registry import load_aim_authorities  # noqa: E402
from scoring_protocol.aim_runner_v2 import parse_holistic_stage2_output, run_aim_v2  # noqa: E402
from scoring_protocol.codex_worker import WorkerInvocationError, WorkerRun  # noqa: E402
from scoring_protocol.common import load_json  # noqa: E402


def worker_receipt(effort: str) -> dict[str, object]:
    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {
        "phase": "unit",
        "model": "gpt-5.6-terra",
        "effort": effort,
        "promptVersion": "factual-instruction-v2",
        "startedAt": timestamp,
        "completedAt": timestamp,
        "invocationReceipt": "codex-thread:test",
    }


class AimRunnerV2Tests(unittest.TestCase):
    def test_holistic_stage2_parser_requires_score_first_and_a_bounded_rationale(self) -> None:
        self.assertEqual(
            parse_holistic_stage2_output("Aim Fit Score: 100\nStrong channel ownership and travel alignment."),
            {"score": 100, "rationale": "Strong channel ownership and travel alignment."},
        )
        for output in (
            "Score: 50\nReason",
            "Reason first\nAim Fit Score: 50",
            "Aim Fit Score: 101\nReason",
            "Aim Fit Score: 50",
        ):
            with self.subTest(output=output), self.assertRaises(ValueError):
                parse_holistic_stage2_output(output)

    def run_export(self, exported: dict[str, object], fake_worker: object) -> tuple[dict[str, object], dict[str, int], list[str]]:
        prompts: list[str] = []

        def capture(**kwargs: object) -> WorkerRun:
            prompts.append(str(kwargs["prompt"]))
            return fake_worker(**kwargs)  # type: ignore[operator]

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.aim_runner_v2.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.aim_runner_v2.selected_model_context_window", return_value=200_000
            ), patch("scoring_protocol.aim_runner_v2.run_worker", side_effect=capture):
                output_path, counts = run_aim_v2(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            result = load_json(output_path)
        return result, counts, prompts

    @staticmethod
    def unsupported_worker(**kwargs: object) -> WorkerRun:
        assert kwargs["schema"] is None
        if kwargs["effort"] == "high":
            assert kwargs["memory_enabled"] is True
            output = "Aim Fit Score: 50\nThe role presents a mixed, middle-of-the-road preference fit."
            return WorkerRun(output, worker_receipt("high"), raw_output=output)
        assert kwargs.get("memory_enabled", False) is False
        prompt = str(kwargs["prompt"])
        question_lines = [
            line for line in prompt.splitlines()
            if re.match(r"^\d+\. ", line)
        ]
        answer = "not found" if "Use present" in prompt else "unsupported"
        output = "\n".join(
            f"{number}. {answer}" for number in range(1, len(question_lines) + 1)
        )
        return WorkerRun(output, worker_receipt(str(kwargs["effort"])), raw_output=output)

    def test_survivor_uses_medium_stage1_and_one_high_holistic_stage2_call(self) -> None:
        exported, _ = make_aim_v2_export(REPO_ROOT)
        result, counts, prompts = self.run_export(exported, self.unsupported_worker)
        self.assertEqual(len(prompts), 2)
        self.assertTrue(all(exported["jobs"][0]["source"]["originalJd"] in prompt for prompt in prompts))
        self.assertTrue(all("S1.Q" not in prompt and "S2." not in prompt for prompt in prompts))
        item = result["results"][0]
        self.assertEqual(item["result"]["variant"], "scored_survivor")
        self.assertEqual(item["result"]["score"], 50)
        self.assertIn("middle-of-the-road", item["result"]["rationale"])
        self.assertEqual([worker["effort"] for worker in item["workers"]], ["medium", "high"])
        self.assertEqual(result["controller"]["totalModelCalls"], 2)
        self.assertEqual(counts["accepted"], 1)
        self.assertEqual(counts["safeFailures"], 0)

    def test_evidence_presentation_cannot_safe_fail_a_packet_or_job(self) -> None:
        exported, _ = make_aim_v2_export(REPO_ROOT)

        def presentation_worker(**kwargs: object) -> WorkerRun:
            if kwargs["effort"] == "high":
                return self.unsupported_worker(**kwargs)
            prompt = str(kwargs["prompt"])
            question_lines = [
                line for line in prompt.splitlines() if re.match(r"^\d+\. ", line)
            ]
            stage2 = "Use present" in prompt
            output = "\n".join(
                f"{number}. present\nThis display text is not an exact JD passage."
                if stage2 and number == 1
                else f"{number}. {'not found' if stage2 else 'unsupported'}"
                for number in range(1, len(question_lines) + 1)
            )
            return WorkerRun(output, worker_receipt(str(kwargs["effort"])), raw_output=output)

        result, counts, prompts = self.run_export(exported, presentation_worker)
        item = result["results"][0]
        self.assertEqual(len(prompts), 2)
        self.assertEqual(counts["modelCalls"], 2)
        self.assertEqual(counts["safeFailures"], 0)
        self.assertEqual(item["result"]["variant"], "scored_survivor")
        self.assertTrue(all(
            answer["answer"] == "unsupported"
            for answer in item["result"]["factualVector"]["answers"]
        ))

    def test_local_policy_kill_uses_zero_model_catalog_or_worker_calls(self) -> None:
        exported, _ = make_aim_v2_export(REPO_ROOT, companies=["PepsiCo, Inc."])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.aim_runner_v2.assert_model_available", side_effect=AssertionError("model catalog used")), patch(
                "scoring_protocol.aim_runner_v2.run_worker", side_effect=AssertionError("worker used")
            ):
                output_path, _ = run_aim_v2(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            result = load_json(output_path)
        self.assertEqual(result["controller"]["totalModelCalls"], 0)
        self.assertEqual(result["controller"]["models"], [])
        self.assertEqual(result["results"][0]["result"]["variant"], "local_policy_kill")
        self.assertEqual(result["results"][0]["workers"], [])

    def test_stage1_kill_stops_after_one_logical_unit(self) -> None:
        source = "This position is temporary."
        exported, _ = make_aim_v2_export(REPO_ROOT, sources=[source])

        def worker(**kwargs: object) -> WorkerRun:
            if kwargs["effort"] == "high":
                output = "Aim Fit Score: 25\nThe compensation language does not determine the holistic preference score."
                return WorkerRun(output, worker_receipt("high"), raw_output=output)
            prompt = str(kwargs["prompt"])
            self.assertIsNone(kwargs["schema"])
            question_lines = [line for line in prompt.splitlines() if re.match(r"^\d+\. ", line)]
            answers: list[str] = []
            for number in range(1, len(question_lines) + 1):
                temporary = "part-time, temporary" in question_lines[number - 1]
                answers.append(
                    f'{number}. yes\nEvidence: "{source}"'
                    if temporary else f"{number}. unsupported"
                )
            output = "\n".join(answers)
            return WorkerRun(output, worker_receipt(str(kwargs["effort"])), raw_output=output)

        result, _, prompts = self.run_export(exported, worker)
        self.assertEqual(len(prompts), 1)
        self.assertEqual(result["results"][0]["result"]["variant"], "factual_screen_kill")
        self.assertNotIn("compensation", result["results"][0]["result"])

    def test_stage2_scores_without_a_separate_compensation_packet(self) -> None:
        source = "Maximum annual total cash compensation is USD 59,999."
        exported, _ = make_aim_v2_export(REPO_ROOT, sources=[source])
        target_phrases = (
            "total-cash-compensation amount or range",
            "currency used for compensation",
            "pay period used for compensation",
        )

        def worker(**kwargs: object) -> WorkerRun:
            if kwargs["effort"] == "high":
                output = "Aim Fit Score: 25\nThe compensation language does not determine the holistic preference score."
                return WorkerRun(output, worker_receipt("high"), raw_output=output)
            prompt = str(kwargs["prompt"])
            self.assertIsNone(kwargs["schema"])
            question_lines = [line for line in prompt.splitlines() if re.match(r"^\d+\. ", line)]
            answers: list[str] = []
            stage2 = "Use present" in prompt
            for number in range(1, len(question_lines) + 1):
                selected = any(phrase in question_lines[number - 1] for phrase in target_phrases)
                answers.append(
                    f'{number}. present\nEvidence: "{source}"'
                    if selected else (
                        f"{number}. not found" if stage2 else f"{number}. unsupported"
                    )
                )
            output = "\n".join(answers)
            return WorkerRun(output, worker_receipt(str(kwargs["effort"])), raw_output=output)

        result, _, prompts = self.run_export(exported, worker)
        self.assertEqual(len(prompts), 2)
        self.assertEqual(result["results"][0]["result"]["variant"], "scored_survivor")
        self.assertEqual(result["results"][0]["result"]["score"], 25)
        self.assertNotIn("compensation", result["results"][0]["result"])

    def test_local_packet_checkpoints_resume_without_counting_historical_calls(self) -> None:
        exported, _ = make_aim_v2_export(REPO_ROOT)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.aim_runner_v2.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.aim_runner_v2.selected_model_context_window", return_value=200_000
            ), patch("scoring_protocol.aim_runner_v2.run_worker", side_effect=self.unsupported_worker):
                first_path, first_counts = run_aim_v2(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            first = load_json(first_path)
            def stage2_only(**kwargs: object) -> WorkerRun:
                self.assertEqual(kwargs["effort"], "high")
                return self.unsupported_worker(**kwargs)
            with patch("scoring_protocol.aim_runner_v2.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.aim_runner_v2.selected_model_context_window", return_value=200_000
            ), patch("scoring_protocol.aim_runner_v2.run_worker", side_effect=stage2_only):
                second_path, second_counts = run_aim_v2(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            second = load_json(second_path)
        self.assertEqual(first_counts["modelCalls"], 2)
        self.assertEqual(len(first["results"][0]["workers"]), 2)
        self.assertEqual(second_counts["modelCalls"], 1)
        self.assertEqual(second["controller"]["totalModelCalls"], 1)
        self.assertEqual(second["controller"]["models"], [{"model": "gpt-5.6-terra", "effort": "high"}])
        self.assertEqual(len(second["results"][0]["workers"]), 1)
        vector = second["results"][0]["result"]["factualVector"]
        self.assertEqual(vector["provenance"]["disposition"], "packet_cache_reuse")
        self.assertTrue(all(
            packet["attempts"] == []
            and packet["reusedFromPacketManifestHash"] == packet["packetManifestHash"]
            for packet in vector["provenance"]["packets"]
        ))

    def test_corrupt_local_checkpoint_is_quarantined_and_only_that_unit_regenerates(self) -> None:
        exported, _ = make_aim_v2_export(REPO_ROOT)
        calls = 0

        def counting_worker(**kwargs: object) -> WorkerRun:
            nonlocal calls
            calls += 1
            return self.unsupported_worker(**kwargs)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            patches = (
                patch("scoring_protocol.aim_runner_v2.assert_model_available", return_value="/usr/bin/codex"),
                patch("scoring_protocol.aim_runner_v2.selected_model_context_window", return_value=200_000),
                patch("scoring_protocol.aim_runner_v2.run_worker", side_effect=counting_worker),
            )
            with patches[0], patches[1], patches[2]:
                run_aim_v2(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            self.assertEqual(calls, 2)
            cache_files = sorted((root / ".cache" / "aim-v2").glob("*/packets/*.json"))
            self.assertEqual(len(cache_files), 1)
            damaged = json.loads(cache_files[0].read_text(encoding="utf-8"))
            damaged["extractionIdentity"] = "0" * 64
            cache_files[0].write_text(json.dumps(damaged), encoding="utf-8")
            calls = 0
            with patch("scoring_protocol.aim_runner_v2.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.aim_runner_v2.selected_model_context_window", return_value=200_000
            ), patch("scoring_protocol.aim_runner_v2.run_worker", side_effect=counting_worker):
                output_path, counts = run_aim_v2(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            result = load_json(output_path)
            quarantined = sorted((root / ".cache" / "aim-v2").glob("*/packets/quarantine/*.json"))
        self.assertEqual(calls, 2)
        self.assertEqual(counts["modelCalls"], 2)
        self.assertEqual(len(result["results"][0]["workers"]), 2)
        self.assertEqual(len(quarantined), 1)

    def test_force_fresh_calibration_isolated_from_production_packet_cache(self) -> None:
        exported, _ = make_aim_v2_export(REPO_ROOT)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.aim_runner_v2.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.aim_runner_v2.selected_model_context_window", return_value=200_000
            ), patch("scoring_protocol.aim_runner_v2.run_worker", side_effect=self.unsupported_worker):
                run_aim_v2(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)
            production_files = sorted((root / ".cache" / "aim-v2").glob("*/packets/*.json"))
            before = {path: path.read_bytes() for path in production_files}
            with patch("scoring_protocol.aim_runner_v2.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.aim_runner_v2.selected_model_context_window", return_value=200_000
            ), patch("scoring_protocol.aim_runner_v2.run_worker", side_effect=self.unsupported_worker):
                output_path, counts = run_aim_v2(
                    export_path=export_path,
                    output_dir=root,
                    repo_root=REPO_ROOT,
                    force_fresh_calibration=True,
                    calibration_run_id="fixture-calibration-1",
                )
            result = load_json(output_path)
            calibration_files = sorted((root / ".calibration" / "fixture-calibration-1" / "units").glob("*.json"))
            model_output_files = sorted(
                (root / ".calibration" / "fixture-calibration-1" / "model-outputs").glob("*.json")
            )
            model_output_records = [load_json(path) for path in model_output_files]
            after = {path: path.read_bytes() for path in production_files}
        self.assertEqual(counts["modelCalls"], 2)
        self.assertEqual(result["artifactPurpose"], "calibration")
        self.assertEqual(
            output_path.name,
            "career-dashboard-aim-calibration-11111111-1111-4111-8111-111111111111-fixture-calibration-1.json",
        )
        self.assertEqual(len(calibration_files), 1)
        self.assertEqual(len(model_output_records), counts["modelCalls"])
        self.assertEqual(
            [record["unit"]["privatePhase"] for record in model_output_records],
            ["stage1", "holistic_stage2"],
        )
        self.assertEqual(
            [record["attempt"]["effort"] for record in model_output_records],
            ["medium", "high"],
        )
        self.assertEqual(after, before)

    def test_force_fresh_calibration_records_a_failed_holistic_invocation(self) -> None:
        exported, _ = make_aim_v2_export(REPO_ROOT)

        def worker(**kwargs: object) -> WorkerRun:
            if kwargs["effort"] == "high":
                raise WorkerInvocationError(
                    "aim_stage2 attempted forbidden worker capability web_search",
                    worker_receipt("high"),
                )
            return self.unsupported_worker(**kwargs)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.aim_runner_v2.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.aim_runner_v2.selected_model_context_window", return_value=200_000
            ), patch("scoring_protocol.aim_runner_v2.run_worker", side_effect=worker):
                output_path, counts = run_aim_v2(
                    export_path=export_path,
                    output_dir=root,
                    repo_root=REPO_ROOT,
                    force_fresh_calibration=True,
                    calibration_run_id="fixture-calibration-failure",
                )
            result = load_json(output_path)
            records = [
                load_json(path)
                for path in sorted(
                    (root / ".calibration" / "fixture-calibration-failure" / "model-outputs").glob("*.json")
                )
            ]
        self.assertEqual(counts["modelCalls"], 2)
        self.assertEqual(counts["safeFailures"], 1)
        safe_failure = result["results"][0]["result"]
        self.assertEqual(safe_failure["code"], "worker_invocation_failed")
        self.assertEqual(safe_failure["phase"], "holistic_scoring")
        self.assertNotIn("score", safe_failure)
        self.assertIn("forbidden worker capability web_search", safe_failure["detail"])
        self.assertEqual(result["results"][0]["workers"][-1]["outcome"], "invocation_failed")
        self.assertEqual(len(records), 2)
        holistic = next(record for record in records if record["unit"]["privatePhase"] == "holistic_stage2")
        self.assertEqual(holistic["validation"]["status"], "not_run")
        self.assertEqual(holistic["validation"]["failureCategory"], "invocation_failure")

    def test_whitespace_source_safe_fails_and_invalid_unicode_sources_never_reach_model(self) -> None:
        whitespace_export, _ = make_aim_v2_export(REPO_ROOT, sources=["   \t\n"])
        result, counts, prompts = self.run_export(whitespace_export, self.unsupported_worker)
        self.assertEqual(result["results"][0]["result"]["code"], "source_unusable")
        self.assertEqual(counts["modelCalls"], 0)
        self.assertEqual(prompts, [])

        for source, message in (("bad\x00source", "NUL"), ("bad\ud800source", "valid Unicode")):
            exported, _ = make_aim_v2_export(REPO_ROOT)
            exported["jobs"][0]["source"]["originalJd"] = source
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                export_path = root / "export.json"
                export_path.write_text(json.dumps(exported), encoding="utf-8")
                with patch(
                    "scoring_protocol.aim_runner_v2.assert_model_available",
                    side_effect=AssertionError("model catalog used"),
                ), self.assertRaisesRegex(ValueError, message):
                    run_aim_v2(export_path=export_path, output_dir=root, repo_root=REPO_ROOT)

    def test_model_context_and_result_contract_limits_use_distinct_safe_failures(self) -> None:
        exported, _ = make_aim_v2_export(REPO_ROOT)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.aim_runner_v2.assert_model_available", return_value="/usr/bin/codex"), patch(
                "scoring_protocol.aim_runner_v2.selected_model_context_window", return_value=9_000
            ), patch(
                "scoring_protocol.aim_runner_v2.run_worker",
                side_effect=AssertionError("context-limit source reached a worker"),
            ):
                context_path, context_counts = run_aim_v2(
                    export_path=export_path, output_dir=root, repo_root=REPO_ROOT
                )
            context_result = load_json(context_path)
        self.assertEqual(context_counts["modelCalls"], 0)
        self.assertEqual(context_result["results"][0]["result"]["code"], "model_context_limit_exceeded")
        self.assertEqual(context_result["results"][0]["result"]["phase"], "model_input_preflight")

        authorities = load_aim_authorities(REPO_ROOT)
        authorities.runner_protocol["limits"]["maximumSerializedResultBytesPerJob"] = 2_500
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            export_path = root / "export.json"
            export_path.write_text(json.dumps(exported), encoding="utf-8")
            with patch("scoring_protocol.aim_runner_v2.load_aim_authorities", return_value=authorities), patch(
                "scoring_protocol.aim_runner_v2.assert_model_available", return_value="/usr/bin/codex"
            ), patch(
                "scoring_protocol.aim_runner_v2.selected_model_context_window", return_value=200_000
            ), patch("scoring_protocol.aim_runner_v2.run_worker", side_effect=self.unsupported_worker):
                contract_path, contract_counts = run_aim_v2(
                    export_path=export_path, output_dir=root, repo_root=REPO_ROOT
                )
            contract_result = load_json(contract_path)
        self.assertEqual(contract_counts["modelCalls"], 2)
        self.assertEqual(contract_result["results"][0]["result"]["code"], "input_contract_limit_exceeded")
        self.assertEqual(contract_result["results"][0]["result"]["phase"], "result_builder")
        self.assertIsNone(contract_result["results"][0]["extractionIdentity"])
        self.assertIsNone(contract_result["results"][0]["semanticResultHash"])

    def test_stage1_dashboard_reuse_continues_without_reasking_accepted_questions(self) -> None:
        exported, _ = make_aim_v2_export(REPO_ROOT)
        first, _, _ = self.run_export(exported, self.unsupported_worker)
        complete = first["results"][0]["result"]["factualVector"]
        authorities = load_aim_authorities(REPO_ROOT)
        stage1_ids = set(expected_question_ids("stage1", authorities))
        stage1 = deepcopy(complete)
        stage1["scope"] = "stage1"
        stage1["runnerProtocolVersion"] = "historical-runner-provenance-v1"
        stage1["runnerProtocolHash"] = "f" * 64
        stage1["answers"] = [answer for answer in complete["answers"] if answer["questionId"] in stage1_ids]
        evidence_ids = {evidence_id for answer in stage1["answers"] for evidence_id in answer["evidenceIds"]}
        stage1["evidenceCatalog"] = [
            entry for entry in complete["evidenceCatalog"] if entry["evidenceId"] in evidence_ids
        ]
        stage1_packets = [
            packet for packet in complete["provenance"]["packets"] if packet["baseOrdinal"] == 0
        ]
        stage1["provenance"] = {
            "disposition": "fresh",
            "sourceExtractionId": None,
            "packetPlanHash": packet_plan_hash([packet["packetManifestHash"] for packet in stage1_packets]),
            "packets": stage1_packets,
        }
        stage1["factualVectorHash"] = factual_vector_hash(stage1)
        extraction_row_id = "99999999-9999-4999-8999-999999999999"
        exported["jobs"][0]["reuse"] = {
            "aimFactualExtractionId": extraction_row_id,
            "scope": "stage1",
            "extractionIdentity": stage1["extractionIdentity"],
            "factualVectorHash": stage1["factualVectorHash"],
            "factualVector": stage1,
        }
        second, counts, prompts = self.run_export(exported, self.unsupported_worker)
        item = second["results"][0]
        self.assertEqual(len(prompts), 1)
        self.assertEqual(counts["modelCalls"], 1)
        self.assertEqual(len(item["workers"]), 1)
        self.assertEqual(item["result"]["variant"], "scored_survivor")
        final_vector = item["result"]["factualVector"]
        self.assertEqual(final_vector["factualVectorHash"], stage1["factualVectorHash"])
        self.assertTrue(all(
            question["wording"] not in "\n".join(prompts)
            for question in authorities.registry["questions"]
            if question["id"] in stage1_ids
        ))

    def test_cross_lifecycle_source_fact_closes_deterministically_without_repeating_questions(self) -> None:
        source = "The role owns acquisition and post-sale growth across the lifecycle."
        exported, _ = make_aim_v2_export(REPO_ROOT, sources=[source])

        def conflicting_worker(**kwargs: object) -> WorkerRun:
            if kwargs["effort"] == "high":
                return self.unsupported_worker(**kwargs)
            prompt = str(kwargs["prompt"])
            self.assertIsNone(kwargs["schema"])
            lines = [line for line in prompt.splitlines() if re.match(r"^\d+\. ", line)]
            answers: list[str] = []
            for number, line in enumerate(lines, start=1):
                is_cross_lifecycle = "across the customer lifecycle from initial acquisition" in line
                answers.append(
                    f'{number}. present\nEvidence: "{source}"'
                    if is_cross_lifecycle else (
                        f"{number}. not found" if "Use present" in prompt
                        else f"{number}. unsupported"
                    )
                )
            output = "\n".join(answers)
            return WorkerRun(output, worker_receipt(str(kwargs["effort"])), raw_output=output)

        result, counts, prompts = self.run_export(exported, conflicting_worker)
        item = result["results"][0]
        self.assertEqual(item["result"]["variant"], "scored_survivor")
        self.assertEqual(len(prompts), 2)
        self.assertEqual(len(item["workers"]), 2)
        self.assertEqual(result["controller"]["totalModelCalls"], 2)
        self.assertEqual(counts["modelCalls"], 2)
        self.assertEqual(sum(
            "across the customer lifecycle from initial acquisition" in prompt
            for prompt in prompts
        ), 0)

    def test_batch_model_concurrency_is_globally_four_and_per_job_two(self) -> None:
        sources = [f"No relevant facts are stated for source {index}." for index in range(4)]
        exported, _ = make_aim_v2_export(REPO_ROOT, sources=sources)
        lock = Lock()
        active_total = 0
        maximum_total = 0
        active_by_source = {source: 0 for source in sources}
        maximum_by_source = {source: 0 for source in sources}

        def worker(**kwargs: object) -> WorkerRun:
            nonlocal active_total, maximum_total
            prompt = str(kwargs["prompt"])
            source = next(value for value in sources if value in prompt)
            with lock:
                active_total += 1
                active_by_source[source] += 1
                maximum_total = max(maximum_total, active_total)
                maximum_by_source[source] = max(maximum_by_source[source], active_by_source[source])
            time.sleep(0.01)
            try:
                return self.unsupported_worker(**kwargs)
            finally:
                with lock:
                    active_total -= 1
                    active_by_source[source] -= 1

        result, counts, _ = self.run_export(exported, worker)
        self.assertEqual([item["ordinal"] for item in result["results"]], list(range(4)))
        self.assertEqual(counts["accepted"], 4)
        self.assertEqual(maximum_total, 4)
        self.assertTrue(all(value <= 2 for value in maximum_by_source.values()))

    def test_runner_accepts_fifty_ordered_jobs(self) -> None:
        sources = [f"No relevant facts are stated for source {index}." for index in range(50)]
        exported, _ = make_aim_v2_export(
            REPO_ROOT,
            sources=sources,
            companies=["PepsiCo, Inc."] * 50,
        )
        result, counts, prompts = self.run_export(exported, self.unsupported_worker)

        self.assertEqual(len(result["results"]), 50)
        self.assertEqual([item["ordinal"] for item in result["results"]], list(range(50)))
        self.assertEqual(result["results"][-1]["ordinal"], 49)
        self.assertEqual(counts["accepted"], 50)
        self.assertEqual(counts["safeFailures"], 0)
        self.assertEqual(counts["modelCalls"], 0)
        self.assertEqual(prompts, [])


if __name__ == "__main__":
    unittest.main()
