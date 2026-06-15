// MapOn: 토지 조회 Edge Function (v10 - 도로 소유구분 판별: 사유도로(사도) 경고 추가, getPossessionAttr 연동)
// 입력: { pnu } 또는 { address, addressType }
// 흐름:
//   1) 주소→getcoord 좌표→연속지적도 역조회→PNU 확정 (또는 PNU 직접)
//   2) 면적: 경계 폴리곤에서 측지면적 직접 계산
//   3) 공시지가: 지적도 jiga
//   4) 용도지역/규제: NED getLandUseAttr
//   5) 인접 도로 확인: bbox 공간쿼리(도로 포착) + 거리 2차 필터(일반필지 2.5m, 도로·구거·유지는 면제)
//      + 접한 도로의 소유구분(getPossessionAttr) 조회 → 사유도로(사도) 경고
//   6) land_lookups 캐싱
// 시크릿: VWORLD_KEY(필수), VWORLD_DOMAIN(선택, 기본 b4adopt.org)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const VW_DATA = 'https://api.vworld.kr/req/data';
const VW_ADDR = 'https://api.vworld.kr/req/address';
const NED = 'https://api.vworld.kr/ned/data';

interface UseZone { name: string; code: string; conflict: string; isPrimary: boolean }

interface RoadAccess {
  status: 'direct_road' | 'ditch' | 'none' | 'unknown';
  adjacentJimoks: string[];
  message: string;
  roadOwnership?: 'gov' | 'private' | 'mixed' | 'unknown';  // 접한 도로의 소유: 국공유/사유/혼재/미상
  roadOwnerNote?: string;                                    // 소유 관련 안내 문구
}

interface LandResult {
  pnu: string | null;
  address: string | null;
  jimok: string | null;
  areaSqm: number | null;
  areaPyeong: number | null;
  officialPrice: number | null;
  primaryUseZone: string | null;
  useZones: UseZone[];
  regulations: string[];
  roadAccess: RoadAccess | null;
  lat: number | null;
  lng: number | null;
  geomBoundary: unknown | null;
  cached: boolean;
  note?: string;
}

function classifyZone(code: string, name: string): { isPrimary: boolean } {
  const c = (code || '').toUpperCase();
  if (/^UQA[1-4]\d{2}$/.test(c) && c !== 'UQA001' && c !== 'UQA002') return { isPrimary: true };
  if (/^UQ[BC]/.test(c)) return { isPrimary: true };
  if (/(주거지역|상업지역|공업지역|녹지지역|관리지역|농림지역|자연환경보전지역)$/.test(name || '')) return { isPrimary: true };
  return { isPrimary: false };
}

async function geocode(address: string, type: string, key: string) {
  const url = `${VW_ADDR}?service=address&request=getcoord&version=2.0&crs=epsg:4326`
    + `&address=${encodeURIComponent(address)}&type=${type}&format=json&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  const p = j?.response?.result?.point;
  if (j?.response?.status !== 'OK' || !p) return null;
  return { lng: Number(p.x), lat: Number(p.y) };
}

async function cadastralByPoint(lat: number, lng: number, key: string) {
  const url = `${VW_DATA}?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN`
    + `&key=${key}&geomFilter=${encodeURIComponent(`POINT(${lng} ${lat})`)}&geometry=true&format=json&size=1&page=1&crs=EPSG:4326`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.json())?.response ?? null;
}

async function cadastralByPnu(pnu: string, key: string) {
  const url = `${VW_DATA}?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN`
    + `&key=${key}&attrFilter=pnu:=:${pnu}&geometry=true&format=json&size=1&page=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.json())?.response ?? null;
}

