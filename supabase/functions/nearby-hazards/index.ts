// MapOn: 주변 혐오·기피시설 반경 조회 Edge Function (v1)
// 입력: { lat, lng }  (land-lookup이 준 필지 중심 좌표) — pnu는 로깅용(선택)
// 흐름:
//   1) 좌표 없으면 빈 배열 반환(영향 없음 취급)
//   2) hazard_facilities에서 bbox(약 5km) 1차 필터로 후보 조회
//   3) Haversine 정밀거리 계산 → 각 시설 type의 최대 영향반경 이내만 채택
//   4) 거리순 정렬해 반환 { hazards: [{type,typeLabel,name,distanceM}] }
// 시설 DB는 공공데이터 적재 대상(hazard_facilities). 데이터가 없으면 빈 배열.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// 프런트 landScore HAZARD_TIERS와 동일 기준(라벨·최대 영향반경 m).
// EF에서 반경 밖 시설을 미리 걸러 응답을 가볍게 한다.
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

const MAX_REACH = 5000; // bbox 1차 필터 반경(m)

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { lat, lng } = await req.json().catch(() => ({}));

    // 좌표 없으면 조회 불가 → 빈 배열(영향 없음 취급)
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return json({ hazards: [] });
    }

    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const sb = createClient(url, key);

    // bbox 1차 필터(약 5km). 위도 1도≈111km, 경도 1도≈111km*cos(lat).
    const dLat = MAX_REACH / 111000;
    const dLng = MAX_REACH / (111000 * Math.cos((lat * Math.PI) / 180) || 1);

    const { data, error } = await sb
      .from('hazard_facilities')
      .select('type, name, lat, lng')
      .gte('lat', lat - dLat)
      .lte('lat', lat + dLat)
      .gte('lng', lng - dLng)
      .lte('lng', lng + dLng)
      .limit(500);

    if (error || !Array.isArray(data)) return json({ hazards: [] });

    const hazards = [];
    for (const f of data) {
      const tier = TIERS[f.type];
      if (!tier) continue;
      const d = haversineM(lat, lng, f.lat, f.lng);
      if (d > tier.reach) continue; // 시설별 영향 반경 밖 제외
      hazards.push({
        type: f.type,
        typeLabel: tier.label,
        name: f.name ?? null,
        distanceM: Math.round(d),
      });
    }
    hazards.sort((a, b) => a.distanceM - b.distanceM);
    return json({ hazards });
  } catch (_e) {
    return json({ hazards: [] });
  }
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
