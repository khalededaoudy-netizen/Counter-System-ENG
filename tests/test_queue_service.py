from app.core.database import Database
from app.core.models import TicketStatus
from app.core.queue_service import NoWaitingTicketsError, QueueService
from app.core.session_service import SessionService
from app.core.ticket_service import TicketService


def make_services(tmp_path):
    db = Database(tmp_path / "queue.db")
    return db, SessionService(db), TicketService(db), QueueService(db)


def _print_ticket(tickets, session_id):
    t = tickets.reserve_next_ticket(session_id)
    return tickets.mark_printed(t.id, "PrinterA")


def test_call_next_picks_oldest_waiting_ticket_fifo(tmp_path):
    db, sessions, tickets, queue = make_services(tmp_path)
    session = sessions.get_or_create_today()

    _print_ticket(tickets, session.id)  # #1
    _print_ticket(tickets, session.id)  # #2
    _print_ticket(tickets, session.id)  # #3

    called = queue.call_next(session.id, counter_number=4)
    assert called.ticket_number == 1
    assert called.status == TicketStatus.CALLED

    called2 = queue.call_next(session.id, counter_number=4)
    assert called2.ticket_number == 2


def test_call_next_raises_when_queue_empty(tmp_path):
    db, sessions, tickets, queue = make_services(tmp_path)
    session = sessions.get_or_create_today()

    try:
        queue.call_next(session.id, counter_number=1)
        assert False, "expected NoWaitingTicketsError"
    except NoWaitingTicketsError:
        pass


def test_called_ticket_leaves_waiting_list_and_shows_as_current(tmp_path):
    db, sessions, tickets, queue = make_services(tmp_path)
    session = sessions.get_or_create_today()

    _print_ticket(tickets, session.id)
    _print_ticket(tickets, session.id)

    assert [t.ticket_number for t in queue.get_waiting_tickets(session.id)] == [1, 2]

    queue.call_next(session.id, counter_number=7)

    assert [t.ticket_number for t in queue.get_waiting_tickets(session.id)] == [2]
    current = queue.get_currently_called(session.id)
    assert current == {"ticket_number": 1, "counter_number": 7, "called_at": current["called_at"]}


def test_call_next_reuses_existing_counter_row(tmp_path):
    db, sessions, tickets, queue = make_services(tmp_path)
    session = sessions.get_or_create_today()
    _print_ticket(tickets, session.id)
    _print_ticket(tickets, session.id)

    queue.call_next(session.id, counter_number=3)
    queue.call_next(session.id, counter_number=3)

    row = db.execute("SELECT COUNT(*) AS c FROM counters WHERE counter_number=3").fetchone()
    assert row["c"] == 1


def test_public_display_data_reflects_call_state(tmp_path):
    db, sessions, tickets, queue = make_services(tmp_path)
    session = sessions.get_or_create_today()
    for _ in range(3):
        _print_ticket(tickets, session.id)

    queue.call_next(session.id, counter_number=2)

    data = queue.get_public_display_data(session.id, session.business_date)
    assert data["current"]["ticket_number"] == 1
    assert data["current"]["counter_number"] == 2
    assert data["next_numbers"] == [2, 3]
    assert data["stats"] == {"total_today": 3, "waiting": 2, "called": 1}


def test_called_tickets_still_counted_in_desktop_stats(tmp_path):
    """A ticket moving PRINTED -> CALLED must not disappear from the
    printer app's own 'today's count' / 'current number' — see the
    comment in ticket_service.get_today_stats."""
    db, sessions, tickets, queue = make_services(tmp_path)
    session = sessions.get_or_create_today()
    _print_ticket(tickets, session.id)
    _print_ticket(tickets, session.id)

    queue.call_next(session.id, counter_number=1)

    stats = tickets.get_today_stats(session.id)
    assert stats["today_count"] == 2
    assert stats["current_number"] == 2


def test_called_tickets_still_sync_eligible(tmp_path):
    db, sessions, tickets, queue = make_services(tmp_path)
    session = sessions.get_or_create_today()
    _print_ticket(tickets, session.id)
    queue.call_next(session.id, counter_number=1)

    pending = tickets.get_pending_sync_tickets()
    assert len(pending) == 1
    assert pending[0].status == TicketStatus.CALLED
