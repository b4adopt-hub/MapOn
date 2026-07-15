// etl-ingest: 관리자 파일업로드 기반 대량 적재 (permitted_uses 또는 zoning_rates)
// 클라이언트(관리자모드 Web Worker)가 eum.go.kr xlsx를 브라우저에서 파싱해
// 배치(JSON 배열)로 전송하면, service role로 검증·절단·삽입한다.
// 행위제한정보→permitted_uses, 법령정보(건폐율·용적율)→zoning_rates. 두 테이블은 서로 독립적(삭제 경합 없음).
// actions: start | batch | finish | fail
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MAX_BATCH_ROWS = 2500;

// 테이블별 설정: 리셋 RPC, 컬럼 순서(배치 배열 인덱스), 필수 컬럼 검증기
interface TableCfg {
  reset: string;
  cols: string[];
  build: (r: unknown[], month: string) => Record<string, unknown> | null;
}

function s(v: unknown, max: number): string { return String(v ?? '').trim().slice(0, max); }
function numOrNull(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function dateOrNull(v: unknown): string | null {
  const t = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}
function boolOf(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

const TABLES: Record<string, TableCfg> = {
  permitted_uses: {
    reset: 'etl_reset_permitted_uses',
    cols: ['sgg_code', 'sgg_name', 'zone_nm', 'law_name', 'land_use', 'decision', 'condition_note', 'is_ordinance'],
    // [sgg_code, sgg_name, zone_nm, law_name, land_use, decision, condition_note, is_ordinance]
    build: (r, month) => {
      if (!Array.isArray(r) || r.length < 8) return null;
      const code = s(r[0], 20);
      const landUse = s(r[4], 300);
      if (!code || !landUse) return null;
      return {
        sgg_code: code,
        sgg_name: s(r[1], 100),
        zone_nm: s(r[2], 200),
        law_name: s(r[3], 300),
        land_use: landUse,
        decision: s(r[5], 200),
        condition_note: s(r[6], 2000),
        is_ordinance: boolOf(r[7]),
        src_month: month,
      };
    },
  },
  zoning_rates: {
    reset: 'etl_reset_zoning_rates',
    cols: ['sgg_code', 'zone_cd', 'zone_nm', 'rate_kind', 'category', 'rate_pct', 'rate_values', 'ordinance', 'provision', 'enforce_dt', 'content', 'needs_review'],
    // [sgg_code, zone_cd, zone_nm, rate_kind, category, rate_pct, rate_values, ordinance, provision, enforce_dt, content, needs_review]
    build: (r, month) => {
      if (!Array.isArray(r) || r.length < 12) return null;
      const code = s(r[0], 20);
      const zoneCd = s(r[1], 20);
      if (!code || !zoneCd) return null;
      return {
        sgg_code: code,
        zone_cd: zoneCd,
        zone_nm: s(r[2], 200),
        rate_kind: s(r[3], 10),
        category: s(r[4], 20),
        rate_pct: numOrNull(r[5]),
        rate_values: s(r[6], 200),
        ordinance: s(r[7], 200),
        provision: s(r[8], 100),
        enforce_dt: dateOrNull(r[9]),
        content: s(r[10], 2000),
        needs_review: boolOf(r[11]),
        src_month: month,
      };
    },
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // 1) 로그인 사용자 확인
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
  const uid = userData.user.id;

  // 2) 관리자 확인 (service role로 profiles 조회)
  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: prof } = await svc.from('profiles').select('role').eq('id', uid).maybeSingle();
  if ((prof as { role?: string } | null)?.role !== 'admin') {
    return json({ error: 'forbidden: admin only' }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const action = String(body.action ?? '');
  const table = String(body.table ?? 'permitted_uses');
  const cfg = TABLES[table];
  if (!cfg) return json({ error: 'unknown table: ' + table }, 400);

  try {
    if (action === 'start') {
      const month = String(body.src_month ?? '');
      if (!/^\d{6}$/.test(month)) return json({ error: 'src_month must be YYYYMM' }, 400);
      // 같은 테이블·같은 월만 삭제 후 재적재(멱등). 다른 테이블은 절대 건들지 않음.
      const { data: deleted, error: delErr } = await svc.rpc(cfg.reset, { p_month: month });
      if (delErr) return json({ error: 'reset failed: ' + delErr.message }, 500);
      await svc.from('etl_jobs')
        .update({ status: 'canceled', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('table_name', table).eq('src_month', month).eq('status', 'running');
      const { data: job, error: jobErr } = await svc.from('etl_jobs').insert({
        table_name: table,
        src_month: month,
        file_name: s(body.file_name, 300) || null,
        deleted_rows: Number(deleted ?? 0),
        created_by: uid,
      }).select('id').single();
      if (jobErr) return json({ error: 'job create failed: ' + jobErr.message }, 500);
      return json({ job_id: (job as { id: string }).id, deleted: Number(deleted ?? 0) });
    }

    if (action === 'batch') {
      const jobId = String(body.job_id ?? '');
      const month = String(body.src_month ?? '');
      const rows = body.rows;
      if (!jobId || !/^\d{6}$/.test(month)) return json({ error: 'job_id/src_month required' }, 400);
      if (!Array.isArray(rows) || rows.length === 0) return json({ error: 'rows required' }, 400);
      if (rows.length > MAX_BATCH_ROWS) return json({ error: `max ${MAX_BATCH_ROWS} rows per batch` }, 400);
      const { data: job } = await svc.from('etl_jobs').select('status, src_month, table_name').eq('id', jobId).maybeSingle();
      const j = job as { status?: string; src_month?: string; table_name?: string } | null;
      if (!j || j.status !== 'running' || j.src_month !== month || j.table_name !== table) {
        return json({ error: 'job not running' }, 409);
      }
      const objs: Record<string, unknown>[] = [];
      for (const r of rows as unknown[][]) {
        const o = cfg.build(r, month);
        if (o) objs.push(o);
      }
      if (objs.length > 0) {
        const { error: insErr } = await svc.from(table).insert(objs);
        if (insErr) return json({ error: 'insert failed: ' + insErr.message }, 500);
      }
      const { data: progressed } = await svc.rpc('etl_job_progress', { p_job: jobId, p_add: objs.length });
      return json({ inserted: objs.length, skipped: rows.length - objs.length, total_inserted: Number(progressed ?? 0) });
    }

    if (action === 'finish') {
      const jobId = String(body.job_id ?? '');
      const month = String(body.src_month ?? '');
      if (!jobId || !/^\d{6}$/.test(month)) return json({ error: 'job_id/src_month required' }, 400);
      const { count, error: cntErr } = await svc.from(table)
        .select('id', { count: 'exact', head: true }).eq('src_month', month);
      if (cntErr) return json({ error: 'count failed: ' + cntErr.message }, 500);
      const now = new Date().toISOString();
      const { error: updErr } = await svc.from('etl_jobs').update({
        status: 'done', total_rows: count ?? 0, finished_at: now, updated_at: now,
      }).eq('id', jobId).eq('status', 'running');
      if (updErr) return json({ error: 'finish failed: ' + updErr.message }, 500);
      return json({ done: true, total_rows: count ?? 0 });
    }

    if (action === 'fail') {
      const jobId = String(body.job_id ?? '');
      const now = new Date().toISOString();
      await svc.from('etl_jobs').update({
        status: 'failed', error: s(body.error, 2000) || null, finished_at: now, updated_at: now,
      }).eq('id', jobId).eq('status', 'running');
      return json({ ok: true });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
