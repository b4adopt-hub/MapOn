/**
 * MAP On 진단 엔진 (룰 매트릭스)
 *
 * 입력: 토지 데이터(용도지역·지목·면적·경사·규제 신호) + 목적
 * 출력: 가능성 등급, 위험 항목, 추천 시설물, 예비 견적 범위, 면책·전문가 트리거
 *
 * 외부 의존 없음(순수 함수). 공공 API 키 없이 단위 테스트 가능.
 * 데이터가 채워지기 전이라도 부분 입력으로 동작하며, 누락분은
 * "확인 필요" 신호로 처리한다.
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
      note: '지목 정보가 확인되지 않았습니다. 토지대장 열람으로 확인이 필요합니다.',
    });
    return { risks, gradeAdj };
  }

  // 임야: 산지전용 가능성 — 전문가 확인
  if (j.includes('임') ) {
    risks.push({
      key: 'forest_conversion',
      label: '산지전용 검토 필요',
      level: 'warning',
      note: '임야는 건축·형질변경 시 산지전용허가가 필요할 수 있으며, 보전산지 여부에 따라 제한이 큽니다. 가부는 행정 심사 영역으로 전문가 확인이 필요합니다.',
    });
    gradeAdj = worseGrade('expert', gradeAdj ?? 'expert');
  }
  // 전·답: 농지전용 가능성
  if (j === '전' || j === '답' || j.includes('전') || j.includes('답')) {
    risks.push({
      key: 'farm_conversion',
      label: '농지전용 검토 필요',
      level: 'warning',
      note: '전·답 등 농지는 건축 시 농지전용허가가 필요할 수 있으며, 농업진흥구역이면 제한이 큽니다. 가부는 행정 심사 영역으로 전문가 확인이 필요합니다.',
    });
    if (purpose !== 'farmhut') {
      // 농막은 농지 위 설치가 오히려 정합적이므로 하향 폭을 줄임
      gradeAdj = worseGrade('expert', gradeAdj ?? 'expert');
    }
  }
  // 잡종지·대: 상대적으로 개발 친화
  return { risks, gradeAdj };
}

/** 경사 기반 위험 신호 */
function slopeRisks(input: LandInput): RiskItem[] {
  const risks: RiskItem[] = [];
  const s = input.slopePercent;
  if (s == null) return risks;
  if (s >= 25) {
    risks.push({
      key: 'slope_high',
      label: '급경사 주의',
      level: 'warning',
      note: `평균 경사가 약 ${s}%로 가파릅니다. 성토·옹벽·배수 공사비가 크게 늘 수 있고, 산지전용 시 경사도 기준에 걸릴 수 있습니다.`,
    });
  } else if (s >= 15) {
    risks.push({
      key: 'slope_mid',
      label: '경사 검토',
      level: 'caution',
      note: `평균 경사가 약 ${s}%입니다. 기초·배수 공사 비용 증가 가능성을 검토해야 합니다.`,
    });
  }
  return risks;
}

/** 규제 신호 → 위험 항목 + 등급 하향 */
function regulationRisks(input: LandInput): { risks: RiskItem[]; gradeAdj: Grade | null } {
  const risks: RiskItem[] = [];
  let gradeAdj: Grade | null = null;
  const regs = input.regulations ?? [];

  const HARD = [
    { match: '개발제한', label: '개발제한구역', grade: 'unlikely' as Grade },
    { match: '농업진흥', label: '농업진흥구역', grade: 'risky' as Grade },
    { match: '보전산지', label: '보전산지', grade: 'risky' as Grade },
    { match: '상수원', label: '상수원보호구역', grade: 'unlikely' as Grade },
    { match: '군사', label: '군사시설보호구역', grade: 'expert' as Grade },
    { match: '문화유산', label: '문화유산 보호구역', grade: 'expert' as Grade },
    { match: '생태', label: '생태·경관보전지역', grade: 'risky' as Grade },
  ];

  for (const reg of regs) {
    for (const h of HARD) {
      if (reg.includes(h.match)) {
        risks.push({
          key: `reg_${h.match}`,
          label: `${h.label} 지정`,
          level: 'warning',
          note: `${h.label}으로 지정된 토지로 보입니다. 해당 구역은 행위제한이 강하므로 전문가 확인이 필요합니다.`,
        });
        gradeAdj = gradeAdj ? worseGrade(gradeAdj, h.grade) : h.grade;
      }
    }
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

  const riskItems: RiskItem[] = [];

  if (zoneUnknown) {
    riskItems.push({
      key: 'zone_unknown',
      label: '용도지역 확인 필요',
      level: 'caution',
      note: '용도지역이 자동 매칭되지 않았습니다. 토지이용계획확인서로 확인이 필요합니다.',
    });
  }

  // 2) 지목 신호
  const j = jimokRisks(input, purpose);
  riskItems.push(...j.risks);
  if (j.gradeAdj) grade = worseGrade(grade, j.gradeAdj);

  // 3) 경사 신호
  riskItems.push(...slopeRisks(input));

  // 4) 규제 신호 (가장 강한 하향 요인)
  const r = regulationRisks(input);
  riskItems.push(...r.risks);
  if (r.gradeAdj) grade = worseGrade(grade, r.gradeAdj);

  // 5) 접도(맹지) — 데이터 부재 단계에서는 항상 확인 권고(info)
  riskItems.push({
    key: 'road_access',
    label: '접도 확인 권고',
    level: 'info',
    note: '진입도로(접도) 확보 여부는 건축 인허가의 핵심입니다. 현황도로·맹지 여부를 현장에서 확인하시기 바랍니다.',
  });

  // 6) 트리거
  const surveyTrigger = SURVEY_PURPOSES.includes(purpose);
  const expertTrigger =
    grade === 'expert' || grade === 'risky' || grade === 'unlikely' || zoneUnknown;

  if (surveyTrigger) {
    riskItems.push({
      key: 'survey_notice',
      label: '경계측량 안내',
      level: 'info',
      note: '경계에 인접한 시공은 정확한 경계 확인이 필요합니다. 본 서비스의 경계 표시는 참고용이며 법적 경계는 지적측량(한국국토정보공사 등)으로만 확정됩니다.',
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
