import { useState } from 'react';
import { diagnose, LandInput, DiagnosisResult } from './engine/diagnose';
import { Purpose, PURPOSE_LABELS } from './engine/purposes';
import { fetchOrdinance, OrdinanceResult } from './engine/ordinance';
import { supabase, supabaseReady } from './lib/supabase';
import { useAuth } from './lib/useAuth';
import AuthModal from './components/AuthModal';
import LandMap from './components/LandMap';

const PURPOSES = Object.keys(PURPOSE_LABELS) as Purpose[];
const ZONE_OPTIONS = ['계획관리지역','생산관리지역','보전관리지역','농림지역','자연환경보전지역','제1종일반주거지역','자연녹지지역','생산녹지지역','보전녹지지역'];
const JIMOK_OPTIONS = ['대','전','답','임야','잡종지','과수원'];
const REGULATION_OPTIONS = ['농업진흥구역','보전산지','개발제한구역','상수원보호구역','군사시설보호구역','자연보전권역','가축사육제한구역'];
const GRADE_COLOR: Record<string,string> = {'가능성 높음':'#1a7f4b','조건부 검토':'#2d6cb8','전문가 확인 필요':'#b8862d','리스크 높음':'#c2622d','불가 가능성 높음':'#b83a3a'};
const LEVEL_COLOR: Record<string,string> = {info:'#6b7280',caution:'#b8862d',warning:'#b83a3a'};

// 강화 면책 문구 — 결과 화면과 푸터에 반복 표시(법적 방어)
const DISCLAIMER_FULL = '본 서비스는 공공데이터와 사용자가 입력한 정보를 바탕으로 한 사전 참고자료입니다. 건축 가능 여부, 개발행위허가 가능 여부, 도로 인정 여부, 권리·점유 관계, 인허가 가능성, 가격 적정성, 입찰·매수 판단을 확정하거나 보장하지 않습니다. 최종 판단은 관할 지자체, 법원 기록, 공부서류, 현장조사 및 관련 전문가 검토를 통해 진행해야 합니다.';

interface UseZone { name:string; code:string; conflict:string; isPrimary:boolean }
interface RoadAccess { status:'direct_road'|'ditch'|'none'|'unknown'; adjacentJimoks:string[]; message:string; roadOwnership?:'gov'|'private'|'mixed'|'unknown'; roadOwnerNote?:string }
interface BuildingInfo {
  hasBuilding:boolean; count:number;
  bldNm?:string|null; mainPurpose?:string|null; etcPurpose?:string|null; structure?:string|null;
  totArea?:number|null; archArea?:number|null; bcRat?:number|null; vlRat?:number|null;
  grndFlr?:number|null; ugrndFlr?:number|null; useAprDay?:string|null;
  violation?:boolean; violationNote?:string|null;
}
interface LandLookup {
  pnu:string|null; address:string|null; jimok:string|null; areaSqm:number|null; areaPyeong:number|null;
  officialPrice:number|null; primaryUseZone:string|null; useZones:UseZone[]; regulations:string[];
  roadAccess:RoadAccess|null;
  lat:number|null; lng:number|null; geomBoundary:unknown|null; cached:boolean; note?:string; error?:string; message?:string;
}

