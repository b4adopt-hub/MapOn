-- 크레딧: 일반회원 기본 1크레딧. 토지 조회 시 1 차감.
alter table public.profiles
  add column if not exists credits integer not null default 1;

-- 기존 사용자에게도 최소 1크레딧 보장(0 이하만 1로)
update public.profiles set credits = 1 where credits is null or credits < 1;

-- 원자적 크레딧 차감 RPC.
-- 반환: 남은 크레딧(차감 성공) / 관리자는 차감 없이 -1 반환(무한 취급) / 부족 시 예외.
create or replace function public.consume_credit()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_remaining integer;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select role into v_role from public.profiles where id = auth.uid();

  -- 관리자는 무제한(차감 없음). 무한을 -1로 표기.
  if v_role = 'admin' then
    return -1;
  end if;

  update public.profiles
    set credits = credits - 1
    where id = auth.uid() and credits > 0
    returning credits into v_remaining;

  if v_remaining is null then
    raise exception 'INSUFFICIENT_CREDITS';
  end if;

  return v_remaining;
end;
$$;

revoke execute on function public.consume_credit() from anon, public;
grant  execute on function public.consume_credit() to authenticated;
