from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Any

from .aim_identity import (
    extraction_identity,
    normalize_trusted_metadata,
    source_identity,
    source_jd_hash,
    trusted_metadata_hash,
)
from .aim_runner_v2 import run_aim_v2
from .common import atomic_write_json, canonical_sha256, load_json, normalize_source_text, safe_task_component
from .contracts import validate_export, validate_result_against_export
from .input_versions import (
    current_aim_v2_authority_bindings,
    expected_aim_v2_input_hash,
    validate_current_aim_v2_export,
)

BRIDGE_VERSION = "career-dashboard-aim-v1-calibration-bridge-v1"


def _manifest_hash(batch: dict[str, Any], jobs: list[dict[str, Any]]) -> str:
    return canonical_sha256({
        "kind": "aim_export_manifest_v2",
        "batchId": batch["id"],
        "stage": batch["stage"],
        "protocolVersion": batch["protocolVersion"],
        "exportSchemaVersion": batch["exportSchemaVersion"],
        "scoringPolicyVersion": batch["scoringPolicyVersion"],
        "questionRegistryHash": batch["questionRegistryHash"],
        "promptContractHash": batch["promptContractHash"],
        "responseContractHash": batch["responseContractHash"],
        "packetStrategyHash": batch["packetStrategyHash"],
        "items": [
            {"ordinal": job["ordinal"], "jobId": job["jobId"], "inputHash": job["inputHash"]}
            for job in jobs
        ],
    })


