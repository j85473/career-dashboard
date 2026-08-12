from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .codex_worker import WorkerRun, assert_model_available, run_worker
from .common import (
    RUNNER_VERSION,
    atomic_write_json,
    canonical_json,
    canonical_sha256,
    load_json,
    normalize_source_text,
    normalized_text_sha256,
    safe_task_component,
    utc_timestamp,
    with_hash,
)
from .contracts import validate_export, validate_result_against_export, validate_schema, validate_span
from .worker_schemas import aim_worker_schemas, experience_worker_schemas


@dataclass(frozen=True)
class RunnerSettings:
    model: str
    effort: str
    escalation_effort: str
    timeout_seconds: int
    maximum_repairs: int


def load_runner_settings(repo_root: Path, model: str | None, effort: str | None) -> RunnerSettings:
    protocol = load_json(repo_root / "data/scoring/runner-protocol-v1.json")
    selected_model = model or protocol["defaultModel"]
    selected_effort = effort or protocol["defaultEffort"]
    if selected_effort != "medium":
        raise ValueError("initial semantic effort must be medium; high is reserved for bounded repair escalation")
    return RunnerSettings(
        model=selected_model,
        effort=selected_effort,
        escalation_effort=protocol["escalationEffort"],
        timeout_seconds=protocol["invocationTimeoutSeconds"],
        maximum_repairs=protocol["maximumTargetedRepairsPerArtifact"],
    )


def _prompt(repo_root: Path, name: str, payload: dict[str, Any], repair: bool = False) -> str:
    prompts = repo_root / "data/scoring/prompts"
    base = (prompts / f"{name}-v1.md").read_text(encoding="utf-8")
    if repair:
        base += "\n" + (prompts / "targeted-repair-v1.md").read_text(encoding="utf-8")
    return f"{base}\n\n<untrusted-json-data>\n{canonical_json(payload)}\n</untrusted-json-data>\n"


def _invoke(
    *, repo_root: Path, name: str, phase: str, payload: dict[str, Any], schema: dict[str, Any],
    task_dir: Path, settings: RunnerSettings, codex_path: str, effort: str, repair: bool = False,
) -> WorkerRun:
    return run_worker(
        phase=phase,
        prompt_version=f"{name}-v1",
        prompt=_prompt(repo_root, name, payload, repair=repair),
        schema=schema,
        task_dir=task_dir,
        model=settings.model,
        effort=effort,
        timeout_seconds=settings.timeout_seconds,
        codex_path=codex_path,
    )


def _repair_effort(repair_number: int, settings: RunnerSettings) -> str:
    return settings.effort if repair_number == 1 else settings.escalation_effort


def _safe_failure(code: str, detail: str) -> dict[str, Any]:
    return {"kind": "safe_failure", "code": code, "detail": detail[:2000]}


def _validate_cleaner(source: str, output: dict[str, Any]) -> dict[str, Any]:
    normalized = normalize_source_text(source)
    spans = output["removedSpans"]
    cursor = 0
    pieces: list[str] = []
    for span in spans:
        validate_span(normalized, span)
        start, end = span["startCodePoint"], span["endCodePoint"]
        if start < cursor or end <= start:
            raise ValueError("cleaner spans must be ordered, non-overlapping, and non-empty")
        pieces.append(normalized[cursor:start])
        cursor = end
    pieces.append(normalized[cursor:])
    if "".join(pieces) != output["cleanedText"]:
        raise ValueError("cleanedText is not exactly the original JD minus declared spans")
    if not output["cleanedText"].strip():
        raise ValueError("cleanedText cannot be empty")
    return output


