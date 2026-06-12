-- ============================================================
-- MapOn 03: diagnoses(진단 결과) + demand_signals(익명 수요 집계)
-- ============================================================

-- diagnoses : 사용자 진단 결과 (본인만 접근)
create table public.diagnoses (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  pnu          varchar(19) references public.land_lookups(pnu),
  purpose      text,                  -- 전원주택/농막/창고/카페/캠핑장/반려동물시설 등
  budget_min   numeric,
  budget_max   numeric,
  timeframe    text,
  purpose_grade text,                 -- 가능성높음/조건부검토/전문가확인필요/리스크높음/불가가능성높음
  risk_items   jsonb,                 -- 위험도 항목 배열
  recommendations jsonb,              -- 추천 시설물 배열
  est_cost_min numeric,
  est_cost_max numeric,
  created_at   timestamptz not null default now()
);

create index idx_diagnoses_user on public.diagnoses (user_id, created_at desc);

alter table public.diagnoses enable row level security;

create policy "diagnoses_select_own"
  on public.diagnoses for select
  using (auth.uid() = user_id);

create policy "diagnoses_insert_own"
  on public.diagnoses for insert
  with check (auth.uid() = user_id);

create policy "diagnoses_delete_own"
  on public.diagnoses for delete
  using (auth.uid() = user_id);

-- demand_signals : 익명 수요 집계 (B2B 영업 자산)
-- 개인정보·정확한 지번 미포함. 시군구 단위 + 목적 + 예산대 + 시기.
create table public.demand_signals (
  id           uuid primary key default gen_random_uuid(),
  sido         text not null,
  sigungu      text,
  purpose      text not null,
  budget_band  text,
  timeframe    text,
  created_at   timestamptz not null default now()
);

create index idx_demand_region_purpose on public.demand_signals (sido, sigungu, purpose, created_at desc);

alter table public.demand_signals enable row level security;

-- 임의 오염 방지: 필수 필드 존재 + 길이 제한
create policy "demand_insert_authenticated"
  on public.demand_signals for insert
  to authenticated
  with check (
    sido is not null
    and char_length(sido) <= 20
    and purpose is not null
    and char_length(purpose) <= 40
    and (sigungu is null or char_length(sigungu) <= 30)
    and (budget_band is null or char_length(budget_band) <= 30)
    and (timeframe is null or char_length(timeframe) <= 30)
  );

-- select 정책 미부여 = 기본 차단. 집계는 추후 service_role 기반 함수로 제공.
