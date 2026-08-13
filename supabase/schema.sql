-- Supabase schema: mirror + queue-calling coordination.
--
-- The local SQLite database (desktop app) remains the source of truth
-- for TICKET NUMBERING — this table only mirrors already-printed
-- tickets and adds the "calling" columns used by the online public
-- display / call-next pages (hosted on Vercel, see /nextjs-app).
--
-- Numbering and calling are deliberately split across two different
-- write paths so neither can corrupt the other:
--   - the desktop app's background sync UPSERTs its own printed
--     tickets directly (status/printed_at/etc.) — unchanged from Phase 1.
--   - calling a ticket forward is NOT a plain UPDATE from the browser.
--     It only happens through call_next_ticket(), a SECURITY DEFINER
--     function that atomically picks the oldest waiting ticket and
--     marks it CALLED. The anon key has no direct UPDATE grant on
--     status/counter_number/called_at outside that function, so two
--     browsers calling "next" at the same instant can't both grab the
--     same ticket, and a page can't hand-craft an update to skip the
--     queue.

create table if not exists tickets (
    uuid           uuid primary key,
    ticket_number  integer not null,
    business_date  date not null,
    status         text not null,
    printed_at     timestamptz,
    device_id      text,
    printer_name   text,
    counter_number integer,
    called_at      timestamptz,
    created_at     timestamptz not null,
    updated_at     timestamptz not null,
    synced_at      timestamptz not null default now(),
    unique (business_date, ticket_number)
);

-- Additive migration for projects created from the Phase 1 version of
-- this file (safe to re-run: IF NOT EXISTS on everything).
alter table tickets add column if not exists counter_number integer;
alter table tickets add column if not exists called_at timestamptz;

-- Certificate / student-affairs admission stage.
--
-- certificate_type is the stable id chosen at print time on the
-- desktop app (see app/core/certificates.py) and pushed up with the
-- ticket. Everything downstream keys off it — never off the Arabic
-- label. Nullable: tickets printed before this feature existed have
-- none, and are simply never eligible for a certificate queue.
alter table tickets add column if not exists certificate_type text;
alter table tickets add column if not exists first_review_completed_at timestamptz;
alter table tickets add column if not exists admission_called_at timestamptz;
alter table tickets add column if not exists admission_desk text;
alter table tickets add column if not exists completed_at timestamptz;

create index if not exists idx_tickets_business_date on tickets(business_date);
create index if not exists idx_tickets_waiting
    on tickets(business_date, ticket_number)
    where status = 'PRINTED' and called_at is null;

-- The admission queue lookup: "oldest ticket waiting for admission,
-- among these certificate types". Partial index so it stays small and
-- exactly matches the predicate admission_call_next() uses.
create index if not exists idx_tickets_waiting_admission
    on tickets(business_date, certificate_type, ticket_number)
    where status = 'WAITING_FOR_ADMISSION';

alter table tickets enable row level security;

-- Desktop app sync (unchanged from Phase 1): the printer PC's anon key
-- upserts its own printed tickets directly. This key is only ever
-- held by the printer PC, not shipped to the browser.
drop policy if exists "desktop app can insert tickets" on tickets;
create policy "desktop app can insert tickets"
    on tickets for insert
    to anon
    with check (true);

drop policy if exists "desktop app can upsert its own tickets" on tickets;
create policy "desktop app can upsert its own tickets"
    on tickets for update
    to anon
    using (true)
    with check (true);

-- Public read (the Vercel display/call pages use the anon key too —
-- browser-exposed, so it must stay read-only + the RPC below).
drop policy if exists "anyone with anon key can read tickets" on tickets;
create policy "anyone with anon key can read tickets"
    on tickets for select
    to anon
    using (true);

-- NOTE: the same broad "using (true)" UPDATE policy above technically
-- also lets anyone with the anon key hand-craft a direct update to
-- tickets (e.g. change status themselves) — that was an accepted
-- simplification back when only the desktop app held this key. Now
-- that the key is exposed in the browser (Vercel), the honest fix is
-- a separate, narrower key/policy for the desktop sync vs. the public
-- pages. Tracked as a known follow-up, not solved by this migration —
-- see PHASE2_WEB.md "Known limitations".

