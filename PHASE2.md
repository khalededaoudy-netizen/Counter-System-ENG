# Phase 2 — Local Backend + Public Queue Display

> **Deployment update:** the public display and call pages actually in
> use are now the Vercel/Supabase versions described in
> [PHASE2_WEB.md](PHASE2_WEB.md) — only the printer PC stays local, so
> the display/call pages needed to be reachable from anywhere, not
> just the university LAN. Everything below (the FastAPI app in
> `app/web/`) still works and is kept as a LAN-only fallback, but it's
> no longer the primary path.

Builds on [Phase 1](README.md) without touching its printing/numbering
guarantees. Adds a local web server that reads the same SQLite
database the desktop app writes to, and:

- a **public display page** (big screen) showing the number currently
  being served, its counter, the next few waiting numbers, and today's
  stats — auto-refreshing.
- a **minimal "call next" page**, since showing a real "now serving"
  number requires *something* to call tickets forward, and Phase 4's
  full per-counter employee dashboard isn't built yet. This page is an
  intentionally small stand-in for that — a counter number field and a
  button — not the final UI.

---

## 1. Architecture

```
Desktop app (Phase 1)                 Web server (Phase 2, separate process)
  reserves/prints tickets               reads + writes the SAME queue.db
  status: RESERVED→PRINTED                (SQLite WAL mode — safe for
                                            two processes, one writer at a time)
        │                                        │
        └──────────────┬─────────────────────────┘
                        ▼
                    queue.db
                        │
                        ▼
        QueueService.call_next(counter_number)
        picks oldest PRINTED ticket with called_at IS NULL,
        sets status=CALLED, counter_id, called_at
                        │
                        ▼
              GET /api/display  (polled every 2s)
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
      Public display (/)     Call page (/call)
```

**No new "WAITING" status.** A ticket that is `PRINTED` with
`called_at IS NULL` *is* the waiting queue, in `ticket_number` order.
Calling a ticket only ever transitions `PRINTED → CALLED`. This means
Phase 1's print-reliability state machine (`RESERVED → PRINTED` /
`PRINT_FAILED`) is completely untouched by anything in this phase —
the web server never writes to a ticket before it's been printed.

