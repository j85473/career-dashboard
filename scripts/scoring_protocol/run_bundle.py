from __future__ import annotations

import json
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import BoundedSemaphore, Lock
from typing import Any

from .aim_runner_v2 import run_aim_v2
from .common import (
    atomic_copy_file,
    atomic_write_json,
    canonical_json,
    canonical_sha256,
    file_sha256,
    load_json,
    utc_timestamp,
    verify_byte_identical,
)
from .contracts import validate_export, validate_result_against_export
from .experience_runner import run_experience


RUN_EXPORT_SCHEMA = "career-dashboard-scoring-run-export-v1"
RUN_RESULT_DRAFT_SCHEMA = "career-dashboard-scoring-run-result-draft-v1"
RUN_RESULT_SCHEMA = "career-dashboard-scoring-run-result-v1"
EXPERIENCE_REVIEW_SCHEMA = "career-dashboard-experience-run-review-v1"
RUN_STATE_SCHEMA = "career-dashboard-scoring-run-state-v1"
MAX_RUN_BYTES = 64 * 1024 * 1024
CHILD_BATCH_SIZE = 40
CHILD_BATCH_CONCURRENCY = 2
GLOBAL_MODEL_CONCURRENCY = 4
MAX_RUN_JOBS = 2000
MAX_CHILD_BATCHES = MAX_RUN_JOBS // CHILD_BATCH_SIZE
RUN_REQUEST_OVERHEAD_BYTES = 4096


