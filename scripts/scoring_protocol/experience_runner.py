from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .codex_worker import WorkerInvocationError, WorkerRun, assert_model_available, run_worker
from .common import (
    RUNNER_VERSION,
    atomic_write_json,
    canonical_json,
    load_json,
    safe_task_component,
    utc_timestamp,
    with_hash,
)
from .contracts import validate_export, validate_result_against_export, validate_schema, validate_span
from .input_versions import validate_current_experience_v2_export, worker_prompt_version
from .worker_schemas import experience_worker_schemas


@dataclass(frozen=True)
class HistoricalRunnerSettings:
    model: str
    effort: str
    escalation_effort: str
    timeout_seconds: int
    maximum_repairs: int


def load_runner_settings(repo_root: Path, model: str | None, effort: str | None) -> HistoricalRunnerSettings:
    protocol = load_json(repo_root / "data/scoring/runner-protocol-v1.json")
    selected_model = model or protocol["defaultModel"]
    selected_effort = effort or protocol["defaultEffort"]
    if selected_effort != "medium":
        raise ValueError("initial semantic effort must be medium; high is reserved for bounded repair escalation")
    return HistoricalRunnerSettings(
        model=selected_model,
        effort=selected_effort,
        escalation_effort=protocol["escalationEffort"],
        timeout_seconds=protocol["invocationTimeoutSeconds"],
        maximum_repairs=protocol["maximumTargetedRepairsPerArtifact"],
    )


def _prompt(repo_root: Path, name: str, payload: dict[str, Any], repair: bool = False) -> str:
    prompts = repo_root / "data/scoring/archive/experience-v1/prompts"
    base = (prompts / f"{worker_prompt_version(name)}.md").read_text(encoding="utf-8")
    if repair:
        base += "\n" + (prompts / "targeted-repair-v1.md").read_text(encoding="utf-8")
    return f"{base}\n\n<untrusted-json-data>\n{canonical_json(payload)}\n</untrusted-json-data>\n"


def _invoke(
    *, repo_root: Path, name: str, phase: str, payload: dict[str, Any], schema: dict[str, Any],
    task_dir: Path, settings: HistoricalRunnerSettings, codex_path: str, effort: str, repair: bool = False,
) -> WorkerRun:
    return run_worker(
        phase=phase,
        prompt_version=worker_prompt_version(name),
        prompt=_prompt(repo_root, name, payload, repair=repair),
        schema=schema,
        task_dir=task_dir,
        model=settings.model,
        effort=effort,
        timeout_seconds=settings.timeout_seconds,
        codex_path=codex_path,
    )


def _repair_effort(repair_number: int, settings: HistoricalRunnerSettings) -> str:
    return settings.effort if repair_number == 1 else settings.escalation_effort


def _safe_failure(code: str, detail: str) -> dict[str, Any]:
    return {"kind": "safe_failure", "code": code, "detail": detail[:2000]}


def _experience_parent_fields(job: dict[str, Any], v2: bool) -> tuple[str, ...]:
    if v2:
        return (
            "jobId", "ordinal", "inputHash", "sourceAimEventId", "aimFactualExtractionId",
            "sourceJdHash", "trustedMetadataHash", "aimSemanticResultHash",
        )
    return (
        "jobId", "ordinal", "inputHash", "aimEventId", "aimEventHash",
        "cleanedArtifactId", "cleanedArtifactHash",
    )


def _worker_failure_item(job: dict[str, Any], error: WorkerInvocationError, stage: str, v2: bool = False) -> dict[str, Any]:
    keys = ["jobId", "ordinal", "inputHash"]
    if stage == "experience":
        keys = list(_experience_parent_fields(job, v2))
    base = {key: job[key] for key in keys}
    return with_hash(base | {
        "workers": [error.receipt],
        "result": _safe_failure("worker_invocation_failed", str(error)),
    })


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
                "leaves": [leaf | {
                    "outcome": "cannot_evaluate", "support": [], "conflict": [],
                    "rationale": "excluded from Experience evaluation by policy",
                } for leaf in leaves],
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
    *, task_dir: Path, input_hash: str, result_schema: dict[str, Any], schema_root: dict[str, Any],
    produce: Callable[[], dict[str, Any]],
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


