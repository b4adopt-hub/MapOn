/**
 * 지자체 조례(자치법규) 안내 레이어 — Supabase 데이터 기반
 *
 * 구성:
 *  - ordinance_rules(get_ordinance RPC): 수기 큐레이션 경고·안내 규칙
 *  - zoning_rates: 조례 기본 건폐율·용적률 (국토부 토지이용규제 월별 데이터)
 *  - permitted_uses: 조례 기준 용도별 건축 가능/금지 (동 데이터)
 *  - devperm_rules: 개발행위허가 경사도·입목축적 (지자체 조례 실측 등재)
 * 데이터 없는 지자체는 일반 안내(genericItems) 폴백.
 */

import { Purpose, PURPOSE_LABELS } from './purposes';
import { supabase, supabaseReady } from '../lib/supabase';
import { fetchZoningRates, ZoningRates } from './zoningRates';
import { fetchPermittedUses, PurposeUseResult } from './permittedUses';
import { fetchDevPermRules, slopeVerdict, DevPermRules } from './devPermRules';

export interface OrdinanceItem {
  key: string;
  label: string;
  level: 'info' | 'caution' | 'warning';
  note: string;
  source?: string;
}

export interface OrdinanceResult {
  sggCode: string | null;
  sggName: string | null;
  elisUrl: string | null;
  items: OrdinanceItem[];
  /** 조례 기본 건폐율·용적률 (zoning_rates 기반, 없으면 null) */
  rates: ZoningRates | null;
  /** 조례 기준 용도별 가능여부 (permitted_uses 기반) */
  uses: PurposeUseResult[];
}

/** ELIS 자치법규 목록 링크 */
function elisLink(sgg: string): string {
  return `https://www.elis.go.kr/locgovalr/locgovClAlrList?ctpvSggCd=${sgg}`;
}

/** 데이터 없는 지자체용 일반 안내(클라이언트 폴백) */
function genericItems(zoneName: string, purposes: Purpose[]): OrdinanceItem[] {
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
  if (z.includes('녹지') || z.includes('관리') || z.includes('농림') || z.includes('자연환경')) {
    items.push({
      key: 'gen_bcr',
      label: '건폐율·용적률 — 조례로 정하는 비율 확인',
      level: 'info',
      note: '녹지지역·관리지역·농림지역의 건폐율·용적률 상한은 국토계획법이 정한 범위 안에서 지자체 조례로 최종 결정됩니다. 자동 표시된 수치는 일반 기준이며, 특정 시설에 대한 특례(상향)가 있을 수 있으니 조례를 확인하세요.',
    });
  }
  return items;
}

interface RpcRow {
  sgg_code: string;
  sgg_name: string | null;
  level: 'info' | 'caution' | 'warning';
  label: string;
  note: string;
  source: string | null;
  sort_order: number;
}

/** zoning_rates 기반 조례 기본율 안내 항목 생성 */
function ratesItem(rates: ZoningRates, zoneName: string): OrdinanceItem {
  const parts: string[] = [];
  if (rates.bcr) parts.push(`건폐율 ${rates.bcr.pct}% 이하`);
  if (rates.far) parts.push(`용적률 ${rates.far.pct}% 이하`);
  const src = rates.bcr ?? rates.far;
  const provParts: string[] = [];
  if (rates.bcr) provParts.push(`건폐율 「${rates.bcr.ordinance}」 ${rates.bcr.provision}`);
  if (rates.far) provParts.push(`용적률 「${rates.far.ordinance}」 ${rates.far.provision}`);
  const dt = src?.enforceDt ? ` (시행 ${src.enforceDt})` : '';
  const fb = rates.sidoFallback ? ' ※ 광역 지자체 조례 기준입니다.' : '';
  return {
    key: 'zoning_rates',
    label: `이 지역 조례 기준: ${parts.join(' · ')}`,
    level: 'info',
    note: `${zoneName}의 조례상 기본 기준입니다. 근거: ${provParts.join(', ')}${dt}. 법령 일반값이 아닌 해당 지자체 조례 수치이며, 방화지구·성장관리계획구역 등 특례로 달라질 수 있습니다.${fb}`,
    source: '국토부 토지이용규제정보(토지이음)',
  };
}

