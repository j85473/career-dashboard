from __future__ import annotations

import hashlib
import json
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from .common import atomic_write_json, file_sha256, load_json, utc_timestamp
from .cli import publish_desktop_upload_copy, verified_delivery_receipt
from .runner import run_aim


BACKLOG_RUN_SCHEMA = "career-dashboard-aim-backlog-run-v1"
MAX_BATCH_SIZE = 30
NONTERMINAL_BATCH_STATUSES = {"exported", "superseded"}


class DashboardApiError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def normalize_dashboard_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path not in {"", "/"}:
        raise ValueError("Dashboard URL must be an http(s) origin without a path")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


@dataclass(frozen=True)
class RawResponse:
    body: bytes
    headers: dict[str, str]


class DashboardClient:
    def __init__(self, dashboard_url: str, timeout_seconds: int = 120):
        self.base_url = normalize_dashboard_url(dashboard_url)
        self.timeout_seconds = timeout_seconds

    def _request(self, path: str, payload: dict[str, Any] | None = None) -> RawResponse:
        url = f"{self.base_url}{path}"
        data = None if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers = {"Accept": "application/json"}
        method = "GET"
        if payload is not None:
            method = "POST"
            headers.update({
                "Content-Type": "application/json",
                "Origin": self.base_url,
                "Sec-Fetch-Site": "same-origin",
            })
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return RawResponse(
                    body=response.read(),
                    headers={key.lower(): value for key, value in response.headers.items()},
                )
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                parsed = json.loads(raw.decode("utf-8"))
                message = parsed.get("error") if isinstance(parsed, dict) else None
            except (UnicodeError, json.JSONDecodeError):
                message = None
            raise DashboardApiError(error.code, str(message or error.reason or "Dashboard request failed")) from error
        except urllib.error.URLError as error:
            raise DashboardApiError(0, f"Dashboard connection failed: {error.reason}") from error

    def get_json(self, path: str) -> dict[str, Any]:
        response = self._request(path)
        try:
            value = json.loads(response.body.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise DashboardApiError(0, "Dashboard returned invalid UTF-8 JSON") from error
        if not isinstance(value, dict):
            raise DashboardApiError(0, "Dashboard JSON response must be an object")
        return value

    def post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = self._request(path, payload)
        try:
            value = json.loads(response.body.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise DashboardApiError(0, "Dashboard returned invalid UTF-8 JSON") from error
        if not isinstance(value, dict):
            raise DashboardApiError(0, "Dashboard JSON response must be an object")
        return value

    def aim_queue_count(self) -> int:
        response = self.get_json("/api/jobs?status=log&logTab=aim_fit&sort=aim_priority&page=1&limit=1")
        pagination = response.get("pagination")
        total = pagination.get("total") if isinstance(pagination, dict) else None
        if not isinstance(total, int) or isinstance(total, bool) or total < 0:
            raise DashboardApiError(0, "Dashboard Aim queue count is invalid")
        return total

    def active_aim_batches(self) -> list[dict[str, Any]]:
        response = self.get_json("/api/scoring/batches?stage=aim")
        batches = response.get("batches")
        if not isinstance(batches, list):
            raise DashboardApiError(0, "Dashboard batch response is invalid")
        return [
            batch for batch in batches
            if isinstance(batch, dict) and batch.get("status") in NONTERMINAL_BATCH_STATUSES
        ]

    def export_aim_batch(self, limit: int) -> RawResponse:
        return self._request("/api/scoring/export", {"stage": "aim", "limit": limit})

    def extend_batch(self, batch_id: str) -> dict[str, Any]:
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return self.post_json(f"/api/scoring/batches/{batch_id}/extend", {"expiresAt": expires_at})

    def preview_result(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.post_json("/api/scoring/import", {"mode": "preview", "payload": payload})

    def apply_result(self, payload: dict[str, Any], approval_token: str) -> dict[str, Any]:
        return self.post_json("/api/scoring/import", {
            "mode": "apply",
            "payload": payload,
            "approvalToken": approval_token,
        })


def sanitized_preview(response: dict[str, Any]) -> dict[str, Any]:
    preview = response.get("preview")
    if not isinstance(preview, dict):
        raise DashboardApiError(0, "Dashboard preview response is missing preview")
    token = response.get("approvalToken")
    if not isinstance(token, str) or not token:
        raise DashboardApiError(0, "Dashboard preview response is missing approval token")
    return {
        "preview": preview,
        "approvalExpiresAt": response.get("approvalExpiresAt"),
    }


def preview_summary(response: dict[str, Any]) -> dict[str, Any]:
    preview = response.get("preview")
    if not isinstance(preview, dict):
        raise DashboardApiError(0, "Dashboard preview response is missing preview")
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


def validate_preview_binding(
    response: dict[str, Any],
    *,
    batch_id: str,
    job_count: int,
    result_hash: str,
) -> None:
    preview = response.get("preview")
    if not isinstance(preview, dict):
        raise DashboardApiError(0, "Dashboard preview response is missing preview")
    expected = {
        "batchId": batch_id,
        "stage": "aim",
        "resultHash": result_hash,
        "applicable": True,
        "itemCount": job_count,
        "expectedCount": job_count,
        "suppliedCount": job_count,
    }
    for key, value in expected.items():
        if preview.get(key) != value:
            raise DashboardApiError(0, f"Dashboard preview has an unexpected {key}")
    accepted = preview.get("acceptedCount")
    safe_failures = preview.get("safeFailureCount")
    if not isinstance(accepted, int) or isinstance(accepted, bool) or not isinstance(safe_failures, int) or isinstance(safe_failures, bool):
        raise DashboardApiError(0, "Dashboard preview result counts are invalid")
    if accepted + safe_failures != job_count:
        raise DashboardApiError(0, "Dashboard preview does not account for every exact batch member")


def catastrophic_preview_reason(response: dict[str, Any], job_count: int) -> str | None:
    preview = response["preview"]
    accepted = preview["acceptedCount"]
    safe_failures = preview["safeFailureCount"]
    if accepted == 0:
        return "no applicable Aim results were produced"
    if safe_failures * 2 >= job_count:
        return f"{safe_failures} of {job_count} jobs became safe failures"
    return None


def result_artifact_receipt(path: Path) -> dict[str, Any]:
    result = load_json(path)
    batch = result.get("batch")
    batch_id = batch.get("id") if isinstance(batch, dict) else None
    result_hash = result.get("resultHash")
    if not isinstance(batch_id, str) or not isinstance(result_hash, str):
        raise ValueError("validated Aim result is missing batch or result identity")
    return {
        "verified": True,
        "path": str(path.resolve()),
        "bytes": path.stat().st_size,
        "sha256": file_sha256(path),
        "batchId": batch_id,
        "resultHash": result_hash,
        "jsonIdentityVerified": True,
    }


def new_run_state(run_id: str, dashboard_url: str, target_jobs: int, observed_queue: int) -> dict[str, Any]:
    return {
        "schemaVersion": BACKLOG_RUN_SCHEMA,
        "runId": run_id,
        "stage": "aim",
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


def validate_run_state(state: dict[str, Any], dashboard_url: str) -> None:
    if state.get("schemaVersion") != BACKLOG_RUN_SCHEMA or state.get("stage") != "aim":
        raise ValueError("backlog run state has an unsupported contract")
    if state.get("dashboardUrl") != dashboard_url:
        raise ValueError("backlog run is bound to a different Dashboard URL")
    if not isinstance(state.get("batches"), list):
        raise ValueError("backlog run batches are invalid")


def persist_state(path: Path, state: dict[str, Any]) -> None:
    state["updatedAt"] = utc_timestamp()
    atomic_write_json(path, state)


def current_batch(state: dict[str, Any]) -> dict[str, Any] | None:
    batches = state["batches"]
    if not batches:
        return None
    latest = batches[-1]
    return latest if latest.get("status") != "completed" else None


def ensure_active_batch_matches(client: DashboardClient, state: dict[str, Any]) -> None:
    active = client.active_aim_batches()
    expected = current_batch(state)
    if expected is None:
        if active:
            ids = ", ".join(str(batch.get("id")) for batch in active)
            raise RuntimeError(f"Aim already has a nonterminal batch ({ids}); resume or resolve it before backlog automation")
        return
    if len(active) != 1 or active[0].get("id") != expected.get("batchId"):
        ids = ", ".join(str(batch.get("id")) for batch in active) or "none"
        raise RuntimeError(f"backlog state expects batch {expected.get('batchId')} but Dashboard reports {ids}")


def save_export(response: RawResponse, destination: Path) -> dict[str, Any]:
    expected_hash = response.headers.get("x-scoring-export-sha256")
    actual_hash = hashlib.sha256(response.body).hexdigest()
    if not expected_hash or expected_hash != actual_hash:
        raise ValueError("Dashboard export SHA-256 header does not match the exact response bytes")
    atomic_write_bytes(destination, response.body)
    exported = load_json(destination)
    batch = exported.get("batch")
    jobs = exported.get("jobs")
    if not isinstance(batch, dict) or not isinstance(batch.get("id"), str) or not isinstance(jobs, list):
        raise ValueError("Dashboard Aim export is missing batch identity or jobs")
    return {
        "batchId": batch["id"],
        "jobCount": len(jobs),
        "exportPath": str(destination.resolve()),
        "exportBytes": len(response.body),
        "exportSha256": actual_hash,
    }


def run_backlog(
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
    input_function: Callable[[str], str] = input,
    output_function: Callable[[str], None] = print,
) -> tuple[Path, dict[str, Any]]:
    if interactive_apply and auto_apply:
        raise ValueError("interactive and automatic apply modes are mutually exclusive")
    runs_root = output_dir / "backlog-runs"
    try:
        selected_run_id = str(uuid.UUID(run_id)) if run_id else str(uuid.uuid4())
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("--run-id must be an exact UUID") from error
    run_root = runs_root / selected_run_id
    state_path = run_root / "run.json"
    if state_path.exists():
        state = load_json(state_path, integers_only=False)
        validate_run_state(state, client.base_url)
        if max_jobs is not None and max_jobs != state.get("targetJobs"):
            raise ValueError("--max-jobs cannot change an existing backlog run target")
    else:
        observed_queue = client.aim_queue_count()
        target_jobs = min(max_jobs, observed_queue) if max_jobs is not None else observed_queue
        if target_jobs < 1:
            state = new_run_state(selected_run_id, client.base_url, 0, observed_queue)
            state["status"] = "drained"
            persist_state(state_path, state)
            return state_path, state
        state = new_run_state(selected_run_id, client.base_url, target_jobs, observed_queue)
        persist_state(state_path, state)

    if auto_apply:
        state["autoApplyPolicy"] = {
            "enabled": True,
            "enabledAt": state.get("autoApplyPolicy", {}).get("enabledAt") or utc_timestamp(),
            "stopOnContractOrIdentityFailure": True,
            "minimumApplicableResults": 1,
            "stopWhenSafeFailuresReachHalf": True,
        }
        persist_state(state_path, state)

    try:
        while state["appliedJobs"] < state["targetJobs"]:
            ensure_active_batch_matches(client, state)
            batch_state = current_batch(state)
            if batch_state is None:
                remaining = state["targetJobs"] - state["appliedJobs"]
                limit = min(MAX_BATCH_SIZE, remaining)
                batch_ordinal = len(state["batches"]) + 1
                export_path = run_root / f"batch-{batch_ordinal:03d}-START-AIM-FIT.json"
                try:
                    export_receipt = save_export(client.export_aim_batch(limit), export_path)
                except DashboardApiError as error:
                    if error.status == 409 and "no Aim Ready" in str(error):
                        remaining_visible = client.aim_queue_count()
                        state["remainingVisibleJobs"] = remaining_visible
                        state["status"] = "drained" if remaining_visible == 0 else "blocked_nonexportable"
                        persist_state(state_path, state)
                        return state_path, state
                    raise
                batch_state = {
                    "ordinal": batch_ordinal,
                    "status": "exported",
                    **export_receipt,
                    "resultPath": None,
                    "resultArtifact": None,
                    "runnerCounts": None,
                    "preview": None,
                    "applyReceipt": None,
                }
                state["batches"].append(batch_state)
                persist_state(state_path, state)

            export_path = Path(batch_state["exportPath"])
            if batch_state["status"] == "exported":
                result_path, counts = run_aim(
                    export_path=export_path,
                    output_dir=output_dir,
                    repo_root=repo_root,
                    model=model,
                    effort=effort,
                )
                artifact = result_artifact_receipt(result_path)
                if artifact["batchId"] != batch_state["batchId"]:
                    raise ValueError("validated Aim result does not match the active backlog batch")
                delivery_path = publish_desktop_upload_copy("aim", result_path, delivery_dir)
                delivery = verified_delivery_receipt(result_path, delivery_path)
                batch_state.update({
                    "status": "scored",
                    "resultPath": str(result_path.resolve()),
                    "resultArtifact": artifact,
                    "deliveryVerification": delivery,
                    "runnerCounts": counts,
                })
                persist_state(state_path, state)

            result_payload = load_json(Path(batch_state["resultPath"]))
            preview_response = client.preview_result(result_payload)
            validate_preview_binding(
                preview_response,
                batch_id=batch_state["batchId"],
                job_count=batch_state["jobCount"],
                result_hash=batch_state["resultArtifact"]["resultHash"],
            )
            batch_state["status"] = "previewed"
            batch_state["preview"] = sanitized_preview(preview_response)
            state["status"] = "awaiting_approval"
            persist_state(state_path, state)
            summary = preview_summary(preview_response)
            output_function(json.dumps({
                "runId": state["runId"],
                "runStatePath": str(state_path.resolve()),
                "progress": {"applied": state["appliedJobs"], "target": state["targetJobs"]},
                "preview": summary,
                "resultArtifact": batch_state["resultArtifact"],
                "deliveryVerification": batch_state["deliveryVerification"],
            }, ensure_ascii=False, sort_keys=True))

            if auto_apply:
                catastrophic = catastrophic_preview_reason(preview_response, batch_state["jobCount"])
                if catastrophic:
                    batch_state["catastrophicStopReason"] = catastrophic
                    state["status"] = "halted_catastrophic_preview"
                    persist_state(state_path, state)
                    output_function(f"Stopped before import: {catastrophic}.")
                    return state_path, state
            elif not interactive_apply:
                return state_path, state
            else:
                confirmation = input_function(
                    f"Type APPLY {batch_state['batchId']} to import this exact validated preview, or press Enter to stop: "
                ).strip()
                if confirmation != f"APPLY {batch_state['batchId']}":
                    output_function("Stopped without importing the previewed Aim batch.")
                    return state_path, state

            approval_token = preview_response.get("approvalToken")
            if not isinstance(approval_token, str) or not approval_token:
                raise DashboardApiError(0, "Dashboard preview response is missing approval token")
            apply_receipt = client.apply_result(result_payload, approval_token)
            imported = apply_receipt.get("imported")
            released = apply_receipt.get("released")
            if apply_receipt.get("batchId") != batch_state["batchId"] \
                or not isinstance(imported, int) or isinstance(imported, bool) \
                or not isinstance(released, int) or isinstance(released, bool) \
                or imported + released != batch_state["jobCount"]:
                raise DashboardApiError(0, "Dashboard apply receipt does not account for the exact batch")
            batch_state["status"] = "completed"
            batch_state["applyReceipt"] = apply_receipt
            state["appliedJobs"] += batch_state["jobCount"]
            state["status"] = "running"
            persist_state(state_path, state)

        state["status"] = "completed"
        persist_state(state_path, state)
        return state_path, state
    except BaseException as error:
        state["lastError"] = {"at": utc_timestamp(), "type": type(error).__name__, "message": str(error)}
        state["status"] = "error"
        persist_state(state_path, state)
        raise


def exit_summary(state_path: Path, state: dict[str, Any]) -> str:
    batches = state.get("batches") if isinstance(state.get("batches"), list) else []
    decision_counts: dict[str, int] = {}
    safe_failures = 0
    for batch in batches:
        stored = batch.get("preview") if isinstance(batch, dict) else None
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
        "stage": "aim",
        "runId": state.get("runId"),
        "status": state.get("status"),
        "runStatePath": str(state_path.resolve()),
        "observedQueueAtStart": state.get("observedQueueAtStart"),
        "targetJobs": state.get("targetJobs"),
        "appliedJobs": state.get("appliedJobs"),
        "remainingVisibleJobs": state.get("remainingVisibleJobs"),
        "batchCount": len(batches),
        "safeFailures": safe_failures,
        "decisionCounts": decision_counts,
    }, ensure_ascii=False, sort_keys=True)
