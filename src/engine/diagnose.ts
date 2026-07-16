/**
 * MAP On 진단 엔진 (룰 매트릭스)
 *
 * 입력: 토지 데이터(용도지역·지목·면적·경사·규제 신호) + 목적
 * 출력: 가능성 등급, 위험 항목, 추천 시설물, 예비 견적 범위, 면책·전문가 트리거
 *
 * 외부 의존 없음(순수 함수). 공공 API 키 없이 단위 테스트 가능.
 * 데이터가 채워지기 전이라도 부분 입력으로 동작하며, 누락분은
 * "확인 필요" 신호로 처리한다.
 *
 * 접도(맹지) 항목은 land-lookup이 인접 필지 지목을 분석해 전달하는
 * roadAccess 결과 + 토지특성정보(도로접면 공부값)를 함께 반영한다.
 */

import { matchZone, ZoneInfo } from './zones';
import {
  Purpose,
  Grade,
  PURPOSE_LABELS,
  GRADE_LABELS,
  BASE_MATRIX,
  worseGrade,
} from './purposes';

/** 토지 입력 — 공공 API(브이월드/토지이음)에서 채워지는 필드 */
export interface LandInput {
  pnu?: string;
  address?: string;
  /** 용도지역 원문(토지이음/브이월드 표기) */
  useZoneRaw?: string | null;
  /** 지목 (전/답/임야/대/잡종지 등) */
  jimok?: string | null;
  /** 면적(㎡) */
  areaSqm?: number | null;
  /** 평균 경사도(%) — DEM 기반. 없으면 undefined */
  slopePercent?: number | null;
  /** 규제 신호 — 토지이음 규제 문자열 배열(예: 농업진흥구역, 보전산지, 개발제한구역 등) */
  regulations?: string[] | null;
  /** 인접 도로(맹지) 확인 결과 — land-lookup이 제공 */
  roadAccess?: {
    status: 'direct_road' | 'ditch' | 'none' | 'unknown';
    adjacentJimoks: string[];
    message: string;
  } | null;
  /** 토지특성정보(공부값) — land-characteristics가 제공. 도로접면 등급 */
  roadSideName?: string | null;          // 도로접면 명칭(예: 광대한면/중로한면/세로(가)/맹지)
  roadSideLevel?: 'good' | 'normal' | 'weak' | 'blind' | 'unknown' | null;
  /** 지형고저(공부값) — 평지/완경사/급경사 등 */
  topographyName?: string | null;
  /** 토지형상(공부값) — 정방형/장방형/부정형/자루형 등 */
  topographyShape?: string | null;
  /** 주변 혐오·기피시설 목록 — nearby-hazards EF가 반경 조회로 제공 */
  nearbyHazards?: NearbyHazard[] | null;
}

/** 주변 혐오·기피시설 1건 */
export interface NearbyHazard {
  /** 시설 분류 키(landScore HAZARD_TIERS와 매칭) */
  type: string;
  /** 시설 분류 표시명(예: 화장장, 축사, 공동묘지) */
  typeLabel: string;
  /** 개별 시설명(있으면) */
  name?: string | null;
  /** 필지 중심으로부터 직선거리(m) */
  distanceM: number;
}

/** 위험 항목 1건 */
export interface RiskItem {
  /** 항목 키 */
  key: string;
  /** 사용자 표시 라벨 */
  label: string;
  /** 심각도: info(참고) / caution(주의) / warning(경고) */
  level: 'info' | 'caution' | 'warning';
  /** 설명 (사전검토 어조, 단정 금지) */
  note: string;
}

