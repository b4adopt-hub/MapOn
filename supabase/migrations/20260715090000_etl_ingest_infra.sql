-- 관리자 파일업로드 ETL 인프라: 작업 추적 + 월별 멱등 리셋 + 진행 카운터
-- (2026-07-15 Supabase MCP apply_migration 'etl_ingest_infra'로 적용됨 — 저장소 기록용)
create table if not exists public.etl_jobs (
  id uuid primary key default gen_random_uuid(),
  table_name text not null check (table_name in ('permitted_uses')),
  src_month text not null check (src_month ~ '^\d{6}$'),
  status text not null default 'running' check (status in ('running','done','failed','canceled')),
  file_name text,
  total_rows bigint,
  inserted_rows bigint not null default 0,
  deleted_rows bigint not null default 0,
  error text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.etl_jobs enable row level security;

drop policy if exists etl_jobs_admin_read on public.etl_jobs;
create policy etl_jobs_admin_read on public.etl_jobs
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

create index if not exists permitted_uses_src_month_idx
  on public.permitted_uses (src_month);

create or replace function public.etl_reset_permitted_uses(p_month text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare n bigint;
begin
  set local statement_timeout = '600s';
  delete from public.permitted_uses where src_month = p_month;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.etl_reset_permitted_uses(text) from public, anon, authenticated;

create or replace function public.etl_job_progress(p_job uuid, p_add bigint)
returns bigint
language sql
security definer
set search_path = public
as $$
  update public.etl_jobs
     set inserted_rows = inserted_rows + p_add,
         updated_at = now()
   where id = p_job
  returning inserted_rows;
$$;

revoke execute on function public.etl_job_progress(uuid, bigint) from public, anon, authenticated;
