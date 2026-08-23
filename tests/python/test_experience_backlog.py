from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from scripts.scoring_protocol.aim_backlog import RawResponse
from scripts.scoring_protocol.common import atomic_write_json, load_json
from scripts.scoring_protocol.experience_backlog import (
    blocking_experience_semantic_flags,
    EXCLUDED_REQUIREMENT_CATEGORY,
    INVENTORY_SILENCE_CATEGORY,
    catastrophic_experience_reason,
    experience_exit_summary,
    experience_semantic_flags,
    run_experience_backlog,
    save_experience_export,
)


class FakeExperienceDashboardClient:
    def __init__(self, queue_count: int, batch_id: str):
        self.base_url = "http://dashboard.test:3000"
        self.queue_count = queue_count
        self.batch_id = batch_id
        self.active = False
        self.apply_calls: list[tuple[dict[str, object], str]] = []

    def stage_queue_count(self, stage: str) -> int:
        assert stage == "experience"
        return self.queue_count

    def active_batches(self, stage: str) -> list[dict[str, object]]:
        assert stage == "experience"
        return [{"id": self.batch_id, "status": "exported"}] if self.active else []

    def export_batch(self, stage: str, limit: int) -> RawResponse:
        assert stage == "experience"
        self.active = True
        body = json.dumps({
            "schemaVersion": "career-dashboard-experience-export-v2",
            "batch": {"id": self.batch_id, "stage": "experience"},
            "jobs": [{"jobId": str(uuid.uuid4()), "ordinal": index} for index in range(limit)],
        }, sort_keys=True).encode("utf-8")
        return RawResponse(body, {"x-scoring-export-sha256": hashlib.sha256(body).hexdigest()})

    def preview_result(self, payload: dict[str, object]) -> dict[str, object]:
        self.active = True
        item_count = len(payload["results"])  # type: ignore[arg-type]
        return {
            "preview": {
                "batchId": self.batch_id,
                "stage": "experience",
                "resultHash": "c" * 64,
                "applicable": True,
                "itemCount": item_count,
                "expectedCount": item_count,
                "suppliedCount": item_count,
                "acceptedCount": item_count,
                "safeFailureCount": 0,
                "protectedLifecycleCount": 0,
                "scoreRange": {"minimum": 72, "maximum": 84},
                "decisionCounts": {"scored_survivor": item_count},
            },
            "approvalToken": "experience-preview-token",
            "approvalExpiresAt": "2026-08-20T18:15:00.000Z",
        }

    def apply_result(self, payload: dict[str, object], approval_token: str) -> dict[str, object]:
        self.apply_calls.append((payload, approval_token))
        self.active = False
        return {"batchId": self.batch_id, "imported": len(payload["results"]), "released": 0}  # type: ignore[arg-type]


def fake_run_experience(*, export_path: Path, output_dir: Path, **_: object) -> tuple[Path, dict[str, int]]:
    exported = load_json(export_path)
    batch_id = exported["batch"]["id"]
    results = [{
        "jobId": job["jobId"],
        "result": {
            "kind": "evaluation",
            "decision": "scored",
            "hardRequirementsNotMet": [],
            "experienceFitScore": 80,
        },
    } for job in exported["jobs"]]
    result_path = output_dir / f"career-dashboard-experience-results-{batch_id}.json"
    atomic_write_json(result_path, {
        "schemaVersion": "career-dashboard-experience-result-v2",
        "batch": {"id": batch_id},
        "results": results,
        "resultHash": "c" * 64,
    })
    return result_path, {
        "submitted": len(results), "accepted": len(results), "repaired": 0,
        "resumed": 0, "safeFailures": 0,
    }