def _validate_aim_evaluation(
    output: dict[str, Any], source: str, policy: dict[str, Any]
) -> dict[str, Any]:
    hard_stop_codes = [entry["code"] for entry in policy["hardStops"]]
    if [entry["code"] for entry in output["hardStops"]] != hard_stop_codes:
        raise ValueError("Aim hard stops must appear exactly once in policy order")
    for hard_stop in output["hardStops"]:
        binding = hard_stop["binding"]
        if binding["source"] == "original_jd":
            if binding["span"] is None:
                raise ValueError(f"{hard_stop['code']} original-JD binding needs an exact span")
            validate_span(source, binding["span"])
        elif binding["span"] is not None:
            raise ValueError(f"{hard_stop['code']} non-JD binding must use a null span")
    present = [entry for entry in output["hardStops"] if entry["state"] == "present"]
    rubric = output["rubric"]
    if present and rubric is not None:
        raise ValueError("hard-stop result must not have an Aim rubric")
    if not present and rubric is None:
        raise ValueError("Aim survivor must have all rubric bands")
    if rubric is not None:
        for json_key, policy_key in (("coreWork", "coreWork"), ("buildingAutonomy", "buildingAutonomy"), ("productIndustry", "productIndustry"), ("travel", "travel")):
            allowed = {entry["band"]: entry["points"] for entry in policy["rubric"][policy_key]}
            band = rubric[json_key]
            if band["band"] not in allowed or band["points"] != allowed[band["band"]]:
                raise ValueError(f"Aim {json_key} band/points do not match policy")
            binding = band["binding"]
            if binding["source"] == "original_jd":
                if binding["span"] is None:
                    raise ValueError(f"Aim {json_key} original-JD binding needs a span")
                validate_span(source, binding["span"])
            elif binding["span"] is not None:
                raise ValueError(f"Aim {json_key} non-JD binding must use a null span")
        if (output["travel"]["band"], output["travel"]["points"]) != (rubric["travel"]["band"], rubric["travel"]["points"]):
            raise ValueError("travel assessment and rubric travel band disagree")
    if output["travel"]["source"] is not None:
        validate_span(source, output["travel"]["source"])
    if output["compensation"]["source"] is not None:
        validate_span(source, output["compensation"]["source"])
    decision = "rejected_hard_stop" if present else "survivor"
    score = None if present else sum(rubric[key]["points"] for key in ("coreWork", "buildingAutonomy", "productIndustry", "travel"))
    return output | {"decision": decision, "aimFitScore": score}


