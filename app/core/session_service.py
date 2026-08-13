"""Daily business-session management.

A "business day" is its own row in daily_sessions; ticket numbering
restarts at 1 for each new session but old sessions and their tickets
are never deleted (Rule 7). Restarting the app or the computer mid-day
must resume the *same* session rather than creating a new one, so
session lookup is idempotent on business_date.
"""
from __future__ import annotations

from datetime import date, datetime

from app.core.database import Database
from app.core.models import DailySession


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class SessionService:
    def __init__(self, db: Database):
        self.db = db

    def get_or_create_today(self, today: date | None = None) -> DailySession:
        business_date = (today or date.today()).isoformat()
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM daily_sessions WHERE business_date=?",
                (business_date,),
            ).fetchone()
            if row is None:
                now = _now()
                cur = conn.execute(
                    "INSERT INTO daily_sessions(business_date, started_at, created_at) "
                    "VALUES (?, ?, ?)",
                    (business_date, now, now),
                )
                row = conn.execute(
                    "SELECT * FROM daily_sessions WHERE id=?", (cur.lastrowid,)
                ).fetchone()
        return DailySession(**{k: row[k] for k in row.keys()})