class ExperienceBacklogTests(unittest.TestCase):
    def test_current_policy_treats_missing_mandatory_evidence_as_mismatch(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        policy = load_json(repo_root / "data/scoring/experience-policy-v2.json")
        prompt = (repo_root / "data/scoring/prompts/experience-hard-gate-v1.md").read_text()
        self.assertIs(policy["hardGate"]["unknownIsMismatch"], True)
        self.assertIn("Treat the inventory as exhaustive", prompt)
        self.assertIn("inventory silence is sufficient", prompt)
        self.assertIn("do not treat one absent alternative as a mismatch", prompt)
        self.assertIn("generic physical eligibility requirements", prompt)
        self.assertIn("comfort with executives or upper management", prompt)
        self.assertIn("citizenship or nationality restrictions", prompt)

    def test_export_requires_exact_experience_v2_stage_and_hash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            body = json.dumps({
                "schemaVersion": "career-dashboard-experience-export-v2",
                "batch": {"id": str(uuid.uuid4()), "stage": "experience"},
                "jobs": [],
            }).encode()
            receipt = save_experience_export(
                RawResponse(body, {"x-scoring-export-sha256": hashlib.sha256(body).hexdigest()}),
                Path(directory) / "START-E-FIT.json",
            )
            self.assertEqual(receipt["jobCount"], 0)
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                save_experience_export(
                    RawResponse(body, {"x-scoring-export-sha256": "0" * 64}),
                    Path(directory) / "bad.json",
                )

    def test_semantic_flags_detect_silence_and_excluded_requirements(self) -> None:
        payload = {"results": [
            {
                "jobId": "job-silence",
                "result": {
                    "kind": "evaluation",
                    "decision": "hard_requirement_mismatch",
                    "hardRequirementsNotMet": ["The evidence inventory does not show a required certification."],
                },
            },
            {
                "jobId": "job-admin",
                "result": {
                    "kind": "evaluation",
                    "decision": "hard_requirement_mismatch",
                    "hardRequirementsNotMet": ["A driver's license is required."],
                },
            },
        ]}
        flags = experience_semantic_flags(payload)
        self.assertEqual({flag["category"] for flag in flags}, {
            INVENTORY_SILENCE_CATEGORY, EXCLUDED_REQUIREMENT_CATEGORY,
        })

    def test_affirmative_hard_mismatch_is_not_flagged(self) -> None:
        payload = {"results": [{
            "jobId": "job-affirmative",
            "result": {
                "kind": "evaluation",
                "decision": "hard_requirement_mismatch",
                "hardRequirementsNotMet": [
                    "The role requires ten years of direct channel sales; the inventory establishes six years."
                ],
            },
        }]}
        self.assertEqual(experience_semantic_flags(payload), [])

    def test_physical_eligibility_mismatch_is_blocked(self) -> None:
        payload = {"results": [{
            "jobId": "job-altria",
            "result": {
                "kind": "evaluation",
                "decision": "hard_requirement_mismatch",
                "hardRequirementsNotMet": [
                    "The role requires Sales Managers to be able to lift, push, pull, reach, "
                    "conduct overhead work and carry required weights."
                ],
            },
        }]}
        flags = experience_semantic_flags(payload)
        self.assertEqual(flags, [{
            "jobId": "job-altria",
            "category": EXCLUDED_REQUIREMENT_CATEGORY,
            "detail": (
                "The role requires Sales Managers to be able to lift, push, pull, reach, "
                "conduct overhead work and carry required weights."
            ),
        }])
        self.assertEqual(blocking_experience_semantic_flags(flags), flags)

    def test_subjective_trait_mismatches_are_blocked(self) -> None:
        details = [
            "Excellent presentation skills: required under ‘Must Have,’ but not established in the supplied inventory.",
            "Comfort working with Upper Management: required under ‘Must Have,’ but the inventory does not establish it.",
        ]
        payload = {"results": [{
            "jobId": "job-cirtec",
            "result": {
                "kind": "evaluation",
                "decision": "hard_requirement_mismatch",
                "hardRequirementsNotMet": details,
            },
        }]}
        blocking = blocking_experience_semantic_flags(experience_semantic_flags(payload))
        self.assertEqual([flag["detail"] for flag in blocking], details)
        self.assertTrue(all(flag["category"] == EXCLUDED_REQUIREMENT_CATEGORY for flag in blocking))

    def test_citizenship_mismatch_is_blocked(self) -> None:
        detail = (
            "Joe does not meet the explicit requirement of U.S. citizenship with no dual citizenship; "
            "the evidence inventory provides no evidence of it."
        )
        payload = {"results": [{
            "jobId": "job-trm",
            "result": {
                "kind": "evaluation",
                "decision": "hard_requirement_mismatch",
                "hardRequirementsNotMet": [detail],
            },
        }]}
        blocking = blocking_experience_semantic_flags(experience_semantic_flags(payload))
        self.assertEqual(blocking, [{
            "jobId": "job-trm",
            "category": EXCLUDED_REQUIREMENT_CATEGORY,
            "detail": detail,
        }])

    def test_travel_industry_expertise_is_not_travel_logistics(self) -> None:
        payload = {"results": [{
            "jobId": "job-travel-industry",
            "result": {
                "kind": "evaluation",
                "decision": "hard_requirement_mismatch",
                "hardRequirementsNotMet": [
                    "Deep understanding of the travel industry is not established in the inventory."
                ],
            },
        }]}
        self.assertEqual(
            experience_semantic_flags(payload),
            [{
                "jobId": "job-travel-industry",
                "category": INVENTORY_SILENCE_CATEGORY,
                "detail": "Deep understanding of the travel industry is not established in the inventory.",
            }],
        )

    def test_explicit_preferred_not_mandatory_note_is_not_flagged(self) -> None:
        payload = {"results": [{
            "jobId": "job-mandatory-industrial",
            "result": {
                "kind": "evaluation",
                "decision": "hard_requirement_mismatch",
                "hardRequirementsNotMet": [
                    "The inventory contains no evidence of machine-tool sales or manufacturing-process knowledge. "
                    "Industrial B2B sales is described as preferred, not mandatory."
                ],
            },
        }]}
        self.assertEqual(
            experience_semantic_flags(payload),
            [{
                "jobId": "job-mandatory-industrial",
                "category": INVENTORY_SILENCE_CATEGORY,
                "detail": (
                    "The inventory contains no evidence of machine-tool sales or manufacturing-process knowledge. "
                    "Industrial B2B sales is described as preferred, not mandatory."
                ),
            }],
        )

    def test_auto_apply_runs_exact_experience_exchange(self) -> None:
        batch_id = str(uuid.uuid4())
        client = FakeExperienceDashboardClient(queue_count=2, batch_id=batch_id)
        with tempfile.TemporaryDirectory() as directory, patch(
            "scripts.scoring_protocol.experience_backlog.run_experience", side_effect=fake_run_experience,
        ):
            root = Path(directory)
            state_path, state = run_experience_backlog(
                client=client,  # type: ignore[arg-type]
                repo_root=root,
                output_dir=root / "results",
                delivery_dir=root / "Desktop",
                run_id=None,
                max_jobs=None,
                interactive_apply=False,
                auto_apply=True,
                model=None,
                effort=None,
                max_batches_this_invocation=None,
                output_function=lambda _: None,
            )
            self.assertEqual(state["status"], "completed")
            self.assertEqual(state["appliedJobs"], 2)
            self.assertEqual(state["remainingVisibleJobs"], 2)
            self.assertEqual(len(client.apply_calls), 1)
            self.assertEqual(client.apply_calls[0][1], "experience-preview-token")
            batch = state["batches"][0]
            self.assertTrue(batch["deliveryVerification"]["byteIdentical"])
            self.assertTrue(batch["deliveryVerification"]["jsonIdentityVerified"])
            summary = json.loads(experience_exit_summary(state_path, state))
            self.assertEqual(summary["decisionCounts"], {"scored_survivor": 2})

    def test_catastrophic_policy_stops_broad_safe_failures(self) -> None:
        response = {"preview": {"acceptedCount": 14, "safeFailureCount": 16}}
        self.assertIn("16 of 30", catastrophic_experience_reason(response, 30) or "")
        none = {"preview": {"acceptedCount": 0, "safeFailureCount": 1}}
        self.assertEqual(
            catastrophic_experience_reason(none, 1),
            "no applicable Experience results were produced",
        )

    def test_inventory_silence_never_blocks_an_import(self) -> None:
        # The inventory is exhaustive by policy, so a mismatch resting on its
        # silence is the hard gate working. Blocking on it would halt every
        # batch for following the prompt.
        flags = [
            {"jobId": "one", "category": INVENTORY_SILENCE_CATEGORY, "detail": "missing"},
            {"jobId": "two", "category": EXCLUDED_REQUIREMENT_CATEGORY, "detail": "preferred"},
        ]
        self.assertEqual(blocking_experience_semantic_flags(flags), [flags[1]])

    def test_only_silence_flags_leave_nothing_blocking(self) -> None:
        flags = [
            {"jobId": "one", "category": INVENTORY_SILENCE_CATEGORY, "detail": "no evidence of X"},
            {"jobId": "two", "category": INVENTORY_SILENCE_CATEGORY, "detail": "not established"},
        ]
        self.assertEqual(blocking_experience_semantic_flags(flags), [])


if __name__ == "__main__":
    unittest.main()
