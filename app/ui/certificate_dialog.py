"""The "which certificate?" step that now precedes every printed number.

Shown by both the real print button and the test-number button, so a
test ticket exercises exactly the same path a real one does (including
landing in a certificate queue afterwards) rather than being a
different code path that can drift out of sync with production.

Design constraints, in priority order — this screen sits between the
employee and every single ticket they issue, so it is on the critical
path of the whole queue:
  * one tap, no scrolling: all 13 certificates are on screen at once in
    a grid, so issuing a ticket stays a two-tap operation.
  * big targets: touch/mouse under time pressure with a queue waiting.
  * cancellable: closing without choosing must reserve no number at
    all, so an accidental click can't burn a ticket number. The caller
    only reserves *after* this returns a value (see main_window).
"""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog,
    QGridLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
)

from app.core.certificates import CERTIFICATE_TYPES

COLUMNS = 2


class CertificateDialog(QDialog):
    """Modal certificate picker. `selected_value` holds the chosen
    stable id (e.g. "egyptian") after exec() returns Accepted."""

    def __init__(self, parent=None, title: str = "اختر نوع الشهادة"):
        super().__init__(parent)
        self.selected_value: Optional[str] = None

        self.setWindowTitle(title)
        self.setLayoutDirection(Qt.RightToLeft)
        self.setModal(True)
        self.setMinimumWidth(620)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(22, 20, 22, 20)
        layout.setSpacing(14)

        heading = QLabel(title)
        heading.setObjectName("certDialogTitle")
        heading.setAlignment(Qt.AlignCenter)
        layout.addWidget(heading)

        hint = QLabel("اضغط على الشهادة المطلوبة — الرقم هيتطبع بعدها على طول.")
        hint.setObjectName("certDialogHint")
        hint.setAlignment(Qt.AlignCenter)
        hint.setWordWrap(True)
        layout.addWidget(hint)

        grid = QGridLayout()
        grid.setSpacing(10)
        # A trailing odd item ("أخرى") would sit alone in the left
        # column; span it across the full width so the grid stays even.
        # Decided while adding rather than by rearranging the layout
        # afterwards — moving a widget between grid cells after the
        # fact leaves a stale layout item behind and crashes on show().
        last_index = len(CERTIFICATE_TYPES) - 1
        last_is_orphan = len(CERTIFICATE_TYPES) % COLUMNS != 0

        for index, (value, label) in enumerate(CERTIFICATE_TYPES):
            button = QPushButton(label)
            button.setObjectName("certButton")
            button.setCursor(Qt.PointingHandCursor)
            button.setMinimumHeight(58)
            # Bind the value per-iteration; a bare closure over `value`
            # would hand every button the last certificate in the list.
            button.clicked.connect(lambda _checked=False, v=value: self._choose(v))

            row, column = index // COLUMNS, index % COLUMNS
            if index == last_index and last_is_orphan:
                grid.addWidget(button, row, 0, 1, COLUMNS)
            else:
                grid.addWidget(button, row, column)

        layout.addLayout(grid)

        cancel = QPushButton("إلغاء")
        cancel.setObjectName("certCancelButton")
        cancel.clicked.connect(self.reject)
        layout.addWidget(cancel)

    def _choose(self, value: str) -> None:
        self.selected_value = value
        self.accept()


def ask_for_certificate(parent=None, title: str = "اختر نوع الشهادة") -> Optional[str]:
    """Returns the chosen certificate id, or None if the employee
    cancelled/closed the dialog. None must be treated as "do nothing at
    all" by the caller — never as a default certificate."""
    dialog = CertificateDialog(parent, title)
    if dialog.exec() == QDialog.Accepted:
        return dialog.selected_value
    return None
