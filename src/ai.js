// 자연어 조회를 구조화된 조건으로 바꾼다. Anthropic Messages API 를 직접 호출한다.
//
// 이 확장은 번들러가 없는 순수 ES 모듈이고 MV3 는 원격 스크립트 로딩을 막으므로
// 공식 SDK 대신 raw HTTP 로 부른다.

const API_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_MODEL = 'claude-opus-5';

/** 조회 조건 스키마. 구조화 출력으로 강제해 파싱 실패를 없앤다. */
const FILTER_SCHEMA = {
  type: 'object',
  properties: {
    dateFrom: { type: 'string', description: '조회 시작일 YYYY-MM-DD' },
    dateTo: { type: 'string', description: '조회 종료일 YYYY-MM-DD (포함)' },
    hourFrom: { type: 'integer', minimum: 0, maximum: 23, description: '하루 중 조회 시작 시(0-23)' },
    hourTo: { type: 'integer', minimum: 1, maximum: 24, description: '하루 중 조회 종료 시(1-24)' },
    minSeats: { type: ['integer', 'null'], description: '필요한 최소 좌석 수. 언급 없으면 null' },
    minHours: { type: ['number', 'null'], description: '연속으로 필요한 최소 시간. 언급 없으면 null' },
    region: { type: ['string', 'null'], description: '부산 또는 서울. 언급 없으면 null' },
    summary: { type: 'string', description: '해석한 조건을 한 줄로 요약(한국어)' },
  },
  required: ['dateFrom', 'dateTo', 'hourFrom', 'hourTo', 'minSeats', 'minHours', 'region', 'summary'],
  additionalProperties: false,
};

/**
 * 회의실과 차량은 조건의 모양이 같다. 말투와 좌석 규칙만 다르게 일러 준다.
 * @param {'room'|'car'} kind
 */
const systemFor = (kind) => `당신은 사내 ${kind === 'car' ? '업무용 차량' : '회의실'} 예약 도우미입니다.
사용자의 한국어 요청을 ${kind === 'car' ? '차량' : '회의실'} 조회 조건으로 바꿉니다.

규칙:
- 날짜가 없으면 오늘 하루만 조회합니다(dateFrom = dateTo = 오늘).
- "이번 주", "다음 주" 같은 표현은 오늘을 기준으로 실제 날짜로 바꿉니다.
- 연도가 없으면 오늘과 같은 해로 봅니다.
- 시간대가 없으면 hourFrom 9, hourTo 18 로 둡니다.
- "10명" 처럼 인원이 나오면 minSeats 에 넣습니다. 인원 언급이 없으면 null 입니다.${kind === 'car' ? '\n- 차량에는 좌석 정보가 없으므로 minSeats 는 항상 null 입니다.' : ''}
- "2시간짜리" 처럼 필요한 길이가 나오면 minHours 에 넣습니다. 없으면 null 입니다.
- 지역은 부산 또는 서울만 가능합니다. 언급이 없으면 null 입니다.
- summary 는 사용자가 확인할 수 있게 해석 결과를 한 줄로 적습니다.`;

/**
 * 자연어를 조회 조건으로 바꾼다.
 * @param {string} text 사용자가 입력한 문장
 * @param {{apiKey: string, model?: string, today: string, kind?: 'room'|'car'}} opts
 */
export async function parseQuery(text, opts) {
  const { apiKey, model = DEFAULT_MODEL, today, kind = 'room' } = opts;
  if (!apiKey) throw new Error('Anthropic API 키가 설정되어 있지 않습니다.');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // 확장 페이지에서 직접 부르려면 필요하다
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: systemFor(kind),
      output_config: { format: { type: 'json_schema', schema: FILTER_SCHEMA } },
      messages: [{ role: 'user', content: `오늘은 ${today} 입니다.\n\n요청: ${text}` }],
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || '';
    } catch { /* 본문이 JSON 이 아닐 수 있다 */ }
    throw new Error(`Claude 호출 실패 (HTTP ${res.status}) ${detail}`.trim());
  }

  const body = await res.json();
  if (body.stop_reason === 'refusal') throw new Error('요청이 거부되었습니다. 다르게 적어보세요.');

  const block = (body.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('응답에서 조건을 읽지 못했습니다.');

  let filter;
  try {
    filter = JSON.parse(block.text);
  } catch {
    throw new Error('응답을 해석하지 못했습니다.');
  }
  return filter;
}

/* -------------------------------------------------- 예약 실패 원인 분석 */

const DIAG_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['rejected', 'maybe_saved', 'unknown'],
      description: '사이트가 거부한 것인지(rejected), 저장은 된 것 같은데 화면에 안 보이는 것인지(maybe_saved), 알 수 없는지(unknown)',
    },
    siteMessage: { type: 'string', description: '사이트가 사용자에게 실제로 띄운 문구. 없으면 빈 문자열' },
    cause: { type: 'string', description: '원인을 한국어 한두 문장으로' },
    fix: { type: 'string', description: '사용자가 할 수 있는 조치를 한국어 한 문장으로. 없으면 빈 문자열' },
  },
  required: ['verdict', 'siteMessage', 'cause', 'fix'],
  additionalProperties: false,
};

const DIAG_SYSTEM = `당신은 ASP.NET WebForms 사내 시스템에 회의실 예약을 자동 제출하는 프로그램의 진단 도우미입니다.
예약을 제출했지만 다시 조회했을 때 그 예약이 보이지 않았습니다.
아래는 저장 요청에 보낸 값과, 응답 페이지에서 **제출 전과 달라진 부분만** 추린 것입니다.

판단 기준:
- 응답에 새로 나타난 alert/스크립트나 안내 문구가 거부 사유를 말하고 있으면 verdict=rejected 입니다.
- 거부 흔적이 전혀 없고 폼 값도 정상이면 verdict=maybe_saved 입니다(승인 대기 등으로 목록에 안 보일 수 있음).
- 근거가 부족하면 verdict=unknown 입니다.

주의:
- 예약이 됐는지 안 됐는지는 이미 재조회로 확인했습니다. 당신은 원인만 설명합니다.
- 추측을 사실처럼 쓰지 마세요. 근거가 없으면 없다고 하세요.
- 한국어로, 짧고 구체적으로 씁니다.`;

/**
 * 저장 실패 원인을 분석한다.
 * 저장 성공 여부 자체는 재조회로 이미 판정했고, 여기서는 이유만 본다.
 */
export async function diagnoseSave(digest, opts) {
  const { apiKey, model = DEFAULT_MODEL } = opts;
  if (!apiKey) throw new Error('API 키가 없습니다.');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: DIAG_SYSTEM,
      output_config: { format: { type: 'json_schema', schema: DIAG_SCHEMA } },
      messages: [{ role: 'user', content: JSON.stringify(digest, null, 2) }],
    }),
  });

  if (!res.ok) throw new Error(`분석 호출 실패 (HTTP ${res.status})`);

  const body = await res.json();
  if (body.stop_reason === 'refusal') throw new Error('분석이 거부되었습니다.');

  const block = (body.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('분석 결과를 읽지 못했습니다.');
  return JSON.parse(block.text);
}
