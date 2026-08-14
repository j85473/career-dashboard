from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from threading import BoundedSemaphore, Lock
from typing import Any, Callable, Iterable

from .aim_evidence import (
    assemble_factual_vector,
    parse_plain_factual_output,
    validate_factual_vector,
    validate_worker_response,
)
from .aim_identity import (
    builder_failure_resolution_identity,
    extraction_failure_resolution_identity,
    failure_retry_series_key,
    failure_suppression_key,
    packet_checkpoint_key,
    packet_input_hash,
    result_envelope_hash,
    result_item_hash,
    semantic_result_hash,
)
from .aim_registry import (
    AimAuthorities,
    InputContractLimitError,
    ModelContextLimitError,
    PhysicalPacket,
    load_aim_authorities,
    physical_plan_hash,
    plan_physical_packets,
    rendered_packet_sha256,
    stage1_logical_packet,
    validate_export_authority_bindings,
)
from .codex_worker import (
    WorkerInvocationError,
    assert_model_available,
    run_worker,
    selected_model_context_window,
)
from .common import (
    atomic_write_json,
    canonical_json,
    canonical_sha256,
    load_json,
    normalize_source_text,
    safe_task_component,
    utc_timestamp,
)
from .contracts import validate_export, validate_result_against_export


@dataclass(frozen=True)
class AimV2RunnerSettings:
    model: str
    attempt_efforts: tuple[str, ...]
    stage2_effort: str
    timeout_seconds: int
    maximum_output_bytes: int


@dataclass(frozen=True)
class PacketExhausted(RuntimeError):
    code: str
    packet: PhysicalPacket
    receipt: dict[str, Any]
    packet_plan_hash: str
    phase: str
    detail: str

    def __str__(self) -> str:
        return self.detail


@dataclass(frozen=True)
class HolisticStage2Exhausted(RuntimeError):
    code: str
    worker: dict[str, Any]
    detail: str

    def __str__(self) -> str:
        return self.detail


def load_aim_v2_settings(authorities: AimAuthorities, model: str | None, effort: str | None) -> AimV2RunnerSettings:
    protocol = authorities.runner_protocol
    if effort not in (None, "medium"):
        raise ValueError("Aim v2 uses one medium-effort invocation per factual unit")
    efforts = tuple(protocol["attemptEfforts"])
    if efforts != ("medium",):
        raise ValueError("Aim Stage 1 attempt efforts must contain one medium invocation")
    stage2_effort = protocol.get("stage2Effort")
    if stage2_effort != "high":
        raise ValueError("Aim Stage 2 must use one high-effort invocation")
    maximum_attempts = protocol["limits"]["maximumAttemptsPerPhysicalPacket"]
    if maximum_attempts != 1 or protocol["retry"].get("enabled") is not False:
        raise ValueError("Aim v2 retry authority must disable repeats and allow exactly one invocation")
    return AimV2RunnerSettings(
        model=model or protocol["defaultModel"],
        attempt_efforts=efforts,
        stage2_effort=stage2_effort,
        timeout_seconds=protocol["limits"]["invocationTimeoutSeconds"],
        maximum_output_bytes=protocol["contextPreflight"]["maximumSerializedOutputUtf8Bytes"],
    )


def _builder_input(
    job: dict[str, Any],
    batch: dict[str, Any],
    scope: str,
    purpose: str,
    vector: dict[str, Any] | None,
    holistic_assessment: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "schemaVersion": "aim-builder-input-v1",
        "purpose": purpose,
        "controllerScope": scope,
        "canonicalSource": {
            "originalJd": job["source"]["originalJd"],
            "sourceJdHash": job["source"]["sourceJdHash"],
        },
        "trustedMetadata": {
            **job["trustedMetadata"],
            "trustedMetadataHash": job["trustedMetadataHash"],
        },
        "factualVector": vector,
        "holisticAssessment": holistic_assessment,
        "authorityBindings": {
            key: batch[key]
            for key in (
                "questionRegistryVersion", "questionRegistryHash", "scoringPolicyVersion", "scoringPolicyHash",
                "resultBuilderSemanticVersion", "runnerProtocolVersion", "runnerProtocolHash",
                "anonymizationPolicyVersion", "anonymizationPolicyHash",
            )
        },
        "expectedExtractionIdentity": None if vector is None else job["extractionIdentity"],
    }


