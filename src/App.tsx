import { useState, useMemo } from 'react';
import { diagnose, LandInput, DiagnosisResult, NearbyHazard } from './engine/diagnose';
import { Purpose, PURPOSE_LABELS } from './engine/purposes';
import { scoreLand, CATEGORY_ORDER, CATEGORY_LABELS, ScoreCategory } from './engine/landScore';
import { fetchOrdinance, OrdinanceResult } from './engine/ordinance';
import { applyOrdinance } from './engine/gradeAdjust';
import { supabase, supabaseReady } from './lib/supabase';
import { useAuth } from './lib/useAuth';
import AuthModal from './components/AuthModal';
import LandMap from './components/LandMap';
import LandReport from './components/LandReport';
import './components/LandReport.css';

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
interface LandCharact {
  roadSide?:string|null; roadLevel?:'good'|'normal'|'weak'|'blind'|'unknown'; roadNote?:string|null;
  topographyHeight?:string|null; topographyShape?:string|null; landUse?:string|null;
  officialPrice?:number|null; stdrYear?:string|null;
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

// 용도지역으로 기반시설 정비 수준의 약한 신호만 — 단정 아님
function infraOutlying(zone:string|null):boolean{
  if(!zone)return false;
  return /(농림|관리지역|계획관리|생산관리|보전관리|녹지|자연환경보전)/.test(zone);
}

// 데이터 등급: A=자동확정 B=자동추정 C=기관확인 D=현장확인
type DataGrade = 'A'|'B'|'C'|'D';
const GRADE_META: Record<DataGrade,{label:string;cls:string}> = {
  A:{label:'자동 확정',cls:'g-a'},
  B:{label:'자동 추정',cls:'g-b'},
  C:{label:'기관 확인',cls:'g-c'},
  D:{label:'현장 확인',cls:'g-d'},
};

interface InfraGroup {
  key:string; title:string; grade:DataGrade; danger?:number; // danger: 1~5 = 돈 터지는 순위
  lead:string; items:string[]; purposeNote?:string; contact:string;
}
// 문서 기준: 가장 위험한 5개(도로·오수·전기·배수·인허가)를 danger로 표시하고 상단 정렬
// 아래 INFRA_GROUPS는 "나대지(빈땅)" 기준. 기존 건물이 있으면 EXISTING_BLD_OVERRIDE로 본문을 교체.
const INFRA_GROUPS: InfraGroup[] = [
  {
    key:'road', title:'도로 (접도)', grade:'B', danger:1,
    lead:'도로는 토지의 생명줄입니다. 접도가 안 되면 건축·대형차·사용성이 한 번에 무너집니다. 지적도상 도로·현황도로·건축법상 도로는 서로 다릅니다.',
    items:[
      '지적도상 도로에 접하는지(맹지 여부)',
      '현황도로가 건축법상 도로로 인정되는지',
      '도로 폭·막다른 도로·회전반경(대형차 진입·회차)',
      '사도·공유지분 도로면 토지사용승낙·통행권 필요 여부',
      '진입로 경사·포장·제설 관리 주체',
    ],
    purposeNote:'창고·공장·근생이면 대형차 진입·회차 가능성을 현장에서 반드시 확인하세요.',
    contact:'지자체 건축과·도로과 + 현장',
  },
  {
    key:'sewage', title:'오수 (하수)', grade:'C', danger:2,
    lead:'오수 처리가 안 되면 건축 허가 자체가 나지 않습니다. 토지·창고·근생에서 가장 자주 터지는 항목입니다.',
    items:[
      '공공하수처리구역인지, 공공하수관로 연결 가능한지',
      '연결 불가 시 개인하수처리시설(정화조) 설치 의무·용량·비용',
      '정화조 방류수 배출 경로(구거·하천) 확보, 분뇨차 진입 가능 여부',
      '오수관로 연결 거리·원인자부담금',
      '기존 건물이면 건축물대장상 정화조 용량·위치',
    ],
    purposeNote:'카페·식당·숙박은 오수 발생량이 많아 정화조 용량·방류가 자주 막힙니다.',
    contact:'지자체 하수도과·상하수도사업소',
  },
  {
    key:'elec', title:'전기', grade:'C', danger:3,
    lead:'인입 거리가 멀면 공사비가 수백만~수천만 원까지 늘 수 있습니다. 한전 무료인입 한계는 통상 200m입니다.',
    items:[
      '인근 전주(전봇대)가 필지 앞 도로에 있는지, 거리 200m 이내인지',
      '전주 신설·타인 토지 통과가 필요한지(인입 공사비 좌우)',
      '한전 계량기 설치 가능 여부, 기존 전기 사용 이력',
      '단상/삼상·저압/고압, 증설·변압기 용량 여유',
      '용도별 전기 종별(주택용/농사용/산업용)',
    ],
    purposeNote:'공장·창고·냉동·기계 사용이면 삼상 전기·변압기 용량이 핵심입니다.',
    contact:'한전 국번없이 123 · 사이버지점',
  },
  {
    key:'storm', title:'우수 (빗물 배수)', grade:'D', danger:4,
    lead:'오수와 다릅니다. 빗물이 빠질 곳이 없으면 침수·토사 유출이 생기고 토목비가 커집니다.',
    items:[
      '배수로·도로 측구·구거로 물이 빠지는 경로가 있는지',
      '주변보다 낮은 저지대·논 매립지·하천 옆 침수 위험',
      '필지 경사 방향, 장마철 침수 이력',
      '경사지면 옹벽·성토·집수정·우수관 필요 여부',
      '마당 포장 시 배수계획, 인접지 유출 분쟁 소지',
    ],
    purposeNote:'성토한 땅인데 배수계획이 없으면 비 올 때 물이 모입니다. 현장 확인이 가장 중요합니다.',
    contact:'지자체 하수과·도로과 + 현장',
  },
  {
    key:'permit', title:'인허가', grade:'B', danger:5,
    lead:'용도지역·지목·개발행위가 원하는 용도와 안 맞으면 애초에 목적대로 못 씁니다.',
    items:[
      '용도지역상 원하는 용도(주택·창고·공장·근생·음식점·숙박) 가능 여부',
      '지목이 대지가 아니면 농지전용·산지전용 필요 여부',
      '개발행위허가 필요 여부·조건',
      '가축사육제한구역·문화재·군사·상수원·환경 규제',
      '매물 설명과 공부상 용도 불일치(창고라며 파는데 근생인 경우 등)',
    ],
    contact:'지자체 건축과·민원실 + 토지이용계획확인서',
  },
  {
    key:'water', title:'상수도', grade:'C',
    lead:'상수도관이 도로에 매설돼 있어야 인입됩니다. 없으면 지하수(관정)를 직접 개발해야 합니다.',
    items:[
      '앞 도로에 상수도관 매설 여부, 인입 거리·분담금, 기존 계량기',
      '미공급 지역이면 지하수(관정) 개발 가능 여부·비용',
      '관정 수질검사·먹는물 적합 여부',
      '상수원보호구역 등 지하수 개발 제한 여부',
    ],
    purposeNote:'음식점·숙박·공장 등 물 사용 많은 용도면 급수 가능량을 확인하세요.',
    contact:'지자체 상수도사업소',
  },
  {
    key:'gas', title:'가스 · 난방', grade:'C',
    lead:'도시가스가 없으면 LPG·기름·전기난방을 써야 하고, 용도에 따라 연료가 제한됩니다.',
    items:[
      '도시가스 공급 지역인지',
      'LPG 사용 시 저장공간·안전기준',
      '기름·전기난방 가능 여부',
      '음식점·제조시설 등 용도별 연료·환기 기준',
    ],
    contact:'지역 도시가스사 · LPG 공급사',
  },
  {
    key:'tel', title:'통신', grade:'C',
    lead:'외곽·산지에서는 인터넷·휴대폰 신호가 약하거나 설치가 어려울 수 있습니다.',
    items:[
      '인터넷·광케이블 설치 가능 지역인지',
      '휴대폰 신호 상태',
      'CCTV·보안·원격관제 설치 가능성',
    ],
    purposeNote:'창고·사업장 운영이면 통신환경을 현장에서 확인하세요.',
    contact:'KT·SKT·LGU+ 등 통신사',
  },
  {
    key:'fire', title:'소방 · 안전', grade:'B',
    lead:'소방차 진입과 소화전 거리는 창고·공장 용도에서 인허가에 직결됩니다.',
    items:[
      '소방차 진입·비상차량 회차 가능 도로 폭',
      '인근 소화전 위치(반경 100~500m)',
      '창고·공장 용도 소방기준, 건물 간 이격거리',
      '주변 산림 인접(산불·이격) 여부',
    ],
    contact:'관할 소방서 + 건축사·소방시설업체',
  },
  {
    key:'civil', title:'토목 · 지형', grade:'D',
    lead:'보기에는 넓어도 경사·성토·암반이면 평탄화·옹벽에 토목비가 크게 듭니다.',
    items:[
      '경사도·진입로 경사, 성토·절토 흔적',
      '옹벽 필요 여부, 지반·암반 상태',
      '배수 방향·토사유출·산사태 위험지역 여부',
      '마당 조성·평탄화 비용',
    ],
    contact:'토목설계사무소 + 현장',
  },
];

// 기존 건물(주거·근생)이 있을 때 덧쓰는 본문 — "신규 인입"이 아니라 "기존 시설 승계·상태" 관점
// 이미 사용승인된 집이 서 있다 = 진입·수도·전기·오수가 한 번은 해결됐던 땅.
const EXISTING_BLD_OVERRIDE: Record<string, Partial<Pick<InfraGroup,'lead'|'items'|'purposeNote'>>> = {
  road: {
    lead:'이미 사용승인된 건물이 있는 땅입니다. 사람이 드나들던 진입로가 존재한다는 뜻이라, "맹지인가"는 사실상 답이 나와 있습니다. 다만 재건축·증축·대형차 진입을 생각한다면 현장 도로 상태를 확인하세요.',
    items:[
      '현장 진입로 폭·포장 상태(승용차·이사짐차·이사차 드나들 수 있는지)',
      '재건축·증축 시 현행 건축법 도로 기준(폭 4m 등) 충족 여부',
      '진입로가 내 땅·국공유인지, 타인 사유지(사도)를 지나는지 — 통행권 분쟁 소지',
      '공부상 도로접면과 현황 일치 여부(지적도와 실제 진입로가 다른 경우)',
    ],
    purposeNote:'기존 집을 허물고 새로 짓거나 크게 증축할 계획이면, 현장 진입로가 건축법 기준을 만족하는지 다시 확인하세요.',
  },
  water: {
    lead:'기존 주거 건물이 있어 상수도나 관정이 이미 연결돼 사용 중일 가능성이 높습니다. 신규 관정 개발보다 기존 급수 방식·상태를 확인하면 됩니다.',
    items:[
      '현재 급수 방식 — 상수도 인입인지, 지하수(관정)인지',
      '상수도면 계량기 명의·체납 이력, 단수 여부',
      '관정이면 수량·수질검사 결과, 겨울 동결 이력',
      '오래된 남은 배관·동파이프라면 교체 필요 여부',
    ],
    purposeNote:'그대로 살 계획이면 수도가 이미 있으니 큰 문제가 아닙니다. 다만 관정이면 수질·수량을, 증축·영업이면 급수량을 확인하세요.',
  },
  sewage: {
    lead:'기존 건물이 있어 오수 처리(공공하수관 또는 정화조)가 이미 돼 있을 가능성이 높습니다. 신규 설치보다 기존 정화조 상태·용량을 확인하면 됩니다.',
    items:[
      '현재 오수 처리 방식 — 공공하수관 연결인지, 개인 정화조인지',
      '건축물대장·정화조 대장상 정화조 용량·형식·설치일',
      '정화조 청소 이력·노후도, 방류수 배출 경로 정상 여부',
      '증축·용도변경 시 정화조 용량 증설·공공하수 연결 의무 여부',
    ],
    purposeNote:'단순 거주면 기존 정화조로 충분합니다. 카페·식당 등으로 바꾸면 오수량이 늘어 정화조 증설이 필요할 수 있습니다.',
  },
  elec: {
    lead:'기존 건물이 있어 전기가 이미 인입돼 계량기가 있을 가능성이 높습니다. 신규 인입보다 기존 용량·명의 승계를 확인하면 됩니다.',
    items:[
      '기존 한전 계량기 명의·체납 이력, 명의변경 가능 여부',
      '계약 전력(kW)이 쓸 용도에 충분한지(전기냉난방·인덱션 등 쓰면 증설 필요)',
      '단상/삼상 구분 — 공장·기계는 삼상 필요',
      '노후 건물이면 내부 전기배선·분전함 교체 필요 여부',
    ],
    purposeNote:'그대로 살면 전기는 이미 있습니다. 전기차·공장·냉난방 증설이면 계약전력 증설·삼상 여부를 확인하세요.',
  },
  gas: {
    lead:'기존 건물이 있어 난방·취사 연료가 이미 갖춰져 있을 가능성이 높습니다(도시가스 미공급 지역은 통상 LPG·기름·전기). 현재 방식과 유지비를 확인하세요.',
    items:[
      '현재 난방·취사 연료(도시가스·LPG·기름·전기) 확인',
      'LPG면 용기·배관 상태·안전점검 이력',
      '도시가스 공급 지역으로 추후 전환 가능한지(선택 사항)',
    ],
    purposeNote:'도시가스가 안 들어와 LPG·기름을 쓰는 건 외곽 주택에서 흔한 일로, 결함이 아니라 유지비·편의성 차이입니다.',
  },
  tel: {
    lead:'기존 건물이 있어 통신이 이미 들어와 있을 가능성이 높습니다. 속도·품질만 확인하면 됩니다.',
    items:[
      '현재 인터넷 연결 여부·회선 종류·속도',
      '휴대폰 신호 세기(통신사별 차이 있을 수 있음)',
    ],
  },
};

// 목적별 기반시설 관련도: 2=핵심, 1=일반, 0=영향 적음. 도로·인허가는 모든 목적 핵심.
const REL: Record<string, Partial<Record<Purpose, number>>> = {
  road:    { house:2, farmhut:2, warehouse:2, cafe:2, camping:2, petfacility:2, fence:1, landscape:1, parking:2, solar:2 },
  permit:  { house:2, farmhut:2, warehouse:2, cafe:2, camping:2, petfacility:2, fence:1, landscape:1, parking:2, solar:2 },
  sewage:  { house:2, farmhut:1, warehouse:0, cafe:2, camping:2, petfacility:2, fence:0, landscape:0, parking:0, solar:0 },
  water:   { house:2, farmhut:1, warehouse:0, cafe:2, camping:2, petfacility:2, fence:0, landscape:1, parking:0, solar:0 },
  elec:    { house:2, farmhut:2, warehouse:2, cafe:2, camping:1, petfacility:2, fence:0, landscape:0, parking:1, solar:2 },
  storm:   { house:1, farmhut:1, warehouse:1, cafe:1, camping:1, petfacility:1, fence:1, landscape:2, parking:2, solar:1 },
  civil:   { house:1, farmhut:1, warehouse:2, cafe:1, camping:2, petfacility:1, fence:1, landscape:2, parking:2, solar:2 },
  fire:    { house:0, farmhut:0, warehouse:2, cafe:1, camping:1, petfacility:1, fence:0, landscape:0, parking:0, solar:0 },
  gas:     { house:1, farmhut:0, warehouse:0, cafe:2, camping:0, petfacility:0, fence:0, landscape:0, parking:0, solar:0 },
  tel:     { house:1, farmhut:0, warehouse:1, cafe:1, camping:1, petfacility:1, fence:0, landscape:0, parking:0, solar:1 },
};

// 선택 목적들에 대한 항목 관련도(여러 목적이면 최대값) — 목적 없으면 기본 1
function infraRelevance(key:string, purposes:Purpose[]):number{
  if(!purposes.length) return 1;
  const m = REL[key] ?? {};
  return Math.max(...purposes.map(p=>m[p] ?? 1));
}

// 정밀분석 입력(자유 텍스트)에서 관련 활용 목적을 추출한다.
// 사용자가 쓴 내용에 맞는 목적만 룰엔진으로 판정하기 위함(전체 목적 무차별 표시 방지).
const PURPOSE_KEYWORDS: Record<Purpose, string[]> = {
  house:      ['주택','집','전원주택','거주','살','단독','귀촌','귀농','전원생활','살림'],
  farmhut:    ['농막','농사','밭','텃밭','컨테이너','농자재','농기구','경작'],
  warehouse:  ['창고','물류','보관','적재','자재','임대창고','저장','물건'],
  cafe:       ['카페','커피','음식점','식당','근생','상가','펜션','숙박','민박','베이커리','디저트','영업'],
  camping:    ['캠핑','글램핑','야영','오토캠핑','카라반'],
  petfacility:['반려동물','애견','펫','강아지','고양이','동물','보호소','훈련소','호텔','유치원','장묘','분양'],
  fence:      ['울타리','담장','펜스','경계','철책'],
  landscape:  ['조경','마당','정원','가든','화단','수목','잔디'],
  parking:    ['주차','주차장','차고','차량'],
  solar:      ['태양광','발전','태양열','신재생'],
};
function detectPurposes(text:string):Purpose[]{
  const t = (text||'').replace(/\s/g,'');
  if(!t) return [];
  const found:Purpose[] = [];
  (Object.keys(PURPOSE_KEYWORDS) as Purpose[]).forEach(p=>{
    if(PURPOSE_KEYWORDS[p].some(k=>t.includes(k))) found.push(p);
  });
  return found;
}

export default function App() {
  const auth = useAuth();
  const [showAuth, setShowAuth] = useState(false);
  const [address, setAddress] = useState('');
  const [looking, setLooking] = useState(false);
  const [lookupErr, setLookupErr] = useState<string|null>(null);
  const [land, setLand] = useState<LandLookup|null>(null);
  const [building, setBuilding] = useState<BuildingInfo|null>(null);
  const [bldChecked, setBldChecked] = useState(false);
  const [charact, setCharact] = useState<LandCharact|null>(null);
  const [hazards, setHazards] = useState<NearbyHazard[]|null>(null);
  const [infraOpen, setInfraOpen] = useState<string|null>('road');
  const [showMinor, setShowMinor] = useState(false);
  // 리포트(인쇄·PDF) — 10크레딧 차감 후 열린다
  const [reportOpen, setReportOpen] = useState(false);
  const [reportErr, setReportErr] = useState<string|null>(null);
  const [reportBusy, setReportBusy] = useState(false);

  const [useZoneRaw, setUseZone] = useState('계획관리지역');
  const [jimok, setJimok] = useState('대');
  const [areaSqm, setArea] = useState('990');
  const [slope, setSlope] = useState('5');
  const [regs, setRegs] = useState<string[]>([]);

  // 복수 목적 선택 + 자유 입력
  const [purposes] = useState<Purpose[]>(['house']);
  const [freeText, setFreeText] = useState('');

  // 룰엔진 사전검토 결과 + 조례
  const [results, setResults] = useState<DiagnosisResult[]>([]);
  const [ordinance, setOrdinance] = useState<OrdinanceResult|null>(null);

  // AI 분석
  const [aiLoading, setAiLoading] = useState(false);
  const [aiText, setAiText] = useState<string|null>(null);
  const [aiErr, setAiErr] = useState<string|null>(null);

  // 기존 주택·근생 건물이면 전기·물·오수·도로가 이미 해결됐을 개연성 높음
  const hasResidentialBuilding = Boolean(
    building?.hasBuilding && /(주택|주거|단독|다세대|연립|아파트|근린생활)/.test(building?.mainPurpose ?? '')
  );

  // 목적·건물 상태로 기반시설 항목을 동적 정렬(숨기지 않고 우선순위 재배치)
  const infraSorted = useMemo(() => {
    return INFRA_GROUPS
      .map(g => ({ g, rel: infraRelevance(g.key, purposes) }))
      .sort((a, b) => {
        if (b.rel !== a.rel) return b.rel - a.rel;            // 관련도 높은 항목 먼저
        return (a.g.danger ?? 99) - (b.g.danger ?? 99);       // 동률이면 위험순위
      });
  }, [purposes]);

  const coreItems = infraSorted.filter(x => x.rel >= 1);
  const minorItems = infraSorted.filter(x => x.rel === 0);

  // 토지 자체의 항목별 활용성 점수(부동산 투자자 관점).
  // 도로/접도·규제·경사·용도지역·지목·면적 등 실제 토지 조건을 0~100으로 산출.
  // 혐오시설은 nearbyHazards로 연동되고, 편의시설은 데이터 연동 전이라 pending으로 숨겨진다.
  const landScore = useMemo(() => {
    if (!land) return null;
    const base: LandInput = {
      pnu: land.pnu ?? undefined,
      address: land.address ?? address,
      useZoneRaw: land.primaryUseZone ?? useZoneRaw,
      jimok: land.jimok ?? jimok,
      areaSqm: land.areaSqm ?? (areaSqm ? Number(areaSqm) : null),
      slopePercent: slope ? Number(slope) : null,
      regulations: regs.length ? regs : null,
      roadAccess: land.roadAccess ?? null,
      roadSideName: charact?.roadSide ?? null,
      roadSideLevel: charact?.roadLevel ?? null,
      topographyName: charact?.topographyHeight ?? null,
      topographyShape: charact?.topographyShape ?? null,
      nearbyHazards: hazards,
    };
    const result = scoreLand(base);
    // 카테고리별로 그룹핑(측정된 항목만 표시). pending 항목은 데이터가 채워지면 자동 등장.
    const grouped = CATEGORY_ORDER.map((cat: ScoreCategory) => ({
      category: cat,
      label: CATEGORY_LABELS[cat],
      items: result.items.filter(i => i.category === cat && i.status === 'measured' && i.score != null),
    })).filter(g => g.items.length > 0);
    return { ...result, grouped };
  }, [land, charact, hazards, regs, slope, address, useZoneRaw, jimok, areaSqm]);

  function normalizeRegs(raw:string[]):string[]{
    const out=new Set<string>();
    for(const r of raw){ const name=r.replace(/\(.*\)$/,'').trim(); if(name==='도시지역'||name.includes('입안중'))continue; out.add(name); }
    return [...out];
  }

  async function lookup(){
    if(!address.trim())return;
    // 접근 제어: 비로그인은 조회 불가(로그인 유도). 로그인 사용자는 조회 시 1크레딧 차감.
    if(!auth.userId){ setShowAuth(true); return; }
    setLooking(true); setLookupErr(null); setResults([]); setOrdinance(null); setAiText(null); setAiErr(null);
    setBuilding(null); setBldChecked(false); setCharact(null); setHazards(null);
    setLand(null);
    // 크레딧 차감(원자적, 서버). 부족하면 조회 중단하고 안내.
    const paid = await auth.consumeCredit();
    if(!paid.ok){
      setLooking(false);
      setLookupErr(paid.reason==='insufficient'
        ? '크레딧이 부족합니다. 상세 조회는 크레딧이 필요합니다.'
        : paid.reason==='auth'
          ? '로그인이 필요합니다.'
          : '크레딧 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      if(paid.reason==='auth') setShowAuth(true);
      return;
    }
    // 면·리·동 지번 형식(…리/…동 + 지번, '산 00' 포함)이면 지번(PARCEL)으로 조회.
    // 그 외(도로명 등)는 지정하지 않고 서버 기본값(ROAD→PARCEL 폴백)에 맡긴다.
    const addr = address.trim();
    const isParcel = /(리|동|가)\s*(산\s*)?\d+(-\d+)?\s*$/.test(addr) || /\s산\s*\d/.test(addr);
    const reqBody:{address:string; addressType?:string} = isParcel
      ? { address: addr, addressType: 'PARCEL' }
      : { address: addr };
    try{
      let data:LandLookup;
      if(supabaseReady && supabase){
        const res=await supabase.functions.invoke('land-lookup',{body:reqBody});
        if(res.error)throw new Error(res.error.message);
        data=res.data as LandLookup;
      }else{
        const r=await fetch(`${FN_BASE}/land-lookup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(reqBody)});
        data=await r.json() as LandLookup;
      }
      if(data.error){ setLookupErr(data.message||data.error); setLand(null); return; }
      if(!data.pnu){ setLookupErr(data.note||'해당 주소의 필지를 찾지 못했습니다.'); setLand(null); return; }
      setLand(data);
      if(data.primaryUseZone)setUseZone(data.primaryUseZone);
      if(data.jimok)setJimok(data.jimok);
      if(data.areaSqm!=null)setArea(String(Math.round(data.areaSqm)));
      setRegs(normalizeRegs(data.regulations||[]));
      // 건축물·토지특성 자동 조회(별도 함수, 키 없으면 null)
      if(data.pnu){
        fetchBuilding(data.pnu).then(b=>{ setBuilding(b); setBldChecked(true); }).catch(()=>setBldChecked(true));
        fetchCharact(data.pnu).then(setCharact).catch(()=>setCharact(null));
        fetchHazards(data.pnu, data.lat, data.lng).then(setHazards).catch(()=>setHazards([]));
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

  async function fetchCharact(pnu:string):Promise<LandCharact|null>{
    try{
      let data:any;
      if(supabaseReady && supabase){
        const res=await supabase.functions.invoke('land-characteristics',{body:{pnu}});
        if(res.error)return null;
        data=res.data;
      }else{
        const r=await fetch(`${FN_BASE}/land-characteristics`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pnu})});
        data=await r.json();
      }
      return data?.characteristics ?? null;
    }catch{ return null; }
  }

  // 주변 혐오·기피시설 반경 조회(nearby-hazards EF). 실패·미배포 시 빈 배열(영향 없음 취급).
  async function fetchHazards(pnu:string, lat:number|null, lng:number|null):Promise<NearbyHazard[]>{
    try{
      let data:any;
      if(supabaseReady && supabase){
        const res=await supabase.functions.invoke('nearby-hazards',{body:{pnu,lat,lng}});
        if(res.error)return [];
        data=res.data;
      }else{
        const r=await fetch(`${FN_BASE}/nearby-hazards`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pnu,lat,lng})});
        data=await r.json();
      }
      return Array.isArray(data?.hazards) ? data.hazards : [];
    }catch{ return []; }
  }

  function buildInput():LandInput{
    return {
      pnu:land?.pnu??undefined, address:land?.address??address,
      useZoneRaw, jimok,
      areaSqm:areaSqm?Number(areaSqm):null,
      slopePercent:slope?Number(slope):null,
      regulations:regs.length?regs:null,
      roadAccess:land?.roadAccess??null,
      roadSideName:charact?.roadSide??null,
      roadSideLevel:charact?.roadLevel??null,
      topographyName:charact?.topographyHeight??null,
    };
  }

  async function runAI(targets:Purpose[]){
    setAiLoading(true); setAiErr(null); setAiText(null);
    try{
      const input=buildInput();
      const useTargets = targets.length?targets:['house' as Purpose];
      // 룰엔진 결과(사실 근거) 동봉 — 사용자가 입력한 활용에 해당하는 목적만
      const ruleResults = useTargets.map(p=>{
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
          roadSide:charact?.roadSide??null, topography:charact?.topographyHeight??null,
          landShape:charact?.topographyShape??null, landUse:charact?.landUse??null,
          hasBuilding:building?.hasBuilding??null, buildingPurpose:building?.mainPurpose??null,
        }:null,
        purposes: useTargets.map(p=>PURPOSE_LABELS[p]),
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

  // 룰엔진 사전검토: 입력에서 감지한 활용 목적만 등급을 산출하고, 지자체 조례를 조회해 반영.
  function runRuleCheck(targets:Purpose[]){
    const useTargets = targets.length?targets:['house' as Purpose];
    const input=buildInput();
    const list = useTargets.map(p=>diagnose(input,p));
    setResults(list);
    setOrdinance(null);
    fetchOrdinance(land?.pnu, land?.primaryUseZone, useTargets, slope?Number(slope):null)
      .then(ord=>{
        setOrdinance(ord);
        if(ord && ord.uses.length>0){
          setResults(prev=>prev.map(r=>applyOrdinance(r, ord)));
        }
      })
      .catch(()=>setOrdinance(null));
  }

  // 정밀분석: 5크레딧 차감 후, 입력한 활용을 해석해 (1)해당 목적 사전검토(등급·위험·조례) + (2)AI 종합분석.
  async function runPrecision(){
    if(!auth.userId){ setShowAuth(true); return; }
    const paid = await auth.consumeCredit(5);
    if(!paid.ok){
      setAiErr(paid.reason==='insufficient'
        ? '크레딧이 부족합니다. 정밀분석에는 5크레딧이 필요합니다.'
        : paid.reason==='auth'
          ? '로그인이 필요합니다.'
          : '크레딧 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      if(paid.reason==='auth') setShowAuth(true);
      return;
    }
    // 채팅창 입력에서 관련 활용 목적을 감지 → 그 목적만 룰엔진으로 판정
    const targets = detectPurposes(freeText);
    runRuleCheck(targets);   // 입력한 활용의 객관 사전검토(등급·위험·조례)
    await runAI(targets);     // 그 결과를 근거로 AI가 종합 분석·재평가
  }

  // 리포트 출력: 10크레딧 차감 후 인쇄용 리포트 뷰를 연다.
  // 조회 결과(룰엔진·AI·점수·혐오시설)를 그 시점 스냅샷으로 담는다.
  async function openReport(){
    if(!auth.userId){ setShowAuth(true); return; }
    if(!land){ return; }
    setReportErr(null); setReportBusy(true);
    const paid = await auth.consumeCredit(10);
    setReportBusy(false);
    if(!paid.ok){
      setReportErr(paid.reason==='insufficient'
        ? '크레딧이 부족합니다. 리포트 출력에는 10크레딧이 필요합니다.'
        : paid.reason==='auth'
          ? '로그인이 필요합니다.'
          : '크레딧 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
      if(paid.reason==='auth') setShowAuth(true);
      return;
    }
    setReportOpen(true);
  }

  function renderInfraItem(g:InfraGroup, rel:number){
    const core = rel>=2;
    // 기존 주거·근생 건물이 있고 해당 항목에 오버라이드가 있으면 본문 교체
    const ov = hasResidentialBuilding ? EXISTING_BLD_OVERRIDE[g.key] : undefined;
    const lead = ov?.lead ?? g.lead;
    const items = ov?.items ?? g.items;
    const purposeNote = ov ? ov.purposeNote : g.purposeNote;
    return (
      <div key={g.key} className={`infra-item ${infraOpen===g.key?'open':''} ${core?'danger':''} ${rel===0?'minor':''}`}>
        <button className="infra-item-head" onClick={()=>setInfraOpen(infraOpen===g.key?null:g.key)}>
          <span className="infra-item-title">
            {core && <span className="infra-star">●</span>}
            {g.title}
            <span className={`infra-badge sm ${GRADE_META[g.grade].cls}`}>{g.grade}</span>
            {core && <span className="infra-rel-tag core">이 활용에 핵심</span>}
            {rel===0 && <span className="infra-rel-tag minor">영향 적음</span>}
            {ov && <span className="infra-rel-tag exist">기존 시설</span>}
          </span>
          <span className="infra-toggle">{infraOpen===g.key?'−':'+'}</span>
        </button>
        {infraOpen===g.key && (
          <div className="infra-item-body">
            {g.key==='road' && charact?.roadSide && (
              <div className={`infra-auto road-${charact.roadLevel}`}>
                공부상 도로접면: <b>{charact.roadSide}</b>{charact.roadNote?` — ${charact.roadNote}`:''}
              </div>
            )}
            {g.key==='civil' && (charact?.topographyHeight||charact?.topographyShape) && (
              <div className="infra-auto">
                공부상 지형: <b>{[charact?.topographyHeight,charact?.topographyShape].filter(Boolean).join(' · ')}</b>
                {charact?.topographyHeight && /평지/.test(charact.topographyHeight)?' — 평지로 등재(현장 경사·성토는 별도 확인)':' — 현장 경사·성토 확인 권장'}
              </div>
            )}
            {ov && (
              <div className="infra-auto bld-exist">
                이 토지에는 <b>기존 건물({building?.mainPurpose ?? '주거·근생'})</b>이 있어, 이 항목은 <b>신규 설치가 아니라 기존 시설의 상태·승계 확인</b>으로 바꿔 안내합니다.
              </div>
            )}
            <p className="infra-item-lead">{lead}</p>
            <ul>{items.map((it,i)=>(<li key={i}>{it}</li>))}</ul>
            {purposeNote && <div className="infra-purpose">{ov?'참고':'용도 주의'}: {purposeNote}</div>}
            <div className="infra-contact">확인처: {g.contact}</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="mp-topbar">
        {auth.userId ? (
          <span className="mp-user">
            {auth.displayName ?? auth.email}님
            {auth.isExpert && <span className="mp-user-tag">{auth.expertStatus === 'approved' ? '전문가' : '전문가 심사중'}</span>}
            <span className="mp-credit">크레딧 {auth.isAdmin ? '∞' : auth.credits}</span>
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
            placeholder="예) 가나면 다라리 100-1  (도로명 또는 면·리 지번 모두 가능)"
            onKeyDown={e=>{if(e.key==='Enter')lookup();}} />
          {!auth.userId ? (
            <button className="run lookup-btn-full" onClick={()=>setShowAuth(true)}>로그인하고 조회하기</button>
          ) : (!auth.isAdmin && auth.credits<=0) ? (
            <button className="run lookup-btn-full" disabled>크레딧 소진 · 추가 크레딧 필요</button>
          ) : (
            <button className="run lookup-btn-full" onClick={lookup} disabled={looking}>
              {looking?'조회 중…':`토지 조회${auth.isAdmin?'':' (1크레딧)'}`}
            </button>
          )}
          {!auth.userId && <div className="lookup-hint">로그인하면 1크레딧으로 토지 기본 정보와 활용 점수를 확인할 수 있습니다.</div>}
          {lookupErr && <div className="lookup-err">{lookupErr}</div>}
        </div>

        {land && Boolean(land.geomBoundary) && (
          <LandMap geom={land.geomBoundary as any} lat={land.lat} lng={land.lng} label={land.address} />
        )}

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
            <div className="land-slope">
              <label>평균 경사 (%)</label>
              <input value={slope} onChange={e=>setSlope(e.target.value)} inputMode="numeric" />
            </div>
            {charact && (charact.roadSide||charact.topographyHeight||charact.topographyShape) && (
              <div className="charact-row">
                {charact.roadSide && (
                  <div className={`charact-item road-${charact.roadLevel}`}>
                    <span>도로접면(공부)</span><strong>{charact.roadSide}</strong>
                  </div>
                )}
                {charact.topographyHeight && (
                  <div className="charact-item"><span>지형고저</span><strong>{charact.topographyHeight}</strong></div>
                )}
                {charact.topographyShape && (
                  <div className="charact-item"><span>토지형상</span><strong>{charact.topographyShape}</strong></div>
                )}
                {charact.landUse && (
                  <div className="charact-item"><span>이용상황</span><strong>{charact.landUse}</strong></div>
                )}
              </div>
            )}
            {charact?.roadNote && (
              <div className={`charact-note road-${charact.roadLevel}`}>{charact.roadNote}</div>
            )}
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

        {land && (
          <div className="infra-card">
            <div className="infra-head">
              <span className="infra-title">기반시설 · 사용성 확인 항목</span>
              <span className="infra-sub">10개 항목</span>
            </div>
            <p className="infra-lead">
              토지 활용에 앞서 확인해야 할 기반시설을 <b>위험 순으로</b> 정렬했습니다. 공공데이터로 알 수 있는 것과 기관·현장 확인이 필요한 것을 등급으로 구분합니다.
              {hasResidentialBuilding
                ? ' 이 토지에는 이미 사용승인된 건물이 있어 도로·전기·상수도·오수가 이미 해결돼 있을 가능성이 높습니다. 해당 항목은 신규 설치가 아닌 기존 시설 상태·승계 확인으로 안내합니다.'
                : infraOutlying(land.primaryUseZone)
                  ? ' 도심 외곽(관리·농림·녹지)이라 기반시설 미비 가능성이 상대적으로 높습니다.'
                  : ' 도시지역이라도 필지별로 인입 여부가 다릅니다.'}
            </p>
            <div className="infra-legend">
              {(['A','B','C','D'] as DataGrade[]).map(g=>(
                <span key={g} className={`infra-badge ${GRADE_META[g].cls}`}>{g} {GRADE_META[g].label}</span>
              ))}
            </div>
            <p className="infra-danger-note">● 표시는 특히 중요한 항목입니다.</p>
            {coreItems.map(({g,rel})=>renderInfraItem(g,rel))}
            {minorItems.length>0 && (
              <div className="infra-minor-wrap">
                <button className="infra-minor-toggle" onClick={()=>setShowMinor(s=>!s)}>
                  {showMinor?'영향이 적은 항목 접기':`영향이 적은 항목 ${minorItems.length}개 더 보기`} {showMinor?'▲':'▼'}
                </button>
                {showMinor && minorItems.map(({g,rel})=>renderInfraItem(g,rel))}
              </div>
            )}
          </div>
        )}
      </section>

      {land && landScore && landScore.overall!=null && (
        <section className="form score-card">
          <div className="score-head">
            <span className="score-title">이 토지의 활용성 점수</span>
            <span className="score-avg" style={{color: landScore.overall>=70?'#1a7f4b':landScore.overall>=45?'#b8862d':'#c2622d'}}>
              종합 {landScore.overall}점
              {landScore.overallMin!=null && landScore.overallMax!=null && (
                <em className="score-range">최저 {landScore.overallMin}점 · 최고 {landScore.overallMax}점</em>
              )}
            </span>
          </div>
          <p className="score-lead">목적과 무관하게, <b>이 토지 자체의 조건</b>을 부동산 감정평가·투자 실무 기준으로 항목별 평가한 점수입니다. 맹지·개발제한·급경사처럼 개발을 막는 <b>치명적 결함</b>은 다른 장점으로 상쇄하지 않고 종합 점수에 상한을 씌워 보수적으로 반영합니다.</p>
          {landScore.caps.length>0 && (
            <div className="score-caps">
              <div className="score-caps-title">이 토지의 종합 점수를 끌어내린 치명적 결함</div>
              {landScore.caps.map((c,i)=>(<div key={i} className="score-cap-item">• {c}</div>))}
            </div>
          )}
          {hazards!=null && (
            <div className="hazard-box">
              <div className="hazard-box-title">
                주변 혐오·기피시설
                <span className="hazard-box-sub">공공데이터 기준 · 직선거리</span>
              </div>
              {hazards.length===0 ? (
                <div className="hazard-none">반경 내 조회된 혐오·기피시설이 없습니다. (등록되지 않은 축사·묘지 등은 현장 확인 권장)</div>
              ) : (
                <>
                  {[...hazards].sort((a,b)=>a.distanceM-b.distanceM).map((h,i)=>(
                    <div key={i} className="hazard-item">
                      <span className="hazard-dist">{h.distanceM>=1000?`${(h.distanceM/1000).toFixed(1)}km`:`${Math.round(h.distanceM)}m`}</span>
                      <span className="hazard-type">{h.typeLabel}</span>
                      {h.name && <span className="hazard-name">{h.name}</span>}
                    </div>
                  ))}
                  <div className="hazard-foot">혐오·기피시설 인접은 지가·환금성에 부정적입니다(사례상 10~30% 하락, 거래 위축). 위 결과는 참고용이며 현장·중개사 확인을 권장합니다.</div>
                </>
              )}
            </div>
          )}
          {landScore.grouped.map(group=>(
            <div key={group.category} className="score-group">
              <div className="score-group-title">{group.label}</div>
              <div className="score-bars">
                {group.items.map(it=>(
                  <div key={it.key} className="score-row" title={it.note}>
                    <span className="score-label">{it.label}</span>
                    <div className="score-track">
                      <div className="score-fill" style={{width:`${it.score}%`, background: (it.score as number)>=70?'#1a7f4b':(it.score as number)>=45?'#b8862d':'#c2622d'}} />
                    </div>
                    <span className="score-num">{it.score}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {land && (
        <section className="form">
          <div className="field">
            <label>정밀분석 <em className="hint">원하는 활용을 적으면, 그 활용을 해석해 해당 용도의 사전검토(등급·위험·조례)를 판정하고 AI가 종합 분석합니다</em></label>
            <textarea className="freetext" value={freeText} onChange={e=>setFreeText(e.target.value)}
              placeholder="예) 반려동물과 함께 살 단독주택과 작은 텃밭, 손님용 주차공간을 만들고 싶어요. / 창고로 임대 놓으면 어떨지 궁금해요." rows={4} />
          </div>

          {!auth.userId ? (
            <button className="run precision" onClick={()=>setShowAuth(true)}>로그인하고 정밀분석 (5크레딧)</button>
          ) : (!auth.isAdmin && auth.credits<5) ? (
            <button className="run precision" disabled>정밀분석 5크레딧 필요 · 크레딧 부족</button>
          ) : (
            <button className="run precision" onClick={runPrecision} disabled={aiLoading}>
              {aiLoading?'분석 중…':`정밀분석 실행${auth.isAdmin?'':' (5크레딧)'}`}
            </button>
          )}
        </section>
      )}

      {results.length>0 && (
        <section className="result">
          <h3 className="result-title">사전검토 결과 <span className="result-sub">— 입력하신 활용 기준 등급·위험·조례(객관 판정)</span></h3>
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
                {result.zone && (<div className="zone-meta">{result.zone.name} · 건폐율 {ordinance?.rates?.bcr?.pct ?? result.zone.bcrMax}%(땅의 {ordinance?.rates?.bcr?.pct ?? result.zone.bcrMax}%까지 바닥 건축) · 용적률 {ordinance?.rates?.far?.pct ?? result.zone.farMax}%(층수 여유){ordinance?.rates?' · 지자체 조례 기준':' · 법령 일반값'}</div>)}
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
        </section>
      )}

      {(aiText || aiErr) && (
        <section className="result ai-result">
          <h3 className="ai-title">AI 종합 분석</h3>
          {aiErr && <div className="lookup-err">{aiErr}</div>}
          {aiText && <div className="ai-text">{aiText}</div>}
          <p className="disclaimer">{DISCLAIMER_FULL}</p>
        </section>
      )}

      {/* 리포트 버튼: 룰엔진 사전검토 + AI 분석이 모두 나온 뒤에만 노출(분석 전에는 담을 내용이 없음) */}
      {land && landScore && results.length>0 && aiText && (
        <section className="form report-cta">
          {!auth.userId ? (
            <button className="run" onClick={()=>setShowAuth(true)}>로그인하고 리포트 출력 (10크레딧)</button>
          ) : (!auth.isAdmin && auth.credits<10) ? (
            <button className="run" disabled>리포트 출력 10크레딧 필요 · 크레딧 부족</button>
          ) : (
            <button className="run" onClick={openReport} disabled={reportBusy}>
              {reportBusy?'준비 중…':`레포트 출력하기${auth.isAdmin?'':' (10크레딧)'}`}
            </button>
          )}
          <div className="report-hint">
            토지 개요·기반시설 10개 항목·활용성 점수 그래프·주변 혐오시설 도식·사전검토 판정·AI 분석을 한 편의 문서로 만들어
            인쇄하거나 PDF로 저장할 수 있습니다.
          </div>
          {reportErr && <div className="lookup-err">{reportErr}</div>}
        </section>
      )}

      {reportOpen && land && landScore && results.length>0 && (
        <LandReport
          onClose={()=>setReportOpen(false)}
          address={land.address}
          pnu={land.pnu}
          jimok={land.jimok}
          areaSqm={land.areaSqm}
          areaPyeong={land.areaPyeong}
          officialPrice={land.officialPrice}
          primaryUseZone={land.primaryUseZone}
          useZoneNames={(land.useZones??[]).map(z=>z.name)}
          regulations={land.regulations??[]}
          roadSide={charact?.roadSide??null}
          topographyHeight={charact?.topographyHeight??null}
          topographyShape={charact?.topographyShape??null}
          landUse={charact?.landUse??null}
          slopePercent={slope?Number(slope):null}
          hasBuilding={bldChecked?(building?.hasBuilding??null):null}
          buildingPurpose={building?.mainPurpose??null}
          buildingUseAprDay={building?.useAprDay??null}
          buildingViolation={building?.violation??null}
          overall={landScore.overall}
          overallMin={landScore.overallMin}
          overallMax={landScore.overallMax}
          caps={landScore.caps}
          groups={landScore.grouped.map(g=>({
            category:g.category, label:g.label,
            items:g.items.map(i=>({key:i.key,label:i.label,score:i.score})),
          }))}
          hazards={hazards ? hazards.map(h=>({
            type:h.type, typeLabel:h.typeLabel, name:h.name??null, distanceM:h.distanceM,
          })) : null}
          infraItems={infraSorted.map(({g,rel})=>{
            // 기존 주거·근생 건물이 있으면 화면과 동일하게 "기존 시설 상태·승계" 관점 본문으로 교체
            const ov = hasResidentialBuilding ? EXISTING_BLD_OVERRIDE[g.key] : undefined;
            return {
              key:g.key, title:g.title, grade:g.grade, danger:g.danger??null, rel,
              lead: ov?.lead ?? g.lead,
              items: ov?.items ?? g.items,
              purposeNote: (ov ? ov.purposeNote : g.purposeNote) ?? null,
              contact: g.contact,
              existing: !!ov,
            };
          })}
          freeText={freeText.trim()}
          ruleResults={results.map(r=>({
            purpose:r.purpose, purposeLabel:r.purposeLabel,
            gradeLabel:r.gradeLabel, gradeDescription:r.gradeDescription,
            zoneName:r.zone?.name??null,
            bcrMax:ordinance?.rates?.bcr?.pct ?? r.zone?.bcrMax ?? null,
            farMax:ordinance?.rates?.far?.pct ?? r.zone?.farMax ?? null,
            riskItems:r.riskItems.map(ri=>({key:ri.key,label:ri.label,note:ri.note,level:ri.level})),
            recommendations:r.recommendations,
          }))}
          ordinanceSgg={ordinance?.sggName??null}
          ordinanceItems={(ordinance?.items??[]).map(it=>({
            key:it.key,label:it.label,note:it.note,level:it.level,source:it.source??null,
          }))}
          aiText={aiText}
          disclaimer={DISCLAIMER_FULL}
        />
      )}

      <footer className="foot">맵땅 · 토지 활용 사전검토 플랫폼<br/>{DISCLAIMER_FULL}</footer>
    </div>
  );
}