def _run_historical_experience_v1(
    *, export_path: Path, output_dir: Path, repo_root: Path, model: str | None = None, effort: str | None = None
) -> tuple[Path, dict[str, int]]:
    exported = load_json(export_path)
    validate_export(exported, repo_root, "experience")
    if exported["schemaVersion"] != "career-dashboard-experience-export-v1":
        raise ValueError("historical Experience runner accepts only career-dashboard-experience-export-v1")
    v2 = False
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
        source_text = job["originalJd"] if v2 else job["cleanedText"]
        parent_fields = _experience_parent_fields(job, v2)

        def produce() -> dict[str, Any]:
            receipts: list[dict[str, Any]] = []
            extractor_payload = {"job": job, "experiencePolicyVersion": exported["batch"]["policyVersion"]}
            extracted = _invoke(
                repo_root=repo_root, name="requirement-extractor", phase="requirement_extractor",
                payload=extractor_payload, schema=worker_schemas["requirement_extractor"], task_dir=job_dir,
                settings=settings, codex_path=codex_path, effort=settings.effort,
            )
            receipts.append(extracted.receipt)
            criteria: list[dict[str, Any]] | None = None
            coverage: dict[str, Any] | None = None
            repair_history: list[str] = []
            last_error = ""
            for attempt in range(settings.maximum_repairs + 1):
                try:
                    criteria = _stable_criteria(
                        extracted.output["criteria"],
                        job["sourceJdHash"] if v2 else job["inputHash"],
                        source_text,
                    )
                    audit = _invoke(
                        repo_root=repo_root, name="requirement-coverage-auditor", phase="requirement_coverage_auditor",
                        payload={"originalJd" if v2 else "cleanedText": source_text, "criteria": criteria},
                        schema=worker_schemas["requirement_coverage_auditor"], task_dir=job_dir,
                        settings=settings, codex_path=codex_path, effort=settings.effort,
                    )
                    receipts.append(audit.receipt)
                    coverage = audit.output
                    if coverage["complete"]:
                        break
                    last_error = "; ".join(coverage["findings"]) or "coverage auditor did not confirm completeness"
                except ValueError as validation_error:
                    last_error = str(validation_error)
                if attempt >= settings.maximum_repairs:
                    base = {key: job[key] for key in parent_fields}
                    return with_hash(base | {"workers": receipts, "result": _safe_failure("coverage_incomplete", last_error)})
                repair_number = attempt + 1
                extracted = _invoke(
                    repo_root=repo_root, name="requirement-extractor", phase="targeted_repair",
                    payload=extractor_payload | {"priorOutput": extracted.output, "validatorErrors": [last_error]},
                    schema=worker_schemas["requirement_extractor"], task_dir=job_dir, settings=settings,
                    codex_path=codex_path, effort=_repair_effort(repair_number, settings), repair=True,
                )
                receipts.append(extracted.receipt)
                repair_history.append(f"requirement repair {repair_number}: {last_error}"[:2000])
            evaluator_payload = {"job": job, "criteria": criteria, "resume": exported["resume"], "evidence": exported["evidence"]}
            evaluated = _invoke(
                repo_root=repo_root, name="evidence-evaluator", phase="evidence_evaluator",
                payload=evaluator_payload, schema=worker_schemas["evidence_evaluator"], task_dir=job_dir,
                settings=settings, codex_path=codex_path, effort=settings.effort,
            )
            receipts.append(evaluated.receipt)
            derived: dict[str, Any] | None = None
            for attempt in range(settings.maximum_repairs + 1):
                try:
                    derived = _derive_experience(criteria or [], evaluated.output, exported["evidence"]["records"])
                    break
                except ValueError as validation_error:
                    last_error = str(validation_error)
                if attempt >= settings.maximum_repairs:
                    base = {key: job[key] for key in parent_fields}
                    return with_hash(base | {"workers": receipts, "result": _safe_failure("result_untrustworthy", last_error)})
                repair_number = attempt + 1
                evaluated = _invoke(
                    repo_root=repo_root, name="evidence-evaluator", phase="targeted_repair",
                    payload=evaluator_payload | {"priorOutput": evaluated.output, "validatorErrors": [last_error]},
                    schema=worker_schemas["evidence_evaluator"], task_dir=job_dir, settings=settings,
                    codex_path=codex_path, effort=_repair_effort(repair_number, settings), repair=True,
                )
                receipts.append(evaluated.receipt)
                repair_history.append(f"evidence repair {repair_number}: {last_error}"[:2000])
            evaluation = {"kind": "evaluation", "criteria": criteria, "coverageAudit": coverage, "repairHistory": repair_history[:2]} | (derived or {})
            base = {key: job[key] for key in parent_fields}
            return with_hash(base | {"workers": receipts, "result": evaluation})

        try:
            item, resumed = _checkpoint(
                task_dir=job_dir, input_hash=job["inputHash"], result_schema=result_item_schema,
                schema_root=final_schema, produce=produce,
            )
        except WorkerInvocationError as error:
            item = _worker_failure_item(job, error, "experience", v2=v2)
            validate_schema(item, result_item_schema, final_schema)
            atomic_write_json(job_dir / f"{job['inputHash']}.accepted.json", item)
            resumed = False
        results.append(item)
        counts["accepted"] += int(item["result"]["kind"] == "evaluation")
        counts["resumed"] += int(resumed)
        counts["repaired"] += int(any(receipt["phase"] == "targeted_repair" for receipt in item["workers"]))
        counts["safeFailures"] += int(item["result"]["kind"] == "safe_failure")
    completed_at = utc_timestamp()
    overall_effort = "high" if any(receipt["effort"] == "high" for item in results for receipt in item["workers"]) else settings.effort
    result_schema_version = "career-dashboard-experience-result-v1"
    batch_echo = {key: exported["batch"][key] for key in ("id", "stage", "protocolVersion", "policyVersion", "manifestHash")}
    if v2:
        batch_echo |= {
            "exportSchemaVersion": exported["batch"]["exportSchemaVersion"],
            "resultSchemaVersion": result_schema_version,
        }
    result = with_hash({
        "schemaVersion": result_schema_version,
        "batch": batch_echo,
        "resumeHash": exported["resume"]["hash"],
        "evidenceHash": exported["evidence"]["evidenceHash"],
        "runner": {
            "runnerVersion": RUNNER_VERSION, "model": settings.model, "effort": overall_effort,
            "promptVersion": "experience-workers-v1", "startedAt": started_at, "completedAt": completed_at,
            "invocationReceipt": f"isolated-workers:{sum(len(item['workers']) for item in results)};batch:{batch_id}",
        },
        "results": results,
    })
    validate_result_against_export(result, exported, repo_root)
    output_path = output_dir / f"career-dashboard-experience-results-{batch_id}.json"
    atomic_write_json(output_path, result)
    return output_path, counts