def invoke_result_builder(
    *,
    repo_root: Path,
    job: dict[str, Any],
    batch: dict[str, Any],
    scope: str,
    purpose: str,
    vector: dict[str, Any] | None,
    holistic_assessment: dict[str, Any] | None = None,
) -> dict[str, Any]:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required for the application-owned Aim result builder")
    value = _builder_input(job, batch, scope, purpose, vector, holistic_assessment)
    completed = subprocess.run(
        [node, "--import", "tsx", "scripts/build_aim_result.ts"],
        cwd=repo_root,
        input=canonical_json(value),
        capture_output=True,
        text=True,
        shell=False,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        raise ValueError(f"application-owned Aim result builder rejected {scope}")
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("application-owned Aim result builder emitted invalid JSON") from error
    if canonical_json(result) != completed.stdout:
        raise ValueError("application-owned Aim result builder output is not canonical JSON")
    return result


_AIM_SCORE_LINE = re.compile(r"^Aim Fit Score: (100|[0-9]{1,2})$")


def render_holistic_stage2_input(source: str, authorities: AimAuthorities) -> str:
    return "\n".join((
        authorities.stage2_prompt_bytes.decode("utf-8").rstrip(),
        "",
        "<complete-job-description>",
        source,
        "</complete-job-description>",
    ))


def parse_holistic_stage2_output(output: str) -> dict[str, Any]:
    normalized = output.replace("\r\n", "\n").replace("\r", "\n").strip()
    lines = normalized.split("\n")
    if not lines or not _AIM_SCORE_LINE.fullmatch(lines[0]):
        raise ValueError("Stage 2 output must start with exactly 'Aim Fit Score: <integer>'")
    score = int(lines[0].removeprefix("Aim Fit Score: "))
    rationale = "\n".join(lines[1:]).strip()
    if not rationale:
        raise ValueError("Stage 2 output must include a rationale after the score line")
    if len(rationale) > 4000:
        raise ValueError("Stage 2 rationale exceeds 4000 characters")
    return {"score": score, "rationale": rationale}


def _holistic_worker_receipt(
    *, receipt: dict[str, Any], manifest_hash: str, outcome: str, failure_category: str | None,
) -> dict[str, Any]:
    return {
        "packetOrdinal": 1,
        "packetPath": "1",
        "packetManifestHash": manifest_hash,
        "attemptOrdinal": 1,
        "effort": receipt["effort"],
        "startedAt": receipt["startedAt"],
        "completedAt": receipt["completedAt"],
        "outcome": outcome,
        "failureCategory": failure_category,
        "invocationReceipt": receipt["invocationReceipt"][:1000],
    }


def run_holistic_stage2(
    *, source: str, job: dict[str, Any], authorities: AimAuthorities, settings: AimV2RunnerSettings,
    codex_path: str, output_dir: Path, force_fresh_calibration: bool,
    calibration_run_id: str | None, model_semaphore: BoundedSemaphore | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    prompt = render_holistic_stage2_input(source, authorities)
    manifest_hash = canonical_sha256({
        "kind": "aim_stage2_holistic_unit_v1",
        "extractionIdentity": job["extractionIdentity"],
        "sourceJdHash": job["source"]["sourceJdHash"],
        "promptContractHash": authorities.prompt_contract_hash,
        "model": settings.model,
        "effort": settings.stage2_effort,
    })
    with tempfile.TemporaryDirectory(prefix="aim-stage2-") as temporary:
        try:
            invocation = lambda: run_worker(
                phase="aim_stage2", prompt_version="aim-stage2-holistic-v1", prompt=prompt,
                schema=None, task_dir=Path(temporary), model=settings.model,
                effort=settings.stage2_effort, timeout_seconds=settings.timeout_seconds,
                codex_path=codex_path, maximum_output_bytes=settings.maximum_output_bytes,
                memory_enabled=True,
            )
            if model_semaphore is None:
                run = invocation()
            else:
                with model_semaphore:
                    run = invocation()
        except WorkerInvocationError as error:
            category = "output_invalid" if "plain output" in str(error) else "invocation_failure"
            outcome = "output_invalid" if category == "output_invalid" else "invocation_failed"
            _record_holistic_model_output(
                output_dir=output_dir,
                extraction_id=job["extractionIdentity"],
                force_fresh_calibration=force_fresh_calibration,
                calibration_run_id=calibration_run_id,
                job=job,
                manifest_hash=manifest_hash,
                receipt=error.receipt,
                parsed_assessment=None,
                raw_output_text=error.raw_output,
                validator_status="not_run",
                failure_category=category,
                validator_detail=str(error),
            )
            worker = _holistic_worker_receipt(
                receipt=error.receipt, manifest_hash=manifest_hash,
                outcome=outcome, failure_category=category,
            )
            raise HolisticStage2Exhausted(
                code="packet_invalid" if category == "output_invalid" else "worker_invocation_failed",
                worker=worker,
                detail=str(error),
            ) from error
    try:
        if not isinstance(run.output, str):
            raise ValueError("Stage 2 worker did not return plain text")
        assessment = parse_holistic_stage2_output(run.output)
    except ValueError as error:
        _record_holistic_model_output(
            output_dir=output_dir,
            extraction_id=job["extractionIdentity"],
            force_fresh_calibration=force_fresh_calibration,
            calibration_run_id=calibration_run_id,
            job=job,
            manifest_hash=manifest_hash,
            receipt=run.receipt,
            parsed_assessment=None,
            raw_output_text=run.raw_output if run.raw_output is not None else run.output,
            validator_status="rejected",
            failure_category="output_invalid",
            validator_detail=str(error),
        )
        worker = _holistic_worker_receipt(
            receipt=run.receipt, manifest_hash=manifest_hash,
            outcome="output_invalid", failure_category="output_invalid",
        )
        raise HolisticStage2Exhausted(
            code="packet_invalid", worker=worker, detail=str(error),
        ) from error
    _record_holistic_model_output(
        output_dir=output_dir,
        extraction_id=job["extractionIdentity"],
        force_fresh_calibration=force_fresh_calibration,
        calibration_run_id=calibration_run_id,
        job=job,
        manifest_hash=manifest_hash,
        receipt=run.receipt,
        parsed_assessment=assessment,
        raw_output_text=run.raw_output if run.raw_output is not None else run.output,
        validator_status="accepted",
        failure_category=None,
        validator_detail=None,
    )
    return assessment, _holistic_worker_receipt(
        receipt=run.receipt, manifest_hash=manifest_hash,
        outcome="accepted", failure_category=None,
    )


def _attempt_receipt(
    receipt: dict[str, Any],
    attempt_ordinal: int,
    outcome: str,
    failure_category: str | None,
) -> dict[str, Any]:
    return {
        "attemptOrdinal": attempt_ordinal,
        "effort": receipt["effort"],
        "startedAt": receipt["startedAt"],
        "completedAt": receipt["completedAt"],
        "outcome": outcome,
        "failureCategory": failure_category,
        "invocationReceipt": receipt["invocationReceipt"][:1000],
    }


def _packet_receipt(
    packet: PhysicalPacket,
    packet_input: str,
    model: str,
    attempts: list[dict[str, Any]],
    accepted_attempt: int | None,
    reused: str | None,
) -> dict[str, Any]:
    return {
        "baseOrdinal": packet.base_ordinal,
        "physicalOrdinal": packet.physical_ordinal,
        "packetPath": packet.packet_path,
        "packetManifestHash": packet.packet_manifest_hash,
        "packetInputHash": packet_input,
        "model": model,
        "attempts": attempts,
        "acceptedAttempt": accepted_attempt,
        "reusedFromPacketManifestHash": reused,
    }


def _cache_root(
    output_dir: Path,
    extraction_id: str,
    force_fresh_calibration: bool,
    calibration_run_id: str | None,
) -> Path:
    if force_fresh_calibration:
        if not calibration_run_id:
            raise ValueError("force-fresh calibration requires a calibration run ID")
        return output_dir / ".calibration" / safe_task_component(calibration_run_id) / "units"
    return output_dir / ".cache" / "aim-v2" / extraction_id / "packets"


def _model_output_root(
    output_dir: Path,
    extraction_id: str,
    force_fresh_calibration: bool,
    calibration_run_id: str | None,
) -> Path:
    if force_fresh_calibration:
        if not calibration_run_id:
            raise ValueError("force-fresh calibration requires a calibration run ID")
        return output_dir / ".calibration" / safe_task_component(calibration_run_id) / "model-outputs"
    return output_dir / ".model-outputs" / "aim-v2" / extraction_id


def _record_model_output(
    *,
    output_dir: Path,
    extraction_id: str,
    force_fresh_calibration: bool,
    calibration_run_id: str | None,
    job: dict[str, Any],
    packet: PhysicalPacket,
    attempt_ordinal: int,
    receipt: dict[str, Any],
    parsed_response: dict[str, Any] | None,
    raw_output_text: str | None,
    validator_status: str,
    failure_category: str | None,
    validator_detail: str | None,
    normalized_response: dict[str, Any] | None,
) -> Path:
    numbered_answers: dict[int, dict[str, Any]] = {}
    if isinstance(parsed_response, dict) and isinstance(parsed_response.get("answers"), list):
        for answer in parsed_response["answers"]:
            if not isinstance(answer, dict):
                continue
            number = answer.get("number")
            if isinstance(number, int) and not isinstance(number, bool) and number not in numbered_answers:
                numbered_answers[number] = answer
    record = {
        "schemaVersion": "career-dashboard-aim-model-output-v1",
        "artifactPurpose": "calibration" if force_fresh_calibration else "production",
        "job": {
            "jobId": job["jobId"],
            "ordinal": job["ordinal"],
            "company": job["trustedMetadata"]["company"],
            "title": job["trustedMetadata"]["title"],
            "location": job["trustedMetadata"].get("location"),
        },
        "extractionIdentity": extraction_id,
        "unit": {
            "privatePhase": packet.private_phase,
            "baseOrdinal": packet.base_ordinal,
            "physicalOrdinal": packet.physical_ordinal,
            "packetPath": packet.packet_path,
            "packetManifestHash": packet.packet_manifest_hash,
        },
        "attempt": {
            "attemptOrdinal": attempt_ordinal,
            "model": receipt["model"],
            "effort": receipt["effort"],
            "startedAt": receipt["startedAt"],
            "completedAt": receipt["completedAt"],
            "invocationReceipt": receipt["invocationReceipt"][:1000],
        },
        "questionOutputs": [
            {
                "number": number,
                "questionId": question["id"],
                "question": question["wording"],
                "modelOutput": None if number not in numbered_answers else {
                    "answer": (
                        "present" if packet.private_phase == "stage2" and numbered_answers[number].get("answer") == "yes"
                        else "not found" if packet.private_phase == "stage2"
                        and numbered_answers[number].get("answer") == "unsupported"
                        else numbered_answers[number].get("answer")
                    ),
                    "supportingText": numbered_answers[number].get("supportingText", []),
                },
            }
            for number, question in enumerate(packet.ordered_questions, start=1)
        ],
        "rawResponse": None,
        "rawOutputText": raw_output_text,
        "parsedResponse": parsed_response,
        "validation": {
            "status": validator_status,
            "failureCategory": failure_category,
            "detail": None if validator_detail is None else validator_detail[:2000],
            "normalizedResponse": normalized_response,
        },
    }
    root = _model_output_root(
        output_dir, extraction_id, force_fresh_calibration, calibration_run_id
    )
    filename = (
        f"{job['ordinal']:02d}-{safe_task_component(job['jobId'])}-"
        f"unit-{packet.physical_ordinal:02d}-attempt-{attempt_ordinal}.json"
    )
    path = root / filename
    atomic_write_json(path, record)
    return path


def _record_holistic_model_output(
    *,
    output_dir: Path,
    extraction_id: str,
    force_fresh_calibration: bool,
    calibration_run_id: str | None,
    job: dict[str, Any],
    manifest_hash: str,
    receipt: dict[str, Any],
    parsed_assessment: dict[str, Any] | None,
    raw_output_text: str | None,
    validator_status: str,
    failure_category: str | None,
    validator_detail: str | None,
) -> Path:
    record = {
        "schemaVersion": "career-dashboard-aim-model-output-v1",
        "artifactPurpose": "calibration" if force_fresh_calibration else "production",
        "job": {
            "jobId": job["jobId"],
            "ordinal": job["ordinal"],
            "company": job["trustedMetadata"]["company"],
            "title": job["trustedMetadata"]["title"],
            "location": job["trustedMetadata"].get("location"),
        },
        "extractionIdentity": extraction_id,
        "unit": {
            "privatePhase": "holistic_stage2",
            "baseOrdinal": 1,
            "physicalOrdinal": 1,
            "packetPath": "1",
            "packetManifestHash": manifest_hash,
        },
        "attempt": {
            "attemptOrdinal": 1,
            "model": receipt["model"],
            "effort": receipt["effort"],
            "startedAt": receipt["startedAt"],
            "completedAt": receipt["completedAt"],
            "invocationReceipt": receipt["invocationReceipt"][:1000],
        },
        "questionOutputs": [],
        "rawResponse": None,
        "rawOutputText": raw_output_text,
        "parsedResponse": parsed_assessment,
        "validation": {
            "status": validator_status,
            "failureCategory": failure_category,
            "detail": None if validator_detail is None else validator_detail[:2000],
            "normalizedResponse": parsed_assessment if validator_status == "accepted" else None,
        },
    }
    root = _model_output_root(
        output_dir, extraction_id, force_fresh_calibration, calibration_run_id
    )
    filename = (
        f"{job['ordinal']:02d}-{safe_task_component(job['jobId'])}-"
        "unit-holistic-stage2-attempt-1.json"
    )
    path = root / filename
    atomic_write_json(path, record)
    return path


def _load_packet_cache(
    cache_root: Path,
    checkpoint_key: str,
    extraction_id: str,
    packet: PhysicalPacket,
    packet_input: str,
    source: str,
    metadata: dict[str, Any],
    authorities: AimAuthorities,
    allow_search: bool,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    exact_path = cache_root / f"{checkpoint_key}.json"
    candidates = [exact_path]
    if allow_search and cache_root.exists():
        candidates.extend(path for path in sorted(cache_root.glob("*.json")) if path not in candidates)
    for path in candidates:
        if not path.exists():
            continue
        try:
            cached = load_json(path)
        except (OSError, ValueError):
            _quarantine_checkpoint_path(path)
            continue
        if cached.get("schemaVersion") != "aim-packet-checkpoint-v2":
            _quarantine_checkpoint_path(path)
            continue
        if cached.get("packetManifestHash") != packet.packet_manifest_hash:
            if path == exact_path:
                _quarantine_checkpoint_path(path)
            continue
        try:
            if cached.get("extractionIdentity") != extraction_id:
                raise ValueError("cached extraction identity mismatch")
            if cached.get("packetInputHash") != packet_input:
                raise ValueError("cached packet input mismatch")
            if cached.get("questionIds") != [question["id"] for question in packet.ordered_questions]:
                raise ValueError("cached question membership mismatch")
            if not isinstance(cached.get("packetPlanHash"), str):
                raise ValueError("cached packet plan is missing")
            model = cached.get("model")
            if not isinstance(model, str) or not model:
                raise ValueError("cached model provenance is missing")
            historical = cached.get("receipt")
            if not isinstance(historical, dict):
                raise ValueError("cached worker receipt is missing")
            expected_receipt = {
                "baseOrdinal": packet.base_ordinal,
                "physicalOrdinal": packet.physical_ordinal,
                "packetPath": packet.packet_path,
                "packetManifestHash": packet.packet_manifest_hash,
                "packetInputHash": packet_input,
                "model": model,
            }
            if any(historical.get(key) != value for key, value in expected_receipt.items()):
                raise ValueError("cached worker receipt binding mismatch")
            attempts = historical.get("attempts")
            if not isinstance(attempts, list) or len(attempts) != 1:
                raise ValueError("cached worker receipt attempt count is invalid")
            for index, attempt in enumerate(attempts, start=1):
                if not isinstance(attempt, dict) or attempt.get("attemptOrdinal") != index:
                    raise ValueError("cached worker attempt order is invalid")
                expected_effort = authorities.runner_protocol["attemptEfforts"][index - 1]
                if attempt.get("effort") != expected_effort:
                    raise ValueError("cached worker effort order is invalid")
                outcome = attempt.get("outcome")
                failure_category = attempt.get("failureCategory")
                expected_category = {
                    "accepted": None,
                    "invocation_failed": "invocation_failure",
                    "output_invalid": "output_invalid",
                    "evidence_invalid": "evidence_invalidity",
                }.get(outcome, object())
                if failure_category != expected_category:
                    raise ValueError("cached worker outcome/category is invalid")
                if not all(isinstance(attempt.get(field), str) and attempt[field] for field in (
                    "startedAt", "completedAt", "invocationReceipt",
                )):
                    raise ValueError("cached worker attempt provenance is incomplete")
            if attempts[-1].get("outcome") != "accepted":
                raise ValueError("cached worker receipt is not accepted")
            if historical.get("acceptedAttempt") != len(attempts) or historical.get("reusedFromPacketManifestHash") is not None:
                raise ValueError("cached accepted-attempt provenance is invalid")
            parsed = parse_plain_factual_output(
                cached["rawOutputText"], packet, source, metadata
            )
            if canonical_json(parsed) != canonical_json(cached["parsedResponse"]):
                raise ValueError("cached plain-output parse mismatch")
            normalized = validate_worker_response(parsed, packet, source, metadata, authorities)
            if canonical_json(normalized) != canonical_json(cached["normalized"]):
                raise ValueError("cached normalized response mismatch")
            receipt = _packet_receipt(
                packet, packet_input, model, [], None, packet.packet_manifest_hash
            )
            return normalized, receipt
        except (ValueError, KeyError, TypeError):
            _quarantine_checkpoint_path(path)
            continue
    return None


def _quarantine_checkpoint_path(path: Path) -> None:
    try:
        digest = sha256(path.read_bytes()).hexdigest()[:16]
        quarantine = path.parent / "quarantine"
        quarantine.mkdir(parents=True, exist_ok=True)
        destination = quarantine / f"{path.stem}-{digest}.json"
        counter = 1
        while destination.exists():
            destination = quarantine / f"{path.stem}-{digest}-{counter}.json"
            counter += 1
        path.rename(destination)
    except OSError:
        # A concurrently consumed or unwritable tentative cache entry simply
        # remains unavailable; it is never accepted into a factual vector.
        return


def _run_physical_packet(
    *,
    packet: PhysicalPacket,
    packet_plan: str,
    extraction_id: str,
    job: dict[str, Any],
    source: str,
    metadata: dict[str, Any],
    authorities: AimAuthorities,
    settings: AimV2RunnerSettings,
    codex_path: str,
    output_dir: Path,
    force_fresh_calibration: bool,
    calibration_run_id: str | None,
    worker_runner: Callable[..., Any] | None = None,
    model_semaphore: BoundedSemaphore | None = None,
) -> tuple[dict[str, Any], dict[str, Any], int]:
    rendered_hash = rendered_packet_sha256(packet)
    schema_hash = canonical_sha256(packet.response_schema)
    packet_input = packet_input_hash(extraction_id, packet.packet_manifest_hash, rendered_hash, schema_hash)
    checkpoint_key = packet_checkpoint_key(extraction_id, packet_plan, packet.packet_manifest_hash)
    cache_root = _cache_root(output_dir, extraction_id, force_fresh_calibration, calibration_run_id)
    if not force_fresh_calibration:
        cached = _load_packet_cache(
            cache_root, checkpoint_key, extraction_id, packet, packet_input, source, metadata, authorities,
            allow_search=True,
        )
        if cached is not None:
            value, receipt = cached
            return value, receipt, 0

    attempts: list[dict[str, Any]] = []
    last_category = "invocation_failure"
    invoke = worker_runner or run_worker
    for attempt_ordinal, effort in enumerate(settings.attempt_efforts, start=1):
        with tempfile.TemporaryDirectory(prefix="unit-") as temporary:
            try:
                if model_semaphore is None:
                    run = invoke(
                        phase="unit", prompt_version="factual-instruction-v2", prompt=packet.rendered_input,
                        schema=None, task_dir=Path(temporary), model=settings.model,
                        effort=effort, timeout_seconds=settings.timeout_seconds, codex_path=codex_path,
                        maximum_output_bytes=settings.maximum_output_bytes,
                    )
                else:
                    with model_semaphore:
                        run = invoke(
                            phase="unit", prompt_version="factual-instruction-v2", prompt=packet.rendered_input,
                            schema=None, task_dir=Path(temporary), model=settings.model,
                            effort=effort, timeout_seconds=settings.timeout_seconds, codex_path=codex_path,
                            maximum_output_bytes=settings.maximum_output_bytes,
                        )
            except WorkerInvocationError as error:
                last_category = "output_invalid" if "plain output" in str(error) else "invocation_failure"
                outcome = "output_invalid" if last_category == "output_invalid" else "invocation_failed"
                attempts.append(_attempt_receipt(error.receipt, attempt_ordinal, outcome, last_category))
                _record_model_output(
                    output_dir=output_dir,
                    extraction_id=extraction_id,
                    force_fresh_calibration=force_fresh_calibration,
                    calibration_run_id=calibration_run_id,
                    job=job,
                    packet=packet,
                    attempt_ordinal=attempt_ordinal,
                    receipt=error.receipt,
                    parsed_response=None,
                    raw_output_text=error.raw_output,
                    validator_status="not_run",
                    failure_category=last_category,
                    validator_detail=str(error),
                    normalized_response=None,
                )
                continue
            parsed_output: dict[str, Any] | None = None
            try:
                if not isinstance(run.output, str):
                    raise ValueError("worker did not return plain text")
                parsed_output = parse_plain_factual_output(run.output, packet, source, metadata)
                normalized = validate_worker_response(
                    parsed_output,
                    packet,
                    source,
                    metadata,
                    authorities,
                    downgrade_invalid_affirmatives=True,
                )
            except ValueError as error:
                last_category = "evidence_invalidity"
                attempts.append(_attempt_receipt(run.receipt, attempt_ordinal, "evidence_invalid", last_category))
                _record_model_output(
                    output_dir=output_dir,
                    extraction_id=extraction_id,
                    force_fresh_calibration=force_fresh_calibration,
                    calibration_run_id=calibration_run_id,
                    job=job,
                    packet=packet,
                    attempt_ordinal=attempt_ordinal,
                    receipt=run.receipt,
                    parsed_response=parsed_output,
                    raw_output_text=run.raw_output,
                    validator_status="rejected",
                    failure_category=last_category,
                    validator_detail=str(error),
                    normalized_response=None,
                )
                continue
            attempts.append(_attempt_receipt(run.receipt, attempt_ordinal, "accepted", None))
            _record_model_output(
                output_dir=output_dir,
                extraction_id=extraction_id,
                force_fresh_calibration=force_fresh_calibration,
                calibration_run_id=calibration_run_id,
                job=job,
                packet=packet,
                attempt_ordinal=attempt_ordinal,
                receipt=run.receipt,
                    parsed_response=parsed_output,
                raw_output_text=run.raw_output,
                validator_status="accepted",
                failure_category=None,
                validator_detail=None,
                normalized_response=normalized,
            )
            receipt = _packet_receipt(
                packet, packet_input, settings.model, attempts, attempt_ordinal, None
            )
            cache_root.mkdir(parents=True, exist_ok=True)
            atomic_write_json(cache_root / f"{checkpoint_key}.json", {
                "schemaVersion": "aim-packet-checkpoint-v2",
                "extractionIdentity": extraction_id,
                "packetPlanHash": packet_plan,
                "packetManifestHash": packet.packet_manifest_hash,
                "packetInputHash": packet_input,
                "questionIds": [question["id"] for question in packet.ordered_questions],
                "model": settings.model,
                "rawOutputText": run.raw_output if run.raw_output is not None else run.output,
                "parsedResponse": parsed_output,
                "normalized": normalized,
                "receipt": receipt,
            })
            return normalized, receipt, len(attempts)
    code = "evidence_invalid" if last_category == "evidence_invalidity" else "packet_invalid" if last_category == "output_invalid" else "worker_invocation_failed"
    receipt = _packet_receipt(packet, packet_input, settings.model, attempts, None, None)
    raise PacketExhausted(
        code=code,
        packet=packet,
        receipt=receipt,
        packet_plan_hash=packet_plan,
        phase="complete_extraction",
        detail="The factual unit did not produce a valid evidence-bound response in its single isolated invocation.",
    )


def _flatten_workers(receipts: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    workers: list[dict[str, Any]] = []
    for receipt in receipts:
        for attempt in receipt["attempts"]:
            workers.append({
                "packetOrdinal": receipt["physicalOrdinal"],
                "packetPath": receipt["packetPath"],
                "packetManifestHash": receipt["packetManifestHash"],
                **attempt,
            })
    return workers


def _vector_as_packet_value(vector: dict[str, Any]) -> dict[str, Any]:
    return {
        "answers": vector["answers"],
        "evidenceCatalog": vector["evidenceCatalog"],
    }


def _dashboard_reuse_receipts(vector: dict[str, Any]) -> list[dict[str, Any]]:
    """Project accepted historical provenance into zero-call receipts for this run.

    Prior invocation attempts remain immutable inside the stored extraction vector. They
    are not invocations made by this result envelope and therefore must not appear in the
    current item's workers list or controller call total.
    """
    projected: list[dict[str, Any]] = []
    for receipt in vector["provenance"]["packets"]:
        manifest_hash = receipt["packetManifestHash"]
        projected.append({
            **receipt,
            "attempts": [],
            "acceptedAttempt": None,
            "reusedFromPacketManifestHash": manifest_hash,
        })
    return projected


def _terminal_item(
    job: dict[str, Any],
    result: dict[str, Any],
    workers: list[dict[str, Any]],
    packet_plan: str | None,
) -> dict[str, Any]:
    vector = result.get("factualVector")
    extraction_id = vector["extractionIdentity"] if isinstance(vector, dict) else None
    semantic_hash = semantic_result_hash(result, extraction_id)
    without_hash = {
        "jobId": job["jobId"],
        "ordinal": job["ordinal"],
        "inputHash": job["inputHash"],
        "sourceJdHash": job["source"]["sourceJdHash"],
        "trustedMetadataHash": job["trustedMetadataHash"],
        "extractionIdentity": extraction_id,
        "packetPlanHash": packet_plan,
        "workers": workers,
        "result": result,
        "semanticResultHash": semantic_hash,
    }
    return {**without_hash, "resultHash": result_item_hash(without_hash)}


def _safe_failure_result(
    *,
    job: dict[str, Any],
    batch: dict[str, Any],
    code: str,
    phase: str,
    packet_ordinal: int | None,
    attempts: int,
    detail: str,
) -> dict[str, Any]:
    permanence = "input_bound" if code in {
        "source_unusable", "input_contract_limit_exceeded",
        "model_context_limit_exceeded", "extraction_identity_vector_conflict",
    } else "transient"
    if code == "extraction_identity_vector_conflict":
        resolution = builder_failure_resolution_identity(
            job["inputHash"], job["extractionIdentity"], batch["scoringPolicyHash"],
            batch["resultBuilderSemanticVersion"], batch["runnerProtocolHash"],
        )
    else:
        resolution = extraction_failure_resolution_identity(
            job["inputHash"], job["extractionIdentity"], batch["runnerProtocolHash"]
        )
    retry_key = failure_retry_series_key(job["jobId"], resolution, code)
    suppression_key = failure_suppression_key(retry_key, permanence)
    return {
        "variant": "safe_failure",
        "code": code,
        "phase": phase,
        "packetOrdinal": packet_ordinal,
        "attempts": attempts,
        "permanence": permanence,
        "retrySeriesKey": retry_key,
        "suppressionKey": suppression_key,
        "detail": detail[:2000],
    }


def _safe_failure_item(
    job: dict[str, Any],
    result: dict[str, Any],
    workers: list[dict[str, Any]],
    packet_plan: str | None,
) -> dict[str, Any]:
    without_hash = {
        "jobId": job["jobId"],
        "ordinal": job["ordinal"],
        "inputHash": job["inputHash"],
        "sourceJdHash": job["source"]["sourceJdHash"],
        "trustedMetadataHash": job["trustedMetadataHash"],
        "extractionIdentity": None,
        "packetPlanHash": packet_plan,
        "workers": workers,
        "result": result,
        "semanticResultHash": None,
    }
    return {**without_hash, "resultHash": result_item_hash(without_hash)}


def _bounded_terminal_item(
    *,
    job: dict[str, Any],
    batch: dict[str, Any],
    result: dict[str, Any],
    workers: list[dict[str, Any]],
    packet_plan: str | None,
    authorities: AimAuthorities,
) -> dict[str, Any]:
    item = _terminal_item(job, result, workers, packet_plan)
    maximum = authorities.runner_protocol["limits"]["maximumSerializedResultBytesPerJob"]
    if len(canonical_json(item).encode("utf-8")) <= maximum:
        return item
    failure = _safe_failure_result(
        job=job,
        batch=batch,
        code="input_contract_limit_exceeded",
        phase="result_builder",
        packet_ordinal=None,
        attempts=0,
        detail="The complete evidence-bound result exceeds the versioned per-job result-size contract.",
    )
    bounded = _safe_failure_item(job, failure, workers, packet_plan)
    if len(canonical_json(bounded).encode("utf-8")) > maximum:
        raise InputContractLimitError("Aim v2 safe-failure item exceeds the per-job result-size contract")
    return bounded


def _run_packet_group(
    *,
    packets: list[PhysicalPacket],
    all_receipts: list[dict[str, Any]],
    worker_receipts: list[dict[str, Any]],
    all_values: list[dict[str, Any]],
    source: str,
    metadata: dict[str, Any],
    job: dict[str, Any],
    authorities: AimAuthorities,
    settings: AimV2RunnerSettings,
    codex_path: str,
    output_dir: Path,
    force_fresh_calibration: bool,
    calibration_run_id: str | None,
    failure_phase: str,
    model_semaphore: BoundedSemaphore | None = None,
) -> tuple[str, int]:
    plan = physical_plan_hash_from_receipts_and_packets(all_receipts, packets)
    calls = 0
    per_job_limit = authorities.runner_protocol["concurrency"]["perJobModelCalls"]
    if not isinstance(per_job_limit, int) or isinstance(per_job_limit, bool) or per_job_limit != 2:
        raise ValueError("Aim v2 per-job model concurrency authority must equal two")

    # Execute in bounded waves so a failure cannot dispatch later packets after the
    # current at-most-two in-flight units have settled.
    for start in range(0, len(packets), per_job_limit):
        wave = packets[start:start + per_job_limit]
        outcomes: list[tuple[dict[str, Any], dict[str, Any], int] | PacketExhausted] = []
        with ThreadPoolExecutor(max_workers=per_job_limit, thread_name_prefix="aim-v2-unit") as executor:
            futures: list[Future[tuple[dict[str, Any], dict[str, Any], int]]] = [
                executor.submit(
                    _run_physical_packet,
                    packet=packet,
                    packet_plan=plan,
                    extraction_id=job["extractionIdentity"],
                    job=job,
                    source=source,
                    metadata=metadata,
                    authorities=authorities,
                    settings=settings,
                    codex_path=codex_path,
                    output_dir=output_dir,
                    force_fresh_calibration=force_fresh_calibration,
                    calibration_run_id=calibration_run_id,
                    model_semaphore=model_semaphore,
                )
                for packet in wave
            ]
            for future in futures:
                try:
                    outcomes.append(future.result())
                except PacketExhausted as error:
                    outcomes.append(PacketExhausted(
                        code=error.code,
                        packet=error.packet,
                        receipt=error.receipt,
                        packet_plan_hash=plan,
                        phase=failure_phase,
                        detail=error.detail,
                    ))

        exhausted: PacketExhausted | None = None
        for outcome in outcomes:
            if isinstance(outcome, PacketExhausted):
                all_receipts.append(outcome.receipt)
                worker_receipts.append(outcome.receipt)
                calls += len(outcome.receipt["attempts"])
                exhausted = exhausted or outcome
                continue
            value, receipt, packet_calls = outcome
            all_values.append(value)
            all_receipts.append(receipt)
            # A validated local checkpoint is represented by an explicit reuse
            # receipt in factual-vector provenance, but it is not a model call
            # made by this result envelope and cannot enter workers/counts.
            if packet_calls > 0:
                worker_receipts.append(receipt)
            calls += packet_calls
        if exhausted is not None:
            raise exhausted
    return plan, calls


def physical_plan_hash_from_receipts_and_packets(
    existing_receipts: Iterable[dict[str, Any]], packets: Iterable[PhysicalPacket]
) -> str:
    hashes = [receipt["packetManifestHash"] for receipt in existing_receipts]
    hashes.extend(packet.packet_manifest_hash for packet in packets)
    from .aim_identity import packet_plan_hash
    return packet_plan_hash(hashes)


def _batch_echo(batch: dict[str, Any]) -> dict[str, Any]:
    return {
        key: batch[key]
        for key in (
            "id", "stage", "protocolVersion", "exportSchemaVersion", "manifestHash",
            "questionRegistryVersion", "questionRegistryHash", "scoringPolicyVersion", "scoringPolicyHash",
            "resultBuilderSemanticVersion", "promptContractVersion", "promptContractHash",
            "responseContractVersion", "responseContractHash", "runnerProtocolVersion", "runnerProtocolHash",
            "packetStrategyVersion", "packetStrategyHash", "canonicalizationVersion",
            "anonymizationPolicyVersion", "anonymizationPolicyHash", "extractorSemanticVersion",
        )
    } | {"resultSchemaVersion": "career-dashboard-aim-result-v2"}


def run_aim_v2(
    *,
    export_path: Path,
    output_dir: Path,
    repo_root: Path,
    model: str | None = None,
    effort: str | None = None,
    force_fresh_calibration: bool = False,
    calibration_run_id: str | None = None,
) -> tuple[Path, dict[str, int]]:
    exported = load_json(export_path)
    if exported.get("schemaVersion") != "career-dashboard-aim-export-v2":
        raise ValueError("new Aim scoring accepts only career-dashboard-aim-export-v2")
    validate_export(exported, repo_root, "aim")
    authorities = load_aim_authorities(repo_root)
    validate_export_authority_bindings(exported["batch"], authorities)
    settings = load_aim_v2_settings(authorities, model, effort)
    batch = exported["batch"]
    batch_id = safe_task_component(batch["id"])
    task_root = output_dir / ".tasks" / batch_id / "aim-v2"
    task_root.mkdir(parents=True, exist_ok=True)
    started_at = utc_timestamp()
    results: list[dict[str, Any]] = []
    counts = {"submitted": len(exported["jobs"]), "accepted": 0, "resumed": 0, "safeFailures": 0, "modelCalls": 0}
    codex_path: str | None = None
    context_window: int | None = None
    global_model_limit = authorities.runner_protocol["concurrency"]["globalModelCalls"]
    if not isinstance(global_model_limit, int) or isinstance(global_model_limit, bool) or global_model_limit != 4:
        raise ValueError("Aim v2 global model concurrency authority must equal four")
    model_semaphore = BoundedSemaphore(global_model_limit)
    model_catalog_lock = Lock()

    def ensure_model() -> tuple[str, int]:
        nonlocal codex_path, context_window
        with model_catalog_lock:
            if codex_path is None:
                codex_path = assert_model_available(settings.model, "medium")
                assert_model_available(settings.model, settings.stage2_effort, codex_path)
                context_window = selected_model_context_window(settings.model, codex_path)
        return codex_path, context_window  # type: ignore[return-value]

    def process_job(job: dict[str, Any]) -> tuple[dict[str, Any], int]:
        resumed_count = 0
        source = job["source"]["originalJd"]
        metadata = job["trustedMetadata"]
        all_values: list[dict[str, Any]] = []
        all_receipts: list[dict[str, Any]] = []
        worker_receipts: list[dict[str, Any]] = []
        packet_plan: str | None = None
        try:
            local = invoke_result_builder(
                repo_root=repo_root, job=job, batch=batch,
                scope="local_policy", purpose="checkpoint", vector=None,
            )
            if local["variant"] == "local_policy_kill":
                return _bounded_terminal_item(
                    job=job, batch=batch, result=local, workers=[], packet_plan=None, authorities=authorities,
                ), resumed_count
            if local["variant"] != "continue_to_stage1":
                raise ValueError("unexpected local-policy builder state")

            if source != normalize_source_text(source) or not source.strip():
                failure = _safe_failure_result(
                    job=job, batch=batch, code="source_unusable", phase="model_input_preflight",
                    packet_ordinal=None, attempts=0, detail="The supplied material is empty or cannot be represented by the canonical text contract.",
                )
                return _safe_failure_item(job, failure, [], None), resumed_count
            reuse = job.get("reuse")
            if reuse is not None:
                vector = validate_factual_vector(reuse["factualVector"], source, metadata, authorities, batch)
                if (
                    reuse["scope"] != vector["scope"]
                    or reuse["extractionIdentity"] != job["extractionIdentity"]
                    or reuse["factualVectorHash"] != vector["factualVectorHash"]
                ):
                    raise RuntimeError("dashboard reuse identity/vector conflict")
                all_values.append(_vector_as_packet_value(vector))
                all_receipts.extend(_dashboard_reuse_receipts(vector))
                resumed_count = 1
                if vector["scope"] != "stage1":
                    raise RuntimeError("dashboard reuse identity/vector conflict")
                checkpoint = invoke_result_builder(
                    repo_root=repo_root, job=job, batch=batch,
                    scope="stage1", purpose="checkpoint", vector=vector,
                )
                if checkpoint["variant"] != "continue_to_complete":
                    return _bounded_terminal_item(
                        job=job,
                        batch=batch,
                        result=checkpoint,
                        workers=[],
                        packet_plan=vector["provenance"]["packetPlanHash"],
                        authorities=authorities,
                    ), resumed_count
                current_scope = vector["scope"]
            else:
                current_scope = "local_policy"

            resolved_codex, resolved_context = ensure_model()
            next_physical = max((receipt["physicalOrdinal"] for receipt in all_receipts), default=-1) + 1
            if current_scope == "local_policy":
                stage1_packets = plan_physical_packets(
                    [stage1_logical_packet(authorities)], source, metadata, resolved_context, authorities, next_physical
                )
                packet_plan, calls = _run_packet_group(
                    packets=stage1_packets, all_receipts=all_receipts, worker_receipts=worker_receipts,
                    all_values=all_values,
                    source=source, metadata=metadata, job=job, authorities=authorities, settings=settings,
                    codex_path=resolved_codex, output_dir=output_dir,
                    force_fresh_calibration=force_fresh_calibration, calibration_run_id=calibration_run_id,
                    failure_phase="stage1",
                    model_semaphore=model_semaphore,
                )
                vector = assemble_factual_vector(
                    scope="stage1", source=source, metadata=metadata, packet_values=all_values,
                    packet_receipts=all_receipts, packet_plan_hash=packet_plan, authorities=authorities,
                    batch_bindings=batch, disposition="packet_cache_reuse" if calls == 0 else "fresh",
                    source_extraction_id=None,
                )
                checkpoint = invoke_result_builder(
                    repo_root=repo_root, job=job, batch=batch,
                    scope="stage1", purpose="checkpoint", vector=vector,
                )
                if checkpoint["variant"] != "continue_to_complete":
                    return _bounded_terminal_item(
                        job=job, batch=batch, result=checkpoint, workers=_flatten_workers(worker_receipts),
                        packet_plan=packet_plan, authorities=authorities,
                    ), resumed_count
                current_scope = "stage1"

            if current_scope == "stage1":
                assessment, stage2_worker = run_holistic_stage2(
                    source=source, job=job, authorities=authorities, settings=settings,
                    codex_path=resolved_codex, output_dir=output_dir,
                    force_fresh_calibration=force_fresh_calibration,
                    calibration_run_id=calibration_run_id,
                    model_semaphore=model_semaphore,
                )
                terminal = invoke_result_builder(
                    repo_root=repo_root, job=job, batch=batch,
                    scope="stage1", purpose="final", vector=vector,
                    holistic_assessment=assessment,
                )
                if terminal["variant"] != "scored_survivor":
                    raise ValueError("holistic Aim Stage 2 did not produce a scored survivor")
                return _bounded_terminal_item(
                    job=job, batch=batch, result=terminal,
                    workers=[*_flatten_workers(worker_receipts), stage2_worker],
                    packet_plan=packet_plan, authorities=authorities,
                ), resumed_count
            raise ValueError(f"unsupported Aim extraction scope: {current_scope}")
        except ModelContextLimitError:
            failure = _safe_failure_result(
                job=job, batch=batch, code="model_context_limit_exceeded", phase="model_input_preflight",
                packet_ordinal=None, attempts=0, detail="The complete supplied material and one bounded factual unit exceed the selected model context window.",
            )
            return _safe_failure_item(job, failure, _flatten_workers(worker_receipts), packet_plan), resumed_count
        except InputContractLimitError:
            failure = _safe_failure_result(
                job=job, batch=batch, code="input_contract_limit_exceeded", phase="model_input_preflight",
                packet_ordinal=None, attempts=0, detail="The supplied material cannot satisfy the versioned exchange or result-size contract.",
            )
            return _safe_failure_item(job, failure, _flatten_workers(worker_receipts), packet_plan), resumed_count
        except PacketExhausted as error:
            failure = _safe_failure_result(
                job=job, batch=batch, code=error.code,
                phase=error.phase,
                packet_ordinal=error.packet.physical_ordinal, attempts=len(error.receipt["attempts"]), detail=error.detail,
            )
            return _safe_failure_item(
                job, failure, _flatten_workers(worker_receipts), error.packet_plan_hash
            ), resumed_count
        except HolisticStage2Exhausted as error:
            failure = _safe_failure_result(
                job=job, batch=batch, code=error.code, phase="holistic_scoring",
                packet_ordinal=error.worker["packetOrdinal"], attempts=1, detail=error.detail,
            )
            return _safe_failure_item(
                job, failure, [*_flatten_workers(worker_receipts), error.worker], packet_plan
            ), resumed_count
        except RuntimeError as error:
            if "reuse identity/vector conflict" not in str(error):
                raise
            failure = _safe_failure_result(
                job=job, batch=batch, code="extraction_identity_vector_conflict", phase="result_builder",
                packet_ordinal=None, attempts=0, detail="The stored extraction identity and factual vector do not agree.",
            )
            return _safe_failure_item(job, failure, [], None), resumed_count
        except ValueError as error:
            if "fact extraction conflict" not in str(error).casefold() and "Q15 closure" not in str(error):
                raise
            failure = _safe_failure_result(
                job=job, batch=batch, code="fact_extraction_conflict", phase="result_builder",
                packet_ordinal=None, attempts=0, detail="The evidence-bound factual vector was internally inconsistent; no repeat invocation was attempted.",
            )
            return _safe_failure_item(job, failure, _flatten_workers(worker_receipts), packet_plan), resumed_count

    with ThreadPoolExecutor(max_workers=global_model_limit, thread_name_prefix="aim-v2-job") as executor:
        job_futures = [executor.submit(process_job, job) for job in exported["jobs"]]
        completed = [future.result() for future in job_futures]
    results = [item for item, _ in completed]
    counts["resumed"] = sum(resumed for _, resumed in completed)

    completed_at = utc_timestamp()
    workers = [worker for item in results for worker in item["workers"]]
    counts["modelCalls"] = len(workers)
    counts["accepted"] = sum(item["result"]["variant"] != "safe_failure" for item in results)
    counts["safeFailures"] = sum(item["result"]["variant"] == "safe_failure" for item in results)
    model_pairs: list[dict[str, str]] = []
    for worker in workers:
        pair = {"model": settings.model, "effort": worker["effort"]}
        if pair not in model_pairs:
            model_pairs.append(pair)
    without_hash = {
        "schemaVersion": "career-dashboard-aim-result-v2",
        "artifactPurpose": "calibration" if force_fresh_calibration else "production",
        "batch": _batch_echo(batch),
        "controller": {
            "controllerVersion": authorities.runner_protocol["controllerVersion"],
            "startedAt": started_at,
            "completedAt": completed_at,
            "totalModelCalls": len(workers),
            "models": model_pairs,
            "promptContractVersion": batch["promptContractVersion"],
            "responseContractVersion": batch["responseContractVersion"],
            "invocationReceipt": f"aim-two-stage-calls:{len(workers)};run:{batch_id}",
        },
        "results": results,
    }
    if len(canonical_json(without_hash).encode("utf-8")) > authorities.runner_protocol["limits"]["maximumSerializedResultBytesPerBatch"]:
        raise InputContractLimitError("Aim v2 result envelope exceeds the batch result-size contract")
    result = {**without_hash, "resultHash": result_envelope_hash(without_hash)}
    validate_result_against_export(result, exported, repo_root)
    if force_fresh_calibration:
        run_id = safe_task_component(calibration_run_id or "")
        output_path = output_dir / f"career-dashboard-aim-calibration-{batch_id}-{run_id}.json"
    else:
        output_path = output_dir / f"career-dashboard-aim-results-{batch_id}.json"
    atomic_write_json(output_path, result)
    return output_path, counts
