// MapOn: 전국폐기물처리업소 표준데이터 적재 Edge Function (v1, 관리자 실행)
// 소스: 공공데이터포털 전국폐기물처리업소표준데이터(15114147)
//   요청주소: http://api.data.go.kr/openapi/tn_pubr_public_tret_was_api
//   응답: response.body.items[] (표준데이터 공통 규격)
// 흐름:
//   1) DATA_GO_KR_KEY로 pageNo 1..N 순회(numOfRows=1000, type=json)
//   2) 업종명이 "수집및운반업"(트럭 운반업체=실제 시설 아님)이면 제외
//   3) 실제 처리·처분 시설만 업종명→HAZARD_TIERS type 매핑
//   4) 위경도 그대로 hazard_facilities에 src_key 기준 upsert
// 실행: POST { startPage?, maxPages? } — 관리자 전용. 대량이라 시간이 걸릴 수 있어
//   maxPages로 분할 실행 가능(응답 done=false면 nextPage로 이어서 호출).
//
// 시크릿: DATA_GO_KR_KEY(필수, 공공데이터포털 서비스키 — 디코딩된 원본키),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY(기본 주입).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const API = 'http://api.data.go.kr/openapi/tn_pubr_public_tret_was_api';
const ROWS = 1000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// 응답 객체에서 후보 키들 중 처음 값이 있는 것을 집는다(표준데이터 필드명 방어).
function pick(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// 업종명 → HAZARD_TIERS type. 실제 처리·처분 시설만. 운반업은 null(제외).
function mapType(industry: string): string | null {
  const s = industry.replace(/\s/g, '');
  if (!s) return null;
  // 수집·운반업(트럭 업체)은 실제 혐오시설이 아니므로 제외
  if (s.includes('수집') || s.includes('운반')) return null;
  // 매립 성격(최종처분·종합처분)은 landfill, 소각 성격은 incinerator로 세분하고 싶으나
  // 표준데이터 업종명만으로는 매립/소각 구분이 어려워 처분업은 landfill(강한 tier)로,
  // 재활용·중간처분 등 나머지 처리시설은 waste로 둔다(보수적).
  if (s.includes('종합처분') || s.includes('최종처분') || s.includes('매립')) return 'landfill';
  if (s.includes('소각')) return 'incinerator';
  if (s.includes('처분') || s.includes('재활용') || s.includes('처리')) return 'waste';
  return 'waste';
}

// 시도/시군구 추출(주소 앞 두 토큰)
function splitRegion(addr: string): { sido: string; sigungu: string } {
  const t = addr.split(/\s+/).filter(Boolean);
  return { sido: t[0] ?? '', sigungu: t[1] ?? '' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const startPage: number = Number(body.startPage) > 0 ? Number(body.startPage) : 1;
    const maxPages: number = Number(body.maxPages) > 0 ? Number(body.maxPages) : 100;

    const KEY = Deno.env.get('DATA_GO_KR_KEY');
    if (!KEY) return json({ error: 'no_key', message: 'DATA_GO_KR_KEY 시크릿이 설정되지 않았습니다.' }, 400);

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    let page = startPage;
    let totalCount = 0;
    let fetched = 0;
    let inserted = 0;
    let skippedTransport = 0;
    let skippedNoCoord = 0;
    const pagesRun: number[] = [];

    for (let i = 0; i < maxPages; i++) {
      const url = `${API}?serviceKey=${encodeURIComponent(KEY)}&pageNo=${page}&numOfRows=${ROWS}&type=json`;
      const r = await fetch(url);
      const text = await r.text();

      let data: any;
      try { data = JSON.parse(text); }
      catch { return json({ error: 'parse', message: 'API 응답이 JSON이 아닙니다(키/트래픽 확인).', sample: text.slice(0, 300), page }, 502); }

      const resp = data?.response ?? data;
      const header = resp?.header ?? {};
      const bodyR = resp?.body ?? {};
      const code = header.resultCode ?? header.resultcode ?? '00';
      if (code && String(code) !== '00') {
        return json({ error: 'api', message: header.resultMsg ?? header.resultmsg ?? 'API 오류', code, page }, 502);
      }

      totalCount = Number(bodyR.totalCount ?? bodyR.totalcount ?? 0) || totalCount;
      let items: any[] = bodyR.items ?? [];
      // 표준데이터는 items가 배열이거나 {item:[...]}일 수 있음
      if (items && !Array.isArray(items) && Array.isArray(items.item)) items = items.item;
      if (!Array.isArray(items)) items = [];

      if (items.length === 0) { pagesRun.push(page); break; }
      fetched += items.length;

      const rows: Record<string, unknown>[] = [];
      for (const it of items) {
        const name = pick(it, ['시설명', 'fcltyNm', 'bplcNm', 'cmpnyNm', 'instNm', 'bizPlaceNm']);
        const roadAddr = pick(it, ['소재지도로명주소', 'rnAddr', 'roadNmAddr', 'lctnRoadNmAddr']);
        const jibunAddr = pick(it, ['소재지지번주소', 'lnmAddr', 'lctnLotnoAddr', 'addr']);
        const addr = roadAddr || jibunAddr;
        const industry = pick(it, ['업종명', 'indutypeNm', 'bizCondNm', 'induty']);
        const latS = pick(it, ['위도', 'lat', 'latitude', 'y', 'yCrdnt']);
        const lngS = pick(it, ['경도', 'lot', 'lng', 'longitude', 'x', 'xCrdnt']);

        const type = mapType(industry);
        if (!type) { skippedTransport++; continue; }

        const lat = Number(latS), lng = Number(lngS);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 32 || lat > 40 || lng < 124 || lng > 132) {
          skippedNoCoord++; continue;
        }

        const { sido, sigungu } = splitRegion(addr);
        // 안정적 식별키: 좌표(소수5자리)+시설명. 재적재 시 upsert로 중복 방지.
        const srcKey = `waste:${lat.toFixed(5)},${lng.toFixed(5)}:${name}`.slice(0, 300);

        rows.push({
          type,
          name: name || null,
          address: addr || null,
          lat, lng,
          sido: sido || null,
          sigungu: sigungu || null,
          source: '공공데이터포털 전국폐기물처리업소표준데이터',
          src_key: srcKey,
        });
      }

      if (rows.length) {
        const { error } = await sb
          .from('hazard_facilities')
          .upsert(rows, { onConflict: 'src_key', ignoreDuplicates: false });
        if (error) return json({ error: 'db', message: error.message, page }, 500);
        inserted += rows.length;
      }

      pagesRun.push(page);
      page++;

      // 마지막 페이지 판단: 가져온 누적이 totalCount 이상이면 종료
      if (totalCount && fetched >= totalCount) break;
    }

    const done = !totalCount || fetched >= totalCount;
    return json({
      ok: true,
      totalCount,
      fetched,
      insertedOrUpdated: inserted,
      skippedTransport,   // 수집·운반업(제외)
      skippedNoCoord,     // 좌표 이상(제외)
      pagesRun,
      done,
      nextPage: done ? null : page,   // done=false면 이 값으로 다시 호출해 이어서 적재
    });
  } catch (e) {
    return json({ error: 'unexpected', message: e instanceof Error ? e.message : String(e) }, 500);
  }
});
