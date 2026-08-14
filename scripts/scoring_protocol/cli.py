from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Sequence

from .common import atomic_copy_file, load_json
from .runner import run_aim, run_experience


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def project_output_dir() -> Path:
    return repo_root() / "data" / "scoring" / "results"


def publish_desktop_upload_copy(stage: str, output_path: Path, desktop_dir: Path | None = None) -> Path:
    if stage not in {"aim", "experience"}:
        raise ValueError("Desktop upload copy stage must be aim or experience")
    result = load_json(output_path)
    batch = result.get("batch")
    batch_id = batch.get("id") if isinstance(batch, dict) else None
    try:
        safe_batch_id = str(uuid.UUID(str(batch_id)))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("validated scoring result is missing a valid batch ID") from error
    destination = (desktop_dir or Path.home() / "Desktop") / f"career-dashboard-{stage}-upload-{safe_batch_id}.json"
    atomic_copy_file(output_path, destination)
    return destination


def run_stage(stage: str, argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=f"Run one database-free Career Dashboard {stage.title()} scoring export")
    parser.add_argument("export", type=Path, help=f"exact Career Dashboard {stage.title()} export JSON")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=project_output_dir(),
        help="canonical project result and resumable task directory",
    )
    parser.add_argument("--model", default=None, help="exact installed Codex model identifier; never falls back")
    parser.add_argument("--effort", choices=("medium",), default=None, help="select the governed Medium entrypoint; each runner owns later phase effort")
    parser.add_argument(
        "--force-fresh-calibration",
        action="store_true",
        help="Aim only: bypass production cache and emit a non-importable calibration artifact",
    )
    arguments = parser.parse_args(argv)
    function = run_aim if stage == "aim" else run_experience
    if stage != "aim" and arguments.force_fresh_calibration:
        parser.error("--force-fresh-calibration is supported only for Aim")
    run_options = {
        "export_path": arguments.export.resolve(),
        "output_dir": arguments.output_dir.expanduser().resolve(),
        "repo_root": repo_root(),
        "model": arguments.model,
        "effort": arguments.effort,
    }
    if stage == "aim":
        run_options["force_fresh_calibration"] = arguments.force_fresh_calibration
        run_options["calibration_run_id"] = str(uuid.uuid4()) if arguments.force_fresh_calibration else None
    output_path, counts = function(**run_options)
    desktop_upload_path = None if arguments.force_fresh_calibration else publish_desktop_upload_copy(stage, output_path)
    print(json.dumps({
        "stage": stage,
        "validatorStatus": "valid",
        "outputPath": str(output_path),
        "projectOutputPath": str(output_path),
        "desktopUploadPath": str(desktop_upload_path) if desktop_upload_path else None,
        **counts,
    }, sort_keys=True))
    return 0
