// MapOn: 주소→좌표 지오코딩 EF. geocoded=false 행을 배치로 채운다.
// 브이월드 주소검색(land-lookup과 동일). ROAD → PARCEL → 괄호제거 폴백. 실패/빈주소는 geocoded=true로 마킹(좌표 null).
// 입력: { limit?, type? }. 응답 remaining>0면 다시 호출.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const VW_ADDR = 'https://api.vworld.kr/req/address';

function json(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function geocode(address: string, type: string, key: string, domain: string): Promise<{lat:number,lng:number}|null> {
  const url = `${VW_ADDR}?service=address&request=getcoord&version=2.0&crs=epsg:4326`
    + `&address=${encodeURIComponent(address)}&type=${type}&format=json&key=${key}&domain=${encodeURIComponent(domain)}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    const p = j?.response?.result?.point;
    if (p && p.x && p.y) {
      const lng = Number(p.x), lat = Number(p.y);
      if (Number.isFinite(lat) && Number.isFinite(lng) && lat>32 && lat<40 && lng>124 && lng<132) return { lat, lng };
    }
  } catch (_e) { /* noop */ }
  return null;
}

function clean(addr: string): string {
  let a = addr.replace(/\([^)]*\)/g, ' ');
  a = a.replace(/\s{2,}/g, ' ').trim();
  return a;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const limit = Number(body.limit) > 0 ? Math.min(Number(body.limit), 200) : 100;
    const filterType = typeof body.type === 'string' ? body.type : null;

    const KEY = Deno.env.get('VWORLD_KEY');
    if (!KEY) return json({ error: 'no_vworld_key' }, 400);
    const DOMAIN = Deno.env.get('VWORLD_DOMAIN') || 'b4adopt.org';
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    let q = sb.from('hazard_facilities').select('id, address, type').eq('geocoded', false).limit(limit);
    if (filterType) q = q.eq('type', filterType);
    const { data, error } = await q;
    if (error) return json({ error: 'db', message: error.message }, 500);
    if (!data || !data.length) return json({ ok: true, processed: 0, updated: 0, failed: 0, remaining: 0 });

    let updated = 0, failed = 0;
    for (const row of data) {
      const raw = String(row.address || '').trim();
      // 빈 주소: 좌표 불가 — 반드시 geocoded=true로 마킹해 재추출 방지(무한루프 방지)
      if (!raw) {
        await sb.from('hazard_facilities').update({ geocoded: true }).eq('id', row.id);
        failed++; continue;
      }
      let c = await geocode(raw, 'ROAD', KEY, DOMAIN);
      if (!c) c = await geocode(raw, 'PARCEL', KEY, DOMAIN);
      if (!c) { const cl = clean(raw); if (cl !== raw) { c = await geocode(cl, 'ROAD', KEY, DOMAIN) || await geocode(cl, 'PARCEL', KEY, DOMAIN); } }
      if (!c) {
        await sb.from('hazard_facilities').update({ geocoded: true }).eq('id', row.id);
        failed++; continue;
      }
      await sb.from('hazard_facilities').update({ lat: c.lat, lng: c.lng, geocoded: true }).eq('id', row.id);
      updated++;
    }

    const { count } = await sb.from('hazard_facilities').select('id', { count: 'exact', head: true }).eq('geocoded', false);
    return json({ ok: true, processed: data.length, updated, failed, remaining: count ?? 0 });
  } catch (e) {
    return json({ error: 'unexpected', message: e instanceof Error ? e.message : String(e) }, 500);
  }
});
