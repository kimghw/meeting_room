// 차량 신청 폼(Admin_View_New.aspx)의 구조를 **문서를 보고** 찾아낸다.
//
// 이 페이지는 한 번도 캡처된 적이 없다. 목록 페이지에 죽은 채 남은 스크립트(fnSave)가
// DDL_CARNAME / TXT_TITLE / TXT_PLACE 같은 이름을 알려주지만, 그건 후보일 뿐이고
// 시각·날짜·저장 버튼은 이름조차 모른다. 이름을 안다고 가정하고 POST 하면
// **조용히 엉뚱한 값으로 제출된다** — 이 앱에서 가장 나쁜 실패다.
//
// 그래서 src/grid.js 가 RadGrid 컬럼을 위치가 아니라 내용으로 찾아내듯,
// 폼 필드도 **후보 이름 + 실제 내용** 두 가지를 다 보고 고른다.
//   - 시/분 드롭다운: 옵션 값이 0~23 인가, 10분 단위인가
//   - 차량 드롭다운: 옵션에 번호판 모양 "(181허4360)" 이 있는가
//   - 글자 칸: 옆 칸/라벨에 "사용목적" "행선지" 라고 적혀 있는가
//   - 날짜 칸: Telerik 날짜 피커의 짝(_dateInput_ClientState)이 같이 있는가
//
// 못 찾으면 못 찾았다고 말한다(ok:false). 부르는 쪽은 그때 제출하지 않는다.
// 네트워크를 타지 않는 순수 함수라 합성 fixture 로 테스트할 수 있다.

import { CAR_FORM_HINTS } from './config.js';
import { telerikDateFields, parseDate, sameDateText } from './parse.js';

const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const upper = (s) => (s || '').toUpperCase();

/** 한국 번호판: "(181허4360)", "(203도7395)". 차량 드롭다운을 가려내는 가장 확실한 신호다. */
export const PLATE_RE = /\(\s*\d{2,3}\s*[가-힣]\s*\d{4}\s*\)/;

/* ------------------------------------------------------------ 이름 힌트 */

/**
 * 이름에 시작/종료 힌트가 박혀 있는지 본다.
 * DDL_SHOUR / DDL_EHOUR, DP_SDATE / DP_EDATE, DDL_ROOMSHOUR / DDL_ROOMEHOUR 같은 관례다.
 * 구분자 없이 붙는 경우(ROOMEHOUR)가 실제로 있어 앞 글자를 요구하지 않는다.
 * 그래서 오탐이 날 수 있으므로 **한 쌍이 깔끔하게 갈릴 때만** 이 힌트를 쓴다(pairBySide 참고).
 */
export function sideHint(name) {
  const n = upper(name);
  if (/START|BEGIN|FROM/.test(n)) return 'start';
  if (/\bEND|_END|END_|ENDDATE|ENDHOUR|RETURN|FINISH/.test(n)) return 'end';
  const m = n.match(/([SE])[_$]?(DATE|HOUR|HH|MIN|MINUTE|MM|TIME)/);
  if (m) return m[1] === 'S' ? 'start' : 'end';
  return null;
}

/**
 * 후보 둘을 시작/종료로 나눈다.
 * 이름 힌트가 **정확히 하나씩** 갈라줄 때만 힌트를 믿고, 아니면 문서 순서를 쓴다
 * (앞의 짝이 시작, 뒤의 짝이 종료).
 * @returns {{start: any, end: any, by: 'hint'|'order'|'single'|'none'}}
 */
export function pairBySide(items, nameOf = (x) => x) {
  if (!items.length) return { start: null, end: null, by: 'none' };
  if (items.length === 1) return { start: items[0], end: null, by: 'single' };

  const starts = items.filter((x) => sideHint(nameOf(x)) === 'start');
  const ends = items.filter((x) => sideHint(nameOf(x)) === 'end');
  if (starts.length === 1 && ends.length === 1) return { start: starts[0], end: ends[0], by: 'hint' };

  return { start: items[0], end: items[1], by: 'order' };
}

