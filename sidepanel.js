import { DEFAULT_HOURS, SHELL_URL, LIST_URL } from './src/config.js';
import { AuthError } from './src/net.js';
import { loadDay, scanDays, captureRaw, reserve, cancelReservation } from './src/site.js';
import {
  loadCarDay, scanCarDays, reserveCar, cancelCarReservation, openCarForm,
  CAR_LIST_URL, CAR_SHELL_URL,
} from './src/rentcar.js';
import { modifyReservation, describeModifyResult } from './src/modify.js';
import { parseSmart, diagnoseSmart, nativeAvailable, nativeLogs } from './src/llm.js';
import { createLogbook, formatEntries, buildLogReport, stamp } from './src/logbook.js';
import { buildSaveDigest } from './src/diagnose.js';
import { findSlots, MAX_DAYS, widenHours } from './src/search.js';
import { collectMine, datesFrom, sameName } from './src/mine.js';
import { MONTH_DAYS, createDayStore } from './src/monthcache.js';
import { fmtTime, todayStr, buildGrid, canDelete } from './src/parse.js';
import { isFoldedRoom, foldLabels } from './src/roomorder.js';

const $ = (id) => document.getElementById(id);
const el = {
  date: $('date'), prev: $('prevDay'), next: $('nextDay'), today: $('today'),
  dateLabel: $('dateLabel'), dateWeekday: $('dateWeekday'), roomCount: $('roomCount'),
  region: $('region'), hourStart: $('hourStart'), hourEnd: $('hourEnd'), refresh: $('refresh'),
  status: $('status'), grid: $('grid'),
  booking: $('booking'), pickLabel: $('pickLabel'), clearPick: $('clearPick'),
  title: $('fTitle'), submit: $('submit'), extend: $('extend'), cancelBtn: $('cancelBooking'),
  lblTitle: $('lblTitle'), carFields: $('carFields'), place: $('fPlace'),
  passenger: $('fPassenger'), carWho: $('carWho'), modify: $('modify'), editNote: $('editNote'),
  auto: $('auto'), stamp: $('stamp'), pickList: $('pickList'),
  ask: $('askInput'), askGo: $('askGo'), askNote: $('askNote'), askList: $('askList'),
  apiKey: $('apiKey'), cliState: $('cliState'), cliCheck: $('cliCheck'),
  tabRoom: $('tabRoom'), tabCar: $('tabCar'), tabMine: $('tabMine'), appTitle: $('appTitle'),
  openPageInline: $('openPageInline'), scheduleTitle: $('scheduleTitle'), scheduleDate: $('scheduleDate'),
  capture: $('capture'), diagOut: $('diagOut'),
  spanDays: $('spanDays'), spanControl: document.querySelector('.span-control'),
  mineWrap: $('mineWrap'), mineList: $('mineList'), mineEmpty: $('mineEmpty'), myName: $('myName'),
  scanBar: $('scanBar'), scanNote: $('scanNote'), scanFill: $('scanFill'),
  logBox: $('logBox'), logCount: $('logCount'), logOut: $('logOut'),
  logCopy: $('logCopy'), logSave: $('logSave'), logClear: $('logClear'),
};

// picks: 누적 선택. [{ room: 행번호, from: 슬롯, to: 슬롯 }]
const state = { day: null, picks: [], drag: null, loadedAt: 0, timer: null,
  region: null, regions: [], apiKey: '', found: [], cli: false, mode: 'room', extendTarget: null,
  justBooked: [], myName: '', mine: [], editTarget: null, carWho: null,
  foldOpen: false, foundKind: 'room', asking: false };

/* ------------------------------------------------------------- 활동 기록 */

const logbook = createLogbook({ storage: chrome.storage.local });

/**
 * 한 일을 기록한다. 기록은 곁다리다 — 실패해도, 느려도 본 작업을 막지 않도록 기다리지 않는다.
 * API 키 같은 비밀은 data 에 넣지 않는다.
 */
function logEvent(kind, ok, text, data, opts = {}) {
  logbook.add(kind, { ok, text, data, ...opts }).then(paintLog, () => {});
}

/** 수정·이어붙이기 결과에서 남길 것만 고른다. record 에는 화면 손잡이 같은 조각이 딸려 온다. */
const modifyOutcome = (r) => (r && {
  stage: r.stage, restored: r.restored, lost: r.lost, uncertain: r.uncertain, message: r.message,
});

/* ------------------------------------------------------------- 유틸 */

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const asDate = (str) => {
  const [year, month, date] = (str || todayStr()).split('-').map(Number);
  return new Date(year, month - 1, date);
};

const ymdOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const addDays = (str, n) => {
  const d = asDate(str);
  d.setDate(d.getDate() + n);
  return ymdOf(d);
};

const weekdayOf = (d, style = 'short') =>
  new Intl.DateTimeFormat('ko-KR', { weekday: style }).format(d);

/** "9월 19일 (토)" */
const dayLabel = (str) => {
  const d = asDate(str);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${weekdayOf(d)})`;
};

/** "9/19" */
const shortLabel = (str) => {
  const d = asDate(str);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

function paintDate() {
  const value = el.date.value || todayStr();
  const day = asDate(value);
  el.dateLabel.textContent = `${day.getMonth() + 1}월 ${day.getDate()}일`;
  el.dateWeekday.textContent = `${day.getFullYear()}년 · ${weekdayOf(day, 'long')}`;
  // 오늘 버튼은 오늘을 보고 있을 때만 파랗게 — 늘 파라면 다른 날도 오늘로 읽힌다
  const onToday = value === todayStr();
  el.today.classList.toggle('on', onToday);
  if (onToday) el.today.setAttribute('aria-current', 'date');
  else el.today.removeAttribute('aria-current');
  paintHeading();
}

/**
 * 현황 제목 옆에 **지금 보고 있는 날짜**를 박아 둔다.
 * 숫자만 있으면 그게 어느 날 것인지 알 수 없고, 회의실 수는 날짜가 바뀌어도 그대로라
 * 화면이 안 따라온 것처럼 보인다.
 */
function paintHeading() {
  const start = el.date.value || todayStr();
  el.scheduleDate.textContent = isMineMode()
    ? `${shortLabel(start)} ~ ${shortLabel(addDays(start, spanDays() - 1))}`
    : dayLabel(start);
}

function setStatus(msg, kind = '') {
  el.status.className = `status ${kind}`;
  el.status.textContent = msg;
}

/** 링크가 필요한 안내에만 쓴다. 넣는 문자열은 이 파일 안에서 만든 것뿐이다. */
function setStatusHtml(html, kind = '') {
  el.status.className = `status ${kind}`;
  el.status.innerHTML = html;
}

function openSiteOn(linkId) {
  $(linkId)?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: isCar() ? CAR_SHELL_URL : SHELL_URL });
  });
}

function shiftDate(days) {
  el.date.value = addDays(el.date.value || todayStr(), days);
  load();
}

const hours = () => ({ start: +el.hourStart.value, end: +el.hourEnd.value });

/** 내 예약에서 훑을 날 수. 기본은 한 달 — 시작할 때 미리 훑어 두는 범위와 같다. */
const spanDays = () => +el.spanDays.value || MONTH_DAYS;

const AUTO_MS = 60_000;

/** 그때 읽은 지 얼마나 됐는지. 캐시로 그린 화면에서도 쓴다. */
function agoText(at) {
  if (!at) return '';
  const sec = Math.floor((Date.now() - at) / 1000);
  if (sec < 15) return '방금';
  if (sec < 60) return `${sec}초 전`;
  return `${Math.floor(sec / 60)}분 전`;
}

/** 마지막으로 조회한 지 얼마나 됐는지. 현황은 금방 낡으므로 눈에 보이게 둔다. */
function paintStamp() {
  el.stamp.textContent = agoText(state.loadedAt);
}

/** 자동 갱신. 패널이 보이지 않을 때는 서버를 두드리지 않는다. */
function applyAuto() {
  clearInterval(state.timer);
  state.timer = null;
  if (!el.auto.checked) return;
  state.timer = setInterval(() => {
    // 내 예약은 하루에 한 번씩 며칠을 훑는다. 60초마다 자동으로 돌릴 일이 아니다.
    if (document.hidden || el.refresh.disabled || isMineMode()) return;
    // 고르는 중이거나 회의주제를 쓰는 중이면 건드리지 않는다.
    // 새로 고치면 선택이 지워져서, 폼을 채우는 사이에 고른 게 날아간다.
    if (state.picks.length || state.drag) return;
    if (document.activeElement === el.title && el.title.value.trim()) return;
    load();
  }, AUTO_MS);
}

/* ------------------------------------------------------------- 렌더 */

function render(day) {
  const { grid } = day;
  // 배지는 **그날 예약 건수**다. 회의실 수는 날짜가 바뀌어도 그대로라 배지로는 쓸모가 없다.
  const what = isCar() ? '이용' : '예약';
  if (day.confident) {
    el.roomCount.textContent = String(day.reservations.length);
    el.roomCount.title = `${dayLabel(day.date)} ${what} ${day.reservations.length}건`;
  } else {
    el.roomCount.textContent = '?';
    el.roomCount.title = `${dayLabel(day.date)} — ${what} 건수를 확인하지 못했습니다`;
  }
  if (!grid.length) {
    const noun = isCar() ? '차량' : '회의실';
    el.grid.innerHTML = `<p class="hint">${noun} 정보를 찾지 못했습니다. 아래 “페이지 구조 캡처”를 실행해 주세요.</p>`;
    return;
  }

  const head = grid[0].slots
    .map((s) => `<th class="hour" scope="col">${String(Math.floor(s.start / 60)).padStart(2, '0')}</th>`)
    .join('');

  const tipFor = (s) => {
    const span = `${fmtTime(s.start)}~${fmtTime(s.end)}`;
    if (s.state === 'busy') return `${span} · 사용 중${s.by ? ` · ${s.by}` : ''}${s.fresh ? ' (방금 예약함)' : s.mine ? ' (내 예약)' : ''}`;
    if (s.state === 'unknown') return `${span} · 확인 불가 (예약 여부를 읽지 못했습니다)`;
    return `${span} 예약 가능`;
  };

  // 접어 둔 방은 줄을 **지우지 않고 감춘다.** 줄 번호(ri)가 선택의 열쇠라서
  // 빼 버리면 눌러 둔 칸이 다른 방으로 옮겨간다. 차량 표에는 접을 것이 없다.
  const folded = grid.map((row) => !isCar() && isFoldedRoom(row.room));

  const rows = grid.map((row, ri) => {
    const r = row.room;
    const cells = row.slots.map((s, si) => {
      const tip = tipFor(s);
      const mine = `${s.mine ? ' mine' : ''}${s.fresh ? ' fresh' : ''}`;
      const interactive = s.state === 'free' ? ' tabindex="0" role="button" aria-pressed="false"' : '';
      return `<td class="slot ${s.state}${mine}" data-r="${ri}" data-s="${si}" title="${escapeHtml(tip)}"` +
        ` aria-label="${escapeHtml(`${r.name} · ${tip}`)}"${interactive}><span class="slot-fill" aria-hidden="true"></span></td>`;
    }).join('');
    const name = (r.label || r.name).replace(/\s*\(\s*\d+\s*층\s*\)\s*$/, '');
    const meta = [r.floor != null ? `<span>${escapeHtml(r.floor)}층</span>` : '',
      r.seats ? `<span class="seats">${escapeHtml(r.seats)}석</span>` : ''].filter(Boolean).join('<span aria-hidden="true">·</span>');
    return `<tr${folded[ri] ? ' class="folded"' : ''}><th class="room" scope="row" title="${escapeHtml(r.name)}"><span class="rname">${escapeHtml(name)}</span>` +
      (meta ? `<span class="room-meta">${meta}</span>` : '') + `</th>${cells}</tr>`;
  });

  // 접힌 무리 바로 앞에 펼침 손잡이를 끼운다. 정렬이 접는 방을 맨 아래로 몰아 두므로
  // 손잡이 하나면 된다.
  const foldFrom = folded.indexOf(true);
  if (foldFrom >= 0) {
    const hiddenRooms = grid.filter((_, i) => folded[i]).map((row) => row.room);
    const names = foldLabels(hiddenRooms).join(' · ');
    rows.splice(foldFrom, 0,
      `<tr class="fold-row"><td class="fold-cell" colspan="${1 + grid[0].slots.length}">` +
      `<button type="button" id="foldToggle" class="fold-toggle" aria-expanded="${state.foldOpen}"` +
      ` title="눌러서 펼치거나 접습니다"><span class="fold-caret" aria-hidden="true">` +
      `<svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></svg></span>` +
      `<span class="fold-names">${escapeHtml(names)}</span>` +
      `<span class="fold-count">${hiddenRooms.length}곳</span></button></td></tr>`);
  }
  const body = rows.join('');

  const mineCount = day.reservations.filter((r) => r.mine).length;

  el.grid.innerHTML =
    `<div class="table-scroll"><table class="grid${state.foldOpen ? ' show-folded' : ''}"><caption class="sr-only">${escapeHtml(day.date)} 회의실별 예약 현황. 예약 가능한 시간을 선택해 주세요.</caption>` +
    `<thead><tr><th class="room" scope="col">${isCar() ? '차량' : '회의실'}</th>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    (day.confident
      ? '<div class="legend"><span><i class="f"></i>예약 가능</span><span><i class="b"></i>사용 중</span>' +
        `<span><i class="m"></i>내 예약 ${mineCount}건</span></div>`
      : '<div class="legend"><span><i class="u"></i>확인 불가</span>' +
        '<span><i class="b"></i>사용 중(읽힌 것만)</span></div>');

  const table = el.grid.querySelector('table.grid');
  table.style.minWidth = `${150 + grid[0].slots.length * 23}px`;

  // 접기는 화면에만 있는 상태다. 다시 그리지 않고 표에 자국만 바꾼다 —
  // 자동 갱신이 돌 때마다 도로 접히면 눌러 둔 뜻이 사라진다.
  const foldBtn = el.grid.querySelector('#foldToggle');
  foldBtn?.addEventListener('click', () => {
    state.foldOpen = !state.foldOpen;
    chrome.storage.local.set({ foldOpen: state.foldOpen });
    table.classList.toggle('show-folded', state.foldOpen);
    foldBtn.setAttribute('aria-expanded', String(state.foldOpen));
  });

  attachDrag();
  paintPicks();
}

