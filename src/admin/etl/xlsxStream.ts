// eum.go.kr 행위제한정보 xlsx 스트리밍 파서 (2-pass, sharedStrings/inlineStr 모두 대응)
// 202만 행 규모 파일을 메모리에 전부 올리지 않고 행 단위로 흘려보낸다.
import { Unzip, UnzipInflate } from 'fflate';

export function unescapeXml(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (m, e: string) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const hex = e[1] === 'x' || e[1] === 'X';
        const n = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
    }
  });
}

export function colIndexFromRef(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else break;
  }
  return n - 1; // A=0
}

// <t> 조각들을 이어붙인다 (rich text <r><t>..</t></r> 포함)
function textOf(xml: string): string {
  let out = '';
  const re = /<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out += m[1] ? unescapeXml(m[1]) : '';
  return out;
}

// sharedStrings.xml 증분 파서
export class SharedStringsParser {
  buf = '';
  sst: string[] = [];
  push(chunk: string): void {
    this.buf += chunk;
    let start: number;
    while ((start = this.buf.indexOf('<si')) !== -1) {
      const end = this.buf.indexOf('</si>', start);
      if (end === -1) break;
      this.sst.push(textOf(this.buf.slice(start, end + 5)));
      this.buf = this.buf.slice(end + 5);
    }
    if (this.buf.length > 1 << 20 && this.buf.indexOf('<si') === -1) this.buf = this.buf.slice(-16);
  }
}

export type RowHandler = (rowIdx: number, cells: string[]) => void;

// worksheet XML 증분 행 파서. onRow(rowIndex, cells[]) — cells는 열 index 기준 문자열 배열
export class SheetRowParser {
  private buf = '';
  constructor(private sst: string[], private onRow: RowHandler) {}
  push(chunk: string): void {
    this.buf += chunk;
    let start: number;
    while ((start = this.buf.indexOf('<row')) !== -1) {
      const gt = this.buf.indexOf('>', start);
      if (gt === -1) break;
      if (this.buf[gt - 1] === '/') { this.buf = this.buf.slice(gt + 1); continue; } // 빈 행
      const end = this.buf.indexOf('</row>', start);
      if (end === -1) break;
      this.row(this.buf.slice(start, end + 6));
      this.buf = this.buf.slice(end + 6);
    }
    if (this.buf.length > 1 << 20 && this.buf.indexOf('<row') === -1) this.buf = this.buf.slice(-16);
  }
  private row(xml: string): void {
    const rm = /^<row[^>]*?\br="(\d+)"/.exec(xml);
    const rowIdx = rm ? parseInt(rm[1], 10) : 0;
    const cells: string[] = [];
    const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let m: RegExpExecArray | null;
    let pos = 0;
    while ((m = re.exec(xml)) !== null) {
      const attrs = m[1] ?? '';
      const inner = m[2] ?? '';
      const refM = /\br="([A-Z]+)\d+"/.exec(attrs);
      const col = refM ? colIndexFromRef(refM[1]) : pos;
      pos = col + 1;
      const tM = /\bt="([^"]+)"/.exec(attrs);
      const t = tM ? tM[1] : '';
      let val = '';
      if (t === 's') {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vM) { const idx = parseInt(vM[1], 10); val = this.sst[idx] ?? ''; }
      } else if (t === 'inlineStr') {
        val = textOf(inner);
      } else {
        const vM = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        val = vM ? unescapeXml(vM[1]) : '';
      }
      cells[col] = val;
    }
    this.onRow(rowIdx, cells);
  }
}

export interface SheetRef { name: string; path: string }

// workbook.xml + rels → 시트 순서대로 [{name, path}] (속성 순서 무관)
export function parseWorkbook(workbookXml: string, relsXml: string): SheetRef[] {
  const attr = (el: string, name: string): string => {
    const m = new RegExp('\\b' + name + '="([^"]*)"').exec(el);
    return m ? m[1] : '';
  };
  const rels: Record<string, string> = {};
  let m: RegExpExecArray | null;
  const rRe = /<Relationship\b[^>]*\/?>/g;
  while ((m = rRe.exec(relsXml)) !== null) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels[id] = target;
  }
  const sheets: SheetRef[] = [];
  const sRe = /<sheet\b[^>]*\/?>/g;
  while ((m = sRe.exec(workbookXml)) !== null) {
    const name = attr(m[0], 'name');
    const rid = attr(m[0], 'r:id');
    let target = rels[rid] ?? '';
    if (!target) continue;
    if (target.startsWith('/')) target = target.slice(1);
    else if (!target.startsWith('xl/')) target = 'xl/' + target;
    sheets.push({ name: unescapeXml(name), path: target });
  }
  return sheets;
}

