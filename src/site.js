import { LIST_URL, DEFAULT_HOURS, FORM, CALENDAR, MINUTE_STEP, DELETE } from './config.js';
import { siteFetch } from './net.js';
import { parseHtml, postback } from './aspnet.js';
import {
  extractSchedule, parseRooms, parseRegions, parseSelectedRegion,
  parseShownDate, parseDayCounts, buildGrid, fmtTime, parseTime, findOverlap,
  parseFormDate, telerikDateFields,
} from './parse.js';
import { sortRooms } from './roomorder.js';

/* ---------------------------------------------------------------- 이동 */

/**
 * 월 달력(Telerik RadCalendar)으로 날짜를 옮긴다.
 * 포스트백 인자 형식이 Telerik 내부 규칙이라 후보를 차례로 시도하고,
 * **화면에 찍힌 날짜(LB_DATE)가 요청한 날짜와 같은지로 성공을 판정한다.**
 * 추측이 맞았는지 매번 확인하므로, 실패하면 실패했다고 말할 수 있다.
 */
/**
 * 어떤 후보가 먹혔는지 기억한다. 날짜를 여러 번 옮길 때(내 예약 훑기) 매번
 * 빗나간 후보부터 다시 던지면 하루당 요청이 몇 배로 늘어난다. 형식은 세션 중에 바뀌지 않는다.
 */
let dateMoveWinner = null;

async function gotoDate(pageUrl, doc, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const sd = `[[${y},${m},${d}]]`;

  const candidates = [
    { argument: `${y}_${m}_${d}`, extra: { [CALENDAR.selectedField]: sd } },
    { argument: `${y}_${m}_${d}`, extra: {} },
    { argument: '', extra: { [CALENDAR.selectedField]: sd } },
    { argument: `${y}-${m}-${d}`, extra: { [CALENDAR.selectedField]: sd } },
  ];

  const order = dateMoveWinner == null
    ? candidates.map((_, i) => i)
    : [dateMoveWinner, ...candidates.map((_, i) => i).filter((i) => i !== dateMoveWinner)];

  for (const i of order) {
    const c = candidates[i];
    try {
      const res = await postback(pageUrl, doc, CALENDAR.id, c.argument, c.extra);
      const next = parseHtml(res.html);
      if (parseShownDate(next) === dateStr) {
        dateMoveWinner = i;
        return { doc: next, pageUrl: res.finalUrl };
      }
    } catch {
      // 다음 후보로 넘어간다
    }
  }
  return null;
}

/** 지역을 바꾼다. 회의실 드롭다운이 그 지역 것으로 다시 채워진다. */
async function setRegion(pageUrl, doc, region) {
  const res = await postback(pageUrl, doc, FORM.region, '', { [FORM.region]: region });
  const next = parseHtml(res.html);
  if (parseSelectedRegion(next) !== region) return null;
  return { doc: next, pageUrl: res.finalUrl };
}

/* ---------------------------------------------------------------- 조회 */

/**
 * 지정한 날짜·지역의 예약 현황을 가져온다.
 *
 * 반환값의 confident 가 false 면 화면을 "예약 가능"으로 칠하면 안 된다.
 * 표를 못 읽은 것과 예약이 없는 것은 전혀 다르다.
 */
