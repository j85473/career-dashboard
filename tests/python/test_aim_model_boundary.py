from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = REPO_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from scoring_protocol.aim_registry import (  # noqa: E402
    load_aim_authorities,
    physical_plan_hash,
    plan_physical_packets,
    stage1_logical_packet,
)
from scoring_protocol.aim_runner_v2 import _run_physical_packet, load_aim_v2_settings  # noqa: E402
from scoring_protocol.codex_worker import (  # noqa: E402
    WorkerInvocationError,
    WorkerRun,
    build_worker_command,
    installed_models,
    run_worker,
)
from scoring_protocol.common import canonical_json  # noqa: E402


def receipt(effort: str, suffix: str) -> dict[str, object]:
    return {
        "phase": "unit", "model": "gpt-5.6-terra", "effort": effort,
        "promptVersion": "factual-instruction-v2",
        "startedAt": "2026-08-13T12:00:00.000Z", "completedAt": "2026-08-13T12:00:01.000Z",
        "invocationReceipt": f"codex-thread:{suffix}",
    }


class AimModelBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.authorities = load_aim_authorities(REPO_ROOT)

    def test_ordinary_identity_and_contact_text_in_source_is_preserved_for_the_model(self) -> None:
        metadata = {"company": "Example", "title": "Manager", "location": None}
        for source in ("Contact Joseph Lamb.", "Contact hiring@example.com.", "Call 612-555-1212."):
            with self.subTest(source=source):
                packet = plan_physical_packets(
                    [stage1_logical_packet(self.authorities)], source, metadata, 200_000, self.authorities
                )[0]
                self.assertIn(source, packet.rendered_input)

    def test_prompt_and_private_parser_contract_are_neutral(self) -> None:
        source = "Complete source with ordinary workflow automation language."
        metadata = {"company": "Example", "title": "Channel Manager", "location": "Minneapolis, MN"}
        packet = plan_physical_packets(
            [stage1_logical_packet(self.authorities)], source, metadata, 200_000, self.authorities
        )[0]
        forbidden = re.compile(
            r"(?<!\w)(?:joseph|joe|resume|hard stop|score|points|weight|band|consequence|dashboard|database|export|import|preview|approval|cache|validator|repair|retry)(?!\w)",
            re.IGNORECASE,
        )
        self.assertIsNone(forbidden.search(packet.rendered_input))
        self.assertIsNone(forbidden.search(canonical_json(packet.response_schema)))
        self.assertIn(source, packet.rendered_input)
        self.assertNotIn("S1.Q", packet.rendered_input)
        self.assertNotIn("json", packet.rendered_input.casefold())
        self.assertNotIn("schema", packet.rendered_input.casefold())

    def test_one_model_answer_is_recorded_and_script_maps_it_to_question_ids(self) -> None:
        source = "No relevant facts are stated."
        metadata = {"company": "Example", "title": "Channel Manager", "location": None}
        job = {
            "jobId": "11111111-1111-4111-8111-111111111111",
            "ordinal": 0,
            "trustedMetadata": metadata,
        }
        packet = plan_physical_packets(
            [stage1_logical_packet(self.authorities)], source, metadata, 200_000, self.authorities
        )[0]
        settings = load_aim_v2_settings(self.authorities, None, None)
        calls: list[tuple[str, object, str]] = []

        def fake(**kwargs: object) -> WorkerRun:
            calls.append((str(kwargs["prompt"]), kwargs["schema"], Path(kwargs["task_dir"]).name))
            effort = str(kwargs["effort"])
            prompt = str(kwargs["prompt"])
            count = len([
                line for line in prompt.splitlines()
                if re.match(r"^\d+\. ", line)
            ])
            raw = "\n".join(f"{number}. unsupported" for number in range(1, count + 1))
            return WorkerRun(raw, receipt(effort, "accepted"), raw_output=raw)

        with tempfile.TemporaryDirectory() as directory:
            value, packet_receipt, count = _run_physical_packet(
                packet=packet,
                packet_plan=physical_plan_hash([packet]),
                extraction_id="a" * 64,
                job=job,
                source=source,
                metadata=metadata,
                authorities=self.authorities,
                settings=settings,
                codex_path="/usr/bin/codex",
                output_dir=Path(directory),
                force_fresh_calibration=True,
                calibration_run_id="calibration1",
                worker_runner=fake,
            )
            model_output_paths = sorted((Path(directory) / ".calibration" / "calibration1" / "model-outputs").glob("*.json"))
            self.assertEqual(len(model_output_paths), 1)
            model_output = json.loads(model_output_paths[0].read_text(encoding="utf-8"))
        self.assertEqual(count, 1)
        self.assertEqual([attempt["effort"] for attempt in packet_receipt["attempts"]], ["medium"])
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(schema is None for _, schema, _ in calls))
        self.assertTrue(all(name.startswith("unit-") for _, _, name in calls))
        self.assertEqual(len(value["answers"]), 7)
        self.assertIsNone(model_output["rawResponse"])
        self.assertEqual(
            model_output["rawOutputText"],
            "\n".join(f"{number}. unsupported" for number in range(1, 8)),
        )
        self.assertEqual(model_output["parsedResponse"]["answers"], [
            {"number": number, "answer": "unsupported", "supportingText": []}
            for number in range(1, 8)
        ])
        self.assertEqual(
            [entry["questionId"] for entry in model_output["questionOutputs"]],
            [question["id"] for question in packet.ordered_questions],
        )
        self.assertEqual(model_output["validation"]["status"], "accepted")

    def test_plain_aim_worker_command_has_no_output_schema_argument(self) -> None:
        command = build_worker_command(
            codex_path="/usr/bin/codex",
            model="gpt-5.6-terra",
            effort="medium",
            task_dir=Path("/tmp/aim-test-task"),
            schema_path=None,
            output_path=Path("/tmp/aim-test-task/unit.output.txt"),
        )
        self.assertNotIn("--output-schema", command)
        self.assertIn("--output-last-message", command)

    def test_model_catalog_rejects_missing_or_malformed_context_capacity(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["codex", "debug", "models"], returncode=0,
            stdout='{"models":[{"slug":"gpt-5.6-terra","supported_reasoning_efforts":["medium"]}]}',
            stderr="",
        )
        with patch("subprocess.run", return_value=completed), self.assertRaisesRegex(
            RuntimeError, "catalog is not parseable"
        ):
            installed_models("/usr/bin/codex")

        malformed = subprocess.CompletedProcess(
            args=["codex", "debug", "models"], returncode=0, stdout="not-json", stderr="",
        )
        with patch("subprocess.run", return_value=malformed), self.assertRaisesRegex(
            RuntimeError, "catalog is not parseable"
        ):
            installed_models("/usr/bin/codex")

    def test_worker_rejects_timeout_tool_attempt_and_output_byte_limit(self) -> None:
        schema = {
            "type": "object", "additionalProperties": False, "required": ["value"],
            "properties": {"value": {"type": "string"}},
        }
        with tempfile.TemporaryDirectory() as directory:
            task = Path(directory)
            with patch(
                "subprocess.run", side_effect=subprocess.TimeoutExpired(cmd=["codex"], timeout=1)
            ), self.assertRaisesRegex(WorkerInvocationError, "timeout"):
                run_worker(
                    phase="unit", prompt_version="factual-instruction-v1", prompt="prompt", schema=schema,
                    task_dir=task, model="gpt-5.6-terra", effort="medium", timeout_seconds=1,
                    codex_path="/usr/bin/codex", maximum_output_bytes=64,
                )

            for forbidden_item_type in ("command_execution", "web_search"):
                def tool_attempt(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
                    output_path = task / "unit.output.json"
                    output_path.write_text('{"value":"semantic-output-must-not-be-used"}', encoding="utf-8")
                    stdout = '\n'.join((
                        '{"type":"thread.started","thread_id":"tool-attempt"}',
                        json.dumps({
                            "type": "item.completed",
                            "item": {"type": forbidden_item_type},
                        }),
                    ))
                    return subprocess.CompletedProcess(args=["codex"], returncode=0, stdout=stdout, stderr="")

                with self.subTest(forbidden_item_type=forbidden_item_type), patch(
                    "subprocess.run", side_effect=tool_attempt
                ), self.assertRaisesRegex(
                    WorkerInvocationError,
                    f"attempted forbidden worker capability {forbidden_item_type}",
                ) as raised:
                    run_worker(
                        phase="unit", prompt_version="factual-instruction-v1", prompt="prompt", schema=schema,
                        task_dir=task, model="gpt-5.6-terra", effort="medium", timeout_seconds=1,
                        codex_path="/usr/bin/codex", maximum_output_bytes=64,
                    )
                self.assertEqual(raised.exception.receipt["invocationReceipt"], "codex-thread:tool-attempt;failed")
                self.assertEqual(raised.exception.raw_output, '{"value":"semantic-output-must-not-be-used"}')

            def oversized(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
                (task / "unit.output.json").write_text('{"value":"' + ('x' * 80) + '"}', encoding="utf-8")
                return subprocess.CompletedProcess(
                    args=["codex"], returncode=0,
                    stdout='{"type":"thread.started","thread_id":"oversized"}', stderr="",
                )

            with patch("subprocess.run", side_effect=oversized), self.assertRaisesRegex(
                WorkerInvocationError, "exceeds 64 bytes"
            ):
                run_worker(
                    phase="unit", prompt_version="factual-instruction-v1", prompt="prompt", schema=schema,
                    task_dir=task, model="gpt-5.6-terra", effort="medium", timeout_seconds=1,
                    codex_path="/usr/bin/codex", maximum_output_bytes=64,
                )

            stale = task / "unit.output.json"
            stale.write_text('{"value":"stale"}', encoding="utf-8")
            no_output = subprocess.CompletedProcess(
                args=["codex"], returncode=0,
                stdout='{"type":"thread.started","thread_id":"no-output"}', stderr="",
            )
            with patch("subprocess.run", return_value=no_output), self.assertRaisesRegex(
                WorkerInvocationError, "invalid structured output"
            ):
                run_worker(
                    phase="unit", prompt_version="factual-instruction-v1", prompt="prompt", schema=schema,
                    task_dir=task, model="gpt-5.6-terra", effort="medium", timeout_seconds=1,
                    codex_path="/usr/bin/codex", maximum_output_bytes=64,
                )
            self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()