Two things from Phase 1 needed small, backward-compatible adjustments
because a ticket's status now advances past `PRINTED`:
- `ticket_service.get_today_stats` (the desktop app's own "today's
  count" / "current number") now counts `PRINTED` **or** `CALLED`, so
  a ticket doesn't vanish from the printer app's own counters the
  moment it's called on the public display.
- `ticket_service.get_pending_sync_tickets` likewise now includes
  `CALLED` tickets, so calling a ticket doesn't stop it from being
  synced to Supabase.

## 2. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Backend | **FastAPI + Uvicorn** | Small, async, trivial to run locally (`python -m app.web.server`), built-in request validation (Pydantic) for the call-next body, no build step. |
| Real-time updates | **Polling** (`fetch` every 2s), not WebSocket/SSE | At ~300 tickets/day on a local network, 2-second staleness is imperceptible to someone reading a waiting-room screen. Polling needs no persistent-connection handling, reconnect logic, or extra server complexity — it degrades to "try again in 2s" for free. |
| Frontend | **Plain HTML/CSS/JS**, no framework | Two small pages (a display and a form). A build pipeline would be pure overhead. |
| Data layer | **Same `app/core/*` modules as Phase 1** | `QueueService` is new, but reuses the existing `Database`/`SessionService` — no second source of truth, no data-layer duplication. |

## 3. Folder structure (additions)

```
app/
├── core/
│   └── queue_service.py     # call_next / waiting list / display data (NEW)
└── web/
    ├── server.py             # FastAPI app: /, /call, /api/display, /api/call-next
    └── static/
        ├── style.css
        ├── display.html / display.js   # public display, polls /api/display
        └── call.html / call.js          # minimal call-next page
```

`app/core/database.py` gained an additive migration (`_migrate()`):
existing Phase 1 databases automatically get `tickets.counter_id` and
`tickets.called_at` columns added on next open — no manual migration
step, no data at risk (only `ALTER TABLE ... ADD COLUMN`, never a drop
or rewrite). A new `counters` table is created the same way any other
table is (`CREATE TABLE IF NOT EXISTS`).

## 4. Implementation

Key pieces, see the files themselves for full detail:

- **`queue_service.py`** — `call_next(session_id, counter_number)` uses
  the same `BEGIN IMMEDIATE` locking pattern as Phase 1's
  `reserve_next_ticket`, so two counters calling at nearly the same
  instant can't both grab the same waiting ticket. Raises
  `NoWaitingTicketsError` when the queue is empty — treated as a
  normal state (`{"success": false, "reason": "no_waiting_tickets"}`),
  not a server error.
- **`server.py`** — a FastAPI `lifespan` opens one `Database` connection
  for the process lifetime (same `Database` class Phase 1 uses, so WAL
  mode / busy-timeout are already correct for a second process sharing
  the file).
- **`display.js`** — polls `/api/display`, flashes the current-number
  digits green when the served ticket changes, shows an "offline"
  banner if a poll fails (network hiccup, server restarting) and keeps
  retrying rather than freezing on stale data.

## 5. Installation

Same virtualenv as Phase 1 — no separate install:

```bash
.venv\Scripts\activate
pip install -r requirements.txt
```

(`requirements.txt` now also includes `fastapi`, `uvicorn[standard]`,
and `Pillow`, which Phase 1's printing pipeline needed but was
missing from the file.)

## 6. Configuration

New `web:` section in `config/config.yaml` (already present if you
copied from `config.example.yaml` again — otherwise add it):

```yaml
web:
  host: "0.0.0.0"   # reachable from other devices on the LAN; use 127.0.0.1 to restrict to this PC
  port: 8000
  next_numbers_count: 5
```

No new secrets — the web server reads the same `config.yaml`/`.env`
as the desktop app and needs no Supabase access itself.

## 7. Running

Run alongside the desktop app (both can be open at the same time,
pointed at the same `data/queue.db`):

```bash
.venv\Scripts\activate
python -m app.web.server
```

Then, on the printing PC or any device on the same network:
- **Public display**: `http://<pc-ip>:8000/` — open on the waiting-room screen/TV.
- **Call next (temporary, pre-Phase-4)**: `http://<pc-ip>:8000/call`

Find `<pc-ip>` with `ipconfig` (the LAN adapter's IPv4 address). From
the same PC, `http://127.0.0.1:8000/` also works.

## 8. Testing checklist

Automated (`pytest tests/ -v` — 22 tests total, 7 new in
`tests/test_queue_service.py`):

- [x] `call_next` picks the oldest waiting ticket first (FIFO)
- [x] `call_next` raises a normal "empty queue" condition, not a crash, when nothing is waiting
- [x] A called ticket leaves the waiting list and becomes "current"
- [x] Calling the same counter twice reuses one `counters` row, doesn't duplicate it
- [x] `/api/display`-shaped data (`get_public_display_data`) matches expected current/next/stats after a call
- [x] Called tickets still count toward the desktop app's own "today's count" / "current number"
- [x] Called tickets remain eligible for Supabase sync

Manual:
1. **Two processes, one DB** — run the Phase 1 desktop app and `python -m app.web.server` at the same time, print a few tickets from the desktop app, confirm they show up as "waiting" on `/` within 2s.
2. **Call next** — open `/call`, enter a counter number, click Call, confirm the public display updates within 2s and the number flashes.
3. **Empty queue** — call next with no printed tickets waiting; confirm the call page shows "No one is waiting right now" rather than an error.
4. **Multiple counters** — call from counter 1 and counter 2 in sequence; confirm each gets a different ticket and the display always shows the *most recently* called one.
5. **LAN access** — open the display URL from a second device on the same Wi-Fi/network using the PC's LAN IP, confirm it loads.
6. **Server restart** — stop and restart `python -m app.web.server` while the display page is open; confirm the offline banner appears, then clears once the server is back, without a manual page reload.
7. **Day rollover** — same as Phase 1: after midnight, `/api/display` should show the new business date and an empty queue, past tickets untouched.
8. **Existing Phase 1 database** — point this at a `queue.db` created before Phase 2 existed; confirm it opens without error and the migration adds the new columns (check `PRAGMA table_info(tickets)`).

## 9. Edge cases

- **No waiting tickets when "call next" is pressed**: explicit
  `NoWaitingTicketsError` → a normal, labeled empty state in the UI,
  never a stack trace or a called ticket with garbage data.
- **Two counters click "call next" at the same instant**: `BEGIN
  IMMEDIATE` serializes the two calls at the SQLite level — one gets
  the ticket, the other's query re-runs and gets the next one (or the
  empty state). No ticket can be double-assigned.
- **Web server and desktop app writing at the same moment**: WAL mode
  + a 30s busy timeout (already configured in `Database`) means one
  write briefly waits rather than failing; both processes' writes are
  short (`BEGIN IMMEDIATE` transactions), so contention windows are
  tiny.
- **Display page open before the server starts / after it stops**: the
  poll fails, the offline banner shows, polling keeps retrying — it
  recovers on its own once the server is reachable again, no manual
  refresh needed.
- **A counter number that's never been used before**: `call_next`
  auto-creates its `counters` row on first use — no separate "add
  counter" setup step is required for this phase.
- **Upgrading an existing Phase 1 install**: the additive migration in
  `Database._migrate()` runs automatically on first open; nothing
  about existing tickets/sessions is modified or at risk.

## 10. Completion criteria

- [x] Public display shows current number, counter, next waiting
      numbers, and today's stats, refreshing automatically.
- [x] A ticket can be called to a counter from `/call` and appears on
      the display within the poll interval.
- [x] No ticket can be called to two counters at once.
- [x] The desktop app's own numbers/counters are unaffected by tickets
      being called.
- [x] Existing Phase 1 databases upgrade automatically, with no data
      loss.
- [x] Automated tests pass (`pytest tests/` — 22/22).
- [ ] Manual checklist above run once on the real local network with a
      second device viewing the display — please confirm before we
      move to Phase 3 (voice announcements).

---

**Waiting for your testing/approval before starting Phase 3.**
