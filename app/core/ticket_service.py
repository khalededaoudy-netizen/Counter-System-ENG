"""Core ticket-numbering and print-lifecycle logic.

This is the piece the whole reliability story hinges on, so the
sequence of operations is deliberate:

1. `reserve_next_ticket` computes the next number and INSERTs+COMMITs
   it as status=RESERVED *before* anything is sent to the printer.
   Because the number is persisted first, a crash/power-loss during
   printing can never cause the number to be silently reused — it
   just leaves a RESERVED row that startup recovery will surface.

2. The caller (ticket printing workflow, see ui/main_window.py) then
   attempts the actual print. Exactly one of `mark_printed` /
   `mark_print_failed` is called afterwards depending on the outcome.
   A ticket is only ever considered "issued" once `mark_printed` has
   run — i.e. after the printer driver reported success.

3. On PRINT_FAILED, the number is *not* skipped: `retry_ticket` lets
   the employee reprint the exact same ticket_number. This satisfies
   both "never mark a failed print as PRINTED" and "avoid skipped
   numbers whenever technically possible" simultaneously. An employee
   can still explicitly `cancel_ticket` to deliberately abandon a
   number (e.g. paper jam that can't be cleared) — that's a conscious
   skip, logged as CANCELLED, not a silent one.

Sequential numbers are computed as MAX(ticket_number) for the session,
which includes RESERVED/PRINT_FAILED/CANCELLED rows — so numbering
only ever moves forward, regardless of prior failures.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Optional

from app.core.database import Database
from app.core.models import SyncStatus, Ticket, TicketStatus


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class TicketService:
    def __init__(self, db: Database):
        self.db = db

    # ---- ticket numbering / printing lifecycle -------------------------

    def reserve_next_ticket(self, session_id: int, certificate_type: Optional[str] = None) -> Ticket:
        """`certificate_type` is the stable id from core/certificates.py,
        chosen by the employee before printing. It's stored at
        reservation time (not after a successful print) so a ticket that
        fails to print and is retried keeps the certificate it was
        issued for, and so the value can never be lost between the two
        steps. Optional to keep every existing caller/test working."""
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(ticket_number), 0) AS m FROM tickets WHERE session_id=?",
                (session_id,),
            ).fetchone()
            next_number = row["m"] + 1
            now = _now()
            ticket_uuid = str(uuid.uuid4())
            cur = conn.execute(
                """INSERT INTO tickets
                   (uuid, session_id, ticket_number, status, print_attempts,
                    sync_status, device_id, certificate_type, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)""",
                (
                    ticket_uuid,
                    session_id,
                    next_number,
                    TicketStatus.RESERVED,
                    SyncStatus.PENDING_SYNC,
                    self.db.device_id,
                    certificate_type,
                    now,
                    now,
                ),
            )
            ticket_id = cur.lastrowid
            self._log_event(conn, ticket_id, "RESERVED", now, {"certificate_type": certificate_type})
            row = conn.execute("SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()
        return Ticket.from_row(row)

    def mark_printed(self, ticket_id: int, printer_name: str) -> Ticket:
        with self.db.transaction() as conn:
            now = _now()
            conn.execute(
                """UPDATE tickets
                   SET status=?, printed_at=?, printer_name=?,
                       print_attempts=print_attempts+1, updated_at=?,
                       error_message=NULL
                   WHERE id=?""",
                (TicketStatus.PRINTED, now, printer_name, now, ticket_id),
            )
            self._log_event(conn, ticket_id, "PRINTED", now, {"printer": printer_name})
            row = conn.execute("SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()
        return Ticket.from_row(row)

    def mark_print_failed(self, ticket_id: int, error_message: str) -> Ticket:
        with self.db.transaction() as conn:
            now = _now()
            conn.execute(
                """UPDATE tickets
                   SET status=?, print_attempts=print_attempts+1,
                       error_message=?, updated_at=?
                   WHERE id=?""",
                (TicketStatus.PRINT_FAILED, error_message, now, ticket_id),
            )
            self._log_event(conn, ticket_id, "PRINT_FAILED", now, {"error": error_message})
            row = conn.execute("SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()
        return Ticket.from_row(row)

    def cancel_ticket(self, ticket_id: int, reason: str) -> Ticket:
        with self.db.transaction() as conn:
            now = _now()
            conn.execute(
                "UPDATE tickets SET status=?, error_message=?, updated_at=? WHERE id=?",
                (TicketStatus.CANCELLED, reason, now, ticket_id),
            )
            self._log_event(conn, ticket_id, "CANCELLED", now, {"reason": reason})
            row = conn.execute("SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()
        return Ticket.from_row(row)

    def get_unresolved_ticket(self, session_id: int) -> Optional[Ticket]:
        """A RESERVED or PRINT_FAILED ticket from this session, if any —
        must be resolved (retried or cancelled) before printing a new
        number. Covers both a normal print failure and a crash that
        happened between reserve and the printed/failed outcome."""
        row = self.db.execute(
            """SELECT * FROM tickets
               WHERE session_id=? AND status IN (?, ?)
               ORDER BY ticket_number DESC LIMIT 1""",
            (session_id, TicketStatus.RESERVED, TicketStatus.PRINT_FAILED),
        ).fetchone()
        return Ticket.from_row(row) if row else None

    def get_ticket(self, ticket_id: int) -> Optional[Ticket]:
        row = self.db.execute("SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()
        return Ticket.from_row(row) if row else None

    def reconcile_sequence_floor(self, session_id: int, min_ticket_number: int, reason: str) -> Optional[Ticket]:
        """If the cloud mirror already has a higher ticket_number for
        today than this local database does (e.g. the local queue.db
        was lost/reset while Supabase still had newer synced tickets),
        insert a single CANCELLED marker row at `min_ticket_number` so
        the next `reserve_next_ticket` continues from there instead of
        colliding with — or silently reusing — numbers the cloud
        already has on record. A no-op if local is already caught up.
        Never touches printing; only ever raises the numbering floor,
        the same way an employee-cancelled number does."""
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(ticket_number), 0) AS m FROM tickets WHERE session_id=?",
                (session_id,),
            ).fetchone()
            if row["m"] >= min_ticket_number:
                return None

            now = _now()
            ticket_uuid = str(uuid.uuid4())
            cur = conn.execute(
                """INSERT INTO tickets
                   (uuid, session_id, ticket_number, status, print_attempts,
                    sync_status, device_id, error_message, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)""",
                (
                    ticket_uuid,
                    session_id,
                    min_ticket_number,
                    TicketStatus.CANCELLED,
                    SyncStatus.SYNCED,  # mirrors data the server already has; nothing new to push
                    self.db.device_id,
                    reason,
                    now,
                    now,
                ),
            )
            ticket_id = cur.lastrowid
            self._log_event(conn, ticket_id, "SEQUENCE_RECONCILED", now, {"min_ticket_number": min_ticket_number})
            row = conn.execute("SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()
        return Ticket.from_row(row)

    def reset_session(self, session_id: int) -> int:
        """Deletes every local ticket (and its events) for this
        session, so the next reservation starts back at #1. Used only
        by the PIN-gated admin reset — never called automatically.
        Returns the number of tickets removed."""
        with self.db.transaction() as conn:
            conn.execute(
                "DELETE FROM ticket_events WHERE ticket_id IN (SELECT id FROM tickets WHERE session_id=?)",
                (session_id,),
            )
            cur = conn.execute("DELETE FROM tickets WHERE session_id=?", (session_id,))
            return cur.rowcount

    # ---- status / stats for the UI -------------------------------------

    def get_today_stats(self, session_id: int) -> dict:
        # "printed today" means successfully printed at any point, no matter
        # how far down the workflow it has since travelled (called by the
        # first reviewer, queued for admission, completed) — a ticket
        # moving through the queue lifecycle must not disappear from the
        # printer app's own counters. Hence TicketStatus.ISSUED rather
        # than an inline list that would need editing per new status.
        issued = TicketStatus.ISSUED
        placeholders = ", ".join("?" * len(issued))
        last_printed = self.db.execute(
            f"""SELECT * FROM tickets WHERE session_id=? AND status IN ({placeholders})
               ORDER BY ticket_number DESC LIMIT 1""",
            (session_id, *issued),
        ).fetchone()
        count_row = self.db.execute(
            f"SELECT COUNT(*) AS c FROM tickets WHERE session_id=? AND status IN ({placeholders})",
            (session_id, *issued),
        ).fetchone()
        max_row = self.db.execute(
            "SELECT COALESCE(MAX(ticket_number), 0) AS m FROM tickets WHERE session_id=?",
            (session_id,),
        ).fetchone()
        pending_sync_row = self.db.execute(
            "SELECT COUNT(*) AS c FROM tickets WHERE sync_status=?",
            (SyncStatus.PENDING_SYNC,),
        ).fetchone()
        return {
            "current_number": last_printed["ticket_number"] if last_printed else None,
            "current_certificate": last_printed["certificate_type"] if last_printed else None,
            "next_number": max_row["m"] + 1,
            "today_count": count_row["c"],
            "last_printed_at": last_printed["printed_at"] if last_printed else None,
            "pending_sync_count": pending_sync_row["c"],
        }

    # ---- sync support -----------------------------------------------------

    def get_pending_sync_tickets(self, limit: int = 25) -> list[Ticket]:
        rows = self.db.execute(
            """SELECT * FROM tickets
               WHERE sync_status IN (?, ?) AND status IN (?, ?)
               ORDER BY ticket_number ASC LIMIT ?""",
            (
                SyncStatus.PENDING_SYNC,
                SyncStatus.SYNC_FAILED,
                TicketStatus.PRINTED,
                TicketStatus.CALLED,
                limit,
            ),
        ).fetchall()
        return [Ticket.from_row(r) for r in rows]

    def mark_synced(self, ticket_id: int) -> None:
        with self.db.transaction() as conn:
            now = _now()
            conn.execute(
                "UPDATE tickets SET sync_status=?, synced_at=?, updated_at=? WHERE id=?",
                (SyncStatus.SYNCED, now, now, ticket_id),
            )

    def mark_sync_failed(self, ticket_id: int) -> None:
        with self.db.transaction() as conn:
            now = _now()
            conn.execute(
                "UPDATE tickets SET sync_status=?, updated_at=? WHERE id=?",
                (SyncStatus.SYNC_FAILED, now, ticket_id),
            )

    # ---- internal ----------------------------------------------------------

    def _log_event(self, conn, ticket_id: int, event_type: str, ts: str, metadata: dict | None = None) -> None:
        conn.execute(
            "INSERT INTO ticket_events(ticket_id, event_type, timestamp, metadata) VALUES (?, ?, ?, ?)",
            (ticket_id, event_type, ts, json.dumps(metadata) if metadata else None),
        )
