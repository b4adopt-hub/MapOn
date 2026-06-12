import { useState } from 'react';
import { diagnose, LandInput } from './engine/diagnose';
import { Purpose, PURPOSE_LABELS } from './engine/purposes';
import { supabase, supabaseReady } from './lib/supabase';

const PURPOSES = Object.keys(PURPOSE_LABELS) as Purpose[];

const ZONE_OPTIONS = [
  '계획관리지역',
  '생산관리지역',
  '보전관리지역',
  '농림지역',
  '자연환경보전지역',
  '제1종일반주거지역',
  '자연녹지지역',
  '생산녹지지역',
  '보전녹지지역',
];

const JIMOK_OPTIONS = ['대', '전', '답', '임야', '잡종지', '과수원'];

const REGULATION_OPTIONS = [
  '농업진흥구역',
  '보전산지',
  '개발제한구역',
  '상수원보호구역',
  '군사시설보호구역',
  '자연보전권역',
  '가축사육제한구역',
];

const GRADE_COLOR: Record<string, string> = {
  '가능성 높음': '#1a7f4b',
  '조건부 검토': '#2d6cb8',
  '전문가 확인 필요': '#b8862d',
  '리스크 높음': '#c2622d',
  '불가 가능성 높음': '#b83a3a',
};

const LEVEL_COLOR: Record<string, string> = {
  info: '#6b7280',
  caution: '#b8862d',
  warning: '#b83a3a',
};

/** land-lookup Edge Function 응답 타입 */
interface UseZone {
  name: string;
  code: string;
  conflict: string;
  isPrimary: boolean;
}
interface LandLookup {
  pnu: string | null;
  address: string | null;
  jimok: string | null;
  areaSqm: number | null;
  areaPyeong: number | null;
  officialPrice: number | null;
  primaryUseZone: string | null;
  useZones: UseZone[];
  regulations: string[];
  lat: number | null;
  lng: number | null;
  geomBoundary: unknown | null;
  cached: boolean;
  note?: string;
  error?: string;
  message?: string;
}

