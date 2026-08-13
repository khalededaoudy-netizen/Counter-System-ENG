-- Just the "claim next" half — /admission's "التالي" button. Does NOT
-- touch whoever this desk was previously serving; that's
-- admission_finish_review()'s job, called separately.
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
        return;
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
-- المراجعة" button. Scoped to p_desk so it only completes the student
-- THIS desk is holding.
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
