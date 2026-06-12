/**
 * 목적별 활용 가능성 매트릭스
 *
 * 핵심 원칙(법적 책무):
 * - 이 매트릭스는 "확정 판정"이 아니라 "사전검토 등급"을 낸다.
 * - 농지전용·산지전용·개발행위허가는 지자체 재량·심사 영역이므로
 *   매트릭스는 "전문가 확인 필요" 신호까지만 주고 가부를 단정하지 않는다.
 * - 모든 등급에는 "조례·현장 확인 필요" 전제가 따른다.
 */

import { ZoneCategory } from './zones';

/** 활용 목적 */
export type Purpose =
  | 'house' // 전원주택
  | 'farmhut' // 농막
  | 'warehouse' // 창고
  | 'cafe' // 카페(근린생활시설)
  | 'camping' // 캠핑장
  | 'petfacility' // 반려동물 시설
  | 'fence' // 울타리/펜스
  | 'landscape' // 조경 마당
  | 'parking' // 주차장
  | 'solar'; // 태양광

export const PURPOSE_LABELS: Record<Purpose, string> = {
  house: '전원주택',
  farmhut: '농막',
  warehouse: '창고',
  cafe: '카페',
  camping: '캠핑장',
  petfacility: '반려동물 시설',
  fence: '울타리',
  landscape: '조경 마당',
  parking: '주차장',
  solar: '태양광',
};

/** 5단계 가능성 등급 (사업계획서 4-나-2 기준) */
export type Grade =
  | 'high' // 가능성 높음
  | 'conditional' // 조건부 검토
  | 'expert' // 전문가 확인 필요
  | 'risky' // 리스크 높음
  | 'unlikely'; // 불가 가능성 높음

export const GRADE_LABELS: Record<Grade, string> = {
  high: '가능성 높음',
  conditional: '조건부 검토',
  expert: '전문가 확인 필요',
  risky: '리스크 높음',
  unlikely: '불가 가능성 높음',
};

/** 등급 우선순위 — 더 보수적인(불리한) 쪽이 큰 값 */
export const GRADE_RANK: Record<Grade, number> = {
  high: 0,
  conditional: 1,
  expert: 2,
  risky: 3,
  unlikely: 4,
};

/** 두 등급 중 더 보수적인 쪽 반환 (여러 신호 결합 시 사용) */
export function worseGrade(a: Grade, b: Grade): Grade {
  return GRADE_RANK[a] >= GRADE_RANK[b] ? a : b;
}

/**
 * 용도지역 대분류(category) × 목적 → 기본 등급.
 * 이는 "출발 등급"이며, 이후 지목·경사·규제 신호로 하향 조정된다.
 *
 * 표는 일반적 경향을 반영한 보수적 기본값이다.
 * 비도시(관리·농림·자연환경보전)에서 전원주택·근생은 개발행위허가·전용이
 * 얽히므로 기본을 conditional/expert 이하로 둔다.
 */
export const BASE_MATRIX: Record<Purpose, Record<ZoneCategory, Grade>> = {
  // 전원주택: 도시(주거) 양호 / 관리는 조건부~전문가 / 농림·보전 불리
  house: { urban: 'conditional', management: 'expert', agriculture: 'risky', conservation: 'unlikely' },
  // 농막: 농지에 설치하는 가설건축물. 농림·관리에서 오히려 친화적이나 신고·요건 필요
  farmhut: { urban: 'conditional', management: 'conditional', agriculture: 'conditional', conservation: 'risky' },
  // 창고: 관리지역 친화 / 도시 녹지·농림은 제한 / 보전 불리
  warehouse: { urban: 'conditional', management: 'conditional', agriculture: 'expert', conservation: 'unlikely' },
  // 카페(근생): 계획관리·도시 가능 / 보전·생산관리·농림 제한 강함
  cafe: { urban: 'conditional', management: 'expert', agriculture: 'risky', conservation: 'unlikely' },
  // 캠핑장: 관리지역 등에서 등록·개발행위 필요 / 보전 불리
  camping: { urban: 'expert', management: 'expert', agriculture: 'risky', conservation: 'unlikely' },
  // 반려동물 시설: 동물 관련 시설은 용도·이격·민원 변수 큼 → 보수적
  petfacility: { urban: 'expert', management: 'expert', agriculture: 'risky', conservation: 'unlikely' },
  // 울타리/펜스: 경계 시공. 대체로 가능하나 경계측량·인접지 분쟁 변수
  fence: { urban: 'high', management: 'high', agriculture: 'conditional', conservation: 'conditional' },
  // 조경 마당: 형질변경 경미. 대체로 가능
  landscape: { urban: 'high', management: 'high', agriculture: 'conditional', conservation: 'conditional' },
  // 주차장: 포장·형질변경. 도시·관리 가능 / 농림·보전 제한
  parking: { urban: 'conditional', management: 'conditional', agriculture: 'expert', conservation: 'risky' },
  // 태양광: 이격거리 조례·경사·산지 변수 매우 큼 → 전문가 확인 기본
  solar: { urban: 'expert', management: 'expert', agriculture: 'expert', conservation: 'unlikely' },
};
