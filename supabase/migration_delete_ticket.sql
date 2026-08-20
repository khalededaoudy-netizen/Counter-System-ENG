-- Add admin_delete_ticket SECURITY DEFINER function to delete an individual ticket by UUID.
-- Gated by password check ('512333' or '11223344') matching admin_reset_business_date.

create or replace function admin_delete_ticket(p_uuid uuid, p_password text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_password not in ('512333', '11223344') then
        raise exception 'invalid password';
    end if;

    delete from tickets where uuid = p_uuid;
end;
$$;

grant execute on function admin_delete_ticket(uuid, text) to anon;
