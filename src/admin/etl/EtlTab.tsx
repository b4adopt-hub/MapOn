// 관리자 데이터 적재 탭: eum.go.kr 행위제한정보(zip/xlsx) 업로드 → 브라우저 파싱 →
// etl-ingest Edge Function으로 배치 전송(service role 적재). 같은 월 재업로드 시 삭제 후 재적재(멱등).
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import type { EtlRow, FromWorker } from './parseEum.worker';

interface JobRow {
  id: string;
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

// eum 월별 파일 공개 주기(매월 중순) 기준 기대 월: 18일 이후면 당월, 이전이면 전월
export function expectedEumMonth(now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  let y = kst.getUTCFullYear();
  let m = kst.getUTCMonth() + 1;
  if (kst.getUTCDate() < 18) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
  return `${y}${String(m).padStart(2, '0')}`;
}

export async function fetchLatestLoadedMonth(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from('etl_jobs')
    .select('src_month')
    .eq('status', 'done')
    .order('src_month', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { src_month?: string } | null)?.src_month ?? null;
}

const STATUS_LABEL: Record<string, string> = {
  running: '진행중', done: '완료', failed: '실패', canceled: '취소',
};

type Phase = 'idle' | 'starting' | 'running' | 'finishing' | 'done' | 'error';

interface Progress {
  sheetsDone: number;
  sheetsTotal: number;
  rowsParsed: number;
  rowsInserted: number;
  batchesSent: number;
  batchesFailedRetries: number;
}

const ZERO: Progress = { sheetsDone: 0, sheetsTotal: 0, rowsParsed: 0, rowsInserted: 0, batchesSent: 0, batchesFailedRetries: 0 };

async function invokeIngest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!supabase) throw new Error('Supabase 미연결');
  const { data, error } = await supabase.functions.invoke('etl-ingest', { body });
  if (error) {
    // FunctionsHttpError면 응답 본문의 error 메시지를 살린다
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
  jobId: string, month: string, rows: EtlRow[],
  onRetry: () => void,
): Promise<number> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await invokeIngest({ action: 'batch', job_id: jobId, src_month: month, rows });
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
  const [file, setFile] = useState<File | null>(null);
  const [month, setMonth] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [prog, setProg] = useState<Progress>(ZERO);
  const [msg, setMsg] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const cancelRef = useRef(false);
  const workerRef = useRef<Worker | null>(null);

  async function loadJobs() {
    if (!supabase) return;
    const { data } = await supabase
      .from('etl_jobs')
      .select('id,src_month,status,file_name,total_rows,inserted_rows,deleted_rows,error,created_at,finished_at')
      .order('created_at', { ascending: false })
      .limit(20);
    setJobs((data ?? []) as JobRow[]);
    const { count } = await supabase.from('permitted_uses').select('id', { count: 'exact', head: true });
    setLiveCount(count ?? null);
  }
  useEffect(() => { void loadJobs(); }, []);

  function pickFile(f: File | null) {
    setFile(f);
    setMsg(null);
    if (f) {
      const m = /20\d{4}/.exec(f.name);
      if (m) setMonth(m[0]);
    }
  }

  function stop(reason: string) {
    cancelRef.current = true;
    workerRef.current?.terminate();
    workerRef.current = null;
    setPhase('error');
    setMsg(reason);
  }

  async function run() {
    if (!file) { setMsg('파일을 선택하세요.'); return; }
    if (!/^\d{6}$/.test(month)) { setMsg('기준 월(YYYYMM)을 입력하세요. 예: 202606'); return; }
    cancelRef.current = false;
    setProg(ZERO);
    setMsg(null);
    setPhase('starting');
    let jobId = '';
    try {
      const started = await invokeIngest({ action: 'start', src_month: month, file_name: file.name });
      jobId = String(started.job_id ?? '');
      if (!jobId) throw new Error('작업 생성 실패');
      const deleted = Number(started.deleted ?? 0);
      if (deleted > 0) setMsg(`같은 월(${month}) 기존 ${deleted.toLocaleString()}행 삭제 후 재적재합니다.`);
      setPhase('running');

      const buffer = await file.arrayBuffer();
      const worker = new Worker(new URL('./parseEum.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;

      // 배치 전송 파이프라인 (동시 3개)
      const CONCURRENCY = 3;
      let inFlight = 0;
      const queue: EtlRow[][] = [];
      let workerDone = false;
      let fatal: Error | null = null;
      let resolveAll: (() => void) | null = null;
      const allSent = new Promise<void>((res) => { resolveAll = res; });

      const pump = () => {
        if (fatal || cancelRef.current) { if (inFlight === 0 && resolveAll) resolveAll(); return; }
        while (inFlight < CONCURRENCY && queue.length > 0) {
          const rows = queue.shift()!;
          inFlight++;
          void sendBatchWithRetry(jobId, month, rows, () =>
            setProg((p) => ({ ...p, batchesFailedRetries: p.batchesFailedRetries + 1 })))
            .then((inserted) => {
              setProg((p) => ({ ...p, rowsInserted: p.rowsInserted + inserted, batchesSent: p.batchesSent + 1 }));
              worker.postMessage({ type: 'ack' });
            })
            .catch((e) => { fatal = e instanceof Error ? e : new Error(String(e)); })
            .finally(() => { inFlight--; pump(); });
        }
        if (workerDone && queue.length === 0 && inFlight === 0 && resolveAll) resolveAll();
      };

      const workerFinished = new Promise<{ rowsParsed: number; filtered: number }>((res, rej) => {
        worker.onmessage = (ev: MessageEvent<FromWorker>) => {
          const m = ev.data;
          if (m.type === 'batch') { queue.push(m.rows); pump(); }
          else if (m.type === 'progress') setProg((p) => ({ ...p, sheetsDone: m.sheetsDone, sheetsTotal: m.sheetsTotal, rowsParsed: m.rowsParsed }));
          else if (m.type === 'done') { workerDone = true; pump(); res({ rowsParsed: m.rowsParsed, filtered: m.filtered }); }
          else if (m.type === 'error') rej(new Error(m.message));
        };
        worker.onerror = (e) => rej(new Error(e.message || '워커 오류'));
      });

      worker.postMessage({ type: 'start', buffer }, [buffer]);
      const parsed = await workerFinished;
      await allSent;
      worker.terminate();
      workerRef.current = null;
      if (fatal) throw fatal;
      if (cancelRef.current) throw new Error('사용자 취소');

      setPhase('finishing');
      const fin = await invokeIngest({ action: 'finish', job_id: jobId, src_month: month });
      setPhase('done');
      setMsg(`적재 완료: ${Number(fin.total_rows ?? 0).toLocaleString()}행 (파싱 ${parsed.rowsParsed.toLocaleString()}행 / 제외 ${parsed.filtered.toLocaleString()}행)`);
      void loadJobs();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (jobId) { void invokeIngest({ action: 'fail', job_id: jobId, error: message }).catch(() => undefined); }
      stop('실패: ' + message);
      void loadJobs();
    }
  }

  const busy = phase === 'starting' || phase === 'running' || phase === 'finishing';
  const pct = prog.sheetsTotal > 0 ? Math.min(100, Math.round((prog.sheetsDone / prog.sheetsTotal) * 100)) : 0;
  const expected = expectedEumMonth();
  const latestDone = jobs.find((j) => j.status === 'done')?.src_month ?? null;
  const stale = !latestDone || latestDone < expected;

  return (
    <div className="adm-panel">
      <h1>데이터 적재</h1>

      <div className="adm-cards">
        <div className="adm-card"><div className="adm-card-v">{liveCount != null ? liveCount.toLocaleString() : '-'}</div><div className="adm-card-l">행위제한 적재 행수</div></div>
        <div className="adm-card"><div className="adm-card-v">{latestDone ?? '-'}</div><div className="adm-card-l">최근 적재 월</div></div>
        <div className={`adm-card ${stale ? 'alert' : ''}`}><div className="adm-card-v">{expected}</div><div className="adm-card-l">{stale ? '신규 월 파일 적재 필요' : '기대 월 (최신)'}</div></div>
      </div>

      <div className="adm-box">
        <h3>행위제한정보 업로드 (토지이음 월별 파일)</h3>
        <p className="adm-muted adm-small">
          토지이음(eum.go.kr) → 정보마당 → 토지이용규제정보 DB에서 내려받은 <b>행위제한정보</b> zip 또는 xlsx를 그대로 올리면
          브라우저에서 파싱해 서버에 적재합니다. 같은 월을 다시 올리면 해당 월 데이터를 삭제 후 재적재합니다. (전량 적재 — 용도 필터 없음)
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <input type="file" accept=".zip,.xlsx" disabled={busy}
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
          <input className="adm-input" style={{ width: 120, margin: 0 }} placeholder="기준월 YYYYMM"
            value={month} disabled={busy} onChange={(e) => setMonth(e.target.value.trim())} />
          <button className="adm-btn primary" onClick={() => void run()} disabled={busy || !file}>
            {busy ? '적재 중…' : '적재 시작'}
          </button>
          {busy && <button className="adm-btn" onClick={() => stop('사용자 취소')}>취소</button>}
        </div>

        {busy && (
          <div style={{ marginTop: 12 }}>
            <div className="adm-bar">
              <span className="adm-bar-l">{phase === 'starting' ? '준비' : phase === 'finishing' ? '마무리' : '파싱/전송'}</span>
              <span className="adm-bar-track"><span className="adm-bar-fill" style={{ width: `${pct}%` }} /></span>
              <span className="adm-bar-n">{pct}%</span>
            </div>
            <p className="adm-muted adm-small">
              {prog.sheetsTotal > 0 ? `시트 ${prog.sheetsDone}/${prog.sheetsTotal} · ` : ''}파싱 {prog.rowsParsed.toLocaleString()}행 · 적재 {prog.rowsInserted.toLocaleString()}행 · 배치 {prog.batchesSent.toLocaleString()}건
              {prog.batchesFailedRetries > 0 ? ` · 재시도 ${prog.batchesFailedRetries}` : ''}
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
            <thead><tr><th>일시</th><th>기준월</th><th>파일</th><th>상태</th><th>적재</th><th>삭제</th><th>비고</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className={j.status === 'failed' ? 'adm-row-alert' : ''}>
                  <td className="adm-nowrap">{j.created_at?.slice(0, 16).replace('T', ' ')}</td>
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