export async function loadDay(dateStr, hours = DEFAULT_HOURS, wantRegion = null) {
  const first = await siteFetch(LIST_URL);
  let doc = parseHtml(first.html);
  let pageUrl = first.finalUrl;

  // 1) 지역 — 회의실 목록이 지역별로 따로 내려온다
  let regionOk = true;
  const regions = parseRegions(doc);
  if (wantRegion && parseSelectedRegion(doc) !== wantRegion) {
    const moved = await setRegion(pageUrl, doc, wantRegion);
    if (moved) ({ doc, pageUrl } = moved);
    else regionOk = false;
  }
  const region = parseSelectedRegion(doc);

  // 2) 날짜
  let dateTrusted = parseShownDate(doc) === dateStr;
  if (!dateTrusted) {
    const moved = await gotoDate(pageUrl, doc, dateStr);
    if (moved) {
      ({ doc, pageUrl } = moved);
      dateTrusted = true;
    }
  }

  // 3) 현황 — 달력 건수와 대조해 스스로 검증한다
  const schedule = extractSchedule(doc, dateStr);
  // 방 목록은 읽자마자 화면 차례로 세운다. 격자·캐시가 모두 이걸 그대로 쓰므로
  // 여기서 한 번 세워야 줄 번호(선택의 열쇠)가 어디서 그려도 같다.
  const { rooms: rawRooms, source: roomSource } = parseRooms(doc);
  const rooms = sortRooms(rawRooms);

  // 표에는 전 지역 예약이 다 들어 있으므로 현재 지역만 남긴다
  const all = schedule.reservations;
  const reservations = region ? all.filter((r) => !r.region || r.region === region) : all;

  const confident = schedule.confident && dateTrusted && roomSource !== 'none' && regionOk;

  let reason = schedule.reason;
  if (!reason && !dateTrusted) reason = `${dateStr} 로 날짜를 옮기지 못했습니다.`;
  if (!reason && roomSource === 'none') reason = '회의실 목록을 찾지 못했습니다.';
  if (!reason && !regionOk) reason = `지역을 ${wantRegion} 으로 바꾸지 못했습니다.`;

  const grid = buildGrid(rooms, reservations, hours, { confident });

  return {
    date: dateStr,
    region,
    regions,
    rooms,
    roomSource,
    reservations,
    reservationsAllRegions: all,
    expected: schedule.expected,
    confident,
    reason,
    grid,
    doc,
    pageUrl,
    via: first.via,
    hadDateInput: dateTrusted,
  };
}

/**
 * 여러 날짜의 예약 목록을 훑는다. "내 예약"과 **한 달 미리 훑기**가 이걸 쓴다.
 *
 * loadDay 를 날짜마다 부르면 하루에 페이지를 새로 받고 날짜 포스트백까지 해서 2~5번 요청한다.
 * 여기서는 **한 번 연 화면을 그대로 들고 날짜만 옮긴다** — 하루에 요청 한 번이다.
 *
 * 예약은 전 지역 것을 그대로 돌려준다(내 예약은 지역을 가리지 않는다). 다만 **회의실 목록은
 * 지역마다 달라서** 훑기 시작할 때 한 번 읽어 날마다 붙인다. 이게 있어야 캐시만으로
 * 격자를 그릴 수 있다 — 예약 목록만으로는 빈 회의실이 몇 곳인지 알 수 없다.
 *
 * 하루라도 못 읽으면 그 날만 confident:false 로 남기고 계속 간다.
 * 부르는 쪽이 "N일은 확인 불가"라고 말할 수 있어야 하기 때문이다.
 *
 * @param {string[]} dates 'YYYY-MM-DD' 오름차순
 * @param {(date: string, i: number, n: number) => void} onProgress
 * @param {{region?: string|null, onDay?: (day: object) => void}} opts
 *   onDay 는 하루를 읽을 때마다 부른다. 30일을 다 기다리지 않고 **읽는 대로** 화면에 쌓으려고.
 * @returns {Promise<Array<{kind:'room', date:string, reservations:Array, rooms:Array, region:string, confident:boolean, reason:string}>>}
 */
