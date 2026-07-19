// 기존 건물이 있는 토지의 "건물 중심" 시나리오 분석.
//
// 건물이 있는 토지에서 활용 목적이 입력되면, 땅 일반론이 아니라 다음 세 경로를
// 수치와 함께 제시한다:
//   ① 기존 건물 그대로 활용(용도변경) — 가능성·절차·제약
//   ② 기존 건물 유지 + 잔여 건폐율·용적률로 추가 신축 — 몇 ㎡(평)·몇 층까지
//   ③ 철거 후 신축 — 최대 규모(바닥·연면적·층수 계산치)
//
// 수치는 공부(토지·건축물대장)와 적용 건폐율·용적률(조례 우선)로 산출한 추정치다.
// 조문 번호를 단정 인용하지 않으며, 확정은 지자체·전문가 확인을 전제로 안내한다.

export interface ScenarioBuilding {
  mainPurpose: string | null;
  totArea: number | null;   // 연면적(㎡)
  archArea: number | null;  // 건축면적(㎡) — 대장에 없으면 추정
  grndFlr: number | null;   // 지상 층수
  violation: boolean;
}

export interface ScenarioInput {
  areaSqm: number;              // 대지면적(㎡)
  bcrPct: number | null;        // 적용 건폐율(%) — 조례값 우선
  farPct: number | null;        // 적용 용적률(%)
  zoneName: string | null;      // 용도지역명
  purposeLabel: string;         // 사용자가 입력한 활용 목적
  building: ScenarioBuilding;
}

export interface Scenario {
  key: 'reuse' | 'expand' | 'rebuild';
  title: string;
  headline: string;             // 핵심 결론 한 줄(수치 포함)
  lines: string[];              // 산출 근거·설명
  cautions: string[];           // 주의사항
}

export interface ScenarioResult {
  scenarios: Scenario[];
  notes: string[];              // 층수 제한·추정 가정 등 공통 참고
}

const PY = 0.3025; // ㎡ → 평
const py = (m2: number) => Math.round(m2 * PY * 10) / 10;
const r0 = (v: number) => Math.round(v);

function fmtArea(m2: number): string {
  return `약 ${r0(m2).toLocaleString()}㎡(${py(m2).toLocaleString()}평)`;
}

/** 용도지역상 층수 제한 참고 문구(법정 일반 기준, 조례 우선) */
function floorsLimitNote(zoneName: string | null): string | null {
  if (!zoneName) return null;
  if (/녹지|관리|농림|자연환경보전/.test(zoneName)) {
    return `${zoneName}은 법령상 4층 이하로 층수가 제한되는 것이 일반적입니다(지자체 조례로 달리 정할 수 있어 확인 필요).`;
  }
  return null;
}

/** 연면적 한도와 바닥면적으로 계산되는 층수(법정 층수 제한과 함께 표기용) */
function calcFloors(gfa: number, footprint: number): number {
  if (footprint <= 0) return 0;
  return Math.max(1, Math.floor(gfa / footprint));
}

