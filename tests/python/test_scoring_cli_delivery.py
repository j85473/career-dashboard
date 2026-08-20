from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
import uuid
from pathlib import Path

from scripts.scoring_protocol.cli import (
    project_output_dir,
    publish_desktop_upload_copy,
    repo_root,
    verified_delivery_receipt,
)
from scripts.scoring_protocol.common import verify_byte_identical


class ScoringCliDeliveryTests(unittest.TestCase):
    def test_default_canonical_output_stays_inside_project(self) -> None:
        self.assertEqual(project_output_dir(), repo_root() / "data" / "scoring" / "results")

    def test_desktop_upload_copy_is_byte_identical_and_clearly_named(self) -> None:
        batch_id = str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project_result = root / "project" / f"career-dashboard-experience-results-{batch_id}.json"
            project_result.parent.mkdir(parents=True)
            project_result.write_text(json.dumps({
                "schemaVersion": "career-dashboard-experience-result-v2",
                "batch": {"id": batch_id},
                "resultHash": "a" * 64,
            }, sort_keys=True) + "\n", encoding="utf-8")

            desktop_copy = publish_desktop_upload_copy("experience", project_result, root / "Desktop")

            self.assertEqual(desktop_copy, root / "Desktop" / f"career-dashboard-experience-upload-{batch_id}.json")
            self.assertEqual(project_result.read_bytes(), desktop_copy.read_bytes())
            self.assertEqual(
                hashlib.sha256(project_result.read_bytes()).hexdigest(),
                hashlib.sha256(desktop_copy.read_bytes()).hexdigest(),
            )
            verification = verify_byte_identical(project_result, desktop_copy)
            self.assertTrue(verification["verified"])
            self.assertTrue(verification["byteIdentical"])
            self.assertEqual(verification["bytes"], project_result.stat().st_size)
            self.assertEqual(verification["sha256"], hashlib.sha256(project_result.read_bytes()).hexdigest())

            receipt = verified_delivery_receipt(project_result, desktop_copy)
            self.assertEqual(receipt["batchId"], batch_id)
            self.assertTrue(receipt["jsonIdentityVerified"])

            with self.assertRaisesRegex(ValueError, "stage must be aim or experience"):
                publish_desktop_upload_copy("../unsafe", project_result, root / "Desktop")

    def test_byte_verification_rejects_and_copy_removes_tampered_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.json"
            destination = root / "destination.json"
            source.write_bytes(b"same-length-source")
            destination.write_bytes(b"same-length-tamper")
            with self.assertRaisesRegex(ValueError, "byte-identical"):
                verify_byte_identical(source, destination)


if __name__ == "__main__":
    unittest.main()
