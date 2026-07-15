// 관리자 데이터 적재 탭: eum.go.kr 파일(행위제한정보/법령정보) 업로드 → 브라우저 파싱 →
// etl-ingest Edge Function 배치 전송. 파일 종류를 자동 판별해 올바른 테이블로 적재한다.
//  - 행위제한정보 → permitted_uses,  법령정보(건폐율·용적률) → zoning_rates
// 두 테이블은 독립적이라 서로 삭제하지 않는다. 여러 파일을 한 번에 올려 각각 적재할 수 있다.
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import type { EtlRow, EtlTable, FromWorker } from './parseEum.worker';

interface JobRow {
  id: string;
  table_name: string;
  src_month: string;
  status: string;
  file_name: string | null;
  total_rows: number | null;
  inserted_rows: number;
  deleted_rows: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

const TABLE_LABEL: Record<string, string> = {
  permitted_uses: '행위제한',
  zoning_rates: '건폐율·용적률',
};

// eum 월별 파일 공개 주기(매월 중순) 기준 기대 월: 18일 이후면 당월, 이전이면 전월
export function expectedEumMonth(now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  let y = kst.getUTCFullYear();
  let m = kst.getUTCMonth() + 1;
  if (kst.getUTCDate() < 18) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
  return `${y}${String(m).padStart(2, '0')}`;
}

// 두 테이블 모두 최신 월이 적재됐는지 (하나라도 뒤처지면 stale)
export async function fetchLoadedMonths(): Promise<{ permitted: string | null; zoning: string | null }> {
  if (!supabase) return { permitted: null, zoning: null };
  const q = async (t: string) => {
    const { data } = await supabase!
      .from('etl_jobs').select('src_month')
      .eq('status', 'done').eq('table_name', t)
      .order('src_month', { ascending: false }).limit(1).maybeSingle();
    return (data as { src_month?: string } | null)?.src_month ?? null;
  };
  return { permitted: await q('permitted_uses'), zoning: await q('zoning_rates') };
}

const STATUS_LABEL: Record<string, string> = {
  running: '진행중', done: '완료', failed: '실패', canceled: '취소',
};

type Phase = 'idle' | 'running' | 'done' | 'error';

interface Progress {
  fileName: string;
  table: EtlTable | null;
  sheetsDone: number;
  sheetsTotal: number;
  rowsParsed: number;
  rowsInserted: number;
  batchesSent: number;
  retries: number;
}

function zeroProg(fileName: string): Progress {
  return { fileName, table: null, sheetsDone: 0, sheetsTotal: 0, rowsParsed: 0, rowsInserted: 0, batchesSent: 0, retries: 0 };
}

async function invokeIngest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!supabase) throw new Error('Supabase 미연결');
  const { data, error } = await supabase.functions.invoke('etl-ingest', { body });
  if (error) {
    const resp = (error as { context?: Response }).context;
    if (resp) {
      try {
        const j = await resp.json();
        throw new Error(String((j as { error?: string }).error ?? error.message));
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
      }
    }
    throw new Error(error.message);
  }
  return (data ?? {}) as Record<string, unknown>;
}

async function sendBatchWithRetry(
  table: EtlTable, jobId: string, month: string, rows: EtlRow[], onRetry: () => void,
): Promise<number> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await invokeIngest({ action: 'batch', table, job_id: jobId, src_month: month, rows });
      return Number(r.inserted ?? 0);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (/job not running|forbidden|unauthorized/.test(lastErr.message)) throw lastErr;
      onRetry();
      await new Promise((res) => setTimeout(res, attempt * 1500));
    }
  }
  throw lastErr ?? new Error('배치 전송 실패');
}

