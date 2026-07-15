// eum.go.kr 행위제한정보 xlsx 파서. 셀 문자열/행을 증분식으로 흘려 메모리 피크를 억제한다.
// zip 해제는 zipStream.ts(네이티브 DecompressionStream)가 담당한다.
import {
  ZipEntry, readCentralDirectory, inflateEntry, inflateEntryToString, inflateEntryToBytes,
} from './zipStream';

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

// sharedStrings.xml 증분 파서 (<si> 단위로 buf를 잘라 메모리 유지)
export class SharedStringsParser {
  private buf = '';
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

// worksheet XML 증분 행 파서 (<row> 단위로 buf를 잘라 메모리 유지)
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

// 업로드 파일에서 파싱 대상 xlsx의 zip 바이트를 얻는다.
// (a) 업로드가 xlsx 자체면 그대로, (b) eum zip 컨테이너면 내부 첫 xlsx를 해제해 반환.
export async function resolveXlsxZip(uploaded: Uint8Array): Promise<Uint8Array> {
  const entries = readCentralDirectory(uploaded);
  const isXlsxItself = entries.some((e) => e.name === '[Content_Types].xml');
  if (isXlsxItself) return uploaded;
  const inner = entries.find((e) => e.name.toLowerCase().endsWith('.xlsx'));
  if (!inner) throw new Error('zip 안에서 xlsx 파일을 찾지 못했습니다');
  return inflateEntryToBytes(uploaded, inner);
}

export interface XlsxMeta { entries: ZipEntry[]; byName: Record<string, ZipEntry>; sheets: SheetRef[]; sst: string[] }

// xlsx zip에서 workbook·rels·sharedStrings를 먼저 읽어 시트 순서와 공유문자열을 확보한다.
export async function readXlsxMeta(xlsxZip: Uint8Array): Promise<XlsxMeta> {
  const entries = readCentralDirectory(xlsxZip);
  const byName: Record<string, ZipEntry> = {};
  for (const e of entries) byName[e.name] = e;
  const wbE = byName['xl/workbook.xml'];
  const relsE = byName['xl/_rels/workbook.xml.rels'];
  if (!wbE || !relsE) throw new Error('xlsx 구조가 올바르지 않습니다 (workbook 없음)');
  const wb = await inflateEntryToString(xlsxZip, wbE);
  const rels = await inflateEntryToString(xlsxZip, relsE);
  const sheets = parseWorkbook(wb, rels);
  if (sheets.length === 0) throw new Error('워크북에서 시트를 찾지 못했습니다');
  const sstParser = new SharedStringsParser();
  const sstE = byName['xl/sharedStrings.xml'];
  if (sstE) {
    const dec = new TextDecoder();
    await inflateEntry(xlsxZip, sstE, (chunk, final) => sstParser.push(dec.decode(chunk, { stream: !final })));
  }
  return { entries, byName, sheets, sst: sstParser.sst };
}

// 한 시트를 스트리밍 해제하며 행을 흘린다.
export async function streamSheetRows(
  xlsxZip: Uint8Array, meta: XlsxMeta, sheet: SheetRef,
  onRow: RowHandler,
): Promise<void> {
  const e = meta.byName[sheet.path];
  if (!e) return;
  const dec = new TextDecoder();
  const parser = new SheetRowParser(meta.sst, onRow);
  await inflateEntry(xlsxZip, e, (chunk, final) => parser.push(dec.decode(chunk, { stream: !final })));
}