/** 진단 결과 */
export interface DiagnosisResult {
  purpose: Purpose;
  purposeLabel: string;
  grade: Grade;
  gradeLabel: string;
  /** 등급의 쉬운 한 줄 설명 */
  gradeDescription: string;
  zone: ZoneInfo | null;
  /** 용도지역 매칭 실패 여부 */
  zoneUnknown: boolean;
  riskItems: RiskItem[];
  recommendations: string[];
  /** 예비 견적 범위(원). 견적 대상 목적이 아니면 null */
  estCostMin: number | null;
  estCostMax: number | null;
  /** 측량 연계 트리거 — 경계 인접 시공 목적일 때 true */
  surveyTrigger: boolean;
  /** 전문가(행정사/인허가) 확인 권고 트리거 */
  expertTrigger: boolean;
  /** 면책 문구 — 항상 표기 */
  disclaimer: string;
}

const DISCLAIMER =
  '본 결과는 공공데이터 기반 사전검토이며 법적 확정 판정이 아닙니다. ' +
  '건폐율·용적률·행위제한의 구체 기준과 인허가 가부는 해당 지자체 조례 및 ' +
  '현장 확인에 따라 달라질 수 있습니다.';

/** 등급별 쉬운 한 줄 설명 (일반인 눈높이) */
const GRADE_DESC: Record<Grade, string> = {
  high: '큰 걸림돌 없이 가능성이 높아 보입니다. 다만 세부 조건은 확인이 필요합니다.',
  conditional: '몇 가지 조건만 맞추면 가능해 보입니다. 아래 검토 항목을 확인하세요.',
  expert: '가능할 수도 있지만 따져볼 게 있습니다. 군청·시청이나 토지 전문가에게 확인하는 게 안전합니다.',
  risky: '제약이 많아 쉽지 않아 보입니다. 추진 전에 반드시 전문가·지자체 확인이 필요합니다.',
  unlikely: '현재 조건으로는 어려워 보입니다. 매입 전 가능 여부를 꼭 확인하세요.',
};

/** 경계 인접 시공이 수반되는 목적(측량 연계 트리거 대상) */
const SURVEY_PURPOSES: Purpose[] = ['fence', 'house', 'warehouse', 'parking'];

/** 견적 대상 목적별 단위 견적 계수 (1차 훅용 거친 기본값)
 *  실제 단가는 업체 데이터 축적 후 정밀화. 여기서는 면적 비례 개략 범위만.
 *  단위: 원 (min/max 계수는 ㎡당 또는 식). 데이터 부재 시 넓은 범위 제시.
 */
interface CostModel {
  /** 고정 기반비(원) */
  baseMin: number;
  baseMax: number;
  /** 면적(㎡) 비례 단가(원/㎡). 면적 모르면 0 처리 */
  perSqmMin: number;
  perSqmMax: number;
}

const COST_MODELS: Partial<Record<Purpose, CostModel>> = {
  fence: { baseMin: 500_000, baseMax: 1_000_000, perSqmMin: 0, perSqmMax: 0 }, // 길이 미입력 단계: 기반비만
  farmhut: { baseMin: 8_000_000, baseMax: 25_000_000, perSqmMin: 0, perSqmMax: 0 },
  landscape: { baseMin: 1_000_000, baseMax: 3_000_000, perSqmMin: 30_000, perSqmMax: 120_000 },
  parking: { baseMin: 2_000_000, baseMax: 5_000_000, perSqmMin: 40_000, perSqmMax: 100_000 },
  warehouse: { baseMin: 10_000_000, baseMax: 40_000_000, perSqmMin: 150_000, perSqmMax: 500_000 },
};