export function buildScenarios(inp: ScenarioInput): ScenarioResult | null {
  const { areaSqm, bcrPct, farPct, building, purposeLabel, zoneName } = inp;
  if (!areaSqm || areaSqm <= 0 || bcrPct == null || farPct == null) return null;

  const notes: string[] = [];
  const maxFoot = (areaSqm * bcrPct) / 100; // 바닥면적 상한
  const maxGfa = (areaSqm * farPct) / 100;  // 연면적 상한

  const totArea = building.totArea ?? null;
  let archArea = building.archArea ?? null;
  if (archArea == null && totArea != null) {
    archArea = totArea / Math.max(1, building.grndFlr ?? 1);
    notes.push('건축면적이 공부에 없어 연면적÷지상층수로 추정한 값입니다.');
  }

  const scenarios: Scenario[] = [];

  // ① 기존 건물 그대로 활용(용도변경)
  {
    const bldDesc = `주용도 ${building.mainPurpose ?? '미상'}${totArea != null ? ` · 연면적 ${fmtArea(totArea)}` : ''}`;
    const lines = [
      `기존 건물(${bldDesc})을 철거·신축 없이 '${purposeLabel}' 용도로 쓰는 경로입니다. 비용·기간이 가장 적게 듭니다.`,
      `핵심은 건축물대장상 용도를 '${purposeLabel}'에 맞는 용도로 변경할 수 있는지입니다. 건축법상 용도변경은 현재 용도와 목표 용도가 속한 시설군에 따라 허가·신고·기재변경으로 절차가 갈립니다.`,
    ];
    const cautions: string[] = [];
    if (building.violation) {
      cautions.push('위반건축물로 등재된 상태에서는 해소(원상복구·양성화) 전 용도변경이 제한됩니다.');
    }
    cautions.push('용도변경 시 주차대수·정화조 용량·소방 기준이 새 용도 기준으로 재산정될 수 있습니다.');
    cautions.push('변경 가능 여부와 절차는 지자체 건축부서에서 확정됩니다.');
    scenarios.push({
      key: 'reuse',
      title: '① 기존 건물 활용 (용도변경)',
      headline: '철거·신축 없이 가장 빠르고 저렴한 경로',
      lines,
      cautions,
    });
  }

  // ② 기존 건물 유지 + 추가 신축(증축·별동)
  if (archArea != null && totArea != null) {
    const remFoot = maxFoot - archArea;
    const remGfa = maxGfa - totArea;
    const lines: string[] = [];
    const cautions: string[] = [];
    let headline: string;

    if (remFoot > 5 && remGfa > 5) {
      headline = `추가 신축 여유 — 바닥 최대 ${fmtArea(remFoot)}, 연면적 최대 ${fmtArea(remGfa)}`;
      lines.push(
        `대지 ${r0(areaSqm).toLocaleString()}㎡ × 건폐율 ${bcrPct}% = 바닥 상한 ${fmtArea(maxFoot)}에서 기존 건축면적 ${fmtArea(archArea)}을 빼면, 새 건물 바닥으로 ${fmtArea(remFoot)}까지 여유가 있습니다.`
      );
      lines.push(
        `용적률 ${farPct}% 기준 연면적 상한 ${fmtArea(maxGfa)}에서 기존 연면적 ${fmtArea(totArea)}을 빼면 ${fmtArea(remGfa)}까지 추가할 수 있습니다.`
      );
      const fl = calcFloors(remGfa, remFoot);
      if (fl >= 2) {
        lines.push(`바닥을 여유 최대(${fmtArea(remFoot)})로 잡으면 연면적 한도 기준 ${fl}층분까지 계산됩니다 — 용도지역 층수 제한과 조례가 우선 적용됩니다.`);
      }
      cautions.push('증축·별동 신축은 건축허가(경우에 따라 개발행위허가 포함) 대상이며, 자연보전권역 등 규제구역에서는 규모·업종 심사가 추가될 수 있습니다.');
      cautions.push('기존 건물이 현행 기준(도로 폭·주차 등)에 부적합하면 증축 시 보완이 요구될 수 있습니다.');
    } else {
      headline = '건폐율·용적률 여유가 사실상 없음 — 증축·별동 신축 곤란';
      if (remFoot <= 5) lines.push(`건폐율 ${bcrPct}% 기준 바닥 상한 ${fmtArea(maxFoot)}을 기존 건축면적 ${fmtArea(archArea)}이 거의 소진했습니다.`);
      if (remGfa <= 5) lines.push(`용적률 ${farPct}% 기준 연면적 상한 ${fmtArea(maxGfa)}을 기존 연면적 ${fmtArea(totArea)}이 거의 소진했습니다.`);
      lines.push('이 경우 규모를 키우려면 ③ 철거 후 신축 또는 용도지역·조례상 완화 특례 검토가 필요합니다.');
    }
    scenarios.push({ key: 'expand', title: '② 기존 유지 + 추가 신축', headline, lines, cautions });
  }

  // ③ 철거 후 신축
  {
    const fl = calcFloors(maxGfa, maxFoot);
    const lines = [
      `기존 건물을 철거(멸실신고)하고 새로 짓는 경우, 바닥 최대 ${fmtArea(maxFoot)}, 연면적 최대 ${fmtArea(maxGfa)}까지 계획할 수 있습니다.`,
      `바닥을 상한까지 쓰면 연면적 한도 기준 ${fl}층분까지 계산되며, 실제 층수는 용도지역 층수 제한과 조례가 우선합니다.`,
    ];
    const cautions = [
      '철거에는 철거비와 멸실신고가 따르고, 신축에는 현행 건폐율·용적률·도로·주차·정화조 기준이 전부 새로 적용됩니다(기존 건물이 누리던 기득권 소멸).',
      '규제구역(자연보전권역 등)에서는 신축 규모·업종 심사가 까다로울 수 있어 인허가 난이도가 가장 높은 경로입니다.',
    ];
    scenarios.push({
      key: 'rebuild',
      title: '③ 철거 후 신축',
      headline: `최대 규모 — 바닥 ${fmtArea(maxFoot)} · 연면적 ${fmtArea(maxGfa)}`,
      lines,
      cautions,
    });
  }

  const fln = floorsLimitNote(zoneName);
  if (fln) notes.push(fln);

  return { scenarios, notes };
}
