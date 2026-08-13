"""The certificate picker now sits in front of every printed ticket, so
a fault here stops the counter working entirely.

These run against a real Qt widget on the "offscreen" platform plugin
(no visible window, no display needed). That matters: an earlier
version of this dialog constructed fine and only crashed when actually
shown, so a test that merely instantiated it would have passed while
every print in production died.
"""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QPushButton  # noqa: E402

from app.core.certificates import CERTIFICATE_TYPES  # noqa: E402
from app.ui.certificate_dialog import CertificateDialog  # noqa: E402


@pytest.fixture(scope="module")
def qt_app():
    # One QApplication per process is a Qt hard requirement; reuse it if
    # another test module already created one.
    yield QApplication.instance() or QApplication([])


def test_dialog_can_actually_be_shown(qt_app):
    """Regression: rearranging the grid after populating it left a stale
    layout item and segfaulted on show()."""
    dialog = CertificateDialog()
    dialog.show()          # the step that used to crash
    qt_app.processEvents()
    assert dialog.isVisible()
    dialog.close()


def test_every_certificate_gets_a_button(qt_app):
    dialog = CertificateDialog()
    dialog.show()
    qt_app.processEvents()

    labels = {b.text() for b in dialog.findChildren(QPushButton) if b.objectName() == "certButton"}
    assert labels == {label for _, label in CERTIFICATE_TYPES}
    dialog.close()


def test_clicking_a_button_selects_that_certificates_value(qt_app):
    """Each button must carry its own value — a closure bug here would
    silently file every student under the last certificate in the list."""
    for value, label in CERTIFICATE_TYPES:
        dialog = CertificateDialog()
        dialog.show()
        qt_app.processEvents()

        button = next(
            b
            for b in dialog.findChildren(QPushButton)
            if b.objectName() == "certButton" and b.text() == label
        )
        button.click()

        assert dialog.selected_value == value
        assert dialog.result() == CertificateDialog.Accepted


def test_cancelling_selects_nothing(qt_app):
    """Cancel must yield None so the caller reserves no ticket number —
    a mis-click on "print" must never burn a number."""
    dialog = CertificateDialog()
    dialog.show()
    qt_app.processEvents()
    dialog.reject()

    assert dialog.selected_value is None