/** 같은 회의실에서 겹치거나 맞붙은 선택은 하나로 합친다. */
function normalizePicks() {
  const byRoom = new Map();
  for (const p of state.picks) {
    if (!byRoom.has(p.room)) byRoom.set(p.room, []);
    byRoom.get(p.room).push({ ...p });
  }

  const out = [];
  for (const [room, list] of byRoom) {
    list.sort((a, b) => a.from - b.from);
    let cur = list[0];
    for (const p of list.slice(1)) {
      if (p.from <= cur.to + 1) cur.to = Math.max(cur.to, p.to);
      else { out.push(cur); cur = p; }
    }
    out.push(cur);
    void room;
  }

  out.sort((a, b) => a.room - b.room || a.from - b.from);
  state.picks = out;
}

/**
 * 선택 하나를 사이트에 보낼 예약 한 건으로 바꾼다.
 *
 * 회의실과 차량은 보내는 값이 다르다. 차량은 회의주제 대신 **행선지가 필수**이고
 * (사이트의 fnSaveCheck 가 그렇게 막는다), 차량 자체는 폼이 아니라 주소(CARIDX)로 정해진다.
 */
function pickToPayload(p, title) {
  const row = state.day.grid[p.room];
  const start = fmtTime(row.slots[p.from].start);
  const end = fmtTime(row.slots[p.to].end);

  if (isCar()) {
    return {
      kind: 'car',
      car: row.room.name,
      carValue: row.room.value,
      room: row.room.name,          // 진행 표시와 '내가 넣음' 기록이 room 을 본다
      date: state.day.date,
      start,
      end,
      title,
      place: el.place.value.trim(),
      passenger: el.passenger.value.trim(),
    };
  }
  return {
    kind: 'room',
    room: row.room.name,
    roomValue: row.room.value,
    region: state.day.region,
    date: state.day.date,
    start,
    end,
    title,
  };
}

/** 지금 보고 있는 탭에 맞는 예약/취소/재조회. 회의실과 차량이 같은 흐름을 쓰게 한다. */
const submitOne = (payload) =>
  (payload.kind === 'car' ? reserveCar(payload) : reserve(payload, state.day));

const cancelOne = (record, day) =>
  (isCar() ? cancelCarReservation(record, day) : cancelReservation(record, day));

const reloadDay = (date = state.day.date) =>
  (isCar() ? loadCarDay(date, hours()) : loadDay(date, hours(), state.region));

function paintPicks() {
  for (const td of el.grid.querySelectorAll('td.slot')) {
    td.classList.remove('picked');
    if (td.classList.contains('free')) td.setAttribute('aria-pressed', 'false');
  }

  if (!state.picks.length) {
    el.booking.classList.add('hidden');
    el.pickList.innerHTML = '';
    return;
  }

  for (const p of state.picks) {
    for (let s = p.from; s <= p.to; s++) {
      const td = el.grid.querySelector(`td.slot[data-r="${p.room}"][data-s="${s}"]`);
      td?.classList.add('picked');
      td?.setAttribute('aria-pressed', 'true');
    }
  }

  const cancels = state.picks.filter((p) => p.kind === 'cancel');
  const books = state.picks.filter((p) => p.kind !== 'cancel');

  el.pickLabel.textContent = cancels.length && !books.length
    ? `취소할 예약 ${cancels.length}건`
    : `선택 ${books.length}건`;

  el.pickList.innerHTML = state.picks.map((p, i) => {
    const row = state.day.grid[p.room];
    const time = `${fmtTime(row.slots[p.from].start)}~${fmtTime(row.slots[p.to].end)}`;
    const name = row.room.label || row.room.name;
    const cancel = p.kind === 'cancel';
    return `<li data-i="${i}"${cancel ? ' class="cancel"' : ''}>` +
      `<span class="pk-mark" data-mark>${cancel ? '✕' : ''}</span>` +
      `<span class="pk-room" title="${escapeHtml(row.room.name)}">${escapeHtml(name)}` +
      `${cancel && p.record?.title ? ` · ${escapeHtml(p.record.title)}` : ''}</span>` +
      `<span class="pk-time">${time}</span>` +
      `<button class="pk-del" data-del="${i}" title="빼기">×</button></li>`;
  }).join('');

  paintActions(books, cancels);
  el.booking.classList.remove('hidden');
}

/**
 * 고른 것에 맞춰 버튼을 바꾼다.
 *
 * 예약과 취소가 섞이면 **예약이 이긴다**(취소 선택은 애초에 들어오지 못하게 막는다).
 * 내 예약에 맞닿은 빈 칸 하나만 골랐으면 연장하기를 함께 보여준다.
 */
function paintActions(books, cancels) {
  const onlyCancel = cancels.length > 0 && books.length === 0;

  el.cancelBtn.classList.toggle('hidden', !onlyCancel);
  el.submit.classList.toggle('hidden', onlyCancel);
  el.title.hidden = onlyCancel;
  document.querySelector('label[for="fTitle"]')?.toggleAttribute('hidden', onlyCancel);

  if (onlyCancel) {
    el.extend.classList.add('hidden');
    el.modify.classList.add('hidden');
    el.cancelBtn.textContent = cancels.length > 1 ? `${cancels.length}건 취소하기` : '취소하기';
    return;
  }

  el.submit.textContent = books.length > 1 ? `${books.length}건 예약하기` : '예약하기';

  // 수정 중이면 예약이 아니라 수정이다. 한 건만 고른 상태에서만 뜻이 있다
  // — 두 칸을 고르면 어느 쪽으로 옮기라는 것인지 알 수 없다.
  const editing = !!state.editTarget && books.length === 1;
  el.modify.classList.toggle('hidden', !editing);
  el.submit.classList.toggle('hidden', editing);
  if (editing) {
    const row = state.day.grid[books[0].room];
    const from = row.slots[books[0].from].start;
    const to = row.slots[books[0].to].end;
    el.modify.textContent = `${fmtTime(from)}~${fmtTime(to)} 로 수정`;
    el.modify.title = '기존 예약을 취소하고 이 시간으로 다시 넣습니다';
    el.extend.classList.add('hidden');
    return;
  }

  // 연장은 한 건만 골랐을 때, 그리고 그 옆이 내 예약일 때만 뜻이 있다
  const target = books.length === 1 ? extendTargetFor(books[0]) : null;
  state.extendTarget = target;
  el.extend.classList.toggle('hidden', !target);
  if (target) {
    const from = Math.min(target.start, state.day.grid[books[0].room].slots[books[0].from].start);
    const to = Math.max(target.end, state.day.grid[books[0].room].slots[books[0].to].end);
    el.extend.textContent = `${fmtTime(from)}~${fmtTime(to)} 로 이어붙이기`;
    el.extend.title = '기존 예약을 취소하고 합친 시간으로 다시 예약합니다';
  }
}

/** 선택 범위 안에 사용 중인 칸이 없어야 한다. */
function rangeIsFree(roomIdx, from, to) {
  const slots = state.day.grid[roomIdx].slots;
  for (let i = from; i <= to; i++) if (slots[i].state !== 'free') return false;
  return true;
}

/** 이미 선택된 칸이면 그 선택의 인덱스를 준다. */
function pickAt(room, slot) {
  return state.picks.findIndex((p) => p.room === room && slot >= p.from && slot <= p.to);
}

/** 그 칸을 덮고 있는 내 예약을 찾는다. */
function myRecordAt(room, slot) {
  const row = state.day?.grid[room];
  const s = row?.slots[slot];
  if (!row || !s || !s.mine) return null;
  return state.day.reservations.find((r) =>
    (r.room === row.room.name || r.room === row.room.value) &&
    r.mine && r.start < s.end && r.end > s.start) || null;
}

/** 취소 선택을 넣는다. 예약 선택이 있으면 예약이 이긴다. */
function addCancelPick(room, rec) {
  if (state.picks.some((p) => p.kind === 'book')) {
    setStatus('예약 선택이 있어 취소는 함께 고를 수 없습니다. 선택을 지우고 다시 누르세요.', 'error');
    return;
  }
  const slots = state.day.grid[room].slots;
  const from = slots.findIndex((sl) => sl.end > rec.start);
  let to = -1;
  for (let i = 0; i < slots.length; i++) if (slots[i].start < rec.end) to = i;
  if (from < 0 || to < 0) return;

  if (state.picks.some((p) => p.kind === 'cancel' && p.record === rec)) return;
  state.picks.push({ room, from, to, kind: 'cancel', record: rec });
  paintPicks();
}

/** 고른 범위가 내 예약과 맞닿아 있으면 그 예약을 준다(연장 대상). */
function extendTargetFor(pick) {
  const row = state.day?.grid[pick.room];
  if (!row) return null;
  const startMin = row.slots[pick.from].start;
  const endMin = row.slots[pick.to].end;
  return state.day.reservations.find((r) =>
    r.mine && (r.room === row.room.name || r.room === row.room.value) &&
    (r.end === startMin || r.start === endMin)) || null;
}

/**
 * 못 고르는 칸을 눌렀을 때 이유를 말해준다.
 * 아무 반응이 없으면 고장난 줄 안다 — 실제로 그렇게 보였다.
 */
function explainBlocked(room, slot) {
  const s = state.day?.grid[room]?.slots[slot];
  if (!s) return;

  if (s.state === 'unknown') {
    setStatus('이 칸은 예약 여부를 읽지 못해 고를 수 없습니다.', 'error');
    return;
  }
  if (s.mine) {
    // 사이트에 수정 기능이 따로 있고, 우리는 이어 붙이는 쪽을 안내한다
    const free = nextFreeAfter(room, slot);
    setStatus(
      free
        ? `이미 내 예약입니다. 시간을 늘리려면 옆의 빈 칸(${fmtTime(free.start)}~)을 고르세요. `
          + '시간을 옮기려면 내 예약 탭에서 수정을 누르세요.'
        : '이미 내 예약입니다. 시간을 옮기려면 내 예약 탭에서 수정을 누르세요.',
      'error',
    );
    return;
  }
  setStatus(`이미 사용 중입니다${s.by ? ` · ${s.by}` : ''}.`, 'error');
}

