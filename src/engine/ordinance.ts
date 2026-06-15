/**
 * 지자체 조례(자치법규) 안내 레이어
 *
 * 용도지역·규제는 국가 공간정보(브이월드/NED)로 자동 조회되지만,
 * 지자체 조례(건축물 높이·층수, 생산녹지 건폐율, 가축사육제한 거리 등)는
 * 표준화된 전국 API가 없다. 각 지자체가 자치법규로 따로 정한다.
 *
 * 따라서 본 레이어는 "조례 수치를 단정"하지 않고,
 *  - 이 땅에 적용되는 조례 항목이 무엇인지 짚어주고
 *  - 해당 지자체 자치법규(ELIS) 링크로 직접 확인하도록 안내한다.
 * (법적 방어: 확정 표현 금지 원칙과 일치)
 *
 * PNU 앞 5자리 = 법정동 시군구 코드. 이 코드로 지자체를 식별하고
 * ELIS(자치법규정보시스템) 링크를 자동 생성한다.
 */

import { Purpose } from './purposes';

export interface OrdinanceItem {
  key: string;
  label: string;
  level: 'info' | 'caution' | 'warning';
  note: string;
}

export interface OrdinanceResult {
  sggCode: string | null;     // 시군구 코드(PNU 앞 5자리)
  sggName: string | null;     // 지자체명(알려진 경우)
  elisUrl: string | null;     // 해당 지자체 자치법규 목록 링크
  items: OrdinanceItem[];     // 조례 확인 안내 항목
}

/** 자주 다루는 시군구 코드 → 이름. 폴백은 코드만 노출. */
const SGG_NAMES: Record<string, string> = {
  '41820': '가평군',
  '51750': '영월군',
  '41610': '광주시',
  '41830': '양평군',
  '51820': '홍천군',
  '51760': '평창군',
  '51730': '횡성군',
  '47830': '청송군',
  '41280': '고양시',
  '41360': '남양주시',
};

/** ELIS 자치법규 목록 링크 — ctpvSggCd에 시군구 5자리 코드 */
function elisLink(sgg: string): string {
  return `https://www.elis.go.kr/locgovalr/locgovClAlrList?ctpvSggCd=${sgg}`;
}

/**
 * 가평군(41820) 전용 조례 디테일.
 * 출처: 가평군 군계획 조례, 가평군 건축 조례(국가법령정보센터/ELIS).
 * 수치는 "확인 기준"으로만 안내하며 확정하지 않는다.
 */
function gapyeongOrdinance(zoneName: string, purposes: Purpose[]): OrdinanceItem[] {
  const items: OrdinanceItem[] = [];
  const z = zoneName || '';

  // 건축물 높이 — 가평군은 단일 높이 상한이 아니라 일조권(정북방향)·가로구역 기준.
  // 저층(2층 이하·높이 8m 이하)은 일조권 제한 완화 대상.
  const buildPurposes: Purpose[] = ['house', 'cafe', 'warehouse', 'petfacility', 'farmhut'];
  if (purposes.some(p => buildPurposes.includes(p))) {
    items.push({
      key: 'gp_height',
      label: '가평군 건축물 높이 — 일조권·가로구역 기준',
      level: 'caution',
      note: '가평군은 건축물 높이를 단일 숫자로 일괄 제한하지 않고, 정북방향 일조권 확보 기준과 가로구역별 최고높이로 규율합니다. 통상 2층 이하·높이 8m 이하 건축물은 일조권 제한이 완화되지만, 그 이상은 인접 대지 경계에서 띄워야 하는 거리(이격) 기준이 적용됩니다. 계획한 층수·높이가 가능한지 가평군 건축조례로 확인하세요.',
    });
  }

  // 생산녹지 건폐율 — 일반 20%, 특정 농수산 가공·처리시설 등은 조례상 60%.
  if (z.includes('생산녹지')) {
    items.push({
      key: 'gp_green_bcr',
      label: '생산녹지 건폐율 — 일반 20%, 일부 농업시설 60%',
      level: 'info',
      note: '가평군 군계획 조례상 생산녹지지역의 건폐율은 원칙적으로 20%이나, 가평·인근 시군에서 생산된 농수산물의 가공·처리시설, 농산물 건조·보관시설 등 특정 농업 관련 시설은 60%까지 허용됩니다. 지으려는 건축물이 이 특례에 해당하는지 확인하면 활용 면적이 크게 달라집니다.',
    });
  }

  // 가축사육제한 — 반려동물 시설 목적이면 거리 기준 강조.
  if (purposes.includes('petfacility')) {
    items.push({
      key: 'gp_livestock',
      label: '가평군 가축사육제한 — 주거 밀집지 이격거리 확인',
      level: 'warning',
      note: '반려동물 보호·위탁·번식·훈련·장묘 시설 등은 가평군 가축분뇨 관리 조례의 가축사육제한구역 이격거리(주거 밀집지·도로·하천 등으로부터의 거리)와 건축물 용도 기준에 걸릴 수 있습니다. 동물보호법상 등록·허가 여부와 함께, 해당 필지가 제한구역 거리 안에 드는지 군청에 확인하세요.',
    });
  }

  return items;
}

