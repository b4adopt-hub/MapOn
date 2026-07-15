-- ETL 리셋 timeout 회피(배치 삭제) + zoning_rates 적재 경로 추가
-- (2026-07-15 Supabase MCP apply_migration 'etl_batch_reset_and_zoning'로 적용됨 — 저장소 기록용)

-- permitted_uses 대량 삭제를 배치 루프로 (단일 DELETE statement timeout 회피)
create or replace function public.etl_reset_permitted_uses(p_month text)
returns bigint language plpgsql security definer set search_path = public as $$
declare total bigint := 0; n bigint;
begin
  loop
    delete from public.permitted_uses
     where ctid in (select ctid from public.permitted_uses where src_month = p_month limit 50000);
    get diagnostics n = row_count; total := total + n;
    exit when n = 0;
  end loop;
  return total;
end $$;
revoke execute on function public.etl_reset_permitted_uses(text) from public, anon, authenticated;

-- etl_jobs가 두 테이블을 추적
alter table public.etl_jobs drop constraint if exists etl_jobs_table_name_check;
alter table public.etl_jobs add constraint etl_jobs_table_name_check
  check (table_name in ('permitted_uses','zoning_rates'));

-- zoning_rates 월별 배치 삭제
create or replace function public.etl_reset_zoning_rates(p_month text)
returns bigint language plpgsql security definer set search_path = public as $$
declare total bigint := 0; n bigint;
begin
  loop
    delete from public.zoning_rates
     where ctid in (select ctid from public.zoning_rates where src_month = p_month limit 50000);
    get diagnostics n = row_count; total := total + n;
    exit when n = 0;
  end loop;
  return total;
end $$;
revoke execute on function public.etl_reset_zoning_rates(text) from public, anon, authenticated;

create index if not exists zoning_rates_src_month_idx on public.zoning_rates (src_month);