/** 그 칸 뒤로 가장 가까운 빈 칸. */
function nextFreeAfter(room, slot) {
  const slots = state.day?.grid[room]?.slots || [];
  for (let i = slot + 1; i < slots.length; i++) {
    if (slots[i].state === 'free') return slots[i];
    if (slots[i].state === 'busy') break;
  }
  for (let i = slot - 1; i >= 0; i--) {
    if (slots[i].state === 'free') return slots[i];
    if (slots[i].state === 'busy') break;
  }
  return null;
}

function attachDrag() {
  const table = el.grid.querySelector('table.grid');
  if (!table) return;

  const cellOf = (t) => (t instanceof HTMLElement ? t.closest('td.slot') : null);

  table.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !state.day || el.grid.getAttribute('aria-busy') === 'true') return;
    const td = cellOf(e.target);
    if (!td) return;
    const room = +td.dataset.r;
    const slot = +td.dataset.s;

    // 이미 고른 칸을 다시 누르면 그 건을 뺀다
    const existing = pickAt(room, slot);
    if (existing >= 0) {
      e.preventDefault();
      state.picks.splice(existing, 1);
      paintPicks();
      return;
    }

    if (!td.classList.contains('free')) {
      // 내 예약을 누르면 취소 대상으로 고른다
      const rec = myRecordAt(room, slot);
      if (rec) {
        e.preventDefault();
        addCancelPick(room, rec);
        return;
      }
      explainBlocked(room, slot);
      return;
    }
    e.preventDefault();

    // 예약 선택이 들어오면 취소 선택은 덮어쓴다
    state.picks = state.picks.filter((p) => p.kind !== 'cancel');
    state.picks.push({ room, from: slot, to: slot, kind: 'book' });
    state.drag = { room, anchor: slot, idx: state.picks.length - 1 };
    paintPicks();
  });

  table.addEventListener('mouseover', (e) => {
    if (!state.drag) return;
    const td = cellOf(e.target);
    if (!td || +td.dataset.r !== state.drag.room) return;

    const slot = +td.dataset.s;
    const from = Math.min(state.drag.anchor, slot);
    const to = Math.max(state.drag.anchor, slot);
    if (!rangeIsFree(state.drag.room, from, to)) return;

    state.picks[state.drag.idx] = { room: state.drag.room, from, to };
    paintPicks();
  });

  table.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat || !state.day || el.grid.getAttribute('aria-busy') === 'true') return;
    const td = cellOf(e.target);
    if (!td?.classList.contains('free')) return;
    e.preventDefault();
    state.drag = null;
    const room = +td.dataset.r;
    const slot = +td.dataset.s;
    const existing = pickAt(room, slot);
    if (existing >= 0) {
      const [pick] = state.picks.splice(existing, 1);
      if (pick.from < slot) state.picks.push({ room, from: pick.from, to: slot - 1 });
      if (slot < pick.to) state.picks.push({ room, from: slot + 1, to: pick.to });
    } else {
      state.picks.push({ room, from: slot, to: slot });
    }
    normalizePicks();
    paintPicks();
  });
}

/** 선택 목록의 빼기 버튼. */
function attachPickList() {
  el.pickList.addEventListener('click', (e) => {
    const btn = e.target instanceof HTMLElement ? e.target.closest('[data-del]') : null;
    if (!btn) return;
    state.picks.splice(+btn.dataset.del, 1);
    paintPicks();
  });
}

/* --------------------------------------------- 한 달 미리 훑기 (세 탭 공용) */

/**
 * 패널이 열리면 **오늘부터 한 달**을 한 번 훑어 여기에 담는다.
 * 회의실·차량·내 예약 세 탭이 모두 이 한 벌을 본다 — 탭을 옮기거나 날짜를 넘길 때마다
 * 느린 사이트를 다시 두드리지 않는다.
 *
 * 담긴 값에는 읽은 시각이 붙는다. 캐시로 그린 화면에는 **언제 읽은 것인지** 같이 적는다.
 * 묵은 현황을 지금 것처럼 보여주면 이미 찬 칸을 "예약 가능"으로 칠하게 된다.
 */
const store = createDayStore();

/**
 * 지역별 회의실 목록.
 *
 * 예약 목록에는 전 지역 것이 다 들어 있지만 **방 목록은 지역마다 다르다.** 훑기는 한 지역으로만
 * 돌기 때문에, 지역을 바꾸면 담아 둔 예약은 그대로 쓰면서 방 목록만 여기서 꺼내 쓴다.
 * 그 지역을 한 번이라도 열어 봤으면 한 달치가 통째로 다시 살아난다.
 */
const roomsByRegion = new Map();

/** 하루가 담길 때마다 알린다. 내 예약 목록이 훑는 대로 차오르게 하는 데 쓴다. */
const scanWatchers = new Set();
function onScanDay(fn) {
  scanWatchers.add(fn);
  return () => scanWatchers.delete(fn);
}

/** 지금 도는 훑기. 한 번에 하나만 돈다 — 둘이 겹치면 같은 날을 두 번 읽는다. */
let scanning = null;

/** 진행 막대에 보여줄 것. 회의실·차량 두 바퀴를 한 줄로 합쳐 센다. */
const scanView = { on: false, label: '', phase: 0, i: 0, n: 0, date: '', at: 0, range: '' };

/** 시작할 때 미리 훑는 범위. 오늘부터 한 달. */
const monthDates = () => datesFrom(todayStr(), MONTH_DAYS);

function paintScanBar() {
  const { on, label, phase, i, n, date, at, range } = scanView;
  el.scanBar.classList.toggle('hidden', !on && !at);
  el.scanBar.classList.toggle('done', !on);

  if (on) {
    el.scanNote.textContent = `${label} ${i}/${n}${date ? ` · ${shortLabel(date)}` : ''}`;
    el.scanBar.title = date ? `${date} 읽는 중` : '한 달치를 미리 읽어 둡니다';
    const done = n ? (phase * n + i) / (n * 2) : 0;
    el.scanFill.style.width = `${Math.round(done * 100)}%`;
    return;
  }
  if (at) {
    el.scanNote.textContent = `한 달 준비됨 · ${range}`;
    el.scanBar.title = `${agoText(at)} 읽어 둔 것입니다. 누르면 다시 훑습니다.`;
    el.scanFill.style.width = '100%';
  }
}

/**
 * 날짜들을 실제로 훑어 캐시에 담는다. 회의실 한 바퀴, 차량 한 바퀴.
 * 한쪽이 실패해도 다른 쪽은 계속한다 — 부르는 쪽이 무엇이 빠졌는지 말할 수 있어야 한다.
 */
async function runScan(dates) {
  const failed = [];
  let authError = null;

  const feed = (day) => {
    store.put(day);
    if (day.kind === 'room' && day.region && day.rooms?.length) roomsByRegion.set(day.region, day.rooms);
    for (const watch of [...scanWatchers]) {
      try { watch(day); } catch { /* 화면 문제로 훑기를 멈추지는 않는다 */ }
    }
  };

  scanView.on = true;
  scanView.n = dates.length;
  scanView.range = `${shortLabel(dates[0])}~${shortLabel(dates[dates.length - 1])}`;

  const phase = async (idx, label, fn) => {
    scanView.phase = idx;
    scanView.label = label;
    scanView.i = 0;
    paintScanBar();
    try {
      await fn((date, i, n) => {
        scanView.date = date;
        scanView.i = i;
        scanView.n = n;
        paintScanBar();
      });
    } catch (err) {
      if (err instanceof AuthError) authError = err;
      failed.push(`${label} 훑기 실패: ${err.message}`);
    }
  };

  try {
    // 회의실 방 목록은 지역마다 다르다. 보고 있는 지역으로 훑어야 격자를 캐시로 그릴 수 있다.
    await phase(0, '회의실', (p) => scanDays(dates, p, { region: state.region, onDay: feed }));
    await phase(1, '차량', (p) => scanCarDays(dates, p, { onDay: feed }));
  } finally {
    scanView.on = false;
    scanView.at = Date.now();
    paintScanBar();
  }
  // 훑기를 기다리는 쪽이 여럿일 수 있어 실패는 여기서 한 번만 남긴다.
  if (failed.length) {
    logEvent('scan', false, failed.join(' · '), { range: scanView.range, days: dates.length, auth: !!authError });
  }
  return { failed, authError };
}

/**
 * 그 날짜들이 캐시에 신선하게 담기도록 한다. 이미 담겨 있으면 아무것도 하지 않는다.
 *
 * 훑기는 한 번에 하나만 돈다. 이미 도는 게 있으면 그것이 채워 주기를 기다렸다가
 * **그래도 빈 날만** 다시 훑는다(탭을 옮기거나 기간을 늘렸을 때).
 */
async function ensureDays(dates, { force = false } = {}) {
  const out = { failed: [], authError: null };
  if (force) store.drop(dates);

  const absorb = (got) => {
    if (!got) return;
    out.failed.push(...got.failed);
    out.authError = out.authError || got.authError;
  };

  // 이미 도는 훑기가 있으면 그쪽이 채워 주기를 먼저 기다린다.
  while (scanning) absorb(await scanning.catch(() => null));

  // 훑을 날은 여기서 한 번만 정한다. 한 달을 훑는 동안 앞쪽 날이 다시 묵을 수 있는데,
  // 그때마다 되돌아가면 영영 끝나지 않는다. 묵은 것은 다음에 부를 때 다시 읽는다.
  const todo = store.missing(dates);
  if (!todo.length) return out;

  const run = runScan(todo);
  scanning = run;
  try { absorb(await run.catch(() => null)); }
  finally { if (scanning === run) scanning = null; }
  return out;
}

/** 패널이 열리면 곧바로 한 달을 훑어 둔다. 세 탭이 이 한 벌을 나눠 쓴다. */
async function prefetchMonth({ force = false } = {}) {
  const got = await ensureDays(monthDates(), { force });
  if (got.authError && !el.status.textContent) {
    setStatusHtml(`${got.authError.message} <a href="#" id="openLogin">eclass 열기</a>`, 'error');
    openSiteOn('openLogin');
  }
}

/**
 * 미리 훑어 둔 하루로 격자를 그릴 day 를 만든다.
 *
 * **보기 전용이다.** 예약·취소는 사이트 화면 손잡이(doc/pageUrl)가 있어야 하는데 훑기는
 * 그것을 남기지 않는다. 그래서 doc 없이 돌려주고, 살아 있는 조회가 끝날 때까지 격자는
 * aria-busy 로 잠긴 채 둔다. 예약 버튼도 doc 이 없으면 막는다.
 */
function cachedDay(date) {
  const kind = isCar() ? 'car' : 'room';
  const rec = store.get(kind, date);
  if (!rec) return null;

  // 보고 있는 지역의 방 목록이 있어야 격자를 그린다. 예약은 전 지역이 담겨 있어 그대로 쓴다.
  const region = kind === 'room' ? (state.region || rec.region || null) : null;
  const rooms = kind === 'room' && region && region !== rec.region
    ? roomsByRegion.get(region)
    : rec.rooms;
  if (!rooms?.length) return null;

  // markMine 이 여기에 '내 예약' 표시를 입히므로 **베껴서** 넘긴다. 담아 둔 것에 그 표시가
  // 묻으면, 이름으로 맞춘 건을 다음번에 "사이트가 붙인 수정·삭제 버튼"으로 읽게 된다.
  // 내 예약 목록의 근거 표시가 거기서 거짓말이 된다.
  const all = (rec.reservations || []).map((r) => ({ ...r }));
  const reservations = region ? all.filter((r) => !r.region || r.region === region) : all;

  return markMine({
    kind,
    date,
    region,
    regions: rec.regions || [],
    rooms,
    roomSource: rec.roomSource || 'table',
    reservations,
    reservationsAllRegions: all,
    expected: null,
    confident: rec.confident,
    reason: rec.reason,
    grid: buildGrid(rooms, reservations, hours(), { confident: rec.confident }),
    doc: null,
    pageUrl: null,
    cached: true,
    readAt: rec.at,
  });
}

/**
 * 살아 있는 조회 결과를 캐시에도 넣는다. 내 예약 목록이 이걸 그대로 쓴다.
 * **markMine 을 입히기 전에** 부른다 — 담기는 것은 사이트가 말한 그대로여야 한다.
 */
