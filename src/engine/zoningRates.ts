/**
 * 지자체 조례 건폐율·용적률 조회 — Supabase zoning_rates 테이블 기반
 *
 * 원천: 국토부 토지이용규제법령정보(토지이음) 월별 데이터 (etl/load_luris.py 적재)
 * 조회 규칙:
 *  0) zoning_rate_overrides(수기 보정)가 있으면 최우선 적용 (별표 위임·분산 조번호 등 자동추출 실패분)
 *  1) 시군구 코드 정확 일치 → 없으면 시도 코드(앞 2자리+'000') 폴백 (광역시 조례)
 *  2) category='base' AND needs_review=false 만 사용 (특례·검수대상 제외)
 *  3) 용도지역명 정규화 후 정확 일치 우선, 실패 시 포함 매칭
 */

import { supabase, supabaseReady } from '../lib/supabase';

export interface RateInfo {
  /** 기본율(%) */
  pct: number;
  /** 근거 조례명 (예: 가평군 군계획 조례) */
  ordinance: string;
  /** 근거 조항 (예: 제49조 제19호) */
  provision: string;
  /** 시행일 (YYYY-MM-DD, 없을 수 있음) */
  enforceDt: string | null;
}

export interface ZoningRates {
  /** 건폐율 */
  bcr: RateInfo | null;
  /** 용적률 */
  far: RateInfo | null;
  /** 적용된 시군구 코드 (폴백 시 시도 코드) */
  appliedSgg: string;
  /** 시도 코드로 폴백되었는지 */
  sidoFallback: boolean;
}

function normZone(raw: string): string {
  return (raw || '').replace(/[\s·ㆍ()[\]]/g, '').trim();
}

interface Row {
  zone_nm: string;
  rate_kind: 'bcr' | 'far';
  rate_pct: number | null;
  ordinance: string | null;
  provision: string | null;
  enforce_dt: string | null;
}

interface OverrideRow {
  zone_nm: string;
  rate_kind: 'bcr' | 'far';
  rate_pct: number;
  ordinance: string | null;
  provision: string | null;
}

function pickRate(rows: Row[], zoneName: string, kind: 'bcr' | 'far'): RateInfo | null {
  const n = normZone(zoneName);
  const ofKind = rows.filter((r) => r.rate_kind === kind && r.rate_pct != null);
  // 정확 일치 우선
  let hit = ofKind.find((r) => normZone(r.zone_nm) === n);
  // 포함 매칭 (긴 이름 우선)
  if (!hit) {
    hit = ofKind
      .filter((r) => n.includes(normZone(r.zone_nm)) || normZone(r.zone_nm).includes(n))
      .sort((a, b) => normZone(b.zone_nm).length - normZone(a.zone_nm).length)[0];
  }
  if (!hit) return null;
  return {
    pct: Number(hit.rate_pct),
    ordinance: hit.ordinance ?? '',
    provision: hit.provision ?? '',
    enforceDt: hit.enforce_dt,
  };
}

/** 수기 보정 테이블에서 해당 시군구·용도지역 값 조회 (있으면 RateInfo, 없으면 null) */
function pickOverride(rows: OverrideRow[], zoneName: string, kind: 'bcr' | 'far'): RateInfo | null {
  const n = normZone(zoneName);
  const hit = rows.find((r) => r.rate_kind === kind && normZone(r.zone_nm) === n);
  if (!hit) return null;
  return {
    pct: Number(hit.rate_pct),
    ordinance: hit.ordinance ?? '',
    provision: hit.provision ?? '',
    enforceDt: null,
  };
}

/**
 * 시군구×용도지역의 조례 기본 건폐율·용적률 조회.
 * 데이터 미적재·미매칭·오류 시 null 필드로 조용히 폴백 (진단 흐름을 막지 않음).
 */
export async function fetchZoningRates(
  sgg: string | null,
  zoneName: string | null | undefined,
): Promise<ZoningRates | null> {
  if (!sgg || !zoneName || !supabaseReady || !supabase) return null;
  const sido = sgg.slice(0, 2) + '000';

  const query = (code: string) =>
    supabase!
      .from('zoning_rates')
      .select('zone_nm,rate_kind,rate_pct,ordinance,provision,enforce_dt')
      .eq('sgg_code', code)
      .eq('category', 'base')
      .eq('needs_review', false);

  try {
    // 0) 수기 보정 우선 조회 (해당 시군구)
    let overrides: OverrideRow[] = [];
    try {
      const ov = await supabase
        .from('zoning_rate_overrides')
        .select('zone_nm,rate_kind,rate_pct,ordinance,provision')
        .eq('sgg_code', sgg);
      overrides = (ov.data ?? []) as OverrideRow[];
    } catch { /* 보정 테이블 없거나 조회 실패 시 무시 */ }

    let applied = sgg;
    let fallback = false;
    let { data } = await query(sgg);
    if (!data || data.length === 0) {
      const res = await query(sido);
      data = res.data;
      applied = sido;
      fallback = true;
    }
    const rows = (data ?? []) as Row[];

    // 보정값이 자동추출값보다 우선
    const bcr = pickOverride(overrides, zoneName, 'bcr') ?? pickRate(rows, zoneName, 'bcr');
    const far = pickOverride(overrides, zoneName, 'far') ?? pickRate(rows, zoneName, 'far');
    if (!bcr && !far) return null;
    return { bcr, far, appliedSgg: applied, sidoFallback: fallback };
  } catch {
    return null;
  }
}
