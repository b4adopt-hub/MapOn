// ============================================================
// 토지 활용성 점수 엔진 (부동산 전문가·투자자 관점)
// - 목적별 등급이 아니라 "토지 자체의 항목별 접합도"를 0~100으로 산출.
// - 카테고리: physical(물리) / regulation(규제·인허가) / location(입지·주변)
// - location(혐오시설·편의시설)은 아직 데이터가 없어 status:'pending' 로 나오며,
//   값이 채워지면(주변조회 함수 연동) 그래프에 자동 등장한다.
// - 종합 점수는 measured 항목만 가중평균. 도로/접도 가중치를 최상으로 둔다(투자자 관점).
// ============================================================

import { LandInput } from './diagnose';

export type ScoreCategory = 'physical' | 'regulation' | 'location';

export interface ScoreItem {
  key: string;
  label: string;
  category: ScoreCategory;
  /** 0~100. 측정 불가(데이터 없음)면 null. */
  score: number | null;
  /** 종합 가중평균에 쓰는 가중치. 도로/접도가 최상. */
  weight: number;
  /** 'measured' = 점수 산출됨 / 'pending' = 데이터 대기(그래프에서 숨김) */
  status: 'measured' | 'pending';
  /** 한 줄 근거(투자자 관점 코멘트) */
  note: string;
}

export interface LandScoreResult {
  items: ScoreItem[];
  /** measured 항목 가중평균(0~100). measured 없으면 null. */
  overall: number | null;
  categories: Record<ScoreCategory, string>;
}

export const CATEGORY_LABELS: Record<ScoreCategory, string> = {
  physical: '물리적 조건',
  regulation: '규제 · 인허가',
  location: '입지 · 주변환경',
};

export const CATEGORY_ORDER: ScoreCategory[] = ['physical', 'regulation', 'location'];

// ── 개별 산식 ────────────────────────────────────────────────

/** 도로/접도(맹지 여부) — 투자자 관점 최우선. 공부 도로접면 + 인접분석 결합. */
function scoreRoad(input: LandInput): { score: number | null; note: string } {
  const level = input.roadSideLevel;
  const name = (input.roadSideName ?? '').trim();
  const status = input.roadAccess?.status;

  // 공부상 도로접면 등급이 있으면 이를 우선(가장 직접적)
  if (level && level !== 'unknown') {
    if (level === 'blind')
      return { score: 12, note: `공부상 맹지(${name || '도로 미접'}). 건축 허가가 어려워 투자 리스크가 가장 큰 조건입니다.` };
    if (level === 'weak')
      return { score: 45, note: `좁은 도로 접함(${name}). 대형차·소방차 진입/회차가 제한될 수 있어 사용성·환금성이 낮습니다.` };
    if (level === 'normal')
      return { score: 75, note: `도로 접함(${name}). 접도 자체는 확보. 건축법상 도로 폭(4m 등) 충족 여부만 현장 확인.` };
    if (level === 'good')
      return { score: 95, note: `넓은 도로 접함(${name}). 접도 조건 양호 — 건축·환금성 측면에서 유리합니다.` };
  }

  // 공부값이 없으면 인접분석 status로 보정 판정
  if (status === 'direct_road')
    return { score: 72, note: '지적도상 도로 인접 가능성. 현황도로·도로폭·건축법상 도로 인정 여부는 확인 필요.' };
  if (status === 'ditch')
    return { score: 40, note: '구거·하천 인접. 점용·지분 확보 시 진입 가능성 있으나 절차·비용 리스크.' };
  if (status === 'none')
    return { score: 18, note: '지적도상 도로 미접(맹지 가능성). 현황도로·도로지분·통행권 확보 여부가 핵심.' };

  return { score: null, note: '도로접면 정보가 아직 조회되지 않았습니다.' };
}