/* ------------------------------------------------------------ 라벨 읽기 */

/** 입력칸 옆에 사람이 읽는 글자가 뭐라고 적혀 있는지 모은다. 이게 "내용" 쪽 근거다. */
export function labelTextOf(el, doc) {
  const parts = [];
  const id = el.getAttribute('id');
  if (id) {
    for (const l of doc.querySelectorAll('label')) {
      if (l.getAttribute('for') === id) parts.push(l.textContent);
    }
  }
  parts.push(el.getAttribute('title') || '', el.getAttribute('placeholder') || '');

  // 표 안이면 같은 행의 앞쪽 칸이 라벨이다. 두 칸까지만 본다(더 가면 남의 라벨을 집는다).
  const cell = el.closest ? el.closest('td, th') : null;
  if (cell) {
    let prev = cell.previousElementSibling;
    for (let i = 0; prev && i < 2; i++) {
      parts.push(prev.textContent);
      prev = prev.previousElementSibling;
    }
    const row = cell.closest('tr');
    const first = row ? row.querySelector('th, td') : null;
    if (first && first !== cell) parts.push(first.textContent);
  }
  return clean(parts.join(' | '));
}

/* --------------------------------------------------- select 종류 판정 */

/** 옵션의 숫자 값. value 가 숫자면 그것, 아니면 보이는 글자에서 읽는다. */
function optionNumbers(sel) {
  const out = [];
  for (const o of sel.querySelectorAll('option')) {
    const raw = o.getAttribute('value');
    const text = clean(o.textContent);
    // 값이 빈 안내 항목("선택하세요")은 건너뛴다. 이것 때문에 시 드롭다운을 놓치면 안 된다.
    if ((raw == null || raw === '') && !/^\d{1,2}$/.test(text)) continue;
    const pick = raw != null && /^\s*\d{1,2}\s*$/.test(raw) ? raw : text;
    if (!/^\s*\d{1,2}\s*$/.test(pick)) return null;   // 하나라도 숫자가 아니면 시/분이 아니다
    out.push(Number(pick));
  }
  return out.length ? out : null;
}

const MINUTE_SET = [0, 10, 20, 30, 40, 50];

/**
 * 드롭다운이 시(hour)인지 분(minute)인지 **옵션 내용만 보고** 판정한다.
 * 이름은 보지 않는다 — 이름이 AAA/BBB 여도 찾아내야 한다.
 */
export function selectTimeKind(sel) {
  const nums = optionNumbers(sel);
  if (!nums) return null;

  // 분: 10분 단위 여섯 칸 이하 (사이트가 00,10,...,50 만 받는다)
  if (nums.length >= 2 && nums.length <= 6 && nums.every((v) => MINUTE_SET.includes(v))) return 'minute';

  // 시: 0~24 범위를 열두 칸 넘게 덮고 끝이 저녁까지 간다
  if (nums.length >= 12 && nums.every((v) => v >= 0 && v <= 24) && Math.max(...nums) >= 18) return 'hour';

  return null;
}

/* ------------------------------------------------------------ 글자 칸 */

/**
 * 글자 입력칸 후보. 이름 힌트(names)와 라벨 글자(texts) 둘 다 본다.
 * 점수: 이름만 2점, 라벨만 3점(사람이 읽는 글자가 더 믿을 만하다), 둘 다면 5점.
 */
const TEXT_FIELDS = [
  { key: 'title', label: '사용목적',
    names: [/TITLE/, /PURPOSE/, /SUBJECT/], texts: [/사용\s*목적/, /용도/, /목적(?!\s*지)/] },
  { key: 'place', label: '행선지',
    names: [/PLACE/, /DEST/], texts: [/행선지/, /목적지/, /도착지/, /방문지/] },
  { key: 'driver', label: '운전자',
    names: [/DRIVER(?!.*(DEPT|ID))/], texts: [/운전자/, /운전\s*자/] },
  { key: 'driverDept', label: '운전자 부서',
    names: [/DRIVER.*DEPT/, /DEPT/], texts: [/부서/, /소속/] },
  // 사번은 보통 숨은 칸이라 라벨이 없다. 이름만으로 찾을 수밖에 없다.
  { key: 'driverId', label: '운전자 사번',
    names: [/DRIVER.*ID/, /HIDDRIVER/, /EMP.*(ID|NO)/], texts: [] },
  { key: 'passenger', label: '동승자',
    names: [/PASSENGER/, /RIDER/], texts: [/동승자?/, /탑승자/] },
];

