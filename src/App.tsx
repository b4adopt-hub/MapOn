import { useState } from 'react';
import { diagnose, LandInput } from './engine/diagnose';
import { Purpose, PURPOSE_LABELS } from './engine/purposes';
import { supabaseReady } from './lib/supabase';

const PURPOSES = Object.keys(PURPOSE_LABELS) as Purpose[];

const ZONE_OPTIONS = [
  '계획관리지역',
  '생산관리지역',
  '보전관리지역',
  '농림지역',
  '자연환경보전지역',
  '제1종일반주거지역',
  '자연녹지지역',
];

const JIMOK_OPTIONS = ['대', '전', '답', '임야', '잡종지', '과수원'];

const REGULATION_OPTIONS = [
  '농업진흥구역',
  '보전산지',
  '개발제한구역',
  '상수원보호구역',
  '군사시설보호구역',
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

export default function App() {
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

  function run() {
    const input: LandInput = {
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
        <h1>지번을 넣기 전에, 먼저 살폽니다</h1>
        <p className="sub">
          용도지역·지목·규제를 사전검토해 활용 가능성을 등급으로 보여줍니다.
          확정 판정이 아닌 사전검토입니다.
        </p>
        <div className={`status ${supabaseReady ? 'on' : 'off'}`}>
          {supabaseReady ? 'Supabase 연결됨' : '데모 모드 (엔진 직접 실행 · API 미연동)'}
        </div>
      </header>

      <section className="form">
        <div className="field">
          <label>용도지역</label>
          <select value={useZoneRaw} onChange={(e) => setUseZone(e.target.value)}>
            {ZONE_OPTIONS.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </div>

        <div className="row">
          <div className="field">
            <label>지목</label>
            <select value={jimok} onChange={(e) => setJimok(e.target.value)}>
              {JIMOK_OPTIONS.map((j) => (
                <option key={j} value={j}>{j}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>면적 (㎡)</label>
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
          <label>규제 (해당 시 선택)</label>
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
