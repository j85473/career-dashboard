from __future__ import annotations

import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Any, Callable

from .aim_backlog import (
    DashboardApiError,
    DashboardClient,
    MAX_BATCH_SIZE,
    atomic_write_bytes,
    result_artifact_receipt,
    sanitized_preview,
)
from .cli import publish_desktop_upload_copy, verified_delivery_receipt
from .common import atomic_write_json, load_json, utc_timestamp
from .runner import run_experience


BACKLOG_RUN_SCHEMA = "career-dashboard-experience-backlog-run-v1"
STAGE = "experience"

# The Core Evidence Inventory is exhaustive for Joe's qualifications and
# experience, so a mandatory qualification absent from it is genuinely not
# held. Hard-gate results that say so are the policy working as written, not a
# defect: this category is recorded for visibility and never blocks an import.
# See the EVIDENCE SAFETY rule in .agents/AGENTS.md and
# `hardGate.unknownIsMismatch` in data/scoring/experience-policy-v2.json.
INVENTORY_SILENCE_CATEGORY = "inventory_silence_mismatch"
# A mismatch resting on an excluded requirement kind is still a real defect:
# administrative eligibility and preferred qualifications are score-neutral by
# policy no matter how complete the inventory is. This category always blocks.
EXCLUDED_REQUIREMENT_CATEGORY = "excluded_requirement_kind"

_SILENCE_AS_MISMATCH_PATTERNS = (
    re.compile(r"\bno evidence\b", re.IGNORECASE),
    re.compile(
        r"\b(?:inventory|resume|evidence)\b.{0,50}\b"
        r"(?:does not|doesn't|did not|fails to)\b.{0,30}\b"
        r"(?:show|mention|demonstrate|document|establish|confirm|verify|indicate)",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:not|isn't|wasn't)\s+"
        r"(?:shown|mentioned|documented|established|confirmed|verified|indicated)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bcannot\s+(?:confirm|verify|establish|determine)\b", re.IGNORECASE),
    re.compile(r"\b(?:unknown|unclear|ambiguous)\b", re.IGNORECASE),
)
_EXCLUDED_REQUIREMENT_PATTERNS = (
    re.compile(
        r"\b(?:preferred|nice[- ]to[- ]have)\b"
        r"(?!(?:\s|,)*(?:but\s+)?not\s+(?:mandatory|required))",
        re.IGNORECASE,
    ),
    re.compile(r"\bwork authori[sz]ation\b", re.IGNORECASE),
    re.compile(r"\b(?:u\.?s\.?\s+)?citizenship\b", re.IGNORECASE),
    re.compile(r"\bnationality\b", re.IGNORECASE),
    re.compile(r"\b(?:background|drug) (?:check|screen)\b", re.IGNORECASE),
    re.compile(r"\bdriver'?s? licen[cs]e\b", re.IGNORECASE),
    re.compile(
        r"\b(?:(?:ability|willingness|required|available|availability)\s+to\s+travel"
        r"|travel\s+(?:required|requirements?|logistics?|up\s+to\s+\d+%))\b",
        re.IGNORECASE,
    ),
    re.compile(r"\brelocat(?:e|ion)\b", re.IGNORECASE),
    re.compile(
        r"\b(?:must\s+be\s+able\s+to|required\s+to|ability\s+to|able\s+to|"
        r"requires?[^.;:\n]{0,50}\bto\s+be\s+able\s+to)\s*"
        r"(?:lift|push|pull|carry|reach|stand|walk|conduct\s+overhead\s+work)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bgeneric physical (?:eligibility|requirements?|demands?)\b", re.IGNORECASE),
    re.compile(
        r"\b(?:excellent|exceptional|strong|superior)\s+"
        r"(?:presentation|communication|interpersonal)\s+skills?\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bcomfort(?:able)?\s+(?:working|communicating|presenting)\s+with\s+"
        r"(?:upper|senior|executive)\s+(?:management|leadership|leaders|stakeholders)\b",
        re.IGNORECASE,
    ),
)


def experience_queue_count(client: DashboardClient) -> int:
    return client.stage_queue_count(STAGE)


def active_experience_batches(client: DashboardClient) -> list[dict[str, Any]]:
    return client.active_batches(STAGE)