def build_v2_calibration_export(
    historical_export: dict[str, Any],
    repo_root: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Bind an exact historical v1 corpus to current v2 calibration authorities.

    This is not a migration path. It accepts only a fully valid historical Aim
    v1 export, preserves its source/metadata snapshots, prohibits extraction
    reuse, and exists solely as input to a forced-fresh calibration invocation.
    """
    if historical_export.get("schemaVersion") != "career-dashboard-aim-export-v1":
        raise ValueError("Aim calibration bridge accepts only career-dashboard-aim-export-v1")
    validate_export(historical_export, repo_root, "aim")

    old_batch = historical_export["batch"]
    bindings = current_aim_v2_authority_bindings(repo_root)
    batch: dict[str, Any] = {
        "id": old_batch["id"],
        "stage": "aim",
        "createdAt": old_batch["createdAt"],
        "expiresAt": old_batch["expiresAt"],
        **bindings,
        "manifestHash": "",
    }
    jobs: list[dict[str, Any]] = []
    source_bytes = 0
    for old_job in historical_export["jobs"]:
        source = old_job["originalJd"]
        if source != normalize_source_text(source):
            raise ValueError(
                f"historical Aim source is not already v2-canonical at ordinal {old_job['ordinal']}"
            )
        metadata = {
            "company": old_job["company"],
            "title": old_job["title"],
            "location": old_job["location"],
        }
        if normalize_trusted_metadata(metadata) != metadata:
            raise ValueError(
                f"historical Aim metadata is not already v2-canonical at ordinal {old_job['ordinal']}"
            )
        source_hash = source_jd_hash(source)
        if source_hash != old_job["sourceJdHash"]:
            raise ValueError(f"historical Aim source changed at ordinal {old_job['ordinal']}")
        metadata_hash = trusted_metadata_hash(metadata)
        source_id = source_identity(source_hash, metadata_hash)
        extraction_id = extraction_identity({
            "sourceIdentity": source_id,
            **{
                key: batch[key]
                for key in (
                    "questionRegistryVersion",
                    "questionRegistryHash",
                    "promptContractVersion",
                    "promptContractHash",
                    "responseContractVersion",
                    "responseContractHash",
                    "packetStrategyVersion",
                    "packetStrategyHash",
                    "canonicalizationVersion",
                    "anonymizationPolicyVersion",
                    "anonymizationPolicyHash",
                    "extractorSemanticVersion",
                )
            },
        })
        job: dict[str, Any] = {
            "jobId": old_job["jobId"],
            "ordinal": old_job["ordinal"],
            "submittedUpdatedAt": old_job["submittedUpdatedAt"],
            "inputHash": "",
            "trustedMetadata": metadata,
            "trustedMetadataHash": metadata_hash,
            "source": {"originalJd": source, "sourceJdHash": source_hash},
            "sourceIdentity": source_id,
            "extractionIdentity": extraction_id,
            "transportProvenance": {"sourceUrl": old_job["sourceUrl"]},
            "reuse": None,
        }
        job["inputHash"] = expected_aim_v2_input_hash(job, batch)
        jobs.append(job)
        source_bytes += len(source.encode("utf-8"))

    batch["manifestHash"] = _manifest_hash(batch, jobs)
    bridged = {"schemaVersion": "career-dashboard-aim-export-v2", "batch": batch, "jobs": jobs}
    validate_export(bridged, repo_root, "aim")
    validate_current_aim_v2_export(bridged, repo_root)

    if len(historical_export["jobs"]) != len(jobs):
        raise AssertionError("Aim calibration bridge changed batch membership")
    for old_job, job in zip(historical_export["jobs"], jobs):
        if job["source"]["originalJd"].encode("utf-8") != old_job["originalJd"].encode("utf-8"):
            raise AssertionError("Aim calibration bridge changed source bytes")
        if job["trustedMetadata"] != {
            "company": old_job["company"],
            "title": old_job["title"],
            "location": old_job["location"],
        }:
            raise AssertionError("Aim calibration bridge changed trusted metadata")
        if job["transportProvenance"]["sourceUrl"] != old_job["sourceUrl"]:
            raise AssertionError("Aim calibration bridge changed transport provenance")

    receipt = {
        "schemaVersion": "career-dashboard-aim-calibration-bridge-receipt-v1",
        "bridgeVersion": BRIDGE_VERSION,
        "artifactPurpose": "calibration",
        "sourceSchemaVersion": historical_export["schemaVersion"],
        "targetSchemaVersion": bridged["schemaVersion"],
        "batchId": batch["id"],
        "jobs": len(jobs),
        "sourceUtf8Bytes": source_bytes,
        "sourceBytesPreserved": True,
        "trustedMetadataPreserved": True,
        "transportProvenancePreserved": True,
        "reuseEmbedded": False,
        "targetManifestHash": batch["manifestHash"],
    }
    return bridged, receipt


def run_historical_aim_calibration(
    *,
    export_path: Path,
    output_dir: Path,
    repo_root: Path,
    model: str | None = None,
    effort: str | None = None,
    calibration_run_id: str | None = None,
) -> tuple[Path, Path, Path, Path, dict[str, int]]:
    historical = load_json(export_path)
    bridged, receipt = build_v2_calibration_export(historical, repo_root)
    run_id = safe_task_component(calibration_run_id or str(uuid.uuid4()))
    batch_id = safe_task_component(bridged["batch"]["id"])
    calibration_root = output_dir / ".calibration" / run_id
    calibration_input_path = calibration_root / f"career-dashboard-aim-calibration-input-{batch_id}.json"
    receipt_path = calibration_root / f"career-dashboard-aim-calibration-bridge-receipt-{batch_id}.json"
    atomic_write_json(calibration_input_path, bridged)
    source_export_hash = hashlib.sha256(export_path.read_bytes()).hexdigest()
    target_export_hash = hashlib.sha256(calibration_input_path.read_bytes()).hexdigest()
    atomic_write_json(receipt_path, {
        **receipt,
        "calibrationRunId": run_id,
        "sourceExportSha256": source_export_hash,
        "calibrationInputSha256": target_export_hash,
        "status": "prepared",
    })

    output_path, counts = run_aim_v2(
        export_path=calibration_input_path,
        output_dir=output_dir,
        repo_root=repo_root,
        model=model,
        effort=effort,
        force_fresh_calibration=True,
        calibration_run_id=run_id,
    )
    result = load_json(output_path)
    validate_result_against_export(result, bridged, repo_root)
    if result.get("artifactPurpose") != "calibration":
        raise ValueError("Aim calibration bridge produced an importable artifact purpose")
    model_output_records = [
        load_json(path)
        for path in sorted((calibration_root / "model-outputs").glob("*.json"))
    ]
    if len(model_output_records) != counts["modelCalls"]:
        raise ValueError("Aim calibration did not retain exactly one model-output record per invocation")
    model_outputs_path = output_dir / f"career-dashboard-aim-model-outputs-{batch_id}-{run_id}.json"
    atomic_write_json(model_outputs_path, {
        "schemaVersion": "career-dashboard-aim-model-outputs-v1",
        "artifactPurpose": "calibration",
        "importable": False,
        "batchId": batch_id,
        "calibrationRunId": run_id,
        "modelCallCount": counts["modelCalls"],
        "records": model_output_records,
    })
    atomic_write_json(receipt_path, {
        **receipt,
        "calibrationRunId": run_id,
        "sourceExportSha256": source_export_hash,
        "calibrationInputSha256": target_export_hash,
        "resultSha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
        "resultHash": result["resultHash"],
        "modelOutputsSha256": hashlib.sha256(model_outputs_path.read_bytes()).hexdigest(),
        "modelOutputRecords": len(model_output_records),
        "status": "completed",
    })
    return output_path, calibration_input_path, receipt_path, model_outputs_path, counts
