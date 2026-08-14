from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .common import atomic_write_json, utc_timestamp
from .contracts import validate_schema

DISABLED_FEATURES = (
    "shell_tool",
    "apps",
    "browser_use",
    "browser_use_external",
    "in_app_browser",
    "computer_use",
    "image_generation",
    "multi_agent",
    "goals",
    "hooks",
    "plugins",
    "plugin_sharing",
    "memories",
    "skill_search",
    "tool_suggest",
)
FORBIDDEN_ITEM_TYPES = {
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "computer_use",
    "image_generation",
}


@dataclass(frozen=True)
class WorkerRun:
    output: Any
    receipt: dict[str, Any]
    raw_output: str | None = None


@dataclass(frozen=True)
class InstalledModel:
    efforts: frozenset[str]
    context_window: int


class WorkerInvocationError(RuntimeError):
    """A bounded worker failure with exact attempted-invocation provenance."""

    def __init__(self, message: str, receipt: dict[str, Any], raw_output: str | None = None):
        super().__init__(message)
        self.receipt = receipt
        self.raw_output = raw_output


def installed_models(codex_path: str) -> dict[str, InstalledModel]:
    completed = subprocess.run(
        [codex_path, "debug", "models"],
        shell=False,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"could not inspect installed Codex models: {completed.stderr[-1000:]}")
    try:
        catalog = json.loads(completed.stdout)
        result: dict[str, InstalledModel] = {}
        for model in catalog["models"]:
            levels = model.get("supported_reasoning_efforts", model.get("supported_reasoning_levels"))
            if not isinstance(levels, list):
                raise TypeError("missing supported reasoning efforts")
            efforts = frozenset(
                level["effort"] if isinstance(level, dict) else level
                for level in levels
            )
            context_window = model["context_window"]
            if not isinstance(context_window, int) or isinstance(context_window, bool) or context_window <= 0:
                raise TypeError("invalid context window")
            result[model["slug"]] = InstalledModel(efforts=efforts, context_window=context_window)
        return result
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("installed Codex model catalog is not parseable") from error


def assert_model_available(model: str, effort: str, codex_path: str | None = None) -> str:
    resolved = codex_path or shutil.which("codex")
    if not resolved:
        raise RuntimeError("codex CLI is not installed or not on PATH")
    catalog = installed_models(resolved)
    if model not in catalog or effort not in catalog[model].efforts:
        raise RuntimeError(f"requested model/effort is unavailable: {model}/{effort}; no fallback was attempted")
    return resolved


def selected_model_context_window(model: str, codex_path: str) -> int:
    catalog = installed_models(codex_path)
    if model not in catalog:
        raise RuntimeError(f"requested model is unavailable: {model}; no fallback was attempted")
    return catalog[model].context_window


def build_worker_command(
    *, codex_path: str, model: str, effort: str, task_dir: Path,
    schema_path: Path | None, output_path: Path, memory_enabled: bool = False,
) -> list[str]:
    command = [
        codex_path,
        "exec",
        "--strict-config",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--cd",
        str(task_dir),
        "--model",
        model,
        "--config",
        f'model_reasoning_effort="{effort}"',
        "--config",
        'approval_policy="never"',
    ]
    for feature in DISABLED_FEATURES:
        if feature == "memories" and memory_enabled:
            continue
        command.extend(("--disable", feature))
    if memory_enabled:
        command.extend(("--enable", "memories"))
    if schema_path is not None:
        command.extend(("--output-schema", str(schema_path)))
    command.extend(("--output-last-message", str(output_path), "--json", "-"))
    return command


def codex_failure_detail(stdout: str, stderr: str) -> str:
    jsonl_error = ""
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "error" and isinstance(event.get("message"), str):
            jsonl_error = event["message"]
        elif event.get("type") == "turn.failed" and isinstance(event.get("error"), dict):
            message = event["error"].get("message")
            if isinstance(message, str):
                jsonl_error = message
    return jsonl_error or stderr[-2000:] or "no diagnostic output"


def run_worker(
    *,
    phase: str,
    prompt_version: str,
    prompt: str,
    schema: dict[str, Any] | None,
    task_dir: Path,
    model: str,
    effort: str,
    timeout_seconds: int,
    codex_path: str,
    maximum_output_bytes: int | None = None,
    memory_enabled: bool = False,
) -> WorkerRun:
    task_dir.mkdir(parents=True, exist_ok=True)
    schema_path = None if schema is None else task_dir / f"{phase}.output-schema.json"
    output_path = task_dir / f"{phase}.output.{ 'txt' if schema is None else 'json' }"
    if schema_path is not None:
        atomic_write_json(schema_path, schema)
    # `--output-last-message` is an output file, not an append-only receipt.
    # Remove any earlier attempt before invoking Codex so a nominally successful
    # process that fails to emit a new result can never reuse stale JSON.
    output_path.unlink(missing_ok=True)
    started_at = utc_timestamp()
    thread_id = "unknown"

    def failed(message: str) -> WorkerInvocationError:
        raw_output: str | None = None
        try:
            if output_path.exists():
                raw_output = output_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            raw_output = None
        return WorkerInvocationError(message, {
            "phase": phase,
            "model": model,
            "effort": effort,
            "promptVersion": prompt_version,
            "startedAt": started_at,
            "completedAt": utc_timestamp(),
            "invocationReceipt": f"codex-thread:{thread_id};failed",
        }, raw_output=raw_output)

    command = build_worker_command(
        codex_path=codex_path,
        model=model,
        effort=effort,
        task_dir=task_dir,
        schema_path=schema_path,
        output_path=output_path,
        memory_enabled=memory_enabled,
    )
    try:
        completed = subprocess.run(
            command,
            input=prompt,
            shell=False,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise failed(f"{phase} exceeded the {timeout_seconds}-second invocation timeout") from error
    completed_at = utc_timestamp()
    for line in completed.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise failed(f"{phase} emitted non-JSONL output") from error
        if event.get("type") == "thread.started":
            thread_id = str(event.get("thread_id", "unknown"))
        item = event.get("item")
        if isinstance(item, dict) and item.get("type") in FORBIDDEN_ITEM_TYPES:
            raise failed(f"{phase} attempted forbidden worker capability {item['type']}")
    if completed.returncode != 0:
        raise failed(f"{phase} Codex invocation failed: {codex_failure_detail(completed.stdout, completed.stderr)}")
    try:
        if maximum_output_bytes is not None and output_path.stat().st_size > maximum_output_bytes:
            kind = "plain output" if schema is None else "structured output"
            raise ValueError(f"{kind} exceeds {maximum_output_bytes} bytes")
        raw_output = output_path.read_text(encoding="utf-8")
        if schema is None:
            if not raw_output.strip():
                raise ValueError("plain output is empty")
            output: Any = raw_output
        else:
            output = json.loads(raw_output)
            validate_schema(output, schema)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        kind = "plain output" if schema is None else "structured output"
        raise failed(f"{phase} returned invalid {kind}: {error}") from error
    receipt = {
        "phase": phase,
        "model": model,
        "effort": effort,
        "promptVersion": prompt_version,
        "startedAt": started_at,
        "completedAt": completed_at,
        "invocationReceipt": f"codex-thread:{thread_id}",
    }
    return WorkerRun(output=output, receipt=receipt, raw_output=raw_output)