def save_experience_export(response: Any, destination: Path) -> dict[str, Any]:
    expected_hash = response.headers.get("x-scoring-export-sha256")
    actual_hash = hashlib.sha256(response.body).hexdigest()
    if not expected_hash or expected_hash != actual_hash:
        raise ValueError("Dashboard Experience export SHA-256 header does not match the exact response bytes")
    atomic_write_bytes(destination, response.body)
    exported = load_json(destination)
    batch = exported.get("batch")
    jobs = exported.get("jobs")
    if exported.get("schemaVersion") != "career-dashboard-experience-export-v2" \
        or not isinstance(batch, dict) or batch.get("stage") != STAGE \
        or not isinstance(batch.get("id"), str) or not isinstance(jobs, list):
        raise ValueError("Dashboard Experience export is missing its exact v2 stage, batch, or jobs")
    return {
        "batchId": batch["id"],
        "jobCount": len(jobs),
        "exportPath": str(destination.resolve()),
        "exportBytes": len(response.body),
        "exportSha256": actual_hash,
    }


def validate_experience_preview(
    response: dict[str, Any], *, batch_id: str, job_count: int, result_hash: str,
) -> None:
    preview = response.get("preview")
    if not isinstance(preview, dict):
        raise DashboardApiError(0, "Dashboard Experience preview response is missing preview")
    expected = {
        "batchId": batch_id,
        "stage": STAGE,
        "resultHash": result_hash,
        "applicable": True,
        "itemCount": job_count,
        "expectedCount": job_count,
        "suppliedCount": job_count,
    }
    for key, value in expected.items():
        if preview.get(key) != value:
            raise DashboardApiError(0, f"Dashboard Experience preview has an unexpected {key}")
    accepted = preview.get("acceptedCount")
    safe_failures = preview.get("safeFailureCount")
    if not isinstance(accepted, int) or isinstance(accepted, bool) \
        or not isinstance(safe_failures, int) or isinstance(safe_failures, bool):
        raise DashboardApiError(0, "Dashboard Experience preview counts are invalid")
    if accepted + safe_failures != job_count:
        raise DashboardApiError(0, "Dashboard Experience preview does not account for every exact batch member")


def experience_preview_summary(response: dict[str, Any]) -> dict[str, Any]:
    preview = response.get("preview")
    if not isinstance(preview, dict):
        raise DashboardApiError(0, "Dashboard Experience preview response is missing preview")
    return {
        "batchId": preview.get("batchId"),
        "itemCount": preview.get("itemCount"),
        "acceptedCount": preview.get("acceptedCount"),
        "safeFailureCount": preview.get("safeFailureCount"),
        "protectedLifecycleCount": preview.get("protectedLifecycleCount"),
        "scoreRange": preview.get("scoreRange"),
        "decisionCounts": preview.get("decisionCounts"),
        "approvalExpiresAt": response.get("approvalExpiresAt"),
    }


def catastrophic_experience_reason(response: dict[str, Any], job_count: int) -> str | None:
    preview = response["preview"]
    accepted = preview["acceptedCount"]
    safe_failures = preview["safeFailureCount"]
    if accepted == 0:
        return "no applicable Experience results were produced"
    if safe_failures * 2 >= job_count:
        return f"{safe_failures} of {job_count} jobs became safe failures"
    return None


def experience_semantic_flags(payload: dict[str, Any]) -> list[dict[str, str]]:
    results = payload.get("results")
    if not isinstance(results, list):
        raise ValueError("Experience result is missing results")
    flags: list[dict[str, str]] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        result = item.get("result")
        if not isinstance(result, dict) or result.get("kind") != "evaluation" \
            or result.get("decision") != "hard_requirement_mismatch":
            continue
        mismatches = result.get("hardRequirementsNotMet")
        if not isinstance(mismatches, list):
            continue
        for mismatch in mismatches:
            if not isinstance(mismatch, str):
                continue
            categories: list[str] = []
            if any(pattern.search(mismatch) for pattern in _SILENCE_AS_MISMATCH_PATTERNS):
                categories.append(INVENTORY_SILENCE_CATEGORY)
            if any(pattern.search(mismatch) for pattern in _EXCLUDED_REQUIREMENT_PATTERNS):
                categories.append(EXCLUDED_REQUIREMENT_CATEGORY)
            for category in categories:
                flags.append({
                    "jobId": str(item.get("jobId") or ""),
                    "category": category,
                    "detail": mismatch[:1000],
                })
    return flags


