# MapOn — Lovable 전체 화면 디자인 브리프

> 이 문서는 Lovable에 그대로 전달하기 위한 인계서다.
> **Lovable은 화면(UI)만 새로 만든다. 데이터 조회·진단 로직은 아래 계약대로 호출만 하고 절대 수정하지 않는다.**

---

## 1. 제품 한 줄 정의

**MapOn — "지번을 넣기 전에, 먼저 살핍니다."**
토지 주소만 입력하면 용도지역·지목·면적·공시지가·규제를 자동 조회하고,
지도에 필지 경계를 그려주며, "이 땅에 무엇을 지을 수 있는지"를 등급으로 알려주는
토지 구매 전 사전검토 도구. (확정 판정이 아닌 사전검토)

대상 사용자: 시골 땅·전원주택 부지·소규모 토지를 알아보는 일반인.
핵심 가치: 어렵고 흩어진 공공 토지정보를 **주소 한 줄로** 한눈에.

---

## 2. 디자인 방향 (톤 & 무드)

- 신뢰감 있는 **공공·측량·지적** 무드. 단, 관공서처럼 딱딱하지 않고 **모던하고 친근하게**.
- 시그니처 컬러: **측량 청록(teal) `#1f5c4d`**. 보조 `#184a3e`, 연한 배경 `#eef5f2`.
- 등급 색상(의미 고정 — 바꾸지 말 것):
  - 가능성 높음 `#1a7f4b` (초록)
  - 조건부 검토 `#2d6cb8` (파랑)
  - 전문가 확인 필요 `#b8862d` (황토)
  - 리스크 높음 `#c2622d` (주황)
  - 불가 가능성 높음 `#b83a3a` (빨강)
- 한글 가독성 최우선(Pretendard 또는 시스템 한글 폰트). 숫자는 tabular.
- 모바일 우선(대부분 휴대폰으로 땅 보러 다니며 조회). 데스크톱은 중앙 1단 컬럼(최대 760px) 확장.
- 과한 그림자·그라데이션 지양. 깔끔한 카드·둥근 모서리(12~16px)·여백 충분히.

---

## 3. 화면 플로우 (3단계, 세로 1컬럼)

### (A) 히어로 + 주소 검색
- 브랜드명 MapOn, 헤드라인 "지번을 넣기 전에, 먼저 살핍니다"
- 서브카피: "주소만 넣으면 용도지역·지목·면적·규제를 자동 조회해 활용 가능성을 등급으로 보여줍니다."
- **큰 주소 검색창**(토지이음처럼 시원하게) + "토지 조회" 버튼
- placeholder: `예) 가평군 상면 비룡로 2268-38  또는  가평군 상면 연하리 189`

### (B) 토지 정보 카드 + 지도 (조회 후 표시)
- 카드: 주소 / PNU / 지목 / 면적(㎡·평) / 공시지가(원/㎡) / 대표 용도지역
- 용도지역지구 태그들(대표 용도지역은 강조 색)
- 그 아래 **카카오맵**에 필지 경계가 청록 폴리곤으로 표시 (지도 컴포넌트는 그대로 둘 것)

### (C) 사전검토 입력 + 결과
- 입력: 용도지역·지목·면적·평균경사(조회 시 자동 채움, 수정 가능) / 목적 선택(칩) / 규제(칩)
- "사전검토 실행" 버튼
- 결과 카드: **큰 등급 표시**(색상), 용도지역·건폐율·용적률, 예비 견적 범위,
  검토 항목 리스트(info/caution/warning 점 색상), 추천 시설물 칩, 면책 문구

---

## 4. 데이터 계약 (★ 이대로 호출만. 수정 금지 ★)

### 4-1. 토지 조회 — Edge Function

```
POST https://irijchducsbsohzocmbk.supabase.co/functions/v1/land-lookup
Content-Type: application/json
Body: { "address": "경기도 가평군 상면 비룡로 2268-38" }
```

또는 supabase-js 사용 시:
```js
const res = await supabase.functions.invoke('land-lookup', {
  body: { address: 주소 }
});
```

