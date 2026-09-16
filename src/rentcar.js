// 차량 이용 신청. 회의실과 같은 VSDotnet/Telerik 앱이지만 표 구조가 다르다.
//
//  - 시간이 본 행이 아니라 상세 표에 있다
//  - 한 건이 여러 날에 걸친다: "26.09.16 (수) 09:00 ~ 26.09.18 (금) 21:00"
//  - 목록은 그날 것만이 아니라 앞뒤 날짜 예약까지 함께 보여준다
//
// 그래서 날짜 범위를 풀어서 고른 날짜와 겹치는 부분만 잘라 격자에 칠한다.

import {
  ORIGIN, DEFAULT_HOURS, CALENDAR, CAR_GRID, CAR_DATE_LABEL_ID,
  CAR_RESERVE_URL, CAR_DELETE,
} from './config.js';
import { siteFetch } from './net.js';
import { parseHtml, postback, formState } from './aspnet.js';
import {
  parseDate, parseDayCounts, buildGrid, fmtTime, parseTime, rowDeleteHandle, rowDeleteSubmit,
} from './parse.js';
import { detectCarForm, buildCarFields, readAlert, readFormWho } from './carform.js';

export const CAR_LIST_URL = `${ORIGIN}/intra/intranet/VSDotnet/RentCar/New_List.aspx?s_code=0102010300`;
export const CAR_SHELL_URL = `${ORIGIN}/GAPSU/GeneralAffairs/SurveyWork/BusinessVehicle/BVM_Car_List.aspx?s_code=0102010100`;

const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/* ---------------------------------------------------------------- 시각 */

/**
 * "26.09.16 (수) 09:00" 한 쪽을 푼다.
 * @returns {{date: string, minutes: number} | null}
 */
