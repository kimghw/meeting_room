// API 키 없이 쓰는 규칙 기반 질의 해석기.
// 흔한 문장은 여기서 처리하고, 키가 있으면 ai.js 가 더 유연하게 해석한다.

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** 월요일을 주의 시작으로 본다. */
function weekStart(d) {
  const x = new Date(d);
  const dow = (x.getDay() + 6) % 7; // 월=0
  return addDays(x, -dow);
}

/** "오후 2시" 처럼 오전/오후가 붙은 시각을 24시간제로. */
function toHour24(raw, ampm) {
  let h = raw;
  if (ampm === '오후' && h < 12) h += 12;
  if (ampm === '오전' && h === 12) h = 0;
  return h;
}

function parseDates(text, today) {
  const base = new Date(`${today}T00:00:00`);

  if (/모레|내일모레/.test(text)) { const d = addDays(base, 2); return { from: ymd(d), to: ymd(d), how: '모레' }; }
  if (/내일/.test(text)) { const d = addDays(base, 1); return { from: ymd(d), to: ymd(d), how: '내일' }; }
  if (/오늘/.test(text)) return { from: today, to: today, how: '오늘' };

  if (/다음\s*주|담주/.test(text)) {
    const s = addDays(weekStart(base), 7);
    return { from: ymd(s), to: ymd(addDays(s, 4)), how: '다음 주 평일' };
  }
  if (/이번\s*주|금주/.test(text)) {
    const s = weekStart(base);
    return { from: ymd(s), to: ymd(addDays(s, 4)), how: '이번 주 평일' };
  }

  // "9월 20일 ... 27일" / "9/20 ~ 9/27" 형태에서 날짜를 순서대로 모은다
  const found = [];
  const re = /(?:(\d{1,2})\s*[월/.-]\s*)?(\d{1,2})\s*일/g;
  let m;
  let lastMonth = null;
  while ((m = re.exec(text))) {
    const month = m[1] ? +m[1] : lastMonth;
    if (!month) continue;
    lastMonth = month;
    found.push({ month, day: +m[2] });
  }
  // "9/20" 처럼 '일' 없이 쓴 경우
  if (!found.length) {
    const re2 = /\b(\d{1,2})\s*[/.-]\s*(\d{1,2})\b/g;
    while ((m = re2.exec(text))) found.push({ month: +m[1], day: +m[2] });
  }
  if (!found.length) return null;

  const year = base.getFullYear();
  const mk = (f) => ymd(new Date(year, f.month - 1, f.day));
  const from = mk(found[0]);
  const to = found.length > 1 ? mk(found[found.length - 1]) : from;
  return { from, to: to < from ? from : to, how: from === to ? from : `${from} ~ ${to}` };
}

function parseHours(text) {
  // "오전 8시부터 오후 12시까지", "8시~12시", "08:00~12:00"
  const re = /(오전|오후)?\s*(\d{1,2})\s*(?:시|:00)?\s*(?:부터|~|-|–|에서)\s*(오전|오후)?\s*(\d{1,2})\s*(?:시|:00)?\s*(?:까지)?/;
  const m = text.match(re);
  if (m) {
    const start = toHour24(+m[2], m[1]);
    let end = toHour24(+m[4], m[3]);
    // "8시부터 12시까지" 에서 오후 표기가 없어도 끝이 앞서면 오후로 본다
    if (end <= start) end = end + 12 <= 24 ? end + 12 : 24;
    if (end > start) return { start, end, how: `${pad(start)}:00~${pad(end)}:00` };
  }
  if (/오후/.test(text)) return { start: 12, end: 18, how: '오후' };
  if (/오전/.test(text)) return { start: 9, end: 12, how: '오전' };
  return null;
}

/**
 * 문장을 조회 조건으로 바꾼다. ai.js 의 parseQuery 와 같은 모양을 돌려준다.
 * @param {string} text
 * @param {string} today 'YYYY-MM-DD'
 */
export function parseLocal(text, today) {
  const t = (text || '').trim();
  const parts = [];

  const dates = parseDates(t, today);
  const hours = parseHours(t);

  const seatM = t.match(/(\d{1,3})\s*명/);
  const minSeats = seatM ? +seatM[1] : null;

  const durM = t.match(/(\d{1,2}(?:\.\d)?)\s*시간(?!\s*\d)/);
  const minHours = durM ? +durM[1] : null;

  const region = /서울/.test(t) ? '서울' : /부산/.test(t) ? '부산' : null;

  if (dates) parts.push(dates.how);
  else parts.push('오늘');
  if (hours) parts.push(hours.how);
  if (minSeats) parts.push(`${minSeats}명 이상`);
  if (minHours) parts.push(`${minHours}시간 연속`);
  if (region) parts.push(region);

  return {
    dateFrom: dates ? dates.from : today,
    dateTo: dates ? dates.to : today,
    hourFrom: hours ? hours.start : 9,
    hourTo: hours ? hours.end : 18,
    minSeats,
    minHours,
    region,
    summary: parts.join(' · '),
    // 날짜도 시간도 못 읽었으면 기본값으로 돈 것이라고 알려준다
    guessed: !dates && !hours,
  };
}
