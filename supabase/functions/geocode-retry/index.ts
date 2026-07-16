// MapOn: 지오코딩 최종 회수 EF — 주소검색 실패분을 브이월드 지명(POI)검색으로 재시도.
// 1) 시설명 지명검색(search API, type=place) 2) 시군구+시설명 3) 주소 지명검색
// 입력: { limit? }. 회수 실패 행은 그대로 둗(좌표 null, 조회 제외).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const VW_SEARCH = 'https://api.vworld.kr/req/search';

function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function poi(query: string, key: string, domain: string): Promise<{lat:number,lng:number}|null> {
  const url = `${VW_SEARCH}?service=search&request=search&version=2.0&crs=epsg:4326&size=5&page=1`
    + `&query=${encodeURIComponent(query)}&type=place&format=json&errorformat=json&key=${key}&domain=${encodeURIComponent(domain)}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    const items = j?.response?.result?.items;
    if (Array.isArray(items) && items.length) {
      const p = items[0]?.point;
      const lng = Number(p?.x), lat = Number(p?.y);
      if (Number.isFinite(lat) && Number.isFinite(lng) && lat>32 && lat<40 && lng>124 && lng<132) return { lat, lng };
    }
  } catch (_e) { /* noop */ }
  return null;
}

// 시설명 정제: 괄호·법인격 접두사 제거
 function cleanName(n: string): string {
  return n.replace(/^\(재\)|^\(사\)|^재\)|^재단법인\s*/g,'').replace(/\([^)]*\)/g,' ').replace(/\s{2,}/g,' ').trim();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const limit = Number(body.limit) > 0 ? Math.min(Number(body.limit), 200) : 100;
    const KEY = Deno.env.get('VWORLD_KEY');
    if (!KEY) return json({ error: 'no_vworld_key' }, 400);
    const DOMAIN = Deno.env.get('VWORLD_DOMAIN') || 'b4adopt.org';
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data, error } = await sb.from('hazard_facilities')
      .select('id, name, address, sido, sigungu').is('lat', null).neq('address','').limit(limit);
    if (error) return json({ error: 'db', message: error.message }, 500);
    if (!data || !data.length) return json({ ok: true, processed: 0, recovered: 0, remaining: 0 });

    let recovered = 0;
    for (const row of data) {
      const nm = cleanName(String(row.name||''));
      const sig = String(row.sigungu||'').trim();
      const sido = String(row.sido||'').trim();
      const addr = String(row.address||'').trim();
      // 후보 쿼리 순서: 시군구+시설명 → 시도+시설명 → 시설명 → 주소
      const queries = [ `${sig} ${nm}`.trim(), `${sido} ${nm}`.trim(), nm, addr ];
      let hit: {lat:number,lng:number}|null = null;
      for (const q of queries) { if (!q) continue; hit = await poi(q, KEY, DOMAIN); if (hit) break; }
      if (hit) { await sb.from('hazard_facilities').update({ lat:hit.lat, lng:hit.lng }).eq('id', row.id); recovered++; }
    }
    const { count } = await sb.from('hazard_facilities').select('id',{count:'exact',head:true}).is('lat',null).neq('address','');
    return json({ ok: true, processed: data.length, recovered, remaining: count ?? 0 });
  } catch (e) {
    return json({ error: 'unexpected', message: e instanceof Error ? e.message : String(e) }, 500);
  }
});
