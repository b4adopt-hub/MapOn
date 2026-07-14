/**
 * 조례 행위제한 결과를 진단 등급에 반영하는 순수 함수.
 * 규칙(보수적 — 하향만 적용, 상향 없음):
 *  - 조례상 건축 금지(예외조건 없음) → 불가 가능성 높음(unlikely)
 *  - 조례상 건축 금지(예외조건 있음: 상수원 집수구역 제외 등) → 리스크 높음(risky)
 *  - 용도별 상이(mixed) → 전문가 확인(expert)
 *  - 가능/조건부는 등급 변경 없음(기존 등급 유지)
 */

import { DiagnosisResult } from './diagnose';
import { Grade, GRADE_LABELS, worseGrade } from './purposes';
import { OrdinanceResult } from './ordinance';

const DESC_ON_DOWNGRADE: Record<string, string> = {
  unlikely: '지자체 조례상 이 용도지역에서 해당 용도의 건축이 금지로 확인되어 등급을 하향했습니다. 매입 전 반드시 지자체에 확인하세요.',
  risky: '지자체 조례상 이 용도의 건축이 원칙 금지이나 예외 조건이 있습니다(예: 공공하수처리구역·자연마을 제외). 필지가 예외에 해당하는지 확인이 필요해 등급을 하향했습니다.',
  expert: '지자체 조례상 세부 용도별로 가능·금지가 갈립니다. 계획한 세부 용도 기준으로 지자체·전문가 확인이 필요해 등급을 조정했습니다.',
};

/**
 * 조례 조회 결과(OrdinanceResult)를 기존 진단 결과에 반영해 새 결과를 반환.
 * 해당 목적의 행위제한 데이터가 없으면 원본 그대로 반환(무손).
 */
export function applyOrdinance(diag: DiagnosisResult, ord: OrdinanceResult): DiagnosisResult {
  const u = ord.uses.find((x) => x.purpose === diag.purpose);
  if (!u) return diag;

  let target: Grade | null = null;
  if (u.verdict === 'denied') {
    target = u.evidences.some((e) => e.condition) ? 'risky' : 'unlikely';
  } else if (u.verdict === 'mixed') {
    target = 'expert';
  }
  if (!target) return diag;

  const newGrade = worseGrade(diag.grade, target);
  const evLine = u.evidences
    .slice(0, 3)
    .map((e) => `${e.landUse}: ${e.decision}`)
    .join(' / ');

  const riskItem = {
    key: `ord_use_${diag.purpose}`,
    label: '지자체 조례 행위제한 반영',
    level: 'warning' as const,
    note: `이 지역 조례 기준 용도별 판정: ${evLine}. 자세한 예외 조건은 상단 '지자체 조례 확인 항목'을 참고하세요. (사전검토이며 확정 판정이 아닙니다)`,
  };

  // 이미 같거나 더 보수적인 등급이어도 근거 항목은 추가(중복 방지)
  const hasItem = diag.riskItems.some((r) => r.key === riskItem.key);
  const riskItems = hasItem ? diag.riskItems : [riskItem, ...diag.riskItems];

  if (newGrade === diag.grade) {
    return { ...diag, riskItems };
  }
  return {
    ...diag,
    grade: newGrade,
    gradeLabel: GRADE_LABELS[newGrade],
    gradeDescription: DESC_ON_DOWNGRADE[target] ?? diag.gradeDescription,
    riskItems,
    expertTrigger: true,
  };
}
