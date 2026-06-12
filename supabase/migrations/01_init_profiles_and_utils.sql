-- ============================================================
-- MapOn 01: 공통 유틸 + profiles
-- 인증 경로: Google(OAuth) / Kakao(OIDC) / Email(직접입력, b4adopt 방식)
-- 모두 auth.users 로 수렴. 아래는 그 위 애플리케이션 레이어.
-- ============================================================

-- updated_at 자동 갱신 트리거 함수 (search_path 고정)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- profiles : auth.users 1:1 확장
-- ------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  auth_provider text,                  -- 'google' | 'kakao' | 'email'
  region_sido  text,                   -- 관심 시도 (선택)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

-- 신규 auth.users 생성 시 profiles 자동 생성
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, auth_provider)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'),
    coalesce(new.raw_app_meta_data->>'provider', 'email')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 트리거 전용 함수 REST 노출 차단
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.set_updated_at()  from anon, authenticated, public;
