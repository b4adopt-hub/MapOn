// ============================================================
// 토지 활용성 점수 엔진 (부동산 감정평가·투자 실무 기준)
// - 목적별 등급이 아니라 "토지 자체의 항목별 접합도"를 0~100으로 산출.
// - 카테고리: physical(물리) / regulation(규제·인허가) / location(입지·주변)
// - location(혐오시설·편의시설)은 아직 데이터가 없어 status:'pending' 로 나오며,
//   값이 채워지면(주변조회 함수 연동) 그래프에 자동 등장한다.
//
// [종합 점수 산정 방식 — 실무 근거]
//   단순 가중평균은 맹지·개발제한 같은 "치명적 결함(fatal flaw)"을
//   다른 장점(경사·면적 등)으로 희석시켜 실제보다 후한 점수를 낸다.
//   감정평가 실무기준(610-1.7.12)상 맹지는 진입로 개설 가능성이 없으면
//   가치가 낮은 토지로 보고, 실무에서도 급경사·개발제한·맹지는 개발 자체가
//   불가능한 "돈 먹는 토지"로 분류된다(다른 장점과 상쇄되지 않음).
//   → 그래서 (1) measured 가중평균을 낸 뒤, (2) 치명적 결함이 있으면
//      종합점수에 상한(cap)을 씌워 실제 개발 난이도에 맞게 끌어내린다.
//   → 결함이 여러 개면 가장 낮은 상한을 적용하고, 결함마다 추가 감점한다.
//   보수적으로(낮게) 평가하는 것을 원칙으로 한다.
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
  /** 종합 점수(0~100). measured 가중평균에 치명적 결함 상한을 적용. measured 없으면 null. */
  overall: number | null;
  /** 종합 점수에 적용된 치명적 결함 목록(설명용). */
  caps: string[];
  categories: Record<ScoreCategory, string>;
}

export const CATEGORY_LABELS: Record<ScoreCategory, string> = {
  physical: '물리적 조건',
  regulation: '규제 · 인허가',
  location: '입지 · 주변환경',
};

export const CATEGORY_ORDER: ScoreCategory[] = ['physical', 'regulation', 'location'];

// ── 개별 산식 ────────────────────────────────────────────────
// 배점은 "개발·건축·환금 관점에서 얼마나 유리한가"를 보수적으로 반영.

/** 도로/접도(맹지 여부) — 투자자 관점 최우선. 공부 도로접면 + 인접분석 결합. */
function scoreRoad(input: LandInput): { score: number | null; note: string } {
  const level = input.roadSideLevel;
  const name = (input.roadSideName ?? '').trim();
  const status = input.roadAccess?.status;

  // 공부상 도로접면 등급이 있으면 이를 우선(가장 직접적)
  if (level && level !== 'unknown') {
    if (level === 'blind')
      return { score: 8, note: `공부상 맹지(${name || '도로 미접'}). 건축 허가 자체가 막혀 진입로(인접지 매입·사도개설·구거점용)를 먼저 해결해야 하는, 투자에서 가장 치명적인 결함입니다.` };
    if (level === 'weak')
      return { score: 40, note: `좁은 도로 접함(${name}). 건축법상 도로 폭(통상 4m) 미달이면 재건축·증축·대형차 진입이 제한됩니다.` };
    if (level === 'normal')
      return { score: 70, note: `도로 접함(${name}). 접도 자체는 확보. 다만 현황도로가 건축법상 도로로 인정되는지, 폭·지분은 현장 확인 필요.` };
    if (level === 'good')
      return { score: 92, note: `넓은 도로 접함(${name}). 접도 조건 양호 — 건축·환금성에 유리합니다.` };
  }

  // 공부값이 없으면 인접분석 status로 보정 판정
  if (status === 'direct_road')
    return { score: 66, note: '지적도상 도로 인접 가능성. 현황도로·도로폭·건축법상 도로 인정 여부는 아직 미확정이라 보수적으로 봅니다.' };
  if (status === 'ditch')
    return { score: 32, note: '구거·하천 인접. 점용허가·지분 확보 시 진입 가능성은 있으나 절차·비용·거절 리스크가 큽니다.' };
  if (status === 'none')
    return { score: 12, note: '지적도상 도로 미접(맹지 가능성). 현황도로·도로지분·통행권이 확보되지 않으면 건축이 사실상 불가합니다.' };

  return { score: null, note: '도로접면 정보가 아직 조회되지 않았습니다.' };
}

