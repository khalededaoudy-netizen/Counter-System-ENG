# University Admission Queue & Ticket Management System — Phase 1

**This document covers Phase 1: the Windows desktop ticket printing
application.** Phase 2 (public queue display + call-next) is
implemented, deployed on Vercel/Supabase — see
[PHASE2_WEB.md](PHASE2_WEB.md) (a local-network fallback version also
exists, see [PHASE2.md](PHASE2.md)). Phases 3–6 (voice announcements,
employee/organizer dashboards, full applicant workflow) are documented
in the original project brief but **not implemented** yet — they'll
build on top of the SQLite schema and Supabase mirror created here
without needing earlier phases to be rewritten.

---

## 1. Architecture

```
Employee clicks PRINT
        │
        ▼
reserve_next_ticket()  ──►  SQLite: INSERT ticket status=RESERVED, COMMIT
        │                    (number is now permanently consumed —
        │                     even if the app crashes next, it will
        │                     never be reused)
        ▼
draw number onto template image (PIL) + send to printer (raw GDI)
        │
   ┌────┴────┐
success      failure
   │            │
   ▼            ▼
mark_printed  mark_print_failed
status=PRINTED  status=PRINT_FAILED
        │            │
        ▼            ▼
sync loop (background thread, every N seconds)
   reads PENDING_SYNC tickets → upserts to Supabase → marks SYNCED
   (never touches numbering; failure just leaves rows PENDING_SYNC)
```