def blocking_experience_semantic_flags(flags: list[dict[str, str]]) -> list[dict[str, str]]:
    """
    Selects the flags that must stop an automatic import.

    Inventory silence is never one of them. The hard-gate prompt instructs the
    worker to treat an absent mandatory qualification as unmet, so blocking on
    that language would halt every batch for doing exactly what it was asked —
    a guard that prevents answers rather than preventing wrong answers. Only an
    excluded requirement kind, which no amount of inventory completeness can
    make into a legitimate hard mismatch, blocks.
    """
    return [flag for flag in flags if flag.get("category") != INVENTORY_SILENCE_CATEGORY]


def new_experience_run_state(
    run_id: str, dashboard_url: str, target_jobs: int, observed_queue: int,
) -> dict[str, Any]:
    return {
        "schemaVersion": BACKLOG_RUN_SCHEMA,
        "runId": run_id,
        "stage": STAGE,
        "dashboardUrl": dashboard_url,
        "createdAt": utc_timestamp(),
        "updatedAt": utc_timestamp(),
        "status": "running",
        "observedQueueAtStart": observed_queue,
        "targetJobs": target_jobs,
        "appliedJobs": 0,
        "batches": [],
        "lastError": None,
    }


def validate_experience_run_state(state: dict[str, Any], dashboard_url: str) -> None:
    if state.get("schemaVersion") != BACKLOG_RUN_SCHEMA or state.get("stage") != STAGE:
        raise ValueError("Experience backlog run state has an unsupported contract")
    if state.get("dashboardUrl") != dashboard_url:
        raise ValueError("Experience backlog run is bound to a different Dashboard URL")
    if not isinstance(state.get("batches"), list):
        raise ValueError("Experience backlog run batches are invalid")


def persist_experience_state(path: Path, state: dict[str, Any]) -> None:
    state["updatedAt"] = utc_timestamp()
    atomic_write_json(path, state)


def current_experience_batch(state: dict[str, Any]) -> dict[str, Any] | None:
    batches = state["batches"]
    if not batches:
        return None
    latest = batches[-1]
    return latest if latest.get("status") != "completed" else None


def ensure_experience_batch_matches(client: DashboardClient, state: dict[str, Any]) -> None:
    active = active_experience_batches(client)
    expected = current_experience_batch(state)
    if expected is None:
        if active:
            ids = ", ".join(str(batch.get("id")) for batch in active)
            raise RuntimeError(
                f"Experience already has a nonterminal batch ({ids}); resume or resolve it before backlog automation"
            )
        return
    if len(active) != 1 or active[0].get("id") != expected.get("batchId"):
        ids = ", ".join(str(batch.get("id")) for batch in active) or "none"
        raise RuntimeError(
            f"Experience backlog expects batch {expected.get('batchId')} but Dashboard reports {ids}"
        )


