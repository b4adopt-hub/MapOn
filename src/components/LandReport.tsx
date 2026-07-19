import { useEffect, useMemo } from 'react';

/**
 * 토지 사전검토 리포트(인쇄·PDF 저장용 전용 뷰).
 *
 * 설계 의도
 *  - 별도 PDF 라이브러리를 쓰지 않고 브라우저 인쇄(→ "PDF로 저장")를 사용한다.
 *    한글 폰트 임베딩 문제가 없고, 텍스트가 벡터로 남아 확대해도 선명하며,
 *    모바일 크롬/사파리에서도 동일하게 동작하기 때문이다.
 *  - 화면(App)의 상태를 그대로 받아 재계산 없이 렌더한다. 리포트는 "그 시점의 스냅샷".
 *  - 그래프·도식은 외부 차트 라이브러리 없이 SVG/CSS로 직접 그린다(인쇄 색 보존).
 */

export interface ReportHazard {
  type: string;
  typeLabel: string;
  name: string | null;
  distanceM: number;
}

export interface ReportScoreItem {
  key: string;
  label: string;
  score: number | null;
}

export interface ReportScoreGroup {
  category: string;
  label: string;
  items: ReportScoreItem[];
}

export interface ReportRisk {
  key: string;
  label: string;
  note: string;
  level: string;
}

export interface ReportRuleResult {
  purpose: string;
  purposeLabel: string;
  gradeLabel: string;
  gradeDescription: string;
  zoneName: string | null;
  bcrMax: number | null;
  farMax: number | null;
  riskItems: ReportRisk[];
  recommendations: string[];
}

export interface ReportInfraItem {
  key: string;
  title: string;
  grade: string;          // A~D 데이터 등급
  danger: number | null;  // 1~5 위험 순위(있으면 상단 정렬)
  rel: number;            // 활용 목적 관련도 2=핵심 1=일반 0=영향 적음
  lead: string;
  items: string[];
  purposeNote: string | null;
  contact: string;
  existing: boolean;      // 기존 건물 기준으로 본문이 교체된 항목인지
}

export interface ReportOrdinanceItem {
  key: string;
  label: string;
  note: string;
  level: string;
  source?: string | null;
}

export interface LandReportProps {
  onClose: () => void;
  /** 열리자마자 인쇄 대화상자를 띄울지 */
  autoPrint?: boolean;

  address: string | null;
  pnu: string | null;
  jimok: string | null;
  areaSqm: number | null;
  areaPyeong: number | null;
  officialPrice: number | null;
  primaryUseZone: string | null;
  useZoneNames: string[];
  regulations: string[];
  roadSide: string | null;
  topographyHeight: string | null;
  topographyShape: string | null;
  landUse: string | null;
  slopePercent: number | null;

  hasBuilding: boolean | null;
  buildingPurpose: string | null;
  buildingUseAprDay: string | null;
  buildingViolation: boolean | null;

  overall: number | null;
  overallMin: number | null;
  overallMax: number | null;
  caps: string[];
  groups: ReportScoreGroup[];

  hazards: ReportHazard[] | null;
  infraItems: ReportInfraItem[];

  freeText: string;
  ruleResults: ReportRuleResult[];
  ordinanceSgg: string | null;
  ordinanceItems: ReportOrdinanceItem[];
  aiText: string | null;

  disclaimer: string;
}

const GRADE_COLOR: Record<string, string> = {
  '가능성 높음': '#1a7f4b',
  '조건부 검토': '#2d6cb8',
  '전문가 확인 필요': '#b8862d',
  '리스크 높음': '#c2622d',
  '불가 가능성 높음': '#b83a3a',
};

const GRADE_DESC: Record<string, string> = {
  A: '자동 확정', B: '자동 추정', C: '기관 확인', D: '현장 확인',
};

function scoreColor(v: number): string {
  return v >= 70 ? '#1a7f4b' : v >= 45 ? '#b8862d' : '#c2622d';
}

function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

function fmtDate(yyyymmdd: string | null): string {
  if (!yyyymmdd) return '-';
  const d = yyyymmdd.replace(/[^0-9]/g, '');
  if (d.length !== 8) return yyyymmdd;
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
}