const FN_BASE = (import.meta.env.VITE_SUPABASE_URL as string|undefined)
  ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`
  : 'https://irijchducsbsohzocmbk.supabase.co/functions/v1';

function fmtDate(yyyymmdd:string):string{
  const d=(yyyymmdd||'').replace(/[^0-9]/g,'');
  if(d.length!==8)return yyyymmdd;
  return `${d.slice(0,4)}.${d.slice(4,6)}.${d.slice(6,8)}`;
}

export default function App() {
  const auth = useAuth();
  const [showAuth, setShowAuth] = useState(false);
  const [address, setAddress] = useState('경기도 가평군 상면 비룡로 2268-38');
  const [looking, setLooking] = useState(false);
  const [lookupErr, setLookupErr] = useState<string|null>(null);
  const [land, setLand] = useState<LandLookup|null>(null);
  const [building, setBuilding] = useState<BuildingInfo|null>(null);
  const [bldChecked, setBldChecked] = useState(false);

  const [useZoneRaw, setUseZone] = useState('계획관리지역');
  const [jimok, setJimok] = useState('대');
  const [areaSqm, setArea] = useState('990');
  const [slope, setSlope] = useState('5');
  const [regs, setRegs] = useState<string[]>([]);

  // 복수 목적 선택 + 자유 입력
  const [purposes, setPurposes] = useState<Purpose[]>(['house']);
  const [freeText, setFreeText] = useState('');

  const [results, setResults] = useState<DiagnosisResult[]>([]);
  const [ordinance, setOrdinance] = useState<OrdinanceResult|null>(null);

  // AI 분석
  const [aiLoading, setAiLoading] = useState(false);
  const [aiText, setAiText] = useState<string|null>(null);
  const [aiErr, setAiErr] = useState<string|null>(null);

  function togglePurpose(p:Purpose){ setPurposes(prev=>prev.includes(p)?prev.filter(x=>x!==p):[...prev,p]); }
  function toggleReg(r:string){ setRegs(p=>p.includes(r)?p.filter(x=>x!==r):[...p,r]); }
  function normalizeRegs(raw:string[]):string[]{
    const out=new Set<string>();
    for(const r of raw){ const name=r.replace(/\(.*\)$/,'').trim(); if(name==='도시지역'||name.includes('입안중'))continue; out.add(name); }
    return [...out];
  }

  async function lookup(){
    if(!address.trim())return;
    setLooking(true); setLookupErr(null); setResults([]); setAiText(null); setAiErr(null);
    setBuilding(null); setBldChecked(false);
    try{
      let data:LandLookup;
      if(supabaseReady && supabase){
        const res=await supabase.functions.invoke('land-lookup',{body:{address:address.trim()}});
        if(res.error)throw new Error(res.error.message);
        data=res.data as LandLookup;
      }else{
        const r=await fetch(`${FN_BASE}/land-lookup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:address.trim()})});
        data=await r.json() as LandLookup;
      }
      if(data.error){ setLookupErr(data.message||data.error); setLand(null); return; }
      if(!data.pnu){ setLookupErr(data.note||'해당 주소의 필지를 찾지 못했습니다.'); setLand(null); return; }
      setLand(data);
      if(data.primaryUseZone)setUseZone(data.primaryUseZone);
      if(data.jimok)setJimok(data.jimok);
      if(data.areaSqm!=null)setArea(String(Math.round(data.areaSqm)));
      setRegs(normalizeRegs(data.regulations||[]));
      // 건축물 조회(별도 함수, 키 없으면 building:null)
      if(data.pnu){
        fetchBuilding(data.pnu).then(b=>{ setBuilding(b); setBldChecked(true); }).catch(()=>setBldChecked(true));
      }
    }catch(e){ setLookupErr(e instanceof Error?e.message:String(e)); setLand(null); }
    finally{ setLooking(false); }
  }

  async function fetchBuilding(pnu:string):Promise<BuildingInfo|null>{
    try{
      let data:any;
      if(supabaseReady && supabase){
        const res=await supabase.functions.invoke('building-lookup',{body:{pnu}});
        if(res.error)return null;
        data=res.data;
      }else{
        const r=await fetch(`${FN_BASE}/building-lookup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pnu})});
        data=await r.json();
      }
      return data?.building ?? null;
    }catch{ return null; }
  }

  function buildInput():LandInput{
    return {
      pnu:land?.pnu??undefined, address:land?.address??address,
      useZoneRaw, jimok,
      areaSqm:areaSqm?Number(areaSqm):null,
      slopePercent:slope?Number(slope):null,
      regulations:regs.length?regs:null,
      roadAccess:land?.roadAccess??null,
    };
  }

  function run(){
    const input=buildInput();
    const list = (purposes.length?purposes:['house' as Purpose]).map(p=>diagnose(input,p));
    setResults(list);
    setAiText(null); setAiErr(null);
    // 조례 안내 비동기 로드(DB)
    setOrdinance(null);
    fetchOrdinance(land?.pnu, land?.primaryUseZone, purposes)
      .then(setOrdinance)
      .catch(()=>setOrdinance(null));
  }

  async function runAI(){
    setAiLoading(true); setAiErr(null); setAiText(null);
    try{
      const input=buildInput();
      // 룰엔진 결과(사실 근거) 동봉
      const ruleResults = (purposes.length?purposes:['house' as Purpose]).map(p=>{
        const r=diagnose(input,p);
        return {
          purposeLabel:r.purposeLabel, gradeLabel:r.gradeLabel,
          zoneName:r.zone?.name??null, bcrMax:r.zone?.bcrMax??null, farMax:r.zone?.farMax??null,
          warnings:r.riskItems.filter(x=>x.level==='warning').map(x=>x.label),
        };
      });
      const payload={
        land: land?{
          address:land.address, jimok:land.jimok, areaSqm:land.areaSqm, areaPyeong:land.areaPyeong,
          officialPrice:land.officialPrice, primaryUseZone:land.primaryUseZone,
          useZones:land.useZones, regulations:land.regulations,
        }:null,
        purposes: purposes.map(p=>PURPOSE_LABELS[p]),
        freeText: freeText.trim()||undefined,
        ruleResults,
      };
      let data:any;
      if(supabaseReady && supabase){
        const res=await supabase.functions.invoke('land-ai-analyze',{body:payload});
        if(res.error)throw new Error(res.error.message);
        data=res.data;
      }else{
        const r=await fetch(`${FN_BASE}/land-ai-analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        data=await r.json();
      }
      if(data.error){ setAiErr(data.message||data.error); return; }
      setAiText(data.analysis);
    }catch(e){ setAiErr(e instanceof Error?e.message:String(e)); }
    finally{ setAiLoading(false); }
  }

  return (
    <div className="page">
      <div className="mp-topbar">
        {auth.userId ? (
          <span className="mp-user">
            {auth.displayName ?? auth.email}님
            {auth.isExpert && <span className="mp-user-tag">{auth.expertStatus === 'approved' ? '전문가' : '전문가 심사중'}</span>}
            <button className="mp-link-btn" onClick={auth.signOut}>로그아웃</button>
          </span>
        ) : (
          <span className="mp-user">
            <a className="mp-link-btn" href="/expert">전문가 가입</a>
            <button className="mp-link-btn primary" onClick={() => setShowAuth(true)}>로그인 / 회원가입</button>
          </span>
        )}
      </div>
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} signIn={auth.signIn} signUp={auth.signUp} />}
      <header className="hero">
        <div className="brand">
          <svg className="brand-pin" viewBox="0 0 36 46" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M18 2C10 2 3.5 8.5 3.5 16.5c0 9.5 12 22 13.4 23.4a1.5 1.5 0 0 0 2.2 0C20.5 38.5 32.5 26 32.5 16.5 32.5 8.5 26 2 18 2z" fill="#1f5c4d"/>
            <path d="M11 18.5L18 12l7 6.5V25a1 1 0 0 1-1 1h-4v-4h-4v4h-4a1 1 0 0 1-1-1v-6.5z" fill="#fff"/>
          </svg>
          <span className="brand-text">맵<span className="brand-ddang">땅</span></span>
        </div>
        <h1>지번을 넣기 전에, 먼저 살핍니다</h1>
        <p className="sub">주소만 넣으면 용도지역·지목·면적·규제·도로 인접 여부를 자동 조회해, 활용 전 확인해야 할 위험 신호를 등급으로 보여줍니다. 확정 판정이 아닌 사전검토입니다.</p>
        <div className={`status ${supabaseReady?'on':'off'}`}>{supabaseReady?'Supabase 연결됨':'직접 호출 모드 (anon 키 미설정)'}</div>
      </header>

      <section className="form">
        <div className="field">
          <label>토지 주소 (도로명 또는 지번)</label>
          <input className="search-input" value={address} onChange={e=>setAddress(e.target.value)}
            placeholder="예) 가평군 상면 비룡로 2268-38  또는  가평군 상면 연하리 189"
            onKeyDown={e=>{if(e.key==='Enter')lookup();}} />
          <button className="run lookup-btn-full" onClick={lookup} disabled={looking}>{looking?'조회 중…':'토지 조회'}</button>
          {lookupErr && <div className="lookup-err">{lookupErr}</div>}
        </div>

        {land && (
          <div className="land-card">
            <div className="land-head">
              <div className="land-addr">{land.address}</div>
              <div className="land-pnu">PNU {land.pnu}{land.cached?' · 캐시':''}</div>
            </div>
            <div className="land-grid">
              <div><span>지목</span><strong>{land.jimok??'-'}</strong></div>
              <div><span>면적</span><strong>{land.areaSqm!=null?`${Math.round(land.areaSqm).toLocaleString()}㎡ (${land.areaPyeong}평)`:'-'}</strong></div>
              <div><span>공시지가</span><strong>{land.officialPrice!=null?`${land.officialPrice.toLocaleString()}원/㎡`:'-'}</strong></div>
              <div><span>대표 용도지역</span><strong>{land.primaryUseZone??'-'}</strong></div>
            </div>
            {land.useZones?.length>0 && (
              <div className="zone-tags">
                {land.useZones.map(z=>(<span key={z.code} className={`zone-tag ${z.isPrimary?'primary':''}`}>{z.name}</span>))}
              </div>
            )}
            {land.roadAccess && land.roadAccess.status!=='unknown' && (
              <div className={`road-line road-${land.roadAccess.status}`}>
                {land.roadAccess.status==='direct_road' && '지적도상 도로 인접 가능성 있음 — 현황도로·도로폭·건축법상 도로 여부 확인 필요'}
                {land.roadAccess.status==='ditch' && '구거·하천 인접 — 점용·지분 시 진입 가능성, 별도 확인 필요'}
                {land.roadAccess.status==='none' && '지적도상 도로 미접함 — 현황도로·지분·진입 이력 확인 필요'}
                {land.roadAccess.adjacentJimoks?.length>0 && (
                  <span className="road-adj"> · 인접: {land.roadAccess.adjacentJimoks.join('·')}</span>
                )}
              </div>
            )}
            {land.roadAccess?.status==='direct_road' && land.roadAccess.roadOwnership && land.roadAccess.roadOwnership!=='unknown' && (
              <div className={`road-owner road-owner-${land.roadAccess.roadOwnership}`}>
                {land.roadAccess.roadOwnership==='private' && '⚠️ 접한 도로가 사유지(사도)로 보임 — 토지사용승낙서·도로지분·통행권 확인 필요'}
                {land.roadAccess.roadOwnership==='gov' && '접한 도로에 국공유 도로 있음 — 통행 동의 측면은 비교적 안전한 편(현황·폭 별도 확인)'}
                {land.roadAccess.roadOwnership==='mixed' && '접한 도로 국공유·사유 혼재 — 실제 진입에 쓰는 도로가 어느 쪽인지 확인 필요'}
              </div>
            )}
          </div>
        )}

        {land && bldChecked && building?.hasBuilding && (
          <div className="bld-card">
            <div className="bld-head">
              <span className="bld-title">건축물 있음{building.count>1?` · ${building.count}동`:''}</span>
              {building.violation && <span className="bld-viol-tag">위반건축물</span>}
            </div>
            {building.violation && (
              <div className="bld-viol">{building.violationNote}</div>
            )}
            <div className="bld-grid">
              {building.bldNm && <div><span>건물명</span><strong>{building.bldNm}</strong></div>}
              {building.mainPurpose && <div><span>주용도</span><strong>{building.mainPurpose}</strong></div>}
              {building.structure && <div><span>구조</span><strong>{building.structure}</strong></div>}
              {building.totArea!=null && <div><span>연면적</span><strong>{building.totArea.toLocaleString()}㎡</strong></div>}
              {(building.grndFlr!=null||building.ugrndFlr!=null) && <div><span>층수</span><strong>지상 {building.grndFlr??0} / 지하 {building.ugrndFlr??0}</strong></div>}
              {building.useAprDay && <div><span>사용승인일</span><strong>{fmtDate(building.useAprDay)}</strong></div>}
            </div>
            <div className="bld-checklist">
              <div className="bld-cl-title">기존 건물이 있는 토지 — 확인 항목</div>
              <ul>
                <li>위반건축물 여부(불법 증축·용도변경) — 이행강제금·대출·매매 제약 확인</li>
                <li>사용승인일 기준 노후도 — 리모델링/재건축 시 비용·구조 안전 검토</li>
                <li>현재 용도와 원하는 용도의 일치 여부 — 용도변경 가능성 확인</li>
                <li>건물 철거 시 철거비·멸실신고, 신축 시 현행 건폐율·용적률 재적용</li>
              </ul>
            </div>
          </div>
        )}
        {land && bldChecked && building && !building.hasBuilding && (
          <div className="bld-card bld-empty">
            <span className="bld-title">건축물대장상 건물 없음</span>
            <p>이 필지에는 등록된 건축물이 확인되지 않습니다(나대지일 가능성). 단, 미등기·무허가 건물이 현장에 있을 수 있으니 현장 확인을 권합니다.</p>
          </div>
        )}
        {land && bldChecked && building===null && (
          <div className="bld-card bld-manual">
            <div className="bld-cl-title">이 토지에 건축물이 있나요?</div>
            <p>건축물이 있다면 <b>건축물대장</b>에서 다음을 반드시 확인하세요. 위반건축물은 이행강제금·대출·매매에 큰 제약이 됩니다.</p>
            <ul>
              <li>위반건축물 여부(불법 증축·용도변경)</li>
              <li>사용승인일(노후도)·구조·주용도</li>
              <li>원하는 용도로의 용도변경 가능성</li>
              <li>철거 후 신축 시 현행 건폐율·용적률 재적용</li>
            </ul>
            <a className="bld-link" href="https://www.gov.kr/portal/service/serviceInfo/PTR000050064" target="_blank" rel="noopener noreferrer">정부24 건축물대장 발급 ↗</a>
          </div>
        )}

        {land && Boolean(land.geomBoundary) && (
          <LandMap geom={land.geomBoundary as any} lat={land.lat} lng={land.lng} label={land.address} />
        )}
      </section>

      <section className="form">
        <div className="field">
          <label>용도지역 {land && <em className="auto">자동</em>}</label>
          <select value={useZoneRaw} onChange={e=>setUseZone(e.target.value)}>
            {ZONE_OPTIONS.map(z=>(<option key={z} value={z}>{z}</option>))}
            {!ZONE_OPTIONS.includes(useZoneRaw) && <option value={useZoneRaw}>{useZoneRaw}</option>}
          </select>
        </div>
        <div className="row">
          <div className="field">
            <label>지목 {land && <em className="auto">자동</em>}</label>
            <select value={jimok} onChange={e=>setJimok(e.target.value)}>
              {JIMOK_OPTIONS.map(j=>(<option key={j} value={j}>{j}</option>))}
              {!JIMOK_OPTIONS.includes(jimok) && <option value={jimok}>{jimok}</option>}
            </select>
          </div>
          <div className="field">
            <label>면적 (㎡) {land && <em className="auto">자동</em>}</label>
            <input value={areaSqm} onChange={e=>setArea(e.target.value)} inputMode="numeric" />
          </div>
          <div className="field">
            <label>평균 경사 (%)</label>
            <input value={slope} onChange={e=>setSlope(e.target.value)} inputMode="numeric" />
          </div>
        </div>

        <div className="field">
          <label>목적 <em className="hint">복수 선택 가능</em></label>
          <div className="chips">
            {PURPOSES.map(p=>(<button key={p} className={`chip ${purposes.includes(p)?'active':''}`} onClick={()=>togglePurpose(p)}>{PURPOSE_LABELS[p]}</button>))}
          </div>
        </div>

        <div className="field">
          <label>직접 입력 <em className="hint">원하는 활용을 자유롭게 적으면 확인 항목을 정리해 드립니다</em></label>
          <textarea className="freetext" value={freeText} onChange={e=>setFreeText(e.target.value)}
            placeholder="예) 반려동물과 함께 살 단독주택과 작은 텃밭, 손님용 주차공간을 만들고 싶어요." rows={3} />
        </div>

        <div className="field">
          <label>규제 {land && <em className="auto">자동</em>}</label>
          <div className="chips">
            {REGULATION_OPTIONS.map(r=>(<button key={r} className={`chip ${regs.includes(r)?'active warn':''}`} onClick={()=>toggleReg(r)}>{r}</button>))}
          </div>
        </div>

        <div className="btn-row">
          <button className="run" onClick={run}>사전검토 실행</button>
          <button className="run ai" onClick={runAI} disabled={aiLoading}>{aiLoading?'정리 중…':'확인 항목 생성'}</button>
        </div>
      </section>

      {results.length>0 && (
        <section className="result">
          {ordinance && ordinance.items.length>0 && (
            <div className="ordinance">
              <h3 className="ord-title">지자체 조례 확인 항목{ordinance.sggName?` · ${ordinance.sggName}`:''}</h3>
              <p className="ord-lead">용도지역·규제는 자동 조회됐지만, 건축물 높이·건폐율 특례·가축사육 거리 등 세부 기준은 지자체 조례로 정해집니다. 아래 항목을 조례에서 확인하세요.</p>
              {ordinance.items.map(it=>(
                <div key={it.key} className={`ord-item ord-${it.level}`}>
                  <div className="ord-item-label">{it.label}</div>
                  <div className="ord-item-note">{it.note}</div>
                  {it.source && <div className="ord-item-src">근거: {it.source}</div>}
                </div>
              ))}
              {ordinance.elisUrl && (
                <a className="ord-elis" href={ordinance.elisUrl} target="_blank" rel="noopener noreferrer">
                  {ordinance.sggName?`${ordinance.sggName} 자치법규(ELIS) 열기`:'자치법규(ELIS) 열기'} ↗
                </a>
              )}
            </div>
          )}
          {results.map((result)=>(
            <div key={result.purpose} className="result-block">
              <div className="grade-card">
                <div className="grade-label">{result.purposeLabel}</div>
                <div className="grade" style={{color:GRADE_COLOR[result.gradeLabel]}}>{result.gradeLabel}</div>
                <div className="grade-desc">{result.gradeDescription}</div>
                {(result.gradeLabel==='리스크 높음'||result.gradeLabel==='불가 가능성 높음') && (
                  <div className="grade-caveat">'불가능' 판정이 아니라, 추가 확인 없이 진행하면 손실 가능성이 크다는 의미입니다.</div>
                )}
                {result.zone && (<div className="zone-meta">{result.zone.name} · 건폐율 {result.zone.bcrMax}%(땅의 {result.zone.bcrMax}%까지 바닥 건축) · 용적률 {result.zone.farMax}%(층수 여유)</div>)}
              </div>
              <div className="risks">
                {result.riskItems.map(ri=>(
                  <div key={ri.key} className="risk">
                    <span className="dot" style={{background:LEVEL_COLOR[ri.level]}} />
                    <div><div className="risk-label">{ri.label}</div><div className="risk-note">{ri.note}</div></div>
                  </div>
                ))}
              </div>
              <div className="recs">
                <div className="chips">{result.recommendations.map(r=>(<span key={r} className="chip static">{r}</span>))}</div>
              </div>
            </div>
          ))}
          <p className="disclaimer">{DISCLAIMER_FULL}</p>
        </section>
      )}

      {(aiText || aiErr) && (
        <section className="result ai-result">
          <h3 className="ai-title">확인 항목 정리</h3>
          {aiErr && <div className="lookup-err">{aiErr}</div>}
          {aiText && <div className="ai-text">{aiText}</div>}
          <p className="disclaimer">{DISCLAIMER_FULL}</p>
        </section>
      )}

      <footer className="foot">맵땅 · 토지 활용 사전검토 플랫폼<br/>{DISCLAIMER_FULL}</footer>
    </div>
  );
}