function cacheLiveDay(day) {
  if (!isCar() && day.region && day.rooms?.length) roomsByRegion.set(day.region, day.rooms);
  store.put({
    kind: isCar() ? 'car' : 'room',
    date: day.date,
    // 내 예약은 지역을 가리지 않는다. 지역으로 거르기 전 것을, 베껴서 담는다.
    reservations: (day.reservationsAllRegions || day.reservations || []).map((r) => ({ ...r })),
    rooms: day.rooms,
    roomSource: day.roomSource,
    region: day.region,
    regions: day.regions,
    confident: day.confident,
    reason: day.reason,
  });
}

/** 예약·취소로 낡아진 날을 캐시에서 버린다. 다음에 그 날을 보면 다시 읽는다. */
function forgetDays(dates, kinds) {
  store.drop(dates, kinds);
}

/** 예약 손잡이가 없는 화면(미리 훑어 둔 것)에서 제출을 막는다. */
function needsLiveDay() {
  if (state.day?.doc) return false;
  setStatus('미리 훑어 둔 현황이라 바로 보낼 수 없습니다. 최신 현황을 불러오는 중이니 잠시 뒤 다시 눌러주세요.', 'error');
  return true;
}

/* ------------------------------------------------------------- 동작 */

let loadSequence = 0;

async function load({ force = false } = {}) {
  const sequence = ++loadSequence;
  const date = el.date.value || todayStr();
  paintDate();
  state.picks = [];
  state.drag = null;
  state.day = null;
  state.loadedAt = 0;
  el.roomCount.textContent = '';
  el.roomCount.title = '';
  paintPicks();
  paintStamp();
  if (isMineMode()) return loadMine(sequence, { force });
  const h = hours();
  if (h.end <= h.start) {
    el.grid.innerHTML = '';
    el.grid.setAttribute('aria-busy', 'false');
    el.refresh.disabled = false;
    el.refresh.classList.remove('spin');
    setStatus('종료 시각이 시작 시각보다 늦어야 합니다.', 'error');
    return;
  }

  setStatus('조회 중...');
  el.refresh.disabled = true;
  el.refresh.classList.add('spin');
  el.grid.setAttribute('aria-busy', 'true');

  // 미리 훑어 둔 날이면 먼저 그린다. 한 달을 담아 뒀으므로 날짜를 넘겨도 즉시 보인다.
  // 살아 있는 조회가 끝나기 전까지는 보기 전용이다(격자가 aria-busy 로 잠겨 있다).
  const preview = cachedDay(date);
  if (preview) {
    state.day = preview;
    state.loadedAt = preview.readAt;
    if (!isCar()) fillRegions(preview);
    render(preview);
    paintStamp();
    setStatus(`미리 훑어 둔 현황(${agoText(preview.readAt)}) · 최신인지 확인하는 중...`);
  }

  try {
    const day = isCar()
      ? await loadCarDay(date, h)
      : await loadDay(date, h, state.region);
    if (sequence !== loadSequence) return;
    // 담는 게 먼저다. markMine 은 화면용 표시를 예약 줄에 입히는데, 그게 캐시로 새면
    // 다음번에 이름으로 맞춘 건을 "사이트가 본인 것에만 붙인 버튼"으로 읽게 된다.
    cacheLiveDay(day);
    state.day = markMine(day);
    if (!isCar()) fillRegions(day);
    render(day);
    state.loadedAt = Date.now();

    if (!day.confident) {
      // 예약 여부를 읽지 못한 것을 "예약 없음"으로 보여주면 안 된다.
      setStatus(`예약 여부를 확인할 수 없습니다 — ${day.reason} 아래 “구조 캡처”가 필요합니다.`, 'error');
      logEvent('load', false, `${isCar() ? '차량' : '회의실'} ${date} 예약 여부를 읽지 못함 — ${day.reason}`,
        { mode: state.mode, region: day.region, hours: h, rooms: day.rooms?.length });
    } else {
      if (isCar()) {
        const note = day.roomSource === 'table' ? ' · 그날 신청된 차량만 표시됨' : '';
        setStatus(`차량 ${day.rooms.length}대 · 이용 ${day.reservations.length}건${note}`);
      } else {
        const other = day.reservationsAllRegions.length - day.reservations.length;
        const otherNote = other > 0 ? ` · 다른 지역 ${other}건 숨김` : '';
        setStatus(`${day.region} · 회의실 ${day.rooms.length}곳 · 예약 ${day.reservations.length}건${otherNote}`);
      }
    }
  } catch (err) {
    if (sequence !== loadSequence) return;
    // 미리 훑어 둔 화면은 지우지 않는다. 빈 화면보다 **언제 읽은 것인지 밝힌** 현황이 낫다.
    if (!preview) {
      el.grid.innerHTML = '';
      el.roomCount.textContent = '';
      state.day = null;
    }
    const stale = preview ? ` — 화면은 ${agoText(preview.readAt)} 미리 훑어 둔 것입니다.` : '';
    logEvent('load', false, `${isCar() ? '차량' : '회의실'} ${date} 조회 실패: ${err.message}`,
      { mode: state.mode, region: state.region, hours: h, auth: err instanceof AuthError, preview: !!preview });
    if (err instanceof AuthError) {
      setStatusHtml(`${err.message}${escapeHtml(stale)} <a href="#" id="openLogin">eclass 열기</a>`, 'error');
      openSiteOn('openLogin');
    } else {
      setStatus(`조회 실패: ${err.message}${stale}`, 'error');
    }
  } finally {
    if (sequence === loadSequence) {
      el.refresh.disabled = false;
      el.refresh.classList.remove('spin');
      // 조회가 실패해 미리 훑어 둔 화면만 남았으면 잠근 채 둔다. 사이트 화면 손잡이가 없어
      // 여기서 고른 칸은 예약으로 보낼 수 없다 — 고를 수 있게 해 놓고 거절하면 더 나쁘다.
      el.grid.setAttribute('aria-busy', String(!!state.day && !state.day.doc));
      paintStamp();
    }
  }
}

/**
 * 예약이 안 됐을 때 무엇이 어긋났는지 작은 요약으로 만든다. 활동 기록과 원인 분석이 같이 쓴다.
 *
 * 응답 HTML 을 통째로 받아 적으면 100KB 가 넘는데 그중 쓸모 있는 건
 * **보낸 값과 응답에 남은 값의 차이** 뿐이다(2026-09-16 의 날짜 어긋남도 이걸로 찾았다).
 */
function saveDigest(payload, result) {
  if (!result.responseHtml) return null;
  try {
    return buildSaveDigest(result.responseHtml, result.baselineHtml, result.requestFields, payload);
  } catch {
    return null;
  }
}

/**
 * 왜 안 됐는지 Claude 에게 물어본다.
 *
 * 예약이 됐는지 자체는 이미 재조회로 판정했다. 여기서는 **이유만** 읽는다.
 * 모델 판단이 결정적 검증을 덮어쓰지 않도록 하기 위해서다.
 * @returns {Promise<{result: object, via: string} | null>}
 */
async function explainFailure(digest) {
  if (!digest) return null;
  if (!state.cli && !state.apiKey) return null;
  try {
    return await diagnoseSmart(digest, { apiKey: state.apiKey, useNative: state.cli });
  } catch {
    return null;
  }
}

/** 선택 목록의 한 줄에 진행 상태를 표시한다. */
function markPick(i, mark, cls) {
  const li = el.pickList.querySelector(`li[data-i="${i}"]`);
  if (!li) return;
  li.classList.remove('done', 'fail');
  if (cls) li.classList.add(cls);
  const m = li.querySelector('[data-mark]');
  if (m) m.textContent = mark;
}

/**
 * 고른 선택을 하나씩 예약한다.
 *
 * 한 건 넣을 때마다 ViewState 가 바뀌므로 다음 건은 새로 조회한 화면으로 보낸다.
 * 중간에 실패해도 앞서 성공한 건은 그대로 남는다 — 그래서 결과를 건별로 보여준다.
 */
async function submitBooking() {
  if (!state.day || !state.picks.length) return;
  if (needsLiveDay()) return;

  const title = el.title.value.trim();
  // 차량은 사이트가 **행선지**를 요구하고 사용목적은 요구하지 않는다(실제 신청 폼 캡처로 확인).
  // 회의실은 반대로 회의주제가 있어야 한다. 사이트보다 엄격하게 막으면 사이트에서는
  // 되는 일이 이 확장에서만 안 된다.
  if (isCar()) {
    if (!el.place.value.trim()) {
      setStatus('행선지를 입력하세요. 사이트가 반드시 요구합니다.', 'error');
      el.place.focus();
      return;
    }
  } else if (!title) {
    setStatus('회의주제를 입력하세요.', 'error');
    el.title.focus();
    return;
  }

  const jobs = state.picks.filter((p) => p.kind !== 'cancel').map((p) => pickToPayload(p, title));
  el.submit.disabled = true;
  el.refresh.disabled = true;

  const failed = [];
  let done = 0;

  try {
    for (let i = 0; i < jobs.length; i++) {
      const payload = jobs[i];
      setStatus(`예약 중 ${i + 1}/${jobs.length} — ${payload.room} ${payload.start}~${payload.end}`);
      markPick(i, '⏳');

      let result;
      try {
        result = await submitOne(payload);
      } catch (err) {
        result = { ok: false, submitted: false, message: err.message };
      }

      const what = `${payload.room} ${payload.date} ${payload.start}~${payload.end}`;
      if (result.ok && result.verified) {
        done++;
        markPick(i, '✓', 'done');
        logEvent('reserve', true, what,
          { payload, message: result.message || undefined, owner: result.record?.owner || result.who?.name });
        rememberBooked([{
          mode: state.mode, date: payload.date, room: payload.room,
          start: parseInt(payload.start, 10) * 60 + +payload.start.slice(3),
          end: parseInt(payload.end, 10) * 60 + +payload.end.slice(3),
          at: Date.now(),
        }]);
        // 사이트는 로그인한 사람의 이름을 어디에도 적어주지 않는다. 확인된 내 예약 행이
        // 그 이름을 알 수 있는 유일한 자리다. 회의주제까지 같을 때만 내 것으로 본다
        // (제출 사이에 남이 같은 칸을 채간 경우와 섞이면 안 된다).
        // 차량 신청 폼은 로그인한 사람의 이름을 아예 적어서 내려준다. 추측할 필요가 없다.
        if (result.who?.name) {
          rememberName(result.who.name);
        } else if (result.record?.owner && result.record.title === payload.title) {
          rememberName(result.record.owner);
        }
      } else {
        const digest = saveDigest(payload, result);
        failed.push({ payload, result, digest });
        markPick(i, result.submitted ? '⚠' : '✕', 'fail');
        logEvent('reserve', false,
          `${what} — ${result.submitted ? '제출했지만 확인 못 함' : '실패'}: ${result.message}`,
          { payload, submitted: !!result.submitted, verified: result.verified, message: result.message, digest });
      }

      // 다음 건은 새 화면으로 보낸다(방금 넣은 예약도 반영된다)
      if (i < jobs.length - 1) {
        try {
          state.day = await reloadDay();
        } catch {
          // 다음 건에서 실패로 잡힌다
        }
      }
    }
  } finally {
    el.submit.disabled = false;
    el.refresh.disabled = false;
  }

  const only = failed[0];
  let detail = '';
  if (only) {
    setStatus('예약이 안 된 이유를 확인하는 중...');
    state.lastFailure = { payload: only.payload, result: only.result };
    const out = await explainFailure(only.digest);
    const found = out?.result;
    if (found) {
      const tag = { rejected: '사이트 거부', maybe_saved: '저장됐을 수 있음', unknown: '원인 불분명' }[found.verdict] || '';
      detail = ` — ${tag}: ${found.cause}` +
        (found.siteMessage ? ` (사이트 문구: "${found.siteMessage}")` : '') +
        (found.fix ? ` → ${found.fix}` : '');
      logEvent('diagnose', true, `${only.payload.room} ${only.payload.date}${detail}`, { via: out.via, ...found });
    }
  }

  // 넣은 날은 담아 둔 현황이 낡았다. 버려서 다음에 볼 때 다시 읽게 한다.
  forgetDays([...new Set(jobs.map((j) => j.date))], [state.mode === 'car' ? 'car' : 'room']);

  // 결과를 먼저 쓰면 아래 조회가 덮어버린다. 새로고침을 끝내고 나서 말한다.
  if (!failed.length) state.picks = [];
  await load();

  if (!failed.length) {
    setStatus(`${done}건 예약 확인됨`);
  } else if (only.result.submitted) {
    setStatusHtml(
      `${done}건 완료 · ⚠ ${failed.length}건은 제출됐지만 확인 못 함. ${escapeHtml(only.result.message)}${escapeHtml(detail)} ` +
      '<a href="#" id="openSite">사이트에서 확인</a>',
      'error',
    );
    openSiteOn('openSite');
  } else {
    setStatusHtml(
      `${done}건 완료 · ${failed.length}건 실패. ${escapeHtml(only.result.message)}${escapeHtml(detail)} ` +
      '<a href="#" id="openSite">사이트에서 예약</a>',
      'error',
    );
    openSiteOn('openSite');
  }
}

