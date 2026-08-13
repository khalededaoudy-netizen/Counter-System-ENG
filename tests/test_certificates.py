"""Guards the one rule the two certificate lists depend on: the Python
list (desktop app) and the TypeScript list (web app) describe the same
certificates, in the same order, with the same stable `value` ids.

They can't literally share a file across the two languages, so this
test parses the .ts source and compares. If someone adds a certificate
to one side only, tickets printed under it would be unlabelable (or
uncallable) on the other side — that's the failure this catches.
"""
from __future__ import annotations

import re
from pathlib import Path

from app.core.certificates import (
    CERTIFICATE_TYPES,
    certificate_label,
    is_valid_certificate,
)

TS_FILE = Path(__file__).resolve().parent.parent / "vercel-app" / "lib" / "certificates.ts"

# { value: "ig", label: "..." } — tolerant of whitespace, strict about shape.
ENTRY_RE = re.compile(
    r'\{\s*value:\s*"(?P<value>[^"]+)"\s*,\s*label:\s*"(?P<label>[^"]+)"\s*\}'
)


def parse_ts_certificates() -> list[tuple[str, str]]:
    source = TS_FILE.read_text(encoding="utf-8")
    # Only the array literal, so the doc-comment examples above it can
    # never be mistaken for real entries.
    array_body = source.split("CERTIFICATE_TYPES: CertificateType[] = [", 1)[1].split("];", 1)[0]
    return [(m.group("value"), m.group("label")) for m in ENTRY_RE.finditer(array_body)]


def test_python_and_typescript_certificate_lists_match():
    assert parse_ts_certificates() == list(CERTIFICATE_TYPES)


def test_certificate_values_are_unique():
    values = [value for value, _ in CERTIFICATE_TYPES]
    assert len(values) == len(set(values))


def test_the_thirteen_expected_certificates_are_present():
    assert [value for value, _ in CERTIFICATE_TYPES] == [
        "ig",
        "saudi",
        "qatari",
        "bahraini",
        "kuwaiti",
        "omani",
        "yemeni",
        "palestinian",
        "egyptian",
        "azhar",
        "emirati",
        "americanDiploma",
        "other",
    ]


def test_label_lookup_and_validation():
    assert certificate_label("egyptian") == "الثانوية العامة المصرية"
    assert is_valid_certificate("egyptian")
    assert not is_valid_certificate("not-a-real-certificate")

    # A ticket printed before certificates existed has no type — every
    # screen must still render it instead of blowing up.
    assert certificate_label(None) == "—"
    assert not is_valid_certificate(None)