def _stable_criteria(criteria: list[dict[str, Any]], input_hash: str, source: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for criterion in criteria:
        validate_span(source, criterion["source"])
        source_span = criterion["source"]
        digest = hashlib.sha256(
            f"{input_hash}\0{criterion['classification']}\0{source_span['startCodePoint']}\0{source_span['endCodePoint']}".encode()
        ).hexdigest()
        criterion_id = f"criterion-{digest[:32]}"
        if criterion_id in seen:
            raise ValueError("duplicate criterion source/classification binding")
        seen.add(criterion_id)
        leaves: list[dict[str, Any]] = []
        for index, leaf in enumerate(criterion["leaves"]):
            validate_span(source, leaf["source"])
            leaf_digest = hashlib.sha256(
                f"{criterion_id}\0{leaf['source']['startCodePoint']}\0{leaf['source']['endCodePoint']}\0{index}".encode()
            ).hexdigest()
            leaves.append(leaf | {"leafId": f"leaf-{leaf_digest[:32]}"})
        if criterion["operator"] == "single" and len(leaves) != 1:
            raise ValueError("single criterion must contain exactly one leaf")
        result.append(criterion | {"criterionId": criterion_id, "leaves": leaves})
    return result


def _compound_outcome(operator: str, outcomes: list[str]) -> str:
    if not outcomes:
        raise ValueError("criterion has no atomic leaves")
    if operator == "any":
        for outcome in ("direct", "partial", "cannot_evaluate", "does_not_meet"):
            if outcome in outcomes:
                return outcome
    else:
        for outcome in ("does_not_meet", "cannot_evaluate", "partial", "direct"):
            if outcome in outcomes:
                return outcome
    raise ValueError("criterion has an invalid logical operator")


def _validate_evidence_binding(binding: dict[str, Any], records: dict[str, dict[str, Any]]) -> None:
    record = records.get(binding["evidenceId"])
    if not record:
        raise ValueError(f"unknown evidence ID {binding['evidenceId']}")
    value = record[binding["fieldPath"]]
    if not isinstance(value, str):
        raise ValueError("evidence field path does not address text")
    validate_span(value, binding)


def _derive_experience(
    criteria: list[dict[str, Any]], evaluator: dict[str, Any], evidence_records: list[dict[str, Any]]
) -> dict[str, Any]:
    declared = evaluator["outcomes"]
    if [entry["criterionId"] for entry in declared] != [entry["criterionId"] for entry in criteria]:
        raise ValueError("evidence outcomes must preserve exact criterion membership and order")
    records = {record["evidenceId"]: record for record in evidence_records}
    normalized_outcomes: list[dict[str, Any]] = []
    if len(criteria) != len(declared):
        raise ValueError("evidence outcomes must preserve exact criterion membership and order")
    for criterion, outcome in zip(criteria, declared):
        if [leaf["leafId"] for leaf in outcome["leaves"]] != [leaf["leafId"] for leaf in criterion["leaves"]]:
            raise ValueError(f"criterion {criterion['criterionId']} leaf membership/order mismatch")
        leaves: list[dict[str, Any]] = []
        for leaf in outcome["leaves"]:
            for binding in leaf["support"] + leaf["conflict"]:
                _validate_evidence_binding(binding, records)
            state = leaf["outcome"]
            if state == "direct" and not any(binding["relation"] == "supports_complete" for binding in leaf["support"]):
                raise ValueError(f"leaf {leaf['leafId']} declares direct without complete support")
            if state == "partial" and not any(binding["relation"] == "supports_partial" for binding in leaf["support"]):
                raise ValueError(f"leaf {leaf['leafId']} declares partial without partial support")
            if state == "does_not_meet" and not leaf["conflict"]:
                raise ValueError(f"leaf {leaf['leafId']} declares does_not_meet without conflict evidence")
            if state == "cannot_evaluate" and (leaf["support"] or leaf["conflict"]):
                raise ValueError(f"leaf {leaf['leafId']} cannot_evaluate must be evidence-silent")
            leaves.append(leaf)
        if criterion["category"] in ("administrative", "subjective_boilerplate"):
            normalized_outcomes.append({
                "criterionId": criterion["criterionId"],
                "outcome": "excluded",
                "leaves": [leaf | {"outcome": "cannot_evaluate", "support": [], "conflict": [], "rationale": "excluded from Experience evaluation by policy"} for leaf in leaves],
            })
        else:
            derived = _compound_outcome(criterion["operator"], [leaf["outcome"] for leaf in leaves])
            normalized_outcomes.append({"criterionId": criterion["criterionId"], "outcome": derived, "leaves": leaves})
    active = [
        (criterion, outcome)
        for criterion, outcome in zip(criteria, normalized_outcomes)
        if criterion["category"] not in ("administrative", "subjective_boilerplate")
    ]
    blocking = [
        {"criterionId": criterion["criterionId"], "outcome": outcome["outcome"]}
        for criterion, outcome in active
        if criterion["classification"] == "required" and outcome["outcome"] != "direct"
    ]
    if blocking:
        return {
            "outcomes": normalized_outcomes,
            "decision": "hard_requirement_not_fully_supported",
            "blockingCriteria": blocking,
            "preferredPoints": None,
            "experienceFitScore": None,
        }
    preferred = [outcome["outcome"] for criterion, outcome in active if criterion["classification"] == "preferred"]
    units = sum(2 if outcome == "direct" else 1 if outcome == "partial" else 0 for outcome in preferred)
    preferred_points = 0 if not preferred else (20 * units + len(preferred)) // (2 * len(preferred))
    return {
        "outcomes": normalized_outcomes,
        "decision": "qualified",
        "blockingCriteria": [],
        "preferredPoints": preferred_points,
        "experienceFitScore": 80 + preferred_points,
    }


def _checkpoint(
    *, task_dir: Path, input_hash: str, result_schema: dict[str, Any], schema_root: dict[str, Any], produce: Callable[[], dict[str, Any]]
) -> tuple[dict[str, Any], bool]:
    checkpoint = task_dir / f"{input_hash}.accepted.json"
    if checkpoint.exists():
        value = load_json(checkpoint)
        validate_schema(value, result_schema, schema_root)
        return value, True
    value = produce()
    validate_schema(value, result_schema, schema_root)
    atomic_write_json(checkpoint, value)
    return value, False


def run_aim(
    *, export_path: Path, output_dir: Path, repo_root: Path, model: str | None = None, effort: str | None = None
) -> tuple[Path, dict[str, int]]:
    exported = load_json(export_path)
    validate_export(exported, repo_root, "aim")
    settings = load_runner_settings(repo_root, model, effort)
    codex_path = assert_model_available(settings.model, settings.effort)
    assert_model_available(settings.model, settings.escalation_effort, codex_path)
    worker_schemas = aim_worker_schemas(repo_root)
    final_schema = load_json(repo_root / "data/scoring/schemas/aim-result-v1.schema.json")
    result_item_schema = final_schema["$defs"]["result"]
    policy = load_json(repo_root / "data/scoring/aim-policy-v1.json")
    batch_id = safe_task_component(exported["batch"]["id"])
    task_root = output_dir / ".tasks" / batch_id / "aim"
    started_at = utc_timestamp()
    results: list[dict[str, Any]] = []
    counts = {"submitted": len(exported["jobs"]), "accepted": 0, "repaired": 0, "resumed": 0, "safeFailures": 0}
    for job in exported["jobs"]:
        job_dir = task_root / f"{job['ordinal']:02d}-{safe_task_component(job['jobId'])}"

        def produce() -> dict[str, Any]:
            receipts: list[dict[str, Any]] = []
            cleaner = _invoke(repo_root=repo_root, name="jd-cleaner", phase="jd_cleaner", payload={"job": job}, schema=worker_schemas["jd_cleaner"], task_dir=job_dir, settings=settings, codex_path=codex_path, effort=settings.effort)
            receipts.append(cleaner.receipt)
            candidate = cleaner.output
            repair_history: list[str] = []
            coverage: dict[str, Any] | None = None
            for attempt in range(settings.maximum_repairs + 1):
                try:
                    candidate = _validate_cleaner(job["originalJd"], candidate)
                    audit = _invoke(repo_root=repo_root, name="jd-coverage-auditor", phase="jd_coverage_auditor", payload={"originalJd": job["originalJd"], "candidate": candidate}, schema=worker_schemas["jd_coverage_auditor"], task_dir=job_dir, settings=settings, codex_path=codex_path, effort=settings.effort)
                    receipts.append(audit.receipt)
                    coverage = audit.output
                    if coverage["complete"]:
                        break
                    error = "; ".join(coverage["findings"]) or "coverage auditor did not confirm completeness"
                except ValueError as validation_error:
                    error = str(validation_error)
                if attempt >= settings.maximum_repairs:
                    payload = {"jobId": job["jobId"], "ordinal": job["ordinal"], "inputHash": job["inputHash"], "workers": receipts, "result": _safe_failure("coverage_incomplete", error)}
                    return with_hash(payload)
                repair_number = attempt + 1
                repaired = _invoke(repo_root=repo_root, name="jd-cleaner", phase="targeted_repair", payload={"job": job, "priorOutput": candidate, "validatorErrors": [error]}, schema=worker_schemas["jd_cleaner"], task_dir=job_dir, settings=settings, codex_path=codex_path, effort=_repair_effort(repair_number, settings), repair=True)
                receipts.append(repaired.receipt)
                candidate = repaired.output
                repair_history.append(f"repair {repair_number}: {error}"[:2000])
            evaluator_payload = {"job": job, "cleanedText": candidate["cleanedText"], "policy": policy, "employerOverrides": exported["preferences"]["employerOverrides"]}
            evaluated = _invoke(repo_root=repo_root, name="aim-evaluator", phase="aim_evaluator", payload=evaluator_payload, schema=worker_schemas["aim_evaluator"], task_dir=job_dir, settings=settings, codex_path=codex_path, effort=settings.effort)
            receipts.append(evaluated.receipt)
            aim_result: dict[str, Any] | None = None
            last_error = ""
            for attempt in range(settings.maximum_repairs + 1):
                try:
                    aim_result = _validate_aim_evaluation(evaluated.output, job["originalJd"], policy)
                    break
                except ValueError as validation_error:
                    last_error = str(validation_error)
                if attempt >= settings.maximum_repairs:
                    payload = {"jobId": job["jobId"], "ordinal": job["ordinal"], "inputHash": job["inputHash"], "workers": receipts, "result": _safe_failure("result_untrustworthy", last_error)}
                    return with_hash(payload)
                repair_number = attempt + 1
                evaluated = _invoke(repo_root=repo_root, name="aim-evaluator", phase="targeted_repair", payload=evaluator_payload | {"priorOutput": evaluated.output, "validatorErrors": [last_error]}, schema=worker_schemas["aim_evaluator"], task_dir=job_dir, settings=settings, codex_path=codex_path, effort=_repair_effort(repair_number, settings), repair=True)
                receipts.append(evaluated.receipt)
                repair_history.append(f"Aim repair {repair_number}: {last_error}"[:2000])
            artifact = {
                "cleanerVersion": "jd-cleaner-v1",
                "sourceJdHash": job["sourceJdHash"],
                "cleanedText": candidate["cleanedText"],
                "cleanedTextHash": normalized_text_sha256(candidate["cleanedText"]),
                "removedSpans": candidate["removedSpans"],
                "coverageAudit": coverage,
                "repairHistory": repair_history[:2],
            }
            evaluation = {"kind": "evaluation", "cleanedArtifact": artifact} | aim_result
            return with_hash({"jobId": job["jobId"], "ordinal": job["ordinal"], "inputHash": job["inputHash"], "workers": receipts, "result": evaluation})

        item, resumed = _checkpoint(task_dir=job_dir, input_hash=job["inputHash"], result_schema=result_item_schema, schema_root=final_schema, produce=produce)
        results.append(item)
        counts["accepted"] += 1
        counts["resumed"] += int(resumed)
        counts["repaired"] += int(any(receipt["phase"] == "targeted_repair" for receipt in item["workers"]))
        counts["safeFailures"] += int(item["result"]["kind"] == "safe_failure")
    completed_at = utc_timestamp()
    overall_effort = "high" if any(receipt["effort"] == "high" for item in results for receipt in item["workers"]) else settings.effort
    result = with_hash({
        "schemaVersion": "career-dashboard-aim-result-v1",
        "batch": {key: exported["batch"][key] for key in ("id", "stage", "protocolVersion", "policyVersion", "manifestHash")},
        "runner": {"runnerVersion": RUNNER_VERSION, "model": settings.model, "effort": overall_effort, "promptVersion": "aim-workers-v1", "startedAt": started_at, "completedAt": completed_at, "invocationReceipt": f"isolated-workers:{sum(len(item['workers']) for item in results)};batch:{batch_id}"},
        "results": results,
    })
    validate_result_against_export(result, exported, repo_root)
    output_path = output_dir / f"career-dashboard-aim-results-{batch_id}.json"
    atomic_write_json(output_path, result)
    return output_path, counts


def run_experience(
    *, export_path: Path, output_dir: Path, repo_root: Path, model: str | None = None, effort: str | None = None
) -> tuple[Path, dict[str, int]]:
    exported = load_json(export_path)
    validate_export(exported, repo_root, "experience")
    settings = load_runner_settings(repo_root, model, effort)
    codex_path = assert_model_available(settings.model, settings.effort)
    assert_model_available(settings.model, settings.escalation_effort, codex_path)
    worker_schemas = experience_worker_schemas(repo_root)
    final_schema = load_json(repo_root / "data/scoring/schemas/experience-result-v1.schema.json")
    result_item_schema = final_schema["$defs"]["result"]
    batch_id = safe_task_component(exported["batch"]["id"])
    task_root = output_dir / ".tasks" / batch_id / "experience"
    started_at = utc_timestamp()
    results: list[dict[str, Any]] = []
    counts = {"submitted": len(exported["jobs"]), "accepted": 0, "repaired": 0, "resumed": 0, "safeFailures": 0}
    for job in exported["jobs"]:
        job_dir = task_root / f"{job['ordinal']:02d}-{safe_task_component(job['jobId'])}"

        def produce() -> dict[str, Any]:
            receipts: list[dict[str, Any]] = []
            extractor_payload = {"job": job, "experiencePolicyVersion": exported["batch"]["policyVersion"]}
            extracted = _invoke(repo_root=repo_root, name="requirement-extractor", phase="requirement_extractor", payload=extractor_payload, schema=worker_schemas["requirement_extractor"], task_dir=job_dir, settings=settings, codex_path=codex_path, effort=settings.effort)
            receipts.append(extracted.receipt)
            criteria: list[dict[str, Any]] | None = None
            coverage: dict[str, Any] | None = None
            repair_history: list[str] = []
            last_error = ""
            for attempt in range(settings.maximum_repairs + 1):
                try:
                    criteria = _stable_criteria(extracted.output["criteria"], job["inputHash"], job["cleanedText"])
                    audit = _invoke(repo_root=repo_root, name="requirement-coverage-auditor", phase="requirement_coverage_auditor", payload={"cleanedText": job["cleanedText"], "criteria": criteria}, schema=worker_schemas["requirement_coverage_auditor"], task_dir=job_dir, settings=settings, codex_path=codex_path, effort=settings.effort)
                    receipts.append(audit.receipt)
                    coverage = audit.output
                    if coverage["complete"]:
                        break
                    last_error = "; ".join(coverage["findings"]) or "coverage auditor did not confirm completeness"
                except ValueError as validation_error:
                    last_error = str(validation_error)
                if attempt >= settings.maximum_repairs:
                    base = {key: job[key] for key in ("jobId", "ordinal", "inputHash", "aimEventId", "aimEventHash", "cleanedArtifactId", "cleanedArtifactHash")}
                    return with_hash(base | {"workers": receipts, "result": _safe_failure("coverage_incomplete", last_error)})
                repair_number = attempt + 1
                extracted = _invoke(repo_root=repo_root, name="requirement-extractor", phase="targeted_repair", payload=extractor_payload | {"priorOutput": extracted.output, "validatorErrors": [last_error]}, schema=worker_schemas["requirement_extractor"], task_dir=job_dir, settings=settings, codex_path=codex_path, effort=_repair_effort(repair_number, settings), repair=True)
                receipts.append(extracted.receipt)
                repair_history.append(f"requirement repair {repair_number}: {last_error}"[:2000])
            evaluator_payload = {"job": job, "criteria": criteria, "resume": exported["resume"], "evidence": exported["evidence"]}
            evaluated = _invoke(repo_root=repo_root, name="evidence-evaluator", phase="evidence_evaluator", payload=evaluator_payload, schema=worker_schemas["evidence_evaluator"], task_dir=job_dir, settings=settings, codex_path=codex_path, effort=settings.effort)
            receipts.append(evaluated.receipt)
            derived: dict[str, Any] | None = None
            for attempt in range(settings.maximum_repairs + 1):
                try:
                    derived = _derive_experience(criteria, evaluated.output, exported["evidence"]["records"])
                    break
                except ValueError as validation_error:
                    last_error = str(validation_error)
                if attempt >= settings.maximum_repairs:
                    base = {key: job[key] for key in ("jobId", "ordinal", "inputHash", "aimEventId", "aimEventHash", "cleanedArtifactId", "cleanedArtifactHash")}
                    return with_hash(base | {"workers": receipts, "result": _safe_failure("result_untrustworthy", last_error)})
                repair_number = attempt + 1
                evaluated = _invoke(repo_root=repo_root, name="evidence-evaluator", phase="targeted_repair", payload=evaluator_payload | {"priorOutput": evaluated.output, "validatorErrors": [last_error]}, schema=worker_schemas["evidence_evaluator"], task_dir=job_dir, settings=settings, codex_path=codex_path, effort=_repair_effort(repair_number, settings), repair=True)
                receipts.append(evaluated.receipt)
                repair_history.append(f"evidence repair {repair_number}: {last_error}"[:2000])
            evaluation = {"kind": "evaluation", "criteria": criteria, "coverageAudit": coverage, "repairHistory": repair_history[:2]} | derived
            base = {key: job[key] for key in ("jobId", "ordinal", "inputHash", "aimEventId", "aimEventHash", "cleanedArtifactId", "cleanedArtifactHash")}
            return with_hash(base | {"workers": receipts, "result": evaluation})

        item, resumed = _checkpoint(task_dir=job_dir, input_hash=job["inputHash"], result_schema=result_item_schema, schema_root=final_schema, produce=produce)
        results.append(item)
        counts["accepted"] += 1
        counts["resumed"] += int(resumed)
        counts["repaired"] += int(any(receipt["phase"] == "targeted_repair" for receipt in item["workers"]))
        counts["safeFailures"] += int(item["result"]["kind"] == "safe_failure")
    completed_at = utc_timestamp()
    overall_effort = "high" if any(receipt["effort"] == "high" for item in results for receipt in item["workers"]) else settings.effort
    result = with_hash({
        "schemaVersion": "career-dashboard-experience-result-v1",
        "batch": {key: exported["batch"][key] for key in ("id", "stage", "protocolVersion", "policyVersion", "manifestHash")},
        "resumeHash": exported["resume"]["hash"],
        "evidenceHash": exported["evidence"]["evidenceHash"],
        "runner": {"runnerVersion": RUNNER_VERSION, "model": settings.model, "effort": overall_effort, "promptVersion": "experience-workers-v1", "startedAt": started_at, "completedAt": completed_at, "invocationReceipt": f"isolated-workers:{sum(len(item['workers']) for item in results)};batch:{batch_id}"},
        "results": results,
    })
    validate_result_against_export(result, exported, repo_root)
    output_path = output_dir / f"career-dashboard-experience-results-{batch_id}.json"
    atomic_write_json(output_path, result)
    return output_path, counts