/** 지역은 버튼 하나로 돌려가며 바꾼다. 목록은 페이지에서 읽어온다. */
function fillRegions(day) {
  if (day.regions?.length) state.regions = day.regions;
  if (day.region) state.region = day.region;
  paintRegion();
}

function paintRegion() {
  el.region.textContent = state.region || '지역';
  const next = nextRegion();
  el.region.title = next ? `클릭하면 ${next} 로 바뀝니다` : '클릭하면 지역이 바뀝니다';
}

function nextRegion() {
  const list = state.regions;
  if (list.length < 2) return null;
  const i = list.indexOf(state.region);
  return list[(i + 1) % list.length];
}

/**
 * 옆 칸을 기존 예약과 같은 제목으로 한 건 더 예약한다.
 *
 * 사이트에는 예약 시간을 늘리는 기능이 없다. 그래서 기존 건은 건드리지 않고
 * **추가 예약**을 넣는다. 제목만 자동으로 가져오므로 누르면 바로 끝난다.
 */
async function extendBooking() {
  const target = state.extendTarget;
  const pick = state.picks.find((p) => p.kind !== 'cancel');
  if (!target || !pick || !state.day) return;
  if (needsLiveDay()) return;

  const row = state.day.grid[pick.room];
  const addStart = row.slots[pick.from].start;
  const addEnd = row.slots[pick.to].end;
  const merged = { start: Math.min(target.start, addStart), end: Math.max(target.end, addEnd) };
  const title = target.title || el.title.value.trim();

  if (!canDelete(target.del)) {
    setStatus('기존 예약의 삭제 정보를 찾지 못해 이어붙일 수 없습니다. 사이트에서 수정해 주세요.', 'error');
    return;
  }

  const mk = (from, to) => ({
    room: row.room.name,
    roomValue: row.room.value,
    region: state.day.region,
    date: state.day.date,
    start: fmtTime(from),
    end: fmtTime(to),
    title,
  });

  el.extend.disabled = true;
  el.submit.disabled = true;
  el.refresh.disabled = true;
  forgetDays([state.day.date], ['room']);

  let result;
  try {
    // 사이트는 시간이 1분이라도 겹치면 받지 않는다. 기존 건을 먼저 비우고 합친 범위로 새로 넣는다.
    // 순서와 되돌리기는 src/modify.js 에 맡긴다 — 이어붙이기와 수정이 같은 규칙을 쓴다.
    // 특히 **새 예약이 제출은 됐는데 확인이 안 될 때는 되돌리지 않는다**(이중 예약 방지).
    result = await modifyReservation({
      onStage: (stage) => setStatus({
        cancel: `기존 ${fmtTime(target.start)}~${fmtTime(target.end)} 취소 중...`,
        reserve: `${fmtTime(merged.start)}~${fmtTime(merged.end)} 로 다시 예약 중...`,
        restore: '이어붙이기에 실패해 원래 예약을 되살리는 중...',
      }[stage] || '', stage === 'restore' ? 'error' : ''),

      cancel: () => cancelReservation(target, state.day),
      reserve: async () => {
        state.day = await loadDay(state.day.date, hours(), state.region);
        return reserve(mk(merged.start, merged.end), state.day);
      },
      restore: async () => {
        state.day = await loadDay(state.day.date, hours(), state.region);
        return reserve(mk(target.start, target.end), state.day);
      },
    });

    logEvent('extend', result.ok,
      `${row.room.name} ${state.day.date} ${fmtTime(target.start)}~${fmtTime(target.end)} → ` +
      `${fmtTime(merged.start)}~${fmtTime(merged.end)}${result.ok ? '' : ` — ${result.message}`}`,
      { title, outcome: modifyOutcome(result) });
    if (result.ok) {
      rememberBooked([{ mode: state.mode, date: state.day.date, room: row.room.name, start: merged.start, end: merged.end, at: Date.now() }]);
    }
    state.picks = [];
    await load();

    if (result.ok) {
      setStatus(`${fmtTime(merged.start)}~${fmtTime(merged.end)} 로 이어붙였습니다`);
    } else {
      const said = describeModifyResult(result);
      if (said.needsSiteCheck) {
        setStatusHtml(`${escapeHtml(said.text)} <a href="#" id="openSite">사이트에서 확인</a>`, 'error');
        openSiteOn('openSite');
      } else {
        setStatus(said.text, said.kind || 'error');
      }
    }
  } catch (err) {
    setStatus(`이어붙이기 실패: ${err.message}`, 'error');
    logEvent('extend', false, `${row.room.name} 이어붙이기 실패: ${err.message}`, { outcome: modifyOutcome(result) });
  } finally {
    el.extend.disabled = false;
    el.submit.disabled = false;
    el.refresh.disabled = false;
  }
}


/**
 * 내 예약 목록에서 한 건을 취소한다.
 *
 * 격자와 달리 여기서는 날짜가 제각각이라, 그 건이 있는 날을 먼저 불러와서
 * **그 화면의 ViewState 로** 삭제를 보낸다. 다른 날 화면으로 보내면 먹지 않는다.
 */
async function cancelFromMine(index) {
  const it = state.mine?.[index];
  if (!canDelete(it?.record?.del)) return;

  const when = `${it.from.date} ${fmtTime(it.from.minutes)}~${fmtTime(it.to.minutes)}`;
  el.refresh.disabled = true;
  setStatus(`취소 중... ${it.room} ${when}`);

  try {
    const car = it.kind === 'car';
    const day = car
      ? await loadCarDay(it.from.date, DEFAULT_HOURS)
      : await loadDay(it.from.date, DEFAULT_HOURS, it.region || state.region);
    const rec = findLiveRecord(day, it) || it.record;

    const r = car ? await cancelCarReservation(rec, day) : await cancelReservation(rec, day);
    logEvent('cancel', r.ok, `${it.room} ${when}${r.ok ? '' : ` — ${r.message}`}`,
      { from: 'mine', kind: it.kind, title: it.title, submitted: r.submitted, message: r.message || undefined });
    forgetDays([it.from.date]);
    if (r.ok) {
      state.justBooked = state.justBooked.filter((b) =>
        !(b.date === it.from.date && b.room === it.room && b.start < it.to.minutes && b.end > it.from.minutes));
      chrome.storage.local.set({ justBooked: state.justBooked });
      await load();
      setStatus(`취소 확인됨: ${it.room} ${when}`);
    } else {
      setStatusHtml(`${escapeHtml(r.message)} <a href="#" id="openSite">사이트에서 확인</a>`, 'error');
      openSiteOn('openSite');
    }
  } catch (err) {
    setStatus(`취소 실패: ${err.message}`, 'error');
    logEvent('cancel', false, `${it.room} ${when} — ${err.message}`, { from: 'mine', kind: it.kind });
  } finally {
    el.refresh.disabled = false;
  }
}

/** 고른 내 예약을 취소한다. */
async function cancelPicked() {
  const cancels = state.picks.filter((p) => p.kind === 'cancel');
  if (!cancels.length || !state.day) return;
  if (needsLiveDay()) return;
  forgetDays([state.day.date], [isCar() ? 'car' : 'room']);

  el.cancelBtn.disabled = true;
  el.refresh.disabled = true;
  let done = 0;
  let failMsg = '';

  try {
    for (let i = 0; i < cancels.length; i++) {
      const p = cancels[i];
      setStatus(`취소 중 ${i + 1}/${cancels.length}...`);
      const rec = p.record || {};
      const what = `${rec.room || rec.name || '?'} ${state.day.date} ${fmtTime(rec.start)}~${fmtTime(rec.end)}`;
      let r;
      try {
        r = await cancelOne(p.record, state.day);
      } catch (err) {
        logEvent('cancel', false, `${what} — ${err.message}`, { from: 'grid', mode: state.mode });
        throw err;
      }
      logEvent('cancel', r.ok, `${what}${r.ok ? '' : ` — ${r.message}`}`,
        { from: 'grid', mode: state.mode, title: rec.title, submitted: r.submitted, message: r.message || undefined });
      if (r.ok) {
        done++;
      } else {
        failMsg = r.message;
        break;
      }
      if (i < cancels.length - 1) {
        try {
          state.day = await reloadDay();
        } catch { /* 다음 건에서 잡힌다 */ }
      }
    }
  } finally {
    el.cancelBtn.disabled = false;
    el.refresh.disabled = false;
  }

  state.picks = [];
  await load();

  if (failMsg) {
    setStatusHtml(`${done}건 취소 · ${escapeHtml(failMsg)} <a href="#" id="openSite">사이트에서 확인</a>`, 'error');
    openSiteOn('openSite');
  } else {
    setStatus(`${done}건 취소 확인됨`);
  }
}


/* --------------------------------------------------------------- 수정 */

/**
 * 살아 있는 화면에서 그 예약의 **지금** 기록을 찾는다.
 *
 * 삭제는 그 화면의 ViewState 손잡이(fn_del 의 idx)로 보낸다. 담아 둔 기록의 idx 는
 * 낡았을 수 있으므로, 지울 때는 방금 읽은 화면에서 같은 자리를 다시 찾아 쓴다.
 */
function findLiveRecord(day, it) {
  const from = it.from?.minutes ?? it.start;
  const to = it.to?.minutes ?? it.end;
  return day.reservations.find((r) =>
    (r.room === it.room || r.name === it.room) &&
    r.start < to && r.end > from && canDelete(r.del)) || null;
}

/** 차량/회의실 목록에서 이름으로 값(CARIDX 또는 회의실 값)을 찾는다. */
function rowValueOf(name) {
  const hit = (state.day?.rooms || []).find((r) => r.name === name || r.value === name);
  return hit ? hit.value : null;
}

/**
 * 수정을 시작한다. **사이트에는 예약을 옮기는 기능이 없다** — 취소하고 다시 넣는 수밖에 없다.
 * 그래서 되돌릴 수 있게 만들어 두고, 새 시간은 평소처럼 격자에서 고르게 한다.
 */
function startEdit(index) {
  const it = state.mine?.[index];
  if (!canDelete(it?.record?.del)) return;

  const mode = it.kind === 'car' ? 'car' : 'room';
  el.date.value = it.from.date;
  applyMode(mode).then(() => {
    state.editTarget = {
      kind: mode,
      record: it.record,
      date: it.from.date,
      room: it.room,
      region: it.region || state.region,
      title: it.title || '',
      start: it.from.minutes,
      end: it.to.minutes,
    };
    el.title.value = it.title || '';
    paintEditNote();
    setStatus(`수정할 새 시간을 고르세요 — 지금은 ${it.room} ${fmtTime(it.from.minutes)}~${fmtTime(it.to.minutes)} 입니다.`);
  });
}

function cancelEdit() {
  state.editTarget = null;
  paintEditNote();
  paintPicks();
}

/**
 * 수정 중이라는 것과 **무슨 일이 벌어지는지**를 적어 둔다.
 * 취소가 먼저 일어나므로, 누르기 전에 그 사실을 알아야 한다.
 */
function paintEditNote() {
  const t = state.editTarget;
  el.editNote.classList.toggle('hidden', !t);
  if (!t) return;
  el.editNote.innerHTML =
    `<strong>수정 중</strong> · ${escapeHtml(t.room)} ${fmtTime(t.start)}~${fmtTime(t.end)}<br>` +
    '새 시간을 고르고 누르면 <b>기존 예약을 취소한 뒤 그 시간으로 다시 넣습니다.</b> ' +
    '다시 넣기가 실패하면 원래대로 되돌립니다.' +
    (t.kind === 'car'
      ? '<br>차량 목록에는 <b>행선지가 남지 않습니다</b> — 행선지를 다시 입력해 주세요. 되돌릴 때도 이 값을 씁니다.'
      : '');
}