/** 일반 지자체 — 조례 확인 안내(수치 미상, 링크 중심) */
function genericOrdinance(zoneName: string, purposes: Purpose[]): OrdinanceItem[] {
  const items: OrdinanceItem[] = [];
  const z = zoneName || '';
  const buildPurposes: Purpose[] = ['house', 'cafe', 'warehouse', 'petfacility', 'farmhut'];

  if (purposes.some(p => buildPurposes.includes(p))) {
    items.push({
      key: 'gen_height',
      label: '건축물 높이·층수 — 지자체 조례 확인 필요',
      level: 'caution',
      note: '건축물의 최고 높이·층수는 지자체 도시계획·건축 조례와 일조권(정북방향) 기준, 지구단위계획·경관지구 지정 여부에 따라 달라집니다. 같은 용도지역이라도 지자체마다 기준이 다르므로, 계획한 높이가 가능한지 해당 지자체 자치법규로 확인하세요.',
    });
  }
  if (z.includes('녹지') || z.includes('관리')) {
    items.push({
      key: 'gen_bcr',
      label: '건폐율·용적률 — 조례로 정하는 비율 확인',
      level: 'info',
      note: '녹지지역·관리지역의 건폐율·용적률 상한은 국토계획법이 정한 범위 안에서 지자체 조례로 최종 결정됩니다. 자동 표시된 수치는 일반 기준이며, 특정 시설에 대한 특례(상향)가 있을 수 있으니 조례를 확인하세요.',
    });
  }
  return items;
}

/**
 * 조례 안내 생성.
 * @param pnu  19자리 PNU (앞 5자리가 시군구 코드)
 * @param zoneName  대표 용도지역명
 * @param purposes  사용자가 선택한 목적들
 */
export function buildOrdinance(pnu: string | null | undefined, zoneName: string | null | undefined, purposes: Purpose[]): OrdinanceResult {
  const sgg = pnu && pnu.length >= 5 ? pnu.slice(0, 5) : null;
  const sggName = sgg ? (SGG_NAMES[sgg] ?? null) : null;
  const elisUrl = sgg ? elisLink(sgg) : null;
  const z = zoneName ?? '';
  const ps = purposes.length ? purposes : (['house'] as Purpose[]);

  let items: OrdinanceItem[];
  if (sgg === '41820') {
    items = gapyeongOrdinance(z, ps);
  } else {
    items = genericOrdinance(z, ps);
  }

  // 공통: 자치법규 직접 확인 안내(링크 동반)
  if (elisUrl) {
    items.push({
      key: 'elis_link',
      label: sggName ? `${sggName} 자치법규 직접 확인` : '해당 지자체 자치법규 직접 확인',
      level: 'info',
      note: `정확한 조례 기준은 자치법규정보시스템(ELIS)에서 ${sggName ?? '해당 지자체'}의 도시계획 조례·건축 조례를 직접 확인하세요. 건축물 높이, 건폐율·용적률 특례, 가축사육제한 거리 등 세부 수치가 조례에 규정돼 있습니다.`,
    });
  }

  return { sggCode: sgg, sggName, elisUrl, items };
}