def run_experience_backlog(
    *,
    client: DashboardClient,
    repo_root: Path,
    output_dir: Path,
    delivery_dir: Path,
    run_id: str | None,
    max_jobs: int | None,
    interactive_apply: bool,
    auto_apply: bool,
    model: str | None,
    effort: str | None,
    max_batches_this_invocation: int | None,
    input_function: Callable[[str], str] = input,
    output_function: Callable[[str], None] = print,
) -> tuple[Path, dict[str, Any]]:
    if interactive_apply and auto_apply:
        raise ValueError("interactive and automatic apply modes are mutually exclusive")
    if max_batches_this_invocation is not None and max_batches_this_invocation < 1:
        raise ValueError("maximum batches this invocation must be at least one")
    completed_this_invocation = 0
    runs_root = output_dir / "backlog-runs"
    try:
        selected_run_id = str(uuid.UUID(run_id)) if run_id else str(uuid.uuid4())
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("--run-id must be an exact UUID") from error
    run_root = runs_root / selected_run_id
    state_path = run_root / "run.json"
    if state_path.exists():
        state = load_json(state_path, integers_only=False)
        validate_experience_run_state(state, client.base_url)
        if max_jobs is not None and max_jobs != state.get("targetJobs"):
            raise ValueError("--max-jobs cannot change an existing Experience backlog target")
    else:
        observed_queue = experience_queue_count(client)
        target_jobs = min(max_jobs, observed_queue) if max_jobs is not None else observed_queue
        if target_jobs < 1:
            state = new_experience_run_state(selected_run_id, client.base_url, 0, observed_queue)
            state["status"] = "drained"
            persist_experience_state(state_path, state)
            return state_path, state
        state = new_experience_run_state(selected_run_id, client.base_url, target_jobs, observed_queue)
        persist_experience_state(state_path, state)

    if auto_apply:
        state["autoApplyPolicy"] = {
            "enabled": True,
            "enabledAt": state.get("autoApplyPolicy", {}).get("enabledAt") or utc_timestamp(),
            "stopOnContractOrIdentityFailure": True,
            "minimumApplicableResults": 1,
            "stopWhenSafeFailuresReachHalf": True,
            "acceptMissingEvidenceAsMismatch": True,
            "stopOnExcludedRequirementKind": True,
        }
        persist_experience_state(state_path, state)

    try:
        while state["appliedJobs"] < state["targetJobs"]:
            ensure_experience_batch_matches(client, state)
            batch_state = current_experience_batch(state)
            if batch_state is None:
                remaining = state["targetJobs"] - state["appliedJobs"]
                limit = min(MAX_BATCH_SIZE, remaining)
                batch_ordinal = len(state["batches"]) + 1
                export_path = run_root / f"batch-{batch_ordinal:03d}-START-E-FIT.json"
                try:
                    export_receipt = save_experience_export(
                        client.export_batch(STAGE, limit), export_path,
                    )
                except DashboardApiError as error:
                    if error.status == 409 and "no Experience Ready" in str(error):
                        remaining_visible = experience_queue_count(client)
                        state["remainingVisibleJobs"] = remaining_visible
                        state["status"] = "drained" if remaining_visible == 0 else "blocked_nonexportable"
                        persist_experience_state(state_path, state)
                        return state_path, state
                    raise
                batch_state = {
                    "ordinal": batch_ordinal,
                    "status": "exported",
                    **export_receipt,
                    "resultPath": None,
                    "resultArtifact": None,
                    "runnerCounts": None,
                    "semanticFlags": [],
                    "preview": None,
                    "applyReceipt": None,
                }
                state["batches"].append(batch_state)
                persist_experience_state(state_path, state)

            export_path = Path(batch_state["exportPath"])
            if batch_state["status"] == "exported":
                result_path, counts = run_experience(
                    export_path=export_path,
                    output_dir=output_dir,
                    repo_root=repo_root,
                    model=model,
                    effort=effort,
                )
                artifact = result_artifact_receipt(result_path)
                if artifact["batchId"] != batch_state["batchId"]:
                    raise ValueError("validated Experience result does not match the active backlog batch")
                delivery_path = publish_desktop_upload_copy("experience", result_path, delivery_dir)
                delivery = verified_delivery_receipt(result_path, delivery_path)
                result_payload = load_json(result_path)
                semantic_flags = experience_semantic_flags(result_payload)
                batch_state.update({
                    "status": "scored",
                    "resultPath": str(result_path.resolve()),
                    "resultArtifact": artifact,
                    "deliveryVerification": delivery,
                    "runnerCounts": counts,
                    "semanticFlags": semantic_flags,
                })
                persist_experience_state(state_path, state)

            result_payload = load_json(Path(batch_state["resultPath"]))
            semantic_flags = experience_semantic_flags(result_payload)
            if batch_state.get("semanticFlags") != semantic_flags:
                batch_state["semanticFlags"] = semantic_flags
                persist_experience_state(state_path, state)
            preview_response = client.preview_result(result_payload)
            validate_experience_preview(
                preview_response,
                batch_id=batch_state["batchId"],
                job_count=batch_state["jobCount"],
                result_hash=batch_state["resultArtifact"]["resultHash"],
            )
            batch_state["status"] = "previewed"
            batch_state["preview"] = sanitized_preview(preview_response)
            state["status"] = "awaiting_approval"
            persist_experience_state(state_path, state)
            output_function(json.dumps({
                "runId": state["runId"],
                "runStatePath": str(state_path.resolve()),
                "progress": {"applied": state["appliedJobs"], "target": state["targetJobs"]},
                "preview": experience_preview_summary(preview_response),
                "semanticFlags": batch_state["semanticFlags"],
                "resultArtifact": batch_state["resultArtifact"],
                "deliveryVerification": batch_state["deliveryVerification"],
            }, ensure_ascii=False, sort_keys=True))

            if auto_apply:
                catastrophic = catastrophic_experience_reason(preview_response, batch_state["jobCount"])
                if catastrophic:
                    batch_state["catastrophicStopReason"] = catastrophic
                    state["status"] = "halted_catastrophic_preview"
                    persist_experience_state(state_path, state)
                    output_function(f"Stopped before Experience import: {catastrophic}.")
                    return state_path, state
                blocking_flags = blocking_experience_semantic_flags(batch_state["semanticFlags"])
                if blocking_flags:
                    batch_state["blockingSemanticFlags"] = blocking_flags
                    state["status"] = "halted_semantic_review"
                    persist_experience_state(state_path, state)
                    output_function(
                        "Stopped before Experience import: a hard mismatch rests on an excluded "
                        "requirement kind and requires review."
                    )
                    return state_path, state
            elif not interactive_apply:
                return state_path, state
            else:
                confirmation = input_function(
                    f"Type APPLY {batch_state['batchId']} to import this exact validated Experience preview, "
                    "or press Enter to stop: "
                ).strip()
                if confirmation != f"APPLY {batch_state['batchId']}":
                    output_function("Stopped without importing the previewed Experience batch.")
                    return state_path, state

            approval_token = preview_response.get("approvalToken")
            if not isinstance(approval_token, str) or not approval_token:
                raise DashboardApiError(0, "Dashboard Experience preview response is missing approval token")
            apply_receipt = client.apply_result(result_payload, approval_token)
            imported = apply_receipt.get("imported")
            released = apply_receipt.get("released")
            if apply_receipt.get("batchId") != batch_state["batchId"] \
                or not isinstance(imported, int) or isinstance(imported, bool) \
                or not isinstance(released, int) or isinstance(released, bool) \
                or imported + released != batch_state["jobCount"]:
                raise DashboardApiError(0, "Dashboard Experience apply receipt does not account for the exact batch")
            batch_state["status"] = "completed"
            batch_state["applyReceipt"] = apply_receipt
            # `appliedJobs` paces the loop, so it counts every job this run has
            # taken off the queue including safe failures — otherwise a batch
            # that mostly fails would be retried forever. It is not a measure of
            # progress: released jobs return to the queue unscored. `importedJobs`
            # is the honest count of scores actually written, and the gap between
            # the two is the first-pass clean rate worth watching.
            state["appliedJobs"] += batch_state["jobCount"]
            state["importedJobs"] = state.get("importedJobs", 0) + imported
            state["releasedJobs"] = state.get("releasedJobs", 0) + released
            state["status"] = "running"
            state.pop("remainingVisibleJobs", None)
            persist_experience_state(state_path, state)
            completed_this_invocation += 1
            if max_batches_this_invocation is not None \
                and completed_this_invocation >= max_batches_this_invocation:
                state["status"] = "paused"
                persist_experience_state(state_path, state)
                return state_path, state

        state["status"] = "completed"
        state["remainingVisibleJobs"] = experience_queue_count(client)
        persist_experience_state(state_path, state)
        return state_path, state
    except BaseException as error:
        state["lastError"] = {
            "at": utc_timestamp(), "type": type(error).__name__, "message": str(error),
        }
        state["status"] = "error"
        persist_experience_state(state_path, state)
        raise