def _uuid(value: Any, name: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError(f"{name} must be an exact UUID") from error


def _record(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def _assert_run_exchange_size(value: dict[str, Any], name: str) -> None:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    size = len(encoded.encode("utf-8")) + RUN_REQUEST_OVERHEAD_BYTES
    if size > MAX_RUN_BYTES:
        raise ValueError(f"{name} exceeds the 64 MiB scoring-run exchange ceiling")


def validate_run_export(exported: dict[str, Any], repo_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if exported.get("schemaVersion") != RUN_EXPORT_SCHEMA:
        raise ValueError("scoring run accepts only career-dashboard-scoring-run-export-v1")
    run = _record(exported.get("run"), "scoring run")
    run_id = _uuid(run.get("id"), "run ID")
    stage = run.get("stage")
    if stage not in {"aim", "experience"}:
        raise ValueError("scoring run stage must be aim or experience")
    if run.get("batchSize") != CHILD_BATCH_SIZE:
        raise ValueError("scoring run child batch size must equal 40")
    raw_batches = exported.get("batches")
    if not isinstance(raw_batches, list) or not raw_batches:
        raise ValueError("scoring run must contain child batches")
    if len(raw_batches) > MAX_CHILD_BATCHES:
        raise ValueError("scoring run exceeds the 2,000-job safety ceiling")
    if run.get("batchCount") != len(raw_batches):
        raise ValueError("scoring run child count mismatch")

    batches: list[dict[str, Any]] = []
    total_jobs = 0
    manifest_batches: list[dict[str, Any]] = []
    seen_jobs: set[str] = set()
    for ordinal, raw in enumerate(raw_batches):
        entry = _record(raw, f"run child {ordinal}")
        if entry.get("ordinal") != ordinal:
            raise ValueError("scoring run child order mismatch")
        batch_id = _uuid(entry.get("batchId"), f"run child {ordinal} batch ID")
        child_export = _record(entry.get("export"), f"run child {ordinal} export")
        child_batch = _record(child_export.get("batch"), f"run child {ordinal} export batch")
        jobs = child_export.get("jobs")
        if not isinstance(jobs, list) or not 1 <= len(jobs) <= CHILD_BATCH_SIZE:
            raise ValueError(f"run child {ordinal} must contain 1–{CHILD_BATCH_SIZE} jobs")
        if ordinal < len(raw_batches) - 1 and len(jobs) != CHILD_BATCH_SIZE:
            raise ValueError("only the final scoring run child may contain fewer than 40 jobs")
        if entry.get("jobCount") != len(jobs):
            raise ValueError(f"run child {ordinal} job count mismatch")
        if child_batch.get("id") != batch_id or child_batch.get("stage") != stage:
            raise ValueError(f"run child {ordinal} stage or batch binding mismatch")
        export_hash = canonical_sha256(child_export)
        if entry.get("exportHash") != export_hash:
            raise ValueError(f"run child {ordinal} export hash mismatch")
        validate_export(child_export, repo_root, stage)
        for job in jobs:
            job_id = _record(job, "run child job").get("jobId")
            if not isinstance(job_id, str) or not job_id or job_id in seen_jobs:
                raise ValueError("scoring run contains a missing or duplicate job ID")
            seen_jobs.add(job_id)
        total_jobs += len(jobs)
        manifest_batches.append({
            "ordinal": ordinal,
            "batchId": batch_id,
            "jobCount": len(jobs),
            "exportHash": export_hash,
            "manifestHash": child_batch.get("manifestHash"),
        })
        batches.append({**entry, "batchId": batch_id, "export": child_export})
    if run.get("jobCount") != total_jobs:
        raise ValueError("scoring run total job count mismatch")
    if total_jobs > MAX_RUN_JOBS:
        raise ValueError("scoring run exceeds the 2,000-job safety ceiling")
    expected_manifest = canonical_sha256({
        "kind": "scoring_run_manifest_v1",
        "runId": run_id,
        "stage": stage,
        "batchSize": CHILD_BATCH_SIZE,
        "jobCount": total_jobs,
        "batches": manifest_batches,
    })
    if run.get("manifestHash") != expected_manifest:
        raise ValueError("scoring run manifest hash mismatch")
    return {**run, "id": run_id, "stage": stage}, batches


def _child_export_path(run_root: Path, entry: dict[str, Any], stage: str) -> Path:
    trigger = "START-AIM-FIT" if stage == "aim" else "START-E-FIT"
    return run_root / f"batch-{entry['ordinal']:03d}-{trigger}-{entry['batchId']}.json"


def _new_state(run: dict[str, Any], source_hash: str, source_path: Path, batches: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schemaVersion": RUN_STATE_SCHEMA,
        "runId": run["id"],
        "stage": run["stage"],
        "sourcePath": str(source_path.resolve()),
        "sourceSha256": source_hash,
        "createdAt": utc_timestamp(),
        "updatedAt": utc_timestamp(),
        "status": "running",
        "batches": [{
            "ordinal": entry["ordinal"],
            "batchId": entry["batchId"],
            "status": "pending",
            "exportHash": entry["exportHash"],
            "resultPath": None,
            "resultHash": None,
            "counts": None,
            "error": None,
        } for entry in batches],
    }


def _persist_state(path: Path, state: dict[str, Any], lock: Lock | None = None) -> None:
    if lock is None:
        state["updatedAt"] = utc_timestamp()
        atomic_write_json(path, state)
        return
    with lock:
        state["updatedAt"] = utc_timestamp()
        atomic_write_json(path, state)


def _result_entry(entry: dict[str, Any], result_path: Path, repo_root: Path) -> dict[str, Any]:
    result = load_json(result_path)
    validate_result_against_export(result, entry["export"], repo_root)
    result_hash = result.get("resultHash")
    if not isinstance(result_hash, str) or not result_hash:
        raise ValueError(f"run child {entry['ordinal']} result is missing resultHash")
    return {
        "ordinal": entry["ordinal"],
        "batchId": entry["batchId"],
        "exportHash": entry["exportHash"],
        "resultHash": result_hash,
        "result": result,
    }


def _experience_mismatches(
    batches: list[dict[str, Any]], results: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    mismatches: list[dict[str, Any]] = []
    for entry, completed in zip(batches, results):
        jobs = entry["export"]["jobs"]
        for job, item in zip(jobs, completed["result"]["results"]):
            decision = item["result"]
            if decision.get("kind") != "evaluation" or decision.get("decision") != "hard_requirement_mismatch":
                continue
            mismatches.append({
                "batchOrdinal": entry["ordinal"],
                "batchId": entry["batchId"],
                "jobId": item["jobId"],
                "resultHash": item["resultHash"],
                "trustedMetadata": job["trustedMetadata"],
                "originalJd": job["originalJd"],
                "hardRequirementsNotMet": decision.get("hardRequirementsNotMet", []),
                "hardRequirementEvidence": decision.get("hardRequirementEvidence", []),
                "decision": "pending",
            })
    return mismatches


def _approved_semantic_review(run_id: str, reviews: list[dict[str, str]]) -> dict[str, Any]:
    exact = [{
        "batchId": item["batchId"],
        "jobId": item["jobId"],
        "resultHash": item["resultHash"],
        "decision": "approved",
    } for item in reviews]
    hash_items = [{key: item[key] for key in ("batchId", "jobId", "resultHash")} for item in exact]
    return {
        "status": "approved",
        "reviewer": "codex-main-agent",
        "reviewedAt": utc_timestamp(),
        "reviews": exact,
        "reviewHash": canonical_sha256({
            "kind": "experience_run_semantic_review_v1",
            "runId": run_id,
            "reviews": hash_items,
        }),
    }


def _final_payload(draft: dict[str, Any], semantic_review: dict[str, Any] | None) -> dict[str, Any]:
    without_hash = {
        **draft,
        "schemaVersion": RUN_RESULT_SCHEMA,
        "semanticReview": semantic_review,
    }
    return {**without_hash, "resultHash": canonical_sha256(without_hash)}


def _publish_result(
    *, result: dict[str, Any], output_dir: Path, delivery_dir: Path, stage: str, run_id: str,
) -> tuple[Path, Path, dict[str, Any]]:
    project_path = output_dir / f"career-dashboard-{stage}-run-results-{run_id}.json"
    delivery_path = delivery_dir / f"career-dashboard-{stage}-run-upload-{run_id}.json"
    atomic_write_json(project_path, result)
    atomic_copy_file(project_path, delivery_path)
    receipt = verify_byte_identical(project_path, delivery_path)
    return project_path, delivery_path, receipt


def _completed_run_receipt(state: dict[str, Any], run_id: str, stage: str) -> dict[str, Any]:
    result_path_value = state.get("resultPath")
    delivery_path_value = state.get("deliveryPath")
    if not isinstance(result_path_value, str) or not isinstance(delivery_path_value, str):
        raise ValueError("completed scoring run recovery state is missing delivery paths")
    result_path = Path(result_path_value)
    delivery_path = Path(delivery_path_value)
    result = load_json(result_path, integers_only=False, maximum_bytes=MAX_RUN_BYTES)
    if result.get("schemaVersion") != RUN_RESULT_SCHEMA:
        raise ValueError("completed scoring run result schema mismatch")
    result_run = _record(result.get("run"), "completed scoring run result")
    if result_run.get("id") != run_id or result_run.get("stage") != stage:
        raise ValueError("completed scoring run result binding mismatch")
    if result_run.get("exportHash") != state.get("sourceSha256"):
        raise ValueError("completed scoring run source hash mismatch")
    result_hash = result.get("resultHash")
    if not isinstance(result_hash, str):
        raise ValueError("completed scoring run result is missing resultHash")
    without_hash = {key: value for key, value in result.items() if key != "resultHash"}
    if canonical_sha256(without_hash) != result_hash or state.get("resultHash") != result_hash:
        raise ValueError("completed scoring run result hash mismatch")
    receipt = verify_byte_identical(result_path, delivery_path)
    controller = _record(result.get("controller"), "completed scoring run controller")
    counts = _record(controller.get("counts"), "completed scoring run counts")
    return {
        "stage": stage, "runId": run_id, "status": "completed", "idempotentReplay": True,
        "counts": counts, "validatorStatus": "valid",
        "projectOutputPath": str(result_path.resolve()),
        "desktopUploadPath": str(delivery_path.resolve()), "deliveryVerification": receipt,
    }


def run_scoring_bundle(
    *, export_path: Path, output_dir: Path, delivery_dir: Path, repo_root: Path,
    model: str | None = None, effort: str | None = None,
) -> dict[str, Any]:
    exported = load_json(export_path, maximum_bytes=MAX_RUN_BYTES)
    run, batches = validate_run_export(exported, repo_root)
    source_hash = file_sha256(export_path)
    run_root = output_dir / ".tasks" / run["id"] / f"{run['stage']}-run"
    state_path = run_root / "run.json"
    if state_path.exists():
        state = load_json(state_path, integers_only=False, maximum_bytes=MAX_RUN_BYTES)
        if state.get("schemaVersion") != RUN_STATE_SCHEMA or state.get("runId") != run["id"] \
            or state.get("stage") != run["stage"] or state.get("sourceSha256") != source_hash:
            raise ValueError("existing scoring run state does not bind this exact export")
    else:
        state = _new_state(run, source_hash, export_path, batches)
        _persist_state(state_path, state)

    resolved_source = str(export_path.resolve())
    if state.get("sourcePath") != resolved_source:
        state["sourcePath"] = resolved_source
        _persist_state(state_path, state)

    if state.get("status") == "completed":
        return _completed_run_receipt(state, run["id"], run["stage"])
    if state.get("status") == "awaiting_semantic_review":
        draft_path_value = state.get("draftPath")
        review_path_value = state.get("reviewPath")
        if not isinstance(draft_path_value, str) or not isinstance(review_path_value, str):
            raise ValueError("Experience semantic-review recovery state is incomplete")
        draft_path = Path(draft_path_value)
        review_path = Path(review_path_value)
        draft = load_json(draft_path, integers_only=False, maximum_bytes=MAX_RUN_BYTES)
        review = load_json(review_path, integers_only=False, maximum_bytes=MAX_RUN_BYTES)
        if draft.get("schemaVersion") != RUN_RESULT_DRAFT_SCHEMA \
            or review.get("schemaVersion") != EXPERIENCE_REVIEW_SCHEMA \
            or _record(draft.get("run"), "Experience run draft").get("id") != run["id"] \
            or review.get("runId") != run["id"]:
            raise ValueError("Experience semantic-review recovery binding mismatch")
        reviews = review.get("reviews")
        if not isinstance(reviews, list):
            raise ValueError("Experience semantic-review recovery list is invalid")
        return {
            "stage": run["stage"], "runId": run["id"], "status": "awaiting_semantic_review",
            "counts": state.get("counts", {}), "draftPath": str(draft_path.resolve()),
            "reviewPath": str(review_path.resolve()), "mismatchCount": len(reviews),
            "projectOutputPath": None, "desktopUploadPath": None,
        }

    for entry in batches:
        child_path = _child_export_path(run_root, entry, run["stage"])
        if child_path.exists():
            child = load_json(child_path)
            if canonical_sha256(child) != entry["exportHash"]:
                raise ValueError(f"stored child export {entry['ordinal']} hash mismatch")
        else:
            atomic_write_json(child_path, entry["export"])

    state_lock = Lock()
    model_semaphore = BoundedSemaphore(GLOBAL_MODEL_CONCURRENCY)

    def run_child(entry: dict[str, Any]) -> tuple[int, Path, dict[str, int]]:
        ordinal = entry["ordinal"]
        batch_state = state["batches"][ordinal]
        if batch_state.get("status") == "completed":
            result_path_value = batch_state.get("resultPath")
            counts = batch_state.get("counts")
            if not isinstance(result_path_value, str) or not isinstance(counts, dict):
                raise ValueError(f"completed run child {ordinal} has incomplete recovery state")
            result_path = Path(result_path_value)
            completed = _result_entry(entry, result_path, repo_root)
            if batch_state.get("resultHash") != completed["resultHash"]:
                raise ValueError(f"completed run child {ordinal} recovery hash mismatch")
            return ordinal, result_path, {key: int(value) for key, value in counts.items()}
        batch_state.update({"status": "running", "error": None})
        _persist_state(state_path, state, state_lock)
        child_path = _child_export_path(run_root, entry, run["stage"])
        try:
            if run["stage"] == "aim":
                result_path, counts = run_aim_v2(
                    export_path=child_path, output_dir=output_dir, repo_root=repo_root,
                    model=model, effort=effort, shared_model_semaphore=model_semaphore,
                )
            else:
                result_path, counts = run_experience(
                    export_path=child_path, output_dir=output_dir, repo_root=repo_root,
                    model=model, effort=effort, model_semaphore=model_semaphore, job_workers=2,
                )
            completed = _result_entry(entry, result_path, repo_root)
            batch_state.update({
                "status": "completed",
                "resultPath": str(result_path.resolve()),
                "resultHash": completed["resultHash"],
                "counts": counts,
                "error": None,
            })
            _persist_state(state_path, state, state_lock)
            return ordinal, result_path, counts
        except BaseException as error:
            batch_state.update({
                "status": "error",
                "error": {"type": type(error).__name__, "message": str(error), "at": utc_timestamp()},
            })
            _persist_state(state_path, state, state_lock)
            raise

    failures: list[tuple[int, BaseException]] = []
    with ThreadPoolExecutor(max_workers=CHILD_BATCH_CONCURRENCY, thread_name_prefix="scoring-run-child") as executor:
        future_map = {executor.submit(run_child, entry): entry["ordinal"] for entry in batches}
        for future in as_completed(future_map):
            try:
                future.result()
            except BaseException as error:
                failures.append((future_map[future], error))
    if failures:
        state["status"] = "error"
        _persist_state(state_path, state)
        summary = "; ".join(f"child {ordinal}: {type(error).__name__}: {error}" for ordinal, error in failures)
        raise RuntimeError(f"scoring run has failed child batches: {summary}")

    result_entries = [
        _result_entry(entry, Path(state["batches"][entry["ordinal"]]["resultPath"]), repo_root)
        for entry in batches
    ]
    counts = {
        key: sum(int(batch["counts"].get(key, 0)) for batch in state["batches"])
        for key in {key for batch in state["batches"] for key in batch["counts"]}
    }
    draft = {
        "schemaVersion": RUN_RESULT_DRAFT_SCHEMA,
        "run": {
            "id": run["id"],
            "stage": run["stage"],
            "exportHash": source_hash,
            "manifestHash": run["manifestHash"],
            "jobCount": run["jobCount"],
            "batchCount": run["batchCount"],
        },
        "controller": {
            "controllerVersion": "career-dashboard-scoring-run-controller-v1",
            "childBatchConcurrency": CHILD_BATCH_CONCURRENCY,
            "globalModelConcurrency": GLOBAL_MODEL_CONCURRENCY,
            "completedAt": utc_timestamp(),
            "counts": counts,
        },
        "batches": result_entries,
    }
    if run["stage"] == "experience":
        mismatches = _experience_mismatches(batches, result_entries)
        if mismatches:
            draft_path = output_dir / f"career-dashboard-experience-run-draft-{run['id']}.json"
            review_path = output_dir / f"career-dashboard-experience-run-review-{run['id']}.json"
            review_payload = {
                "schemaVersion": EXPERIENCE_REVIEW_SCHEMA,
                "runId": run["id"],
                "evidence": batches[0]["export"]["evidence"],
                "reviews": mismatches,
            }
            _assert_run_exchange_size(draft, "Experience run draft")
            _assert_run_exchange_size(review_payload, "Experience semantic review")
            atomic_write_json(draft_path, draft)
            atomic_write_json(review_path, review_payload)
            state["status"] = "awaiting_semantic_review"
            state["counts"] = counts
            state["draftPath"] = str(draft_path.resolve())
            state["reviewPath"] = str(review_path.resolve())
            _persist_state(state_path, state)
            return {
                "stage": run["stage"], "runId": run["id"], "status": state["status"],
                "counts": counts, "draftPath": str(draft_path.resolve()),
                "reviewPath": str(review_path.resolve()), "mismatchCount": len(mismatches),
                "projectOutputPath": None, "desktopUploadPath": None,
            }
        semantic_review = _approved_semantic_review(run["id"], [])
    else:
        semantic_review = None

    final = _final_payload(draft, semantic_review)
    _assert_run_exchange_size(final, "scoring run result")
    project_path, delivery_path, receipt = _publish_result(
        result=final, output_dir=output_dir, delivery_dir=delivery_dir,
        stage=run["stage"], run_id=run["id"],
    )
    state["status"] = "completed"
    state["resultHash"] = final["resultHash"]
    state["resultPath"] = str(project_path.resolve())
    state["deliveryPath"] = str(delivery_path.resolve())
    _persist_state(state_path, state)
    return {
        "stage": run["stage"], "runId": run["id"], "status": "completed", "counts": counts,
        "validatorStatus": "valid", "projectOutputPath": str(project_path.resolve()),
        "desktopUploadPath": str(delivery_path.resolve()), "deliveryVerification": receipt,
    }


def finalize_experience_bundle(
    *, draft_path: Path, review_path: Path, output_dir: Path, delivery_dir: Path, repo_root: Path,
) -> dict[str, Any]:
    draft = load_json(draft_path, integers_only=False, maximum_bytes=MAX_RUN_BYTES)
    if draft.get("schemaVersion") != RUN_RESULT_DRAFT_SCHEMA:
        raise ValueError("Experience run draft has an unsupported schema")
    run = _record(draft.get("run"), "Experience draft run")
    if run.get("stage") != "experience":
        raise ValueError("Experience finalizer accepts only an Experience run draft")
    run_id = _uuid(run.get("id"), "Experience run ID")
    state_path = output_dir / ".tasks" / run_id / "experience-run" / "run.json"
    state = load_json(state_path, integers_only=False, maximum_bytes=MAX_RUN_BYTES)
    if state.get("schemaVersion") != RUN_STATE_SCHEMA or state.get("runId") != run_id \
        or state.get("stage") != "experience":
        raise ValueError("Experience finalizer state does not bind the draft run")
    if state.get("status") == "completed":
        return _completed_run_receipt(state, run_id, "experience")
    if state.get("status") != "awaiting_semantic_review" \
        or state.get("draftPath") != str(draft_path.resolve()) \
        or state.get("reviewPath") != str(review_path.resolve()):
        raise ValueError("Experience finalizer requires the exact awaiting-review state")
    review = load_json(review_path, integers_only=False, maximum_bytes=MAX_RUN_BYTES)
    if review.get("schemaVersion") != EXPERIENCE_REVIEW_SCHEMA or review.get("runId") != run_id:
        raise ValueError("Experience semantic review does not bind the draft run")

    source_path_value = state.get("sourcePath")
    source_hash = state.get("sourceSha256")
    if not isinstance(source_path_value, str) or not isinstance(source_hash, str):
        raise ValueError("Experience finalizer state is missing its exact source export")
    source_path = Path(source_path_value)
    if file_sha256(source_path) != source_hash or run.get("exportHash") != source_hash:
        raise ValueError("Experience finalizer source export hash mismatch")
    exported = load_json(source_path, maximum_bytes=MAX_RUN_BYTES)
    source_run, source_batches = validate_run_export(exported, repo_root)
    if source_run["id"] != run_id or source_run["manifestHash"] != run.get("manifestHash"):
        raise ValueError("Experience finalizer source manifest mismatch")

    draft_batches = draft.get("batches")
    if not isinstance(draft_batches, list) or len(draft_batches) != len(source_batches):
        raise ValueError("Experience finalizer draft child count mismatch")
    for ordinal, (source_batch, raw_child) in enumerate(zip(source_batches, draft_batches)):
        child = _record(raw_child, f"Experience draft child {ordinal}")
        result = _record(child.get("result"), f"Experience draft child {ordinal} result")
        if child.get("ordinal") != ordinal or child.get("batchId") != source_batch["batchId"] \
            or child.get("exportHash") != source_batch["exportHash"] \
            or child.get("resultHash") != result.get("resultHash"):
            raise ValueError(f"Experience finalizer child {ordinal} binding mismatch")
        validate_result_against_export(result, source_batch["export"], repo_root)

    expected_reviews = [
        {**item, "decision": "approved"}
        for item in _experience_mismatches(source_batches, draft_batches)
    ]
    if canonical_json(review.get("evidence")) != canonical_json(source_batches[0]["export"]["evidence"]):
        raise ValueError("Experience semantic review evidence snapshot mismatch")
    if canonical_json(review.get("reviews")) != canonical_json(expected_reviews):
        raise ValueError("every exact Experience hard mismatch must be manually changed from pending to approved")

    expected: list[dict[str, str]] = []
    for child in draft.get("batches", []):
        entry = _record(child, "Experience draft child")
        batch_id = _uuid(entry.get("batchId"), "Experience draft child ID")
        result = _record(entry.get("result"), "Experience draft child result")
        for raw_item in result.get("results", []):
            item = _record(raw_item, "Experience result item")
            decision = _record(item.get("result"), "Experience result decision")
            if decision.get("kind") == "evaluation" and decision.get("decision") == "hard_requirement_mismatch":
                expected.append({
                    "batchId": batch_id,
                    "jobId": str(item.get("jobId")),
                    "resultHash": str(item.get("resultHash")),
                    "decision": "approved",
                })
    supplied = []
    for raw in review.get("reviews", []):
        item = _record(raw, "Experience semantic review item")
        supplied.append({
            "batchId": str(item.get("batchId")),
            "jobId": str(item.get("jobId")),
            "resultHash": str(item.get("resultHash")),
            "decision": str(item.get("decision")),
        })
    if supplied != expected:
        raise ValueError("Experience semantic review receipt mismatch")
    final = _final_payload(draft, _approved_semantic_review(run_id, supplied))
    _assert_run_exchange_size(final, "Experience scoring run result")
    project_path, delivery_path, receipt = _publish_result(
        result=final, output_dir=output_dir, delivery_dir=delivery_dir,
        stage="experience", run_id=run_id,
    )
    state["status"] = "completed"
    state["resultHash"] = final["resultHash"]
    state["resultPath"] = str(project_path.resolve())
    state["deliveryPath"] = str(delivery_path.resolve())
    _persist_state(state_path, state)
    return {
        "stage": "experience", "runId": run_id, "status": "completed",
        "validatorStatus": "valid", "reviewedMismatchCount": len(supplied),
        "projectOutputPath": str(project_path.resolve()),
        "desktopUploadPath": str(delivery_path.resolve()), "deliveryVerification": receipt,
    }
