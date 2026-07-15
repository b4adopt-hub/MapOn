// zip(Uint8Array)에서 중앙 디렉터리로 엔트리 목록을 읽고, 각 엔트리를
// 브라우저 네이티브 DecompressionStream('deflate-raw')로 스트리밍 해제한다.
// deflate(method 8)·stored(0)·zip64 대응. fflate 대비 메모리 피크가 훨씬 낮아
// 압축 해제 시 수백 MB가 되는 전국 xlsx도 브라우저 힙 안에서 처리된다.

function u16(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function u64(b: Uint8Array, o: number): number { return u32(b, o) + u32(b, o + 4) * 4294967296; }

export interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localOff: number;
}

export function readCentralDirectory(zip: Uint8Array): ZipEntry[] {
  // EOCD (뒤에서부터, 코멘트 최대 65535)
  let eocd = -1;
  const min = Math.max(0, zip.length - 22 - 65535);
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x05 && zip[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('올바른 zip 파일이 아닙니다 (EOCD 없음)');
  let cdOff = u32(zip, eocd + 16);
  let cdCount = u16(zip, eocd + 10);
  // zip64
  if (cdOff === 0xffffffff || cdCount === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && zip[loc] === 0x50 && zip[loc + 1] === 0x4b && zip[loc + 2] === 0x06 && zip[loc + 3] === 0x07) {
      const z64 = u64(zip, loc + 8);
      cdOff = u64(zip, z64 + 48);
      cdCount = u64(zip, z64 + 32);
    }
  }
  const dec = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = cdOff;
  for (let i = 0; i < cdCount; i++) {
    if (u32(zip, p) !== 0x02014b50) break;
    const method = u16(zip, p + 10);
    let compSize = u32(zip, p + 20);
    let uncompSize = u32(zip, p + 24);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    let localOff = u32(zip, p + 42);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff) {
      let ep = p + 46 + nameLen;
      const eend = ep + extraLen;
      while (ep + 4 <= eend) {
        const tag = u16(zip, ep);
        const sz = u16(zip, ep + 2);
        let q = ep + 4;
        if (tag === 0x0001) {
          if (uncompSize === 0xffffffff) { uncompSize = u64(zip, q); q += 8; }
          if (compSize === 0xffffffff) { compSize = u64(zip, q); q += 8; }
          if (localOff === 0xffffffff) { localOff = u64(zip, q); q += 8; }
        }
        ep += 4 + sz;
      }
    }
    entries.push({ name, method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.length === 0) throw new Error('zip 안에 파일이 없습니다');
  return entries;
}

function entryDataSlice(zip: Uint8Array, e: ZipEntry): Uint8Array {
  const p = e.localOff;
  if (u32(zip, p) !== 0x04034b50) throw new Error('zip 로컬 헤더 불일치: ' + e.name);
  const nameLen = u16(zip, p + 26);
  const extraLen = u16(zip, p + 28);
  const start = p + 30 + nameLen + extraLen;
  return zip.subarray(start, start + e.compSize);
}

// 엔트리 압축 데이터를 스트리밍 해제해 onChunk(Uint8Array, final)로 흘린다.
export async function inflateEntry(
  zip: Uint8Array, e: ZipEntry,
  onChunk: (chunk: Uint8Array, final: boolean) => void,
): Promise<void> {
  const comp = entryDataSlice(zip, e);
  if (e.method === 0) { onChunk(comp, true); return; }
  if (e.method !== 8) throw new Error('지원하지 않는 압축 방식(' + e.method + '): ' + e.name);
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const pump = (async () => {
    const S = 1 << 20;
    for (let o = 0; o < comp.length; o += S) {
      await writer.ready;
      const part = comp.slice(o, Math.min(o + S, comp.length));
      await writer.write(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
    }
    await writer.close();
  })();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) onChunk(value, false);
  }
  await pump;
  onChunk(new Uint8Array(0), true);
}

// 엔트리를 문자열로 완전 해제 (작은 부품: workbook/rels 전용)
export async function inflateEntryToString(zip: Uint8Array, e: ZipEntry): Promise<string> {
  const dec = new TextDecoder();
  let out = '';
  await inflateEntry(zip, e, (chunk, final) => { out += dec.decode(chunk, { stream: !final }); });
  return out;
}

// 엔트리를 바이트로 완전 해제 (내부 xlsx 추출용)
export async function inflateEntryToBytes(zip: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  await inflateEntry(zip, e, (chunk) => {
    if (chunk.length) { parts.push(chunk.slice()); total += chunk.length; }
  });
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
