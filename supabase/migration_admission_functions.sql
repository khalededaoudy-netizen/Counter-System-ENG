-- ---------------------------------------------------------------------
-- Stage 2: first reviewer finishes → ticket enters its certificate queue
-- ---------------------------------------------------------------------
--
-- The first reviewer's screen has exactly one button ("next"), and it
-- has always meant "I'm done with the person in front of me, send me
-- the next one". That single action now also has to hand the finished
-- student off to student affairs, so both halves happen in ONE
-- function — and therefore one transaction. Splitting it into two
-- round-trips from the browser would leave a window where a dropped
-- connection strands a student as neither being-reviewed nor queued
-- for admission, with no screen showing them anywhere.
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
