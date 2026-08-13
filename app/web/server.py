"""Phase 2 local web backend: public queue display + a minimal
call-next action.

Runs as its own process (`python -m app.web.server`), reading/writing
the SAME SQLite file the desktop printing app uses. SQLite's WAL mode
(already enabled in core/database.py) lets this and the desktop app
coexist as separate OS processes without stepping on each other — the
30s busy timeout absorbs the rare moment both try to write at once.

This process never touches ticket numbering or printing at all; its
only write is `QueueService.call_next`, which is entirely separate
from Phase 1's print-reliability state machine (see queue_service.py).

Real-time update strategy: the display page polls `/api/display`
every couple of seconds instead of a WebSocket/SSE channel. For a
few-hundred-ticket/day local-network display, sub-3-second polling is
indistinguishable from "real time" to a person in a waiting room, and
it avoids adding a persistent-connection layer this scale doesn't need.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.config import load_config
from app.core.database import Database
from app.core.queue_service import NoWaitingTicketsError, QueueService
from app.core.session_service import SessionService
from app.logging_config import get_logger, setup_logging

logger = get_logger("web")

STATIC_DIR = Path(__file__).resolve().parent / "static"


class CallNextRequest(BaseModel):
    counter_number: int


@asynccontextmanager
async def lifespan(app: FastAPI):
    config = load_config()
    setup_logging(config.resolve_path(config.logging.dir), config.logging.level)
    db = Database(config.resolve_path(config.database.path))
    app.state.config = config
    app.state.db = db
    app.state.sessions = SessionService(db)
    app.state.queue = QueueService(db)
    logger.info("Web server ready (db=%s)", db.db_path)
    yield
    db.close()


app = FastAPI(title="University Queue — Public Display", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def public_display_page():
    return FileResponse(STATIC_DIR / "display.html")


@app.get("/call")
def call_page():
    return FileResponse(STATIC_DIR / "call.html")


@app.get("/api/display")
def api_display():
    session = app.state.sessions.get_or_create_today()
    data = app.state.queue.get_public_display_data(
        session.id, session.business_date, app.state.config.web.next_numbers_count
    )
    return data


@app.post("/api/call-next")
def api_call_next(body: CallNextRequest):
    session = app.state.sessions.get_or_create_today()
    try:
        ticket = app.state.queue.call_next(session.id, body.counter_number)
    except NoWaitingTicketsError:
        return {"success": False, "reason": "no_waiting_tickets"}
    logger.info("Ticket #%s called to counter %s", ticket.ticket_number, body.counter_number)
    return {"success": True, "ticket_number": ticket.ticket_number, "counter_number": body.counter_number}


def main() -> None:
    import uvicorn

    config = load_config()
    uvicorn.run(app, host=config.web.host, port=config.web.port)


if __name__ == "__main__":
    main()
