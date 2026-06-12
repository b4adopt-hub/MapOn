-- ============================================================
-- MapOn 02: land_lookups (토지 조회 캐시)
-- 브이월드/토지이음 API 응답을 PNU 기준 캐싱.
-- API 속도(PNU 100개당 40~60초)·무상 호출 한도 대응 필수.
-- 캐시는 공용 자원: 읽기 공개(authenticated), 쓰기는 service_role 만.
-- ============================================================

create table public.land_lookups (
  pnu            varchar(19) primary key,         -- 필지고유번호 19자리
  address        text,                            -- 지번주소
  jimok          text,                            -- 지목
  area_sqm       numeric,                         -- 면적(㎡)
  use_zone       text,                            -- 용도지역(주)
  use_zone_sub   text,                            -- 용도지역(부)
  official_price numeric,                         -- 개별공시지가(원/㎡)
  lat            double precision,
  lng            double precision,
  geom_boundary  jsonb,                           -- 지적 경계 폴리곤(GeoJSON)
  vworld_raw     jsonb,                           -- 브이월드 원본 응답
  luris_raw      jsonb,                           -- 토지이음 규제 원본 응답
  fetched_at     timestamptz not null default now(),
  expires_at     timestamptz not null default (now() + interval '30 days')
);

create index idx_land_lookups_expires on public.land_lookups (expires_at);
create index idx_land_lookups_latlng  on public.land_lookups (lat, lng);

alter table public.land_lookups enable row level security;

create policy "land_lookups_select_authenticated"
  on public.land_lookups for select
  to authenticated
  using (true);

-- 쓰기는 service_role(Edge Function)만. service_role 은 RLS 우회.
