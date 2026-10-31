"""Command-line access to the AI service jobs (FR-22 retraining, FR-17 forecasting).

Run from the ai-service folder:

    python scripts/train_cli.py                       # retrain (same as POST /ai/models/retrain)
    python scripts/train_cli.py retrain --search-iter 4
    python scripts/train_cli.py list                  # model registry
    python scripts/train_cli.py activate rf-20261030-0915
    python scripts/train_cli.py forecast --days 7     # same as POST /ai/jobs/forecast

DATABASE_URL / MODELS_DIR come from the environment or .env unless given as options.
Exit code 0 on success, 1 when the job was refused (e.g. fewer than 200 labelled tokens).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

# Make the ``app`` package importable when the script is run as ``python scripts/train_cli.py``.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.config import settings  # noqa: E402


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Smart OPD AI service jobs")
    parser.add_argument("--database-url", help="override DATABASE_URL")
    parser.add_argument("--models-dir", help="override MODELS_DIR")
    sub = parser.add_subparsers(dest="command")

    retrain = sub.add_parser("retrain", help="train, evaluate and register a new waiting-time model")
    retrain.add_argument("--search-iter", type=int, help="RandomizedSearchCV iterations (default AI_SEARCH_ITER)")
    retrain.add_argument("--min-rows", type=int, help="minimum labelled tokens (default AI_MIN_TRAINING_ROWS=200)")

    sub.add_parser("list", help="list registered model versions")

    activate = sub.add_parser("activate", help="make a registered version the active model")
    activate.add_argument("version")

    forecast = sub.add_parser("forecast", help="regenerate hourly arrival/congestion forecasts")
    forecast.add_argument("--days", type=int, default=7)

    args = parser.parse_args(argv)
    if args.command is None:
        args.command = "retrain"
        args.search_iter = None
        args.min_rows = None
    return args


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args = _parse_args(argv)

    if args.models_dir:
        settings.models_dir = Path(args.models_dir)
    if args.database_url:
        db.reset_engine(args.database_url)

    # Imported after the settings overrides so every module sees the same configuration.
    from app.forecasting import ForecastBusyError, run_forecast
    from app.training import ModelNotFoundError, TrainingError, activate, list_models, retrain

    try:
        if args.command == "retrain":
            if args.search_iter:
                settings.search_iter = max(1, args.search_iter)
            if args.min_rows:
                settings.min_training_rows = max(1, args.min_rows)
            result = retrain()
        elif args.command == "list":
            result = list_models()
        elif args.command == "activate":
            result = activate(args.version)
        else:
            result = run_forecast(args.days)
    except (TrainingError, ModelNotFoundError, ForecastBusyError) as exc:
        print(json.dumps({"error": str(exc)}, indent=2), file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