/* ------------------------------------------------------------ 날짜 칸 */

/**
 * Telerik RadDatePicker 는 글자 칸 하나로 끝나지 않는다.
 *   <base>            보이는 글자 칸
 *   <base>$dateInput  안쪽 입력칸
 *   <base>_dateInput_ClientState  **서버가 실제로 읽는 값**
 *   <base>_calendar_SD            달력이 고른 날
 * 이 짝이 문서에 있으면 날짜 피커가 확실하다. 자세한 사정은 README "날짜 칸은 글자만 채우면 안 먹는다".
 */
export function telerikDatePickerNames(base) {
  return {
    date: base,
    dateInput: `${base}$dateInput`,
    dateInputClientState: `${base}_dateInput_ClientState`,
    dateCalendarSelected: `${base}_calendar_SD`,
    // 스킨에 따라 보이는 글자 칸이 따로 있다(차량 신청 폼). 없는 폼도 있어 있을 때만 쓴다.
    dateInputText: `${base}_dateInput_text`,
  };
}

/** 문서에 있는 Telerik 날짜 피커의 바탕 이름들을 문서 순서대로 모은다. */
function telerikBases(doc) {
  const bases = [];
  for (const el of doc.querySelectorAll('input')) {
    const name = el.getAttribute('name') || '';
    let m = name.match(/^(.+)_dateInput_ClientState$/);
    if (!m) m = name.match(/^(.+)\$dateInput$/);
    if (m && !bases.includes(m[1])) bases.push(m[1]);
  }
  return bases;
}

/** 날짜 피커가 없을 때 쓰는 글자 날짜 칸. 이름에 DATE 가 있거나 값이 날짜로 읽히는 칸. */
function textDateFields(doc) {
  const out = [];
  for (const el of doc.querySelectorAll('input')) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type !== 'text' && type !== 'date') continue;
    const name = el.getAttribute('name');
    if (!name) continue;
    const byName = /DATE|_DT|YMD/.test(upper(name));
    const byValue = !!parseDate(el.getAttribute('value') || '');
    if (byName || byValue) out.push({ name, byName, byValue });
  }
  return out;
}

/* ------------------------------------------------------------ 저장 버튼 */

const SAVE_NAME_RE = /SAVE|REG(?!ION)|INSERT|\bOK\b|OK$|SUBMIT|APPLY/;
const SAVE_TEXT_RE = /저장|신청|확인|등록/;

function detectSave(doc) {
  const cands = [...doc.querySelectorAll('input, button, a')];
  let best = null;

  for (const el of cands) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && !['image', 'submit', 'button'].includes(type)) continue;

    const name = el.getAttribute('name') || '';
    const id = el.getAttribute('id') || '';
    const words = `${el.getAttribute('value') || ''} ${el.getAttribute('alt') || ''} ` +
      `${el.getAttribute('src') || ''} ${clean(el.textContent)}`;
    const onclick = `${el.getAttribute('onclick') || ''} ${el.getAttribute('href') || ''}`;

    let score = 0;
    const why = [];
    if (SAVE_NAME_RE.test(upper(`${name} ${id}`))) { score += 2; why.push('이름'); }
    if (SAVE_TEXT_RE.test(words)) { score += 3; why.push('글자'); }
    if (type === 'image' || type === 'submit') { score += 1; why.push(`type=${type}`); }
    if (isKnownHint('save', name)) { score += 1; why.push('알려진 후보'); }
    if (!score) continue;

    let kind = null;
    let target = name;
    if (type === 'image') kind = 'image';
    else if (type === 'submit') kind = 'submit';
    else {
      const pb = onclick.match(/__doPostBack\s*\(\s*['"]([^'"]+)['"]/);
      if (pb) { kind = 'postback'; target = pb[1]; }
      else if (name) kind = 'submit';
    }
    if (!kind || !target) continue;

    if (!best || score > best.score) {
      best = { score, kind, name: target, why: why.join('+'), value: el.getAttribute('value') || '' };
    }
  }
  if (best) return best;

  // 버튼 마크업을 못 찾으면 스크립트에 박힌 __doPostBack 대상이라도 찾아본다.
  const html = doc.documentElement ? doc.documentElement.outerHTML : '';
  for (const m of html.matchAll(/__doPostBack\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (SAVE_NAME_RE.test(upper(m[1]))) {
      return { score: 1, kind: 'postback', name: m[1], why: '스크립트의 __doPostBack 대상', value: '' };
    }
  }
  return null;
}

