"""The certificate types a ticket can be issued for — one canonical list.

`value` is the stable internal identifier that everything else keys off
(stored in `tickets.certificate_type` locally and in Supabase, matched
against the certificate queues an Admission employee selected). `label`
is Arabic display text only — never store or compare on it, because
rewording a label must never silently orphan the tickets already
issued under it.

This list is mirrored in TypeScript for the web app at
vercel-app/lib/certificates.ts. The two files MUST stay in sync;
tests/test_certificates.py parses the .ts file and fails if they ever
drift, so this comment is enforced rather than aspirational.
"""
from __future__ import annotations

CERTIFICATE_TYPES: tuple[tuple[str, str], ...] = (
    ("ig", "شهادة الدبلومه البريطانية"),
    ("saudi", "شهادة سعودية"),
    ("qatari", "شهادة قطرية"),
    ("bahraini", "شهادة بحرينية"),
    ("kuwaiti", "شهادة كويتية"),
    ("omani", "شهادة عمانية"),
    ("yemeni", "شهادة يمنية"),
    ("palestinian", "شهادة فلسطينية (توجيهي)"),
    ("egyptian", "الثانوية العامة المصرية"),
    ("azhar", "الثانوية الأزهرية"),
    ("emirati", "الشهادة الإماراتية"),
    ("americanDiploma", "الدبلومة الأمريكية"),
    ("other", "أخرى"),
)

CERTIFICATE_VALUES: frozenset[str] = frozenset(value for value, _ in CERTIFICATE_TYPES)

_LABELS = dict(CERTIFICATE_TYPES)


def certificate_label(value: str | None) -> str:
    """Display text for a stored certificate value. Unknown/missing
    values render as a dash rather than raising — a ticket printed
    before this feature existed (certificate_type IS NULL) must still
    be listable and callable, not crash a screen."""
    if not value:
        return "—"
    return _LABELS.get(value, value)


def is_valid_certificate(value: str | None) -> bool:
    return value in CERTIFICATE_VALUES