export async function scanDays(dates, onProgress = () => {}, opts = {}) {
  const { region: wantRegion = null, onDay = null } = opts;

  const first = await siteFetch(LIST_URL);
  let doc = parseHtml(first.html);
  let pageUrl = first.finalUrl;

  // 지역을 먼저 맞춘다. 회의실 목록이 지역별로 따로 내려오기 때문이다.
  let regionOk = true;
  if (wantRegion && parseSelectedRegion(doc) !== wantRegion) {
    const moved = await setRegion(pageUrl, doc, wantRegion);
    if (moved) ({ doc, pageUrl } = moved);
    else regionOk = false;
  }

  // 회의실 목록은 날짜를 옮겨도 그대로다. 한 번만 읽어 날마다 같이 붙인다.
  const region = parseSelectedRegion(doc);
  const regions = parseRegions(doc);
  const { rooms: rawRooms, source: roomSource } = parseRooms(doc);
  const rooms = sortRooms(rawRooms);
  const shared = { rooms, roomSource, region, regions, regionOk };

  const out = [];
  const emit = (day) => {
    const full = { ...shared, ...day };
    out.push(full);
    onDay?.(full);
  };

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    onProgress(date, i + 1, dates.length);

    // 달력이 그날 0건이라고 하면 화면을 옮길 것도 없다. 사이트가 스스로 센 숫자다.
    if (parseDayCounts(doc).get(date) === 0) {
      emit({ kind: 'room', date, reservations: [], confident: true, reason: '' });
      continue;
    }

    if (parseShownDate(doc) !== date) {
      const moved = await gotoDate(pageUrl, doc, date);
      if (!moved) {
        emit({ kind: 'room', date, reservations: [], confident: false, reason: '날짜를 옮기지 못했습니다.' });
        continue;
      }
      ({ doc, pageUrl } = moved);
    }

    const sch = extractSchedule(doc, date);
    emit({ kind: 'room', date, reservations: sch.reservations, confident: sch.confident, reason: sch.reason });
  }
  return out;
}

/** 진단용: 로그인된 상태의 원본 HTML 을 그대로 돌려준다. */
export async function captureRaw(url = LIST_URL) {
  return siteFetch(url);
}

/* ---------------------------------------------------------------- 예약 */

/**
 * 응답에 새로 말한 alert 문구만 골라낸다.
 *
 * 이 페이지는 fnCheck() 같은 검증 함수 안에 alert("회의장을 선택해 주세요.") 를
 * 항상 담고 있다. 그냥 긁어오면 성공해도 오류 문구가 나온다.
 * 제출 전 HTML 에도 있는 문구는 정적이므로 무시한다.
 */
