import { GRID, DATE_LABEL_ID, CALENDAR, FORM, ROOM_PLACEHOLDER_VALUES, SLOT_MINUTES } from './config.js';

const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/* ---------------------------------------------------------------- 시간 */

/** "09:00", "9시", "0900", "9" → 분 단위 정수. 실패하면 null. */
export function parseTime(text) {
  const t = clean(text);
  if (!t) return null;

  let m = t.match(/(\d{1,2})\s*[:시]\s*(\d{1,2})?/);
  if (m) {
    const h = +m[1];
    const min = m[2] ? +m[2] : 0;
    if (h <= 24 && min < 60) return h * 60 + min;
  }
  m = t.match(/^(\d{3,4})$/);
  if (m) {
    const v = m[1].padStart(4, '0');
    const h = +v.slice(0, 2);
    const min = +v.slice(2);
    if (h <= 24 && min < 60) return h * 60 + min;
  }
  m = t.match(/^(\d{1,2})$/);
  if (m && +m[1] <= 24) return +m[1] * 60;
  return null;
}

export const fmtTime = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** "09:00~ 18:00" 같은 한 칸짜리 범위를 분해한다(줄바꿈이 섞여 있어도 된다). */
export function parseTimeRange(text) {
  const t = clean(text);
  const m = t.match(/(\d{1,2}\s*[:시]?\s*\d{0,2})\s*[~\-–—]\s*(\d{1,2}\s*[:시]?\s*\d{0,2})/);
  if (!m) return null;
  const start = parseTime(m[1]);
  const end = parseTime(m[2]);
  if (start == null || end == null) return null;
  return { start, end };
}

/** "2026-09-16", "2026.09.16", "20260916" → "YYYY-MM-DD" */
export function parseDate(text) {
  const t = clean(text);
  let m = t.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
  m = t.match(/\b(\d{8})\b/);
  if (m) return `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}`;
  return null;
}