type ChunkCb = (chunk: Uint8Array, final: boolean) => void;

// zip 바이트를 1MB 슬라이스로 스트리밍 순회. handler(name)가 콜백을 반환하면 해당 엔트리 청크 수신.
// onProgress는 슬라이스마다 await — 백프레셔/진행률 지점.
export async function streamZip(
  data: Uint8Array,
  handler: (name: string) => ChunkCb | null,
  onProgress?: (consumed: number) => Promise<void> | void,
  sliceSize = 1 << 20,
): Promise<void> {
  const uz = new Unzip();
  uz.register(UnzipInflate);
  let err: Error | null = null;
  uz.onfile = (file) => {
    const cb = handler(file.name);
    if (!cb) return;
    file.ondata = (e, chunk, final) => {
      if (e) { err = e; return; }
      cb(chunk, final);
    };
    file.start();
  };
  for (let off = 0; off < data.length; off += sliceSize) {
    const end = Math.min(off + sliceSize, data.length);
    uz.push(data.subarray(off, end), end === data.length);
    if (err) throw err;
    if (onProgress) await onProgress(end);
  }
}

// xlsx 바이트에서 행 스트림 추출 (2-pass: 메타·sharedStrings → 시트 행)
export async function parseXlsx(
  xlsxBytes: Uint8Array,
  onRow: (sheetName: string, rowIdx: number, cells: string[]) => void,
  onProgress?: (consumed: number) => Promise<void> | void,
): Promise<string[]> {
  let wb = '';
  let rels = '';
  const sstParser = new SharedStringsParser();
  const dWb = new TextDecoder(), dRels = new TextDecoder(), dSst = new TextDecoder();
  await streamZip(xlsxBytes, (name) => {
    if (name === 'xl/workbook.xml') return (c, f) => { wb += dWb.decode(c, { stream: !f }); };
    if (name === 'xl/_rels/workbook.xml.rels') return (c, f) => { rels += dRels.decode(c, { stream: !f }); };
    if (name === 'xl/sharedStrings.xml') return (c, f) => { sstParser.push(dSst.decode(c, { stream: !f })); };
    return null;
  });
  const sheets = parseWorkbook(wb, rels);
  if (sheets.length === 0) throw new Error('워크북에서 시트를 찾지 못했습니다');
  const byPath: Record<string, string> = {};
  for (const s of sheets) byPath[s.path] = s.name;
  await streamZip(xlsxBytes, (name) => {
    const sheetName = byPath[name];
    if (sheetName === undefined) return null;
    const dec = new TextDecoder();
    const p = new SheetRowParser(sstParser.sst, (rowIdx, cells) => onRow(sheetName, rowIdx, cells));
    return (c, f) => { p.push(dec.decode(c, { stream: !f })); };
  }, onProgress);
  return sheets.map((s) => s.name);
}

// 업로드 파일이 (a) eum zip 컨테이너면 내부 .xlsx들을 추출, (b) xlsx 자체면 그대로 반환
export async function extractXlsxEntries(bytes: Uint8Array): Promise<{ name: string; data: Uint8Array }[]> {
  const names: string[] = [];
  const collected: Record<string, Uint8Array[]> = {};
  await streamZip(bytes, (name) => {
    names.push(name);
    if (name.toLowerCase().endsWith('.xlsx')) {
      collected[name] = [];
      return (c) => { collected[name].push(c.slice()); };
    }
    return null;
  });
  const found = Object.keys(collected);
  if (found.length === 0) {
    if (names.includes('[Content_Types].xml')) return [{ name: '(업로드 파일)', data: bytes }];
    throw new Error('zip 안에서 xlsx 파일을 찾지 못했습니다');
  }
  return found.map((n) => {
    const total = collected[n].reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of collected[n]) { out.set(c, o); o += c.length; }
    return { name: n, data: out };
  });
}
