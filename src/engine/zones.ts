/**
 * 용도지역 분류 및 법령 기본값
 * 근거: 국토의 계획 및 이용에 관한 법률 제76~78조, 시행령 제30·84·85조
 *
 * 주의: 건폐율/용적률의 구체 수치와 행위제한은 최종적으로
 * 지자체 도시·군계획조례에서 정해진다. 아래 값은 법령상 "최대한도"의
 * 일반 기준이며, 실제 적용은 반드시 해당 지자체 조례 확인이 필요하다.
 * 따라서 이 데이터는 1차 사전검토 등급 산출용이며 확정 판정이 아니다.
 */

export type ZoneCategory =
  | 'urban' // 도시지역
  | 'management' // 관리지역
  | 'agriculture' // 농림지역
  | 'conservation'; // 자연환경보전지역

export interface ZoneInfo {
  /** 표준 코드 (내부 식별자) */
  code: string;
  /** 용도지역명 (토지이음/브이월드 표기와 매칭) */
  name: string;
  category: ZoneCategory;
  /** 법령상 건폐율 최대한도(%) — 조례로 더 강화될 수 있음 */
  bcrMax: number;
  /** 법령상 용적률 최대한도(%) — 조례로 더 강화될 수 있음 */
  farMax: number;
  /** 비도시(비도시지역) 여부 — MAP On 주 대상 */
  nonUrban: boolean;
}

/**
 * 용도지역 마스터 테이블 (소분류 21종 + 비세분 관리지역 보조 항목)
 * 토지이음/브이월드가 반환하는 용도지역명은 표기가 다양하므로
 * matchZone() 에서 정규화하여 매칭한다.
 */
export const ZONES: ZoneInfo[] = [
  // ── 도시지역: 주거 ──
  { code: 'res_excl_1', name: '제1종전용주거지역', category: 'urban', bcrMax: 50, farMax: 100, nonUrban: false },
  { code: 'res_excl_2', name: '제2종전용주거지역', category: 'urban', bcrMax: 50, farMax: 150, nonUrban: false },
  { code: 'res_gen_1', name: '제1종일반주거지역', category: 'urban', bcrMax: 60, farMax: 200, nonUrban: false },
  { code: 'res_gen_2', name: '제2종일반주거지역', category: 'urban', bcrMax: 60, farMax: 250, nonUrban: false },
  { code: 'res_gen_3', name: '제3종일반주거지역', category: 'urban', bcrMax: 50, farMax: 300, nonUrban: false },
  { code: 'res_semi', name: '준주거지역', category: 'urban', bcrMax: 70, farMax: 500, nonUrban: false },
  // ── 도시지역: 상업 ──
  { code: 'com_central', name: '중심상업지역', category: 'urban', bcrMax: 90, farMax: 1500, nonUrban: false },
  { code: 'com_general', name: '일반상업지역', category: 'urban', bcrMax: 80, farMax: 1300, nonUrban: false },
  { code: 'com_neighbor', name: '근린상업지역', category: 'urban', bcrMax: 70, farMax: 900, nonUrban: false },
  { code: 'com_dist', name: '유통상업지역', category: 'urban', bcrMax: 80, farMax: 1100, nonUrban: false },
  // ── 도시지역: 공업 ──
  { code: 'ind_excl', name: '전용공업지역', category: 'urban', bcrMax: 70, farMax: 300, nonUrban: false },
  { code: 'ind_general', name: '일반공업지역', category: 'urban', bcrMax: 70, farMax: 350, nonUrban: false },
  { code: 'ind_semi', name: '준공업지역', category: 'urban', bcrMax: 70, farMax: 400, nonUrban: false },
  // ── 도시지역: 녹지 ──
  { code: 'green_conserv', name: '보전녹지지역', category: 'urban', bcrMax: 20, farMax: 80, nonUrban: false },
  { code: 'green_prod', name: '생산녹지지역', category: 'urban', bcrMax: 20, farMax: 100, nonUrban: false },
  { code: 'green_nat', name: '자연녹지지역', category: 'urban', bcrMax: 20, farMax: 100, nonUrban: false },
  // ── 관리지역 ──
  { code: 'mng_conserv', name: '보전관리지역', category: 'management', bcrMax: 20, farMax: 80, nonUrban: true },
  { code: 'mng_prod', name: '생산관리지역', category: 'management', bcrMax: 20, farMax: 80, nonUrban: true },
  { code: 'mng_plan', name: '계획관리지역', category: 'management', bcrMax: 40, farMax: 100, nonUrban: true },
  // ── 농림지역 ──
  { code: 'agri', name: '농림지역', category: 'agriculture', bcrMax: 20, farMax: 80, nonUrban: true },
  // ── 자연환경보전지역 ──
  { code: 'conserv', name: '자연환경보전지역', category: 'conservation', bcrMax: 20, farMax: 80, nonUrban: true },
];

/** 용도지역명 정규화: 공백·괄호·로마자 등 표기 흔들림 제거 */
function normalizeZoneName(raw: string): string {
  return raw
    .replace(/\s+/g, '')
    .replace(/[()[\]]/g, '')
    .replace(/제([1-3])종/g, '제$1종')
    .trim();
}

/**
 * 토지이음/브이월드가 반환한 용도지역 문자열을 ZoneInfo로 매칭.
 * 부분 포함 매칭을 허용하되, 더 구체적인(긴) 이름을 우선한다.
 * 매칭 실패 시 null — 호출부에서 "용도지역 확인 필요"로 처리.
 */
export function matchZone(raw: string | null | undefined): ZoneInfo | null {
  if (!raw) return null;
  const n = normalizeZoneName(raw);
  // 정확 일치 우선
  const exact = ZONES.find((z) => normalizeZoneName(z.name) === n);
  if (exact) return exact;
  // 부분 포함 매칭 — 가장 긴 이름이 먼저 잡히도록 정렬
  const candidates = [...ZONES]
    .sort((a, b) => b.name.length - a.name.length)
    .filter((z) => n.includes(normalizeZoneName(z.name)));
  return candidates[0] ?? null;
}