/** 지목 기반 위험 신호 */
function jimokRisks(input: LandInput, purpose: Purpose): { risks: RiskItem[]; gradeAdj: Grade | null } {
  const risks: RiskItem[] = [];
  const j = (input.jimok ?? '').trim();
  let gradeAdj: Grade | null = null;

  if (!j) {
    risks.push({
      key: 'jimok_unknown',
      label: '지목 확인 필요',
      level: 'caution',
      note: '이 땅의 지목(논·밭·대지 등 땅의 종류)이 확인되지 않았습니다. 정부 사이트나 토지대장에서 확인할 수 있습니다.',
    });
    return { risks, gradeAdj };
  }

  // 임야: 산지전용 가능성 — 전문가 확인
  if (j.includes('임') ) {
    risks.push({
      key: 'forest_conversion',
      label: '산지전용 검토 필요',
      level: 'warning',
      note: '이 땅은 "임야"(산)로 돼 있어, 집이나 건물을 지으려면 산을 개발용으로 바꾸는 "산지전용허가"가 필요합니다. 보호 대상 산이면 허가가 거절될 수 있어, 매입 전에 가능 여부를 꼭 확인하세요.',
    });
    gradeAdj = worseGrade('expert', gradeAdj ?? 'expert');
  }
  // 전·답: 농지전용 가능성
  if (j === '전' || j === '답' || j.includes('전') || j.includes('답')) {
    risks.push({
      key: 'farm_conversion',
      label: '농지전용 검토 필요',
      level: 'warning',
      note: '이 땅은 "전(밭)·답(논)" 같은 농지라, 집이나 건물을 지으려면 농지를 다른 용도로 바꾸는 "농지전용허가"가 필요합니다. 농사 보호구역(농업진흥구역)이면 더 어렵습니다. 매입 전 가능 여부를 확인하세요.',
    });
    if (purpose !== 'farmhut') {
      // 농막은 농지 위 설치가 오히려 정합적이므로 하향 폭을 줄임
      gradeAdj = worseGrade('expert', gradeAdj ?? 'expert');
    }
  }
  // 잡종지·대: 상대적으로 개발 친화
  return { risks, gradeAdj };
}

/** 경사 기반 위험 신호 (사용자 입력 경사% + 토지특성 지형고저 공부값) */
function slopeRisks(input: LandInput): RiskItem[] {
  const risks: RiskItem[] = [];
  const s = input.slopePercent;
  if (s != null && s >= 25) {
    risks.push({
      key: 'slope_high',
      label: '급경사 주의',
      level: 'warning',
      note: `땅 기울기가 약 ${s}%로 꽤 가파릅니다. 평평하게 만드는 흙 작업·옹벽·물 빠짐 공사가 추가로 들어 비용이 크게 늘 수 있고, 너무 가파르면 건축 허가가 안 날 수도 있습니다.`,
    });
  } else if (s != null && s >= 15) {
    risks.push({
      key: 'slope_mid',
      label: '경사 검토',
      level: 'caution',
      note: `땅 기울기가 약 ${s}% 정도입니다. 약간 경사가 있어 기초·물 빠짐 공사 비용이 조금 더 들 수 있으니 예산에 감안하세요.`,
    });
  }

  // 토지특성 지형고저(공부값) — 사용자가 경사를 입력하지 않았어도 공부상 경사 신호를 잡는다.
  const t = (input.topographyName ?? '').trim();
  if (t && /급경사/.test(t)) {
    risks.push({
      key: 'topo_steep',
      label: '공부상 급경사지',
      level: 'warning',
      note: '공적 장부(토지특성)에 이 땅이 "급경사"로 등재돼 있습니다. 평탄화·옹벽·배수에 토목비가 크게 들 수 있고, 경사가 심하면 개발행위허가가 제한될 수 있습니다. 현장 경사와 토목 견적을 반드시 확인하세요.',
    });
  } else if (t && /완경사/.test(t)) {
    risks.push({
      key: 'topo_mild',
      label: '공부상 완경사',
      level: 'caution',
      note: '공적 장부상 "완경사"로 등재된 땅입니다. 약간의 성토·기초·배수 비용을 예산에 감안하세요.',
    });
  }
  return risks;
}

