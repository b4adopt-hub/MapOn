/**
 * 지자체 조례 행위제한(용도별 건축 가능여부) 조회 — Supabase permitted_uses 테이블 기반
 *
 * 원천: 국토부 토지이용규제 행위제한정보(토지이음) — 시군구×용도지역×토지이용행위 가능여부
 * 목적(Purpose) → 건축법 별표1 용도 키워드로 매핑해 해당 지자체 조례 기준의
 * 가능/금지/조건을 근거와 함께 반환한다. 데이터 없으면 null 폴백(진단 흐름 불간섭).
 *
 * 주의: 이 결과는 사전검토 안내이며 확정 판정이 아니다. 농지·산지전용,
 * 개발행위허가 등 별도 인허가는 기존 진단 로직이 별도 안내한다.
 */

import { Purpose } from './purposes';
import { supabase, supabaseReady } from '../lib/supabase';

/** 목적 → 건축물 용도 키워드 (건축법 시행령 별표1 명칭 기준).
 *  건축물이 아닌 목적(울타리·조경·농막)은 매핑 없음(조회 생략). */
const PURPOSE_USES: Partial<Record<Purpose, string[]>> = {
  house: ['단독주택'],
  cafe: ['휴게음식점', '제과점', '일반음식점'],
  warehouse: ['창고'],
  camping: ['야영장'],
  petfacility: ['동물병원', '동물미용', '동물위탁관리', '동물 관련 시설'],
  parking: ['주차장'],
  solar: ['태양광', '발전시설'],
};

export type UseVerdict = 'allowed' | 'conditional' | 'denied' | 'mixed';

export interface UseEvidence {
  landUse: string;
  decision: string;
  condition: string | null;
  lawName: string | null;
}

export interface PurposeUseResult {
  purpose: Purpose;
  verdict: UseVerdict;
  evidences: UseEvidence[];
  sidoFallback: boolean;
}

interface Row {
  zone_nm: string;
  land_use: string;
  decision: string;
  condition_note: string | null;
  law_name: string | null;
}

const strip = (s: string) => (s || '').replace(/[。\s]/g, '').trim();

function verdictOf(evs: UseEvidence[]): UseVerdict {
  const allow = evs.some((e) => e.decision.includes('가능'));
  const deny = evs.some((e) => e.decision.includes('금지'));
  if (allow && deny) return 'mixed';
  if (deny) return 'denied';
  return evs.some((e) => e.condition) ? 'conditional' : 'allowed';
}

async function queryRows(code: string, zoneName: string, keywords: string[]): Promise<Row[]> {
  if (!supabase) return [];
  const orExpr = keywords.map((k) => `land_use.ilike.%${k}%`).join(',');
  // 1차: 용도지역명 정확 일치
  let { data } = await supabase
    .from('permitted_uses')
    .select('zone_nm,land_use,decision,condition_note,law_name')
    .eq('sgg_code', code)
    .eq('zone_nm', zoneName.trim())
    .or(orExpr)
    .limit(120);
  if (!data || data.length === 0) {
    // 2차: 표기 흔들림 대비 포함 매칭
    const res = await supabase
      .from('permitted_uses')
      .select('zone_nm,land_use,decision,condition_note,law_name')
      .eq('sgg_code', code)
      .ilike('zone_nm', `%${strip(zoneName)}%`)
      .or(orExpr)
      .limit(120);
    data = res.data;
  }
  return (data ?? []) as Row[];
}

/**
 * 선택 목적들의 용도별 건축 가능여부 조회.
 * 시군구 정확 일치 → 시도 코드 폴백. 데이터·매핑 없으면 해당 목적 생략.
 */
export async function fetchPermittedUses(
  sgg: string | null,
  zoneName: string | null | undefined,
  purposes: Purpose[],
): Promise<PurposeUseResult[]> {
  if (!sgg || !zoneName || !supabaseReady || !supabase) return [];
  const sido = sgg.slice(0, 2) + '000';
  const out: PurposeUseResult[] = [];

  for (const p of purposes) {
    const keywords = PURPOSE_USES[p];
    if (!keywords) continue;
    try {
      let rows = await queryRows(sgg, zoneName, keywords);
      let fallback = false;
      if (rows.length === 0) {
        rows = await queryRows(sido, zoneName, keywords);
        fallback = true;
      }
      if (rows.length === 0) continue;
      // 용도명 중복 제거 + 키워드 적합도(짧은 용도명 우선) 정렬
      const seen = new Set<string>();
      const evs: UseEvidence[] = [];
      for (const r of rows.sort((a, b) => strip(a.land_use).length - strip(b.land_use).length)) {
        const key = strip(r.land_use);
        if (seen.has(key)) continue;
        seen.add(key);
        evs.push({
          landUse: (r.land_use || '').replace(/。/g, '').trim(),
          decision: (r.decision || '').trim(),
          condition: r.condition_note?.trim() || null,
          lawName: r.law_name?.trim() || null,
        });
        if (evs.length >= 4) break;
      }
      out.push({ purpose: p, verdict: verdictOf(evs), evidences: evs, sidoFallback: fallback });
    } catch {
      /* 목적 단위 실패는 조용히 생략 */
    }
  }
  return out;
}
