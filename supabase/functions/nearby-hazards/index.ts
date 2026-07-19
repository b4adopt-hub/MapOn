// MapOn: 주변 혐오·기피시설 반경 조회 Edge Function (v2)
// 입력: { lat, lng }
// 흐름:
//   1) hazard_facilities DB 조회(폐기물·장사시설 등 적재분)
//   2) 카카오 로컬 키워드 검색으로 축사·목장 실시간 보강(전국 공개데이터가 없는 유형)
//      — category_name에 '축산업'이 포함된 것만 채택해 정육점·식당 오탐 제거
//   3) 중복 제거(이름 유사 + 150m 이내) 후 거리순 반환
// 카카오 키/호출 실패해도 DB 결과는 그대로 나간다.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TIERS: Record<string, { reach: number; label: string }> = {
  nuclear:     { reach: 5000, label: '원자력·발전시설' },
  landfill:    { reach: 2000, label: '쓰레기매립장' },
  incinerator: { reach: 2000, label: '소각장' },
  wastewater:  { reach: 1500, label: '분뇨·오폐수처리장' },
  waste:       { reach: 1500, label: '폐기물처리시설' },
  crematory:   { reach: 2000, label: '화장장' },
  cemetery:    { reach: 1500, label: '공동묘지' },
  columbarium: { reach: 1000, label: '봉안당·납골당' },
  funeral:     { reach: 1000, label: '장례식장' },
  prison:      { reach: 2000, label: '교정시설' },
  powerline:   { reach: 500,  label: '고압송전탑·송전선로' },
  fuel:        { reach: 1000, label: '유류·가스저장소' },
  military:    { reach: 2000, label: '군사시설' },
  livestock:   { reach: 700,  label: '축사·목장(가축분뇨)' },
  isolation:   { reach: 1000, label: '격리병원' },
};

const MAX_REACH = 5000;
// 카카오 보강 대상: 공개데이터에 위치가 없는 유형(축사)만.
const KAKAO_KEYWORDS = ['목장', '축사', '농장', '축산'];
const KAKAO_CAT_MUST = '축산업'; // category_name에 이게 있어야 축사로 인정

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function normName(s: string): string {
  return (s || '').replace(/\s|\(.*?\)|주식회사|\(주\)|농장|목장|축사/g, '').trim();
}

// 카카오 로컬 키워드 검색으로 축사·목장 수집(실패하면 빈 배열)
async function fetchKakaoLivestock(lat: number, lng: number, reach: number) {
  const key = Deno.env.get('KAKAO_REST_KEY') || Deno.env.get('KAKAO_REST_API_KEY') || '';
  if (!key) return [];
  const out: { name: string; lat: number; lng: number; distanceM: number }[] = [];
  const seen = new Set<string>();
  for (const kw of KAKAO_KEYWORDS) {
    const url = `https://dapi.kakao.com/v2/local/search/keyword.json`
      + `?query=${encodeURIComponent(kw)}&x=${lng}&y=${lat}&radius=${reach}&size=15&sort=distance`;
    try {
      const r = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` } });
      if (r.status !== 200) continue;
      const j = await r.json();
      for (const d of (j.documents || [])) {
        const cat = String(d.category_name || '');
        if (!cat.includes(KAKAO_CAT_MUST)) continue; // 축산업 카테고리만
        const nm = String(d.place_name || '').trim();
        const y = Number(d.y), x = Number(d.x);
        if (!nm || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        const k = `${nm}@${x.toFixed(4)},${y.toFixed(4)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const dist = Number(d.distance);
        out.push({ name: nm, lat: y, lng: x, distanceM: Number.isFinite(dist) ? dist : Math.round(haversineM(lat, lng, y, x)) });
      }
    } catch (_e) { /* 개별 키워드 실패는 무시 */ }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { lat, lng } = await req.json().catch(() => ({}));
    if (typeof lat !== 'number' || typeof lng !== 'number') return json({ hazards: [] });

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const dLat = MAX_REACH / 111000;
    const dLng = MAX_REACH / (111000 * Math.cos((lat * Math.PI) / 180) || 1);

    const [dbRes, kakaoRes] = await Promise.all([
      sb.from('hazard_facilities').select('type, name, lat, lng')
        .gte('lat', lat - dLat).lte('lat', lat + dLat)
        .gte('lng', lng - dLng).lte('lng', lng + dLng).limit(500),
      fetchKakaoLivestock(lat, lng, TIERS.livestock.reach),
    ]);

    const hazards: { type: string; typeLabel: string; name: string | null; distanceM: number; lat?: number; lng?: number }[] = [];
    const data = Array.isArray(dbRes?.data) ? dbRes.data : [];
    for (const f of data) {
      const tier = TIERS[f.type];
      if (!tier) continue;
      const d = haversineM(lat, lng, f.lat, f.lng);
      if (d > tier.reach) continue;
      hazards.push({ type: f.type, typeLabel: tier.label, name: f.name ?? null, distanceM: Math.round(d), lat: f.lat, lng: f.lng });
    }

    // 카카오 축사 병합 — DB에 이미 있는 건(이름 유사 + 150m 이내)은 제외
    const existing = hazards.filter(h => h.type === 'livestock');
    for (const k of kakaoRes) {
      const dup = existing.some(e =>
        (e.lat != null && e.lng != null && haversineM(e.lat, e.lng, k.lat, k.lng) < 150) ||
        (e.name && normName(e.name) && normName(e.name) === normName(k.name))
      );
      if (dup) continue;
      hazards.push({ type: 'livestock', typeLabel: TIERS.livestock.label, name: k.name, distanceM: Math.round(k.distanceM) });
    }

    hazards.sort((a, b) => a.distanceM - b.distanceM);
    return json({ hazards: hazards.map(({ lat: _a, lng: _b, ...rest }) => rest) });
  } catch (_e) {
    return json({ hazards: [] });
  }
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { ...CORS, 'Content-Type': 'application/json' } });
}
