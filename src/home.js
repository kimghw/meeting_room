// e-Class 홈(eClassVer4/Home/Index) 맨 위에 "내 예약" 카드를 붙인다.
//
// 사이드패널을 열지 않아도 홈에 들어오면 앞으로 한 달 안의 내 회의실·차량 예약이 보이게 한다.
// 훑기(site/rentcar)와 내 예약 판정(mine)은 사이드패널과 **같은 모듈**을 그대로 쓴다. 다른 점은 둘이다.
//
//   1) 콘텐츠 스크립트라 페이지와 같은 출처에서 요청한다. 쿠키가 그냥 실리고, 탭 경유 폴백은 없다.
//   2) 훑은 결과를 chrome.storage 에 담아 둔다. 홈은 하루에도 여러 번 여는 화면이라 그때마다
//      서른 날을 다시 두드릴 수 없다. 담긴 것은 **언제 읽었는지**와 함께 보여주고, 묵으면 다시 읽는다.
//      패널에서 예약·취소하면 패널이 이 캐시를 지우고, 카드는 그것을 보고 다시 훑는다.
//
// 겉모습은 사이트의 카드(Popup Notice 와 같은 markup)를 빌려 홈의 다른 카드와 같아 보이게 한다.
// 안쪽 목록은 krs-mine-* 접두어의 자체 스타일만 쓴다 — 사이트 CSS 가 바뀌어도 목록은 읽힌다.

import { scanDays } from './site.js';
import { scanCarDays } from './rentcar.js';
import { collectMine, datesFrom } from './mine.js';
import { MONTH_DAYS, STALE_MS } from './monthcache.js';
import { fmtTime, todayStr } from './parse.js';
import { AuthError } from './net.js';