async function nedLandUse(pnu: string, key: string, domain: string) {
  const url = `${NED}/getLandUseAttr?key=${key}&pnu=${pnu}&format=json&numOfRows=100&domain=${encodeURIComponent(domain)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

function firstFeature(resp: any): { props: any; geom: any } | null {
  const feats = resp?.result?.featureCollection?.features;
  if (Array.isArray(feats) && feats.length > 0) {
    return { props: feats[0].properties ?? {}, geom: feats[0].geometry ?? null };
  }
  return null;
}

function ringAreaSqm(ring: number[][]): number {
  const R = 6378137;
  let total = 0;
  const n = ring.length;
  if (n < 3) return 0;
  for (let i = 0; i < n; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[(i + 1) % n];
    total += (toRad(lng2) - toRad(lng1)) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs(total * R * R / 2);
}
function toRad(d: number): number { return (d * Math.PI) / 180; }

function geomAreaSqm(geom: any): number | null {
  if (!geom) return null;
  try {
    let polys: number[][][][] = [];
    if (geom.type === 'MultiPolygon') polys = geom.coordinates;
    else if (geom.type === 'Polygon') polys = [geom.coordinates];
    else return null;
    let area = 0;
    for (const poly of polys) {
      for (let r = 0; r < poly.length; r++) {
        const a = ringAreaSqm(poly[r]);
        area += r === 0 ? a : -a;
      }
    }
    return area > 0 ? Math.round(area * 10) / 10 : null;
  } catch { return null; }
}

// ── 인접 도로(맹지) 확인 ──
// bbox로 넓게 쿼리해 도로를 놓치지 않고, 일반 필지는 거리 필터로 과포함을 막는다.
// 도로·구거·하천·제방·유지는 거리 필터 면제(맹지 오판 방지).

/** 경계 bounding box를 meters만큼 확장한 WKT */
function bboxWkt(geom: any, meters: number): string | null {
  if (!geom) return null;
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const scan = (ring: number[][]) => {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
  };
  try {
    if (geom.type === 'MultiPolygon') for (const poly of geom.coordinates) for (const r of poly) scan(r);
    else if (geom.type === 'Polygon') for (const r of geom.coordinates) scan(r);
    else return null;
  } catch { return null; }
  if (!isFinite(minLng)) return null;
  const cLat = (minLat + maxLat) / 2;
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.cos(cLat * Math.PI / 180));
  const a = minLng - dLng, b = minLat - dLat, c = maxLng + dLng, d = maxLat + dLat;
  return `POLYGON((${a} ${b}, ${c} ${b}, ${c} ${d}, ${a} ${d}, ${a} ${b}))`;
}

/** 원본 geom의 모든 외곽 링 추출(거리 계산용) */
function outerRings(geom: any): number[][][] {
  if (!geom) return [];
  try {
    if (geom.type === 'MultiPolygon') return geom.coordinates.map((p: number[][][]) => p[0]);
    if (geom.type === 'Polygon') return [geom.coordinates[0]];
  } catch { return []; }
  return [];
}

/** 두 링 간 최단거리(m) — 점↔선분 양방향 */
function ringsMinDistance(ringA: number[][], ringB: number[][], centerLat: number): number {
  const latRad = centerLat * Math.PI / 180;
  const mLat = 111320, mLng = 111320 * Math.cos(latRad);
  const toM = ([lng, lat]: number[]): number[] => [lng * mLng, lat * mLat];
  const A = ringA.map(toM), B = ringB.map(toM);
  const segDist = (p: number[], a: number[], b: number[]): number => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  let min = Infinity;
  for (const p of A) for (let i = 0; i < B.length - 1; i++) { const d = segDist(p, B[i], B[i + 1]); if (d < min) min = d; }
  for (const p of B) for (let i = 0; i < A.length - 1; i++) { const d = segDist(p, A[i], A[i + 1]); if (d < min) min = d; }
  return min;
}

function jimokOf(jibun: string): string {
  return (jibun || '').replace(/[0-9\-\s]/g, '').trim();
}

/** 토지소유정보(getPossessionAttr) 조회 → 소유구분 판별.
 *  nationInsttSeCode: "ZZ"(구분없음)=사유, 그 외 코드(01=중앙부처, 지자체 등)=국공유. */
async function fetchOwnership(pnu: string, key: string, domain: string): Promise<'gov' | 'private' | 'unknown'> {
  try {
    const url = `${NED}/getPossessionAttr?key=${key}&pnu=${pnu}&format=json&numOfRows=10&domain=${encodeURIComponent(domain)}`;
    const res = await fetch(url);
    if (!res.ok) return 'unknown';
    const j = await res.json();
    const f = j?.possessions?.field;
    const arr = Array.isArray(f) ? f : (f ? [f] : []);
    if (arr.length === 0) return 'unknown';
    // 하나라도 국가/지자체 소유(ZZ가 아님)면 국공유로 본다(진입 안전).
    const anyGov = arr.some((it: any) => it?.nationInsttSeCode && it.nationInsttSeCode !== 'ZZ');
    if (anyGov) return 'gov';
    return 'private';
  } catch { return 'unknown'; }
}

async function checkRoadAccess(geom: any, selfPnu: string | null, key: string, domain: string): Promise<RoadAccess> {
  // 쿼리는 bbox로 넓게(BBOX_M) 잡아 도로를 놓치지 않되,
  // 일반 필지는 거리 필터(ADJ_THRESHOLD_M)로 '진짜 변을 맞댄 것'만 채택해 과포함을 막는다.
  // - BBOX_M: 도로·구거가 모서리/약간 떨어져 있어도 후보로 잡히도록 넉넉히.
  // - ADJ_THRESHOLD_M: 지적 폴리곤 노드 미스매칭 오차(1~2m)는 통과시키되,
  //   폭 2~3m짜리 알박기 띠 필지(타인 소유)는 걸러내도록 2.5m로 타이트하게.
  const BBOX_M = 14;
  const ADJ_THRESHOLD_M = 2.5;
  const wkt = bboxWkt(geom, BBOX_M);
  if (!wkt) return { status: 'unknown', adjacentJimoks: [], message: '인접 필지를 확인하지 못했습니다.' };

  const selfRings = outerRings(geom);
  const centerLat = selfRings[0]?.[0]?.[1] ?? 37.5;

  const url = `${VW_DATA}?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN`
    + `&key=${key}&geomFilter=${encodeURIComponent(wkt)}&geometry=true&format=json&size=300&page=1&crs=EPSG:4326`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { status: 'unknown', adjacentJimoks: [], message: '인접 필지 조회에 실패했습니다.' };
    const j = await res.json();
    const feats = j?.response?.result?.featureCollection?.features ?? [];

    const jimoks = new Set<string>();
    const roadPnus: string[] = [];  // 소유구분 조회용 도로 PNU
    let considered = 0;
    for (const f of feats) {
      const p = f.properties ?? {};
      if (selfPnu && p.pnu === selfPnu) continue;
      const jm = jimokOf(p.jibun || '');
      if (!jm) continue;

      // 진입과 직결된 핵심 지목(도로·구거·하천·제방·유지)은 버퍼 영역에 있으면 무조건 포함.
      // 이런 지목은 폭이 있어 경계에서 다소 떨어져 보일 수 있으므로 거리 필터를 면제한다.
      // (맹지 오판 방지 — 실제 접한 도로를 거리 때문에 떨어뜨리면 안 됨)
      const isAccessKey = jm.includes('도로') || jm === '도' || jm.includes('구거') || jm === '구' || jm.includes('하천') || jm === '천' || jm.includes('제방') || jm === '제' || jm.includes('유지') || jm === '유';
      if (isAccessKey) {
        jimoks.add(jm); considered++;
        if ((jm.includes('도로') || jm === '도') && p.pnu) roadPnus.push(p.pnu);
        continue;
      }

      // 일반 필지만 거리 2차 필터: 후보 경계와 원본 경계의 최단거리가 임계 이내인지
      const candRings = outerRings(f.geometry);
      if (candRings.length === 0) {
        jimoks.add(jm); considered++;
        continue;
      }
      let near = false;
      for (const sr of selfRings) {
        for (const cr of candRings) {
          if (ringsMinDistance(sr, cr, centerLat) <= ADJ_THRESHOLD_M) { near = true; break; }
        }
        if (near) break;
      }
      if (near) { jimoks.add(jm); considered++; }
    }

    const list = [...jimoks];
    const hasRoad = list.some(j => j.includes('도로') || j === '도');
    const hasDitch = list.some(j => j.includes('구거') || j === '구' || j.includes('하천') || j === '천' || j.includes('제방') || j === '제');
    const hasReservoir = list.some(j => j.includes('유지') || j === '유');

    if (hasRoad) {
      // 접한 도로 필지의 소유구분 조회(최대 3개). 하나라도 국공유면 안심, 전부 사유면 경고.
      let roadOwnership: 'gov' | 'private' | 'mixed' | 'unknown' = 'unknown';
      let roadOwnerNote = '';
      const uniqRoads = [...new Set(roadPnus)].slice(0, 3);
      if (uniqRoads.length > 0) {
        const owns = await Promise.all(uniqRoads.map(rp => fetchOwnership(rp, key, domain)));
        const hasGov = owns.includes('gov');
        const hasPrivate = owns.includes('private');
        if (hasGov && hasPrivate) roadOwnership = 'mixed';
        else if (hasGov) roadOwnership = 'gov';
        else if (hasPrivate) roadOwnership = 'private';
        else roadOwnership = 'unknown';

        if (roadOwnership === 'gov') {
          roadOwnerNote = ' 접한 도로 중 국가·지자체 소유(국공유) 도로가 있어, 통행 동의 측면에서는 비교적 안전한 편입니다.';
        } else if (roadOwnership === 'private') {
          roadOwnerNote = ' ⚠️ 접한 도로가 모두 개인 소유(사도)로 확인됩니다. 건축 시 도로 소유자의 토지사용승낙서나 도로지분 확보가 필요할 수 있으니, 반드시 소유관계와 통행권을 확인하세요.';
        } else if (roadOwnership === 'mixed') {
          roadOwnerNote = ' 접한 도로 중 일부는 국공유, 일부는 사유로 보입니다. 실제 진입에 쓰는 도로가 어느 쪽인지 확인하세요.';
        }
      }
      return { status: 'direct_road', adjacentJimoks: list, roadOwnership, roadOwnerNote: roadOwnerNote.trim() || undefined,
        message: '인접한 땅 중에 "도로"가 있습니다. 지적도상 도로에 접해 있어 맹지가 아닐 가능성이 높습니다. 다만 그 도로가 실제 차가 다닐 수 있는 현황도로인지, 건축 가능한 폭(보통 4m 이상)인지는 현장에서 확인하세요.' + roadOwnerNote };
    }
    if (hasDitch) {
      return { status: 'ditch', adjacentJimoks: list,
        message: '인접한 땅 중에 "구거(옛 물길·도랑)"나 하천·제방이 있습니다. 구거는 점용허가를 받거나, 구거 위 도로지분·농로(다리)를 확보하면 진입로로 인정될 수 있습니다. 과거 도로 이력이나 도로지분 보유가 있으면 맹지가 아닐 수 있으니, 등기·점용 이력을 함께 확인하세요.' };
    }
    if (hasReservoir) {
      return { status: 'ditch', adjacentJimoks: list,
        message: '인접한 땅 중에 "유지(저수지·소류지 등 물이 고이는 땅)"가 있습니다. 지적도상 유지여도 오래전 매립되어 현황도로로 쓰이는 경우가 있고, 반대로 실제 물이 차 있는 경우도 있습니다. 진입로로 쓰려면 목적 외 사용승인(점용)이 필요할 수 있으니, 현황과 사용 가능 여부를 현장·지자체에서 확인하세요.' };
    }
    return { status: 'none', adjacentJimoks: list,
      message: considered > 0
        ? '바로 접한 필지 중에 "도로"는 확인되지 않았습니다. 다만 지적도에 안 나오는 현황도로(실제 사용 중인 길), 도로지분 보유, 구거 점용 등으로 진입이 가능한 경우도 많습니다. 진입 이력이 있으면 맹지가 아닐 수 있습니다.'
        : '인접 필지 정보를 충분히 얻지 못했습니다. 도로 접함 여부는 현장과 지적도에서 직접 확인하세요.' };
  } catch {
    return { status: 'unknown', adjacentJimoks: [], message: '인접 필지 조회 중 오류가 발생했습니다.' };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const KEY = Deno.env.get('VWORLD_KEY');
    if (!KEY) return j500('VWORLD_KEY_MISSING', 'VWORLD_KEY 시크릿이 없습니다.');
    const DOMAIN = Deno.env.get('VWORLD_DOMAIN') || 'b4adopt.org';

    const body = await req.json().catch(() => ({}));
    let pnu: string | null = typeof body.pnu === 'string' && /^\d{19}$/.test(body.pnu) ? body.pnu : null;
    const address: string | null = typeof body.address === 'string' ? body.address.trim() : null;
    const addressType: string = (body.addressType === 'PARCEL') ? 'PARCEL' : 'ROAD';
    if (!pnu && !address) return j400('INPUT_REQUIRED', 'pnu(19자리) 또는 address가 필요합니다.');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    if (pnu) {
      const { data: cached } = await supabase
        .from('land_lookups').select('*').eq('pnu', pnu)
        .gt('expires_at', new Date().toISOString()).maybeSingle();
      if (cached) return ok(toResult(cached, true));
    }

    let cadResp: any = null;
    let coord: { lat: number; lng: number } | null = null;
    if (pnu) {
      cadResp = await cadastralByPnu(pnu, KEY);
    } else if (address) {
      coord = await geocode(address, addressType, KEY);
      if (!coord && addressType === 'ROAD') coord = await geocode(address, 'PARCEL', KEY);
      if (!coord) return ok(empty(null, address, '주소를 좌표로 변환하지 못했습니다. 지번주소로 다시 시도해 보세요.'));
      cadResp = await cadastralByPoint(coord.lat, coord.lng, KEY);
    }

    const cad = firstFeature(cadResp);
    if (!cad) return ok(empty(pnu, address, '해당 위치의 필지를 찾지 못했습니다(NOT_FOUND).', coord));

    const cadProps = cad.props;
    const resolvedPnu: string | null = cadProps.pnu ?? pnu ?? null;
    const jimok: string | null = cadProps.jibun
      ? String(cadProps.jibun).replace(/[0-9\-\s]/g, '').trim() || null : null;
    const officialPrice: number | null = cadProps.jiga ? Number(cadProps.jiga) : null;
    const addr: string | null = cadProps.addr ?? address ?? null;

    const areaSqm = geomAreaSqm(cad.geom);
    const areaPyeong = areaSqm != null ? Math.round((areaSqm / 3.305785) * 10) / 10 : null;

    const useZones: UseZone[] = [];
    const regulations: string[] = [];
    let primaryUseZone: string | null = null;
    let nedRaw: any = null;
    if (resolvedPnu) {
      nedRaw = await nedLandUse(resolvedPnu, KEY, DOMAIN).catch(() => null);
      const fields = nedRaw?.landUses?.field ?? [];
      const arr = Array.isArray(fields) ? fields : (fields ? [fields] : []);
      for (const it of arr) {
        const name = it?.prposAreaDstrcCodeNm;
        const code = it?.prposAreaDstrcCode ?? '';
        const conflict = it?.cnflcAtNm ?? '';
        if (!name) continue;
        const { isPrimary } = classifyZone(code, name);
        useZones.push({ name: String(name), code: String(code), conflict: String(conflict), isPrimary });
        if (!primaryUseZone && isPrimary && conflict === '포함') primaryUseZone = String(name);
        if (!isPrimary) regulations.push(conflict ? `${name}(${conflict})` : String(name));
      }
      if (!primaryUseZone) {
        const p = useZones.find(z => z.isPrimary) ?? useZones[0];
        if (p) primaryUseZone = p.name;
      }
    }

    // 인접 도로(맹지) 확인 + 도로 소유구분 판별
    const roadAccess = await checkRoadAccess(cad.geom, resolvedPnu, KEY, DOMAIN).catch(() => null);

    let lat = coord?.lat ?? null;
    let lng = coord?.lng ?? null;
    const g: any = cad.geom;
    if ((!lat || !lng) && g) {
      const c = g.type === 'MultiPolygon' ? g.coordinates?.[0]?.[0]?.[0]
        : g.type === 'Polygon' ? g.coordinates?.[0]?.[0] : null;
      if (c) { lng = c[0]; lat = c[1]; }
    }

    if (resolvedPnu) {
      await supabase.from('land_lookups').upsert({
        pnu: resolvedPnu, address: addr, jimok, area_sqm: areaSqm,
        use_zone: primaryUseZone, official_price: officialPrice,
        lat, lng, geom_boundary: cad.geom,
        vworld_raw: { cadastral: cadResp },
        luris_raw: { useZones, regulations, ned: nedRaw, roadAccess },
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      });
    }

    return ok({
      pnu: resolvedPnu, address: addr, jimok, areaSqm, areaPyeong, officialPrice,
      primaryUseZone, useZones, regulations, roadAccess, lat, lng, geomBoundary: cad.geom, cached: false,
    });
  } catch (e) {
    return j500('LOOKUP_FAILED', String(e));
  }
});

function empty(pnu: string | null, address: string | null, note: string, coord?: { lat: number; lng: number } | null): LandResult {
  return {
    pnu, address, jimok: null, areaSqm: null, areaPyeong: null, officialPrice: null,
    primaryUseZone: null, useZones: [], regulations: [], roadAccess: null,
    lat: coord?.lat ?? null, lng: coord?.lng ?? null, geomBoundary: null, cached: false, note,
  };
}
function toResult(row: any, cached: boolean): LandResult {
  const areaSqm = row.area_sqm;
  return {
    pnu: row.pnu, address: row.address, jimok: row.jimok, areaSqm,
    areaPyeong: areaSqm != null ? Math.round((areaSqm / 3.305785) * 10) / 10 : null,
    officialPrice: row.official_price,
    primaryUseZone: row.use_zone,
    useZones: Array.isArray(row.luris_raw?.useZones) ? row.luris_raw.useZones : [],
    regulations: Array.isArray(row.luris_raw?.regulations) ? row.luris_raw.regulations : [],
    roadAccess: row.luris_raw?.roadAccess ?? null,
    lat: row.lat, lng: row.lng, geomBoundary: row.geom_boundary, cached,
  };
}
function ok(r: LandResult) {
  return new Response(JSON.stringify(r), { headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function j400(error: string, message: string) {
  return new Response(JSON.stringify({ error, message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function j500(error: string, message: string) {
  return new Response(JSON.stringify({ error, message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
