// 행위제한정보(zip/xlsx) 파싱 Web Worker.
// 메인 스레드가 처리(ack)한 배치 수에 맞춰 파싱 속도를 조절한다(백프레셔).
import { extractXlsxEntries, parseXlsx } from './xlsxStream';

// [sgg_code, sgg_name, zone_nm, law_name, land_use, decision, condition_note, is_ordinance]
export type EtlRow = [string, string, string, string, string, string, string, boolean];

export interface StartMsg { type: 'start'; buffer: ArrayBuffer }
export interface AckMsg { type: 'ack' }
export type ToWorker = StartMsg | AckMsg;

export type FromWorker =
  | { type: 'batch'; rows: EtlRow[]; seq: number }
  | { type: 'progress'; bytesDone: number; bytesTotal: number; rowsParsed: number }
  | { type: 'done'; rowsParsed: number; filtered: number; sheets: string[] }
  | { type: 'error'; message: string };

const ctx = self as unknown as Worker;
const BATCH_ROWS = 2000;
const MAX_PENDING = 3; // ack 없이 앞서갈 수 있는 배치 수

let pending = 0;
let waiter: (() => void) | null = null;

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'ack') {
    pending = Math.max(0, pending - 1);
    if (waiter && pending < MAX_PENDING) { const w = waiter; waiter = null; w(); }
    return;
  }
  if (msg.type === 'start') void run(msg.buffer);
};

async function run(buffer: ArrayBuffer): Promise<void> {
  try {
    const bytes = new Uint8Array(buffer);
    const entries = await extractXlsxEntries(bytes);
    let rowsParsed = 0;
    let filtered = 0;
    let seq = 0;
    let batch: EtlRow[] = [];
    const allSheets: string[] = [];

    const flush = () => {
      if (batch.length === 0) return;
      pending++;
      ctx.postMessage({ type: 'batch', rows: batch, seq: seq++ } satisfies FromWorker);
      batch = [];
    };

    for (const entry of entries) {
      const total = entry.data.length;
      const sheets = await parseXlsx(
        entry.data,
        (sheetName, rowIdx, cells) => {
          if (rowIdx === 1) return; // 헤더 (load_luris.parse_act min_row=2와 동일)
          const code = (cells[0] ?? '').trim();
          const landUse = (cells[4] ?? '').trim();
          if (!code || !landUse) { filtered++; return; }
          batch.push([
            code,
            (cells[1] ?? '').trim(),
            (cells[2] ?? '').trim(),
            (cells[3] ?? '').trim().slice(0, 300),
            landUse.slice(0, 300),
            (cells[5] ?? '').trim().slice(0, 200),
            (cells[6] ?? '').trim().slice(0, 2000),
            sheetName !== '법령',
          ]);
          rowsParsed++;
          if (batch.length >= BATCH_ROWS) flush();
        },
        async (consumed) => {
          ctx.postMessage({ type: 'progress', bytesDone: consumed, bytesTotal: total, rowsParsed } satisfies FromWorker);
          if (pending >= MAX_PENDING) {
            await new Promise<void>((res) => { waiter = res; });
          }
        },
      );
      allSheets.push(...sheets);
    }
    flush();
    ctx.postMessage({ type: 'done', rowsParsed, filtered, sheets: allSheets } satisfies FromWorker);
  } catch (e) {
    ctx.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) } satisfies FromWorker);
  }
}