/**
 * 취소 → 재예약. 순서와 되돌리기는 src/modify.js 가 쥐고 있고 여기서는 세 가지 일만 넘긴다.
 *
 * 매번 **그 날짜의 살아 있는 화면**을 다시 읽어서 넘기는 것이 중요하다.
 * 삭제도 저장도 그 화면의 ViewState 로만 먹는다.
 */
async function runModify() {
  const t = state.editTarget;
  const pick = state.picks.find((p) => p.kind !== 'cancel');
  if (!t || !pick || !state.day) return;
  if (needsLiveDay()) return;

  const title = el.title.value.trim() || t.title;
  const next = pickToPayload(pick, title);

  if (t.kind === 'car' && !el.place.value.trim()) {
    setStatus('행선지를 입력하세요. 되돌릴 때도 이 값을 씁니다.', 'error');
    el.place.focus();
    return;
  }

  // 되돌릴 값은 **원래 자리, 원래 시간** 이다. 다른 회의실/차량을 골랐을 수 있다.
  const backValue = rowValueOf(t.room);
  if (backValue == null) {
    setStatus(`원래 예약이 있던 ${t.room} 을(를) 지금 목록에서 찾지 못해 수정을 시작하지 않습니다. `
      + '되돌릴 수 없는 상태로 취소부터 하면 예약을 잃게 됩니다.', 'error');
    return;
  }
  const back = {
    ...next,
    room: t.room,
    car: t.room,
    roomValue: backValue,
    carValue: backValue,
    date: t.date,
    start: fmtTime(t.start),
    end: fmtTime(t.end),
    title: t.title || title,
  };

  const busy = (on) => {
    el.modify.disabled = on;
    el.submit.disabled = on;
    el.refresh.disabled = on;
  };
  busy(true);
  forgetDays([...new Set([t.date, next.date])], [t.kind]);

  let result;
  try {
    result = await modifyReservation({
      onStage: (stage) => setStatus({
        cancel: `기존 ${t.room} ${fmtTime(t.start)}~${fmtTime(t.end)} 취소 중...`,
        reserve: `${next.start}~${next.end} 로 다시 예약 중...`,
        restore: '다시 예약하지 못해 원래 예약을 되살리는 중...',
      }[stage] || '', stage === 'restore' ? 'error' : ''),

      cancel: async () => {
        state.day = await reloadDay(t.date);
        return cancelOne(findLiveRecord(state.day, t) || t.record, state.day);
      },
      reserve: async () => {
        state.day = await reloadDay(next.date);
        return submitOne(next);
      },
      restore: async () => {
        state.day = await reloadDay(t.date);
        return submitOne(back);
      },
    });
  } finally {
    busy(false);
  }
  logEvent('modify', result.ok,
    `${t.room} ${t.date} ${fmtTime(t.start)}~${fmtTime(t.end)} → ${next.room} ${next.date} ${next.start}~${next.end}` +
    (result.ok ? '' : ` — ${result.message}`),
    { kind: t.kind, title, outcome: modifyOutcome(result) });

  state.picks = [];
  state.editTarget = null;
  paintEditNote();
  await load();

  if (result.ok) {
    rememberBooked([{
      mode: state.mode, date: next.date, room: next.room,
      start: state.day.grid[pick.room].slots[pick.from].start,
      end: state.day.grid[pick.room].slots[pick.to].end,
      at: Date.now(),
    }]);
    setStatus(`수정 확인됨: ${next.room} ${next.start}~${next.end}`);
    return;
  }

  const said = describeModifyResult(result);
  if (said.needsSiteCheck) {
    setStatusHtml(`${escapeHtml(said.text)} <a href="#" id="openSite">사이트에서 확인</a>`, 'error');
    openSiteOn('openSite');
  } else {
    setStatus(said.text, said.kind || 'error');
  }
}

/* ------------------------------------------------------- 자연어 찾기 */

/** 로컬 Claude CLI 다리가 연결돼 있는지 확인해 배지에 보여준다. */
async function checkCli() {
  el.cliState.textContent = '확인 중';
  el.cliState.className = 'badge';
  state.cli = await nativeAvailable();
  el.cliState.textContent = state.cli ? '연결됨' : '없음';
  el.cliState.className = `badge ${state.cli ? 'on' : 'off'}`;
  paintAskReady();
  // 패널을 열 때마다 확인하므로, 상태가 바뀔 때만 남긴다.
  logEvent('cli', state.cli, state.cli ? '로컬 Claude 다리 연결됨' : '로컬 Claude 다리 없음', undefined,
    { onlyIfChanged: true });
}

const ASK_PLACEHOLDER = '말로 찾는 회의실/차량';
const ASK_OFF_TEXT = 'claude가 연결되지 않았습니다';
const ASK_OFF_HINT = 'native/install.ps1 로 다리를 등록하거나, 아래 설정에 API 키를 넣으면 쓸 수 있습니다';

/**
 * 말로 찾기는 Claude 가 문장을 읽어준다는 전제 위에 서 있다.
 * 붙을 곳(로컬 CLI·API 키)이 하나도 없으면 눌러도 헛일이라 칸을 잠그고, 왜 잠겼는지
 * 플레이스홀더에 적는다 — 적어 넣고 눌렀는데 아무 일도 일어나지 않는 편보다 낫다.
 */
function paintAskReady() {
  const ready = state.cli || !!state.apiKey;
  el.ask.disabled = !ready;
  el.askGo.disabled = !ready || state.asking;
  document.querySelector('.ask')?.classList.toggle('off', !ready);
  el.ask.placeholder = ready ? ASK_PLACEHOLDER : ASK_OFF_TEXT;
  el.ask.title = ready
    ? (isCar() ? '예) 내일 오후 2시부터 3시간 쓸 차량' : '예) 내일 오후 2시, 8명이 쓸 회의실')
    : ASK_OFF_HINT;
}

const VIA_LABEL = { cli: '로컬 CLI', api: 'API 키', local: '규칙 해석' };

const isCar = () => state.mode === 'car';
const isMineMode = () => state.mode === 'mine';

/** 내가 넣은 예약을 며칠간 기억한다. 지난 날짜는 버린다. */
const BOOKED_KEEP_DAYS = 30;

function pruneBooked(list) {
  const cut = new Date();
  cut.setDate(cut.getDate() - BOOKED_KEEP_DAYS);
  const cutStr = `${cut.getFullYear()}-${String(cut.getMonth() + 1).padStart(2, '0')}-${String(cut.getDate()).padStart(2, '0')}`;
  return (list || []).filter((b) => b.date >= cutStr).slice(-200);
}

function rememberBooked(entries) {
  state.justBooked = pruneBooked([...state.justBooked, ...entries]);
  chrome.storage.local.set({ justBooked: state.justBooked });
}

/**
 * 내 예약에 표시를 단다.
 *
 * 사이트는 본인 예약에만 수정/삭제 버튼을 붙이는데, 승인 전이라 그 버튼이 없거나
 * 화면이 달라 못 잡을 수 있다. 그러면 내가 넣고도 남의 예약처럼 보인다.
 * 그래서 넣은 기록(justBooked)과 내 이름도 같이 본다 — src/mine.js 와 같은 신호다.
 */
function markMine(day) {
  let changed = false;
  for (const r of day.reservations) {
    const hit = state.justBooked.find((b) =>
      b.mode === state.mode && b.date === day.date && b.room === r.room &&
      b.start < r.end && b.end > r.start);
    if (hit) r.fresh = true;
    if (r.mine) continue;
    if (hit || (state.myName && sameName(r.owner, state.myName))) {
      r.mine = true;
      changed = true;
    }
  }
  if (changed) {
    day.grid = buildGrid(day.rooms, day.reservations, hours(), { confident: day.confident });
  }
  // 격자에도 '방금' 표시를 옮긴다
  for (const row of day.grid) {
    const mine = day.reservations.filter((r) => r.room === row.room.name || r.room === row.room.value);
    for (const slot of row.slots) {
      const hit = mine.find((r) => r.fresh && r.start < slot.end && r.end > slot.start);
      if (hit) slot.fresh = true;
    }
  }
  return day;
}

/**
 * 탭 상태를 화면에 적용하고 다시 조회한다.
 * 같은 모드여도 그대로 진행한다 — 시작할 때 저장된 모드를 입히는 데도 쓰기 때문이다.
 */
function applyMode(mode) {
  state.mode = mode;
  state.picks = [];
  state.day = null;
  state.mine = [];

  const car = isCar();
  const mineTab = isMineMode();
  for (const [tab, on] of [[el.tabRoom, !car && !mineTab], [el.tabCar, car], [el.tabMine, mineTab]]) {
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
  }

  const pageName = car ? '차량 이용' : '회의실 예약';
  el.appTitle.innerHTML = (mineTab ? '내 예약' : pageName) + '<span class="title-dot">.</span>';
  const openLabel = `${pageName} 페이지를 새 탭에서 열기`;
  el.openPageInline.title = openLabel;
  el.openPageInline.setAttribute('aria-label', openLabel);
  el.scheduleTitle.childNodes[0].nodeValue =
    mineTab ? '내 예약 ' : car ? '차량 현황 ' : '회의실 현황 ';
  document.querySelector('.selection-hint').textContent =
    mineTab ? '누르면 그 날짜로 갑니다' : '빈 시간을 눌러 예약하세요';

  // 차량 신청 칸(행선지·동승자)은 차량 탭에서만 뜻이 있다.
  el.carFields.classList.toggle('hidden', !car);
  el.lblTitle.textContent = car ? '사용목적' : '회의 주제';
  el.title.placeholder = car ? '예) 고객사 방문 (선택)' : '예) 주간 업무회의';
  el.booking.classList.add('hidden');
  el.editNote.classList.add('hidden');
  state.editTarget = null;
  el.region.hidden = car || mineTab;
  // 말로 찾기는 회의실·차량 둘 다 쓴다. 내 예약은 이미 지난 것을 보는 화면이라 뜻이 없다.
  document.querySelector('.ask')?.toggleAttribute('hidden', mineTab);
  // 칸 하나에 로고·입력·버튼이 한 줄로 들어가느라 제목 줄이 없다.
  // 그래서 플레이스홀더가 제목 몫을 하고, 탭별 예문은 툴팁으로 내린다.
  paintAskReady();

  // 내 예약은 날짜를 여러 날 훑는다. 시간대·자동 갱신은 뜻이 없고 기간이 필요하다.
  document.querySelector('.hours-control')?.toggleAttribute('hidden', mineTab);
  document.querySelector('.auto')?.toggleAttribute('hidden', mineTab);
  el.spanControl?.toggleAttribute('hidden', !mineTab);
  el.grid.classList.toggle('hidden', mineTab);
  el.mineWrap.classList.toggle('hidden', !mineTab);

  chrome.storage.local.set({ mode });
  return load();
}

/** 탭 클릭. 이미 그 모드면 아무것도 하지 않는다. */
function setMode(mode) {
  if (state.mode === mode) return;
  applyMode(mode);
}

/* ------------------------------------------------------------ 내 예약 */

const WHY_LABEL = { name: '이름 일치', booked: '내가 넣음' };

/** 내 이름을 기억한다. 내 예약 판정에 쓴다. */
function rememberName(name) {
  const value = String(name || '').trim();
  if (!value || value === state.myName) return;
  state.myName = value;
  el.myName.value = value;
  chrome.storage.local.set({ myName: value });
}

/**
 * 내 예약 한 줄의 취소·수정 버튼. 회의실과 차량이 같다.
 *
 * 둘 다 삭제 손잡이(행의 취소 버튼 또는 fn_del 번호)가 있어야 누를 수 있다. 없으면 **왜 못 누르는지**를
 * 버튼에 적어 둔다 — 눌렀는데 아무 일도 없으면 고장난 줄 안다.
 */
function mineRowButtons(it, i) {
  if (!canDelete(it.record?.del)) {
    const why = '삭제 정보를 찾지 못했습니다. 사이트에서 해주세요';
    return `<button class="mi-cancel" disabled title="${why}">취소</button>`;
  }
  return `<button class="mi-edit ghost small" data-edit="${i}" title="취소하고 새 시간으로 다시 넣습니다">수정</button>`
    + `<button class="mi-cancel" data-cancel="${i}" title="이 예약을 취소합니다">취소</button>`;
}

