# Phase 3 — Certificates, certificate queues & Student Affairs admission

Extends the existing system (it does **not** replace any of it) so a
student is handled in two stages instead of one: a first reviewer in
the general hall, then a student-affairs employee who specialises in
that student's certificate.

## 1. The workflow

```
Print Number  ──▶  Certificate popup  ──▶  Ticket printed
                                                │
                                                ▼
                                    General waiting hall
                                                │
                                     first reviewer presses NEXT
                                                ▼
                                        First reviewer
                                                │
                                     first reviewer presses NEXT again
                                       (finishes this student and
                                        calls the following one)
                                                ▼
                                  Certificate queue (per certificate)
                                                │
                                  admission employee presses NEXT
                                                ▼
                                     Student Affairs / Admission
                                                │
                                  admission employee presses NEXT again
                                                ▼
                                           Completed
```

The key rule: **printing a number does not put the student into a
certificate queue.** The certificate is only recorded at print time.
The student enters their certificate queue when the *first reviewer
finishes with them*, not before.

## 2. Ticket statuses

| Status | Meaning | Written by |
|---|---|---|
| `RESERVED` | number allocated, print unconfirmed | desktop |
| `PRINTED` (+ `called_at IS NULL`) | waiting in the general hall | desktop |
| `PRINT_FAILED` / `CANCELLED` | print problem / employee abandoned it | desktop |
| `CALLED` | called by a first reviewer, at their counter | `finish_first_review_and_call_next` |
| `WAITING_FOR_ADMISSION` | first review done; queued under its certificate | `finish_first_review_and_call_next` |
| `CALLED_BY_ADMISSION` | claimed by a student-affairs employee | `admission_call_next` |
| `COMPLETED` | admission finished with this student | `admission_call_next` |

Two stages from the original spec are folded in deliberately rather
than stored separately, because no UI action would ever produce them:
`UNDER_FIRST_REVIEW` **is** `CALLED` (the employee called the student
to their desk — that *is* the review), and `UNDER_ADMISSION_REVIEW`
**is** `CALLED_BY_ADMISSION`. Each ends when the employee presses NEXT,
which completes the current student and calls the following one — one
button, the same gesture both screens already had.

## 3. Certificate identity

`app/core/certificates.py` (Python) and `vercel-app/lib/certificates.ts`
(TypeScript) hold the same 13 certificates. The stable `value`
(`"egyptian"`, `"ig"`, …) is what gets stored and matched; the Arabic
`label` is display-only, so rewording a label never orphans tickets
already issued under it.

The two files can't literally share source across languages, so
`tests/test_certificates.py` parses the `.ts` file and fails the suite
if the lists ever drift apart.

## 4. Where the work happens

Numbering and printing stay entirely on the desktop app + local SQLite,
exactly as before. Everything from the first reviewer onwards is
coordinated in Supabase, because two or more employees act on the same
queue concurrently and only the database can arbitrate that.

The desktop pushes each ticket to Supabase **once** (a ticket is
`PENDING_SYNC` until its first successful upsert, then `SYNCED`), so it
can never overwrite a status the cloud has since advanced.

## 5. Preventing double-calling

Both call RPCs claim a row with the same pattern the original
`call_next_ticket` used:

```sql
where t.uuid = (
    select uuid from tickets
    where ...
    order by ticket_number asc
    limit 1
    for update skip locked
)
```

`FOR UPDATE SKIP LOCKED` means two employees pressing NEXT in the same
instant each skip the row the other has locked — they get different
students, never the same one, and never deadlock. Because it's a single
statement inside a `SECURITY DEFINER` function, the claim is atomic;
there is no read-then-write window a second employee could slip into.

Queue isolation is enforced in the same place: `admission_call_next`
filters to `certificate_type = any(p_certificate_types)` **server-side**.
The anon key is public, so "an employee can only call the certificates
they selected" has to be enforced in the function to mean anything.

## 6. `/admission`

Route: `https://znu-counter-voice.vercel.app/admission` — part of the
same Next.js app, same Supabase project, same design language.

1. **Setup screen** — multi-select of all 13 certificates, then START.
   The selection is saved in `localStorage`, so a refresh mid-shift
   returns straight to the dashboard rather than the setup screen.
2. **Dashboard** — "now serving" (number + certificate), a big NEXT
   button, and a live per-certificate waiting count plus total.

Waiting counts update through the same mechanism the display page
already uses: a Supabase Realtime `postgres_changes` subscription for
the instant push, plus a 5-second poll as a safety net for a missed
event. No new real-time technology was introduced.

Each browser gets a stable `admission_desk` id (localStorage). It
scopes "the student I'm currently serving", so pressing NEXT completes
the person at *this* desk rather than whoever another employee is with,
and so a refresh re-derives the current student from the server instead
of losing them.

## 7. Voice announcements

Reuses the existing Web Speech pipeline in `vercel-app/lib/speech.ts`
(including the Arabic number-spelling and the FIFO announcement queue
that stops two calls talking over each other). Admission calls add one
phrasing:

```
الرقم 125، شؤون الطلاب، شهادات الـ IG (IGCSE/O-Level/A-Level)
```

The certificate is spoken because several certificate queues are being
served in parallel — the number alone wouldn't tell the student which
desk wants them. Announcements play on the public display (`/`), which
is what the waiting hall actually hears; `/admission` also announces
its own call locally so the employee gets immediate confirmation.

## 8. Applying the migration

`supabase/schema.sql` must be re-run once in the Supabase SQL Editor.
It is safe to re-run — every statement is idempotent
(`alter table ... add column if not exists`, `create or replace
function`, `create index if not exists`).

It adds `certificate_type`, `first_review_completed_at`,
`admission_called_at`, `admission_desk`, `completed_at`, a partial
index for the admission queue lookup, and the two new RPCs. The
original `call_next_ticket` is left untouched so the older local
FastAPI display keeps working.

**Until the migration is applied**, `/admission` shows its offline
banner and `/call` fails to call — the columns and functions it needs
don't exist yet. The desktop app is unaffected: it keeps printing and
just records `certificate_type` locally.

## 9. Known limitations

- **No authentication.** This project has never had any — `/call` and
  `/view` are equally open, and this change deliberately did not
  invent a roles system for one page. `/admission` is protected only
  by being an unadvertised URL. If real access control is wanted, it
  should be added across all the employee pages at once, as its own
  piece of work.
- **Tickets printed before this feature** have `certificate_type = NULL`.
  They can't be routed to a certificate queue, so when a first reviewer
  finishes with one it goes straight to `COMPLETED` rather than being
  stranded in a queue nobody can drain.
- **The desktop app never learns the later statuses.** Local SQLite
  keeps the ticket at `PRINTED`/`CALLED`; the admission stages exist
  only in Supabase. The desktop's own counters are unaffected by
  design, but a ticket's full journey is only visible in the cloud.
- **The two certificate lists are kept in sync by a test**, not by a
  shared artifact. Adding a certificate means editing both files.