/** 규제·건축제한 — 가장 강한 규제 기준으로 감점. */
function scoreRegulation(input: LandInput): { score: number | null; note: string } {
  const regs = input.regulations ?? [];
  if (!regs.length) return { score: 100, note: '조회된 개발·건축 제한 규제가 없습니다(자동 조회 기준).' };

  // 심각도: 낮을수록 점수 하락. diagnose 등급 체계와 정합.
  const TIERS: { match: string; score: number; label: string }[] = [
    { match: '개발제한', score: 10, label: '개발제한구역(그린벨트)' },
    { match: '상수원', score: 12, label: '상수원보호구역' },
    { match: '농업진흥', score: 30, label: '농업진흥구역' },
    { match: '보전산지', score: 32, label: '보전산지' },
    { match: '생태', score: 35, label: '생태·경관보전지역' },
    { match: '군사', score: 55, label: '군사시설보호구역' },
    { match: '문화유산', score: 55, label: '문화유산 보호구역' },
    { match: '성장관리', score: 62, label: '성장관리권역' },
    { match: '자연보전권역', score: 62, label: '자연보전권역' },
    { match: '가축사육제한', score: 68, label: '가축사육제한구역' },
  ];

  let worst: { score: number; label: string } | null = null;
  const hits: string[] = [];
  for (const reg of regs) {
    for (const t of TIERS) {
      if (reg.includes(t.match)) {
        hits.push(t.label);
        if (!worst || t.score < worst.score) worst = { score: t.score, label: t.label };
      }
    }
  }
  if (!worst) return { score: 85, note: `규제 신호(${regs.join('·')}) 확인 — 건축 제한 강도는 낮은 편으로 판단됩니다.` };
  return {
    score: worst.score,
    note: `${hits.join('·')} 지정. 가장 강한 규제(${worst.label}) 기준으로 건축·개발 제한 리스크를 반영했습니다.`,
  };
}

/** 경사도 — 토목비·허가 리스크. */
function scoreSlope(input: LandInput): { score: number | null; note: string } {
  const s = input.slopePercent;
  const topo = (input.topographyName ?? '').trim();

  if (s != null) {
    if (s <= 5) return { score: 100, note: `평균 경사 ${s}% — 거의 평지. 토목비 부담이 낮습니다.` };
    if (s <= 10) return { score: 82, note: `평균 경사 ${s}% — 완만. 약간의 정지·배수 비용만 감안.` };
    if (s <= 15) return { score: 62, note: `평균 경사 ${s}% — 성토·기초·배수 비용이 늘 수 있습니다.` };
    if (s <= 25) return { score: 38, note: `평균 경사 ${s}% — 옹벽·평탄화 토목비가 크게 늘 수 있습니다.` };
    return { score: 15, note: `평균 경사 ${s}% — 급경사. 토목비 급증·개발행위허가 제한 우려.` };
  }
  // 사용자 경사 미입력 시 공부상 지형고저로 판정
  if (topo && /급경사/.test(topo)) return { score: 30, note: '공부상 급경사지로 등재 — 토목비·허가 리스크. 현장 경사 확인 필요.' };
  if (topo && /완경사/.test(topo)) return { score: 70, note: '공부상 완경사로 등재 — 약간의 토목비 감안.' };
  if (topo && /평지/.test(topo)) return { score: 92, note: '공부상 평지로 등재 — 토목 부담 낮음(현장 확인 권장).' };
  return { score: null, note: '경사 정보가 입력·조회되지 않았습니다.' };
}

/** 용도지역 활용 폭 — 넓게 쓸 수 있을수록 고점. */
function scoreUseZone(input: LandInput): { score: number | null; note: string } {
  const z = (input.useZoneRaw ?? '').trim();
  if (!z) return { score: null, note: '용도지역이 조회되지 않았습니다.' };

  if (/계획관리/.test(z)) return { score: 90, note: '계획관리지역 — 비도시 중 활용 폭이 가장 넓어 개발 선호도가 높습니다.' };
  if (/(일반주거|준주거|상업|준공업)/.test(z)) return { score: 92, note: `${z} — 건축·수익 활용 폭이 넓은 편입니다.` };
  if (/생산관리/.test(z)) return { score: 58, note: '생산관리지역 — 농업·제한적 개발 위주로 활용 폭이 좁습니다.' };
  if (/보전관리/.test(z)) return { score: 48, note: '보전관리지역 — 보전 성격이 강해 개발 제약이 큽니다.' };
  if (/농림/.test(z)) return { score: 42, note: '농림지역 — 농림업 위주로 일반 개발이 크게 제한됩니다.' };
  if (/자연환경보전/.test(z)) return { score: 22, note: '자연환경보전지역 — 개발이 가장 강하게 제한됩니다.' };
  if (/녹지/.test(z)) return { score: 55, note: `${z} — 개발이 제한적으로 허용됩니다.` };
  return { score: 65, note: `${z} — 일반적 활용 가능(세부 행위제한은 조례 확인).` };
}

