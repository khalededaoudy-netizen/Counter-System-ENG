"""Queue-calling logic for Phase 2 (public display + the minimal web
call action that stands in for Phase 4's full counter dashboard).

There is deliberately no separate "WAITING" status in the database: a
ticket that is `PRINTED` with `called_at IS NULL` *is* the waiting
queue, in ticket_number order (FIFO). Calling a ticket is the only
write this module does — it never touches print/numbering state, so
Phase 1's printing reliability guarantees are untouched by anything
here.

`call_next` takes the same `BEGIN IMMEDIATE` locking pattern as
`ticket_service.reserve_next_ticket`, for the same reason: multiple
counters could click "call next" at nearly the same moment, and each
waiting ticket must go to exactly one counter.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from app.core.database import Database
from app.core.models import Counter, Ticket, TicketStatus


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class NoWaitingTicketsError(Exception):
    pass


class QueueService:
    def __init__(self, db: Database):
        self.db = db

    # ---- counters -----------------------------------------------------

    def get_or_create_counter(self, counter_number: int) -> Counter:
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM counters WHERE counter_number=?", (counter_number,)
            ).fetchone()
            if row is None:
                now = _now()
                cur = conn.execute(
                    "INSERT INTO counters(counter_number, active, created_at) VALUES (?, 1, ?)",
                    (counter_number, now),
                )
                row = conn.execute(
                    "SELECT * FROM counters WHERE id=?", (cur.lastrowid,)
                ).fetchone()
        return Counter.from_row(row)

    # ---- waiting queue / calling ---------------------------------------

    def get_waiting_tickets(self, session_id: int, limit: int = 10) -> list[Ticket]:
        rows = self.db.execute(
            """SELECT * FROM tickets
               WHERE session_id=? AND status=? AND called_at IS NULL
               ORDER BY ticket_number ASC LIMIT ?""",
            (session_id, TicketStatus.PRINTED, limit),
        ).fetchall()
        return [Ticket.from_row(r) for r in rows]

    def call_next(self, session_id: int, counter_number: int) -> Ticket:
        """Assign the oldest waiting ticket to `counter_number`. Raises
        NoWaitingTicketsError if the queue is empty — callers should
        treat that as a normal, expected state, not a failure."""
        counter = self.get_or_create_counter(counter_number)
        with self.db.transaction() as conn:
            row = conn.execute(
                """SELECT * FROM tickets
                   WHERE session_id=? AND status=? AND called_at IS NULL
                   ORDER BY ticket_number ASC LIMIT 1""",
                (session_id, TicketStatus.PRINTED),
            ).fetchone()
            if row is None:
                raise NoWaitingTicketsError(f"No waiting tickets in session {session_id}")

            now = _now()
            conn.execute(
                """UPDATE tickets
                   SET status=?, counter_id=?, called_at=?, updated_at=?
                   WHERE id=?""",
                (TicketStatus.CALLED, counter.id, now, now, row["id"]),
            )
            conn.execute(
                "INSERT INTO ticket_events(ticket_id, event_type, timestamp, metadata) "
                "VALUES (?, 'CALLED', ?, ?)",
                (row["id"], now, f'{{"counter_number": {counter_number}}}'),
            )
            updated = conn.execute("SELECT * FROM tickets WHERE id=?", (row["id"],)).fetchone()
        return Ticket.from_row(updated)

    def get_currently_called(self, session_id: int) -> Optional[dict]:
        """The most recently called ticket, with its counter number —
        i.e. what the public display should show as "now serving"."""
        row = self.db.execute(
            """SELECT t.ticket_number AS ticket_number, c.counter_number AS counter_number,
                      t.called_at AS called_at
               FROM tickets t
               JOIN counters c ON c.id = t.counter_id
               WHERE t.session_id=? AND t.status=?
               ORDER BY t.called_at DESC LIMIT 1""",
            (session_id, TicketStatus.CALLED),
        ).fetchone()
        if row is None:
            return None
        return {"ticket_number": row["ticket_number"], "counter_number": row["counter_number"], "called_at": row["called_at"]}

    def get_public_display_data(self, session_id: int, business_date: str, next_count: int = 5) -> dict:
        current = self.get_currently_called(session_id)
        waiting = self.get_waiting_tickets(session_id, limit=next_count)

        waiting_count_row = self.db.execute(
            "SELECT COUNT(*) AS c FROM tickets WHERE session_id=? AND status=? AND called_at IS NULL",
            (session_id, TicketStatus.PRINTED),
        ).fetchone()
        called_count_row = self.db.execute(
            "SELECT COUNT(*) AS c FROM tickets WHERE session_id=? AND status=?",
            (session_id, TicketStatus.CALLED),
        ).fetchone()
        total_row = self.db.execute(
            "SELECT COUNT(*) AS c FROM tickets WHERE session_id=? AND status IN (?, ?)",
            (session_id, TicketStatus.PRINTED, TicketStatus.CALLED),
        ).fetchone()

        return {
            "business_date": business_date,
            "current": current,
            "next_numbers": [t.ticket_number for t in waiting],
            "stats": {
                "total_today": total_row["c"],
                "waiting": waiting_count_row["c"],
                "called": called_count_row["c"],
            },
        }