-- Atomically call the oldest waiting ticket to a counter. SECURITY
-- DEFINER means it runs with the owner's privileges and bypasses RLS
-- internally, so it can update `tickets` even though anon has no
-- direct column-level grant on status/counter_number/called_at beyond
-- the broad policy above — this is the intended, safe write path.
-- Returns zero rows if nothing is waiting (checked by the caller as
-- "no waiting tickets", not an error).
create or replace function call_next_ticket(p_business_date date, p_counter_number integer)
returns table(out_ticket_number integer, out_counter_number integer, out_called_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_now timestamptz := now();
    v_ticket_number integer;
    v_called_at timestamptz;
begin
    update tickets t
    set status = 'CALLED',
        counter_number = p_counter_number,
        called_at = v_now,
        updated_at = v_now
    where t.uuid = (
        select uuid from tickets
        where business_date = p_business_date
          and status = 'PRINTED'
          and called_at is null
        order by ticket_number asc
        limit 1
        for update skip locked
    )
    returning t.ticket_number, t.called_at into v_ticket_number, v_called_at;

    if v_ticket_number is null then
        return; -- empty result set = queue is empty right now
    end if;

    out_ticket_number := v_ticket_number;
    out_counter_number := p_counter_number;
    out_called_at := v_called_at;
    return next;
end;
$$;

grant execute on function call_next_ticket(date, integer) to anon;

-- ---------------------------------------------------------------------
-- Stage 2: first reviewer finishes → ticket enters its certificate queue
-- ---------------------------------------------------------------------
--
-- finish_first_review_and_call_next() below does both halves ("I'm
-- done with this student" + "send me the next one") in one atomic
-- call. It's kept for compatibility (and still the right choice for
-- any one-button caller) but the /call page no longer uses it as of
-- the two-step "اطلب رقم جديد" / "تمت المراجعة" workflow: a reviewer
-- finishing a student doesn't necessarily mean they're ready for the
-- next one immediately, so the two actions are split into
-- finish_first_review() and call_next_ticket() (above), called
-- separately by two different button states on the same page.
--
-- call_next_ticket() above is deliberately left untouched: the older
-- local FastAPI display (app/web/) and any bookmarked client still
-- call it, and it must keep behaving exactly as it did.
--
-- Tickets with no certificate_type (printed before certificates
-- existed) go straight to COMPLETED rather than WAITING_FOR_ADMISSION:
-- no admission employee selects a NULL certificate, so queueing them
-- would strand them in a queue nobody can ever drain.
create or replace function finish_first_review_and_call_next(
    p_business_date date,
    p_counter_number integer
)
returns table(
    out_ticket_number integer,
    out_counter_number integer,
    out_called_at timestamptz,
    out_certificate_type text,
    out_finished_ticket_number integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_now timestamptz := now();
    v_finished_number integer;
    v_ticket_number integer;
    v_called_at timestamptz;
    v_certificate_type text;
begin
    -- 1. Hand off whoever this counter was serving. Only the most
    --    recently called one: a counter serves one student at a time,
    --    and scoping it this way leaves any older CALLED rows (e.g.
    --    from before this workflow existed) exactly as they were.
    update tickets t
    set status = case
                     when t.certificate_type is null then 'COMPLETED'
                     else 'WAITING_FOR_ADMISSION'
                 end,
        first_review_completed_at = v_now,
        completed_at = case when t.certificate_type is null then v_now else null end,
        updated_at = v_now
    where t.uuid = (
        select uuid from tickets
        where business_date = p_business_date
          and counter_number = p_counter_number
          and status = 'CALLED'
        order by called_at desc
        limit 1
        for update skip locked
    )
    returning t.ticket_number into v_finished_number;

    -- 2. Same claim as call_next_ticket(): oldest waiting ticket in the
    --    general hall, locked so two counters can't take the same one.
    update tickets t
    set status = 'CALLED',
        counter_number = p_counter_number,
        called_at = v_now,
        updated_at = v_now
    where t.uuid = (
        select uuid from tickets
        where business_date = p_business_date
          and status = 'PRINTED'
          and called_at is null
        order by ticket_number asc
        limit 1
        for update skip locked
    )
    returning t.ticket_number, t.called_at, t.certificate_type
        into v_ticket_number, v_called_at, v_certificate_type;

    -- Always return a row, even when the general queue was empty, so
    -- the caller can still report "I filed the previous student, there
    -- just isn't a next one yet" rather than losing that fact.
    out_finished_ticket_number := v_finished_number;
    out_ticket_number := v_ticket_number;
    out_counter_number := case when v_ticket_number is null then null else p_counter_number end;
    out_called_at := v_called_at;
    out_certificate_type := v_certificate_type;
    return next;
end;
$$;

grant execute on function finish_first_review_and_call_next(date, integer) to anon;

-- Just the "I'm done with this student" half, on its own — the /call
-- page's "تمت المراجعة" (review completed) button. Deliberately does
-- NOT also claim a next ticket: a reviewer can finish with someone and
-- not be ready to call the next one immediately (paperwork, a break,
-- anything), and forcing an immediate call was the bug this function
-- exists to fix. Same claim/lock shape as the first half of
-- finish_first_review_and_call_next() above — see that function's
-- comments for why FOR UPDATE SKIP LOCKED and "most recent CALLED row"
-- are the right scoping.
create or replace function finish_first_review(
    p_business_date date,
    p_counter_number integer
)
returns table(out_finished_ticket_number integer)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_now timestamptz := now();
    v_finished_number integer;
begin
    update tickets t
    set status = case
                     when t.certificate_type is null then 'COMPLETED'
                     else 'WAITING_FOR_ADMISSION'
                 end,
        first_review_completed_at = v_now,
        completed_at = case when t.certificate_type is null then v_now else null end,
        updated_at = v_now
    where t.uuid = (
        select uuid from tickets
        where business_date = p_business_date
          and counter_number = p_counter_number
          and status = 'CALLED'
        order by called_at desc
        limit 1
        for update skip locked
    )
    returning t.ticket_number into v_finished_number;

    out_finished_ticket_number := v_finished_number;
    return next;
end;
$$;

grant execute on function finish_first_review(date, integer) to anon;

-- ---------------------------------------------------------------------
-- Stage 3: student affairs / admission calls the next student
-- ---------------------------------------------------------------------
--
-- p_certificate_types is the set of certificate queues this employee
-- signed up for on /admission. The claim is filtered to that set
-- server-side, not just in the UI: the anon key is public, so "an
-- employee can only call certificates they selected" has to be
-- enforced here to mean anything.
--
-- Double-calling protection is the same mechanism as the first
-- reviewer's: a single UPDATE whose subquery takes a row lock with FOR
-- UPDATE SKIP LOCKED. Two employees pressing "next" in the same
-- instant each skip the row the other locked, so they get different
-- students — never the same one, and never a deadlock.
--
-- admission_call_next() combines "finish current" + "claim next" in
-- one call, same as finish_first_review_and_call_next() did for the
-- first reviewer — kept for compatibility, but /admission now uses
-- the split pair below (admission_claim_next / admission_finish_review)
-- for the same reason /call was split: finishing a student doesn't
-- mean the employee is ready for the next one immediately.
create or replace function admission_call_next(
    p_business_date date,
    p_certificate_types text[],
    p_desk text default null
)
returns table(
    out_ticket_number integer,
    out_certificate_type text,
    out_called_at timestamptz,
    out_finished_ticket_number integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_now timestamptz := now();
    v_finished_number integer;
    v_ticket_number integer;
    v_certificate_type text;
    v_called_at timestamptz;
begin
    if p_certificate_types is null or array_length(p_certificate_types, 1) is null then
        return; -- no queues selected: nothing this employee may call
    end if;

    -- 1. Complete whoever this desk was serving (mirrors the first
    --    reviewer's "next also finishes the current one" behaviour, so
    --    both screens work identically for the employees).
    if p_desk is not null then
        update tickets t
        set status = 'COMPLETED',
            completed_at = v_now,
            updated_at = v_now
        where t.uuid = (
            select uuid from tickets
            where business_date = p_business_date
              and admission_desk = p_desk
              and status = 'CALLED_BY_ADMISSION'
            order by admission_called_at desc
            limit 1
            for update skip locked
        )
        returning t.ticket_number into v_finished_number;
    end if;

    -- 2. Claim the next student, FIFO by ticket_number across all the
    --    certificate queues this employee handles.
    update tickets t
    set status = 'CALLED_BY_ADMISSION',
        admission_called_at = v_now,
        admission_desk = p_desk,
        updated_at = v_now
    where t.uuid = (
        select uuid from tickets
        where business_date = p_business_date
          and status = 'WAITING_FOR_ADMISSION'
          and certificate_type = any(p_certificate_types)
        order by ticket_number asc
        limit 1
        for update skip locked
    )
    returning t.ticket_number, t.certificate_type, t.admission_called_at
        into v_ticket_number, v_certificate_type, v_called_at;

    out_finished_ticket_number := v_finished_number;
    out_ticket_number := v_ticket_number;
    out_certificate_type := v_certificate_type;
    out_called_at := v_called_at;
    return next;
end;
$$;

grant execute on function admission_call_next(date, text[], text) to anon;

-- Just the "claim next" half — /admission's "التالي" button. Does NOT
-- touch whoever this desk was previously serving; that's
-- admission_finish_review()'s job, called separately. Splitting these
-- (mirroring call_next_ticket / finish_first_review for the first
-- reviewer) means finishing a student and being ready to serve the
-- next one are two distinct actions, not one forced click.
create or replace function admission_claim_next(
    p_business_date date,
    p_certificate_types text[],
    p_desk text
)
returns table(
    out_ticket_number integer,
    out_certificate_type text,
    out_called_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_now timestamptz := now();
    v_ticket_number integer;
    v_certificate_type text;
    v_called_at timestamptz;
begin
    if p_certificate_types is null or array_length(p_certificate_types, 1) is null then
        return; -- no queues selected: nothing this employee may call
    end if;

    update tickets t
    set status = 'CALLED_BY_ADMISSION',
        admission_called_at = v_now,
        admission_desk = p_desk,
        updated_at = v_now
    where t.uuid = (
        select uuid from tickets
        where business_date = p_business_date
          and status = 'WAITING_FOR_ADMISSION'
          and certificate_type = any(p_certificate_types)
        order by ticket_number asc
        limit 1
        for update skip locked
    )
    returning t.ticket_number, t.certificate_type, t.admission_called_at
        into v_ticket_number, v_certificate_type, v_called_at;

    out_ticket_number := v_ticket_number;
    out_certificate_type := v_certificate_type;
    out_called_at := v_called_at;
    return next;
end;
$$;

grant execute on function admission_claim_next(date, text[], text) to anon;

-- Just the "I'm done with this student" half — /admission's "تمت
-- المراجعة" button. Scoped to p_desk, the same stable per-browser id
-- used everywhere else on this page, so it only ever completes the
-- student THIS desk is holding.
create or replace function admission_finish_review(
    p_business_date date,
    p_desk text
)
returns table(out_finished_ticket_number integer)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_now timestamptz := now();
    v_finished_number integer;
begin
    update tickets t
    set status = 'COMPLETED',
        completed_at = v_now,
        updated_at = v_now
    where t.uuid = (
        select uuid from tickets
        where business_date = p_business_date
          and admission_desk = p_desk
          and status = 'CALLED_BY_ADMISSION'
        order by admission_called_at desc
        limit 1
        for update skip locked
    )
    returning t.ticket_number into v_finished_number;

    out_finished_ticket_number := v_finished_number;
    return next;
end;
$$;

grant execute on function admission_finish_review(date, text) to anon;

-- Admin reset: wipes every ticket for a given business date (used by
-- the desktop app's PIN-gated "إعادة تعيين النظام" action to zero the
-- sequence, e.g. after a rehearsal/demo). Password-gated INSIDE the
-- function, not just client-side in the desktop app — the anon key
-- calling this RPC is also embedded in the public Vercel site, so a
-- client-side-only check would be no protection at all against
-- someone calling this RPC directly from a browser console. Only the
-- password check makes this safe to grant to anon.
create or replace function admin_reset_business_date(p_business_date date, p_password text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_password is distinct from '11223344' then
        raise exception 'invalid password';
    end if;

    delete from tickets where business_date = p_business_date;
end;
$$;

grant execute on function admin_reset_business_date(date, text) to anon;

-- Enable Realtime for the public display page's live subscription
-- (Database > Replication > supabase_realtime in the dashboard also
-- works instead of this statement). Guarded because, unlike the rest
-- of this file, ALTER PUBLICATION ... ADD TABLE errors on re-run if
-- the table is already a member.
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and tablename = 'tickets'
    ) then
        alter publication supabase_realtime add table tickets;
    end if;
end $$;
