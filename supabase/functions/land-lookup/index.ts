// MapOn: 토지 조회 Edge Function (v6 - 인접 도로(맹지) 자동 확인 추가)
// 입력: { pnu } 또는 { address, addressType }
// 흐름:
//   1) 주소→getcoord 좌표→연속지적도 역조회→PNU 확정 (또는 PNU 직접)
//   2) 면적: 경계 폴리곤에서 측지면적 직접 계산
//   3) 공시지가: 지적도 jiga
//   4) 용도지역/규제: NED getLandUseAttr
//   5) 인접 도로 확인: 경계 주변 공간쿼리로 접한 필지 지목 분석(도로/구거 판정)
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
function bboxFromGeom(geom: any, padDeg: number): string | null {
  if (!geom) return null;
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const scan = (ring: number[][]) => {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
  };
  try {
    if (geom.type === 'MultiPolygon') for (const poly of geom.coordinates) for (const ring of poly) scan(ring);
    else if (geom.type === 'Polygon') for (const ring of geom.coordinates) scan(ring);
    else return null;
  } catch { return null; }
  if (!isFinite(minLng)) return null;
  const a = minLng - padDeg, b = minLat - padDeg, c = maxLng + padDeg, d = maxLat + padDeg;
  return `POLYGON((${a} ${b}, ${c} ${b}, ${c} ${d}, ${a} ${d}, ${a} ${b}))`;
}

function jimokOf(jibun: string): string {
  return (jibun || '').replace(/[0-9\-\s]/g, '').trim();
}

async function checkRoadAccess(geom: any, selfPnu: string | null, key: string): Promise<RoadAccess> {
  const bbox = bboxFromGeom(geom, 0.00012);
  if (!bbox) return { status: 'unknown', adjacentJimoks: [], message: '인접 필지를 확인하지 못했습니다.' };
  const url = `${VW_DATA}?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN`
    + `&key=${key}&geomFilter=${encodeURIComponent(bbox)}&geometry=false&format=json&size=200&page=1&crs=EPSG:4326`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { status: 'unknown', adjacentJimoks: [], message: '인접 필지 조회에 실패했습니다.' };
    const j = await res.json();
    const feats = j?.response?.result?.featureCollection?.features ?? [];
    const jimoks = new Set<string>();
    for (const f of feats) {
      const p = f.properties ?? {};
      if (selfPnu && p.pnu === selfPnu) continue;
      const jm = jimokOf(p.jibun || '');
      if (jm) jimoks.add(jm);
    }
    const list = [...jimoks];
    const hasRoad = list.some(j => j.includes('도로') || j === '도');
    const hasDitch = list.some(j => j.includes('구거') || j === '구' || j.includes('하천') || j.includes('제방'));

    if (hasRoad) {
      return { status: 'direct_road', adjacentJimoks: list,
        message: '인접한 땅 중에 "도로"가 있습니다. 지적도상 도로에 접해 있어 맹지가 아닐 가능성이 높습니다. 다만 그 도로가 실제 차가 다닐 수 있는 현황도로인지, 건축 가능한 폭(보통 4m 이상)인지는 현장에서 확인하세요.' };
    }
    if (hasDitch) {
      return { status: 'ditch', adjacentJimoks: list,
        message: '인접한 땅 중에 "구거(옛 물길·도랑)"나 하천·제방이 있습니다. 구거는 점용허가를 받거나, 구거 위 도로지분·농로(다리)를 확보하면 진입로로 인정될 수 있습니다. 과거 도로 이력이나 도로지분 보유가 있으면 맹지가 아닐 수 있으니, 등기·점용 이력을 함께 확인하세요.' };
    }
    return { status: 'none', adjacentJimoks: list,
      message: '지적도상 바로 접한 "도로" 필지는 확인되지 않았습니다. 다만 지적도에 안 나오는 현황도로(실제 사용 중인 길), 도로지분 보유, 구거 점용 등으로 진입이 가능한 경우도 많습니다. 진입 이력이 있으면 맹지가 아닐 수 있습니다.' };
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

    // 인접 도로(맹지) 확인
    const roadAccess = await checkRoadAccess(cad.geom, resolvedPnu, KEY).catch(() => null);

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