def experience_exit_summary(state_path: Path, state: dict[str, Any]) -> str:
    batches = state.get("batches") if isinstance(state.get("batches"), list) else []
    decision_counts: dict[str, int] = {}
    safe_failures = 0
    semantic_flags = 0
    for batch in batches:
        if not isinstance(batch, dict):
            continue
        semantic_flags += len(batch.get("semanticFlags") or [])
        stored = batch.get("preview")
        preview = stored.get("preview") if isinstance(stored, dict) else None
        if not isinstance(preview, dict):
            continue
        safe = preview.get("safeFailureCount")
        if isinstance(safe, int) and not isinstance(safe, bool):
            safe_failures += safe
        decisions = preview.get("decisionCounts")
        if isinstance(decisions, dict):
            for key, value in decisions.items():
                if isinstance(value, int) and not isinstance(value, bool):
                    decision_counts[str(key)] = decision_counts.get(str(key), 0) + value
    return json.dumps({
        "stage": STAGE,
        "runId": state.get("runId"),
        "status": state.get("status"),
        "runStatePath": str(state_path.resolve()),
        "observedQueueAtStart": state.get("observedQueueAtStart"),
        "targetJobs": state.get("targetJobs"),
        "appliedJobs": state.get("appliedJobs"),
        "importedJobs": state.get("importedJobs", 0),
        "releasedJobs": state.get("releasedJobs", 0),
        "remainingVisibleJobs": state.get("remainingVisibleJobs"),
        "batchCount": len(batches),
        "safeFailures": safe_failures,
        "semanticFlags": semantic_flags,
        "decisionCounts": decision_counts,
    }, ensure_ascii=False, sort_keys=True)
