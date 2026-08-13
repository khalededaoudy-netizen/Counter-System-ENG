"""Application-wide logging setup.

Writes a rotating log file under data/logs/ and echoes to the console.
The UI attaches its own handler (see ui/main_window.py) to mirror
messages into the on-screen log panel so a non-technical employee can
see what happened without opening a file.
"""
from __future__ import annotations

import logging
import logging.handlers
from pathlib import Path

_LOG_FORMAT = "%(asctime)s %(levelname)-8s %(name)-22s %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def setup_logging(log_dir: str | Path, level: str = "INFO") -> logging.Logger:
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    root = logging.getLogger("queue_system")
    root.setLevel(level)
    root.handlers.clear()

    formatter = logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT)

    file_handler = logging.handlers.RotatingFileHandler(
        log_dir / "app.log", maxBytes=2_000_000, backupCount=10, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    root.addHandler(console_handler)

    return root


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"queue_system.{name}")