@dataclass(frozen=True)
class SimpleRunnerSettings:
    model: str
    hard_gate_effort: str
    holistic_effort: str
    timeout_seconds: int
    maximum_output_bytes: int
    maximum_hard_requirements: int
    hard_requirement_mismatch_score: int


def load_simple_runner_settings(
    repo_root: Path, model: str | None, effort: str | None,
) -> SimpleRunnerSettings:
    protocol = load_json(repo_root / "data/scoring/experience-runner-protocol-v2.json")
    policy = load_json(repo_root / "data/scoring/experience-policy-v2.json")
    if effort not in (None, "medium"):
        raise ValueError("Experience v2 always uses Terra Medium for the hard gate and Terra High for holistic scoring")
    if protocol["hardGateEffort"] != "medium" or protocol["holisticEffort"] != "high":
        raise ValueError("Experience v2 requires medium hard-gate effort and high holistic effort")
    if protocol["retry"].get("enabled") is not False or protocol["retry"].get("maximumAttemptsPerPhase") != 1:
        raise ValueError("Experience v2 does not permit model repair or retry invocations")
    if policy["hardGate"]["effort"] != protocol["hardGateEffort"] \
        or policy["holisticScore"]["effort"] != protocol["holisticEffort"]:
        raise ValueError("Experience v2 policy and runner effort bindings disagree")
    return SimpleRunnerSettings(
        model=model or protocol["defaultModel"],
        hard_gate_effort=protocol["hardGateEffort"],
        holistic_effort=protocol["holisticEffort"],
        timeout_seconds=protocol["invocationTimeoutSeconds"],
        maximum_output_bytes=protocol["maximumOutputUtf8Bytes"],
        maximum_hard_requirements=protocol["maximumHardRequirements"],
        hard_requirement_mismatch_score=policy["hardRequirementMismatchScore"],
    )


