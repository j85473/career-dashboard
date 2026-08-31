#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from scoring_protocol.cli import project_output_dir, repo_root
from scoring_protocol.run_bundle import run_scoring_bundle


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one whole-queue Career Dashboard scoring export bundle")
    parser.add_argument("export", type=Path, help="exact START-AIM-FIT-RUN or START-E-FIT-RUN JSON")
    parser.add_argument("--output-dir", type=Path, default=project_output_dir())
    parser.add_argument("--delivery-dir", type=Path, default=Path.home() / "Desktop")
    parser.add_argument("--model", default=None, help="exact installed Codex model identifier; never falls back")
    parser.add_argument("--effort", choices=("medium",), default=None)
    arguments = parser.parse_args()
    result = run_scoring_bundle(
        export_path=arguments.export.expanduser().resolve(),
        output_dir=arguments.output_dir.expanduser().resolve(),
        delivery_dir=arguments.delivery_dir.expanduser().resolve(),
        repo_root=repo_root(),
        model=arguments.model,
        effort=arguments.effort,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
