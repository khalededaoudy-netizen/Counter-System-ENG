"""Entry point for the desktop ticket printing application."""
from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication, QMessageBox

from app.config import load_config
from app.logging_config import setup_logging


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("University Queue Ticket Printer")

    try:
        config = load_config()
    except FileNotFoundError as e:
        QMessageBox.critical(None, "Configuration missing", str(e))
        return 1

    setup_logging(config.resolve_path(config.logging.dir), config.logging.level)

    from app.ui.main_window import MainWindow  # imported after logging is set up

    window = MainWindow(config)
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