/** permitted_uses 기반 용도별 가능여부 항목 생성 */
function useItem(u: PurposeUseResult, zoneName: string): OrdinanceItem {
  const VERDICT_LABEL = {
    allowed: '조례상 건축 가능',
    conditional: '조례상 조건부 가능',
    denied: '조례상 건축 금지',
    mixed: '조례상 용도별 상이',
  } as const;
  const level: OrdinanceItem['level'] =
    u.verdict === 'denied' ? 'warning' : u.verdict === 'allowed' ? 'info' : 'caution';
  const evLines = u.evidences
    .map((e) => `${e.landUse}: ${e.decision}${e.condition ? ` — ${e.condition.slice(0, 100)}` : ''}`)
    .join(' / ');
  const law = u.evidences.find((e) => e.lawName)?.lawName;
  const fb = u.sidoFallback ? ' ※ 광역 지자체 조례 기준입니다.' : '';
  return {
    key: `use_${u.purpose}`,
    label: `${PURPOSE_LABELS[u.purpose]} — ${VERDICT_LABEL[u.verdict]}`,
    level,
    note: `${zoneName}에서의 용도별 판정: ${evLines}${law ? ` (근거: ${law})` : ''}. 조례 기준 사전검토이며, 농지·산지전용·개발행위허가 등 인허가는 별도입니다.${fb}`,
    source: '국토부 토지이용규제 행위제한정보(토지이음)',
  };
}

/** devperm_rules 기반 개발행위허가 경사도·입목축적 항목 생성 */
function devPermItems(dev: DevPermRules, userSlopePct: number | null): OrdinanceItem[] {
  const out: OrdinanceItem[] = [];
  if (dev.slope) {
    const areaTxt = dev.slope.areas.length
      ? ' 지역구분: ' + dev.slope.areas.map((a) => `${a.area} ${a.valueDeg ?? a.valuePct}${a.valueDeg != null ? '도' : '%'}`).join(', ') + '.'
      : '';
    const roadTxt = dev.slope.accessRoadPct != null ? ` 진입로 종단경사도는 ${dev.slope.accessRoadPct}% 이하여야 합니다.` : '';
    const verdict = slopeVerdict(userSlopePct, dev.slope.baseDeg);
    out.push({
      key: 'devperm_slope',
      label: verdict
        ? `개발행위허가 경사도 — ${verdict.level === 'warning' ? '기준 초과 주의' : verdict.level === 'caution' ? '기준 근접' : '기준 이내'}`
        : `개발행위허가 경사도 기준: ${dev.slope.baseDeg ?? '-'}도 이하`,
      level: verdict?.level ?? 'caution',
      note: `${dev.slope.baseDeg != null ? `이 지자체는 경사도 ${dev.slope.baseDeg}도 이하 토지에 한해 개발행위를 허가합니다.` : ''}${areaTxt}${roadTxt}${verdict ? ' ' + verdict.text : ' 계획 필지의 평균경사도를 확인하세요.'} 경사도 산정방식은 지자체 규칙으로 정해지며, 기준 초과 시에도 도시계획위원회 심의로 허가되는 경우가 있습니다.`,
      source: `「${dev.slope.ordinance}」 ${dev.slope.provision}`,
    });
  }
  if (dev.forestStock) {
    out.push({
      key: 'devperm_forest',
      label: '개발행위허가 입목축적 기준',
      level: 'info',
      note: `임야 개발 시 입목축적 기준: ${dev.forestStock.text}. 대상 토지의 헥타르당 평균입목축적이 기준을 초과하면 개발행위허가가 제한될 수 있습니다.`,
      source: `「${dev.forestStock.ordinance}」 ${dev.forestStock.provision}`,
    });
  }
  return out;
}

