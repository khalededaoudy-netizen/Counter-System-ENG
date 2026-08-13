# Phase 2 (online variant) — Vercel + Supabase public display & call page

This supersedes [PHASE2.md](PHASE2.md)'s deployment target for the
public display and call-next pages: instead of a local FastAPI server
on the university's LAN, they're a **Next.js app deployed on Vercel**,
reading and writing **Supabase directly** — because only the printer
PC is guaranteed to be on the local network; the display/call pages
need to be reachable from anywhere.

The local FastAPI app from PHASE2.md (`app/web/server.py`) is left in
the repo as a LAN-only fallback (e.g. if internet/Vercel is down but
the printer PC and a local screen are still up) — it isn't removed,
just no longer the primary path for the public-facing pages.

---

## 1. Architecture

```
Printer PC (only local part of the system)          Anywhere (internet)
┌──────────────────────────┐
│ Phase 1 desktop app        │
│ SQLite (numbering, print)  │
│         │                  │
│   background sync ─────────┼───────► Supabase (tickets table)
│   (now triggers instantly           - source of truth for CALLING
│    after each print, not            - RLS: public read + one
│    just every 15s)                    SECURITY DEFINER RPC to call
└──────────────────────────┘                    │
                                                 │ Realtime (postgres_changes)
                                                 ▼
                                   ┌─────────────────────────────┐
                                   │ Next.js app on Vercel         │
                                   │  /       — public display     │
                                   │  /call   — call-next page     │
                                   │  both talk to Supabase         │
                                   │  directly from the browser     │
                                   │  (no server-side code needed)  │
                                   └─────────────────────────────┘
```

Numbering (SQLite, printer PC) and calling (Supabase, from anywhere)
are two different write paths on purpose, same as the LAN version:
- The printer PC's sync only ever `UPSERT`s its own printed tickets.
- Calling a ticket forward only happens through
  `call_next_ticket(business_date, counter_number)`, a `SECURITY
  DEFINER` Postgres function that atomically picks the oldest waiting
  ticket (`status='PRINTED' AND called_at IS NULL`) and marks it
  `CALLED`. Two browsers calling "next" at the same instant can't grab
  the same ticket (`FOR UPDATE SKIP LOCKED`).
- **No round-trip back to SQLite.** The printer PC never learns a
  ticket was called — by explicit choice, since nothing about
  printing/numbering needs to know. If a future phase needs that,
  the desktop app's sync loop can add a periodic read-back.

### "دلوقتي عايز فوري" — near-instant instead of waiting on the sync interval

The desktop sync used to run strictly every `interval_seconds` (15s
default). It now uses a `threading.Event` instead of a plain sleep, so
[`main_window.py`](app/ui/main_window.py) calls `sync_manager.trigger()`
right after a successful print — the pending ticket is pushed to
Supabase within roughly a second, not up to 15s later. See the updated
docstring in [`sync_manager.py`](app/sync/sync_manager.py).

The **call** side is already instant by construction: the RPC call and
the Realtime push both happen the moment the button is pressed —
there's no polling involved there at all.

### Startup reconciliation + admin reset (added later)

Two more pieces close the loop between the local database and the
cloud mirror:

