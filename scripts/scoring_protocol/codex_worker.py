from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .common import atomic_write_json, load_json, utc_timestamp
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
    output: dict[str, Any]
    receipt: dict[str, Any]


def installed_models(codex_path: str) -> dict[str, set[str]]:
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
        return {
            model["slug"]: {level["effort"] for level in model["supported_reasoning_levels"]}
            for model in catalog["models"]
        }
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("installed Codex model catalog is not parseable") from error


def assert_model_available(model: str, effort: str, codex_path: str | None = None) -> str:
    resolved = codex_path or shutil.which("codex")
    if not resolved:
        raise RuntimeError("codex CLI is not installed or not on PATH")
    catalog = installed_models(resolved)
    if model not in catalog or effort not in catalog[model]:
        raise RuntimeError(f"requested model/effort is unavailable: {model}/{effort}; no fallback was attempted")
    return resolved


def build_worker_command(
    *, codex_path: str, model: str, effort: str, task_dir: Path, schema_path: Path, output_path: Path
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
        command.extend(("--disable", feature))
    command.extend(("--output-schema", str(schema_path), "--output-last-message", str(output_path), "--json", "-"))
    return command


def run_worker(
    *,
    phase: str,
    prompt_version: str,
    prompt: str,
    schema: dict[str, Any],
    task_dir: Path,
    model: str,
    effort: str,
    timeout_seconds: int,
    codex_path: str,
) -> WorkerRun:
    task_dir.mkdir(parents=True, exist_ok=True)
    schema_path = task_dir / f"{phase}.output-schema.json"
    output_path = task_dir / f"{phase}.output.json"
    atomic_write_json(schema_path, schema)
    started_at = utc_timestamp()
    command = build_worker_command(
        codex_path=codex_path,
        model=model,
        effort=effort,
        task_dir=task_dir,
        schema_path=schema_path,
        output_path=output_path,
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
        raise RuntimeError(f"{phase} exceeded the {timeout_seconds}-second invocation timeout") from error
    completed_at = utc_timestamp()
    if completed.returncode != 0:
        raise RuntimeError(f"{phase} Codex invocation failed: {completed.stderr[-2000:]}")
    thread_id = "unknown"
    for line in completed.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"{phase} emitted non-JSONL output") from error
        if event.get("type") == "thread.started":
            thread_id = str(event.get("thread_id", "unknown"))
        item = event.get("item")
        if isinstance(item, dict) and item.get("type") in FORBIDDEN_ITEM_TYPES:
            raise RuntimeError(f"{phase} attempted forbidden worker capability {item['type']}")
    output = load_json(output_path)
    validate_schema(output, schema)
    receipt = {
        "phase": phase,
        "model": model,
        "effort": effort,
        "promptVersion": prompt_version,
        "startedAt": started_at,
        "completedAt": completed_at,
        "invocationReceipt": f"codex-thread:{thread_id}",
    }
    return WorkerRun(output=output, receipt=receipt)
