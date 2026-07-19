import { useCallback, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';

/**
 * 토지 사전검토 리포트(인쇄·PDF 저장용 전용 문서).
 *
 * 동작 방식
 *  - "레포트 출력하기"를 누르면 이 리포트 화면만 전체 화면으로 표시된다(앱 화면을 덮는다).
 *  - 자동 인쇄는 하지 않는다. 상단 "인쇄 · PDF로 저장" 버튼을 눌렀을 때만
 *    인쇄 대화상자가 열린다(대상에서 "PDF로 저장"을 선택하면 저장).
 *  - 리포트가 열려 있는 동안 body.rp-printing이 유지되어, 어떤 경로로 인쇄해도 앱 화면은
 *    인쇄물에 포함되지 않고 리포트 문서만 종이에 나간다.
 *  - 별도 PDF 라이브러리를 쓰지 않고 브라우저 인쇄를 사용한다.
 *    한글 폰트 임베딩 문제가 없고, 텍스트가 벡터로 남아 확대해도 선명하다.
 *  - 화면에서 접혀 있는 항목(기반시설 아코디언 등)도 리포트에서는 전부 펼쳐서 수록한다.
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
  '가능성 높음': '#186b41',
  '조건부 검토': '#2a5f9e',
  '전문가 확인 필요': '#8e6416',
  '리스크 높음': '#b8541f',
  '불가 가능성 높음': '#a8321f',
};

const GRADE_DESC: Record<string, string> = {
  A: '자동 확정', B: '자동 추정', C: '기관 확인', D: '현장 확인',
};

function scoreColor(v: number): string {
  return v >= 70 ? '#186b41' : v >= 45 ? '#8e6416' : '#b8541f';
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
  const rMax = 128;
  const maxM = Math.max(500, ...hazards.map((h) => h.distanceM));
  const rings = maxM <= 700 ? [250, 500, 700] : maxM <= 1500 ? [500, 1000, 1500] : [1000, 2000, 3000];
  const scale = (m: number) => Math.min(rMax, (m / rings[rings.length - 1]) * rMax);

  return (
    <svg className="rp-diagram" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="주변 혐오·기피시설 거리 도식">
      {rings.map((r) => (
        <g key={r}>
          <circle cx={cx} cy={cy} r={scale(r)} fill="none" stroke="#cfc9bb" strokeWidth="1" strokeDasharray="3 3" />
          <text x={cx + 3} y={cy - scale(r) + 11} className="rp-diagram-ring">
            {r >= 1000 ? `${r / 1000}km` : `${r}m`}
          </text>
        </g>
      ))}
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
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="#c2622d" strokeWidth="1" opacity="0.5" />
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
    onClose,
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

  // 리포트가 떠 있는 동안 body에 rp-printing을 계속 달아 둔다(@media print 안에서만 효력이 있어
  // 화면 표시에는 영향이 없다). 인쇄가 버튼으로 시작되든 브라우저 메뉴로 시작되든,
  // 리포트가 열려 있는 한 앱 화면은 인쇄물에 절대 포함되지 않는다. 배경 스크롤도 잠근다.
  useEffect(() => {
    document.body.classList.add('rp-printing');
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.classList.remove('rp-printing');
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // 인쇄: 같은 창에서 window.print() — 위 효과 덕분에 리포트 문서만 인쇄된다.
  const printDocument = useCallback(() => { window.print(); }, []);

  const sortedHazards = hazards ? [...hazards].sort((a, b) => a.distanceM - b.distanceM) : null;
  const nearestHazard = sortedHazards && sortedHazards.length ? sortedHazards[0] : null;

  // body 직계로 포털 렌더(앱 레이아웃의 영향을 받지 않게). 리포트만 전체 화면으로 보인다.
  return createPortal(
    <div className="rp-overlay" role="dialog" aria-label="토지 활용 사전검토 리포트">
      <div className="rp-toolbar rp-print-hide">
        <button type="button" className="rp-btn" onClick={printDocument}>인쇄 · PDF로 저장</button>
        <button type="button" className="rp-btn ghost" onClick={onClose}>닫기</button>
        <span className="rp-toolbar-hint">인쇄 창이 뜨면 대상을 <b>"PDF로 저장"</b>으로 선택하세요.</span>
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

        {/* 핵심 요약 — 첫 장에서 판단 근거가 한눈에 들어오도록 */}
        <section className="rp-summary">
          <div className="rp-sum-card">
            <div className="rp-sum-label">활용성 종합</div>
            <div className="rp-sum-value" style={{ color: overall != null ? scoreColor(overall) : '#43443f' }}>
              {overall != null ? `${overall}점` : '-'}
            </div>
            <div className="rp-sum-note">
              {overallMin != null && overallMax != null ? `가능 범위 ${overallMin}~${overallMax}점` : '100점 만점'}
            </div>
          </div>
          <div className="rp-sum-card">
            <div className="rp-sum-label">사전검토 등급</div>
            <div className="rp-sum-value" style={{ color: GRADE_COLOR[ruleResults[0]?.gradeLabel] ?? '#43443f', fontSize: 15 }}>
              {ruleResults[0]?.gradeLabel ?? '-'}
            </div>
            <div className="rp-sum-note">
              {ruleResults.length > 1 ? `${ruleResults[0]?.purposeLabel} 외 ${ruleResults.length - 1}건` : (ruleResults[0]?.purposeLabel ?? '-')}
            </div>
          </div>
          <div className="rp-sum-card">
            <div className="rp-sum-label">치명적 결함</div>
            <div className="rp-sum-value" style={{ color: caps.length ? '#b8541f' : '#186b41' }}>
              {caps.length ? `${caps.length}건` : '없음'}
            </div>
            <div className="rp-sum-note">{caps.length ? '종합 점수에 상한 적용' : '개발을 막는 결함 미확인'}</div>
          </div>
          <div className="rp-sum-card">
            <div className="rp-sum-label">최근접 혐오시설</div>
            <div className="rp-sum-value" style={{ color: nearestHazard ? '#b8541f' : '#186b41', fontSize: nearestHazard ? 19 : 16 }}>
              {nearestHazard ? fmtDist(nearestHazard.distanceM) : '반경 내 없음'}
            </div>
            <div className="rp-sum-note">{nearestHazard ? nearestHazard.typeLabel : '공공데이터 기준'}</div>
          </div>
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

        {/* 2. 기반시설 · 사용성 확인 항목(10개 전체, 모두 펼침) */}
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
          <section className="rp-sec rp-break">
            <h2 className="rp-sec-title"><span className="rp-num">3</span>토지 활용성 점수</h2>
            <p className="rp-lead">
              목적과 무관하게 이 토지 자체의 조건을 감정평가·투자 실무 기준으로 항목별 평가한 점수입니다.
              맹지·개발제한·급경사처럼 개발을 막는 <b>치명적 결함</b>은 다른 장점으로 상쇄하지 않고 종합 점수에 상한을 씩워 보수적으로 반영합니다.
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
              <p className="rp-quote">{freeText}</p>
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
              <thead><tr><th style={{ width: '22%' }}>항목</th><th>확인 내용</th><th style={{ width: '24%' }}>근거</th></tr></thead>
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
    </div>,
    document.body
  );
}