/** 규제·건축제한 — 가장 강한 규제 기준으로 감점(보수적). */
function scoreRegulation(input: LandInput): { score: number | null; note: string } {
  const regs = input.regulations ?? [];
  if (!regs.length) return { score: 90, note: '조회된 개발·건축 제한 규제가 없습니다(자동 조회 기준). 세부 행위제한은 조례로 별도 확인하세요.' };

  // 심각도: 낮을수록 점수 하락. 개발 가능성을 실질적으로 얼마나 막는지 기준.
  const TIERS: { match: string; score: number; label: string }[] = [
    { match: '개발제한', score: 5, label: '개발제한구역(그린벨트)' },
    { match: '상수원', score: 8, label: '상수원보호구역' },
    { match: '농업진흥', score: 20, label: '농업진흥구역' },
    { match: '보전산지', score: 22, label: '보전산지' },
    { match: '생태', score: 25, label: '생태·경관보전지역' },
    { match: '자연환경보전', score: 20, label: '자연환경보전지역' },
    { match: '문화유산', score: 40, label: '문화유산 보호구역' },
    { match: '군사', score: 45, label: '군사시설보호구역' },
    { match: '자연보전권역', score: 52, label: '자연보전권역' },
    { match: '성장관리', score: 58, label: '성장관리권역' },
    { match: '가축사육제한', score: 60, label: '가축사육제한구역' },
    { match: '영농여건불리', score: 72, label: '영농여건불리농지' },
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
  // 규제가 여러 개 겹치면 중첩 규제로 추가 감점(최대 -10)
  if (worst) {
    const extra = Math.min(10, Math.max(0, hits.length - 1) * 5);
    const score = Math.max(5, worst.score - extra);
    return {
      score,
      note: `${[...new Set(hits)].join('·')} 지정. 가장 강한 규제(${worst.label}) 기준${extra ? ` + 중첩 규제 감점` : ''}으로 건축·개발 제한 리스크를 반영했습니다.`,
    };
  }
  return { score: 78, note: `규제 신호(${regs.join('·')}) 확인 — 건축 제한 강도는 낮은 편으로 보이나 조례로 확인 필요.` };
}

/** 경사도 — 토목비·개발행위허가 리스크. 조례 상한(대개 15~25도)을 감안해 보수적으로. */
function scoreSlope(input: LandInput): { score: number | null; note: string } {
  const s = input.slopePercent;
  const topo = (input.topographyName ?? '').trim();

  if (s != null) {
    if (s <= 5) return { score: 95, note: `평균 경사 ${s}% — 거의 평지. 토목비 부담이 낮습니다.` };
    if (s <= 10) return { score: 78, note: `평균 경사 ${s}% — 완만. 정지·배수 비용을 약간 감안.` };
    if (s <= 15) return { score: 55, note: `평균 경사 ${s}% — 성토·기초·배수 비용이 늘고, 지자체 조례 경사도 기준(대개 15~25도)에 가까워질 수 있습니다.` };
    if (s <= 25) return { score: 30, note: `평균 경사 ${s}% — 옹벽·평탄화 토목비가 크게 늘고, 개발행위·산지전용 허가 경사도 기준에 걸릴 수 있습니다.` };
    return { score: 10, note: `평균 경사 ${s}% — 급경사. 개발행위·산지전용 허가(대개 25도/조례로 더 강화) 자체가 어려울 수 있습니다.` };
  }
  // 사용자 경사 미입력 시 공부상 지형고저로 판정(보수적)
  if (topo && /급경사/.test(topo)) return { score: 25, note: '공부상 급경사지로 등재 — 토목비·허가 리스크. 현장 경사 확인 필수.' };
  if (topo && /완경사/.test(topo)) return { score: 62, note: '공부상 완경사로 등재 — 성토·배수 비용을 감안하세요(현장 경사 확인 권장).' };
  if (topo && /평지/.test(topo)) return { score: 88, note: '공부상 평지로 등재 — 토목 부담 낮음(현장 확인 권장).' };
  return { score: null, note: '경사 정보가 입력·조회되지 않았습니다.' };
}

/** 용도지역 활용 폭 — 넓게 쓸 수 있을수록 고점(보수적). */
function scoreUseZone(input: LandInput): { score: number | null; note: string } {
  const z = (input.useZoneRaw ?? '').trim();
  if (!z) return { score: null, note: '용도지역이 조회되지 않았습니다.' };

  if (/(일반주거|준주거|상업|준공업)/.test(z)) return { score: 88, note: `${z} — 건축·수익 활용 폭이 넓은 편입니다.` };
  if (/계획관리/.test(z)) return { score: 80, note: '계획관리지역 — 비도시 중 활용 폭이 가장 넓어 개발 선호도가 높지만, 건폐율 40%·4층 이하 등 도시지역보다는 제약이 있습니다.' };
  if (/생산관리/.test(z)) return { score: 48, note: '생산관리지역 — 농업·제한적 개발 위주로 활용 폭이 좁습니다.' };
  if (/녹지/.test(z)) return { score: 45, note: `${z} — 개발이 제한적으로만 허용됩니다.` };
  if (/보전관리/.test(z)) return { score: 38, note: '보전관리지역 — 보전 성격이 강해 개발 제약이 큽니다.' };
  if (/농림/.test(z)) return { score: 32, note: '농림지역 — 농림업 위주로 일반 개발이 크게 제한됩니다.' };
  if (/자연환경보전/.test(z)) return { score: 18, note: '자연환경보전지역 — 개발이 가장 강하게 제한됩니다.' };
  return { score: 55, note: `${z} — 활용 폭은 개별 확인이 필요합니다(세부 행위제한은 조례 확인).` };
}

/** 지목 — 전용 절차·비용 리스크(보수적). */
function scoreJimok(input: LandInput): { score: number | null; note: string } {
  const j = (input.jimok ?? '').trim();
  if (!j) return { score: null, note: '지목이 조회되지 않았습니다.' };
  if (/잡종지/.test(j)) return { score: 95, note: `지목 "${j}" — 별도 전용 없이 활용 가능성이 높습니다.` };
  if (/대/.test(j)) return { score: 92, note: `지목 "${j}" — 건축을 위한 지목은 확보(현황·건축 이력 확인).` };
  if (/(전|답|과수원|목장)/.test(j)) return { score: 48, note: `지목 "${j}"(농지) — 건축하려면 농지전용 허가 + 농지보전부담금(공시지가 20~30%, ㎡당 최대 5만원)이 발생하고, 농취증도 필요합니다.` };
  if (/임/.test(j)) return { score: 35, note: `지목 "${j}"(임야) — 산지전용 허가가 필요하고 경사도·임목축적 기준에 걸려 거절될 리스크가 있습니다.` };
  return { score: 60, note: `지목 "${j}" — 용도 적합성은 개별 확인이 필요합니다.` };
}

/** 토지 형상 — 부정형은 건축 배치·활용 효율이 떨어져 감점(약한 신호). */
function scoreShape(input: LandInput): { score: number | null; note: string } {
  const shape = (input.topographyShape ?? '').trim();
  if (!shape) return { score: null, note: '토지형상이 조회되지 않았습니다.' };
  if (/(정방형|가로장방|세로장방|사다리)/.test(shape)) return { score: 88, note: `형상 "${shape}" — 건축·배치 효율이 무난합니다.` };
  if (/자루/.test(shape)) return { score: 40, note: `형상 "${shape}" — 진입부가 좁은 자루형. 건축 배치·차량 진입에 제약이 있습니다.` };
  if (/부정형/.test(shape)) return { score: 55, note: `형상 "${shape}" — 반듯하지 않아 유효 건축면적·배치 효율이 떨어질 수 있습니다.` };
  return { score: 70, note: `형상 "${shape}" — 활용 효율은 현장 확인이 필요합니다.` };
}

/** 면적 효율 — 극단만 감점(약한 신호). */
function scoreArea(input: LandInput): { score: number | null; note: string } {
  const a = input.areaSqm;
  if (a == null) return { score: null, note: '면적이 조회되지 않았습니다.' };
  if (a < 60) return { score: 40, note: `${Math.round(a)}㎡ — 지나치게 좁아 건축·활용에 제약이 있을 수 있습니다.` };
  if (a < 100) return { score: 65, note: `${Math.round(a)}㎡ — 소규모. 용도에 따라 활용이 제한될 수 있습니다.` };
  if (a > 3300) return { score: 78, note: `${Math.round(a)}㎡ — 대규모. 분할·개발행위 규모 기준·매각 난이도를 함께 검토하세요.` };
  return { score: 90, note: `${Math.round(a)}㎡ — 일반적 활용에 적정한 규모입니다.` };
}

// ── 치명적 결함 상한(cap) ────────────────────────────────────
// 개발·건축을 실질적으로 막는 결함은 다른 장점으로 희석되면 안 되므로,
// 가중평균 결과에 "이 이상은 줄 수 없다"는 상한을 씌운다.

interface Cap { cap: number; label: string }

function fatalCaps(input: LandInput, scores: {
  reg: number | null; slope: number | null; zone: number | null;
}): Cap[] {
  const caps: Cap[] = [];

  // 1) 맹지/도로 미접 — 건축 자체가 막힘. 가장 강한 상한.
  const level = input.roadSideLevel;
  const roadStatus = input.roadAccess?.status;
  if (level === 'blind' || roadStatus === 'none') {
    caps.push({ cap: 35, label: '맹지(도로 미접) — 진입로 미확보 시 건축 불가' });
  } else if (roadStatus === 'ditch' && (level == null || level === 'unknown')) {
    caps.push({ cap: 50, label: '도로 미접(구거 인접) — 점용·지분 확보 전엔 진입 불확실' });
  }

  // 2) 개발을 강하게 막는 규제 — 규제 점수가 매우 낮으면 상한.
  if (scores.reg != null) {
    if (scores.reg <= 15) caps.push({ cap: 30, label: '개발제한급 규제 — 사실상 개발 불가' });
    else if (scores.reg <= 30) caps.push({ cap: 55, label: '강한 규제 — 개발 범위가 크게 제한됨' });
  }

  // 3) 급경사 — 개발행위·산지전용 허가 자체가 어려움.
  if (scores.slope != null && scores.slope <= 15) {
    caps.push({ cap: 55, label: '급경사 — 개발행위허가 경사도 기준·토목비 리스크' });
  }

  // 4) 개발이 크게 제한되는 용도지역(농림·자연환경보전 등)
  if (scores.zone != null && scores.zone <= 35) {
    caps.push({ cap: 55, label: '개발 제한 용도지역 — 일반 건축이 크게 제한됨' });
  }

  return caps;
}

// ── 조립 ─────────────────────────────────────────────────────

export function scoreLand(input: LandInput): LandScoreResult {
  const road = scoreRoad(input);
  const reg = scoreRegulation(input);
  const slope = scoreSlope(input);
  const zone = scoreUseZone(input);
  const jimok = scoreJimok(input);
  const shape = scoreShape(input);
  const area = scoreArea(input);

  const items: ScoreItem[] = [
    // 물리적 조건 — 도로/접도 가중치 최상
    { key: 'road',   label: '도로 · 접도(맹지)', category: 'physical',   weight: 3.5, ...wrap(road) },
    { key: 'slope',  label: '경사도',           category: 'physical',   weight: 1.5, ...wrap(slope) },
    { key: 'jimok',  label: '지목',             category: 'physical',   weight: 1.2, ...wrap(jimok) },
    { key: 'shape',  label: '토지 형상',        category: 'physical',   weight: 0.8, ...wrap(shape) },
    { key: 'area',   label: '면적 · 규모',      category: 'physical',   weight: 0.6, ...wrap(area) },
    // 규제 · 인허가
    { key: 'reg',    label: '건축 · 개발 제한',  category: 'regulation', weight: 2.8, ...wrap(reg) },
    { key: 'zone',   label: '용도지역 활용도',   category: 'regulation', weight: 1.2, ...wrap(zone) },
    // 입지 · 주변환경 — 데이터 연동 전이라 pending(그래프에서 숨김).
    { key: 'hazard', label: '혐오시설 인접',     category: 'location',   weight: 2.0, score: null, status: 'pending', note: '주변 축사·공장·송전탑·폐기물시설 등 인접 분석(추후 데이터 연동).' },
    { key: 'amenity',label: '편의시설 접근성',   category: 'location',   weight: 1.0, score: null, status: 'pending', note: '마트·병원·학교·대중교통 접근성 분석(추후 데이터 연동).' },
  ];

  const measured = items.filter((i) => i.status === 'measured' && i.score != null);

  // 1) measured 가중평균
  const weighted = measured.length
    ? measured.reduce((s, i) => s + (i.score as number) * i.weight, 0) /
      measured.reduce((s, i) => s + i.weight, 0)
    : null;

  // 2) 치명적 결함 상한 적용(가장 낮은 상한으로 끌어내림) + 결함 개수만큼 추가 감점
  const caps = fatalCaps(input, { reg: reg.score, slope: slope.score, zone: zone.score });

  let overall: number | null = weighted == null ? null : Math.round(weighted);
  if (overall != null && caps.length) {
    const lowestCap = Math.min(...caps.map((c) => c.cap));
    // 결함이 2개 이상이면 상한에서 개당 -5 추가(중첩 결함 페널티, 최소 8점 보장)
    const extraPenalty = Math.max(0, caps.length - 1) * 5;
    overall = Math.max(8, Math.min(overall, lowestCap - extraPenalty));
  }

  return { items, overall, caps: caps.map((c) => c.label), categories: CATEGORY_LABELS };
}

function wrap(r: { score: number | null; note: string }): { score: number | null; status: 'measured' | 'pending'; note: string } {
  return { score: r.score, status: r.score == null ? 'pending' : 'measured', note: r.note };
}