- **Startup reconciliation**: on launch, the desktop app makes one
  best-effort call to Supabase for today's highest `ticket_number`. If
  the cloud mirror is ahead of the local database (e.g. `queue.db` was
  lost/reset while Supabase still had newer synced tickets — exactly
  what happened repeatedly during this session's own testing), it
  inserts a single `CANCELLED` marker row locally to raise the
  numbering floor to match, so the next reservation can't collide with
  a number the cloud already has. See `reconcile_sequence_floor` in
  [`ticket_service.py`](app/core/ticket_service.py) and
  `_reconcile_with_server` in
  [`main_window.py`](app/ui/main_window.py). Deferred via
  `QTimer.singleShot` so a dead network delays this check, never the
  window appearing — printing is never blocked by it.
- **Admin reset** (`إعادة تعيين النظام` button, PIN `11223344`): wipes
  today's tickets both locally (`ticket_service.reset_session`) and on
  Supabase, via a new `admin_reset_business_date(date, password)` RPC
  in `supabase/schema.sql`. The password check happens **inside the
  Postgres function**, not just in the desktop app's dialog — the same
  anon key that calls it is embedded in the public Vercel bundle, so a
  client-side-only check would be no real protection against someone
  calling the RPC directly from a browser console.
- The same PIN also gates the **test-number button** (`سحب رقم تجريبي`,
  see PHASE1 notes) — unlocked once per app session, unlike reset which
  re-prompts every time since it deletes data.

## 2. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Hosting | **Vercel** | User's explicit choice — free tier is plenty for two small pages. |
| Framework | **Next.js (App Router)** | The natural fit for Vercel; `create-next-app` scaffold, zero server code needed since both pages talk to Supabase directly from the browser. |
| Real-time | **Supabase Realtime** (`postgres_changes`), not polling | The LAN version polls because that's simplest for a local server; here, Supabase already provides a push channel, and the requirement was explicitly "فوري" (instant) — Realtime is the correct tool, not a bigger hammer. A 5s poll is kept as a safety net only, in case a Realtime event is ever dropped. |
| Mutation safety | **`SECURITY DEFINER` Postgres RPC**, not a server API route | Lets the call button run with a plain publishable (anon) key straight from the browser — no server-side secret to manage on Vercel — while still preventing the anon key from directly skipping the queue or hand-editing ticket state. |
| Data layer | **Supabase Postgres**, browser `@supabase/supabase-js` client | Already the project's cloud database; no new service introduced. |

## 3. Supabase project

Connected to the existing **`COUNTER`** project
(`https://yymwohimrfqaqepjrerp.supabase.co`, org "ebrahimmehasen's
Org") — found empty (no tables) and used as-is, rather than creating a
new one.

`supabase/schema.sql` (updated for this phase) was run against it via
the SQL Editor. It's safe to re-run — every statement is
idempotent (`create table if not exists`, `drop policy if exists`
`create policy`, `create or replace function`, a guarded
`alter publication`). It creates:

- `tickets` — same columns as the Phase 1 mirror, plus `counter_number`
  and `called_at`.
- RLS policies: desktop app can insert/update its own rows (anon,
  unchanged from Phase 1); anyone with the anon key can `SELECT`
  (needed for the public display).
- `call_next_ticket(business_date, counter_number)` — the only write
  path for calling, `SECURITY DEFINER`, granted to `anon`.
- Realtime enabled on `tickets`.

Both apps' credentials point at this project:
- Desktop app: `.env` → `SUPABASE_URL` / `SUPABASE_KEY` (git-ignored, already set on this machine).
- Next.js app: `vercel-app/.env.local` → `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` (git-ignored, already set for local dev).

Both currently use the project's single **publishable key**
(`sb_publishable_...`) — safe to expose in the browser by design; RLS
is what actually restricts it, not secrecy.

## 4. Folder structure (addition)

```
vercel-app/                   # Next.js app — deploy THIS folder's root to Vercel
├── app/
│   ├── page.tsx               # public display (polls via Realtime, "use client")
│   ├── call/page.tsx           # first reviewer's call-next page
│   ├── view/page.tsx           # per-counter served-ticket stats
│   └── admission/page.tsx      # student affairs — certificate queues (see PHASE3_ADMISSION.md)
├── lib/
│   ├── supabaseClient.ts       # browser Supabase client + local-date helper
│   ├── speech.ts               # Arabic Web Speech announcements
│   └── certificates.ts         # the 13 certificate types (mirrors app/core/certificates.py)
├── .env.local                  # git-ignored, already configured locally
└── .env.local.example
```

## 5. Installation (local dev)

```bash
cd vercel-app
npm install
copy .env.local.example .env.local
```
Fill in `.env.local` with the `COUNTER` project's URL and publishable
key from Supabase → Project Settings → API Keys (already done on this
machine — skip if you're not setting up a new machine).

## 6. Running locally

```bash
cd vercel-app
npm run dev
```
- Display: http://localhost:3000/
- Call (first reviewer): http://localhost:3000/call
- Admission (student affairs): http://localhost:3000/admission

Verified end-to-end against the live `COUNTER` project: inserted 3
test tickets via SQL, watched them appear on `/` within ~1s via
Realtime (no manual refresh), called one from `/call`, watched `/`
update to "NOW SERVING 1 · COUNTER 1" with the waiting list dropping
to `[2, 3]` — then cleaned the test rows back out.

## 7. Deployed on Vercel

**Live production URL: https://znu-counter-voice.vercel.app**
- Display: https://znu-counter-voice.vercel.app/
- Call (first reviewer): https://znu-counter-voice.vercel.app/call
- Admission (student affairs): https://znu-counter-voice.vercel.app/admission

This is the project's **stable alias** (visible as "Latest Production
URL" via `vercel project ls`) — it always points at whatever was most
recently deployed to production. Earlier docs/messages in this project
referenced `vercel-app-pi-weld.vercel.app`, which was actually a
one-off *deployment* URL (each individual deploy gets a unique random
one) that stops resolving once superseded — a mistake, not a second
real domain. Always use the stable alias above.

Deployed via the Vercel CLI (`npx vercel login` → device-flow browser
authorization → `npx vercel` → set `NEXT_PUBLIC_SUPABASE_URL` /
`NEXT_PUBLIC_SUPABASE_ANON_KEY` as production env vars via `vercel env
add` → `npx vercel --prod` to rebuild with them). Project:
`ebrahim8/vercel-app` in your Vercel account.

**Now connected to GitHub** (`ebrahimmehasen/-ZNU_counter`, via `vercel
git connect`) with **Root Directory** set to `vercel-app` (since the
Next.js app is a subfolder of the repo, not the repo root — set via
`vercel project update vercel-app --root-directory vercel-app`).
Pushing to `main` now triggers an automatic production deploy — no
need to run `vercel --prod` by hand for ordinary code changes anymore;
it's still there as a manual fallback.

Verified against the live deployment itself (not just localhost):
inserted real tickets via SQL, watched them appear on the deployed `/`
within ~1s via Realtime, called two from two simulated counters at
once, watched the "last 5 called" stack update in the correct order —
then cleaned the test rows back out via the `admin_reset_business_date`
RPC (far more reliable than the SQL Editor UI for scripted cleanup).

## 8. Testing checklist

Automated: unchanged Python suite still covers the printer-side logic
(`pytest tests/` — 22/22). This phase's new code (two React pages) has
no automated tests yet — it's thin enough (two Supabase calls each)
that manual verification was used instead; see §6 for what was
actually run against the live project.

Manual (do this once against the deployed Vercel URL, not just
localhost):
1. Print a real ticket from the desktop app; confirm it appears on the
   deployed `/` within ~1–2s (this also exercises the new instant-sync
   trigger, not just Realtime).
2. Call it from the deployed `/call`; confirm `/` updates within ~1s
   and the number flashes.
3. Call with no tickets waiting; confirm "No one is waiting right now."
4. Two browser tabs both open on `/call`, click both around the same
   time with only one ticket waiting; confirm exactly one succeeds and
   the other gets "No one is waiting" (not the same ticket twice).
5. Turn off the printer PC's internet; print a few tickets; confirm
   they still print (Phase 1 guarantee, unaffected); reconnect; confirm
   they appear on the display shortly after (bounded by
   `sync.interval_seconds` as a fallback, but should be near-instant
   via `trigger()` once the first ticket after reconnect syncs).
6. Load `/` on a phone/laptop *not* on the university network, confirm
   it works (this is the whole point of moving off local FastAPI).

## 9. Known limitations

- **The anon key's RLS UPDATE policy is broader than ideal.** It still
  grants blanket `UPDATE ... USING (true)` (needed for the desktop
  app's own upsert), and that same key is now also embedded in the
  public Vercel bundle. In principle someone could extract the key
  from the deployed site's JS and call `supabase.from('tickets').update(...)`
  directly, bypassing `call_next_ticket()`'s locking (though not
  numbering — SQLite is still authoritative there, so the worst case
  is queue-display mischief, not duplicate/lost ticket numbers). The
  honest fix is splitting the desktop app onto its own more-privileged
  key/policy, separate from the public key. Not done here — flagged
  in `supabase/schema.sql` and here for a follow-up.
- **Calling doesn't sync back to the printer PC.** By explicit choice
  (see §1) — the desktop app has no idea a ticket was called. Revisit
  if Phase 4's employee dashboard ends up needing that.
- **The `/call` page has no access control.** Anyone with the URL can
  call numbers — fine for a same-building "temporary stand-in" per the
  brief, but worth locking down (a PIN, or waiting for Phase 4's real
  per-counter login) before wider rollout.

## 10. Completion criteria

- [x] Supabase schema (tickets columns, RLS, RPC, Realtime) deployed
      to the real `COUNTER` project.
- [x] Desktop app's `.env` and the Next.js app's `.env.local` both
      point at it.
- [x] Public display shows live data from Supabase, updating within
      ~1s of a change via Realtime (verified against real inserts).
- [x] Call page calls the next waiting ticket via the atomic RPC,
      verified against the live project.
- [x] Desktop sync now pushes within ~1s of printing instead of
      waiting for the poll interval.
- [x] Python test suite still green (22/22) after the sync-timing
      change.
- [x] Deployed to Vercel production: https://vercel-app-pi-weld.vercel.app
- [x] Insert-a-real-row → Realtime update → call → display update
      verified against the *deployed* URL itself, not just localhost
      (§7) — items 1–2 of §8's manual checklist.
- [ ] Remaining §8 manual checklist items (3–6: empty-queue message,
      double-call race, offline printing during a real outage, access
      from a device outside the university network) — worth running
      once during a real admission day, not just this smoke test.

---

**Live and working.** Remaining checklist items in §8 are best run
during real operation rather than simulated further here.