/**
 * 조례 안내 조회(비동기). get_ordinance RPC + zoning_rates + permitted_uses + devperm_rules.
 * @param pnu         19자리 PNU (앞 5자리가 시군구 코드)
 * @param zoneName    대표 용도지역명
 * @param purposes    선택 목적들
 * @param userSlopePct 사용자 입력 평균 경사도(%) — 개발행위 경사도 대조용
 */
export async function fetchOrdinance(
  pnu: string | null | undefined,
  zoneName: string | null | undefined,
  purposes: Purpose[],
  userSlopePct?: number | null,
): Promise<OrdinanceResult> {
  const sgg = pnu && pnu.length >= 5 ? pnu.slice(0, 5) : null;
  const z = zoneName ?? '';
  const ps = purposes.length ? purposes : (['house'] as Purpose[]);
  const elisUrl = sgg ? elisLink(sgg) : null;

  if (!sgg || !supabaseReady || !supabase) {
    const items = genericItems(z, ps);
    if (elisUrl) items.push(elisLinkItem(null));
    return { sggCode: sgg, sggName: null, elisUrl, items, rates: null, uses: [] };
  }

  let sggName: string | null = null;
  let items: OrdinanceItem[] = [];

  // 조례 규칙(RPC)·기본율·행위제한·개발행위기준 병렬 조회
  const ratesPromise = fetchZoningRates(sgg, z);
  const usesPromise = fetchPermittedUses(sgg, z, ps);
  const devPromise = fetchDevPermRules(sgg);

  try {
    const { data, error } = await supabase.rpc('get_ordinance', {
      p_sgg: sgg,
      p_zone: z,
      p_purposes: ps,
    });
    if (!error && Array.isArray(data) && data.length > 0) {
      const rows = data as RpcRow[];
      sggName = rows[0].sgg_name;
      items = rows.map((r, i) => ({
        key: `db_${i}`,
        label: r.label,
        level: r.level,
        note: r.note,
        source: r.source ?? undefined,
      }));
    }
  } catch {
    // 무시하고 폴백
  }

  const [rates, uses, dev] = await Promise.all([ratesPromise, usesPromise, devPromise]);

  // 시군구명을 못 받았으면 sgg_codes에서 직접 조회
  if (!sggName) {
    try {
      const { data } = await supabase.from('sgg_codes').select('sgg_name').eq('sgg_code', sgg).maybeSingle();
      sggName = (data as { sgg_name: string } | null)?.sgg_name ?? null;
    } catch { /* 무시 */ }
  }

  // DB에 조례 규칙이 없으면 일반 안내 폴백
  if (items.length === 0) {
    items = genericItems(z, ps);
  }

  // 개발행위허가 경사도·입목축적 (해당 시 추가)
  if (dev) {
    items.push(...devPermItems(dev, userSlopePct ?? null));
  }

  // 용도별 가능여부 (선택 목적 순서 유지, 상단 배치)
  if (uses.length > 0 && z) {
    for (const u of [...uses].reverse()) {
      items.unshift(useItem(u, z));
    }
  }

  // 조례 기본율은 최상단
  if (rates && z) {
    items.unshift(ratesItem(rates, z));
  }

  if (elisUrl) items.push(elisLinkItem(sggName));

  return { sggCode: sgg, sggName, elisUrl, items, rates, uses };
}

/** ELIS 직접 확인 항목 */
function elisLinkItem(sggName: string | null): OrdinanceItem {
  return {
    key: 'elis_link',
    label: sggName ? `${sggName} 자치법규 직접 확인` : '해당 지자체 자치법규 직접 확인',
    level: 'info',
    note: `정확한 조례 기준은 자치법규정보시스템(ELIS)에서 ${sggName ?? '해당 지자체'}의 도시계획 조례·건축 조례를 직접 확인하세요. 건축물 높이, 건폐율·용적률 특례, 가축사육제한 거리 등 세부 수치가 조례에 규정되어 있습니다.`,
  };
}
