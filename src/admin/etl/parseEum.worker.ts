// eum.go.kr 파일 파싱 Web Worker. 파일 종류를 자동 판별해:
//  - 행위제한정보 → permitted_uses 행 (시트별 스트리밍)
//  - 법령정보(건폐율·용적률) → zoning_rates 행 (전량 수집 후 parse_law 2-pass 판정)
// 네이티브 DecompressionStream으로 해제하고, 메인 스레드가 처리(ack)한 배치 수에
// 맞춰 파싱을 멈춰(백프레셔) 대용량에서도 메모리·전송을 안정화한다.
import {
  resolveXlsxZip, readXlsxMeta, streamSheetRows, detectKind, collectLawRows,
} from './xlsxStream';
import { parseLawRows } from './parseLaw';

export type EtlRow = unknown[];
export type EtlTable = 'permitted_uses' | 'zoning_rates';

export interface StartMsg { type: 'start'; buffer: ArrayBuffer; fileName?: string }
export interface AckMsg { type: 'ack' }
export type ToWorker = StartMsg | AckMsg;

export type FromWorker =
  | { type: 'meta'; table: EtlTable }
  | { type: 'batch'; rows: EtlRow[]; seq: number }
  | { type: 'progress'; sheetsDone: number; sheetsTotal: number; rowsParsed: number }
  | { type: 'done'; rowsParsed: number; filtered: number; sheets: string[] }
  | { type: 'error'; message: string };

const ctx = self as unknown as Worker;
const BATCH_ROWS = 2000;
const MAX_PENDING = 3;

let pending = 0;
let waiter: (() => void) | null = null;

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'ack') {
    pending = Math.max(0, pending - 1);
    if (waiter && pending < MAX_PENDING) { const w = waiter; waiter = null; w(); }
    return;
  }
  if (msg.type === 'start') void run(msg.buffer, msg.fileName);
};

async function waitForCapacity(): Promise<void> {
  if (pending < MAX_PENDING) return;
  await new Promise<void>((res) => { waiter = res; });
}

async function run(buffer: ArrayBuffer, fileName?: string): Promise<void> {
  try {
    const uploaded = new Uint8Array(buffer);
    const xlsxZip = await resolveXlsxZip(uploaded);
    const meta = await readXlsxMeta(xlsxZip);
    const kind = detectKind(meta, fileName);
    const table: EtlTable = kind === 'zoning' ? 'zoning_rates' : 'permitted_uses';
    ctx.postMessage({ type: 'meta', table } satisfies FromWorker);

    let rowsParsed = 0;
    let filtered = 0;
    let seq = 0;
    let batch: EtlRow[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      pending++;
      ctx.postMessage({ type: 'batch', rows: batch, seq: seq++ } satisfies FromWorker);
      batch = [];
    };

    if (kind === 'zoning') {
      // 법령정보: 전량 수집 → parse_law 2-pass 판정 → zoning_rates 행
      const lawInput = await collectLawRows(xlsxZip, meta);
      ctx.postMessage({ type: 'progress', sheetsDone: 1, sheetsTotal: 2, rowsParsed: lawInput.length } satisfies FromWorker);
      const zr = parseLawRows(lawInput);
      for (const row of zr) {
        batch.push(row);
        rowsParsed++;
        if (batch.length >= BATCH_ROWS) { flush(); await waitForCapacity(); }
      }
      flush();
      ctx.postMessage({ type: 'progress', sheetsDone: 2, sheetsTotal: 2, rowsParsed } satisfies FromWorker);
      ctx.postMessage({ type: 'done', rowsParsed, filtered: lawInput.length - zr.length, sheets: meta.sheets.map((s) => s.name) } satisfies FromWorker);
      return;
    }

    // 행위제한정보: 시트별 스트리밍 → permitted_uses 행
    let sheetsDone = 0;
    for (const sheet of meta.sheets) {
      const isOrdinance = sheet.name !== '법령';
      await streamSheetRows(xlsxZip, meta, sheet, (rowIdx, cells) => {
        if (rowIdx === 1) return;
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
          isOrdinance,
        ]);
        rowsParsed++;
        if (batch.length >= BATCH_ROWS) flush();
      });
      sheetsDone++;
      ctx.postMessage({ type: 'progress', sheetsDone, sheetsTotal: meta.sheets.length, rowsParsed } satisfies FromWorker);
      await waitForCapacity();
    }
    flush();
    ctx.postMessage({ type: 'done', rowsParsed, filtered, sheets: meta.sheets.map((s) => s.name) } satisfies FromWorker);
  } catch (e) {
    ctx.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) } satisfies FromWorker);
  }
}
