"""Plain data containers for rows read out of SQLite."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


class TicketStatus:
    """The ticket lifecycle, in order.

    Stages 1-3 (printing + the general waiting hall + the first
    reviewer) are owned by the desktop app and its local SQLite. The
    admission stages after that are driven entirely in Supabase by the
    web app, via SECURITY DEFINER RPCs — the desktop only ever pushes
    each ticket up once (see sync_manager), so it can never overwrite a
    status the cloud has since advanced.

    Two stages from the requested workflow are deliberately folded into
    the statuses either side of them rather than added as separate
    rows-in-transit, because there is no UI action that would ever
    produce them: UNDER_FIRST_REVIEW is CALLED (the employee called the
    student to their desk — that *is* the review), and
    UNDER_ADMISSION_REVIEW is CALLED_BY_ADMISSION for the same reason.
    Both transitions end when the employee presses "next", which
    completes whoever they had and calls the following student.
    """

    RESERVED = "RESERVED"          # number allocated, print not yet confirmed
    PRINTED = "PRINTED"            # printer confirmed success; implicitly "waiting"
                                    # until called_at is set (see queue_service.py —
                                    # there's no separate WAITING status: a PRINTED
                                    # ticket with called_at IS NULL *is* the waiting queue)
    PRINT_FAILED = "PRINT_FAILED"  # printer/template error, safe to retry
    CANCELLED = "CANCELLED"        # employee explicitly abandoned this number
    CALLED = "CALLED"              # called by the first reviewer, at their counter

    # --- certificate/admission stage (written by Supabase RPCs) ------
    WAITING_FOR_ADMISSION = "WAITING_FOR_ADMISSION"  # first review done; queued by certificate
    CALLED_BY_ADMISSION = "CALLED_BY_ADMISSION"      # claimed by a student-affairs employee
    COMPLETED = "COMPLETED"                          # admission finished with this student

    TERMINAL = (CANCELLED, COMPLETED)
    UNRESOLVED = (RESERVED, PRINT_FAILED)
    # Tickets confirmed printed — eligible to sync to Supabase. Only
    # PRINTED matters in practice (a ticket syncs once, right after it
    # prints); the later stages are listed so a ticket whose first sync
    # failed and was retried after the cloud advanced it still counts
    # as "issued" rather than silently dropping out of the queue.
    SYNCABLE = (PRINTED, CALLED)
    # Every status that means "this number was really issued today" —
    # what the day's counters and totals are built from. A ticket must
    # not vanish from the day's numbers just because it moved further
    # down the workflow.
    ISSUED = (PRINTED, CALLED, WAITING_FOR_ADMISSION, CALLED_BY_ADMISSION, COMPLETED)


class SyncStatus:
    PENDING_SYNC = "PENDING_SYNC"
    SYNCED = "SYNCED"
    SYNC_FAILED = "SYNC_FAILED"


@dataclass
class DailySession:
    id: int
    business_date: str
    started_at: str
    ended_at: Optional[str]
    created_at: str


@dataclass
class Ticket:
    id: int
    uuid: str
    session_id: int
    ticket_number: int
    status: str
    print_attempts: int
    printed_at: Optional[str]
    sync_status: str
    synced_at: Optional[str]
    device_id: Optional[str]
    printer_name: Optional[str]
    error_message: Optional[str]
    created_at: str
    updated_at: str
    counter_id: Optional[int] = None
    called_at: Optional[str] = None
    certificate_type: Optional[str] = None

    @classmethod
    def from_row(cls, row) -> "Ticket":
        return cls(**{k: row[k] for k in row.keys()})


@dataclass
class Counter:
    id: int
    counter_number: int
    name: Optional[str]
    active: bool
    created_at: str

    @classmethod
    def from_row(cls, row) -> "Counter":
        data = {k: row[k] for k in row.keys()}
        data["active"] = bool(data["active"])
        return cls(**data)