export function parseCarMoment(text) {
  const t = clean(text);
  const m = t.match(/(\d{2,4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*(?:\([^)]*\))?\s*(\d{1,2})\s*:\s*(\d{2})/);
  if (!m) return null;

  let year = +m[1];
  if (year < 100) year += 2000;
  const hour = +m[4];
  const min = +m[5];
  if (hour > 24 || min > 59) return null;

  return {
    date: `${year}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`,
    minutes: hour * 60 + min,
  };
}

/**
 * "26.09.16 (수) 09:00 ~ 26.09.18 (금) 21:00" 을 시작/종료로 나눈다.
 * 끝쪽에 날짜가 없으면 시작과 같은 날로 본다.
 */
export function parseCarRange(text) {
  const t = clean(text);
  const idx = t.search(/~/);
  if (idx < 0) return null;

  const start = parseCarMoment(t.slice(0, idx));
  if (!start) return null;

  const tail = t.slice(idx + 1);
  let end = parseCarMoment(tail);
  if (!end) {
    // "09:00 ~ 21:00" 처럼 날짜가 생략된 경우
    const hm = clean(tail).match(/(\d{1,2})\s*:\s*(\d{2})/);
    if (!hm) return null;
    end = { date: start.date, minutes: +hm[1] * 60 + +hm[2] };
  }
  return { start, end };
}

/** 여러 날에 걸친 예약을 특정 날짜 안의 구간으로 자른다. 겹치지 않으면 null. */
export function clipToDate(range, dateStr) {
  const { start, end } = range;
  if (dateStr < start.date || dateStr > end.date) return null;

  return {
    start: dateStr === start.date ? start.minutes : 0,
    end: dateStr === end.date ? end.minutes : 24 * 60,
  };
}

/* ---------------------------------------------------------------- 표 */

/** 화면이 보여주는 날짜. 차량 화면은 라벨 id 가 다르다. */
export function parseCarShownDate(doc) {
  const el = doc.getElementById(CAR_DATE_LABEL_ID);
  return el ? parseDate(el.textContent) : null;
}

/** 본인 신청 건에만 붙는 수정/삭제 버튼. */
function rowIsMine(row) {
  return [...row.querySelectorAll('a, input, img, span')].some((n) => {
    const hint = `${n.getAttribute('href') || ''} ${n.getAttribute('onclick') || ''}`;
    return /fn_del\s*\(|fn_update\s*\(|fn_modify\s*\(/.test(hint);
  });
}

/** 예약 버튼의 onclick 에서 차량 번호(CARIDX)를 꺼낸다. */
function carIdxOf(row) {
  for (const n of row.querySelectorAll('input, a')) {
    const m = (n.getAttribute('onclick') || '').match(/CARIDX=(\d+)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * 차량 목록과 그날 이용 내역을 읽는다.
 *
 * @returns {{cars: Array, reservations: Array, unreadable: number, ok: boolean, reason: string}}
 */
export function extractCars(doc, dateStr) {
  const table = doc.getElementById(CAR_GRID.tableId) || doc.querySelector(`table.${CAR_GRID.tableClass}`);
  if (!table) return { cars: [], reservations: [], unreadable: 0, ok: false, reason: '차량 표를 찾지 못했습니다.' };

  const rows = [...table.rows];
  const cars = [];
  const reservations = [];
  let unreadable = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.querySelector('th')) continue;
    if (row.cells.length < 3) continue;          // 상세 행은 셀이 2개다

    const name = clean(row.cells[CAR_GRID.main.name]?.textContent);
    if (!name) continue;

    const status = clean(row.cells[CAR_GRID.main.status]?.textContent).replace(/\s*예약\s*$/, '');
    cars.push({ value: carIdxOf(row) || name, name, label: name, seats: null, status });

    // 바로 뒤 상세 표에 이 차량의 예약들이 들어 있다
    const detail = rows[i + 1]?.querySelector(`table.${CAR_GRID.detailClass}`);
    if (!detail) continue;

    for (const dr of detail.rows) {
      if (dr.querySelector('th')) continue;
      if (dr.cells.length < 2) continue;

      const timeText = clean(dr.cells[CAR_GRID.detail.time]?.textContent);
      if (!timeText) continue;

      const range = parseCarRange(timeText);
      if (!range) { unreadable++; continue; }

      const slice = clipToDate(range, dateStr);
      if (!slice) continue;                       // 다른 날 예약

      const ownerRaw = clean(dr.cells[CAR_GRID.detail.owner]?.textContent);
      const om = ownerRaw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      const purpose = clean(dr.cells[CAR_GRID.detail.purpose]?.textContent).replace(/^ㄴ\s*운행정보\s*:?\s*/, '');

      // 취소 손잡이. 본인 건에만 붙고, 버튼이 상세 행에 있을 수도 본 행에 있을 수도 있어 둘 다 뒤진다.
      // 없으면 null 이고, 그러면 취소 버튼을 막아야 한다 — 짐작으로 지우지 않는다.
      //
      // **실제 화면은 submit 버튼(`…$BTN_DEL`)이다.** 페이지에 죽은 채 남아 있는 fn_del(idx, group)
      // 인자만 찾다가 못 찾아서, 넣은 예약을 취소할 수 없었다(2026-09-30 실제 화면에서 확인).
      const del = rowDeleteSubmit(dr) || rowDeleteSubmit(row) || rowDeleteHandle(dr) || rowDeleteHandle(row);

      reservations.push({
        del,
        room: name,
        name,
        date: dateStr,
        start: slice.start,
        end: slice.end,
        spanStart: range.start,
        spanEnd: range.end,
        title: purpose,
        owner: om ? om[1] : ownerRaw,
        dept: om ? om[2] : '',
        mine: !!del || rowIsMine(dr) || rowIsMine(row),
      });
    }
  }

  if (!cars.length) {
    return { cars, reservations, unreadable, ok: false, reason: '표에서 차량을 하나도 읽지 못했습니다.' };
  }
  if (unreadable > 0) {
    return { cars, reservations, unreadable, ok: false, reason: `${unreadable}건의 예약 시간을 해석하지 못했습니다.` };
  }
  return { cars, reservations, unreadable, ok: true, reason: '' };
}

/* ---------------------------------------------------------------- 조회 */

/** 달력으로 날짜를 옮긴다. 화면에 찍힌 날짜로 성공을 판정한다. */
/** 먹힌 후보를 기억한다. 날짜를 여러 번 옮길 때 빗나간 후보를 매번 다시 던지지 않으려고. */
let dateMoveWinner = null;

async function gotoDate(pageUrl, doc, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const sd = `[[${y},${m},${d}]]`;
  const cands = [
    { argument: `${y}_${m}_${d}`, extra: { [CALENDAR.selectedField]: sd } },
    { argument: `${y}_${m}_${d}`, extra: {} },
    { argument: '', extra: { [CALENDAR.selectedField]: sd } },
  ];
  const order = dateMoveWinner == null
    ? cands.map((_, i) => i)
    : [dateMoveWinner, ...cands.map((_, i) => i).filter((i) => i !== dateMoveWinner)];

  for (const i of order) {
    const c = cands[i];
    try {
      const res = await postback(pageUrl, doc, CALENDAR.id, c.argument, c.extra);
      const next = parseHtml(res.html);
      if (parseCarShownDate(next) === dateStr) {
        dateMoveWinner = i;
        return { doc: next, pageUrl: res.finalUrl };
      }
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/**
 * 하루치 차량 이용 현황.
 * 회의실과 같은 규칙: 확신할 수 없으면 빈 칸으로 칠하지 않는다.
 */
export async function loadCarDay(dateStr, hours = DEFAULT_HOURS) {
  const first = await siteFetch(CAR_LIST_URL);
  let doc = parseHtml(first.html);
  let pageUrl = first.finalUrl;

  let dateTrusted = parseCarShownDate(doc) === dateStr;
  if (!dateTrusted) {
    const moved = await gotoDate(pageUrl, doc, dateStr);
    if (moved) {
      ({ doc, pageUrl } = moved);
      dateTrusted = true;
    }
  }

  const got = extractCars(doc, dateStr);
  let ok = got.ok && dateTrusted;
  let reason = got.reason;
  if (ok === false && !reason && !dateTrusted) reason = `${dateStr} 로 날짜를 옮기지 못했습니다.`;

  const grid = buildGrid(got.cars, got.reservations, hours, { confident: ok });

  return {
    kind: 'car',
    date: dateStr,
    rooms: got.cars,
    roomSource: got.cars.length ? 'table' : 'none',
    reservations: got.reservations,
    reservationsAllRegions: got.reservations,
    region: null,
    regions: [],
    expected: null,
    confident: ok,
    reason,
    grid,
    doc,
    pageUrl,
    via: first.via,
  };
}

/**
 * 여러 날짜의 차량 이용 목록을 훑는다. site.js 의 scanDays 와 같은 방식이다
 * — 한 번 연 화면을 들고 날짜만 옮겨 하루에 요청 한 번으로 끝낸다.
 *
 * 달력에 찍힌 그날 건수와 읽은 건수를 대조한다. 차량 달력의 건수는 **그날에 걸치는**
 * 예약 수라서(2026-09-16: 달력 12건 = 그날 걸친 상세행 12건) 표를 제대로 읽었는지 볼 수 있다.
 *
 * 차량 목록 자체는 날짜가 바뀌어도 같으므로 한 번 읽어 날마다 붙인다. 이게 있어야
 * 캐시만으로 차량 격자를 그릴 수 있다 — 이용 내역만으로는 노는 차를 알 수 없다.
 *
 * @param {string[]} dates 'YYYY-MM-DD' 오름차순
 * @param {(date: string, i: number, n: number) => void} onProgress
 * @param {{onDay?: (day: object) => void}} opts
 *   onDay 는 하루를 읽을 때마다 부른다. 다 기다리지 않고 **읽는 대로** 화면에 쌓으려고.
 * @returns {Promise<Array<{kind:'car', date:string, reservations:Array, rooms:Array, confident:boolean, reason:string}>>}
 */
export async function scanCarDays(dates, onProgress = () => {}, opts = {}) {
  const { onDay = null } = opts;

  const first = await siteFetch(CAR_LIST_URL);
  let doc = parseHtml(first.html);
  let pageUrl = first.finalUrl;

  // 차량 목록은 첫 화면에서 한 번 읽어 둔다. 0건이라 화면을 옮기지 않는 날에도 붙여야 한다.
  let cars = extractCars(doc, parseCarShownDate(doc) || dates[0] || '').cars;

  const out = [];
  const emit = (day) => {
    const full = { rooms: cars, roomSource: cars.length ? 'table' : 'none', ...day };
    out.push(full);
    onDay?.(full);
  };

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    onProgress(date, i + 1, dates.length);

    const counts = parseDayCounts(doc);
    if (counts.get(date) === 0) {
      emit({ kind: 'car', date, reservations: [], confident: true, reason: '' });
      continue;
    }

    if (parseCarShownDate(doc) !== date) {
      const moved = await gotoDate(pageUrl, doc, date);
      if (!moved) {
        emit({ kind: 'car', date, reservations: [], confident: false, reason: '날짜를 옮기지 못했습니다.' });
        continue;
      }
      ({ doc, pageUrl } = moved);
    }

    const got = extractCars(doc, date);
    if (got.cars.length) cars = got.cars;
    const expected = parseDayCounts(doc).get(date);
    let confident = got.ok;
    let reason = got.reason;
    if (confident && expected != null && expected !== got.reservations.length) {
      confident = false;
      reason = `달력은 ${expected}건인데 표에서 ${got.reservations.length}건만 읽었습니다.`;
    }
    emit({ kind: 'car', date, reservations: got.reservations, rooms: got.cars.length ? got.cars : cars, confident, reason });
  }
  return out;
}

export { fmtTime };

/* ---------------------------------------------------------------- 신청 */

/** 신청 폼(팝업) 주소. 목록 행의 예약 버튼이 이 주소를 연다. */
export function carFormUrl(carValue, dateStr) {
  return `${CAR_RESERVE_URL}?CARIDX=${encodeURIComponent(carValue)}&SDATE=${encodeURIComponent(dateStr)}`;
}

/**
 * 차량 신청 폼을 열고 구조를 파악한다. **제출은 하지 않는다.**
 *
 * 이 페이지는 캡처된 적이 없어 필드 이름을 박아둘 수 없다. carform.js 가 문서를 보고
 * 찾아내고, 못 찾으면 ok:false 로 돌려준다 — 부르는 쪽은 그때 제출하지 않는다.
 *
 * @param {string} carValue CARIDX (extractCars 가 준 car.value)
 * @param {string} dateStr 'YYYY-MM-DD'
 */
export async function openCarForm(carValue, dateStr) {
  const url = carFormUrl(carValue, dateStr);
  let res;
  try {
    res = await siteFetch(url);
  } catch (err) {
    return {
      ok: false, reason: `신청 폼을 열지 못했습니다: ${err.message}`,
      fields: {}, missing: [], found: {}, doc: null, pageUrl: url, html: '',
    };
  }

  const doc = parseHtml(res.html);
  const detected = detectCarForm(doc);
  return {
    ok: detected.ok,
    reason: detected.reason,
    fields: detected.fields,
    missing: detected.missing,
    found: detected.found,
    // 신청 폼은 로그인한 사람의 이름·부서·사번을 채워서 내려준다. 조회 화면에는 없는 정보다.
    who: readFormWho(doc, detected),
    doc,
    pageUrl: res.finalUrl,
    html: res.html,
  };
}

/**
 * 차량 이름 대조. 표의 이름은 "아반테CN74 (181허4360)" 처럼 번호판이 붙어 있어
 * 화면이 들고 있는 이름과 글자가 조금 어긋날 수 있다. 정확히 같은 것을 먼저 보고,
 * 없으면 한쪽이 다른 쪽을 품고 있는 경우까지 본다.
 */
export function findCarOverlap(reservations, carName, startMin, endMin) {
  const overlaps = (r) => r.start < endMin && r.end > startMin;
  const exact = reservations.find((r) => r.room === carName && overlaps(r));
  if (exact) return exact;
  const a = clean(carName);
  if (!a) return null;
  return reservations.find((r) => {
    const b = clean(r.room);
    return b && (b.includes(a) || a.includes(b)) && overlaps(r);
  }) || null;
}

/**
 * 신청 후 실제로 잡혔는지 **다시 조회해서** 확인한다. 제출 응답을 믿지 않는다.
 * 차량은 여러 날에 걸치므로 clipToDate 로 그날 구간을 잘라 겹치는지 본다.
 */
async function verifyCarReservation(payload) {
  const startMin = parseTime(payload.start);
  const endMin = parseTime(payload.end);
  const endDate = payload.endDate || payload.date;
  const slice = clipToDate(
    { start: { date: payload.date, minutes: startMin }, end: { date: endDate, minutes: endMin } },
    payload.date,
  );
  if (!slice) return { verified: false, reason: '요청한 날짜가 신청 구간 밖입니다.' };

  try {
    const day = await loadCarDay(payload.date);
    if (!day.confident) {
      return { verified: false, reason: `현황을 다시 읽지 못해 확인할 수 없습니다. (${day.reason})` };
    }
    const hit = findCarOverlap(day.reservations, payload.car, slice.start, slice.end);
    if (!hit) return { verified: false, reason: '다시 조회했지만 그 차량 그 시간에 신청이 보이지 않습니다.' };
    return { verified: true, reason: '', record: hit };
  } catch (err) {
    return { verified: false, reason: `확인 조회 실패: ${err.message}` };
  }
}

/**
 * 차량을 신청한다.
 *
 * 두 가지를 반드시 지킨다.
 *  1) 폼 구조를 이해하지 못하면 **제출하지 않는다.** 무엇을 못 찾았는지 말한다.
 *  2) 제출했으면 **재조회로 확인한 뒤에만** ok:true. 응답 alert 는 근거로 쓰지 않는다.
 *
 * @param {{carValue, car, date, start, end, endDate?, title, place, driver?, passenger?}} payload
 */
export async function reserveCar(payload) {
  const startMin = parseTime(payload.start);
  const endMin = parseTime(payload.end);
  const endDate = payload.endDate || payload.date;

  if (startMin == null || endMin == null) {
    return { ok: false, submitted: false, verified: false, message: '시간 형식을 읽지 못했습니다.' };
  }
  if (endDate < payload.date) {
    return { ok: false, submitted: false, verified: false, message: '종료 날짜가 시작 날짜보다 빠릅니다.' };
  }
  if (endDate === payload.date && endMin <= startMin) {
    return { ok: false, submitted: false, verified: false, message: '시간 범위가 올바르지 않습니다.' };
  }
  // 실제 신청 폼의 fnSaveCheck() 는 **행선지**를 요구한다(사용목적은 요구하지 않는다).
  // 나머지 필수 조건은 폼을 연 뒤 carFormProblems 가 폼의 실제 값까지 보고 판정한다.
  if (!payload.place) {
    return { ok: false, submitted: false, verified: false, message: '행선지는 필수 입력 사항입니다.' };
  }

  const form = await openCarForm(payload.carValue, payload.date);
  if (!form.ok) {
    const what = form.missing && form.missing.length ? form.missing.join('·') : (form.reason || '필요한');
    return {
      ok: false, submitted: false, verified: false,
      missing: form.missing || [],
      message: `신청 폼에서 ${what} 칸을 찾지 못해 제출하지 않았습니다. `
        + '차량 탭 → 설정 및 연결 → 페이지 구조 캡처로 알려주시면 맞추겠습니다.',
    };
  }

  let fields;
  try {
    // 폼이 이미 들고 있는 값(사용자·부서 등)까지 봐야 필수 칸 검사가 정확하다.
    fields = buildCarFields(form, payload, formState(form.doc));
  } catch (err) {
    return { ok: false, submitted: false, verified: false, message: `신청 폼을 채우지 못했습니다: ${err.message}` };
  }

  const beforeHtml = form.doc.documentElement.outerHTML;
  let out;
  try {
    out = await postback(form.pageUrl, form.doc, '', '', fields);
  } catch (err) {
    return {
      ok: false, submitted: false, verified: false,
      message: `제출 실패: ${err.message}`,
      // 사이트가 오류 화면을 돌려줬으면 그것도 넘긴다. 무엇이 어긋났는지는 거기에만 있다.
      responseHtml: err.body || '',
      baselineHtml: beforeHtml, requestFields: fields,
    };
  }

  const alertMsg = readAlert(out.html, beforeHtml);
  const check = await verifyCarReservation(payload);

  if (check.verified) {
    // 신청 폼이 알려준 로그인 사용자. 조회 화면에는 없는 정보라, 내 예약 판정에 쓰라고 같이 올린다.
    return { ok: true, submitted: true, verified: true, message: alertMsg || '', record: check.record, who: form.who };
  }
  return {
    ok: false, submitted: true, verified: false,
    message: alertMsg ? `사이트 응답: "${alertMsg}" — 그런데 ${check.reason}` : check.reason,
    // 왜 안 됐는지 분석하려면 제출 전후가 둘 다 필요하다
    responseHtml: out.html, baselineHtml: beforeHtml, requestFields: fields,
  };
}

/* ---------------------------------------------------------------- 취소 */

/**
 * 목록 문서에서 진짜 삭제 포스트백 대상을 찾는다.
 *
 * fn_del 은 'RG_MAIN$ctl00$ctl04$BTN_DEL' 을 하드코딩하고 있지만 ctl04 는 화면마다 다를 수 있고,
 * 2026-09-16 fixture 에는 삭제 버튼을 가진 행이 하나도 없어 마크업을 대조하지 못했다.
 * 그래서 문서에서 먼저 찾아보고, 없을 때만 하드코딩 값을 쓴다.
 */
export function findCarDeleteTarget(doc) {
  if (!doc || !doc.querySelectorAll) return null;
  for (const el of doc.querySelectorAll('[name]')) {
    const name = el.getAttribute('name') || '';
    if (/BTN_?DEL/i.test(name)) return name;
  }
  const html = doc.documentElement ? doc.documentElement.outerHTML : '';
  const m = html.match(/__doPostBack\s*\(\s*['"]([^'"]*BTN_?DEL[^'"]*)['"]/i);
  return m ? m[1] : null;
}

/**
 * 차량 예약을 취소한다. **사이트의 '취소' 버튼을 그대로 누른 것과 같은 요청**을 보낸다.
 *
 * 그 버튼은 그 예약의 행 안에 있는 submit 이라(`RG_MAIN$…$BTN_DEL`) 이름만 얹으면 되고,
 * 어느 건을 지우는지 헷갈릴 수 없다. 페이지에 죽은 채 남아 있는 `fn_del(idx, group)` 쪽 길도
 * 남겨 두었지만(숨은 칸 + __EVENTTARGET), 실제 화면이 쓰는 것은 앞쪽이다.
 *
 * 응답을 믿지 않고 다시 조회해서 **정말 사라졌는지** 확인한 뒤에만 ok:true.
 * 같이 신청된 건까지 지우는 옵션(HF_DEL_YN='Y')은 쓰지 않는다 — 고른 한 건만 지운다.
 *
 * @param {object} record extractCars 가 준 예약 한 건
 * @param {object} day loadCarDay 결과 ({doc, pageUrl, date})
 */
export async function cancelCarReservation(record, day) {
  const handle = record && record.del;
  if (!handle || (!handle.submit && !handle.idx)) {
    return { ok: false, submitted: false, message: '이 예약의 삭제 정보를 찾지 못했습니다. 사이트에서 지워주세요.' };
  }
  if (!day || !day.doc || !day.pageUrl) {
    return { ok: false, submitted: false, message: '살아 있는 화면이 없어 취소할 수 없습니다. 다시 조회한 뒤 눌러주세요.' };
  }

  // 길이 둘이다.
  //  1) 그 건의 행에 붙은 '취소' submit 버튼 — 실제 화면이 쓰는 길. 이름만 얹으면 되고,
  //     버튼이 그 건 안에 있으니 **엉뚱한 건을 지울 수 없다.**
  //  2) fn_del(idx, group) 을 쓰는 화면 — 숨은 칸에 번호를 넣고 __EVENTTARGET 으로 누른다.
  let target = '';
  let fields;
  if (handle.submit) {
    fields = { [handle.submit]: handle.value || '취소' };
  } else {
    target = findCarDeleteTarget(day.doc) || CAR_DELETE.eventTarget;
    fields = {
      [CAR_DELETE.flag]: 'N',                     // 'Y' 는 같이 신청된 건까지 지운다 — 쓰지 않는다
      [CAR_DELETE.idx]: handle.idx,
      [CAR_DELETE.groupIdx]: handle.group == null ? '0' : handle.group,
    };
  }

  const beforeHtml = day.doc.documentElement.outerHTML;
  let out;
  try {
    out = await postback(day.pageUrl, day.doc, target, '', fields);
  } catch (err) {
    return {
      ok: false, submitted: false, message: `취소 요청 실패: ${err.message}`,
      baselineHtml: beforeHtml, requestFields: fields,
    };
  }

  const alertMsg = readAlert(out.html, beforeHtml);
  const diag = { responseHtml: out.html, baselineHtml: beforeHtml, requestFields: fields };

  try {
    const fresh = await loadCarDay(record.date || day.date);
    if (!fresh.confident) {
      return {
        ok: false, submitted: true, verified: false,
        message: `현황을 다시 읽지 못해 취소를 확인할 수 없습니다. (${fresh.reason})`,
        ...diag,
      };
    }
    const still = findCarOverlap(fresh.reservations, record.name || record.room, record.start, record.end);
    if (still) {
      return {
        ok: false, submitted: true, verified: false,
        message: alertMsg
          ? `사이트 응답: "${alertMsg}" — 그런데 신청이 그대로 남아 있습니다.`
          : '다시 조회했더니 신청이 그대로 남아 있습니다.',
        ...diag,
      };
    }
    return { ok: true, submitted: true, verified: true, message: alertMsg || '' };
  } catch (err) {
    return { ok: false, submitted: true, verified: false, message: `취소 확인 조회 실패: ${err.message}`, ...diag };
  }
}
