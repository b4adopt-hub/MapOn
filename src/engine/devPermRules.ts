/**
 * 개발행위허가 기준(경사도·표고·입목축적)·도로요건 조회 — Supabase devperm_rules 기반
 *
 * 이 영역은 토지이음 정형 데이터셋 밖이라 지자체 조례 조문에서 실측 등재한다.
 * 등재된 지자체는 수치를 근거와 함께 안내하고,
 * 미등재 지자체는 null 반환 → 앱이 조례 조문 링크 안내로 폴백(자동 단정하지 않음).
 */

import { supabase, supabaseReady } from '../lib/supabase';

export interface SlopeRule {
  /** 기본 허용 경사도(도) */
  baseDeg: number | null;
  /** 진입로 종단경사도 상한(%) */
  accessRoadPct: number | null;
  /** 지역구분별 추가 기준(읽면·지역별 차등 등) */
  areas: { area: string; valueDeg?: number; valuePct?: number }[];
  ordinance: string;
  provision: string;
  note: string | null;
}

export interface DevPermRules {
  slope: SlopeRule | null;
  /** 입목축적 기준 요약 문자열 */
  forestStock: { text: string; ordinance: string; provision: string } | null;
}

interface DetailRow {
  rule_kind: 'slope' | 'elevation' | 'forest_stock' | 'road_width';
  detail: any;
  ordinance: string | null;
  provision: string | null;
  note: string | null;
}

/**
 * 개발행위허가 기준 조회. 등재된 지자체만 값을 반환하며,
 * 미등재 시 null(앱이 조례 링크 안내로 폴백).
 */
export async function fetchDevPermRules(sgg: string | null): Promise<DevPermRules | null> {
  if (!sgg || !supabaseReady || !supabase) return null;
  try {
    const { data } = await supabase
      .from('devperm_rules')
      .select('rule_kind,detail,ordinance,provision,note')
      .eq('sgg_code', sgg);
    if (!data || data.length === 0) return null;
    const rows = data as DetailRow[];

    let slope: SlopeRule | null = null;
    const s = rows.find((r) => r.rule_kind === 'slope');
    if (s && s.detail) {
      const items: any[] = Array.isArray(s.detail.items) ? s.detail.items : [];
      const base = items.find((i) => i.area === '기본' && i.value_deg != null);
      const road = items.find((i) => i.value_pct != null && /진입로|종단/.test(i.area || ''));
      slope = {
        baseDeg: base?.value_deg ?? null,
        accessRoadPct: road?.value_pct ?? null,
        areas: items
          .filter((i) => i.area && i.area !== '기본' && !/진입로|종단/.test(i.area))
          .map((i) => ({ area: i.area, valueDeg: i.value_deg, valuePct: i.value_pct })),
        ordinance: s.ordinance ?? '',
        provision: s.provision ?? '',
        note: s.note,
      };
    }

    let forestStock: DevPermRules['forestStock'] = null;
    const f = rows.find((r) => r.rule_kind === 'forest_stock');
    if (f && f.detail) {
      forestStock = {
        text: f.detail.desc ?? `군(시) 평균의 ${f.detail.value_pct}% 이하`,
        ordinance: f.ordinance ?? '',
        provision: f.provision ?? '',
      };
    }

    if (!slope && !forestStock) return null;
    return { slope, forestStock };
  } catch {
    return null;
  }
}

/**
 * 사용자 입력 경사도(%)를 개발행위 경사도 기준(도)과 비교해 신호 반환.
 * 입력은 %, 기준은 도(deg) — tan 변환으로 비교. 경계부근은 caution.
 */
export function slopeVerdict(userSlopePct: number | null, baseDeg: number | null):
  { level: 'info' | 'caution' | 'warning'; text: string } | null {
  if (userSlopePct == null || baseDeg == null) return null;
  const userDeg = Math.atan(userSlopePct / 100) * (180 / Math.PI);
  const margin = baseDeg - userDeg;
  if (margin < 0) {
    return {
      level: 'warning',
      text: `입력 경사 ${userSlopePct}%(약 ${userDeg.toFixed(1)}도)가 개발행위허가 기준 ${baseDeg}도를 초과합니다. 도시계획위원회 심의 대상이거나 허가가 어려울 수 있습니다.`,
    };
  }
  if (margin < 3) {
    return {
      level: 'caution',
      text: `입력 경사 ${userSlopePct}%(약 ${userDeg.toFixed(1)}도)가 기준 ${baseDeg}도에 근접합니다. 실측·산정방식에 따라 초과될 수 있으니 확인이 필요합니다.`,
    };
  }
  return {
    level: 'info',
    text: `입력 경사 ${userSlopePct}%(약 ${userDeg.toFixed(1)}도)는 개발행위허가 경사도 기준 ${baseDeg}도 이내입니다(평균경사도 산정은 별도).`,
  };
}
