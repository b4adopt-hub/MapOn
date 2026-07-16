// MapOn: 주소기반 혐오시설 적재 Edge Function (장사시설 등). 좌표없이 upsert 후 geocoded=false.
// 입력: { rows: [{type,name,address,sido,sigungu}], source }
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const source = typeof body.source === 'string' ? body.source : '장사시설';
    if (!rows.length) return json({ error: 'no_rows' }, 400);

    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const seen = new Set<string>();
    const recs = [];
    let dup = 0;
    for (const r of rows) {
      const type = String(r.type || '').trim();
      const name = String(r.name || '').trim();
      const address = String(r.address || '').trim();
      if (!type || !name || !address) continue;
      const srcKey = `jangsa:${type}:${name}:${address}`.slice(0, 300);
      if (seen.has(srcKey)) { dup++; continue; }
      seen.add(srcKey);
      recs.push({
        type, name, address,
        sido: String(r.sido || '').trim() || null,
        sigungu: String(r.sigungu || '').trim() || null,
        source, src_key: srcKey, geocoded: false,
      });
    }

    if (!recs.length) return json({ ok: true, inserted: 0, dup });
    const { error } = await sb.from('hazard_facilities').upsert(recs, { onConflict: 'src_key', ignoreDuplicates: true });
    if (error) return json({ error: 'db', message: error.message }, 500);
    return json({ ok: true, inserted: recs.length, dup });
  } catch (e) {
    return json({ error: 'unexpected', message: e instanceof Error ? e.message : String(e) }, 500);
  }
});