/** 도로접면(토지특성 공부값) 기반 맹지·접도 판정 — land-lookup 인접분석보다 직접적 */
function roadSideRisks(input: LandInput, purpose: Purpose): { risks: RiskItem[]; gradeAdj: Grade | null } {
  const risks: RiskItem[] = [];
  let gradeAdj: Grade | null = null;
  const level = input.roadSideLevel;
  const name = (input.roadSideName ?? '').trim();
  if (!level || level === 'unknown' || !name) return { risks, gradeAdj };

  // 건축류 목적 — 접도가 사용성/허가에 직결되는 용도
  const BUILD: Purpose[] = ['house', 'warehouse', 'cafe', 'petfacility', 'camping', 'farmhut', 'parking'];
  const isBuild = BUILD.includes(purpose);

  if (level === 'blind') {
    risks.push({
      key: 'roadside_blind',
      label: '공부상 맹지 — 도로 미접',
      level: 'warning',
      note: `공적 장부(토지특성)상 도로접면이 "${name}"으로, 도로에 접하지 않은 맹지로 등재돼 있습니다. 맹지는 건축 허가가 나지 않는 경우가 많습니다. 다만 지적도에 없는 현황도로·도로지분·통행권으로 진입이 가능한 사례도 있으니, 진입로 확보 방법을 매입 전 반드시 확인하세요.`,
    });
    if (isBuild) gradeAdj = 'risky';
  } else if (level === 'weak') {
    risks.push({
      key: 'roadside_weak',
      label: '좁은 도로 접함 — 대형차 주의',
      level: 'caution',
      note: `공부상 도로접면이 "${name}"으로, 자동차 통행이 어려운 좁은 도로에 접해 있습니다. 일반 승용차는 가능해도 대형차·소방차 진입이나 회차가 어려울 수 있습니다. 창고·공장·다중이용 용도면 도로 폭과 진입을 현장에서 꼭 확인하세요.`,
    });
  } else if (level === 'normal') {
    risks.push({
      key: 'roadside_normal',
      label: '도로 접함 (공부 확인)',
      level: 'info',
      note: `공부상 도로접면이 "${name}"으로, 도로에 접한 것으로 등재돼 있습니다. 다만 공부상 접면과 실제 건축법상 도로(폭 4m 등) 인정 여부는 다를 수 있으니 도로 폭·현황을 확인하세요.`,
    });
  } else if (level === 'good') {
    risks.push({
      key: 'roadside_good',
      label: '도로 접함 양호 (공부 확인)',
      level: 'info',
      note: `공부상 도로접면이 "${name}"으로, 비교적 넓은 도로에 접한 것으로 등재돼 있습니다. 접도 측면은 양호한 편입니다(실제 도로 폭·현황은 별도 확인 권장).`,
    });
  }
  return { risks, gradeAdj };
}

