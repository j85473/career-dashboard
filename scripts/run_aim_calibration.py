#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from scoring_protocol.aim_calibration_bridge import run_historical_aim_calibration


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run one historical Aim corpus through an isolated, non-importable Aim v2 calibration"
    )
    parser.add_argument("export", type=Path, help="exact historical career-dashboard-aim-export-v1 JSON")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path.home() / "Desktop" / "Career Dashboard Scoring",
        help="Finder-visible calibration-result directory",
    )
    parser.add_argument("--model", default=None, help="exact installed Codex model identifier; never falls back")
    parser.add_argument("--effort", choices=("medium",), default=None)
    arguments = parser.parse_args()
    output_path, calibration_input_path, receipt_path, model_outputs_path, counts = run_historical_aim_calibration(
        export_path=arguments.export.expanduser().resolve(),
        output_dir=arguments.output_dir.expanduser().resolve(),
        repo_root=Path(__file__).resolve().parents[1],
        model=arguments.model,
        effort=arguments.effort,
    )
    print(json.dumps({
        "stage": "aim",
        "artifactPurpose": "calibration",
        "importable": False,
        "validatorStatus": "valid",
        "outputPath": str(output_path),
        "calibrationInputPath": str(calibration_input_path),
        "bridgeReceiptPath": str(receipt_path),
        "modelOutputsPath": str(model_outputs_path),
        **counts,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