function renderMine(items, note) {
  state.mine = items;
  el.roomCount.textContent = String(items.length);
  el.roomCount.title = note;
  el.mineEmpty.classList.toggle('hidden', items.length > 0);

  el.mineList.innerHTML = items.map((it, i) => {
    const sameDay = it.from.date === it.to.date;
    const when = sameDay
      ? `${dayLabel(it.from.date)} ${fmtTime(it.from.minutes)}~${fmtTime(it.to.minutes)}`
      : `${shortLabel(it.from.date)} ${fmtTime(it.from.minutes)} ~ ${shortLabel(it.to.date)} ${fmtTime(it.to.minutes)}`;
    const why = WHY_LABEL[it.why] || '';
    return `<li data-i="${i}" title="누르면 ${escapeHtml(it.from.date)} 로 이동합니다">` +
      `<span class="mi-kind ${it.kind}">${it.kind === 'car' ? '차량' : '회의실'}</span>` +
      '<span class="mi-main">' +
        `<span class="mi-when${sameDay ? '' : ' mi-span'}">${escapeHtml(when)}</span>` +
        (it.status ? `<span class="mi-status">${escapeHtml(it.status)}</span>` : '') +
        '<span class="mi-sub">' +
          `<span class="mi-room">${escapeHtml(it.room)}</span>` +
          (it.title ? `<span class="mi-title">${escapeHtml(it.title)}</span>` : '') +
        '</span>' +
      '</span>' +
      (why ? `<span class="mi-why" title="이 건을 내 것으로 본 근거">${why}</span>` : '') +
      mineRowButtons(it, i) +
      '</li>';
  }).join('');
}

/**
 * 고른 날부터 한 달(고른 기간)간 내 예약만 모은다.
 *
 * 직접 훑지 않고 **세 탭이 함께 쓰는 캐시**에 그 날짜들을 채워 달라고 한다. 패널이 열릴 때
 * 이미 한 달을 미리 훑어 두므로 보통은 기다릴 것이 없다. 아직 훑는 중이면 담기는 대로
 * 목록이 차오른다 — 서른 날을 다 기다린 뒤에야 첫 줄이 보이면 아무것도 안 하는 것처럼 보인다.
 *
 * **못 읽은 날은 결과에서 빼고 몇 일이 빠졌는지 말한다.** 못 읽은 날을 조용히 넘기면
 * "내 예약이 없다"는 거짓말이 된다.
 */
async function loadMine(sequence, { force = false } = {}) {
  const start = el.date.value || todayStr();
  const dates = datesFrom(start, spanDays());
  const span = `${shortLabel(start)}~${shortLabel(addDays(start, spanDays() - 1))}`;

  el.mineWrap.setAttribute('aria-busy', 'true');
  el.refresh.disabled = true;
  el.refresh.classList.add('spin');

  /** 지금까지 담긴 것만으로 목록을 그린다. 훑는 동안 여러 번 불린다. */
  const paint = () => {
    const got = collectMine(store.list(dates), { name: state.myName, booked: state.justBooked });
    renderMine(got.items, `${span} 내 예약 ${got.items.length}건`);
    state.loadedAt = store.oldest(dates);
    paintStamp();
    return got;
  };

  setStatus(store.covers(dates) ? '미리 훑어 둔 내 예약입니다.' : '내 예약을 찾는 중...');
  paint();

  const off = onScanDay(() => { if (sequence === loadSequence) paint(); });
  let scan;
  try {
    scan = await ensureDays(dates, { force });
  } finally {
    off();
  }
  if (sequence !== loadSequence) return;

  el.mineWrap.setAttribute('aria-busy', 'false');
  el.refresh.disabled = false;
  el.refresh.classList.remove('spin');

  // 한 날도 못 읽었는데 로그인이 끊긴 것이면, 목록이 아니라 그 사실을 보여줘야 한다.
  const read = store.list(dates);
  if (scan.authError && !read.length) {
    el.mineList.innerHTML = '';
    el.mineEmpty.classList.add('hidden');
    el.roomCount.textContent = '';
    setStatusHtml(`${scan.authError.message} <a href="#" id="openLogin">eclass 열기</a>`, 'error');
    openSiteOn('openLogin');
    return;
  }

  const { items, skipped } = paint();

  // 회의실·차량을 따로 훑으므로 못 읽은 기록은 한 날에 둘까지 나온다. 날짜 수로 센다.
  const skippedDates = new Set(skipped.map((s) => s.date));
  const unread = dates.filter((d) => !store.get('room', d) || !store.get('car', d));
  const parts = [`${span} · ${dates.length}일 훑음 · 내 예약 ${items.length}건`];
  if (!state.myName) parts.push('이름을 넣으면 더 정확합니다');
  if (skippedDates.size) parts.push(`⚠ ${skippedDates.size}일은 확인 불가라 제외`);
  if (unread.length) parts.push(`⚠ ${unread.length}일은 아예 읽지 못했습니다`);
  parts.push(...scan.failed);
  const bad = skippedDates.size || unread.length || scan.failed.length;
  setStatus(parts.join(' · '), bad ? 'error' : '');
}

/** 목록에서 한 건을 누르면 그 날짜·종류 화면으로 간다. */
function openMineItem(i) {
  const it = state.mine[i];
  if (!it) return;
  el.date.value = it.from.date;
  applyMode(it.kind === 'car' ? 'car' : 'room');
}

function setAskNote(msg, kind = '') {
  el.askNote.className = `ask-note ${kind}`;
  el.askNote.textContent = msg;
}

function renderFound(found, skipped, kind = 'room') {
  state.found = found;
  state.foundKind = kind;
  if (!found.length) {
    el.askList.innerHTML = '';
    return;
  }
  const car = kind === 'car';
  el.askList.innerHTML = found.slice(0, 40).map((r, i) => {
    const seat = r.room.seats ? `<span class="ak-seat">${r.room.seats}석</span>` : '';
    const md = r.date.slice(5).replace('-', '/');
    return `<li data-i="${i}" title="누르면 그 날로 옮겨 이 칸을 골라 둡니다">` +
      `<span class="ak-date">${md}</span>` +
      `<span class="ak-room">${escapeHtml(r.room.label || r.room.name)}</span>` +
      (car ? '<span class="ak-kind">차량</span>' : seat) +
      `<span class="ak-time">${r.label}</span></li>`;
  }).join('');
  void skipped;
}

async function runAsk() {
  // Claude 가 없으면 칸이 잠겨 있다. 엔터로도 들어오지 못하게 여기서도 막는다.
  if (el.ask.disabled) return;
  const text = el.ask.value.trim();
  if (!text) return;

  // 물어본 탭을 붙잡아 둔다. 찾는 동안 탭을 옮겨도 결과는 물어본 곳 것이고,
  // 누를 때 그 탭으로 도로 옮겨 준다.
  const kind = isCar() ? 'car' : 'room';

  state.asking = true;
  el.askGo.disabled = true;
  el.askList.innerHTML = '';
  state.found = [];
  setAskNote('조건을 해석하는 중...');

  try {
    const parsed = await parseSmart(text, {
      apiKey: state.apiKey, today: todayStr(), useNative: state.cli, kind,
    });
    // 차량에는 좌석 수가 없다. 인원 조건을 그대로 두면 모든 차가 걸러진다.
    const filter = kind === 'car' ? { ...parsed.filter, minSeats: null } : parsed.filter;
    const via = VIA_LABEL[parsed.via] || parsed.via;
    setAskNote(`[${via}] ${filter.summary} — 후보를 찾는 중...`);

    const { results, skipped, dates } = await findSlots(filter, (date, i, n) => {
      setAskNote(`[${via}] ${filter.summary} — ${date} 조회 중 (${i}/${n})`);
    }, kind === 'car' ? loadCarDay : loadDay);

    renderFound(results, skipped, kind);

    const noun = kind === 'car' ? '차량' : '회의실';
    const parts = [`[${via}] ${noun} ${dates.length}일 조회 · 빈 시간 ${results.length}건`];
    if (parsed.filter.guessed) parts.push('날짜·시간을 못 읽어 기본값으로 봤습니다');
    if (kind === 'car' && parsed.filter.minSeats) parts.push('차량은 좌석 수를 알 수 없어 인원 조건은 뺐습니다');
    if (parsed.note) parts.push(parsed.note);
    if (skipped.length) parts.push(`⚠ ${skipped.length}일은 확인 불가라 제외`);
    if (dates.length >= MAX_DAYS) parts.push(`최대 ${MAX_DAYS}일까지만 봅니다`);
    setAskNote(parts.join(' · '), skipped.length ? 'error' : '');
    // 로컬 CLI 가 실패해 규칙 해석으로 내려간 사정(parsed.note)은 문장에 남긴다 — 결과는 나와도 고칠 거리다.
    logEvent('ask', true,
      `"${text}" → [${via}] ${noun} 빈 시간 ${results.length}건${parsed.note ? ` (${parsed.note})` : ''}`,
      { kind, via: parsed.via, filter, costUsd: parsed.costUsd, days: dates.length, skipped: skipped.length });
  } catch (err) {
    setAskNote(err.message, 'error');
    logEvent('ask', false, `"${text}" — ${err.message}`, { kind });
  } finally {
    state.asking = false;
    paintAskReady();
  }
}

/**
 * 찾은 후보를 누르면 **바로 예약할 수 있는 자리까지** 데려다 놓는다.
 * 그 탭·날짜·지역으로 옮기고, 시간대를 넓혀 그 칸을 골라 둔 뒤 입력칸에 손을 놓는다.
 */
async function applyFound(i) {
  const r = state.found[i];
  if (!r) return;
  const kind = state.foundKind || 'room';

  el.date.value = r.date;
  if (kind === 'room' && r.region) state.region = r.region;
  paintRegion();

  // 후보가 화면 시간대 밖이면 골라낼 칸이 없다. 먼저 넓힌다.
  const want = widenHours(hours(), r.start, r.end);
  if (want.start !== +el.hourStart.value || want.end !== +el.hourEnd.value) {
    el.hourStart.value = String(want.start);
    el.hourEnd.value = String(want.end);
    chrome.storage.local.set({ hourStart: el.hourStart.value, hourEnd: el.hourEnd.value });
  }

  // 차량 후보를 회의실 표에서 고를 수는 없다. 다른 탭에서 찾은 것이면 그 탭으로 옮긴다
  // (applyMode 가 조회까지 한다).
  if (state.mode !== kind) await applyMode(kind);
  else await load();

  if (!state.day || state.day.date !== r.date) return;
  const ri = state.day.grid.findIndex((g) => g.room.name === r.room.name);
  if (ri < 0) return;

  // 접어 둔 방이 걸렸으면 펼친다. 골라 놓고 그 줄이 안 보이면 무엇을 고른 것인지 알 수 없다.
  if (!state.foldOpen && isFoldedRoom(state.day.grid[ri].room)) {
    state.foldOpen = true;
    chrome.storage.local.set({ foldOpen: true });
    render(state.day);
  }

  const slots = state.day.grid[ri].slots;
  const from = slots.findIndex((sl) => sl.start === r.start);
  const to = slots.findIndex((sl) => sl.end === r.end);
  if (from < 0 || to < 0) {
    setAskNote('날짜는 옮겼지만 해당 칸을 찾지 못했습니다.', 'error');
    return;
  }
  if (!rangeIsFree(ri, from, to)) {
    setAskNote('그 사이에 다른 예약이 생겼습니다.', 'error');
    return;
  }
  state.picks = [{ room: ri, from, to }];
  paintPicks();
  el.title.focus();
}

/* ------------------------------------------------------------- 진단 */

const LOG_PREVIEW = 30;
const BRIDGE_TAIL = 30;

/** 다운로드 폴더에 글 파일로 남긴다. */
async function saveText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/**
 * 클립보드에 쓴다. 패널에 포커스가 없으면 clipboard API 가 거절하므로
 * 옛 방식(execCommand)으로 한 번 더 해 본다.
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* 아래로 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(ta);
  try {
    ta.select();
    return document.execCommand?.('copy') === true;
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

const flashTimers = new WeakMap();

/** 버튼 글자를 잠깐 바꿨다가 되돌린다. 누른 결과를 그 자리에서 보여준다. */
function flash(btn, text, ms = 1800) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = text;
  clearTimeout(flashTimers.get(btn));
  flashTimers.set(btn, setTimeout(() => { btn.textContent = btn.dataset.label; }, ms));
}