/* ------------------------------------------------------------ 감지 본체 */

/**
 * 차량 신청 폼의 구조를 알아낸다. 네트워크를 타지 않는 순수 함수다.
 *
 * @param {Document} doc 신청 폼 페이지
 * @returns {{
 *   ok: boolean,
 *   fields: {
 *     car, driver, driverDept, driverId, title, place, passenger,
 *     startDate, startHour, startMinute, endDate, endHour, endMinute,
 *     save, saveKind, dateKind,
 *   },
 *   missing: string[],
 *   found: object,
 *   reason: string,
 * }}
 */
export function detectCarForm(doc) {
  const fields = {
    car: null, driver: null, driverDept: null, driverId: null,
    title: null, place: null, passenger: null,
    startDate: null, startHour: null, startMinute: null,
    endDate: null, endHour: null, endMinute: null,
    save: null, saveKind: null, dateKind: null,
  };
  const found = { optionValues: {}, why: {} };

  if (!doc || !doc.querySelectorAll) {
    return { ok: false, fields, missing: ['문서'], found, reason: '문서를 받지 못했습니다.' };
  }

  /* 1) 시/분 드롭다운 — 옵션 내용만 보고 가른다. 이름은 나중에 짝을 지을 때만 쓴다. */
  const selects = [...doc.querySelectorAll('select')];
  const hours = [];
  const minutes = [];
  const takenSelects = new Set();

  for (const sel of selects) {
    const name = sel.getAttribute('name');
    if (!name) continue;
    const kind = selectTimeKind(sel);
    if (!kind) continue;
    const values = [...sel.querySelectorAll('option')].map((o) => o.getAttribute('value') ?? clean(o.textContent));
    found.optionValues[name] = values;
    takenSelects.add(sel);
    (kind === 'hour' ? hours : minutes).push({ name, sel });
  }

  const hourPair = pairBySide(hours, (x) => x.name);
  const minutePair = pairBySide(minutes, (x) => x.name);
  fields.startHour = hourPair.start ? hourPair.start.name : null;
  fields.endHour = hourPair.end ? hourPair.end.name : null;
  fields.startMinute = minutePair.start ? minutePair.start.name : null;
  fields.endMinute = minutePair.end ? minutePair.end.name : null;
  found.why.hour = `옵션 내용으로 ${hours.length}개 찾음 / 짝은 ${hourPair.by}`;
  found.why.minute = `옵션 내용으로 ${minutes.length}개 찾음 / 짝은 ${minutePair.by}`;

  /* 2) 차량 드롭다운 — 시/분으로 이미 쓴 select 는 빼고 고른다. */
  let carBest = null;
  for (const sel of selects) {
    if (takenSelects.has(sel)) continue;
    const name = sel.getAttribute('name');
    if (!name) continue;

    const optText = [...sel.querySelectorAll('option')].map((o) => clean(o.textContent)).join(' | ');
    let score = 0;
    const why = [];
    if (/CARNAME|VEHICLE|RENT/.test(upper(name))) { score += 3; why.push('이름'); }
    else if (/CAR/.test(upper(name))) { score += 2; why.push('이름'); }
    if (PLATE_RE.test(optText)) { score += 3; why.push('옵션에 번호판'); }
    if (/차량|차종|렌트/.test(labelTextOf(sel, doc))) { score += 2; why.push('라벨'); }
    if (isKnownHint('car', name)) { score += 1; why.push('알려진 후보'); }
    if (!score) continue;

    if (!carBest || score > carBest.score) carBest = { name, score, why: why.join('+'), sel };
  }
  if (carBest) {
    fields.car = carBest.name;
    found.why.car = carBest.why;
    found.optionValues[carBest.name] =
      [...carBest.sel.querySelectorAll('option')].map((o) => o.getAttribute('value') ?? clean(o.textContent));
  }

  /* 3) 날짜 칸 — Telerik 짝이 있으면 그것, 없으면 글자 칸. */
  const bases = telerikBases(doc);
  const dateNames = new Set();
  if (bases.length) {
    const pair = pairBySide(bases, (b) => b);
    fields.dateKind = 'telerik';
    fields.startDate = pair.start;
    fields.endDate = pair.end;
    found.why.date = `Telerik 날짜 피커 ${bases.length}개(${bases.join(', ')}) / 짝은 ${pair.by}`;
    for (const b of bases) {
      const n = telerikDatePickerNames(b);
      for (const v of Object.values(n)) dateNames.add(v);
    }
  } else {
    const texts = textDateFields(doc);
    if (texts.length) {
      const pair = pairBySide(texts, (x) => x.name);
      fields.dateKind = 'text';
      fields.startDate = pair.start ? pair.start.name : null;
      fields.endDate = pair.end ? pair.end.name : null;
      found.why.date = `글자 날짜 칸 ${texts.length}개 / 짝은 ${pair.by}`;
      for (const t of texts) dateNames.add(t.name);
    } else {
      found.why.date = '날짜 칸을 찾지 못했습니다(폼이 주소의 SDATE 를 그대로 쓸 수도 있습니다).';
    }
  }

  /* 4) 글자 칸 — 이름과 라벨 점수를 매기고 겹치지 않게 짝짓는다. */
  const inputs = [];
  for (const el of doc.querySelectorAll('input, textarea')) {
    const name = el.getAttribute('name');
    if (!name || dateNames.has(name)) continue;
    const type = el.tagName === 'TEXTAREA' ? 'text' : (el.getAttribute('type') || 'text').toLowerCase();
    if (!['text', 'hidden', 'search'].includes(type)) continue;
    inputs.push({ el, name, type, label: labelTextOf(el, doc) });
  }

  const scored = [];
  for (const spec of TEXT_FIELDS) {
    for (const cand of inputs) {
      const byName = spec.names.some((re) => re.test(upper(cand.name)));
      // 숨은 칸에는 사람이 읽는 라벨이 없다. 옆 칸 글자를 라벨로 삼으면 남의 라벨을 훔친다.
      const byText = cand.type !== 'hidden' && spec.texts.some((re) => re.test(cand.label));
      // config 의 후보 이름 목록(fnSave/fnCancel 에서 캐낸 것)과 정확히 같으면 한 점 더.
      // 결정적 근거는 아니지만 애매할 때 갈라주는 데 쓴다.
      const known = isKnownHint(spec.key, cand.name);
      const score = (byName ? 2 : 0) + (byText ? 3 : 0) + (known ? 1 : 0);
      if (!score) continue;
      const why = [byName && '이름', byText && '라벨', known && '알려진 후보'].filter(Boolean).join('+');
      scored.push({ key: spec.key, name: cand.name, score, why });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const usedKey = new Set();
  const usedName = new Set();
  for (const s of scored) {
    if (usedKey.has(s.key) || usedName.has(s.name)) continue;
    usedKey.add(s.key);
    usedName.add(s.name);
    fields[s.key] = s.name;
    found.why[s.key] = s.why;
  }

  /* 5) 저장 버튼 */
  const save = detectSave(doc);
  if (save) {
    fields.save = save.name;
    fields.saveKind = save.kind;
    found.why.save = save.why;
    found.saveValue = save.value;
  }

  /* 6) 필수 칸 점검 — 하나라도 없으면 제출하지 않는다. */
  const REQUIRED = [
    ['car', '차량'],
    ['title', '사용목적'],
    ['place', '행선지'],
    ['startHour', '시작 시'],
    ['startMinute', '시작 분'],
    ['endHour', '종료 시'],
    ['endMinute', '종료 분'],
    ['save', '저장 버튼'],
  ];
  const missing = REQUIRED.filter(([k]) => !fields[k]).map(([, label]) => label);

  return {
    ok: missing.length === 0,
    fields,
    missing,
    found,
    reason: missing.length ? `신청 폼에서 ${missing.join('·')} 칸을 찾지 못했습니다.` : '',
  };
}

/* ------------------------------------------------------------ 폼 채우기 */

/** 'HH:MM' → {hour, minute}. 이미 분 단위 숫자면 그대로 나눈다. */
function splitHM(value) {
  if (typeof value === 'number') return { hour: Math.floor(value / 60), minute: value % 60 };
  const m = String(value || '').match(/(\d{1,2})\s*:\s*(\d{1,2})/);
  if (!m) return null;
  return { hour: +m[1], minute: +m[2] };
}

/**
 * 드롭다운이 실제로 들고 있는 옵션 값을 쓴다.
 * "9" 인지 "09" 인지 사이트마다 다르고, 없는 값을 보내면 서버가 조용히 첫 항목을 쓴다.
 */
function optionFor(detected, name, n) {
  const values = detected.found && detected.found.optionValues ? detected.found.optionValues[name] : null;
  if (values) {
    const hit = values.find((v) => Number(v) === n);
    if (hit != null) return hit;
  }
  return String(n);
}

/**
 * 사이트의 `fnSaveCheck()` 가 실제로 막는 것들.
 * **2026-09-16 실제 신청 폼 캡처에서 읽은 규칙이다** — 추측이 아니다.
 *
 * 제출해 보고 alert 를 읽는 대신 여기서 먼저 걸러낸다. 사내 시스템에 헛제출을 하지 않고,
 * 무엇이 왜 안 되는지 그 자리에서 말할 수 있다.
 *
 * **사용목적(txtTitle)은 요구하지 않는다.** 차량 목록 페이지에 죽은 채 남아 있는 fnSave() 는
 * 요구하지만, 실제 신청 폼의 fnSaveCheck() 는 보지 않는다. 죽은 코드를 믿고 사람을 막으면
 * 사이트에서는 되는 일이 이 확장에서만 안 된다.
 *
 * @param {object} detected detectCarForm 결과
 * @param {object} payload  reserveCar payload
 * @param {object} current  폼이 이미 들고 있는 값(name → value).
 *   사용자·부서는 사이트가 로그인 정보로 채워 주므로 payload 에 없어도 된다.
 * @returns {string[]} 사람이 읽을 문제 목록. 비어 있으면 제출해도 된다.
 */
export function carFormProblems(detected, payload, current = {}) {
  const f = (detected && detected.fields) || {};
  const problems = [];

  const s = splitHM(payload.start);
  const e = splitHM(payload.end);
  const endDate = payload.endDate || payload.date;

  if (!s || !e) {
    problems.push(`시간을 읽지 못했습니다(${payload.start} ~ ${payload.end}).`);
  } else if (endDate < payload.date) {
    problems.push('시작일이 종료일보다 클 수 없습니다.');
  } else if (endDate === payload.date && s.hour * 60 + s.minute >= e.hour * 60 + e.minute) {
    // 사이트는 **시(hour)만** 비교해서 09:50~09:00 을 통과시킨다. 우리는 분까지 본다 —
    // 사이트보다 엄격한 쪽이 안전하다. 09:30~09:50 처럼 정상인 범위는 그대로 통과한다.
    problems.push('시작시간이 종료시간보다 클 수 없습니다.');
  }

  /** payload 에 온 값이 먼저, 없으면 폼이 이미 들고 있는 값. */
  const valueOf = (name, given) => {
    if (given !== undefined && given !== null && String(given).trim()) return String(given).trim();
    return String((name && current[name]) || '').trim();
  };

  if (!valueOf(f.driver, payload.driver)) problems.push('사용자는 필수 입력 사항입니다.');
  if (!valueOf(f.driverDept, payload.driverDept)) problems.push('사용자 부서가 비어 있습니다.');
  if (!valueOf(f.place, payload.place)) problems.push('행선지는 필수 입력 사항입니다.');

  return problems;
}

/**
 * 신청 폼이 채워 주는 **로그인한 사람**.
 *
 * 이 사이트에서 로그인한 사람이 누구인지 알 수 있는 유일한 자리다. 조회 화면에는
 * 숨은 입력칸에도 없어서, 그동안은 예약을 한 건 넣어 확인될 때까지 이름을 알 수 없었다.
 * 신청 폼은 사용자명·부서·사번을 미리 채워서 내려준다.
 *
 * @returns {{name: string, dept: string, id: string} | null}
 */
export function readFormWho(doc, detected) {
  const f = (detected && detected.fields) || {};
  const val = (name) => {
    if (!name || !doc || !doc.getElementsByName) return '';
    const el = doc.getElementsByName(name)[0];
    return el ? String(el.getAttribute('value') || '').trim() : '';
  };
  const who = { name: val(f.driver), dept: val(f.driverDept), id: val(f.driverId) };
  return (who.name || who.dept || who.id) ? who : null;
}

/**
 * 칸이 **지금 들고 있는 값**. 부르는 쪽이 넘긴 current 를 먼저 보고, 없으면 문서에서 읽는다.
 *
 * 날짜 칸의 표기를 잘못 짚으면 저장이 통째로 터지므로(HTTP 500 — Telerik 이 글자를 날짜로
 * 읽지 못한다) 짐작하지 않고 폼에 적힌 것을 확인한다.
 */
function currentOf(detected, current, name) {
  if (current && name in current) return current[name];
  const doc = detected && detected.doc;
  const el = doc && doc.getElementsByName ? doc.getElementsByName(name)[0] : null;
  return el ? (el.getAttribute('value') ?? '') : undefined;
}

/** 날짜 피커 한 벌의 현재 값. */
function currentValues(detected, current, names) {
  const out = {};
  for (const name of Object.values(names)) {
    const v = currentOf(detected, current, name);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * 감지 결과와 payload 로 실제 POST 할 필드 묶음을 만든다.
 *
 * **ok:false 인 감지 결과를 받으면 던진다** — 모르는 폼에 값을 밀어 넣지 않는다.
 * 사이트가 거부할 것이 뻔한 값(carFormProblems)도 던진다 — 헛제출을 하지 않는다.
 * 빈 값은 넣지 않는다. 포스트백은 폼의 현재 값에서 출발하므로, 빈 문자열을 얹으면
 * 사이트가 미리 채워 둔 값(로그인한 사람 이름 등)을 지우게 된다.
 *
 * @param {object} detected detectCarForm 결과
 * @param {object} payload  reserveCar 와 같은 모양
 * @param {object} current  폼이 이미 들고 있는 값(name → value). 필수 칸 검사에 쓴다.
 * @returns {object} name → value
 */
export function buildCarFields(detected, payload, current = {}) {
  if (!detected || !detected.ok) {
    const why = detected && detected.reason ? detected.reason : '감지 결과가 없습니다.';
    throw new Error(`신청 폼 구조를 확인하지 못해 값을 채우지 않습니다. ${why}`);
  }
  const problems = carFormProblems(detected, payload, current);
  if (problems.length) throw new Error(problems.join(' '));
  const f = detected.fields;
  const out = {};
  const put = (name, value) => {
    if (!name) return;
    if (value === undefined || value === null || value === '') return;
    out[name] = String(value);
  };

  put(f.car, payload.carValue);
  put(f.title, payload.title);
  put(f.place, payload.place);
  put(f.driver, payload.driver);
  put(f.driverDept, payload.driverDept);
  put(f.driverId, payload.driverId);
  put(f.passenger, payload.passenger);

  const s = splitHM(payload.start);
  const e = splitHM(payload.end);
  if (!s || !e) throw new Error(`시간 형식을 읽지 못했습니다(${payload.start} ~ ${payload.end}).`);
  put(f.startHour, optionFor(detected, f.startHour, s.hour));
  put(f.startMinute, optionFor(detected, f.startMinute, s.minute));
  put(f.endHour, optionFor(detected, f.endHour, e.hour));
  put(f.endMinute, optionFor(detected, f.endMinute, e.minute));

  // 차량은 여러 날에 걸친다. 종료 날짜 칸이 없으면 하루짜리 폼이다.
  //
  // 신청 폼은 `?SDATE=` 로 열기 때문에 **이미 맞는 날짜를 들고 있는 경우가 대부분이다.**
  // 맞는 값을 굳이 다시 쓰지 않는다 — 날짜 피커는 글자 칸 하나만 표기가 어긋나도
  // 서버가 날짜를 못 읽어 저장이 통째로 터진다. 바꿔야 할 때만, 폼의 생김새를 지켜 쓴다.
  const endDate = payload.endDate || payload.date;
  const writeDate = (name, dateStr) => {
    if (!name) return;
    const names = telerikDatePickerNames(name);
    const now = currentValues(detected, current, names);
    if (sameDateText(now[name], dateStr)) return;      // 이미 그 날이면 그대로 둔다
    Object.assign(out, telerikDateFields(dateStr, names, now));
  };

  if (f.dateKind === 'telerik') {
    writeDate(f.startDate, payload.date);
    writeDate(f.endDate, endDate);
  } else if (f.dateKind === 'text') {
    if (f.startDate && !sameDateText(currentOf(detected, current, f.startDate), payload.date)) {
      put(f.startDate, payload.date);
    }
    if (f.endDate && !sameDateText(currentOf(detected, current, f.endDate), endDate)) {
      put(f.endDate, endDate);
    }
  }

  if (f.saveKind === 'image') {
    // 이미지 버튼은 좌표로 눌린 것을 알린다(회의실 BTN_SAVE 와 같다).
    out[`${f.save}.x`] = '10';
    out[`${f.save}.y`] = '10';
  } else if (f.saveKind === 'submit') {
    out[f.save] = (detected.found && detected.found.saveValue) || '저장';
  } else if (f.saveKind === 'postback') {
    out.__EVENTTARGET = f.save;
    out.__EVENTARGUMENT = '';
  }

  return out;
}

/* ------------------------------------------------------------ 응답 읽기 */

/**
 * 응답에 **새로 생긴** alert 문구만 골라낸다.
 *
 * 차량 페이지에는 fnSave() 안에 alert('렌트할 차량을 선택 하세요.') 같은 문구가
 * 처음부터 박혀 있다. 그냥 긁어오면 예약에 성공해도 오류 문구를 보고하게 된다.
 * 제출 전 HTML 에도 있던 문구는 정적이므로 무시한다.
 * (src/site.js 에 같은 함수가 있지만 export 되어 있지 않아 여기에 둔다.)
 */
export function readAlert(html, baselineHtml = '') {
  const found = [...String(html || '').matchAll(/alert\s*\(\s*["']([^"']{1,200})["']/g)].map((m) => m[1]);
  const before = new Set(
    [...String(baselineHtml || '').matchAll(/alert\s*\(\s*["']([^"']{1,200})["']/g)].map((m) => m[1]),
  );
  return found.find((t) => !before.has(t)) || '';
}

/** 후보 이름 목록(config)에 있는 이름인지. 진단 화면에서 "아는 이름인가"를 보여줄 때 쓴다. */
export function isKnownHint(key, name) {
  const list = CAR_FORM_HINTS[key] || [];
  return list.some((h) => upper(h) === upper(name));
}
