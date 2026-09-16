import { FORM, GRID } from './config.js';

const clean = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const scriptsOf = (doc) =>
  [...doc.querySelectorAll('script')].map((s) => clean(s.textContent)).filter(Boolean);

/** 응답에서 폼 필드가 실제로 어떤 값으로 돌아왔는지 읽는다. */
function readField(doc, name) {
  const el = doc.getElementsByName(name)[0];
  if (!el) return null;
  if (el.tagName === 'SELECT') {
    const opt = el.querySelector('option[selected]');
    return opt ? (opt.getAttribute('value') ?? clean(opt.textContent)) : '(선택 없음)';
  }
  return el.getAttribute('value') ?? '';
}

/** 붉은 글씨 등 화면에 뜬 짧은 안내 문구. */
function noticesOf(doc) {
  const out = [];
  for (const n of doc.querySelectorAll('span, font, div, td')) {
    const style = `${n.getAttribute('style') || ''} ${n.getAttribute('class') || ''}`;
    if (!/red|error|warn|경고/i.test(style)) continue;
    const t = clean(n.textContent);
    if (t && t.length <= 120) out.push(t);
  }
  return [...new Set(out)];
}

/**
 * 저장 응답에서 판단에 필요한 부분만 뽑아 작은 요약으로 만든다.
 *
 * 응답 HTML 은 130KB 가 넘는데 대부분 ViewState 와 달력이라
 * 통째로 모델에 보내면 비싸기만 하고 도움이 안 된다.
 * 제출 전 페이지와 **달라진 것**을 중심으로 추린다.
 */
export function buildSaveDigest(html, baselineHtml, fields, payload) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base = new DOMParser().parseFromString(baselineHtml || '', 'text/html');

  const had = new Set(scriptsOf(base));
  const newScripts = scriptsOf(doc).filter((t) => !had.has(t)).map((t) => t.slice(0, 400));

  const hadNotice = new Set(noticesOf(base));
  const newNotices = noticesOf(doc).filter((t) => !hadNotice.has(t));

  const grid = doc.getElementById(GRID.tableId);
  const rowCount = grid ? [...grid.rows].filter((r) => r.cells.length >= GRID.minCells && !r.querySelector('th')).length : null;

  return {
    보낸값: {
      지역: payload.region,
      회의실: payload.roomValue,
      날짜: payload.date,
      시작: payload.start,
      종료: payload.end,
      회의주제: payload.title,
    },
    응답에_남은_폼값: {
      지역: readField(doc, FORM.region),
      회의실: readField(doc, FORM.room),
      날짜: readField(doc, FORM.date),
      시작시: readField(doc, FORM.startHour),
      시작분: readField(doc, FORM.startMinute),
      종료시: readField(doc, FORM.endHour),
      종료분: readField(doc, FORM.endMinute),
      회의주제: readField(doc, FORM.title),
    },
    새로_나타난_스크립트: newScripts.slice(0, 8),
    새로_나타난_안내문구: newNotices.slice(0, 10),
    예약표_행수: rowCount,
    보낸_필드이름: Object.keys(fields || {}).filter((k) => !/VIEWSTATE|EVENTVALIDATION|_TSM|ClientState/.test(k)),
  };
}