/** 규제 신호 → 위험 항목 + 등급 하향 */
function regulationRisks(input: LandInput, purpose: Purpose): { risks: RiskItem[]; gradeAdj: Grade | null } {
  const risks: RiskItem[] = [];
  let gradeAdj: Grade | null = null;
  const regs = input.regulations ?? [];

  // 자연보전권역에서 특히 강하게 제한되는 대규모 개발성 목적
  const HEAVY_DEV: Purpose[] = ['warehouse', 'petfacility', 'camping', 'cafe'];

  const HARD = [
    { match: '개발제한', label: '개발제한구역', grade: 'unlikely' as Grade,
      plain: '이른바 "그린벨트"입니다. 도시가 무분별하게 넓어지는 걸 막으려고 묶어둔 땅이라, 원칙적으로 새 건물을 짓기 매우 어렵습니다. 기존 건물 수선 정도만 가능한 경우가 많습니다.' },
    { match: '농업진흥', label: '농업진흥구역', grade: 'risky' as Grade,
      plain: '농사를 보호하려고 지정한 땅(옛 절대농지)입니다. 농사·농업시설 외의 건축은 원칙적으로 막혀 있어, 집이나 상가를 짓기는 매우 까다롭습니다.' },
    { match: '보전산지', label: '보전산지', grade: 'risky' as Grade,
      plain: '함부로 개발하지 못하도록 보호하는 산입니다. 건물을 지으려면 "산지전용허가"라는 까다로운 절차가 필요하고, 거절되는 경우도 많습니다.' },
    { match: '상수원', label: '상수원보호구역', grade: 'unlikely' as Grade,
      plain: '식수원(상수원)을 깨끗하게 지키려는 구역입니다. 오염을 막기 위해 건축·영업이 강하게 제한돼, 집이나 시설을 새로 짓기 매우 어렵습니다.' },
    { match: '군사', label: '군사시설보호구역', grade: 'expert' as Grade,
      plain: '군부대 인근이라 건축 시 군(軍)의 동의가 필요한 땅입니다. 높이·용도에 제한이 붙을 수 있어, 가능 여부를 미리 확인해야 합니다.' },
    { match: '문화유산', label: '문화유산 보호구역', grade: 'expert' as Grade,
      plain: '문화재 주변이라 경관·보존을 위해 건축이 제한될 수 있는 땅입니다. 공사 전 별도 심의가 필요할 수 있습니다.' },
    { match: '생태', label: '생태·경관보전지역', grade: 'risky' as Grade,
      plain: '자연환경이나 경관을 보호하려는 구역입니다. 개발 행위가 강하게 제한돼, 건축이 어렵거나 까다로운 심사를 거쳐야 합니다.' },
    { match: '자연보전권역', label: '자연보전권역', grade: 'expert' as Grade,
      plain: '수도권의 자연·수질을 보호하려고 묶은 넓은 권역입니다. 작은 집 한 채는 가능한 경우가 많지만, 큰 건물·공장·여러 채 개발은 강하게 제한됩니다. 규모가 클수록 어려워진다고 보면 됩니다.' },
    { match: '성장관리권역', label: '성장관리권역', grade: 'expert' as Grade,
      plain: '수도권 개발을 계획적으로 관리하는 권역입니다. 일정 규모 이상 개발에 제한이 있어, 짓고자 하는 규모에 따라 확인이 필요합니다.' },
    { match: '가축사육제한', label: '가축사육제한구역', grade: 'expert' as Grade,
      plain: '냄새·오염 문제로 가축(개·소·돼지 등) 사육을 제한하는 구역입니다. 동물을 많이 키우는 시설(축사·반려동물 시설 등)은 막히거나 까다로울 수 있습니다. 집을 짓는 것 자체는 보통 영향이 없습니다.' },
  ];

  for (const reg of regs) {
    for (const h of HARD) {
      if (reg.includes(h.match)) {
        risks.push({
          key: `reg_${h.match}`,
          label: `${h.label}`,
          level: 'warning',
          note: `${h.plain} 정확한 가능 여부는 군청·시청 담당 부서나 토지 전문가(행정사 등)에게 확인하시는 게 안전합니다.`,
        });
        gradeAdj = gradeAdj ? worseGrade(gradeAdj, h.grade) : h.grade;
      }
    }
  }

  // 자연보전권역 × 대규모 개발성 목적: 권역 특성상 추가 제한이 크다.
  const inNaturalPreserve = regs.some((r) => r.includes('자연보전권역'));
  if (inNaturalPreserve && HEAVY_DEV.includes(purpose)) {
    risks.push({
      key: 'natpreserve_heavy',
      label: '규모가 큰 시설은 특히 주의',
      level: 'warning',
      note: '이 땅은 자연보전권역이라, 창고·카페·반려동물 시설·캠핑장처럼 규모가 커지는 용도는 면적·업종 기준에 걸릴 수 있습니다. 작게 시작하는 건 가능해도 크게 짓는 건 제한될 수 있으니, 계획한 규모가 가능한지 지자체에 먼저 문의하세요.',
    });
    gradeAdj = gradeAdj ? worseGrade(gradeAdj, 'risky') : 'risky';
  }

  return { risks, gradeAdj };
}

