"""Background synchronization loop.

Runs on its own QThread so a slow/unreachable network never blocks the
print button or the rest of the UI (Supabase must never be a printing
dependency). Every `interval_seconds` it looks for PRINTED tickets that
are still PENDING_SYNC/SYNC_FAILED and upserts them one at a time,
marking each SYNCED as it succeeds. A failed batch simply leaves the
remaining tickets PENDING_SYNC/SYNC_FAILED for the next tick — nothing
about a failed sync ever touches the printing/numbering tables.

The wait between ticks is a `threading.Event` rather than a plain
sleep, so `trigger()` can wake it immediately after a successful print
instead of waiting up to `interval_seconds`. This matters once the
public display/call pages read from Supabase directly (Phase 2's
Vercel deployment): a newly printed ticket should show up as "waiting"
there within about a second, not lag by the full poll interval.
`trigger()` only sets a flag — it's safe to call from the UI thread
and never blocks on the network itself.
"""
from __future__ import annotations

import threading
import time

from PySide6.QtCore import QThread, Signal

from app.core.session_service import SessionService
from app.core.ticket_service import TicketService
from app.logging_config import get_logger
from app.sync.supabase_client import SupabaseSyncClient, SupabaseUnavailable

logger = get_logger("sync")


class SyncManager(QThread):
    status_changed = Signal(dict)  # {"online": bool, "pending": int, "last_sync": str|None, "last_error": str|None}

    def __init__(
        self,
        ticket_service: TicketService,
        session_service: SessionService,
        supabase_client: SupabaseSyncClient,
        interval_seconds: int = 15,
        batch_size: int = 25,
        parent=None,
    ):
        super().__init__(parent)
        self.ticket_service = ticket_service
        self.session_service = session_service
        self.supabase_client = supabase_client
        self.interval_seconds = interval_seconds
        self.batch_size = batch_size
        self._stop_requested = False
        self._last_sync = None
        self._last_error = None
        self._wake_event = threading.Event()

    def stop(self) -> None:
        self._stop_requested = True
        self._wake_event.set()

    def trigger(self) -> None:
        """Wake the sync loop immediately instead of waiting for the next
        timer tick. Safe to call from the UI thread — just sets a flag,
        the actual network call still happens on this background thread."""
        self._wake_event.set()

    def run(self) -> None:
        logger.info("Sync manager started (interval=%ss)", self.interval_seconds)
        while not self._stop_requested:
            self._sync_once()
            self._wake_event.wait(timeout=self.interval_seconds)
            self._wake_event.clear()
        logger.info("Sync manager stopped")

    def _sync_once(self) -> None:
        pending = self.ticket_service.get_pending_sync_tickets(self.batch_size)
        if not pending:
            self._emit_status(online=True)
            return

        today = self.session_service.get_or_create_today()
        synced_count = 0
        error = None
        for ticket in pending:
            try:
                self.supabase_client.upsert_ticket(ticket, today.business_date)
                self.ticket_service.mark_synced(ticket.id)
                synced_count += 1
                logger.info("Ticket #%s synchronized", ticket.ticket_number)
            except SupabaseUnavailable as e:
                error = str(e)
                self.ticket_service.mark_sync_failed(ticket.id)
                logger.warning("Sync failed for ticket #%s: %s", ticket.ticket_number, e)
                break  # network is likely down; stop hammering it this tick

        if synced_count:
            self._last_sync = time.strftime("%Y-%m-%d %H:%M:%S")
        self._last_error = error
        self._emit_status(online=error is None)

    def _emit_status(self, online: bool) -> None:
        remaining = self.ticket_service.get_pending_sync_tickets(9999)
        self.status_changed.emit(
            {
                "online": online,
                "pending": len(remaining),
                "last_sync": self._last_sync,
                "last_error": self._last_error,
            }
        )