Two databases, two different jobs (this is intentional, per the
project's reliability rules):

- **SQLite (`data/queue.db`)** — the only thing responsible for *what
  number is next*. Local, always available, survives restarts.
- **Supabase** — a cloud **mirror** of already-printed tickets, for
  future monitoring/dashboards. It is written to *after* a ticket is
  already safely printed and stored locally, on a background thread,
  and its availability has zero effect on whether printing works.

## 2. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Desktop UI | **PySide6** | Official Qt bindings, LGPL (free for this use), modern look, `QThread` gives a clean non-blocking background sync worker — much better fit than Tkinter for a status-heavy single screen with live updates. |
| Local DB | **SQLite** (stdlib `sqlite3`) | Zero-install, file-based, ACID transactions, WAL mode for concurrent read/write, ships with Python. Exactly what "must work with no server and no internet" calls for. |
| Ticket template | **Pillow, over a pre-rendered image** | The real template lays its design out in floating Word text boxes that `python-docx` can't reliably edit, and the ticket number was never real text in the file — just blank space. The template is exported once (via Word) to a high-res PNG; the number is drawn onto a copy with PIL for every ticket. |
| Printing | **raw GDI** (`pywin32`'s `win32ui`/`win32print`) | The composited ticket is just a bitmap by this point, so it's rasterized straight to the printer's device context — no Word process needed at print time, which is one less dependency between "employee clicks print" and paper coming out. `python-docx`/Word-COM printing (`template_filler.py`, `print_docx()`) are kept in the codebase as an alternate path for templates that don't use floating text boxes. |
| Cloud sync | **supabase-py** | Official client, simple `upsert()` on a stable UUID gives idempotent retries for free. |
| Config | **YAML + `.env`** | Non-secret machine settings (printer name, template path) in a git-ignored `config.yaml`; secrets (Supabase URL/key) in a git-ignored `.env`. Neither is hard-coded or committed. |

This intentionally avoids: a local web server, Docker, message
queues, or any multi-process architecture — 300 tickets/day on one
machine does not need it.

## 3. Folder structure

```
QueueSystem/
├── app/
│   ├── main.py                  # entry point
│   ├── config.py                # loads config.yaml + .env
│   ├── logging_config.py
│   ├── core/
│   │   ├── database.py          # SQLite connection, schema, transactions
│   │   ├── models.py            # Ticket / DailySession / status enums
│   │   ├── certificates.py      # the 13 certificate types (single source of truth)
│   │   ├── session_service.py   # daily business-session lookup/creation
│   │   └── ticket_service.py    # reserve/print/fail/retry/cancel + sync queries
│   ├── printing/
│   │   ├── ticket_image.py      # draws the number onto the template image (active path)
│   │   ├── template_filler.py   # python-docx placeholder replace (alternate path)
│   │   └── printer_service.py   # raw GDI image printing + Word COM printing + printer enumeration
│   ├── sync/
│   │   ├── supabase_client.py   # upsert wrapper (idempotent on uuid)
│   │   └── sync_manager.py      # background QThread sync loop
│   └── ui/
│       ├── main_window.py       # the one-screen employee UI
│       ├── certificate_dialog.py # "which certificate?" popup shown before every print
│       └── styles.py
├── config/
│   └── config.example.yaml      # copy to config.yaml
├── templates/
│   ├── ticket_template.docx          # the real Word ticket design (reference/regeneration source)
│   └── ticket_template_highres.png   # ← what's actually used at print time
├── supabase/
│   └── schema.sql                # run once in the Supabase SQL editor
├── data/                          # created at runtime: queue.db, logs/, temp/
├── tests/
├── .env.example                  # copy to .env
├── requirements.txt
└── README.md
```

## 4. Implementation

All source files are in the repo (see structure above). Key design
points worth calling out:

- **`ticket_service.reserve_next_ticket`** computes `MAX(ticket_number)+1`
  for the session and commits it as `RESERVED` *before* printing is
  attempted, inside a `BEGIN IMMEDIATE` transaction — this is what
  makes the number-then-print ordering crash-safe (see docstring in
  [`app/core/ticket_service.py`](app/core/ticket_service.py)).
- **Print failure never becomes `PRINTED`.** A failed print leaves the
  ticket as `PRINT_FAILED`; the UI shows a retry banner that reprints
  the *same* number. Numbers are only skipped if the employee
  explicitly clicks "Cancel this number" (logged as `CANCELLED`).
- **Startup crash recovery**: if the app or Windows was killed between
  reserving a number and confirming print/fail, that ticket is stuck
  at `RESERVED`. `get_unresolved_ticket()` finds it on every UI
  refresh and blocks new prints until it's retried or cancelled — so
  a crash can never silently swallow a number.
- **Idempotent sync**: every ticket gets a `uuid` at creation; Supabase
  upserts on that `uuid`, so a ticket synced twice (e.g. reconnect
  right after a partial batch) never creates a duplicate cloud row.

## 5. Installation

Prerequisites on the printing PC:
- Windows 10/11
- **Microsoft Word** installed — only needed once, to export the
  template to a high-res image (see "Template requirement" below).
  Printing itself does not depend on Word.
- Python 3.10+
- The ticket printer's driver already installed (per project brief)

```bash
git clone <this-repo>
cd QueueSystem
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## 6. Configuration

`config/config.yaml` doesn't need to be created by hand — running the
app auto-creates it from `config.example.yaml` on first launch if
it's missing. Pick the printer from the in-app dropdown afterwards
(see "Printer selection" in section 7); that choice is saved straight
back into `config.yaml`. Only copy/edit it yourself if you want other
settings (template path, sync interval, etc.) different from the
defaults shown in `config/config.example.yaml`.

```bash
copy .env.example .env
```

Edit **`.env`** (git-ignored, never commit real values):
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=<anon key, NOT the service_role key>
```

Run `supabase/schema.sql` once in your Supabase project's SQL editor
to create the `tickets` mirror table and its RLS policies. If you skip
Supabase setup entirely, leave `.env` empty — the app runs fully
offline and every ticket simply stays `PENDING_SYNC` forever, which is
safe and expected.

**Template requirement**: the real ticket design (`templates/ticket_template.docx`)
turned out to lay everything out in floating text boxes, and the number
was never actual text in the file — just reserved blank space next to
"رقم:". Editing that kind of `.docx` per-ticket isn't reliable, so the
template is instead **rendered once** to a high-resolution image
(`templates/ticket_template_highres.png`, exported via Word itself so
it's pixel-faithful) and the ticket number is drawn onto a copy of
that image with PIL for every print — no Word involvement at print
time. If you ever change the Word design, regenerate the image:

```bash
# Export the .docx to PDF via Word COM, then rasterize page 1 at 1200 DPI, e.g.:
python - <<'PY'
import win32com.client as win32, pymupdf
word = win32.DispatchEx("Word.Application"); word.Visible = False
doc = word.Documents.Open(r"templates\ticket_template.docx", ReadOnly=True)
doc.ExportAsFixedFormat(r"data\temp\template.pdf", 17); doc.Close(False); word.Quit()
pix = pymupdf.open(r"data\temp\template.pdf")[0].get_pixmap(matrix=pymupdf.Matrix(1200/72, 1200/72))
pix.save(r"templates\ticket_template_highres.png")
PY
```

Then re-measure the number box (`app/printing/ticket_image.py` —
`NUMBER_BOX`, `FONT_SIZE`, `RIGHT_GAP`) against the new image if the
layout moved. The current box was measured and confirmed against this
exact template on 2026-08-09: the number sits right-aligned next to
"رقم:" with a small gap, vertically centered, in a bold font sized to
match the label.

## 7. Running

```bash
.venv\Scripts\activate
python -m app.main
```

For daily use, create a desktop shortcut targeting:
```
"C:\path\to\QueueSystem\.venv\Scripts\pythonw.exe" -m app.main
```
(`pythonw.exe` avoids a console window; set "Start in" to the project folder.)

### Building a standalone .exe (no Python install needed on the printing PC)

One-time, from a machine with the dev environment set up:

```bash
.venv\Scripts\activate
pip install pyinstaller
pyinstaller --name ZNU_QueueTicketPrinter --windowed --noconfirm --contents-directory . ^
  --add-data "templates;templates" ^
  --add-data "config/config.example.yaml;config" ^
  --hidden-import win32timezone --hidden-import win32com.client ^
  app/main.py
```

This produces `dist/ZNU_QueueTicketPrinter/` — a self-contained folder
(exe + all Python/Qt runtime + `templates/`). `--contents-directory .`
keeps everything flat next to the .exe instead of PyInstaller's
default `_internal/` subfolder, which matters here: `app/config.py`
resolves `PROJECT_ROOT` from `sys.executable`'s folder when frozen, so
`config/`, `templates/`, and `data/` must sit right next to the .exe.

`config/config.yaml` doesn't need to be prepared before deploying to a
new PC: if it's missing, `config.py` auto-creates it from
`config.example.yaml` (bundled) on first launch, using safe defaults
— the printer is picked afterwards from the in-app dropdown (see
"Printer selection" below), which persists straight back into that
same `config.yaml`, so there's nothing to hand-edit for a normal
deploy.

`.env` (Supabase URL/key) is the one file that *is* machine-specific
in a way that can't be defaulted, since it holds real secrets — copy
it over if this PC should sync to the cloud mirror:
```bash
copy .env dist\ZNU_QueueTicketPrinter\.env
```
Skipping it is fine too: the app runs and prints normally offline,
just without cloud sync, until a `.env` is added later.

Then `dist\ZNU_QueueTicketPrinter\ZNU_QueueTicketPrinter.exe` runs
standalone — copy that whole folder to the printing PC (no Python
required there). `data/` (the SQLite DB, logs, temp files) and
`config/config.yaml` are created inside it on first run. Rebuild and
re-copy the exe whenever the source code changes; the generated
`config.yaml`/`data/` don't need to be touched again after the first
deploy (the printer selection survives via `config.yaml`, and can be
changed anytime from the dropdown without re-deploying anything).

### Certificate selection (before every printed number)

Both **طباعة التذكرة التالية** and **سحب رقم تجريبي** open a popup
listing the 13 certificate types first; the number is only reserved
and printed after one is chosen. Cancelling the popup reserves
nothing, so a mis-click on the print button can't burn a ticket
number.

The chosen certificate is stored on the ticket and pushed to Supabase
with it, which is what later routes the student into the right
student-affairs queue — see **PHASE3_ADMISSION.md** for the full
two-stage workflow and the `/admission` page. The certificate is fixed
at reservation time, so a reprint after a paper jam keeps the same
number *and* the same certificate without asking again.

### Printer selection

The main window has a printer dropdown (with a ⟳ refresh button) that
lists every printer Windows currently reports. Picking one writes it
to `config.yaml` immediately, so it's what the app prints to from
then on — regardless of what Windows itself considers the "default
printer". This matters because Windows can silently reassign its own
default (e.g. to "Microsoft Print to PDF" when the physical receipt
printer gets unplugged), and previously that meant tickets could
start printing to the wrong destination without anyone changing
anything in this app. If the real printer disappears and comes back
(unplugged/replugged, driver reinstalled), hit ⟳ to re-scan and
re-select it.

## 8. Testing checklist

Automated (`pytest tests/ -v` — 40 tests, all passing, cover sequencing/
crash-recovery/retry/cancel/day-rollover/restart/sync-queue/ticket-image/
certificate logic without touching Word or a real printer):

- [x] Sequential numbering starts at 1 and increments correctly
- [x] Print failure does not mark PRINTED; retry reuses the same number
- [x] A RESERVED ticket with no resolution is detected after a simulated restart
- [x] Cancel intentionally skips to the next number
- [x] Duplicate ticket_number is rejected by the DB constraint
- [x] New business day restarts numbering at 1 without touching prior days
- [x] Restart resumes numbering from the last ticket (same DB file)
- [x] Pending-sync queue only contains PRINTED tickets, clears on mark_synced
- [x] 150 sequential tickets in one session number and count correctly
- [x] The chosen certificate is stored on the ticket and survives failure/retry
- [x] Each ticket keeps its own certificate; reserving without one still works
- [x] A pre-certificate `queue.db` migrates without losing tickets
- [x] Tickets advanced past the first reviewer still count in the day's total
- [x] The certificate dialog can actually be *shown* (regression: it segfaulted)
- [x] Every certificate has a button, and each button selects its own value
- [x] Cancelling the dialog selects nothing (so no number is reserved)
- [x] The Python and TypeScript certificate lists have not drifted apart

Manual, on the real machine with printer + template configured:

1. **Normal printing** — click PRINT NEXT TICKET, confirm the physical
   ticket matches the template design with the correct number.
2. **Multiple sequential tickets** — print 5 in a row, confirm 1..5,
   no gaps.
3. **Application restart** — print a few tickets, close the app,
   reopen it, print again → numbering continues, not reset.
4. **Windows restart** — same as above across a reboot.
5. **Internet disconnected** — unplug network, print a ticket → it
   prints, ticket is stored, sync status shows "pending".
6. **Supabase unavailable** — point `.env` at a bad URL, print → still
   prints locally; sync status shows offline/pending, no crash.
7. **Internet restored** — reconnect, wait ≤ `interval_seconds`,
   confirm the pending ticket becomes SYNCED (check Supabase table).
8. **Printer disconnected** — unplug/disable the printer, click print
   → error surfaces in the UI and log, ticket becomes PRINT_FAILED,
   RETRY button appears, print button is disabled until resolved.
9. **Printer error mid-job** — pull paper out during a print, confirm
   the failure path (not a false PRINTED).
10. **New business day** — change system date forward a day (or wait
    past midnight with the app running), confirm numbering resets to 1
    and yesterday's tickets are still in the DB.
11. **Duplicate prevention** — covered by automated test; can also try
    to hand-craft a duplicate insert and confirm it's rejected.
12. **Crash recovery** — kill the app process (Task Manager) right
    after clicking print, reopen → the warning banner appears with the
    stuck ticket, requiring retry/cancel before new prints.
13. **100+ tickets in a day** — covered by automated test at 150; also
    worth doing a real run to confirm no UI slowdown.
14. **Database backup/recovery** — copy `data/queue.db` while the app
    is closed, delete/corrupt the live file, restore the copy, confirm
    the app opens it and resumes correctly. Because of WAL mode, always
    stop the app (or copy the `-wal`/`-shm` files too) before backing up.

## 9. Edge cases and how they're handled

- **Printer offline / wrong name in config**: `printer_is_available()`
  checked before every print attempt; if the configured name isn't in
  `EnumPrinters()`, it fails fast as `PRINT_FAILED` instead of hanging
  on a COM call.
- **Template missing the placeholder**: `TemplateError` before any
  print attempt — no blank/garbled ticket is ever sent to the printer.
- **App killed mid-print**: number is already committed as `RESERVED`
  before printing starts, so it can't be reused; startup detects the
  unresolved row and blocks further printing until resolved.
- **Two rapid clicks on PRINT**: the button is disabled for the
  duration of the print call, and `reserve_next_ticket` takes SQLite's
  write lock via `BEGIN IMMEDIATE`, so even a race would serialize
  rather than duplicate a number.
- **Supabase down for hours**: PENDING_SYNC tickets just accumulate;
  each sync tick tries a batch and stops at the first failure so it
  doesn't hammer a dead network; printing is completely unaffected.
- **Same ticket synced twice**: `upsert(..., on_conflict="uuid")` — no
  duplicate cloud rows.
- **Midnight rollover while app stays open**: a 30-second timer checks
  the current date against the open session and creates the new day's
  session automatically, resetting the "next number" without deleting
  anything.
- **Non-Windows dev machine**: `printer_service` degrades gracefully
  (`list_printers()` returns `[]`, printing raises a clear `PrintError`)
  so the core logic can still be unit-tested off-Windows.

## 10. Completion criteria for Phase 1

- [x] Employee can print a ticket with one click; number and printed
      timestamp are correct.
- [x] Printing works with no internet connection.
- [x] Ticket numbers survive app restart and Windows restart without
      resetting or duplicating.
- [x] A failed print never becomes `PRINTED`, and can be retried under
      the same number.
- [x] Supabase outage never blocks or delays printing.
- [x] Background sync uploads pending tickets once connectivity
      returns, without duplicating cloud rows.
- [x] Previous days' data is never deleted.
- [x] Automated tests pass (`pytest tests/`).
- [ ] Manual checklist above run once on the real target PC with the
      real printer and real Word template — **please run this and
      confirm before we move to Phase 2.**

---

**Waiting for your testing/approval before starting Phase 2** (local
backend + public queue display).