/** 예비 견적 범위 산출 */
function estimateCost(purpose: Purpose, areaSqm?: number | null): { min: number | null; max: number | null } {
  const model = COST_MODELS[purpose];
  if (!model) return { min: null, max: null };
  const a = areaSqm && areaSqm > 0 ? areaSqm : 0;
  return {
    min: model.baseMin + model.perSqmMin * a,
    max: model.baseMax + model.perSqmMax * a,
  };
}

/** 추천 시설물 (목적·지목 기반 간단 룰) */
function buildRecommendations(purpose: Purpose, input: LandInput): string[] {
  const recs: string[] = [];
  switch (purpose) {
    case 'house':
      recs.push('전원주택', '데크', '진입로', '울타리', '조경 마당');
      break;
    case 'farmhut':
      recs.push('농막', '컨테이너', '소형 창고', '데크');
      break;
    case 'warehouse':
      recs.push('소형 창고', '컨테이너', '기초공사', '진입로');
      break;
    case 'fence':
      recs.push('펜스', '게이트', '경계 정리');
      break;
    case 'landscape':
      recs.push('조경 마당', '데크', '배수로');
      break;
    case 'parking':
      recs.push('주차장', '진입로', '배수로');
      break;
    default:
      recs.push(PURPOSE_LABELS[purpose]);
  }
  if ((input.slopePercent ?? 0) >= 15) recs.push('성토·기초공사', '배수공사');
  if (/급경사/.test(input.topographyName ?? '')) recs.push('옹벽·평탄화', '배수공사');
  return recs;
}

/**
 * 메인 진단 함수
 */
