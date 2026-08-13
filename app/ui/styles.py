"""A single, simple stylesheet — large text and high-contrast colors
because this screen is operated by a non-technical employee, often
under time pressure, and must be readable at a glance."""

STYLESHEET = """
QWidget {
    background-color: #f4f6f8;
    font-family: "Segoe UI", sans-serif;
    color: #1f2937;
}

QPushButton#testModeButton {
    font-size: 15px;
    font-weight: 700;
    color: #b45309;
    background-color: #fef3c7;
    border: 1px solid #f59e0b;
    border-radius: 8px;
    padding: 12px;
}
QPushButton#testModeButton:hover { background-color: #fde68a; }
QPushButton#testModeButton:disabled { color: #a3a3a3; background-color: #f1f1f1; border-color: #d4d4d4; }

QPushButton#resetButton {
    font-size: 12px;
    font-weight: 700;
    color: #b91c1c;
    background-color: transparent;
    border: 1px solid #fca5a5;
    border-radius: 8px;
    padding: 8px;
}
QPushButton#resetButton:hover { background-color: #fee2e2; }

QLabel#title {
    font-size: 26px;
    font-weight: 700;
    color: #1e3a8a;
}

QLabel#sectionLabel {
    font-size: 14px;
    color: #6b7280;
    font-weight: 600;
}

QLabel#bigNumber {
    font-size: 72px;
    font-weight: 800;
    color: #111827;
}

QLabel#nextNumber {
    font-size: 40px;
    font-weight: 700;
    color: #2563eb;
}

QLabel#statValue {
    font-size: 28px;
    font-weight: 700;
    color: #111827;
}

QLabel#statusReady {
    font-size: 16px;
    font-weight: 700;
    color: #15803d;
}

QLabel#statusError {
    font-size: 16px;
    font-weight: 700;
    color: #b91c1c;
}

QLabel#statusPending {
    font-size: 16px;
    font-weight: 700;
    color: #b45309;
}

QPushButton#printButton {
    font-size: 24px;
    font-weight: 800;
    color: white;
    background-color: #2563eb;
    border-radius: 10px;
    padding: 22px;
}
QPushButton#printButton:hover { background-color: #1d4ed8; }
QPushButton#printButton:disabled { background-color: #93a3b8; }

QPushButton#retryButton {
    font-size: 16px;
    font-weight: 700;
    color: white;
    background-color: #b45309;
    border-radius: 8px;
    padding: 12px;
}
QPushButton#retryButton:hover { background-color: #92400e; }

QPushButton#cancelButton {
    font-size: 14px;
    color: #b91c1c;
    background-color: transparent;
    border: 1px solid #b91c1c;
    border-radius: 8px;
    padding: 10px;
}
QPushButton#cancelButton:hover { background-color: #fee2e2; }

QFrame#card {
    background-color: white;
    border-radius: 12px;
    border: 1px solid #e5e7eb;
}

QFrame#warningBanner {
    background-color: #fef3c7;
    border: 1px solid #f59e0b;
    border-radius: 8px;
}

QLabel#certDialogTitle {
    font-size: 22px;
    font-weight: 800;
    color: #1e3a8a;
}

QLabel#certDialogHint {
    font-size: 13px;
    color: #6b7280;
}

QPushButton#certButton {
    font-size: 15px;
    font-weight: 700;
    color: #1f2937;
    background-color: white;
    border: 2px solid #cbd5e1;
    border-radius: 10px;
    padding: 12px 10px;
    text-align: center;
}
QPushButton#certButton:hover {
    background-color: #eff6ff;
    border-color: #2563eb;
    color: #1d4ed8;
}
QPushButton#certButton:pressed { background-color: #dbeafe; }

QPushButton#certCancelButton {
    font-size: 14px;
    font-weight: 700;
    color: #b91c1c;
    background-color: transparent;
    border: 1px solid #fca5a5;
    border-radius: 8px;
    padding: 10px;
}
QPushButton#certCancelButton:hover { background-color: #fee2e2; }

QLabel#certificateLabel {
    font-size: 15px;
    font-weight: 700;
    color: #1d4ed8;
}

QTextEdit#logPanel {
    background-color: #0f172a;
    color: #d1d5db;
    font-family: Consolas, monospace;
    font-size: 11px;
    border-radius: 8px;
}
"""