def _plain_prompt(
    *, repo_root: Path, prompt_version: str, original_jd: str, evidence: dict[str, Any],
) -> str:
    base = (repo_root / "data/scoring/prompts" / f"{prompt_version}.md").read_text(encoding="utf-8").rstrip()
    return "\n".join((
        base,
        "",
        "<complete-job-description>",
        original_jd,
        "</complete-job-description>",
        "",
        "<complete-core-evidence-inventory>",
        canonical_json(evidence),
        "</complete-core-evidence-inventory>",
    ))


def _plain_worker(
    *, repo_root: Path, phase: str, prompt_version: str, original_jd: str,
    evidence: dict[str, Any], task_dir: Path, settings: SimpleRunnerSettings,
    codex_path: str, effort: str,
) -> WorkerRun:
    return run_worker(
        phase=phase,
        prompt_version=prompt_version,
        prompt=_plain_prompt(
            repo_root=repo_root,
            prompt_version=prompt_version,
            original_jd=original_jd,
            evidence=evidence,
        ),
        schema=None,
        task_dir=task_dir,
        model=settings.model,
        effort=effort,
        timeout_seconds=settings.timeout_seconds,
        codex_path=codex_path,
        maximum_output_bytes=settings.maximum_output_bytes,
        memory_enabled=False,
    )


def _normalized_plain_output(output: str) -> str:
    normalized = output.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        raise ValueError("model output is empty")
    return normalized


_HARD_REQUIREMENT_CATEGORIES = {
    "minimum_experience",
    "industry_experience",
    "role_specific_experience",
    "role_defining_credential",
}
_ABSOLUTE_BAR_CUE_PATTERN = re.compile(
    r"(?:\bminimum\b|\bmust\s+have\b|\brequired\b|\brequires\b|\bat\s+least\b|"
    r"\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s+years?\b)",
    re.IGNORECASE,
)
# Categories that can never be a hard mismatch, split by where it is safe to
# look for them. "always" terms are scanned in the model's characterization of
# the requirement and in its JD quote; "assertion-only" terms are scanned in the
# characterization alone, because words such as "travel" or "you will" appear
# routinely inside the same sentence as a genuine experience floor. This split
# mirrors src/lib/experienceScoringPolicy.ts exactly.
_EXCLUDED_HARD_REQUIREMENT_PATTERNS = (
    (re.compile(r"\b(?:preferred|nice[ -]to[ -]have|bonus|ideally|desired)\b", re.IGNORECASE),
     "preferred or nice-to-have", "always"),
    (re.compile(
        r"\b(?:citizen(?:ship)?|nationality|work authori[sz]ation|authori[sz]ed to work|visa sponsorship|"
        r"security clearance)\b",
        re.IGNORECASE,
    ), "administrative eligibility", "always"),
    (re.compile(
        r"\b(?:background check|drug screen|driver(?:'s)? licen[cs]e|driving record|travel|relocat(?:e|ion))\b",
        re.IGNORECASE,
    ), "administrative eligibility", "assertion_only"),
    (re.compile(
        r"\b(?:lift(?:ing)?|push(?:ing)?|pull(?:ing)?|carry(?:ing)?|overhead work|physical(?:ly)? demands?)\b",
        re.IGNORECASE,
    ), "physical demand", "always"),
    (re.compile(r"\b(?:load(?:ing)?|unload(?:ing)?|standing|walking|reaching)\b", re.IGNORECASE),
     "physical demand", "assertion_only"),
    (re.compile(
        r"\b(?:(?:excellent|strong|exceptional|outstanding)\s+(?:communication|presentation|interpersonal|leadership|"
        r"storytelling|negotiation)\s+(?:skill|skills|ability|abilities)|team player|self[- ]starter|passionate?|"
        r"comfortable\s+with)\b",
        re.IGNORECASE,
    ), "subjective trait or skill", "assertion_only"),
    (re.compile(r"\b(?:responsible for|responsibilities include|duties include|day[- ]to[- ]day|you will|you'll)\b", re.IGNORECASE),
     "ordinary duty", "assertion_only"),
)


def excluded_requirement_label(requirement: str, exact_quote: str) -> str | None:
    for pattern, label, scope in _EXCLUDED_HARD_REQUIREMENT_PATTERNS:
        if pattern.search(requirement) or (scope == "always" and pattern.search(exact_quote)):
            return label
    return None


