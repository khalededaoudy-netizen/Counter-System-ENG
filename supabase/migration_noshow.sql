-- Mark a ticket as NO_SHOW at a general counter.
create or replace function mark_no_show(
    p_business_date date,
    p_counter_number integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update tickets t
    set status = 'NO_SHOW',
        updated_at = now()
    where t.uuid = (
        select uuid from tickets
        where business_date = p_business_date
          and counter_number = p_counter_number
          and status = 'CALLED'
        order by called_at desc
        limit 1
        for update skip locked
    );
end;
$$;

grant execute on function mark_no_show(date, integer) to anon;

-- Recall a specific ticket from the NO_SHOW list to a general counter.
create or replace function recall_no_show(
    p_business_date date,
    p_counter_number integer,
    p_ticket_number integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update tickets
    set status = 'CALLED',
        counter_number = p_counter_number,
        called_at = now(),
        updated_at = now()
    where business_date = p_business_date
      and ticket_number = p_ticket_number
      and status = 'NO_SHOW';
end;
$$;

grant execute on function recall_no_show(date, integer, integer) to anon;

-- Mark a ticket as ADMISSION_NO_SHOW at an admission desk.
create or replace function admission_mark_no_show(
    p_business_date date,
    p_desk text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update tickets t
    set status = 'ADMISSION_NO_SHOW',
        updated_at = now()
    where t.uuid = (
        select uuid from tickets
        where business_date = p_business_date
          and admission_desk = p_desk
          and status = 'CALLED_BY_ADMISSION'
        order by admission_called_at desc
        limit 1
        for update skip locked
    );
end;
$$;

grant execute on function admission_mark_no_show(date, text) to anon;

-- Recall a specific ticket from the ADMISSION_NO_SHOW list to an admission desk.
create or replace function admission_recall_no_show(
    p_business_date date,
    p_desk text,
    p_ticket_number integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    update tickets
    set status = 'CALLED_BY_ADMISSION',
        admission_desk = p_desk,
        admission_called_at = now(),
        updated_at = now()
    where business_date = p_business_date
      and ticket_number = p_ticket_number
      and status = 'ADMISSION_NO_SHOW';
end;
$$;

grant execute on function admission_recall_no_show(date, text, integer) to anon;