**응답(LandLookup):**
```ts
interface UseZone { name: string; code: string; conflict: string; isPrimary: boolean }
interface LandLookup {
  pnu: string | null;            // "4182033021101890000"
  address: string | null;        // "경기도 가평군 상면 연하리 189"
  jimok: string | null;          // "대"
  areaSqm: number | null;        // 2972.5
  areaPyeong: number | null;     // 899.2
  officialPrice: number | null;  // 108800 (원/㎡)
  primaryUseZone: string | null; // "생산녹지지역" (대표 용도지역)
  useZones: UseZone[];           // 전체 용도지역지구 (isPrimary=대표)
  regulations: string[];         // ["자연보전권역(포함)","가축사육제한구역(포함)", ...]
  lat: number | null;            // 37.8039...
  lng: number | null;            // 127.3523...
  geomBoundary: unknown | null;  // GeoJSON MultiPolygon (지도 경계용)
  cached: boolean;
  note?: string;                 // 실패 사유(필지 못 찾음 등)
  error?: string; message?: string;
}
```

### 4-2. 진단 — 클라이언트 순수 함수 (브라우저에서 직접 호출)

```ts
import { diagnose, LandInput } from './engine/diagnose';
import { Purpose } from './engine/purposes';

const result = diagnose(input: LandInput, purpose: Purpose);
```

**LandInput(진단 입력):**
```ts
interface LandInput {
  pnu?: string;
  address?: string;
  useZoneRaw?: string | null;    // primaryUseZone을 넣음 (예: "생산녹지지역")
  jimok?: string | null;
  areaSqm?: number | null;
  slopePercent?: number | null;
  regulations?: string[] | null; // 규제명 배열(괄호 꼬리표 제거 후)
}
```

**Purpose(목적, 10종):**
`house`(전원주택) `farmhut`(농막) `warehouse`(창고) `cafe`(카페) `camping`(캠핑장)
`petfacility`(반려동물시설) `fence`(울타리) `landscape`(조경마당) `parking`(주차장) `solar`(태양광)

**DiagnosisResult(결과):**
```ts
interface DiagnosisResult {
  purpose: Purpose; purposeLabel: string;
  grade: Grade;                  // high|conditional|expert|risky|unlikely
  gradeLabel: string;            // "가능성 높음" 등 (위 색상표와 매핑)
  zone: { name; bcrMax; farMax; ... } | null;  // 건폐율·용적률
  zoneUnknown: boolean;
  riskItems: { key; label; level: 'info'|'caution'|'warning'; note }[];
  recommendations: string[];     // 추천 시설물
  estCostMin: number | null;     // 예비 견적(원)
  estCostMax: number | null;
  surveyTrigger: boolean;        // 경계측량 안내 노출 여부
  expertTrigger: boolean;        // 전문가 확인 권고 여부
  disclaimer: string;            // 항상 표시(면책 문구)
}
```

---

## 5. 절대 건드리면 안 되는 것 (기능 보존)

1. `land-lookup` Edge Function 호출 방식·파라미터·응답 파싱.
2. `src/engine/` 폴더 전체 (diagnose.ts / zones.ts / purposes.ts) — 진단 로직. **읽어서 호출만.**
3. `src/components/LandMap.tsx` — 카카오맵 경계 렌더링. 스타일(높이·테두리)은 바꿔도 되나 로직은 유지.
4. 규제명에서 `(포함)` 같은 꼬리표 제거 + "도시지역"·"입안중" 제외하는 정규화 규칙.
5. 면책 문구(disclaimer)는 결과에 **항상** 노출. 법적 책무.

---

## 6. 환경변수 (이미 설정됨)

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — Supabase
- `VITE_KAKAO_MAP_KEY` — 카카오맵 JS 키 (JS SDK 도메인에 배포 도메인 등록 필요)

---

## 7. Lovable에 줄 한 줄 지시 (요약)

> "위 데이터 계약(4번)대로 land-lookup을 호출하고 diagnose를 실행하되,
> 그 결과를 보여주는 **화면 전체를 측량 청록 무드의 모던하고 친근한 디자인으로 새로 만들어줘.**
> 모바일 우선, 3단계 플로우(검색 → 토지카드+지도 → 사전검토 결과).
> 등급 색상과 면책 문구는 고정. 진단 로직과 land-lookup 호출은 수정하지 말고 그대로 사용."