export default function EtlTab() {
  const [files, setFiles] = useState<File[]>([]);
  const [month, setMonth] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [prog, setProg] = useState<Progress | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [counts, setCounts] = useState<{ pu: number | null; zr: number | null }>({ pu: null, zr: null });
  const cancelRef = useRef(false);
  const workerRef = useRef<Worker | null>(null);

  async function loadJobs() {
    if (!supabase) return;
    const { data } = await supabase
      .from('etl_jobs')
      .select('id,table_name,src_month,status,file_name,total_rows,inserted_rows,deleted_rows,error,created_at,finished_at')
      .order('created_at', { ascending: false })
      .limit(20);
    setJobs((data ?? []) as JobRow[]);
    const pu = await supabase.from('permitted_uses').select('id', { count: 'exact', head: true });
    const zr = await supabase.from('zoning_rates').select('id', { count: 'exact', head: true });
    setCounts({ pu: pu.count ?? null, zr: zr.count ?? null });
  }
  useEffect(() => { void loadJobs(); }, []);

  function pickFiles(list: FileList | null) {
    const arr = list ? Array.from(list) : [];
    setFiles(arr);
    setMsg(null);
    for (const f of arr) {
      const m = /20\d{4}/.exec(f.name);
      if (m) { setMonth(m[0]); break; }
    }
  }

  function stop(reason: string) {
    cancelRef.current = true;
    workerRef.current?.terminate();
    workerRef.current = null;
    setPhase('error');
    setMsg(reason);
  }

  // 한 파일을 파싱·적재한다. 워커가 종류를 판별해 테이블을 알려주면 그 테이블로 보낸다.
  async function processFile(file: File): Promise<{ table: EtlTable; total: number }> {
    const buffer = await file.arrayBuffer();
    const worker = new Worker(new URL('./parseEum.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    // 워커의 meta 메시지로 테이블 확정 → start 호출 → 배치 전송
    let table: EtlTable | null = null;
    let jobId = '';
    let started = false;
    const CONCURRENCY = 3;
    let inFlight = 0;
    const queue: EtlRow[][] = [];
    let workerDone = false;
    let fatal: Error | null = null;
    let resolveAll: (() => void) | null = null;
    const allSent = new Promise<void>((res) => { resolveAll = res; });

    const pump = () => {
      if (fatal || cancelRef.current) { if (inFlight === 0 && resolveAll) resolveAll(); return; }
      if (!started || !table || !jobId) return;
      while (inFlight < CONCURRENCY && queue.length > 0) {
        const rows = queue.shift()!;
        inFlight++;
        void sendBatchWithRetry(table, jobId, month, rows, () =>
          setProg((p) => (p ? { ...p, retries: p.retries + 1 } : p)))
          .then((inserted) => {
            setProg((p) => (p ? { ...p, rowsInserted: p.rowsInserted + inserted, batchesSent: p.batchesSent + 1 } : p));
            worker.postMessage({ type: 'ack' });
          })
          .catch((e) => { fatal = e instanceof Error ? e : new Error(String(e)); })
          .finally(() => { inFlight--; pump(); });
      }
      if (workerDone && queue.length === 0 && inFlight === 0 && resolveAll) resolveAll();
    };

    const parsedInfo = await new Promise<{ rowsParsed: number; filtered: number }>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.type === 'meta') {
          table = m.table;
          setProg((p) => (p ? { ...p, table: m.table } : p));
          // 테이블 확정 후 작업 시작(삭제→job 생성)
          void invokeIngest({ action: 'start', table: m.table, src_month: month, file_name: file.name })
            .then((r) => {
              jobId = String(r.job_id ?? '');
              if (!jobId) { fatal = new Error('작업 생성 실패'); return; }
              started = true;
              const deleted = Number(r.deleted ?? 0);
              if (deleted > 0) setMsg(`${TABLE_LABEL[m.table]} ${month} 기존 ${deleted.toLocaleString()}행 삭제 후 재적재`);
              pump();
            })
            .catch((e) => { fatal = e instanceof Error ? e : new Error(String(e)); });
        } else if (m.type === 'batch') { queue.push(m.rows); pump(); }
        else if (m.type === 'progress') setProg((p) => (p ? { ...p, sheetsDone: m.sheetsDone, sheetsTotal: m.sheetsTotal, rowsParsed: m.rowsParsed } : p));
        else if (m.type === 'done') { workerDone = true; pump(); resolve({ rowsParsed: m.rowsParsed, filtered: m.filtered }); }
        else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || '워커 오류'));
      worker.postMessage({ type: 'start', buffer, fileName: file.name }, [buffer]);
    });

    await allSent;
    worker.terminate();
    workerRef.current = null;
    if (fatal) throw fatal;
    if (cancelRef.current) throw new Error('사용자 취소');
    if (!table || !jobId) throw new Error('테이블 판별 실패');

    const fin = await invokeIngest({ action: 'finish', table, job_id: jobId, src_month: month });
    void parsedInfo;
    return { table, total: Number(fin.total_rows ?? 0) };
  }

  async function run() {
    if (files.length === 0) { setMsg('파일을 선택하세요.'); return; }
    if (!/^\d{6}$/.test(month)) { setMsg('기준 월(YYYYMM)을 입력하세요. 예: 202606'); return; }
    cancelRef.current = false;
    setMsg(null);
    setPhase('running');
    const results: string[] = [];
    try {
      for (const file of files) {
        if (cancelRef.current) break;
        setProg(zeroProg(file.name));
        const r = await processFile(file);
        results.push(`${TABLE_LABEL[r.table]}: ${r.total.toLocaleString()}행`);
      }
      setPhase('done');
      setMsg('적재 완료 — ' + results.join(' · '));
      void loadJobs();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 진행 중이던 작업 실패 표시는 서버 job 상태로 남기려면 fail 필요하지만
      // jobId 스코프가 processFile 내부라 여기선 메시지만 처리
      stop('실패: ' + message);
      void loadJobs();
    }
  }

  const busy = phase === 'running';
  const pct = prog && prog.sheetsTotal > 0 ? Math.min(100, Math.round((prog.sheetsDone / prog.sheetsTotal) * 100)) : 0;
  const expected = expectedEumMonth();
  const puDone = jobs.find((j) => j.status === 'done' && j.table_name === 'permitted_uses')?.src_month ?? null;
  const zrDone = jobs.find((j) => j.status === 'done' && j.table_name === 'zoning_rates')?.src_month ?? null;
  const puStale = !puDone || puDone < expected;
  const zrStale = !zrDone || zrDone < expected;

  return (
    <div className="adm-panel">
      <h1>데이터 적재</h1>

      <div className="adm-cards">
        <div className="adm-card"><div className="adm-card-v">{counts.pu != null ? counts.pu.toLocaleString() : '-'}</div><div className="adm-card-l">행위제한 적재 행수</div></div>
        <div className="adm-card"><div className="adm-card-v">{counts.zr != null ? counts.zr.toLocaleString() : '-'}</div><div className="adm-card-l">건폐율·용적률 적재 행수</div></div>
        <div className={`adm-card ${puStale ? 'alert' : ''}`}><div className="adm-card-v">{puDone ?? '-'}</div><div className="adm-card-l">{puStale ? '행위제한 신규 월 필요' : '행위제한 최신'}</div></div>
        <div className={`adm-card ${zrStale ? 'alert' : ''}`}><div className="adm-card-v">{zrDone ?? '-'}</div><div className="adm-card-l">{zrStale ? '건폐율·용적률 신규 월 필요' : '건폐율·용적률 최신'}</div></div>
      </div>

      <div className="adm-box">
        <h3>eum.go.kr 파일 업로드 (행위제한정보 · 법령정보)</h3>
        <p className="adm-muted adm-small">
          토지이음(eum.go.kr) → 정보마당 → 토지이용규제정보 DB에서 내려받은 <b>행위제한정보</b>와 <b>법령정보</b> zip/xlsx를 함께 올리면
          파일 종류를 자동 판별해 각각 <b>행위제한(permitted_uses)</b>·<b>건폐율·용적률(zoning_rates)</b> 테이블에 적재합니다.
          두 데이터는 서로 다른 테이블이라 함께 올려도 충돌하지 않습니다. 같은 종류·같은 월을 다시 올리면 그 테이블만 삭제 후 재적재합니다. (전량 적재)
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <input type="file" accept=".zip,.xlsx" multiple disabled={busy}
            onChange={(e) => pickFiles(e.target.files)} />
          <input className="adm-input" style={{ width: 120, margin: 0 }} placeholder="기준월 YYYYMM"
            value={month} disabled={busy} onChange={(e) => setMonth(e.target.value.trim())} />
          <button className="adm-btn primary" onClick={() => void run()} disabled={busy || files.length === 0}>
            {busy ? '적재 중…' : '적재 시작'}
          </button>
          {busy && <button className="adm-btn" onClick={() => stop('사용자 취소')}>취소</button>}
        </div>
        {files.length > 0 && !busy && (
          <p className="adm-muted adm-small">선택된 파일 {files.length}개: {files.map((f) => f.name).join(', ')}</p>
        )}

        {busy && prog && (
          <div style={{ marginTop: 12 }}>
            <div className="adm-bar">
              <span className="adm-bar-l">{prog.table ? TABLE_LABEL[prog.table] : '판별 중'}</span>
              <span className="adm-bar-track"><span className="adm-bar-fill" style={{ width: `${pct}%` }} /></span>
              <span className="adm-bar-n">{pct}%</span>
            </div>
            <p className="adm-muted adm-small">
              {prog.fileName} · 파싱 {prog.rowsParsed.toLocaleString()}행 · 적재 {prog.rowsInserted.toLocaleString()}행 · 배치 {prog.batchesSent.toLocaleString()}건
              {prog.retries > 0 ? ` · 재시도 ${prog.retries}` : ''}
              {' — 창을 닫지 마세요'}
            </p>
          </div>
        )}
        {msg && <div className={phase === 'error' ? 'adm-err' : 'adm-muted'} style={{ marginTop: 10 }}>{msg}</div>}
      </div>

      <div className="adm-box">
        <h3>적재 이력</h3>
        {jobs.length === 0 ? <p className="adm-muted">이력이 없습니다.</p> :
          <table className="adm-table">
            <thead><tr><th>일시</th><th>종류</th><th>기준월</th><th>파일</th><th>상태</th><th>적재</th><th>삭제</th><th>비고</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className={j.status === 'failed' ? 'adm-row-alert' : ''}>
                  <td className="adm-nowrap">{j.created_at?.slice(0, 16).replace('T', ' ')}</td>
                  <td>{TABLE_LABEL[j.table_name] ?? j.table_name}</td>
                  <td>{j.src_month}</td>
                  <td>{j.file_name ?? '-'}</td>
                  <td><span className={`adm-badge ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'alert' : ''}`}>{STATUS_LABEL[j.status] ?? j.status}</span></td>
                  <td>{(j.total_rows ?? j.inserted_rows).toLocaleString()}</td>
                  <td>{j.deleted_rows.toLocaleString()}</td>
                  <td className="adm-small">{j.error ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>
    </div>
  );
}
