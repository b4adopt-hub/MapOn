// MapOn: 토지 활용 AI 분석 Edge Function
// 입력: 토지 데이터 + 선택 목적(복수) + 자유 입력 텍스트
// 처리: 토지 사실(용도지역·지목·규제)을 컨텍스트로 Claude에 보내 종합 분석
// 출력: 자연어 분석 + 목적별 요약
// 시크릿: ANTHROPIC_API_KEY
//
// 안전 원칙:
//  - Claude는 제공된 토지 사실에 근거해서만 분석(새 사실 창작 금지)
//  - 확정 판정 금지, 사전검토 어조, 전문가·행정 확인 권고
//  - 면책 문구는 프론트에서 항상 별도 표시(여기서도 안내)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
// 한글은 토큰 소모가 커서 1024면 12문장에서 잘린다. 여유 있게 확보.
const MAX_TOKENS = 3000;

interface AnalyzeBody {
  land?: {
    address?: string | null;
    jimok?: string | null;
    areaSqm?: number | null;
    areaPyeong?: number | null;
    officialPrice?: number | null;
    primaryUseZone?: string | null;
    useZones?: { name: string; conflict: string; isPrimary: boolean }[];
    regulations?: string[];
  } | null;
  purposes?: string[];
  freeText?: string;
  ruleResults?: {
    purposeLabel: string;
    gradeLabel: string;
    zoneName?: string | null;
    bcrMax?: number | null;
    farMax?: number | null;
    warnings: string[];
  }[];
}

function buildPrompt(b: AnalyzeBody): string {
  const land = b.land ?? {};
  const lines: string[] = [];
  lines.push('당신은 한국 토지 활용 사전검토를 돕는 전문 어시스턴트입니다.');
  lines.push('아래 "토지 사실"과 "룰엔진 판정"에 근거해서만 분석하세요. 사실을 새로 지어내지 마세요.');
  lines.push('확정 판정·인허가 가부를 단정하지 말고, 사전검토 관점에서 가능성과 검토 포인트를 설명하세요.');
  lines.push('농지전용·산지전용·개발행위허가 등 행정 심사가 필요한 사항은 "전문가·지자체 확인 필요"로 안내하세요.');
  lines.push('');
  lines.push('=== 토지 사실 ===');
  if (land.address) lines.push(`주소: ${land.address}`);
  if (land.jimok) lines.push(`지목: ${land.jimok}`);
  if (land.areaSqm) lines.push(`면적: ${Math.round(land.areaSqm)}㎡ (${land.areaPyeong ?? '-'}평)`);
  if (land.officialPrice) lines.push(`공시지가: ${land.officialPrice.toLocaleString()}원/㎡`);
  if (land.primaryUseZone) lines.push(`대표 용도지역: ${land.primaryUseZone}`);
  if (land.useZones?.length) {
    lines.push(`용도지역지구(전체): ${land.useZones.map(z => `${z.name}(${z.conflict})`).join(', ')}`);
  }
  if (land.regulations?.length) {
    lines.push(`규제/구역: ${land.regulations.join(', ')}`);
  }
  lines.push('');

  if (b.ruleResults?.length) {
    lines.push('=== 룰엔진 판정(참고 근거) ===');
    for (const r of b.ruleResults) {
      const z = r.zoneName ? ` / 용도지역 ${r.zoneName}` : '';
      const bf = (r.bcrMax != null && r.farMax != null) ? ` (건폐율 ${r.bcrMax}%·용적률 ${r.farMax}%)` : '';
      lines.push(`- ${r.purposeLabel}: ${r.gradeLabel}${z}${bf}`);
      if (r.warnings.length) lines.push(`    주의: ${r.warnings.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('=== 사용자 요청 ===');
  if (b.purposes?.length) lines.push(`선택한 목적: ${b.purposes.join(', ')}`);
  if (b.freeText) lines.push(`사용자가 직접 쓴 활용 계획: "${b.freeText}"`);
  lines.push('');
  lines.push('=== 작성 지침 ===');
  lines.push('1) 사용자의 활용 계획이 이 토지에서 현실적인지 사전검토 관점에서 종합 평가.');
  lines.push('2) 위 용도지역·규제 사실을 근거로 핵심 제약과 가능성을 구체적으로 설명.');
  lines.push('3) 복수 목적이면 각각의 적합도를 간단히 비교.');
  lines.push('4) 다음 단계로 확인할 것(전문가·지자체·서류)을 1~2가지 제시.');
  lines.push('5) 한국어, 12문장 이내, 단정 금지, 사전검토 어조. 마크다운 헤더 없이 자연스러운 문단으로.');
  lines.push('6) 반드시 마지막 문장까지 완결해서 쓰세요. 문장이 중간에 끊기지 않도록 길이를 조절하세요.');
  return lines.join('\n');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const KEY = Deno.env.get('ANTHROPIC_API_KEY');
    if (!KEY) {
      return json(500, { error: 'ANTHROPIC_API_KEY_MISSING', message: 'ANTHROPIC_API_KEY 시크릿이 없습니다.' });
    }

    const body = (await req.json().catch(() => ({}))) as AnalyzeBody;
    if (!body.land && !body.freeText && !(body.purposes?.length)) {
      return json(400, { error: 'INPUT_REQUIRED', message: '토지 데이터 또는 목적/입력이 필요합니다.' });
    }

    const prompt = buildPrompt(body);

    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return json(502, { error: 'ANTHROPIC_ERROR', message: `분석 API 오류(${res.status})`, detail: errText.slice(0, 500) });
    }

    const data = await res.json();
    const analysis = (data?.content ?? [])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n')
      .trim();

    // 토큰 한계로 잘렸으면 프론트가 알 수 있게 플래그를 넣는다.
    const truncated = data?.stop_reason === 'max_tokens';

    return json(200, {
      analysis: analysis || '분석 결과를 생성하지 못했습니다.',
      truncated,
      disclaimer: '본 AI 분석은 공공데이터 기반 사전검토 참고용이며 법적 확정 판정이 아닙니다. 인허가 가부는 지자체 조례와 현장 확인에 따라 달라질 수 있습니다.',
    });
  } catch (e) {
    return json(500, { error: 'ANALYZE_FAILED', message: String(e) });
  }
});

function json(status: number, obj: unknown) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