/** 요약(건수)은 늘, 목록은 칸을 열었을 때만 그린다. 최신 것이 위로 온다. */
async function paintLog() {
  const list = await logbook.list();
  const fails = list.filter((e) => !e.ok).length;
  el.logCount.textContent = list.length ? `${list.length}건${fails ? ` · 실패 ${fails}` : ''}` : '기록 없음';
  if (!el.logBox.open) return;
  el.logOut.textContent = formatEntries(list.slice(-LOG_PREVIEW).reverse(), { detail: false });
}

async function logReport() {
  const [entries, bridge] = await Promise.all([logbook.list(), nativeLogs(BRIDGE_TAIL)]);
  return buildLogReport({
    entries,
    bridge,
    meta: {
      확장: chrome.runtime.getManifest?.()?.version,
      탭: state.mode,
      지역: state.region,
      다리: state.cli ? '연결됨' : '없음',
      API키: state.apiKey ? '있음' : '없음',
      브라우저: navigator.userAgent,
    },
  });
}

async function copyLog() {
  el.logCopy.disabled = true;
  try {
    const ok = await copyText(await logReport());
    flash(el.logCopy, ok ? '복사됨 ✓' : '복사 실패 — 파일로 저장을 쓰세요', ok ? 1800 : 4000);
  } finally {
    el.logCopy.disabled = false;
  }
}

async function saveLog() {
  el.logSave.disabled = true;
  try {
    const name = `krs-log-${stamp(Date.now()).replace(/[-:]/g, '').replace(' ', '-')}.txt`;
    await saveText(await logReport(), name);
    flash(el.logSave, '저장됨 ✓');
  } catch (err) {
    flash(el.logSave, `저장 실패: ${err.message}`, 4000);
  } finally {
    el.logSave.disabled = false;
  }
}

// 비우기는 되돌릴 수 없다. 브라우저 확인 창 대신 패널 안에서 두 번 눌러 확인한다.
let clearArmedAt = 0;
async function clearLog() {
  if (Date.now() - clearArmedAt > 3000) {
    clearArmedAt = Date.now();
    flash(el.logClear, '한 번 더 누르면 지웁니다', 3000);
    return;
  }
  clearArmedAt = 0;
  await logbook.clear();
  flash(el.logClear, '지웠습니다');
  paintLog();
}

function summarize(html, finalUrl, via) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return {
    capturedAt: new Date().toISOString(),
    url: finalUrl,
    via,
    length: html.length,
    title: doc.title,
    forms: [...doc.querySelectorAll('form')].map((f) => ({
      action: f.getAttribute('action'),
      method: f.getAttribute('method'),
      enctype: f.getAttribute('enctype'),
    })),
    inputs: [...doc.querySelectorAll('input, select, textarea')]
      .filter((i) => !/^__VIEWSTATE/.test(i.getAttribute('name') || ''))
      .map((i) => ({
        tag: i.tagName,
        type: i.getAttribute('type'),
        name: i.getAttribute('name'),
        id: i.getAttribute('id'),
        value: (i.getAttribute('value') || '').slice(0, 40),
        options: i.tagName === 'SELECT'
          ? [...i.querySelectorAll('option')].slice(0, 40).map((o) => `${o.getAttribute('value')}|${o.textContent.trim()}`)
          : undefined,
      })),
    tables: [...doc.querySelectorAll('table')].map((t, i) => ({
      index: i,
      rows: t.rows.length,
      header: t.rows[0] ? [...t.rows[0].cells].map((c) => c.textContent.trim()) : [],
      sample: t.rows[1] ? [...t.rows[1].cells].map((c) => c.textContent.trim()) : [],
    })),
    links: [...doc.querySelectorAll('a')]
      .map((a) => ({ text: a.textContent.trim().slice(0, 30), href: (a.getAttribute('href') || '').slice(0, 160) }))
      .filter((a) => a.text),
  };
}

async function runCapture() {
  el.capture.disabled = true;
  el.diagOut.textContent = '캡처 중...';
  try {
    const list = await captureRaw(isCar() ? CAR_LIST_URL : LIST_URL);
    const summary = summarize(list.html, list.finalUrl, list.via);

    const bundle = `===== SUMMARY =====\n${JSON.stringify(summary, null, 2)}\n\n===== RAW HTML =====\n${list.html}`;
    const filename = isCar() ? 'rentcar-capture.txt' : 'meetingroom-capture.txt';
    await saveText(bundle, filename);

    el.diagOut.textContent =
      `저장됨: 다운로드 폴더 / ${filename}\n` +
      `표 ${summary.tables.length}개, 입력칸 ${summary.inputs.length}개\n\n` +
      JSON.stringify(summary.tables, null, 1).slice(0, 1500);
    logEvent('capture', true, `${filename} 저장`,
      { url: summary.url, via: summary.via, bytes: summary.length, tables: summary.tables.length });
  } catch (err) {
    el.diagOut.textContent = `캡처 실패: ${err.message}`;
    logEvent('capture', false, `캡처 실패: ${err.message}`, { mode: state.mode });
  } finally {
    el.capture.disabled = false;
  }
}

/* ------------------------------------------------------------- 초기화 */

function initHourSelects() {
  for (let h = 0; h <= 24; h++) {
    const label = `${String(h).padStart(2, '0')}:00`;
    el.hourStart.add(new Option(label, String(h), false, h === DEFAULT_HOURS.start));
    el.hourEnd.add(new Option(label, String(h), false, h === DEFAULT_HOURS.end));
  }
}

async function init() {
  initHourSelects();

  const saved = await chrome.storage.local.get(
    ['hourStart', 'hourEnd', 'region', 'auto', 'apiKey', 'mode', 'justBooked', 'myName', 'spanDays',
      'foldOpen']);
  if (saved.hourStart != null) el.hourStart.value = saved.hourStart;
  if (saved.hourEnd != null) el.hourEnd.value = saved.hourEnd;
  if (saved.spanDays != null) el.spanDays.value = saved.spanDays;
  if (saved.region) state.region = saved.region;
  el.auto.checked = !!saved.auto;
  state.apiKey = saved.apiKey || '';
  state.justBooked = pruneBooked(saved.justBooked);
  state.myName = saved.myName || '';
  state.foldOpen = !!saved.foldOpen;
  el.apiKey.value = state.apiKey;
  el.myName.value = state.myName;
  // 패널을 연 것도 남긴다. 기록을 읽을 때 어디서 한 판이 시작됐는지가 보인다.
  logEvent('open', true, `패널 열림 · v${chrome.runtime.getManifest?.()?.version ?? '?'}`,
    { mode: saved.mode || 'room' });
  paintAskReady();
  checkCli();
  paintRegion();
  el.date.value = todayStr();

  el.prev.addEventListener('click', () => shiftDate(-1));
  el.next.addEventListener('click', () => shiftDate(1));
  el.today.addEventListener('click', () => { el.date.value = todayStr(); load(); });
  // 달력에서 고르면 change, 직접 입력하면 input 이 뜬다. 완전한 날짜일 때만 조회한다.
  const onDateEdit = () => {
    const v = el.date.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    if (state.day && state.day.date === v && !el.refresh.disabled) return;
    load();
  };
  el.date.addEventListener('change', onDateEdit);
  el.date.addEventListener('input', onDateEdit);
  // 새로고침은 담아 둔 것을 믿지 않는다. 그 기간을 버리고 다시 읽는다.
  el.refresh.addEventListener('click', () => load({ force: true }));
  el.submit.addEventListener('click', submitBooking);
  el.modify.addEventListener('click', runModify);
  el.extend.addEventListener('click', extendBooking);
  el.cancelBtn.addEventListener('click', cancelPicked);
  // 선택을 지우면 수정도 그만둔다. 수정 중 표시만 남아 있으면 무엇을 누를지 알 수 없다.
  el.clearPick.addEventListener('click', cancelEdit);
  el.clearPick.addEventListener('click', () => { state.picks = []; paintPicks(); });
  attachPickList();
  el.askGo.addEventListener('click', runAsk);
  el.ask.addEventListener('keydown', (e) => { if (e.key === 'Enter') runAsk(); });
  el.askList.addEventListener('click', (e) => {
    const li = e.target instanceof HTMLElement ? e.target.closest('li[data-i]') : null;
    if (li) applyFound(+li.dataset.i);
  });
  el.apiKey.addEventListener('change', () => {
    state.apiKey = el.apiKey.value.trim();
    chrome.storage.local.set({ apiKey: state.apiKey });
    paintAskReady();
  });
  el.openPageInline.addEventListener('click', () => {
    chrome.tabs.create({ url: isCar() ? CAR_SHELL_URL : SHELL_URL });
  });
  el.cliCheck.addEventListener('click', checkCli);
  el.tabRoom.addEventListener('click', () => setMode('room'));
  el.tabCar.addEventListener('click', () => setMode('car'));
  el.tabMine.addEventListener('click', () => setMode('mine'));
  el.mineList.addEventListener('click', async (e) => {
    const editBtn = e.target instanceof HTMLElement ? e.target.closest('[data-edit]') : null;
    if (editBtn) {
      e.stopPropagation();
      startEdit(+editBtn.dataset.edit);
      return;
    }
    const cancelBtn = e.target instanceof HTMLElement ? e.target.closest('[data-cancel]') : null;
    if (cancelBtn) {
      e.stopPropagation();
      await cancelFromMine(+cancelBtn.dataset.cancel);
      return;
    }
    const li = e.target instanceof HTMLElement ? e.target.closest('li[data-i]') : null;
    if (li) openMineItem(+li.dataset.i);
  });
  el.spanDays.addEventListener('change', () => {
    chrome.storage.local.set({ spanDays: el.spanDays.value });
    load();
  });
  el.myName.addEventListener('change', () => {
    state.myName = el.myName.value.trim();
    chrome.storage.local.set({ myName: state.myName });
    if (isMineMode()) load();
  });
  // 막대를 누르면 한 달을 처음부터 다시 훑는다(툴팁에 그렇게 적혀 있다).
  // 내 예약을 보고 있으면 load 로 돌린다 — 그래야 다시 담기는 대로 목록이 따라 바뀐다.
  el.scanBar.addEventListener('click', () => {
    if (scanning) return;
    if (isMineMode()) load({ force: true });
    else prefetchMonth({ force: true });
  });
  el.capture.addEventListener('click', runCapture);
  el.logBox.addEventListener('toggle', paintLog);
  el.logCopy.addEventListener('click', copyLog);
  el.logSave.addEventListener('click', saveLog);
  el.logClear.addEventListener('click', clearLog);
  el.auto.addEventListener('change', () => {
    chrome.storage.local.set({ auto: el.auto.checked });
    applyAuto();
  });
  el.region.addEventListener('click', () => {
    const next = nextRegion();
    if (!next) return;
    state.region = next;
    paintRegion();
    chrome.storage.local.set({ region: next });
    load();
  });

  for (const sel of [el.hourStart, el.hourEnd]) {
    sel.addEventListener('change', () => {
      chrome.storage.local.set({ hourStart: el.hourStart.value, hourEnd: el.hourEnd.value });
      load();
    });
  }

  // 드래그는 표 밖에서 손을 떼도 끝나야 한다.
  window.addEventListener('mouseup', () => {
    if (state.drag) {
      state.drag = null;
      normalizePicks();
      paintPicks();
    }
  });

  setInterval(paintStamp, 10_000);
  applyAuto();

  // 리스너를 모두 붙인 뒤에 모드를 맞춘다. applyMode 가 조회까지 해준다.
  const first = (saved.mode === 'car' || saved.mode === 'mine') ? applyMode(saved.mode) : load();

  // 보고 있는 탭을 먼저 띄운 다음, 오늘부터 한 달을 미리 훑는다.
  // 세 탭이 같은 캐시를 보므로 이 한 번으로 회의실·차량·내 예약이 모두 채워진다.
  // 내 예약 탭으로 열렸다면 그쪽이 이미 훑고 있으니 ensureDays 가 기다렸다 빈 날만 채운다.
  Promise.resolve(first).catch(() => {}).then(() => prefetchMonth());
}

init();