function readAlert(html, baselineHtml = '') {
  const found = [...html.matchAll(/alert\s*\(\s*["']([^"']{1,200})["']/g)].map((m) => m[1]);
  const before = new Set(
    [...baselineHtml.matchAll(/alert\s*\(\s*["']([^"']{1,200})["']/g)].map((m) => m[1]),
  );
  return found.find((t) => !before.has(t)) || '';
}

/** 예약 후 실제로 잡혔는지 다시 조회해서 확인한다. 제출 응답을 믿지 않는다. */
async function verifyReservation(payload) {
  const startMin = parseTime(payload.start);
  const endMin = parseTime(payload.end);

  try {
    const day = await loadDay(payload.date, DEFAULT_HOURS, payload.region);
    if (!day.confident) {
      return { verified: false, reason: `현황을 다시 읽지 못해 확인할 수 없습니다. (${day.reason})` };
    }
    const hit = findOverlap(day.reservations, payload.room, startMin, endMin);
    if (!hit) return { verified: false, reason: '다시 조회했지만 해당 시간에 예약이 보이지 않습니다.' };
    return { verified: true, reason: '', record: hit };
  } catch (err) {
    return { verified: false, reason: `확인 조회 실패: ${err.message}` };
  }
}

/** 사이트 드롭다운이 받아주는 시/분인지 본다. */
function splitTime(mins) {
  return { hour: Math.floor(mins / 60), minute: mins % 60 };
}

/**
 * 예약 폼의 날짜를 목표 날짜로 옮긴다.
 *
 * 목록 날짜(LB_DATE)를 옮겨도 폼 날짜는 따라오지 않고, 글자 칸만 채워 보내면 서버가 무시한다.
 * 그래서 사람이 하는 방법을 순서대로 흉내 내고, **매번 폼 날짜를 다시 읽어 성공을 판정한다.**
 * gotoDate 와 같은 방식이다 — 맞았는지 확인하니 실패하면 실패했다고 말할 수 있다.
 */
async function setFormDate(pageUrl, doc, payload) {
  const [y, m, d] = payload.date.split('-').map(Number);
  const dateFields = telerikDateFields(payload.date);
  const keep = { [FORM.region]: payload.region, [FORM.room]: payload.roomValue };

  const candidates = [
    // 날짜 칸에 직접 입력한 것처럼(RadDateInput 은 AutoPostBack 이다)
    { target: FORM.date, argument: '' },
    // 팝업 달력에서 날짜를 고른 것처럼
    { target: FORM.dateCalendar, argument: `${y}_${m}_${d}` },
  ];

  for (const c of candidates) {
    try {
      const res = await postback(pageUrl, doc, c.target, c.argument, { ...keep, ...dateFields });
      const next = parseHtml(res.html);
      if (parseFormDate(next) === payload.date) return { doc: next, pageUrl: res.finalUrl };
    } catch {
      // 다음 후보로 넘어간다
    }
  }
  return null;
}

/**
 * 예약을 제출한다.
 * 사용자가 하는 순서를 그대로 따른다: 회의실 선택 포스트백 → 저장.
 * 제출 후에는 반드시 재조회로 확인한다.
 */
export async function reserve(payload, day) {
  const startMin = parseTime(payload.start);
  const endMin = parseTime(payload.end);
  if (startMin == null || endMin == null || endMin <= startMin) {
    return { ok: false, submitted: false, message: '시간 범위가 올바르지 않습니다.' };
  }

  const s = splitTime(startMin);
  const e = splitTime(endMin);
  if (e.hour > 23) {
    return {
      ok: false,
      submitted: false,
      message: '사이트는 23:50 까지만 예약할 수 있습니다. 종료 시각을 23시 이하로 맞춰주세요.',
    };
  }
  if (s.minute % MINUTE_STEP || e.minute % MINUTE_STEP) {
    return { ok: false, submitted: false, message: `분은 ${MINUTE_STEP}분 단위만 됩니다.` };
  }

  // 날짜는 글자 칸만 채우면 서버가 무시한다. ClientState 까지 같이 보낸다.
  const dateFields = telerikDateFields(payload.date);

  // 1) 회의실 선택 — 사이트가 onchange 포스트백으로 방 정보를 다시 그린다
  let doc = day.doc;
  let pageUrl = day.pageUrl;
  try {
    const picked = await postback(pageUrl, doc, FORM.room, '', {
      [FORM.region]: payload.region,
      [FORM.room]: payload.roomValue,
      ...dateFields,
    });
    doc = parseHtml(picked.html);
    pageUrl = picked.finalUrl;
  } catch (err) {
    return { ok: false, submitted: false, message: `회의실 선택 실패: ${err.message}` };
  }

  // 선택이 반영됐는지 확인하고서 저장한다
  const roomSel = doc.getElementsByName(FORM.room)[0];
  const chosen = roomSel?.querySelector('option[selected]')?.getAttribute('value');
  if (chosen && chosen !== payload.roomValue) {
    return { ok: false, submitted: false, message: `회의실이 "${chosen}" 으로 잡혀 제출을 중단했습니다.` };
  }

  // 2) 폼 날짜가 정말 옮겨졌는지 본다.
  //    여기서 확인하지 않으면 **오늘 날짜로 조용히 예약된다** — 회의실 확인과 같은 이유로 막는다.
  if (parseFormDate(doc) !== payload.date) {
    const moved = await setFormDate(pageUrl, doc, payload);
    if (moved) ({ doc, pageUrl } = moved);
  }
  const formDate = parseFormDate(doc);
  if (formDate !== payload.date) {
    return {
      ok: false,
      submitted: false,
      message: `예약 폼 날짜가 ${formDate || '알 수 없음'} 으로 남아 있어(요청: ${payload.date}) ` +
        '제출을 중단했습니다. 엉뚱한 날짜로 예약되는 것을 막기 위해서입니다.',
    };
  }

  // 3) 저장
  const fields = {
    [FORM.region]: payload.region,
    [FORM.room]: payload.roomValue,
    ...dateFields,
    [FORM.startHour]: String(s.hour),
    [FORM.startMinute]: String(s.minute),
    [FORM.endHour]: String(e.hour),
    [FORM.endMinute]: String(e.minute),
    [FORM.repeat]: 'N',
    [FORM.title]: payload.title,
    // 이미지 버튼은 좌표로 눌린 것을 알린다
    [`${FORM.save}.x`]: '10',
    [`${FORM.save}.y`]: '10',
  };

  const beforeHtml = doc.documentElement.outerHTML;
  let out;
  try {
    out = await postback(pageUrl, doc, '', '', fields);
  } catch (err) {
    // 사이트가 오류 화면을 돌려줬으면 같이 넘긴다 — 진단이 쓸 수 있는 유일한 근거다.
    return {
      ok: false, submitted: false, message: `제출 실패: ${err.message}`,
      responseHtml: err.body || '', baselineHtml: beforeHtml, requestFields: fields,
    };
  }

  const alertMsg = readAlert(out.html, beforeHtml);
  const check = await verifyReservation(payload);

  if (check.verified) {
    // 확인된 예약 행에는 **예약자 이름**이 적혀 있다. 사이트 어디에도 로그인한 사람의 이름이
    // 없어서, 내가 넣은 예약이 곧 내 이름을 알 수 있는 유일한 자리다(내 예약 판정에 쓴다).
    return { ok: true, submitted: true, verified: true, message: alertMsg || '', record: check.record };
  }
  return {
    ok: false,
    submitted: true,
    verified: false,
    message: alertMsg ? `사이트 응답: "${alertMsg}" — 그런데 ${check.reason}` : check.reason,
    // 왜 안 됐는지 분석하려면 제출 전후 응답이 둘 다 필요하다
    responseHtml: out.html,
    baselineHtml: beforeHtml,
    requestFields: fields,
  };
}

export { fmtTime };

/* ---------------------------------------------------------------- 취소 */

/**
 * 예약을 취소한다. 사이트의 fn_del 이 하는 일을 그대로 보낸다.
 *
 * 삭제도 응답을 믿지 않는다. 다시 조회해서 **정말 사라졌는지** 확인한 뒤에만 성공이라고 한다.
 * 같이 신청된 건까지 지우는 옵션(HF_DEL_YN='Y')은 쓰지 않는다 — 고른 한 건만 지운다.
 */
export async function cancelReservation(record, day) {
  if (!record?.del?.idx) {
    return { ok: false, submitted: false, message: '이 예약의 삭제 정보를 찾지 못했습니다. 사이트에서 지워주세요.' };
  }

  // 화면의 DelCheck 는 hdn_pIDX / hdn_GROUP_pIDX 만 채우고 lbDelete 를 누른다.
  // HF_* 는 fn_del 경로용이라 함께 보내도 해가 없다.
  const fields = {
    [DELETE.flag]: 'N',
    [DELETE.idx]: record.del.idx,
    [DELETE.groupIdx]: record.del.group,
    [DELETE.pIdx]: record.del.idx,
    [DELETE.pGroupIdx]: record.del.group,
    [DELETE.submit]: '',
  };

  const beforeHtml = day.doc.documentElement.outerHTML;
  let out;
  try {
    out = await postback(day.pageUrl, day.doc, '', '', fields);
  } catch (err) {
    return { ok: false, submitted: false, message: `취소 요청 실패: ${err.message}` };
  }

  const alertMsg = readAlert(out.html, beforeHtml);

  // 정말 사라졌는지 다시 조회해서 본다
  try {
    const fresh = await loadDay(record.date || day.date, DEFAULT_HOURS, day.region);
    if (!fresh.confident) {
      return {
        ok: false, submitted: true,
        message: `현황을 다시 읽지 못해 취소를 확인할 수 없습니다. (${fresh.reason})`,
        responseHtml: out.html, baselineHtml: beforeHtml, requestFields: fields,
      };
    }
    const still = findOverlap(fresh.reservations, record.room, record.start, record.end);
    if (still) {
      return {
        ok: false, submitted: true,
        message: alertMsg ? `사이트 응답: "${alertMsg}" — 그런데 예약이 그대로 남아 있습니다.` : '다시 조회했더니 예약이 그대로 남아 있습니다.',
        responseHtml: out.html, baselineHtml: beforeHtml, requestFields: fields,
      };
    }
    return { ok: true, submitted: true, verified: true, message: alertMsg || '' };
  } catch (err) {
    return { ok: false, submitted: true, message: `취소 확인 조회 실패: ${err.message}` };
  }
}