def _json_hard_requirements(output: str) -> list[dict[str, str]] | None:
    candidates = [output]
    first = output.find("{")
    last = output.rfind("}")
    if first >= 0 and last > first:
        candidates.append(output[first:last + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict):
            continue
        raw = value.get("hardRequirementsNotMet")
        if isinstance(raw, list):
            result: list[dict[str, str]] = []
            for entry in raw:
                if not isinstance(entry, dict):
                    raise ValueError("hard-gate mismatch entries must be structured objects")
                fields = ("requirement", "category", "jdQuote", "absoluteBarCue", "inventoryComparison")
                if set(entry) != set(fields) or any(not isinstance(entry[field], str) or not entry[field].strip() for field in fields):
                    raise ValueError("hard-gate mismatch is missing structured evidence")
                result.append({field: entry[field].strip() for field in fields})
            return result
    return None


_NO_HARD_REQUIREMENT_PATTERNS = (
    re.compile(r"^\s*no\b", re.IGNORECASE),
    re.compile(r"\b(?:no|zero)\s+(?:explicit\s+)?(?:unmet\s+)?(?:hard|mandatory|required)\s+requirements?\b", re.IGNORECASE),
    re.compile(r"\b(?:none|no hard requirements identified|did not identify any hard requirements)\b", re.IGNORECASE),
)
def _bind_hard_requirement_evidence(
    mismatches: list[dict[str, str]], original_jd: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Keep the assertions that hold up; report the ones that do not.

    A rejected assertion is not a broken job. The policy lists categories that
    can never be a hard mismatch and requires an absolute-bar cue in the quoted
    text, so an assertion failing either test means *this is not a hard
    requirement* — which is the same conclusion as finding none at all. Failing
    the whole job instead threw away 12 of 18 releases in the first post-fix
    run, including six where the only stated reason was a preferred
    qualification or a lifting requirement.

    A discarded assertion can only ever make the gate more permissive, and the
    job still has to earn its score from the holistic pass. Every surviving
    assertion passes exactly the checks it did before.
    """
    bound: list[dict[str, Any]] = []
    discarded: list[str] = []
    for index, mismatch in enumerate(mismatches):
        category = mismatch["category"]
        if category not in _HARD_REQUIREMENT_CATEGORIES:
            discarded.append(f"mismatch {index}: excluded requirement category {category!r}")
            continue
        quote = mismatch["jdQuote"]
        start = original_jd.find(quote)
        if start < 0:
            # An inexact quote cannot be verified against the posting, so the
            # assertion carries no evidence either way.
            discarded.append(f"mismatch {index}: JD quote is not exact")
            continue
        cue = mismatch["absoluteBarCue"]
        if cue not in quote or _ABSOLUTE_BAR_CUE_PATTERN.search(cue) is None:
            discarded.append(f"mismatch {index}: no recognized absolute-bar cue")
            continue
        inventory_comparison = mismatch["inventoryComparison"]
        if len(inventory_comparison) < 20 \
            or re.search(r"\b(?:inventory|evidence)\b", inventory_comparison, re.IGNORECASE) is None \
            or re.search(r"\b(?:absent|below|does not|doesn't|lacks?|no|not|only|under)\b", inventory_comparison, re.IGNORECASE) is None:
            discarded.append(f"mismatch {index}: insufficient inventory comparison")
            continue
        excluded_label = excluded_requirement_label(mismatch["requirement"], quote)
        if excluded_label is not None:
            discarded.append(f"mismatch {index}: excluded {excluded_label} requirement")
            continue
        bound.append({
            "requirement": mismatch["requirement"],
            "category": category,
            "source": {
                "startCodePoint": start,
                "endCodePoint": start + len(quote),
                "exactQuote": quote,
            },
            "absoluteBarCue": cue,
            "inventoryComparison": inventory_comparison,
        })
    return bound, discarded


def parse_hard_gate_output(
    output: str, maximum_items: int = 20, original_jd: str | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    normalized = _normalized_plain_output(output)
    json_result = _json_hard_requirements(normalized)
    if json_result is not None:
        if len(json_result) > maximum_items:
            raise ValueError(f"hard-gate output exceeds {maximum_items} requirements")
        if any(any(len(value) > 4000 for value in item.values()) for item in json_result):
            raise ValueError("hard-gate requirement evidence exceeds 4000 characters")
        if not json_result:
            return [], []
        if original_jd is None:
            raise ValueError("hard-gate mismatch validation requires the original JD")
        return _bind_hard_requirement_evidence(json_result, original_jd)
    if any(pattern.search(normalized) for pattern in _NO_HARD_REQUIREMENT_PATTERNS):
        return [], []
    raise ValueError("hard-gate mismatch output must provide structured evidence JSON")


def _json_score(output: str) -> int | None:
    candidates = [output]
    first = output.find("{")
    last = output.rfind("}")
    if first >= 0 and last > first:
        candidates.append(output[first:last + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict):
            continue
        for key in ("expertise_fit_score", "experienceFitScore", "expertiseFitScore", "score"):
            score = value.get(key)
            if isinstance(score, int) and not isinstance(score, bool) and 0 <= score <= 100:
                return score
    return None


_SCORE_PATTERNS = (
    re.compile(r"\b(?:expertise|experience)\s+fit\s+score\s*[:=-]?\s*(100|\d{1,2})\b", re.IGNORECASE),
    re.compile(r"\bscore\s*[:=-]\s*(100|\d{1,2})\b", re.IGNORECASE),
    re.compile(r"\b(100|\d{1,2})\s*/\s*100\b"),
    re.compile(r"^\s*(100|\d{1,2})(?:\s*/\s*100)?\b"),
)


def parse_holistic_output(output: str) -> tuple[int, str]:
    normalized = _normalized_plain_output(output)
    json_score = _json_score(normalized)
    if json_score is not None:
        return json_score, normalized
    for pattern in _SCORE_PATTERNS:
        scores = {int(match.group(1)) for match in pattern.finditer(normalized)}
        if len(scores) == 1:
            return scores.pop(), normalized
        if len(scores) > 1:
            raise ValueError("holistic output contains conflicting score values")
    raise ValueError("holistic output does not contain a recognizable 0-100 score")


def _simple_parent_fields(job: dict[str, Any]) -> dict[str, Any]:
    return {key: job[key] for key in _experience_parent_fields(job, True)}


def _simple_failure_item(
    job: dict[str, Any], workers: list[dict[str, Any]], code: str, detail: str,
) -> dict[str, Any]:
    return with_hash(_simple_parent_fields(job) | {
        "workers": workers,
        "result": _safe_failure(code, detail),
    })


def _run_experience_v2(
    *, export_path: Path, output_dir: Path, repo_root: Path,
    model: str | None = None, effort: str | None = None,
) -> tuple[Path, dict[str, int]]:
    exported = load_json(export_path)
    validate_export(exported, repo_root, "experience")
    if exported["schemaVersion"] != "career-dashboard-experience-export-v2":
        raise ValueError("Experience v2 runner accepts only career-dashboard-experience-export-v2")
    validate_current_experience_v2_export(exported, repo_root)
    settings = load_simple_runner_settings(repo_root, model, effort)
    codex_path = assert_model_available(settings.model, settings.hard_gate_effort)
    assert_model_available(settings.model, settings.holistic_effort, codex_path)
    final_schema = load_json(repo_root / "data/scoring/schemas/experience-result-v2.schema.json")
    result_item_schema = final_schema["$defs"]["result"]
    batch_id = safe_task_component(exported["batch"]["id"])
    task_root = output_dir / ".tasks" / batch_id / "experience-v2"
    started_at = utc_timestamp()
    results: list[dict[str, Any]] = []
    counts = {"submitted": len(exported["jobs"]), "accepted": 0, "repaired": 0, "resumed": 0, "safeFailures": 0}

    for job in exported["jobs"]:
        job_dir = task_root / f"{job['ordinal']:02d}-{safe_task_component(job['jobId'])}"

        def produce() -> dict[str, Any]:
            workers: list[dict[str, Any]] = []
            try:
                hard_gate = _plain_worker(
                    repo_root=repo_root,
                    phase="experience_hard_gate",
                    prompt_version="experience-hard-gate-v1",
                    original_jd=job["originalJd"],
                    evidence=exported["evidence"],
                    task_dir=job_dir,
                    settings=settings,
                    codex_path=codex_path,
                    effort=settings.hard_gate_effort,
                )
            except WorkerInvocationError as error:
                return _simple_failure_item(job, [error.receipt], "worker_invocation_failed", str(error))
            workers.append(hard_gate.receipt)
            raw_hard_gate = _normalized_plain_output(str(hard_gate.output))
            try:
                mismatch_evidence, discarded_assertions = parse_hard_gate_output(
                    raw_hard_gate,
                    settings.maximum_hard_requirements,
                    original_jd=job["originalJd"],
                )
            except ValueError as error:
                return _simple_failure_item(job, workers, "output_unusable", str(error))
            if mismatch_evidence:
                mismatches = [entry["requirement"] for entry in mismatch_evidence]
                evaluation = {
                    "kind": "evaluation",
                    "decision": "hard_requirement_mismatch",
                    "hardRequirementsNotMet": mismatches,
                    "hardRequirementEvidence": mismatch_evidence,
                    **({"discardedAssertions": discarded_assertions} if discarded_assertions else {}),
                    "experienceFitScore": settings.hard_requirement_mismatch_score,
                    "rationale": raw_hard_gate,
                    "pass1RawOutput": raw_hard_gate,
                    "pass2RawOutput": None,
                }
                return with_hash(_simple_parent_fields(job) | {"workers": workers, "result": evaluation})
            try:
                holistic = _plain_worker(
                    repo_root=repo_root,
                    phase="experience_holistic",
                    prompt_version="experience-holistic-v1",
                    original_jd=job["originalJd"],
                    evidence=exported["evidence"],
                    task_dir=job_dir,
                    settings=settings,
                    codex_path=codex_path,
                    effort=settings.holistic_effort,
                )
            except WorkerInvocationError as error:
                return _simple_failure_item(job, [*workers, error.receipt], "worker_invocation_failed", str(error))
            workers.append(holistic.receipt)
            raw_holistic = _normalized_plain_output(str(holistic.output))
            try:
                score, rationale = parse_holistic_output(raw_holistic)
            except ValueError as error:
                return _simple_failure_item(job, workers, "output_unusable", str(error))
            evaluation = {
                "kind": "evaluation",
                "decision": "scored",
                "hardRequirementsNotMet": [],
                **({"discardedAssertions": discarded_assertions} if discarded_assertions else {}),
                "experienceFitScore": score,
                "rationale": rationale,
                "pass1RawOutput": raw_hard_gate,
                "pass2RawOutput": raw_holistic,
            }
            return with_hash(_simple_parent_fields(job) | {"workers": workers, "result": evaluation})

        item, resumed = _checkpoint(
            task_dir=job_dir,
            input_hash=job["inputHash"],
            result_schema=result_item_schema,
            schema_root=final_schema,
            produce=produce,
        )
        results.append(item)
        counts["accepted"] += int(item["result"]["kind"] == "evaluation")
        counts["resumed"] += int(resumed)
        counts["safeFailures"] += int(item["result"]["kind"] == "safe_failure")

    completed_at = utc_timestamp()
    overall_effort = "high" if any(
        receipt["effort"] == "high" for item in results for receipt in item["workers"]
    ) else settings.hard_gate_effort
    result = with_hash({
        "schemaVersion": "career-dashboard-experience-result-v2",
        "batch": {
            **{key: exported["batch"][key] for key in ("id", "stage", "protocolVersion", "policyVersion", "manifestHash")},
            "exportSchemaVersion": exported["batch"]["exportSchemaVersion"],
            "resultSchemaVersion": "career-dashboard-experience-result-v2",
        },
        "resumeHash": exported["resume"]["hash"],
        "evidenceHash": exported["evidence"]["evidenceHash"],
        "runner": {
            "runnerVersion": RUNNER_VERSION,
            "model": settings.model,
            "effort": overall_effort,
            "promptVersion": "experience-two-pass-v1",
            "startedAt": started_at,
            "completedAt": completed_at,
            "invocationReceipt": f"isolated-workers:{sum(len(item['workers']) for item in results)};batch:{batch_id}",
        },
        "results": results,
    })
    validate_result_against_export(result, exported, repo_root)
    output_path = output_dir / f"career-dashboard-experience-results-{batch_id}.json"
    atomic_write_json(output_path, result)
    return output_path, counts


def run_experience(
    *, export_path: Path, output_dir: Path, repo_root: Path,
    model: str | None = None, effort: str | None = None,
) -> tuple[Path, dict[str, int]]:
    exported = load_json(export_path)
    if exported.get("schemaVersion") == "career-dashboard-experience-export-v1":
        return _run_historical_experience_v1(
            export_path=export_path,
            output_dir=output_dir,
            repo_root=repo_root,
            model=model,
            effort=effort,
        )
    return _run_experience_v2(
        export_path=export_path,
        output_dir=output_dir,
        repo_root=repo_root,
        model=model,
        effort=effort,
    )
