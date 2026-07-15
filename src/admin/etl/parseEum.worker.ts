// 행위제한정보(zip/xlsx) 파싱 Web Worker.
// 네이티브 DecompressionStream으로 시트를 스트리밍 해제하고, 메인 스레드가 처리(ack)한
// 배치 수에 맞춰 파싱을 멈췜(백프레셔) 대용량(202만 행)에서도 메모리·전송을 안정화한다.
import { resolveXlsxZip, readXlsxMeta, streamSheetRows } from './xlsxStream';

// [sgg_code, sgg_name, zone_nm, law_name, land_use, decision, condition_note, is_ordinance]
export type EtlRow = [string, string, string, string, string, string, string, boolean];

export interface StartMsg { type: 'start'; buffer: ArrayBuffer }
export interface AckMsg { type: 'ack' }
export type ToWorker = StartMsg | AckMsg;

export type FromWorker =
  | { type: 'batch'; rows: EtlRow[]; seq: number }
  | { type: 'progress'; sheetsDone: number; sheetsTotal: number; rowsParsed: number }
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

async function waitForCapacity(): Promise<void> {
  if (pending < MAX_PENDING) return;
  await new Promise<void>((res) => { waiter = res; });
}

async function run(buffer: ArrayBuffer): Promise<void> {
  try {
    const uploaded = new Uint8Array(buffer);
    const xlsxZip = await resolveXlsxZip(uploaded);
    const meta = await readXlsxMeta(xlsxZip);

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

    let sheetsDone = 0;
    for (const sheet of meta.sheets) {
      const isOrdinance = sheet.name !== '법령'; // load_luris 규약과 동일
      await streamSheetRows(xlsxZip, meta, sheet, (rowIdx, cells) => {
        if (rowIdx === 1) return; // 헤더
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
      // 시트 경계에서 전송 백프레셔 적용 (배치가 밀리면 대기)
      await waitForCapacity();
    }
    flush();
    ctx.postMessage({ type: 'done', rowsParsed, filtered, sheets: meta.sheets.map((s) => s.name) } satisfies FromWorker);
  } catch (e) {
    ctx.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) } satisfies FromWorker);
  }
}
