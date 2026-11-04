-- fee_create_run: WITH ORDINALITY needs ROWS FROM() around a column definition list (it failed on its first real call).
create or replace function public.fee_create_run(p_total text, p_receipts jsonb, p_items jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  rid bigint;
  claimed integer;
begin
  insert into fee_runs (total) values (p_total) returning id into rid;
  update fee_receipts r set run_id = rid
    from jsonb_to_recordset(p_receipts) as x(tx_hash text, log_index integer)
    where r.tx_hash = x.tx_hash and r.log_index = x.log_index and r.run_id is null;
  get diagnostics claimed = row_count;
  if claimed <> jsonb_array_length(p_receipts) then
    raise exception 'fee_create_run: % of % fees were still unpaid', claimed, jsonb_array_length(p_receipts);
  end if;
  insert into fee_run_items (run_id, seq, kind, token, amount)
    select rid, (x.ord - 1)::integer, x.kind, x.token, x.amount
    from rows from (jsonb_to_recordset(p_items) as (kind text, token text, amount text)) with ordinality as x(kind, token, amount, ord);
  return rid;
end $$;
revoke all on function public.fee_create_run(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.fee_create_run(text, jsonb, jsonb) to service_role;
