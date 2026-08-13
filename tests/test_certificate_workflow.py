"""Local (SQLite) half of the certificate workflow.

Stages after the first reviewer live in Supabase, so what's testable
here is the part the desktop app owns: that the certificate chosen at
print time is attached to the ticket, survives the failure/retry path,
and doesn't disturb existing numbering or counters.
"""
from __future__ import annotations

import sqlite3

from app.core.database import Database
from app.core.models import TicketStatus
from app.core.session_service import SessionService
from app.core.ticket_service import TicketService


def make_services(tmp_path):
    db = Database(tmp_path / "queue.db")
    return db, SessionService(db), TicketService(db)


def test_certificate_is_stored_with_the_reserved_ticket(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    ticket = tickets.reserve_next_ticket(session.id, "egyptian")
    tickets.mark_printed(ticket.id, "PrinterA")

    assert ticket.certificate_type == "egyptian"
    assert tickets.get_ticket(ticket.id).certificate_type == "egyptian"


def test_certificate_survives_print_failure_and_retry(tmp_path):
    """A failed print keeps the same number AND the same certificate —
    the employee must not be asked to pick it again, and the reprinted
    ticket must not silently land in a different queue."""
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    ticket = tickets.reserve_next_ticket(session.id, "ig")
    tickets.mark_print_failed(ticket.id, "paper jam")

    unresolved = tickets.get_unresolved_ticket(session.id)
    assert unresolved is not None
    assert unresolved.ticket_number == ticket.ticket_number
    assert unresolved.certificate_type == "ig"

    tickets.mark_printed(unresolved.id, "PrinterA")
    assert tickets.get_ticket(ticket.id).certificate_type == "ig"


def test_each_ticket_keeps_its_own_certificate(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    chosen = ["ig", "egyptian", "saudi", "other"]
    created = []
    for value in chosen:
        t = tickets.reserve_next_ticket(session.id, value)
        tickets.mark_printed(t.id, "PrinterA")
        created.append(t)

    assert [tickets.get_ticket(t.id).certificate_type for t in created] == chosen
    assert [t.ticket_number for t in created] == [1, 2, 3, 4]


def test_stats_expose_the_latest_ticket_certificate(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    first = tickets.reserve_next_ticket(session.id, "saudi")
    tickets.mark_printed(first.id, "PrinterA")
    second = tickets.reserve_next_ticket(session.id, "azhar")
    tickets.mark_printed(second.id, "PrinterA")

    stats = tickets.get_today_stats(session.id)
    assert stats["current_number"] == 2
    assert stats["current_certificate"] == "azhar"


def test_tickets_advanced_past_the_first_reviewer_still_count_for_today(tmp_path):
    """The cloud moves tickets to WAITING_FOR_ADMISSION / COMPLETED as
    they progress. Should those statuses ever reach the local mirror,
    the day's count must not shrink — the numbers were still issued."""
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    for status in (
        TicketStatus.PRINTED,
        TicketStatus.CALLED,
        TicketStatus.WAITING_FOR_ADMISSION,
        TicketStatus.CALLED_BY_ADMISSION,
        TicketStatus.COMPLETED,
    ):
        t = tickets.reserve_next_ticket(session.id, "egyptian")
        db.execute("UPDATE tickets SET status=?, printed_at=? WHERE id=?", (status, "2026-01-01T00:00:00", t.id))

    stats = tickets.get_today_stats(session.id)
    assert stats["today_count"] == 5
    assert stats["current_number"] == 5


def test_certificate_is_optional_so_pre_existing_callers_still_work(tmp_path):
    """Reserving without a certificate must stay legal: it's what every
    pre-certificate caller and the whole existing test suite does."""
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    ticket = tickets.reserve_next_ticket(session.id)
    tickets.mark_printed(ticket.id, "PrinterA")

    assert ticket.certificate_type is None
    assert tickets.get_today_stats(session.id)["current_certificate"] is None


def test_database_created_before_certificates_migrates_without_data_loss(tmp_path):
    """A queue.db from the previous release must gain the column on
    first open, keeping every ticket it already had."""
    db_path = tmp_path / "queue.db"

    # Build a "previous release" database: the current schema minus the
    # certificate column, holding one already-printed ticket.
    legacy = sqlite3.connect(str(db_path))
    legacy.executescript(
        """
        CREATE TABLE daily_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, business_date TEXT NOT NULL UNIQUE,
            started_at TEXT NOT NULL, ended_at TEXT, created_at TEXT NOT NULL);
        CREATE TABLE tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
            session_id INTEGER NOT NULL REFERENCES daily_sessions(id),
            ticket_number INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'RESERVED',
            print_attempts INTEGER NOT NULL DEFAULT 0, printed_at TEXT,
            sync_status TEXT NOT NULL DEFAULT 'PENDING_SYNC', synced_at TEXT,
            device_id TEXT, printer_name TEXT, error_message TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE(session_id, ticket_number));
        INSERT INTO daily_sessions(business_date, started_at, created_at)
            VALUES ('2026-01-01', '2026-01-01T09:00:00', '2026-01-01T09:00:00');
        INSERT INTO tickets(uuid, session_id, ticket_number, status, printed_at, created_at, updated_at)
            VALUES ('legacy-uuid', 1, 7, 'PRINTED', '2026-01-01T09:05:00',
                    '2026-01-01T09:05:00', '2026-01-01T09:05:00');
        """
    )
    legacy.commit()
    legacy.close()

    db = Database(db_path)
    tickets = TicketService(db)

    columns = {row["name"] for row in db.execute("PRAGMA table_info(tickets)")}
    assert "certificate_type" in columns

    row = db.execute("SELECT * FROM tickets WHERE uuid='legacy-uuid'").fetchone()
    assert row["ticket_number"] == 7
    assert row["certificate_type"] is None  # old ticket, no certificate — allowed

    # Numbering continues from the legacy data, and new tickets can
    # carry a certificate alongside the old ones.
    fresh = tickets.reserve_next_ticket(1, "kuwaiti")
    assert fresh.ticket_number == 8
    assert fresh.certificate_type == "kuwaiti"
