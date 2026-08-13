-- Just the "I'm done with this student" half, on its own — the /call
-- page's "تمت المراجعة" (review completed) button. Deliberately does
-- NOT also claim a next ticket: a reviewer can finish with someone and
-- not be ready to call the next one immediately (paperwork, a break,
-- anything), and forcing an immediate call was the bug this function
-- exists to fix. Same claim/lock shape as the first half of
-- finish_first_review_and_call_next() — see supabase/schema.sql for
-- why FOR UPDATE SKIP LOCKED and "most recent CALLED row" are the
-- right scoping.
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
