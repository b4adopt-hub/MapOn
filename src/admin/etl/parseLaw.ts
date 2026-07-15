// eum.go.kr 법령정보 파일 → zoning_rates 행 생성.
// etl/load_luris.py의 parse_law를 브라우저용으로 포팅한 것. 파일이 작아(약 5.7만 행)
// 전량 메모리 처리 후 2-pass 기본율 판정을 수행한다.
// 출력 행: [sgg_code, zone_cd, zone_nm, rate_kind, category, rate_pct, rate_values,
//           ordinance, provision, enforce_dt, content, needs_review]

// 건폐율(BCR)·용적률(FAR) 법정 상한(국계법 시행령). 기본율이 이를 넘으면 검수 플래그.
const BCR_CAP: Record<string, number> = {
  UQA111: 50, UQA112: 50, UQA121: 60, UQA122: 60, UQA123: 50, UQA130: 70,
  UQA210: 90, UQA220: 80, UQA230: 70, UQA240: 80, UQA310: 70, UQA320: 70, UQA330: 70,
  UQA410: 20, UQA420: 20, UQA430: 20, UQB100: 40, UQB200: 20, UQB300: 20, UQC001: 20, UQD001: 20,
};
const FAR_CAP: Record<string, number> = {
  UQA111: 100, UQA112: 150, UQA121: 200, UQA122: 250, UQA123: 300, UQA130: 500,
  UQA210: 1500, UQA220: 1300, UQA230: 900, UQA240: 1100, UQA310: 300, UQA320: 350, UQA330: 400,
  UQA410: 80, UQA420: 100, UQA430: 100, UQB100: 100, UQB200: 80, UQB300: 80, UQC001: 80, UQD001: 80,
};

const PCT = /(\d+(?:\.\d+)?)\s*퍼센트/g;
const PCT100 = /100분의\s*(\d+(?:\.\d+)?)/g;
const ITEM = /^\s*\d+\.\s*(?:제?\d*종?\s*)?[가-힣·ㆍ0-9\s]+(?:지역|지구)\s*:\s*(\d+(?:\.\d+)?)\s*퍼센트\s*이하/;
const JO = /(제\d+조(?:의\d+)?)/;
const HANG = /제(\d+)항/;

function norm(s: string): string { return (s || '').replace(/[\s·ㆍ()]/g, ''); }

export type ZoningRow = [string, string, string, string, string, number | null, string, string, string, string | null, string, boolean];

interface Raw {
  code: string; zoneCd: string; zoneNm: string; kind: 'bcr' | 'far';
  jo: string; hang: string; prov: string; ordNm: string; dt: string;
  vals: number[]; selfMatch: boolean; itemVal: number | null; content: string;
}

// 시트 행들(헤더 제외, 배열의 배열)을 받아 zoning_rates 행을 만든다.
export function parseLawRows(rows: string[][]): ZoningRow[] {
  const raw: Raw[] = [];
  for (const r of rows) {
    const code = (r[4] ?? '').trim();
    if (!code || code === '00000') continue;
    const isBp = (r[9] ?? '').trim() === '○';
    const isYr = (r[10] ?? '').trim() === '○';
    if (!isBp && !isYr) continue;
    const content = String(r[11] ?? '');
    const prov = String(r[7] ?? '');
    const joM = JO.exec(prov);
    const hangM = HANG.exec(prov);
    const trimmed = content.trim();
    const itemM = ITEM.exec(trimmed);
    let zoneIn: string | null = null;
    if (itemM) {
      const head = trimmed.split(':')[0];
      const afterDot = head.split(/\.(.+)/)[1] ?? head;
      zoneIn = norm(afterDot);
    }
    const zoneNmNorm = norm(String(r[2] ?? ''));
    const selfMatch = !!itemM && !!zoneIn && (zoneIn.includes(zoneNmNorm) || zoneNmNorm.includes(zoneIn));
    const vals: number[] = [];
    let m: RegExpExecArray | null;
    PCT.lastIndex = 0;
    while ((m = PCT.exec(content)) !== null) vals.push(parseFloat(m[1]));
    PCT100.lastIndex = 0;
    while ((m = PCT100.exec(content)) !== null) vals.push(parseFloat(m[1]));
    for (const [kind, flag] of [['bcr', isBp], ['far', isYr]] as const) {
      if (!flag) continue;
      raw.push({
        code, zoneCd: String(r[1] ?? '').trim(), zoneNm: String(r[2] ?? '').trim(),
        kind, jo: joM ? joM[1] : '', hang: hangM ? hangM[1] : '0', prov: prov.trim(),
        ordNm: String(r[5] ?? '').trim(), dt: String(r[6] ?? '').trim(), vals,
        selfMatch, itemVal: itemM ? parseFloat(itemM[1]) : null, content,
      });
    }
  }

  // (1) 기본율 조항 = self_match 용도지역 수 최대 조번호
  const grp = new Map<string, Set<string>>();
  for (const x of raw) {
    if (!x.selfMatch) continue;
    const k = `${x.code}\u0001${x.kind}\u0001${x.jo}`;
    let set = grp.get(k);
    if (!set) { set = new Set(); grp.set(k, set); }
    set.add(x.zoneCd);
  }
  const baseJo = new Map<string, string>();
  for (const [k, zones] of grp) {
    const [code, kind, jo] = k.split('\u0001');
    const ck = `${code}\u0001${kind}`;
    const cur = baseJo.get(ck);
    if (cur === undefined || zones.size > (grp.get(`${ck}\u0001${cur}`)?.size ?? 0)) baseJo.set(ck, jo);
  }
  // (2) 그 조항 내 최빈 항 = 기본율 항 (특례 항 배제)
  const hangCnt = new Map<string, Map<string, number>>();
  for (const x of raw) {
    const ck = `${x.code}\u0001${x.kind}`;
    if (x.selfMatch && x.jo === baseJo.get(ck)) {
      let cnt = hangCnt.get(ck);
      if (!cnt) { cnt = new Map(); hangCnt.set(ck, cnt); }
      cnt.set(x.hang, (cnt.get(x.hang) ?? 0) + 1);
    }
  }
  const baseHang = new Map<string, string>();
  for (const [ck, cnt] of hangCnt) {
    let best = '', bestN = -1;
    for (const [h, n] of cnt) if (n > bestN) { bestN = n; best = h; }
    baseHang.set(ck, best);
  }

  const out: ZoningRow[] = [];
  for (const x of raw) {
    const ck = `${x.code}\u0001${x.kind}`;
    const isBase = x.selfMatch && x.jo === baseJo.get(ck) && x.hang === baseHang.get(ck);
    const cap = (x.kind === 'bcr' ? BCR_CAP : FAR_CAP)[x.zoneCd];
    const review = !!(isBase && cap && x.itemVal && x.itemVal > cap);
    const dt = x.dt;
    const enforce = dt.length === 8 && /^\d+$/.test(dt) ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}` : null;
    // Python str(float) 포맷과 맞춘다 (정수도 '40.0')
    const valsStr = x.vals.map((v) => (Number.isInteger(v) ? v.toFixed(1) : String(v))).join(';').slice(0, 200);
    out.push([
      x.code, x.zoneCd, x.zoneNm, x.kind,
      isBase ? 'base' : 'special',
      isBase ? x.itemVal : null,
      valsStr,
      x.ordNm.slice(0, 200), x.prov.slice(0, 100),
      enforce, x.content.slice(0, 2000), review,
    ]);
  }
  return out;
}
