from datetime import date, timedelta

from app.core.database import Database
from app.core.models import SyncStatus, TicketStatus
from app.core.session_service import SessionService
from app.core.ticket_service import TicketService


def make_services(tmp_path):
    db = Database(tmp_path / "queue.db")
    return db, SessionService(db), TicketService(db)


def test_sequential_numbering_starts_at_one(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    t1 = tickets.reserve_next_ticket(session.id)
    tickets.mark_printed(t1.id, "PrinterA")
    t2 = tickets.reserve_next_ticket(session.id)
    tickets.mark_printed(t2.id, "PrinterA")

    assert t1.ticket_number == 1
    assert t2.ticket_number == 2


def test_print_failure_does_not_mark_printed_and_allows_retry(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    t = tickets.reserve_next_ticket(session.id)
    failed = tickets.mark_print_failed(t.id, "printer offline")
    assert failed.status == TicketStatus.PRINT_FAILED

    unresolved = tickets.get_unresolved_ticket(session.id)
    assert unresolved is not None
    assert unresolved.ticket_number == t.ticket_number

    # retry: same ticket_number gets printed, no number was skipped
    retried = tickets.mark_printed(t.id, "PrinterA")
    assert retried.status == TicketStatus.PRINTED
    assert retried.ticket_number == t.ticket_number
    assert tickets.get_unresolved_ticket(session.id) is None

    # next reservation continues from the retried number, not before it
    nxt = tickets.reserve_next_ticket(session.id)
    assert nxt.ticket_number == t.ticket_number + 1


def test_reserved_but_never_resolved_ticket_is_detected_after_restart(tmp_path):
    db_path = tmp_path / "queue.db"
    db = Database(db_path)
    sessions = SessionService(db)
    tickets = TicketService(db)
    session = sessions.get_or_create_today()

    # simulate a crash: reserve a number, never call mark_printed/mark_print_failed
    t = tickets.reserve_next_ticket(session.id)
    db.close()

    # "restart" the app against the same file
    db2 = Database(db_path)
    tickets2 = TicketService(db2)
    unresolved = tickets2.get_unresolved_ticket(session.id)
    assert unresolved is not None
    assert unresolved.ticket_number == t.ticket_number
    assert unresolved.status == TicketStatus.RESERVED


def test_cancel_ticket_intentionally_skips_number(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    t = tickets.reserve_next_ticket(session.id)
    tickets.mark_print_failed(t.id, "paper jam, unrecoverable")
    cancelled = tickets.cancel_ticket(t.id, "employee cancelled")
    assert cancelled.status == TicketStatus.CANCELLED
    assert tickets.get_unresolved_ticket(session.id) is None

    nxt = tickets.reserve_next_ticket(session.id)
    assert nxt.ticket_number == t.ticket_number + 1


def test_duplicate_ticket_number_rejected_by_db_constraint(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()
    tickets.reserve_next_ticket(session.id)

    import sqlite3
    import pytest

    with pytest.raises(sqlite3.IntegrityError):
        with db.transaction() as conn:
            conn.execute(
                "INSERT INTO tickets (uuid, session_id, ticket_number, status, "
                "print_attempts, sync_status, created_at, updated_at) "
                "VALUES ('dup-uuid', ?, 1, 'RESERVED', 0, 'PENDING_SYNC', 'x', 'x')",
                (session.id,),
            )


def test_new_business_day_restarts_numbering_without_deleting_old_day(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    today = date.today()
    yesterday = today - timedelta(days=1)

    day1 = sessions.get_or_create_today(yesterday)
    t1 = tickets.reserve_next_ticket(day1.id)
    tickets.mark_printed(t1.id, "PrinterA")
    t2 = tickets.reserve_next_ticket(day1.id)
    tickets.mark_printed(t2.id, "PrinterA")

    day2 = sessions.get_or_create_today(today)
    assert day2.id != day1.id
    t3 = tickets.reserve_next_ticket(day2.id)
    tickets.mark_printed(t3.id, "PrinterA")

    assert t3.ticket_number == 1  # numbering restarted for the new day

    day1_stats = tickets.get_today_stats(day1.id)
    assert day1_stats["today_count"] == 2  # yesterday's records untouched


def test_restart_resumes_numbering_from_last_ticket(tmp_path):
    db_path = tmp_path / "queue.db"
    db = Database(db_path)
    sessions = SessionService(db)
    tickets = TicketService(db)
    session = sessions.get_or_create_today()

    for _ in range(5):
        t = tickets.reserve_next_ticket(session.id)
        tickets.mark_printed(t.id, "PrinterA")
    db.close()

    db2 = Database(db_path)
    sessions2 = SessionService(db2)
    tickets2 = TicketService(db2)
    session2 = sessions2.get_or_create_today()
    assert session2.id == session.id  # same business date -> same session

    t6 = tickets2.reserve_next_ticket(session2.id)
    assert t6.ticket_number == 6


def test_pending_sync_tracking(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    t = tickets.reserve_next_ticket(session.id)
    # not yet printed -> should not appear in pending sync (only PRINTED tickets sync)
    assert tickets.get_pending_sync_tickets() == []

    tickets.mark_printed(t.id, "PrinterA")
    pending = tickets.get_pending_sync_tickets()
    assert len(pending) == 1
    assert pending[0].sync_status == SyncStatus.PENDING_SYNC

    tickets.mark_synced(t.id)
    assert tickets.get_pending_sync_tickets() == []


def test_many_sequential_tickets_in_one_day(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    for i in range(1, 151):
        t = tickets.reserve_next_ticket(session.id)
        assert t.ticket_number == i
        tickets.mark_printed(t.id, "PrinterA")

    stats = tickets.get_today_stats(session.id)
    assert stats["today_count"] == 150
    assert stats["next_number"] == 151


def test_reconcile_sequence_floor_raises_local_ceiling(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    t1 = tickets.reserve_next_ticket(session.id)
    tickets.mark_printed(t1.id, "PrinterA")  # local max is 1

    marker = tickets.reconcile_sequence_floor(session.id, 5, "cloud already had #5")
    assert marker.ticket_number == 5
    assert marker.status == TicketStatus.CANCELLED

    nxt = tickets.reserve_next_ticket(session.id)
    assert nxt.ticket_number == 6


def test_reconcile_sequence_floor_is_noop_when_local_already_ahead(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    for _ in range(3):
        t = tickets.reserve_next_ticket(session.id)
        tickets.mark_printed(t.id, "PrinterA")

    result = tickets.reconcile_sequence_floor(session.id, 2, "cloud only had #2")
    assert result is None

    nxt = tickets.reserve_next_ticket(session.id)
    assert nxt.ticket_number == 4  # unaffected


def test_reset_session_clears_tickets_and_restarts_numbering(tmp_path):
    db, sessions, tickets = make_services(tmp_path)
    session = sessions.get_or_create_today()

    for _ in range(3):
        t = tickets.reserve_next_ticket(session.id)
        tickets.mark_printed(t.id, "PrinterA")

    removed = tickets.reset_session(session.id)
    assert removed == 3

    nxt = tickets.reserve_next_ticket(session.id)
    assert nxt.ticket_number == 1
    assert tickets.get_today_stats(session.id)["today_count"] == 0