export function diagnose(input: LandInput, purpose: Purpose): DiagnosisResult {
  const zone = matchZone(input.useZoneRaw);
  const zoneUnknown = zone == null;

  // 1) 출발 등급 — 용도지역 대분류 × 목적
  let grade: Grade = zone
    ? BASE_MATRIX[purpose][zone.category]
    : 'expert'; // 용도지역 미확인 시 보수적으로 전문가 확인

  // 1-1) 세분 보정: 계획관리지역은 비도시 중 가장 개발 친화적이므로
  //      관리 대분류 일괄 등급보다 한 단계 완화(전원주택·근생 등에서 유효).
  if (zone?.code === 'mng_plan' && BASE_MATRIX[purpose].management === 'expert') {
    grade = 'conditional';
  }

  // 1-2) 녹지지역 세분 보정: 도시지역이지만 건폐율 20%로 개발이 제한적이다.
  //      주거·상업 기준의 urban 등급은 녹지에 과대평가이므로 보수적으로 조정한다.
  //      보전녹지 > 생산녹지 > 자연녹지 순으로 제한이 강하다.
  const GREEN_CODES = ['green_conserv', 'green_prod', 'green_nat'];
  if (zone && GREEN_CODES.includes(zone.code)) {
    // 개발 강도가 큰 목적은 녹지에서 한 단계 보수적으로
    const HEAVY: Purpose[] = ['house', 'cafe', 'warehouse', 'petfacility', 'camping'];
    if (HEAVY.includes(purpose)) {
      const step: Record<string, Grade> = {
        green_nat: 'expert',     // 자연녹지: 개발행위허가로 가능 여지 있으나 전문가 확인
        green_prod: 'risky',     // 생산녹지: 농업 보호 성격, 제한 강함
        green_conserv: 'risky',  // 보전녹지: 가장 제한적
      };
      grade = worseGrade(grade, step[zone.code] ?? 'expert');
    }
  }

  const riskItems: RiskItem[] = [];

  if (zoneUnknown) {
    riskItems.push({
      key: 'zone_unknown',
      label: '용도지역 확인 필요',
      level: 'caution',
      note: '이 땅의 용도지역(무엇을 지을 수 있는지 정하는 구역)이 자동으로 확인되지 않았습니다. 정부 사이트 "토지이음"(eum.go.kr)에서 주소를 넣어 토지이용계획을 직접 확인해 보세요.',
    });
  }

  // 2) 지목 신호
  const j = jimokRisks(input, purpose);
  riskItems.push(...j.risks);
  if (j.gradeAdj) grade = worseGrade(grade, j.gradeAdj);

  // 3) 경사 신호 (사용자 입력 + 토지특성 지형 공부값)
  riskItems.push(...slopeRisks(input));

  // 4) 규제 신호 (가장 강한 하향 요인)
  const r = regulationRisks(input, purpose);
  riskItems.push(...r.risks);
  if (r.gradeAdj) grade = worseGrade(grade, r.gradeAdj);

  // 5) 접도(맹지) — 토지특성 도로접면(공부값) 우선, 없으면 land-lookup 인접분석
  const rs = roadSideRisks(input, purpose);
  if (rs.risks.length > 0) {
    // 공부상 도로접면 데이터가 있으면 이를 우선 사용
    riskItems.push(...rs.risks);
    if (rs.gradeAdj) grade = worseGrade(grade, rs.gradeAdj);
  } else {
    // 도로접면 공부값이 없을 때만 인접 지목 기반 추정으로 폴백
    const ra = input.roadAccess;
    if (ra && ra.status !== 'unknown') {
      const level: RiskItem['level'] =
        ra.status === 'direct_road' ? 'info' : ra.status === 'ditch' ? 'caution' : 'warning';
      const adj = ra.adjacentJimoks?.length ? ` (인접 지목: ${ra.adjacentJimoks.join('·')})` : '';
      riskItems.push({
        key: 'road_access',
        label: ra.status === 'direct_road' ? '도로 접함 확인'
          : ra.status === 'ditch' ? '구거·하천 인접 (진입 가능성 검토)'
          : '도로 접함 미확인 (현황도로·지분 확인)',
        level,
        note: ra.message + adj,
      });
    } else {
      riskItems.push({
        key: 'road_access',
        label: '접도 확인 권고',
        level: 'info',
        note: '땅에 차가 드나들 도로가 붙어 있는지 꼭 확인하세요. 도로가 없는 땅(맹지)은 건축 허가가 안 나는 경우가 많습니다. 다만 지적도에 안 나오는 현황도로나 도로지분 보유로 진입이 가능한 경우도 있으니, 진입 이력을 함께 확인하세요.',
      });
    }
  }

  // 6) 트리거
  const surveyTrigger = SURVEY_PURPOSES.includes(purpose);
  const expertTrigger =
    grade === 'expert' || grade === 'risky' || grade === 'unlikely' || zoneUnknown;

  if (surveyTrigger) {
    riskItems.push({
      key: 'survey_notice',
      label: '경계측량 안내',
      level: 'info',
      note: '담장·건물을 경계 가까이 지을 계획이면, 실제 땅 경계를 정확히 재는 게 좋습니다. 이 화면의 경계선은 참고용이고, 법적으로 인정되는 경계는 한국국토정보공사(LX)의 지적측량으로만 확정됩니다. 이웃과의 경계 분쟁을 막으려면 미리 측량하세요.',
    });
  }

  // 7) 예비 견적
  const cost = estimateCost(purpose, input.areaSqm);

  // 8) 추천
  const recommendations = buildRecommendations(purpose, input);

  return {
    purpose,
    purposeLabel: PURPOSE_LABELS[purpose],
    grade,
    gradeLabel: GRADE_LABELS[grade],
    gradeDescription: GRADE_DESC[grade],
    zone,
    zoneUnknown,
    riskItems,
    recommendations,
    estCostMin: cost.min,
    estCostMax: cost.max,
    surveyTrigger,
    expertTrigger,
    disclaimer: DISCLAIMER,
  };
}
