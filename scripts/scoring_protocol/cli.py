from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from .runner import run_aim, run_experience


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def run_stage(stage: str, argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=f"Run one database-free Career Dashboard {stage.title()} scoring export")
    parser.add_argument("export", type=Path, help=f"exact Career Dashboard {stage.title()} export JSON")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path.home() / "Desktop" / "Career Dashboard Scoring",
        help="Finder-visible result and resumable task directory",
    )
    parser.add_argument("--model", default=None, help="exact installed Codex model identifier; never falls back")
    parser.add_argument("--effort", choices=("medium",), default=None, help="initial effort; High is reserved for bounded repairs")
    arguments = parser.parse_args(argv)
    function = run_aim if stage == "aim" else run_experience
    output_path, counts = function(
        export_path=arguments.export.resolve(),
        output_dir=arguments.output_dir.expanduser().resolve(),
        repo_root=repo_root(),
        model=arguments.model,
        effort=arguments.effort,
    )
    print(json.dumps({"stage": stage, "validatorStatus": "valid", "outputPath": str(output_path), **counts}, sort_keys=True))
    return 0