const FUNCTION_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined)
    ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/land-lookup`
    : 'https://irijchducsbsohzocmbk.supabase.co/functions/v1/land-lookup';

export default function App() {
  // 토지 조회
  const [address, setAddress] = useState('경기도 가평군 상면 비룡로 2268-38');
  const [looking, setLooking] = useState(false);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [land, setLand] = useState<LandLookup | null>(null);

  // 진단 입력(토지 조회 결과로 자동 채움 + 수동 보정 가능)
  const [useZoneRaw, setUseZone] = useState('계획관리지역');
  const [jimok, setJimok] = useState('대');
  const [areaSqm, setArea] = useState('990');
  const [slope, setSlope] = useState('5');
  const [regs, setRegs] = useState<string[]>([]);
  const [purpose, setPurpose] = useState<Purpose>('house');
  const [result, setResult] = useState<ReturnType<typeof diagnose> | null>(null);

  function toggleReg(r: string) {
    setRegs((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));
  }

  /** 규제 문자열에서 "(포함)" 같은 꼬리표 제거하고 알려진 규제만 선별 */
  function normalizeRegs(raw: string[]): string[] {
    const out = new Set<string>();
    for (const r of raw) {
      const name = r.replace(/\(.*\)$/, '').trim();
      // 도시지역 대분류는 규제가 아니므로 제외
      if (name === '도시지역' || name.includes('입안중')) continue;
      out.add(name);
    }
    return [...out];
  }

  async function lookup() {
    if (!address.trim()) return;
    setLooking(true);
    setLookupErr(null);
    setResult(null);
    try {
      let data: LandLookup;
      if (supabaseReady && supabase) {
        const res = await supabase.functions.invoke('land-lookup', {
          body: { address: address.trim() },
        });
        if (res.error) throw new Error(res.error.message);
        data = res.data as LandLookup;
      } else {
        // anon 키 미설정 환경: 직접 fetch (함수는 verify_jwt=false)
        const r = await fetch(FUNCTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: address.trim() }),
        });
        data = (await r.json()) as LandLookup;
      }

      if (data.error) {
        setLookupErr(data.message || data.error);
        setLand(null);
        return;
      }
      if (!data.pnu) {
        setLookupErr(data.note || '해당 주소의 필지를 찾지 못했습니다.');
        setLand(null);
        return;
      }

      setLand(data);
      // 진단 입력 자동 채움
      if (data.primaryUseZone) setUseZone(data.primaryUseZone);
      if (data.jimok) setJimok(data.jimok);
      if (data.areaSqm != null) setArea(String(Math.round(data.areaSqm)));
      setRegs(normalizeRegs(data.regulations || []));
    } catch (e) {
      setLookupErr(e instanceof Error ? e.message : String(e));
      setLand(null);
    } finally {
      setLooking(false);
    }
  }

  function run() {
    const input: LandInput = {
      pnu: land?.pnu ?? undefined,
      address: land?.address ?? address,
      useZoneRaw,
      jimok,
      areaSqm: areaSqm ? Number(areaSqm) : null,
      slopePercent: slope ? Number(slope) : null,
      regulations: regs.length ? regs : null,
    };
    setResult(diagnose(input, purpose));
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="brand">MapOn</div>
        <h1>지번을 넣기 전에, 먼저 살핍니다</h1>
        <p className="sub">
          주소만 넣으면 용도지역·지목·면적·규제를 자동 조회해 활용 가능성을 등급으로 보여줍니다.
          확정 판정이 아닌 사전검토입니다.
        </p>
        <div className={`status ${supabaseReady ? 'on' : 'off'}`}>
          {supabaseReady ? 'Supabase 연결됨' : '직접 호출 모드 (anon 키 미설정)'}
        </div>
      </header>

      {/* 1단계: 주소로 토지 조회 */}
      <section className="form">
        <div className="field">
          <label>토지 주소 (도로명 또는 지번)</label>
          <div className="lookup-row">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="예) 경기도 가평군 상면 비룡로 2268-38"
              onKeyDown={(e) => { if (e.key === 'Enter') lookup(); }}
            />
            <button className="run lookup-btn" onClick={lookup} disabled={looking}>
              {looking ? '조회 중…' : '토지 조회'}
            </button>
          </div>
          {lookupErr && <div className="lookup-err">{lookupErr}</div>}
        </div>

        {land && (
          <div className="land-card">
            <div className="land-head">
              <div className="land-addr">{land.address}</div>
              <div className="land-pnu">PNU {land.pnu}{land.cached ? ' · 캐시' : ''}</div>
            </div>
            <div className="land-grid">
              <div><span>지목</span><strong>{land.jimok ?? '-'}</strong></div>
              <div><span>면적</span><strong>{land.areaSqm != null ? `${Math.round(land.areaSqm).toLocaleString()}㎡ (${land.areaPyeong}평)` : '-'}</strong></div>
              <div><span>공시지가</span><strong>{land.officialPrice != null ? `${land.officialPrice.toLocaleString()}원/㎡` : '-'}</strong></div>
              <div><span>대표 용도지역</span><strong>{land.primaryUseZone ?? '-'}</strong></div>
            </div>
            {land.useZones?.length > 0 && (
              <div className="zone-tags">
                {land.useZones.map((z) => (
                  <span key={z.code} className={`zone-tag ${z.isPrimary ? 'primary' : ''}`}>
                    {z.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 2단계: 진단 입력(자동 채움 + 보정) */}
      <section className="form">
        <div className="field">
          <label>용도지역 {land && <em className="auto">자동</em>}</label>
          <select value={useZoneRaw} onChange={(e) => setUseZone(e.target.value)}>
            {ZONE_OPTIONS.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
            {!ZONE_OPTIONS.includes(useZoneRaw) && (
              <option value={useZoneRaw}>{useZoneRaw}</option>
            )}
          </select>
        </div>

        <div className="row">
          <div className="field">
            <label>지목 {land && <em className="auto">자동</em>}</label>
            <select value={jimok} onChange={(e) => setJimok(e.target.value)}>
              {JIMOK_OPTIONS.map((j) => (
                <option key={j} value={j}>{j}</option>
              ))}
              {!JIMOK_OPTIONS.includes(jimok) && <option value={jimok}>{jimok}</option>}
            </select>
          </div>
          <div className="field">
            <label>면적 (㎡) {land && <em className="auto">자동</em>}</label>
            <input value={areaSqm} onChange={(e) => setArea(e.target.value)} inputMode="numeric" />
          </div>
          <div className="field">
            <label>평균 경사 (%)</label>
            <input value={slope} onChange={(e) => setSlope(e.target.value)} inputMode="numeric" />
          </div>
        </div>

        <div className="field">
          <label>목적</label>
          <div className="chips">
            {PURPOSES.map((p) => (
              <button
                key={p}
                className={`chip ${purpose === p ? 'active' : ''}`}
                onClick={() => setPurpose(p)}
              >
                {PURPOSE_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>규제 {land && <em className="auto">자동</em>}</label>
          <div className="chips">
            {REGULATION_OPTIONS.map((r) => (
              <button
                key={r}
                className={`chip ${regs.includes(r) ? 'active warn' : ''}`}
                onClick={() => toggleReg(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <button className="run" onClick={run}>사전검토 실행</button>
      </section>

      {result && (
        <section className="result">
          <div className="grade-card">
            <div className="grade-label">{result.purposeLabel}</div>
            <div className="grade" style={{ color: GRADE_COLOR[result.gradeLabel] }}>
              {result.gradeLabel}
            </div>
            {result.zone && (
              <div className="zone-meta">
                {result.zone.name} · 건폐율 {result.zone.bcrMax}% · 용적률 {result.zone.farMax}%
              </div>
            )}
          </div>

          {result.estCostMin != null && (
            <div className="cost">
              예비 견적 범위{' '}
              <strong>
                {result.estCostMin.toLocaleString()} ~ {result.estCostMax!.toLocaleString()}원
              </strong>
            </div>
          )}

          <div className="risks">
            <h3>검토 항목</h3>
            {result.riskItems.map((ri) => (
              <div key={ri.key} className="risk">
                <span className="dot" style={{ background: LEVEL_COLOR[ri.level] }} />
                <div>
                  <div className="risk-label">{ri.label}</div>
                  <div className="risk-note">{ri.note}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="recs">
            <h3>추천 시설물</h3>
            <div className="chips">
              {result.recommendations.map((r) => (
                <span key={r} className="chip static">{r}</span>
              ))}
            </div>
          </div>

          <p className="disclaimer">{result.disclaimer}</p>
        </section>
      )}

      <footer className="foot">
        MapOn · 토지 활용 사전검토 플랫폼 · 본 서비스의 경계·등급 정보는 참고용이며 법적 확정 판정이 아닙니다.
      </footer>
    </div>
  );
}