/**
 * 주변 혐오·기피시설 거리 도식.
 * 방위 정보는 없으므로 "거리"만 정확히 표현한다 —
 * 동심원(반경 눈금) 위에 시설을 균등 각도로 배치해 상대 거리를 직관적으로 보여준다.
 */
function HazardDiagram({ hazards }: { hazards: ReportHazard[] }) {
  const size = 320;
  const cx = size / 2;
  const cy = size / 2;
  const rMax = 132;
  // 눈금 반경(m): 가장 먼 시설을 기준으로 500/1000/2000 중 적절히
  const maxM = Math.max(500, ...hazards.map((h) => h.distanceM));
  const rings = maxM <= 700 ? [250, 500, 700] : maxM <= 1500 ? [500, 1000, 1500] : [1000, 2000, 3000];
  const scale = (m: number) => Math.min(rMax, (m / rings[rings.length - 1]) * rMax);

  return (
    <svg className="rp-diagram" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="주변 혐오·기피시설 거리 도식">
      {rings.map((r) => (
        <g key={r}>
          <circle cx={cx} cy={cy} r={scale(r)} fill="none" stroke="#d9d4c9" strokeWidth="1" strokeDasharray="3 3" />
          <text x={cx + 3} y={cy - scale(r) + 11} className="rp-diagram-ring">
            {r >= 1000 ? `${r / 1000}km` : `${r}m`}
          </text>
        </g>
      ))}
      {/* 대상 필지 */}
      <circle cx={cx} cy={cy} r="6" fill="#1f5c4d" />
      <text x={cx} y={cy + 20} textAnchor="middle" className="rp-diagram-self">대상 필지</text>

      {hazards.map((h, i) => {
        const angle = (i / Math.max(1, hazards.length)) * Math.PI * 2 - Math.PI / 2;
        const r = scale(h.distanceM);
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        const labelX = cx + Math.cos(angle) * (r + 16);
        const labelY = cy + Math.sin(angle) * (r + 16);
        const anchor = Math.abs(Math.cos(angle)) < 0.3 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end';
        return (
          <g key={i}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="#c2622d" strokeWidth="1" opacity="0.45" />
            <circle cx={x} cy={y} r="4.5" fill="#c2622d" />
            <text x={labelX} y={labelY} textAnchor={anchor} className="rp-diagram-label">
              {h.typeLabel} {fmtDist(h.distanceM)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** 종합 점수 게이지(최저~최고 범위와 현재 점수를 한 줄로) */
function OverallGauge({ overall, min, max }: { overall: number; min: number | null; max: number | null }) {
  const lo = min ?? overall;
  const hi = max ?? overall;
  return (
    <div className="rp-gauge">
      <div className="rp-gauge-track">
        <div className="rp-gauge-range" style={{ left: `${lo}%`, width: `${Math.max(0, hi - lo)}%` }} />
        <div className="rp-gauge-mark" style={{ left: `${overall}%`, background: scoreColor(overall) }} />
      </div>
      <div className="rp-gauge-scale">
        <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
      </div>
      <div className="rp-gauge-legend">
        <span className="rp-gauge-cur" style={{ color: scoreColor(overall) }}>현재 {overall}점</span>
        {min != null && max != null && (
          <span className="rp-gauge-rng">가능 범위 {min} ~ {max}점 (미확정 항목 반영)</span>
        )}
      </div>
    </div>
  );
}

export default function LandReport(props: LandReportProps) {
  const {
    onClose, autoPrint = true,
    address, pnu, jimok, areaSqm, areaPyeong, officialPrice, primaryUseZone,
    useZoneNames, regulations, roadSide, topographyHeight, topographyShape, landUse, slopePercent,
    hasBuilding, buildingPurpose, buildingUseAprDay, buildingViolation,
    overall, overallMin, overallMax, caps, groups,
    hazards, infraItems, freeText, ruleResults, ordinanceSgg, ordinanceItems, aiText, disclaimer,
  } = props;

  const issuedAt = useMemo(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }, []);

  // 열리면 인쇄 대화상자를 띄우고, 인쇄가 끝나면(또는 취소되면) 리포트를 닫는다.
  useEffect(() => {
    document.body.classList.add('rp-printing');
    const after = () => onClose();
    window.addEventListener('afterprint', after);
    let t: number | undefined;
    if (autoPrint) {
      // 레이아웃이 그려진 뒤 인쇄해야 그래프가 누락되지 않는다.
      t = window.setTimeout(() => window.print(), 350);
    }
    return () => {
      document.body.classList.remove('rp-printing');
      window.removeEventListener('afterprint', after);
      if (t) window.clearTimeout(t);
    };
  }, [autoPrint, onClose]);

  const sortedHazards = hazards ? [...hazards].sort((a, b) => a.distanceM - b.distanceM) : null;

  return (
    <div className="rp-overlay" role="dialog" aria-label="토지 사전검토 리포트">
      <div className="rp-toolbar no-print">
        <button className="rp-btn" onClick={() => window.print()}>인쇄 · PDF로 저장</button>
        <button className="rp-btn ghost" onClick={onClose}>닫기</button>
        <span className="rp-toolbar-hint">인쇄 대화상자에서 대상을 <b>"PDF로 저장"</b>으로 선택하세요.</span>
      </div>

      <article className="rp-page">
        <header className="rp-head">
          <div className="rp-brand">
            <svg className="rp-pin" viewBox="0 0 36 46" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M18 2C10 2 3.5 8.5 3.5 16.5c0 9.5 12 22 13.4 23.4a1.5 1.5 0 0 0 2.2 0C20.5 38.5 32.5 26 32.5 16.5 32.5 8.5 26 2 18 2z" fill="#1f5c4d" />
              <path d="M11 18.5L18 12l7 6.5V25a1 1 0 0 1-1 1h-4v-4h-4v4h-4a1 1 0 0 1-1-1v-6.5z" fill="#fff" />
            </svg>
            <span className="rp-brand-text">맵<span className="rp-brand-ddang">땅</span></span>
          </div>
          <div className="rp-head-meta">
            <div className="rp-doc-title">토지 활용 사전검토 리포트</div>
            <div className="rp-issued">발행 {issuedAt}</div>
          </div>
        </header>

        <section className="rp-addr-block">
          <h1 className="rp-addr">{address ?? '-'}</h1>
          <div className="rp-pnu">PNU {pnu ?? '-'}</div>
        </section>

        {/* 1. 토지 개요 */}
        <section className="rp-sec">
          <h2 className="rp-sec-title"><span className="rp-num">1</span>토지 개요</h2>
          <table className="rp-table">
            <tbody>
              <tr>
                <th>지목</th><td>{jimok ?? '-'}</td>
                <th>면적</th><td>{areaSqm != null ? `${Math.round(areaSqm).toLocaleString()}㎡ (${areaPyeong ?? '-'}평)` : '-'}</td>
              </tr>
              <tr>
                <th>공시지가</th><td>{officialPrice != null ? `${officialPrice.toLocaleString()}원/㎡` : '-'}</td>
                <th>대표 용도지역</th><td>{primaryUseZone ?? '-'}</td>
              </tr>
              <tr>
                <th>도로접면(공부)</th><td>{roadSide ?? '-'}</td>
                <th>평균 경사</th><td>{slopePercent != null ? `${slopePercent}%` : '-'}</td>
              </tr>
              <tr>
                <th>지형고저</th><td>{topographyHeight ?? '-'}</td>
                <th>토지형상</th><td>{topographyShape ?? '-'}</td>
              </tr>
              <tr>
                <th>이용상황</th><td>{landUse ?? '-'}</td>
                <th>건축물</th>
                <td>
                  {hasBuilding == null ? '확인 필요'
                    : hasBuilding
                      ? `있음${buildingPurpose ? ` · ${buildingPurpose}` : ''}${buildingUseAprDay ? ` (사용승인 ${fmtDate(buildingUseAprDay)})` : ''}${buildingViolation ? ' · 위반건축물' : ''}`
                      : '건축물대장상 없음'}
                </td>
              </tr>
            </tbody>
          </table>
          {useZoneNames.length > 0 && (
            <p className="rp-inline-list"><b>용도지역지구</b> {useZoneNames.join(' · ')}</p>
          )}
          {regulations.length > 0 && (
            <p className="rp-inline-list"><b>규제 · 구역</b> {regulations.join(' · ')}</p>
          )}
        </section>

        {/* 2. 기반시설 · 사용성 확인 항목(10개 전체) */}
        {infraItems.length > 0 && (
          <section className="rp-sec rp-break">
            <h2 className="rp-sec-title"><span className="rp-num">2</span>기반시설 · 사용성 확인 항목</h2>
            <p className="rp-lead">
              토지 활용 전 확인해야 할 기반시설 {infraItems.length}개 항목을 <b>위험 순</b>으로 정렬했습니다.
              공공데이터로 알 수 있는 것과 기관·현장 확인이 필요한 것을 등급(A 자동 확정 / B 자동 추정 / C 기관 확인 / D 현장 확인)으로 구분합니다.
            </p>
            {infraItems.map((g) => (
              <div key={g.key} className={`rp-infra${g.rel >= 2 ? ' core' : ''}`}>
                <div className="rp-infra-head">
                  <span className="rp-infra-title">
                    {g.rel >= 2 && <span className="rp-infra-star">●</span>}
                    {g.title}
                  </span>
                  <span className="rp-infra-tags">
                    <span className={`rp-infra-grade g-${g.grade.toLowerCase()}`}>{g.grade} {GRADE_DESC[g.grade] ?? ''}</span>
                    {g.rel >= 2 && <span className="rp-infra-tag core">이 활용에 핵심</span>}
                    {g.rel === 0 && <span className="rp-infra-tag minor">영향 적음</span>}
                    {g.existing && <span className="rp-infra-tag exist">기존 시설</span>}
                  </span>
                </div>
                <p className="rp-infra-lead">{g.lead}</p>
                <ul className="rp-infra-list">
                  {g.items.map((it, i) => (<li key={i}>{it}</li>))}
                </ul>
                {g.purposeNote && (
                  <div className="rp-infra-note">{g.existing ? '참고' : '용도 주의'}: {g.purposeNote}</div>
                )}
                <div className="rp-infra-contact">확인처: {g.contact}</div>
              </div>
            ))}
          </section>
        )}

        {/* 3. 활용성 점수 */}
        {overall != null && (
          <section className="rp-sec">
            <h2 className="rp-sec-title"><span className="rp-num">3</span>토지 활용성 점수</h2>
            <p className="rp-lead">
              목적과 무관하게 이 토지 자체의 조건을 감정평가·투자 실무 기준으로 항목별 평가한 점수입니다.
              맹지·개발제한·급경사처럼 개발을 막는 <b>치명적 결함</b>은 다른 장점으로 상쇄하지 않고 종합 점수에 상한을 씌워 보수적으로 반영합니다.
            </p>

            <div className="rp-overall">
              <div className="rp-overall-num" style={{ color: scoreColor(overall) }}>
                {overall}<small>점</small>
              </div>
              <OverallGauge overall={overall} min={overallMin} max={overallMax} />
            </div>

            {caps.length > 0 && (
              <div className="rp-caps">
                <div className="rp-caps-title">종합 점수를 끌어내린 치명적 결함</div>
                <ul>{caps.map((c, i) => <li key={i}>{c}</li>)}</ul>
              </div>
            )}

            {groups.map((g) => (
              <div key={g.category} className="rp-score-group">
                <div className="rp-score-group-title">{g.label}</div>
                {g.items.map((it) => (
                  <div key={it.key} className="rp-score-row">
                    <span className="rp-score-label">{it.label}</span>
                    <span className="rp-score-track">
                      <span className="rp-score-fill" style={{ width: `${it.score ?? 0}%`, background: scoreColor(it.score ?? 0) }} />
                    </span>
                    <span className="rp-score-num">{it.score}</span>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}

        {/* 4. 주변 혐오·기피시설 */}
        {sortedHazards && (
          <section className="rp-sec rp-break">
            <h2 className="rp-sec-title"><span className="rp-num">4</span>주변 혐오 · 기피시설</h2>
            {sortedHazards.length === 0 ? (
              <p className="rp-lead">반경 내 조회된 혐오·기피시설이 없습니다. 다만 공공데이터에 등록되지 않은 축사·묘지 등이 있을 수 있어 현장 확인을 권장합니다.</p>
            ) : (
              <>
                <div className="rp-hazard-wrap">
                  <HazardDiagram hazards={sortedHazards} />
                  <table className="rp-table rp-hazard-table">
                    <thead>
                      <tr><th>거리</th><th>유형</th><th>시설명</th></tr>
                    </thead>
                    <tbody>
                      {sortedHazards.map((h, i) => (
                        <tr key={i}>
                          <td className="rp-hz-dist">{fmtDist(h.distanceM)}</td>
                          <td>{h.typeLabel}</td>
                          <td>{h.name ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="rp-note">
                  혐오·기피시설 인접은 지가·환금성에 부정적으로 작용합니다(사례상 10~30% 하락, 거래 위축).
                  거리는 직선거리이며, 실제 체감은 지형·바람 방향·차폐 여부에 따라 달라집니다.
                </p>
              </>
            )}
          </section>
        )}

        {/* 5. 활용 계획 사전검토(룰엔진) */}
        {ruleResults.length > 0 && (
          <section className="rp-sec rp-break">
            <h2 className="rp-sec-title"><span className="rp-num">5</span>활용 계획 사전검토</h2>
            {freeText && (
              <p className="rp-quote">“{freeText}”</p>
            )}
            {ruleResults.map((r) => (
              <div key={r.purpose} className="rp-rule">
                <div className="rp-rule-head">
                  <span className="rp-rule-purpose">{r.purposeLabel}</span>
                  <span className="rp-rule-grade" style={{ color: GRADE_COLOR[r.gradeLabel] ?? '#333' }}>{r.gradeLabel}</span>
                </div>
                <div className="rp-rule-desc">{r.gradeDescription}</div>
                {r.zoneName && (
                  <div className="rp-rule-zone">
                    {r.zoneName}
                    {r.bcrMax != null && r.farMax != null && ` · 건폐율 ${r.bcrMax}% · 용적률 ${r.farMax}%`}
                  </div>
                )}
                {r.riskItems.length > 0 && (
                  <ul className="rp-risks">
                    {r.riskItems.map((ri) => (
                      <li key={ri.key} className={`rp-risk lv-${ri.level}`}>
                        <b>{ri.label}</b> — {ri.note}
                      </li>
                    ))}
                  </ul>
                )}
                {r.recommendations.length > 0 && (
                  <div className="rp-recs">확인 권장: {r.recommendations.join(' · ')}</div>
                )}
              </div>
            ))}
          </section>
        )}

        {/* 6. 지자체 조례 확인 항목 */}
        {ordinanceItems.length > 0 && (
          <section className="rp-sec">
            <h2 className="rp-sec-title"><span className="rp-num">6</span>지자체 조례 확인 항목{ordinanceSgg ? ` · ${ordinanceSgg}` : ''}</h2>
            <p className="rp-lead">
              용도지역·규제는 자동 조회되지만, 건축물 높이·건폐율 특례·가축사육 거리 등 세부 기준은 지자체 조례로 정해집니다. 아래 항목을 조례에서 확인하세요.
            </p>
            <table className="rp-table">
              <thead><tr><th>항목</th><th>확인 내용</th><th>근거</th></tr></thead>
              <tbody>
                {ordinanceItems.map((it) => (
                  <tr key={it.key}>
                    <td><b>{it.label}</b></td>
                    <td>{it.note}</td>
                    <td className="rp-src">{it.source ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* 7. AI 종합 분석 */}
        {aiText && (
          <section className="rp-sec rp-break">
            <h2 className="rp-sec-title"><span className="rp-num">7</span>AI 종합 분석</h2>
            <div className="rp-ai">
              {aiText.split(/\n{1,}/).filter(Boolean).map((p, i) => (<p key={i}>{p}</p>))}
            </div>
          </section>
        )}

        <footer className="rp-foot">
          <div className="rp-foot-title">면책 고지</div>
          <p>{disclaimer}</p>
          <div className="rp-foot-brand">맵땅 · 토지 활용 사전검토 플랫폼 · 발행 {issuedAt}</div>
        </footer>
      </article>
    </div>
  );
}