export const ymd = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export const todayStr = () => {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

/* ------------------------------------------------------- 페이지에서 읽기 */

/** 화면이 현재 보여주고 있는 날짜. "2026-09-16 Wednesday" → "2026-09-16" */
export function parseShownDate(doc) {
  const el = doc.getElementById(DATE_LABEL_ID);
  return el ? parseDate(el.textContent) : null;
}

/**
 * 월 달력에 찍힌 날짜별 예약 건수.
 * 셀 모양: <td title="수요일, 9월 02, 2026">2<br><font>17건</font></td>
 * 표를 제대로 읽었는지 대조하는 독립적인 근거로 쓴다.
 * @returns {Map<string, number>}
 */
export function parseDayCounts(doc) {
  const counts = new Map();
  const cal = doc.getElementById(CALENDAR.id);
  if (!cal) return counts;

  for (const td of cal.querySelectorAll('td[title]')) {
    const title = td.getAttribute('title') || '';
    const md = title.match(/(\d{1,2})월\s*(\d{1,2}),\s*(\d{4})/);
    if (!md) continue;
    const key = ymd(+md[3], +md[1], +md[2]);

    // 셀 텍스트는 날짜와 건수가 붙어 있다("16" + "10건" → "1610건").
    // 건수는 별도 자식 요소에만 들어 있으므로 거기서 읽는다.
    const tag = [...td.querySelectorAll('*')].find((n) => /^\s*\d+\s*건\s*$/.test(n.textContent));
    counts.set(key, tag ? +tag.textContent.match(/(\d+)/)[1] : 0);
  }
  return counts;
}

/** 예약 폼(숨은 div_write)이 현재 들고 있는 날짜. 저장 전에 이게 맞는지 봐야 한다. */
export function parseFormDate(doc) {
  const el = doc.getElementsByName(FORM.date)[0];
  return el ? parseDate(el.getAttribute('value') || '') : null;
}

/**
 * 예약 폼의 날짜를 바꾸는 데 필요한 필드 묶음.
 *
 * 글자 칸(DP_ROOMDATE, DP_ROOMDATE$dateInput)만 채워 보내면 **서버가 무시한다.**
 * Telerik RadDateInput 은 값을 ClientState JSON 에서 읽고, 그게 비어 있으면
 * ViewState 에 있던 날짜(보통 오늘)를 그대로 쓴다. 그래서 다른 날짜로 예약하면
 * 조용히 오늘 날짜로 제출돼 버린다. ClientState 까지 같이 채운다.
 *
 * ClientState 안의 날짜 표기는 Telerik 내부 표기인 "yyyy-MM-dd-HH-mm-ss" 다.
 *
 * **글자 칸의 표기는 피커마다 다르다.** 회의실 예약 폼의 `$dateInput` 은 "2026-09-16" 인데
 * 차량 신청 폼의 `txtSdate$dateInput` 은 "2026-09-16-00-00-00" 이다. 한쪽 표기를 박아 두고
 * 다른 폼에 밀어 넣으면 서버가 그 칸을 날짜로 읽지 못해 **저장에서 터진다(HTTP 500).**
 * 그래서 current 를 받으면 **그 칸이 지금 들고 있는 생김새를 지키고 날짜만 바꾼다.**
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {{date:string, dateInput:string, dateInputClientState:string, dateCalendarSelected:string,
 *          dateInputText?:string}} [names]
 *   다른 날짜 피커에도 쓰려고 칸 이름을 받는다. 없으면 회의실 예약 폼(FORM) 이름을 쓴다
 *   — 기존 호출부는 telerikDateFields(date) 그대로 동작한다.
 * @param {object} [current] 폼이 지금 들고 있는 값(name → value). formState(doc) 결과를 넘기면 된다.
 */
export function telerikDateFields(dateStr, names, current = null) {
  const n = names || {
    date: FORM.date,
    dateInput: FORM.dateInput,
    dateInputClientState: FORM.dateInputClientState,
    dateCalendarSelected: FORM.dateCalendarSelected,
  };
  const [y, m, d] = dateStr.split('-').map(Number);
  const stamp = `${dateStr}-00-00-00`;

  // 지금 값이 "YYYY-MM-DD" 로 시작하면 뒤에 붙은 시각 표기를 그대로 남긴다.
  const reshape = (name) => {
    const cur = current && name ? String(current[name] ?? '') : '';
    const m2 = cur.match(/^\d{4}-\d{2}-\d{2}(.*)$/);
    return m2 ? dateStr + m2[1] : dateStr;
  };

  const out = {
    [n.date]: reshape(n.date),
    [n.dateInput]: reshape(n.dateInput),
    [n.dateInputClientState]: JSON.stringify({
      enabled: true,
      emptyMessage: '',
      validationText: stamp,
      valueAsString: stamp,
      lastSetTextBoxValue: dateStr,
    }),
    [n.dateCalendarSelected]: JSON.stringify([[y, m, d]]),
  };

  // 보이는 글자 칸이 따로 있는 스킨(차량 신청 폼)이면 그것도 맞춘다.
  // 있는 폼에만 넣는다 — 없는 칸을 만들어 보내면 그게 또 다른 어긋남이 된다.
  if (n.dateInputText && current && n.dateInputText in current) {
    out[n.dateInputText] = reshape(n.dateInputText);
  }
  return out;
}

/** 두 날짜 글자가 같은 날을 가리키는지. 표기가 달라도("2026-09-16-00-00-00") 앞 열 글자로 본다. */
export function sameDateText(a, b) {
  const day = (v) => (String(v ?? '').match(/^\d{4}-\d{2}-\d{2}/) || [''])[0];
  const x = day(a);
  return !!x && x === day(b);
}

/** 지역 드롭다운에서 현재 선택된 지역. */
export function parseSelectedRegion(doc) {
  const sel = doc.getElementsByName(FORM.region)[0];
  if (!sel) return null;
  const opt = sel.querySelector('option[selected]') || sel.querySelector('option');
  return opt ? clean(opt.getAttribute('value') ?? opt.textContent) : null;
}

/** 지역 목록. */
export function parseRegions(doc) {
  const sel = doc.getElementsByName(FORM.region)[0];
  if (!sel) return [];
  return [...sel.querySelectorAll('option')]
    .map((o) => clean(o.getAttribute('value') ?? o.textContent))
    .filter(Boolean);
}

/**
 * 회의실 이름에 좌석 수와 층이 박혀 있다.
 *   "미팅룸1(1층)-8석"  → { label: "미팅룸1(1층)", floor: 1, seats: 8 }
 *   "스마트홀(18층)"     → { label: "스마트홀(18층)", floor: 18, seats: null }
 */
export function parseRoomName(name) {
  const seatMatch = name.match(/-\s*(\d+)\s*석\s*$/);
  const floorMatch = name.match(/\(\s*(\d+)\s*층\s*\)/);
  return {
    label: seatMatch ? name.slice(0, seatMatch.index).trim() : name,
    seats: seatMatch ? +seatMatch[1] : null,
    floor: floorMatch ? +floorMatch[1] : null,
  };
}

/**
 * 회의실 목록. 예약 폼의 드롭다운이 출처이므로 **예약이 없는 방도 포함**된다.
 * 목록은 현재 선택된 지역 기준이라, 지역을 바꾸려면 포스트백이 필요하다.
 */
export function parseRooms(doc) {
  const sel = doc.getElementsByName(FORM.room)[0];
  if (!sel) return { rooms: [], source: 'none' };

  const rooms = [...sel.querySelectorAll('option')]
    .map((o) => {
      const name = clean(o.textContent);
      return {
        value: o.getAttribute('value') ?? name,
        name,
        ...parseRoomName(name),
      };
    })
    .filter((o) => o.name && !ROOM_PLACEHOLDER_VALUES.includes(o.value) && !/^=+.*=+$/.test(o.name));

  return { rooms, source: rooms.length ? 'select' : 'none' };
}

/* ---------------------------------------------------------------- 예약표 */

function findGridTable(doc) {
  return doc.getElementById(GRID.tableId) || doc.querySelector(`table.${GRID.tableClass}`);
}

/**
 * 내 예약인지 판단한다.
 * 사이트는 본인 예약에만 수정/삭제 버튼(fn_update / fn_del)을 붙인다.
 * 로그인한 사람의 이름을 따로 알아낼 방법이 없어 이 버튼을 신호로 쓴다.
 */
function rowIsMine(row) {
  return !!rowDeleteHandle(row) || !!rowDeleteSubmit(row) || [...row.querySelectorAll('a, input, img, span')].some((n) => {
    const hint = `${n.getAttribute('href') || ''} ${n.getAttribute('onclick') || ''}`;
    return /fn_del\s*\(|fn_update\s*\(/.test(hint);
  });
}

/**
 * 삭제 버튼에서 fn_del(idx, group_idx) 의 인자를 꺼낸다.
 * 이 버튼은 본인 예약에만 붙으므로, 있으면 내 예약이라는 뜻이기도 하다.
 */
export function rowDeleteHandle(row) {
  if (!row) return null;
  for (const n of row.querySelectorAll('a, input, img, span')) {
    const hint = `${n.getAttribute('href') || ''} ${n.getAttribute('onclick') || ''}`;
    // 실제 화면은 DelCheck('69497','69497') 를 쓴다. fn_del/fn_update 도 같은 모양이라 함께 받는다.
    const m = hint.match(/(?:DelCheck|fn_del|fn_update)\s*\(\s*['"]?([^,'")]+)['"]?\s*,\s*['"]?([^)'"]*)['"]?\s*\)/);
    if (m) return { idx: m[1].trim(), group: (m[2] || '0').trim() || '0' };
  }
  return null;
}


/**
 * 행에 붙은 **취소 submit 버튼**. 이름 그대로 포스트백하면 사이트의 취소 버튼을 누른 것과 같다.
 *
 * 차량 현황이 이 방식이다. 2026-09-30 실제 화면에서 확인했다:
 *   <input type="submit" name="RG_MAIN$ctl00$ctl06$Detail10$ctl04$BTN_DEL"
 *          value="취소" onclick="return fnDelete();">
 * 그리고 `fnDelete()` 는 확인창일 뿐이라 평범한 submit 으로 끝난다. 페이지에 죽은 채 남아 있는
 * `fn_del(idx, group)` 과는 다른 길이다 — 그쪽 인자를 찾다 못 찾아서 취소가 되지 않았다.
 *
 * 이 버튼은 **본인 건에만** 붙는다. 그래서 있으면 내 예약이라는 뜻이기도 하고,
 * 버튼이 그 건의 행 안에 있으니 **어느 건을 지우는지도 헷갈릴 수 없다.**
 */
export function rowDeleteSubmit(row) {
  if (!row || !row.querySelectorAll) return null;
  for (const n of row.querySelectorAll('input')) {
    const name = n.getAttribute('name') || '';
    const type = (n.getAttribute('type') || '').toLowerCase();
    if (type !== 'submit' && type !== 'image') continue;
    if (!/BTN_?DEL(ETE)?$/i.test(name)) continue;
    return { submit: name, value: n.getAttribute('value') || '취소', kind: type };
  }
  return null;
}

/**
 * 이 예약을 우리가 지울 수 있는가.
 * 손잡이는 두 모양 중 하나다 — 행에 붙은 취소 submit 버튼(submit), 또는 fn_del 의 번호(idx).
 * 한쪽만 보면 다른 쪽 화면에서 취소 버튼이 통째로 막힌다.
 */
export function canDelete(del) {
  return !!(del && (del.submit || del.idx));
}

/** 예약 한 건의 본 행. 컬럼 위치가 고정되어 있다. */
function parseMainRow(row) {
  const cells = [...row.cells];
  const region = clean(cells[GRID.col.region]?.textContent);
  const room = clean(cells[GRID.col.room]?.textContent);
  const range = parseTimeRange(cells[GRID.col.time]?.textContent || '');
  if (!room || !range) return null;

  return {
    region,
    room,
    start: range.start,
    end: range.end,
    status: clean(cells[GRID.col.status]?.textContent),
    mine: rowIsMine(row),
    del: rowDeleteHandle(row),
  };
}

/**
 * 본 행 바로 뒤의 상세 행에 회의명과 예약자가 들어 있다.
 *
 * 여기서 'tbody tr' 같은 후손 셀렉터를 쓰면 안 된다. 상세 표가 바깥 표 안에 중첩돼 있어서
 * 상세 표의 헤더 행도 바깥 tbody 의 후손으로 잡힌다. 행을 직접 골라야 한다.
 */
function parseDetailRow(row) {
  const detail = row?.querySelector(`table.${GRID.detailClass}`);
  const dr = detail && [...detail.rows].find((r) => r.cells.length >= 2 && !r.querySelector('th'));
  if (!dr) return { title: '', owner: '', dept: '' };

  const title = clean(dr.cells[0]?.textContent).replace(/^└\s*/, '');
  const ownerRaw = clean(dr.cells[1]?.textContent);
  const m = ownerRaw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return {
    title,
    owner: m ? m[1] : ownerRaw,
    dept: m ? m[2] : '',
  };
}

/**
 * 예약 현황을 뽑되, **읽었다고 확신할 수 있을 때만 confident: true** 를 준다.
 * 빈 배열을 그냥 "예약 없음"으로 보면 전부 예약 가능하다고 잘못 안내하게 된다.
 *
 * 달력에 찍힌 그날 건수와 대조해 파싱 누락을 잡아낸다.
 *
 * @returns {{reservations: Array, confident: boolean, reason: string, expected: number|null}}
 */
export function extractSchedule(doc, dateStr) {
  const unsure = (reason, extra = {}) =>
    ({ reservations: [], confident: false, reason, expected: null, ...extra });

  const table = findGridTable(doc);
  if (!table) return unsure('예약 표(RadGrid)를 찾지 못했습니다.');

  const rows = [...table.rows]; // 중첩된 상세 표의 행은 여기 포함되지 않는다
  const reservations = [];
  let unreadable = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.cells.length < GRID.minCells) continue;   // 상세 행·헤더 행 제외
    if (row.querySelector('th')) continue;

    const main = parseMainRow(row);
    if (!main) {
      // 시간이나 회의실을 못 읽은 데이터 행인지, 안내 문구 행인지 구분한다
      if (clean(row.textContent)) unreadable++;
      continue;
    }
    reservations.push({ ...main, ...parseDetailRow(rows[i + 1]), date: dateStr || null });
  }

  const counts = parseDayCounts(doc);
  const expected = dateStr && counts.has(dateStr) ? counts.get(dateStr) : null;

  if (unreadable > 0) {
    return unsure(`예약 ${unreadable}건의 시간을 해석하지 못했습니다.`, { reservations, expected });
  }
  if (expected != null && expected !== reservations.length) {
    return unsure(
      `달력은 ${expected}건인데 표에서 ${reservations.length}건만 읽었습니다.`,
      { reservations, expected },
    );
  }
  if (expected == null && reservations.length === 0) {
    return unsure('예약이 하나도 안 읽혔고 달력에서 건수도 확인하지 못했습니다.');
  }

  return { reservations, confident: true, reason: '', expected };
}

/* ---------------------------------------------------------------- 슬롯 */

/**
 * 회의실 × 시간 슬롯 격자를 만든다.
 * confident 가 false 면 모든 칸을 'unknown' 으로 둔다. 비었다고 단정하지 않는다.
 *
 * @returns [{ room, slots: [{ start, end, state: 'free'|'busy'|'unknown', by }] }]
 */
export function buildGrid(rooms, reservations, hours, opts = {}) {
  const { confident = true, slotMinutes = SLOT_MINUTES } = opts;
  const from = hours.start * 60;
  const to = hours.end * 60;

  return rooms.map((room) => {
    const mine = reservations.filter((r) => r.room === room.name || r.room === room.value);
    const slots = [];
    for (let t = from; t + slotMinutes <= to; t += slotMinutes) {
      const hit = mine.find((r) => r.start < t + slotMinutes && r.end > t);
      let state;
      if (hit) state = 'busy';
      else if (!confident) state = 'unknown';
      else state = 'free';

      slots.push({
        start: t,
        end: t + slotMinutes,
        state,
        mine: !!hit?.mine,
        by: hit ? (hit.title || hit.owner || '예약됨') : '',
      });
    }
    return { room, slots };
  });
}

/** 예약 목록에 특정 회의실/시간대를 덮는 예약이 있는지 본다(예약 후 확인용). */
export function findOverlap(reservations, roomName, startMin, endMin) {
  return reservations.find((r) => r.room === roomName && r.start < endMin && r.end > startMin) || null;
}