/** 지목 — 전용 절차·비용 리스크. */
function scoreJimok(input: LandInput): { score: number | null; note: string } {
  const j = (input.jimok ?? '').trim();
  if (!j) return { score: null, note: '지목이 조회되지 않았습니다.' };
  if (/(대|잡종지)/.test(j)) return { score: 100, note: `지목 "${j}" — 별도 전용 없이 건축 가능성이 높습니다.` };
  if (/(전|답|과수원|목장)/.test(j)) return { score: 55, note: `지목 "${j}"(농지) — 건축 시 농지전용 절차·부담금이 발생합니다.` };
  if (/임/.test(j)) return { score: 40, note: `지목 "${j}"(임야) — 산지전용 허가가 필요하고 거절 리스크가 있습니다.` };
  return { score: 70, note: `지목 "${j}" — 용도 적합성은 개별 확인이 필요합니다.` };
}

/** 면적 효율 — 극단만 감점(약한 신호). */
function scoreArea(input: LandInput): { score: number | null; note: string } {
  const a = input.areaSqm;
  if (a == null) return { score: null, note: '면적이 조회되지 않았습니다.' };
  if (a < 60) return { score: 45, note: `${Math.round(a)}㎡ — 지나치게 좁아 건축·활용에 제약이 있을 수 있습니다.` };
  if (a < 100) return { score: 70, note: `${Math.round(a)}㎡ — 소규모. 용도에 따라 활용이 제한될 수 있습니다.` };
  if (a > 3300) return { score: 82, note: `${Math.round(a)}㎡ — 대규모. 분할·개발행위 규모 기준을 함께 검토하세요.` };
  return { score: 95, note: `${Math.round(a)}㎡ — 일반적 활용에 적정한 규모입니다.` };
}

// ── 조립 ─────────────────────────────────────────────────────

export function scoreLand(input: LandInput): LandScoreResult {
  const road = scoreRoad(input);
  const reg = scoreRegulation(input);
  const slope = scoreSlope(input);
  const zone = scoreUseZone(input);
  const jimok = scoreJimok(input);
  const area = scoreArea(input);

  const items: ScoreItem[] = [
    // 물리적 조건 — 도로/접도 가중치 최상
    { key: 'road',   label: '도로 · 접도(맹지)', category: 'physical',   weight: 3.0, ...wrap(road) },
    { key: 'slope',  label: '경사도',           category: 'physical',   weight: 1.5, ...wrap(slope) },
    { key: 'jimok',  label: '지목',             category: 'physical',   weight: 1.0, ...wrap(jimok) },
    { key: 'area',   label: '면적 · 규모',      category: 'physical',   weight: 0.6, ...wrap(area) },
    // 규제 · 인허가
    { key: 'reg',    label: '건축 · 개발 제한',  category: 'regulation', weight: 2.5, ...wrap(reg) },
    { key: 'zone',   label: '용도지역 활용도',   category: 'regulation', weight: 1.2, ...wrap(zone) },
    // 입지 · 주변환경 — 데이터 연동 전이라 pending(그래프에서 숨김).
    // 주변조회 함수가 값을 채우면 아래 score/status만 바뀌어 자동 등장한다.
    { key: 'hazard', label: '혐오시설 인접',     category: 'location',   weight: 2.0, score: null, status: 'pending', note: '주변 축사·공장·송전탑·폐기물시설 등 인접 분석(추후 데이터 연동).' },
    { key: 'amenity',label: '편의시설 접근성',   category: 'location',   weight: 1.0, score: null, status: 'pending', note: '마트·병원·학교·대중교통 접근성 분석(추후 데이터 연동).' },
  ];

  const measured = items.filter((i) => i.status === 'measured' && i.score != null);
  const overall = measured.length
    ? Math.round(
        measured.reduce((s, i) => s + (i.score as number) * i.weight, 0) /
          measured.reduce((s, i) => s + i.weight, 0),
      )
    : null;

  return { items, overall, categories: CATEGORY_LABELS };
}

function wrap(r: { score: number | null; note: string }): { score: number | null; status: 'measured' | 'pending'; note: string } {
  return { score: r.score, status: r.score == null ? 'pending' : 'measured', note: r.note };
}