/** 훑은 결과를 담는 storage 키. 패널은 예약·취소 뒤 이 키를 지워 카드에게 알린다. */
export const CACHE_KEY = 'homeMine';
/** 카드를 쓸지. 패널 머리의 체크박스가 이 값을 쓴다. 값이 없으면 켠 것으로 본다. */
export const ENABLE_KEY = 'homeCard';
export const homeEnabled = (value) => value !== false;
/** 카드에서 한 건을 누르면 남기는 "이 날짜로 가 달라"는 부탁. 패널이 읽고 지운다. */
export const JUMP_KEY = 'homeJump';
/** 부탁이 이보다 묵으면 패널은 무시한다. 며칠 전 누른 것이 다음에 패널을 열 때 튀어나오면 안 된다. */
export const JUMP_TTL_MS = 60_000;
/** 카드의 루트 요소 id. CDP 검사가 이걸로 찾는다. */
export const ROOT_ID = 'krsMine';
/** 일부를 못 읽은 결과는 이만큼만 믿는다. 사이트가 잠깐 앓은 것일 수 있어 곧 다시 본다. */
export const PARTIAL_STALE_MS = 2 * 60_000;
/** 패널이 예약·취소를 연달아 하면 알림이 몰려온다. 이만큼 모아서 한 번만 훑는다. */
export const RESCAN_DEBOUNCE_MS = 1500;

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const WHY_LABEL = { name: '이름 일치', booked: '내가 넣음' };

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const shortLabel = (dateStr) => {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}`;
};

/** 'YYYY-MM-DD' → '9/17 (수)'. 오늘은 말로 — 목록에서 눈에 먼저 들어와야 하는 날이다. */
export function dayLabel(dateStr, today = todayStr()) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return dateStr === today ? `오늘 (${wd})` : `${m}/${d} (${wd})`;
}

/** 읽은 지 얼마나 됐는지. 카드는 늘 이걸 같이 적는다 — 묵은 현황을 지금 것처럼 보이면 안 된다. */
export function agoText(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

const rangeText = (dates) => `${shortLabel(dates[0])}~${shortLabel(dates[dates.length - 1])}`;

/* ------------------------------------------------------------ 자리 찾기 */

/**
 * 카드를 어디에 붙일지. 홈의 첫 카드(Popup Notice, #divPopupInfo) 바로 앞이 첫째 후보다.
 * 알아보는 자리가 없으면 null — 엉뚱한 화면에 띄우느니 안 붙인다.
 */
export function findAnchor(doc) {
  const notice = doc.querySelector('#divPopupInfo');
  if (notice?.parentElement) return { mode: 'before', el: notice };
  const content = doc.querySelector('.page-content');
  if (content) return { mode: 'prepend', el: content };
  return null;
}

/* ------------------------------------------------------------ 캐시 */

/** 기간은 패널의 내 예약 탭 설정(spanDays)을 그대로 쓴다. 두 화면이 다른 기간을 보면 서로 어긋나 보인다. */
export function spanOf(saved) {
  const n = +saved;
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : MONTH_DAYS;
}

/**
 * 담긴 것을 그대로 써도 되는지. 시작일·기간·이름이 모두 같아야 한다.
 * 이름이 바뀌면 판정이 바뀌고, 날이 바뀌면 어제 것은 오늘 것이 아니다.
 */
export function cacheUsable(cache, { start, days, name = '' }) {
  return !!cache && Array.isArray(cache.items) && typeof cache.at === 'number'
    && cache.start === start && cache.days === days && (cache.name || '') === (name || '');
}

/** 아직 믿어도 되는지. 일부를 못 읽은 결과는 더 짧게 믿는다. */
export function cacheFresh(cache, now = Date.now(), staleMs = STALE_MS) {
  if (!cache) return false;
  const ttl = cache.failed?.length ? Math.min(staleMs, PARTIAL_STALE_MS) : staleMs;
  return now - cache.at < ttl;
}

/** 화면에 필요한 것만 남긴다. record(파싱 원본)는 storage 에 넣지 않는다. */
const slim = (it) => ({
  kind: it.kind, why: it.why, from: it.from, to: it.to,
  room: it.room, title: it.title, status: it.status, owner: it.owner,
});

/**
 * 훑은 날들에서 내 예약을 추리고, 못 읽은 날을 센다.
 * 못 읽은 날을 조용히 넘기면 "내 예약이 없다"는 거짓말이 된다 — 그래서 여기서 같이 센다.
 *   skippedDates — 읽었지만 확신할 수 없어 뺀 날
 *   unread       — 회의실이든 차량이든 기록 자체가 없는 날(훑기가 도중에 죽었을 때)
 */
export function summarize(dates, days, { name = '', booked = [], failed = [] } = {}) {
  const { items, skipped } = collectMine(days, { name, booked });
  const skippedDates = [...new Set(skipped.map((s) => s.date))];
  const have = new Set(days.map((d) => `${d.kind}|${d.date}`));
  const unread = dates.filter((d) => !have.has(`room|${d}`) || !have.has(`car|${d}`));
  return { items: items.map(slim), skippedDates, unread, failed: [...failed] };
}

/* ------------------------------------------------------------ 훑기 */

/**
 * 회의실 한 바퀴, 차량 한 바퀴. 한쪽이 실패해도 다른 쪽은 계속한다.
 * 지역은 옮기지 않는다 — 예약 목록에는 전 지역이 다 들어 있고, 내 예약은 지역을 가리지 않는다.
 */
async function scanMine(dates, { scanRooms, scanCars, onDay, onProgress, signal }) {
  const days = [];
  const failed = [];
  let authError = null;
  const feed = (day) => {
    if (signal?.aborted) return;
    days.push(day);
    try { onDay?.(days); } catch { /* 화면 문제로 훑기를 멈추지는 않는다 */ }
  };
  const phase = async (idx, label, fn) => {
    // 카드를 껐으면 남은 바퀴는 돌지 않는다. 끈 뒤에도 사이트를 두드리면 끈 것이 아니다.
    if (signal?.aborted) return;
    try {
      await fn((date, i, n) => onProgress?.(idx, label, date, i, n));
    } catch (err) {
      if (err instanceof AuthError) authError = err;
      failed.push(`${label} 훑기 실패: ${err.message}`);
    }
  };
  await phase(0, '회의실', (p) => scanRooms(dates, p, { onDay: feed, signal }));
  await phase(1, '차량', (p) => scanCars(dates, p, { onDay: feed, signal }));
  return { days, failed, authError };
}

/* ------------------------------------------------------------ 그리기 */

const STYLE = `
.krs-mine .krs-mine-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding-top: .5rem; }
.krs-mine .krs-mine-title { display: flex; align-items: center; gap: 7px; margin: 0 !important; font-size: .875rem; }
.krs-mine .krs-mine-count { display: inline-block; min-width: 18px; padding: 1px 7px; border-radius: 9px; background: #e8f1fd; color: #1f6fd0; font-size: 11px; font-weight: 700; line-height: 1.5; text-align: center; }
.krs-mine .krs-mine-count:empty { display: none; }
.krs-mine .krs-mine-note { flex: 1 1 auto; min-width: 0; color: #7a8087; font-size: 12px; }
.krs-mine .krs-mine-tools { display: flex; gap: 6px; margin-left: auto; }
.krs-mine .krs-mine-btn { padding: 3px 10px; border: 1px solid #d6dbe0; border-radius: 4px; background: #fff; color: #45464b; font: inherit; font-size: 12px; line-height: 1.4; cursor: pointer; }
.krs-mine .krs-mine-btn:hover { background: #f3f5f7; }
.krs-mine .krs-mine-btn:disabled { opacity: .6; cursor: default; }
.krs-mine .krs-mine-btn.primary { border-color: #1f6fd0; background: #1f6fd0; color: #fff; }
.krs-mine .krs-mine-btn.primary:hover { background: #1a5fb4; }
.krs-mine .krs-mine-body { padding: 10px 16px 12px; }
.krs-mine .krs-mine-bar { height: 3px; margin: -4px 0 8px; border-radius: 2px; background: #edf0f3; overflow: hidden; }
.krs-mine .krs-mine-bar > i { display: block; width: 0; height: 100%; background: #1f6fd0; transition: width .3s; }
.krs-mine .krs-mine-list { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
.krs-mine[aria-busy="true"] .krs-mine-list { opacity: .7; }
.krs-mine .krs-mine-item { display: flex; align-items: flex-start; gap: 9px; flex: 1 1 280px; max-width: 460px; padding: 8px 12px; border: 1px solid #e0e5e8; border-radius: 6px; background: #fff; color: #41464d; font-size: 13px; line-height: 1.35; cursor: pointer; }
.krs-mine .krs-mine-item:hover { border-color: #1f6fd0; background: #f5f9ff; }
.krs-mine .krs-mine-item.today { border-left: 3px solid #1f6fd0; }
.krs-mine .krs-mine-kind { flex: none; margin-top: 1px; padding: 2px 7px; border-radius: 5px; background: #e8f1fd; color: #1f6fd0; font-size: 11px; font-weight: 700; white-space: nowrap; }
.krs-mine .krs-mine-kind.car { background: #e3f3ea; color: #1f7a45; }
.krs-mine .krs-mine-main { flex: 1; min-width: 0; }
.krs-mine .krs-mine-when { font-weight: 600; font-variant-numeric: tabular-nums; }
.krs-mine .krs-mine-status { margin-left: 6px; color: #7a8087; font-size: 11px; }
.krs-mine .krs-mine-sub { display: flex; gap: 6px; min-width: 0; margin-top: 2px; color: #6b7178; font-size: 12px; }
.krs-mine .krs-mine-room { flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.krs-mine .krs-mine-topic { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.krs-mine .krs-mine-topic::before { content: "·"; margin-right: 6px; color: #aeb4ba; }
.krs-mine .krs-mine-why { flex: none; margin-top: 2px; color: #aeb4ba; font-size: 11px; white-space: nowrap; }
.krs-mine .krs-mine-empty, .krs-mine .krs-mine-warn { margin: 0; color: #6b7178; font-size: 12px; }
.krs-mine .krs-mine-warn { color: #a7691a; }
.krs-mine .krs-mine-list:not(:empty) + .krs-mine-empty:not(:empty),
.krs-mine .krs-mine-list:not(:empty) ~ .krs-mine-warn:not(:empty) { margin-top: 8px; }
.krs-mine .krs-mine-empty:empty, .krs-mine .krs-mine-warn:empty { display: none; }
`;

/** 사이트 카드 markup 을 빌려 겉을 만들고, 안쪽은 우리 것으로 채운다. */
function buildStrip(doc) {
  const root = doc.createElement('div');
  root.id = ROOT_ID;
  root.className = 'row pt-3 mt-1 krs-mine';
  root.innerHTML = `<style>${STYLE}</style>
<div class="col-12">
  <div class="card ccard radius-t-0">
    <div class="position-tl w-102 border-t-3 brc-primary ml-n1px mt-n1px"></div>
    <div class="card-header brc-secondary-l3 pb-2 krs-mine-head">
      <h5 class="card-title mb-2 mb-md-0 text-dark-m3 krs-mine-title">내 예약 <span class="krs-mine-count" data-role="count"></span></h5>
      <span class="krs-mine-note" data-role="note"></span>
      <span class="krs-mine-tools">
        <button type="button" class="krs-mine-btn" data-act="refresh" title="담아 둔 것을 버리고 사이트를 다시 훑습니다">새로고침</button>
        <button type="button" class="krs-mine-btn primary" data-act="panel" title="확장의 사이드 패널에서 예약·취소·수정합니다">예약 패널 열기</button>
      </span>
    </div>
    <div class="card-body bgc-white krs-mine-body">
      <div class="krs-mine-bar" data-role="bar" hidden><i data-role="fill"></i></div>
      <ul class="krs-mine-list" data-role="list"></ul>
      <p class="krs-mine-empty" data-role="empty"></p>
      <p class="krs-mine-warn" data-role="warn"></p>
    </div>
  </div>
</div>`;
  const q = (role) => root.querySelector(`[data-role="${role}"]`);
  return {
    root,
    count: q('count'), note: q('note'), bar: q('bar'), fill: q('fill'),
    list: q('list'), empty: q('empty'), warn: q('warn'),
    refresh: root.querySelector('[data-act="refresh"]'),
  };
}

function itemHtml(it, i, today) {
  const sameDay = it.from.date === it.to.date;
  const when = sameDay
    ? `${dayLabel(it.from.date, today)} ${fmtTime(it.from.minutes)}~${fmtTime(it.to.minutes)}`
    : `${dayLabel(it.from.date, today)} ${fmtTime(it.from.minutes)} ~ ${dayLabel(it.to.date, today)} ${fmtTime(it.to.minutes)}`;
  const why = WHY_LABEL[it.why] || '';
  return `<li class="krs-mine-item${it.from.date === today ? ' today' : ''}" data-i="${i}" title="누르면 예약 패널에서 이 날짜를 엽니다">`
    + `<span class="krs-mine-kind ${it.kind}">${it.kind === 'car' ? '차량' : '회의실'}</span>`
    + '<span class="krs-mine-main">'
    + `<span class="krs-mine-when">${escapeHtml(when)}</span>`
    + (it.status ? `<span class="krs-mine-status">${escapeHtml(it.status)}</span>` : '')
    + '<span class="krs-mine-sub">'
    + `<span class="krs-mine-room">${escapeHtml(it.room)}</span>`
    + (it.title ? `<span class="krs-mine-topic">${escapeHtml(it.title)}</span>` : '')
    + '</span></span>'
    + (why ? `<span class="krs-mine-why" title="이 건을 내 것으로 본 근거">${why}</span>` : '')
    + '</li>';
}

/* ------------------------------------------------------------ 붙이기 */

/** 배경(서비스 워커)에게 이 탭에 패널을 열어 달라고 한다. 콘텐츠 스크립트는 sidePanel API 를 직접 못 부른다. */
async function defaultOpenPanel() {
  const r = await chrome.runtime.sendMessage({ type: 'openSidePanel' });
  return r || { ok: false, error: '응답이 없습니다' };
}

/** storage 변화를 듣는다. 돌려주는 함수로 그만 듣는다 — 카드를 끄면 떼어야 한다. */
function defaultOnChanged(fn) {
  const ev = chrome.storage.onChanged;
  if (!ev) return () => {};
  ev.addListener(fn);
  return () => ev.removeListener(fn);
}

/**
 * 홈 문서에 카드를 붙이고 첫 조회가 끝날 때까지 기다린다.
 * @returns {Promise<object|null>} createHomeCard 의 손잡이. 알아보는 자리가 없으면 null
 */
export async function mountHome(doc, deps = {}) {
  const card = createHomeCard(doc, deps);
  if (!card) return null;
  await card.ready;
  return card;
}

/**
 * 설정(ENABLE_KEY)을 따라 카드를 붙이거나 뗀다. 콘텐츠 스크립트는 이것을 부른다.
 *
 * 패널에서 체크박스를 바꾸면 열려 있는 홈에도 곧바로 반영된다 — 끄면 카드가 사라지고 도는 훑기도 멈추고,
 * 켜면 새로고침 없이 다시 붙는다.
 * @returns {Promise<{card: object|null, stop: Function}>}
 */
export async function startHome(doc, deps = {}) {
  const storage = deps.storage || chrome.storage.local;
  const onChanged = deps.onChanged || defaultOnChanged;
  let card = null;

  const apply = (on) => {
    if (on && !card) card = createHomeCard(doc, deps);
    else if (!on && card) {
      card.destroy();
      card = null;
    }
  };

  const off = onChanged((changes, area) => {
    if (area && area !== 'local') return;
    if (ENABLE_KEY in changes) apply(homeEnabled(changes[ENABLE_KEY].newValue));
  });

  const saved = await storage.get(ENABLE_KEY);
  apply(homeEnabled(saved?.[ENABLE_KEY]));
  await card?.ready;

  return {
    get card() { return card; },
    stop() {
      off?.();
      apply(false);
    },
  };
}

/**
 * 홈 문서에 카드를 붙이고 첫 조회를 시작한다. 조회를 기다리지 않고 곧바로 손잡이를 돌려준다
 * — 서른 날을 훑는 동안에도 끌 수 있어야 하기 때문이다.
 *
 * 바깥 것은 모두 주입받는다(storage·훑기·시각·패널 열기) — 테스트가 가짜로 돌리기 위해서다.
 * @returns {{root: Element, ready: Promise, refresh: Function, destroy: Function}|null}
 *   알아보는 자리가 없으면 null
 */
export function createHomeCard(doc, deps = {}) {
  const anchor = findAnchor(doc);
  if (!anchor) return null;

  const storage = deps.storage || chrome.storage.local;
  const onChanged = deps.onChanged || defaultOnChanged;
  const now = deps.now || (() => Date.now());
  const today = deps.today || todayStr;
  const scanRooms = deps.scanRooms || scanDays;
  const scanCars = deps.scanCars || scanCarDays;
  const staleMs = deps.staleMs ?? STALE_MS;
  const debounceMs = deps.debounceMs ?? RESCAN_DEBOUNCE_MS;
  const openPanel = deps.openPanel || defaultOpenPanel;
  const visible = deps.visible || (() => doc.visibilityState !== 'hidden');

  // 확장을 다시 올렸거나 두 번 불렸으면 먼저 것은 치운다.
  doc.getElementById(ROOT_ID)?.remove();
  const ui = buildStrip(doc);
  if (anchor.mode === 'before') anchor.el.parentElement.insertBefore(ui.root, anchor.el);
  else anchor.el.prepend(ui.root);

  const view = { items: [] };
  let running = null;      // 지금 도는 훑기. 한 번에 하나만.
  let rerun = false;       // 도는 중에 다시 훑을 일이 생겼다
  let needRescan = false;  // 안 보이는 사이에 생긴 일. 보이면 훑는다
  let debounce = null;
  let disposed = false;    // 카드를 뗐다. 그 뒤로는 아무것도 하지 않는다
  const stopper = new AbortController();

  const setBusy = (on) => {
    ui.root.setAttribute('aria-busy', String(on));
    ui.refresh.disabled = on;
  };

  function paintList(items) {
    view.items = items;
    const t = today();
    ui.count.textContent = items.length ? String(items.length) : '';
    ui.list.innerHTML = items.map((it, i) => itemHtml(it, i, t)).join('');
  }

  function paintProgress(range, phase, label, date, i, n) {
    ui.bar.hidden = false;
    ui.fill.style.width = `${Math.round(((phase * n + i) / (n * 2)) * 100)}%`;
    ui.note.textContent = `${range} · ${label} 훑는 중 ${i}/${n}${date ? ` · ${shortLabel(date)}` : ''}`;
  }

  /** 담긴(또는 방금 훑은) 결과를 그린다. 언제 읽은 것인지, 무엇을 못 읽었는지 같이 적는다. */
  function paintResult(cache, name) {
    const dates = datesFrom(cache.start, cache.days);
    const range = rangeText(dates);
    paintList(cache.items);
    ui.bar.hidden = true;
    ui.note.textContent = `${range} · ${agoText(cache.at, now())} 읽음`;
    ui.note.title = new Date(cache.at).toLocaleString();
    ui.empty.textContent = cache.items.length ? '' : `${range} 사이에서 내 예약으로 확인된 건을 찾지 못했습니다.`;

    const warn = [];
    if (!name) warn.push('이름을 넣으면 예약자 이름으로도 찾습니다 — 예약 패널의 "설정 및 연결"');
    if (cache.skippedDates?.length) warn.push(`⚠ ${cache.skippedDates.length}일은 확인 불가라 제외했습니다`);
    if (cache.unread?.length) warn.push(`⚠ ${cache.unread.length}일은 아예 읽지 못했습니다`);
    warn.push(...(cache.failed || []));
    ui.warn.textContent = warn.join(' · ');
  }

  /** 잠깐 보였다 사라지는 안내. 경고 줄을 빌려 쓰고 원래 글로 되돌린다. */
  function flash(msg) {
    const prev = ui.warn.textContent;
    ui.warn.textContent = msg;
    setTimeout(() => { if (ui.warn.textContent === msg) ui.warn.textContent = prev; }, 6000);
  }

  /**
   * 담긴 것을 보여주고, 필요하면 훑는다.
   *   담긴 것이 없다        → 훑는다(진행 막대)
   *   담긴 것이 신선하다    → 그것만 보여준다
   *   담긴 것이 묵었다      → 먼저 보여주고 다시 훑어 바꿔 끼운다
   */
  async function run({ force = false } = {}) {
    if (disposed) return undefined;
    if (running) {
      if (force) rerun = true;
      return running;
    }
    running = (async () => {
      const saved = await storage.get(['myName', 'justBooked', 'spanDays', CACHE_KEY]);
      if (disposed) return;
      const name = String(saved.myName || '').trim();
      const booked = Array.isArray(saved.justBooked) ? saved.justBooked : [];
      const days = spanOf(saved.spanDays);
      const start = today();
      const dates = datesFrom(start, days);
      const range = rangeText(dates);
      const cache = saved[CACHE_KEY];
      const usable = cacheUsable(cache, { start, days, name });

      if (usable) paintResult(cache, name);
      if (usable && !force && cacheFresh(cache, now(), staleMs)) return;

      setBusy(true);
      if (!usable) {
        ui.empty.textContent = '';
        ui.warn.textContent = '';
      }
      ui.note.textContent = `${range} · 훑는 중...`;
      try {
        const res = await scanMine(dates, {
          scanRooms, scanCars,
          // 읽는 대로 목록이 차오르게 한다. 서른 날을 다 기다린 뒤에야 첫 줄이 보이면 아무것도 안 하는 것처럼 보인다.
          onDay: (soFar) => paintList(summarize(dates, soFar, { name, booked }).items),
          onProgress: (phase, label, date, i, n) => paintProgress(range, phase, label, date, i, n),
          signal: stopper.signal,
        });
        // 도중에 껐다. 반쯤 읽은 것을 담으면 다음에 켰을 때 "다 읽은 것"처럼 보인다.
        if (disposed) return;

        if (!res.days.length) {
          // 한 날도 못 읽었다. 목록이 아니라 그 사실을 보여주고, 담지도 않는다 — 다음에 열면 다시 시도한다.
          if (usable) paintResult(cache, name);
          else { ui.bar.hidden = true; ui.note.textContent = range; }
          const why = res.authError ? res.authError.message : res.failed.join(' · ');
          ui.warn.textContent = `${why}${usable ? ` (아래는 ${agoText(cache.at, now())} 읽어 둔 것입니다)` : ''}`;
          return;
        }

        const payload = {
          at: now(), start, days, name,
          ...summarize(dates, res.days, { name, booked, failed: res.failed }),
        };
        await storage.set({ [CACHE_KEY]: payload });
        paintResult(payload, name);
      } catch (err) {
        ui.bar.hidden = true;
        ui.warn.textContent = `훑기 실패: ${err.message}`;
      } finally {
        setBusy(false);
      }
    })().finally(() => {
      running = null;
      if (rerun && !disposed) {
        rerun = false;
        run({ force: true });
      }
    });
    return running;
  }

  /** 예약이 바뀌었을 수 있다. 보이면 곧(몰려오는 알림은 모아서) 훑고, 안 보이면 보일 때 훑는다. */
  function wantRescan() {
    if (disposed) return;
    if (!visible()) {
      needRescan = true;
      return;
    }
    clearTimeout(debounce);
    debounce = setTimeout(() => run({ force: true }), debounceMs);
  }

  const offChanged = onChanged((changes, area) => {
    if (area && area !== 'local') return;
    const gone = CACHE_KEY in changes && changes[CACHE_KEY].newValue === undefined;
    const settings = ['myName', 'justBooked', 'spanDays'].some((k) => k in changes);
    if (gone || settings) wantRescan();
  });
  const onVisible = () => {
    if (needRescan && visible()) {
      needRescan = false;
      run({ force: true });
    }
  };
  doc.addEventListener('visibilitychange', onVisible);

  async function askPanel() {
    const r = await openPanel().catch((err) => ({ ok: false, error: err.message }));
    if (!r?.ok) flash(`패널을 여기서 열 수 없습니다 — 툴바의 확장 아이콘을 누르세요.${r?.error ? ` (${r.error})` : ''}`);
  }

  ui.root.addEventListener('click', async (e) => {
    const target = e.target?.closest ? e.target : null;
    const act = target?.closest('[data-act]')?.dataset.act;
    if (act === 'refresh') { run({ force: true }); return; }
    if (act === 'panel') { await askPanel(); return; }
    const li = target?.closest('li[data-i]');
    if (!li) return;
    const it = view.items[+li.dataset.i];
    if (!it) return;
    // 패널이 어느 날짜·종류를 열지 부탁을 남기고 연다. 이미 열려 있으면 패널이 저장소 변화로 알아챈다.
    await storage.set({ [JUMP_KEY]: { date: it.from.date, mode: it.kind === 'car' ? 'car' : 'room', at: now() } });
    await askPanel();
  });

  /** 카드를 뗀다. 도는 훑기는 다음 날짜로 넘어가기 전에 멈추고, 듣던 것도 모두 떼어낸다. */
  function destroy() {
    if (disposed) return;
    disposed = true;
    stopper.abort();
    clearTimeout(debounce);
    offChanged?.();
    doc.removeEventListener('visibilitychange', onVisible);
    ui.root.remove();
  }

  return {
    root: ui.root,
    ready: run(),
    refresh: (opts) => run({ force: true, ...opts }),
    destroy,
    get destroyed() { return disposed; },
  };
}
