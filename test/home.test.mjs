// 홈의 내 예약 카드: 자리 찾기, 캐시(신선도·이름·기간), 훑기와 못 읽은 날 경고, 패널과의 신호.
// 여기서도 가장 중요한 건 **못 읽은 날을 "예약 없음"으로 넘기지 않는 것**이다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  mountHome, startHome, findAnchor, summarize, spanOf, cacheUsable, cacheFresh, agoText, dayLabel,
  homeEnabled, CACHE_KEY, JUMP_KEY, ENABLE_KEY, ROOT_ID, PARTIAL_STALE_MS,
} from '../src/home.js';
import { AuthError } from '../src/net.js';
import { MONTH_DAYS, STALE_MS } from '../src/monthcache.js';
import { datesFrom } from '../src/mine.js';
import { scanDays } from '../src/site.js';
import { scanCarDays } from '../src/rentcar.js';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const ta = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const TODAY = '2026-09-17';   // 목요일
const NOW = new Date('2026-09-17T09:00:00').getTime();

// 2026-09-17 캡처의 홈 뼈대: 본문 첫 카드가 Popup Notice(#divPopupInfo)다.
const HOME = '<html><body><div class="page-content container">'
  + '<div class="row pt-3 mt-1" id="divPopupInfo"><div class="col-12">Popup Notice</div></div>'
  + '<div class="row" id="divkrinfo"></div></div></body></html>';

function homeDoc(html = HOME) {
  const dom = new JSDOM(html, { url: 'https://eclass.krs.co.kr/eClassVer4/Home/Index' });
  return dom.window.document;
}

/** chrome.storage.local 흉내. 바꾼 것은 onChanged 로 알린다 — 진짜처럼. */
function fakeStorage(init = {}) {
  const data = structuredClone(init);
  const listeners = [];
  const fire = (changes) => { for (const fn of listeners) fn(changes, 'local'); };
  return {
    data,
    get: async (keys) => {
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    set: async (obj) => {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      fire(changes);
    },
    remove: async (keys) => {
      const changes = {};
      for (const k of [].concat(keys)) { changes[k] = { oldValue: data[k] }; delete data[k]; }
      fire(changes);
    },
    // 진짜처럼 떼어낼 수 있어야 한다. 카드를 끄면 듣던 것을 떼는지 여기서 본다.
    onChanged: (fn) => {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    listenerCount: () => listeners.length,
  };
}

const day = (kind, date, reservations = [], confident = true, reason = '') =>
  ({ kind, date, reservations, confident, reason });
const room = (over) => ({
  date: TODAY, room: '제1회의실', start: 540, end: 660, owner: '홍길동', mine: false,
  title: '주간 회의', status: '', region: '부산', ...over,
});

/**
 * 날짜별로 정해 둔 하루를 돌려주는 가짜 훑기. 정하지 않은 날은 0건이다.
 * 진짜 훑기처럼 멈춤 신호(signal)를 날짜마다 본다. gate 를 주면 pauseAfter 날을 읽은 뒤 거기서 기다린다.
 */
function fakeScan(kind, byDate = {}, { fail = null, onCall = null, gate = null, pauseAfter = 0 } = {}) {
  const fn = async (dates, onProgress, { onDay, signal } = {}) => {
    fn.calls.push(dates);
    onCall?.();
    if (fail) throw fail;
    for (let i = 0; i < dates.length; i++) {
      if (gate && i === pauseAfter) await gate;
      if (signal?.aborted) break;
      onProgress?.(dates[i], i + 1, dates.length);
      onDay?.(byDate[dates[i]] || day(kind, dates[i]));
      fn.fed++;
    }
    return [];
  };
  fn.calls = [];
  fn.fed = 0;
  return fn;
}

/** 카드를 붙인다. 바깥 것은 전부 가짜다. */
async function mount({
  storage = fakeStorage(), rooms = fakeScan('room'), cars = fakeScan('car'),
  now = () => NOW, visible = () => true, openPanel = null, doc = homeDoc(), debounceMs = 5,
} = {}) {
  const panelCalls = [];
  const ctl = await mountHome(doc, {
    storage, onChanged: storage.onChanged, now, today: () => TODAY,
    scanRooms: rooms, scanCars: cars, visible, debounceMs,
    openPanel: openPanel || (async () => { panelCalls.push(1); return { ok: true }; }),
  });
  const root = doc.getElementById(ROOT_ID);
  const text = (role) => (root?.querySelector(`[data-role="${role}"]`)?.textContent || '').trim();
  return {
    ctl, doc, root, storage, rooms, cars, panelCalls, text,
    items: () => [...(root?.querySelectorAll('li.krs-mine-item') || [])],
  };
}

console.log('자리 찾기');
t('Popup Notice 카드 바로 앞', () => {
  const a = findAnchor(homeDoc());
  assert.equal(a.mode, 'before');
  assert.equal(a.el.id, 'divPopupInfo');
});
t('공지 카드가 없으면 본문 맨 위', () => {
  const a = findAnchor(homeDoc('<html><body><div class="page-content"><p>x</p></div></body></html>'));
  assert.equal(a.mode, 'prepend');
});
t('알아보는 자리가 없으면 null', () =>
  assert.equal(findAnchor(homeDoc('<html><body><div>x</div></body></html>')), null));

console.log('캐시 판정');
const base = { at: NOW - 1000, start: TODAY, days: MONTH_DAYS, name: '', items: [] };
t('시작일·기간·이름이 같아야 쓴다', () => {
  assert.ok(cacheUsable(base, { start: TODAY, days: 30, name: '' }));
  assert.ok(!cacheUsable(base, { start: '2026-09-18', days: 30, name: '' }));
  assert.ok(!cacheUsable(base, { start: TODAY, days: 14, name: '' }));
  assert.ok(!cacheUsable(base, { start: TODAY, days: 30, name: '홍길동' }));
  assert.ok(!cacheUsable(null, { start: TODAY, days: 30 }));
  assert.ok(!cacheUsable({ ...base, items: null }, { start: TODAY, days: 30 }));
});
t('10분이 지나면 묵는다', () => {
  assert.ok(cacheFresh({ ...base, at: NOW - STALE_MS + 1000 }, NOW));
  assert.ok(!cacheFresh({ ...base, at: NOW - STALE_MS }, NOW));
});
t('일부를 못 읽은 결과는 2분만 믿는다', () => {
  const partial = { ...base, failed: ['차량 훑기 실패: x'] };
  assert.ok(cacheFresh({ ...partial, at: NOW - PARTIAL_STALE_MS + 1000 }, NOW));
  assert.ok(!cacheFresh({ ...partial, at: NOW - PARTIAL_STALE_MS - 1000 }, NOW));
});
t('기간 설정은 패널 것을 그대로, 이상하면 한 달', () => {
  assert.equal(spanOf('7'), 7);
  assert.equal(spanOf(14), 14);
  assert.equal(spanOf('abc'), MONTH_DAYS);
  assert.equal(spanOf('0'), MONTH_DAYS);
  assert.equal(spanOf(undefined), MONTH_DAYS);
});
t('읽은 지 얼마나 됐는지', () => {
  assert.equal(agoText(NOW - 10_000, NOW), '방금');
  assert.equal(agoText(NOW - 3 * 60_000, NOW), '3분 전');
  assert.equal(agoText(NOW - 2 * 3600_000, NOW), '2시간 전');
});
t('오늘은 말로, 나머지는 월/일 (요일)', () => {
  assert.equal(dayLabel(TODAY, TODAY), '오늘 (목)');
  assert.equal(dayLabel('2026-09-18', TODAY), '9/18 (금)');
});

console.log('못 읽은 날 세기');
{
  const dates = datesFrom(TODAY, 3);
  const days = [
    day('room', dates[0], [room({ mine: true })]),
    day('room', dates[1], [], false, '날짜를 옮기지 못했습니다.'),
    day('car', dates[0]),
    day('car', dates[1]),
  ];
  const s = summarize(dates, days, {});
  t('내 것만 추린다', () => { assert.equal(s.items.length, 1); assert.equal(s.items[0].why, 'button'); });
  t('확신 없는 날은 빼고 센다', () => assert.deepEqual(s.skippedDates, [dates[1]]));
  t('기록이 아예 없는 날은 따로 센다', () => assert.deepEqual(s.unread, [dates[2]]));
  t('storage 에 넣을 것만 남긴다(record 없음)', () => assert.ok(!('record' in s.items[0])));
}

console.log('캐시가 없으면 훑고 담는다');
await ta('서른 날을 회의실·차량 두 바퀴 훑고 결과를 담는다', async () => {
  const rooms = fakeScan('room', {
    [TODAY]: day('room', TODAY, [room({ mine: true }), room({ owner: '김철수', room: '제2회의실' })]),
  });
  const cars = fakeScan('car', {
    '2026-09-20': day('car', '2026-09-20', [{
      date: '2026-09-20', room: '카니발', start: 540, end: 1080, owner: '홍길동', mine: false, title: '출장',
      spanStart: { date: '2026-09-20', minutes: 540 }, spanEnd: { date: '2026-09-21', minutes: 1080 },
    }]),
  });
  const storage = fakeStorage({ myName: '홍길동' });
  const m = await mount({ storage, rooms, cars });

  assert.equal(rooms.calls.length, 1);
  assert.equal(rooms.calls[0].length, MONTH_DAYS);
  assert.equal(rooms.calls[0][0], TODAY);
  assert.equal(cars.calls.length, 1);

  const saved = storage.data[CACHE_KEY];
  assert.equal(saved.at, NOW);
  assert.equal(saved.start, TODAY);
  assert.equal(saved.days, MONTH_DAYS);
  assert.equal(saved.name, '홍길동');
  assert.equal(saved.items.length, 2);

  assert.equal(m.items().length, 2);
  assert.equal(m.text('count'), '2');
  assert.match(m.text('note'), /9\/17~10\/16 · 방금 읽음/);
  assert.ok(m.items()[0].classList.contains('today'));
  assert.match(m.items()[0].textContent, /오늘 \(목\) 09:00~11:00/);
  // 차량 다중일 예약은 하루로 자르지 않고 구간 그대로
  assert.match(m.items()[1].textContent, /9\/20 \(일\) 09:00 ~ 9\/21 \(월\) 18:00/);
  assert.match(m.items()[1].textContent, /이름 일치/);
  assert.equal(m.text('empty'), '');
  assert.equal(m.text('warn'), '');
  assert.equal(m.root.nextElementSibling.id, 'divPopupInfo');
});
await ta('알아보는 자리가 없으면 붙이지도 훑지도 않는다', async () => {
  const rooms = fakeScan('room');
  const m = await mount({ doc: homeDoc('<html><body><div>다른 화면</div></body></html>'), rooms });
  assert.equal(m.ctl, null);
  assert.equal(m.root, null);
  assert.equal(rooms.calls.length, 0);
});

console.log('담긴 것을 쓴다');
const cached = {
  at: NOW - 60_000, start: TODAY, days: MONTH_DAYS, name: '',
  items: [{ kind: 'room', why: 'button', from: { date: TODAY, minutes: 600 }, to: { date: TODAY, minutes: 660 }, room: '제3회의실', title: '담긴 것', status: '' }],
  skippedDates: [], unread: [], failed: [],
};
await ta('신선하면 훑지 않고 그대로 그린다', async () => {
  const rooms = fakeScan('room');
  const m = await mount({ storage: fakeStorage({ [CACHE_KEY]: cached }), rooms });
  assert.equal(rooms.calls.length, 0);
  assert.equal(m.items().length, 1);
  assert.match(m.items()[0].textContent, /담긴 것/);
  assert.match(m.text('note'), /1분 전 읽음/);
});
await ta('묵었으면 먼저 그려 놓고 다시 훑어 바꿔 끼운다', async () => {
  const doc = homeDoc();
  let seen = null;
  const rooms = fakeScan('room', { [TODAY]: day('room', TODAY, [room({ mine: true, title: '새로 읽은 것' })]) }, {
    onCall: () => {
      seen = {
        items: doc.querySelectorAll('li.krs-mine-item').length,
        note: doc.querySelector('[data-role="note"]').textContent,
      };
    },
  });
  const m = await mount({ doc, storage: fakeStorage({ [CACHE_KEY]: { ...cached, at: NOW - STALE_MS - 1 } }), rooms });
  assert.equal(seen.items, 1, '훑기 시작 전에 담긴 것이 먼저 보여야 한다');
  assert.match(seen.note, /훑는 중/);
  assert.equal(rooms.calls.length, 1);
  assert.match(m.items()[0].textContent, /새로 읽은 것/);
  assert.equal(m.storage.data[CACHE_KEY].at, NOW);
});
await ta('이름이 바뀌면 담긴 것을 믿지 않는다', async () => {
  const rooms = fakeScan('room');
  await mount({ storage: fakeStorage({ [CACHE_KEY]: cached, myName: '홍길동' }), rooms });
  assert.equal(rooms.calls.length, 1);
});
await ta('기간 설정이 바뀌면 그 기간을 훑는다', async () => {
  const rooms = fakeScan('room');
  await mount({ storage: fakeStorage({ [CACHE_KEY]: cached, spanDays: '7' }), rooms });
  assert.equal(rooms.calls.length, 1);
  assert.equal(rooms.calls[0].length, 7);
});
await ta('새로고침 버튼은 담긴 것을 버리고 다시 훑는다', async () => {
  const rooms = fakeScan('room');
  const m = await mount({ storage: fakeStorage({ [CACHE_KEY]: cached }), rooms });
  assert.equal(rooms.calls.length, 0);
  m.root.querySelector('[data-act="refresh"]').click();
  await tick();
  assert.equal(rooms.calls.length, 1);
});

console.log('못 읽은 날은 빼고 말한다');
await ta('확신 없는 날은 제외하고 몇 일인지 적는다', async () => {
  const d2 = '2026-09-18';
  const rooms = fakeScan('room', { [d2]: day('room', d2, [], false, '달력은 3건인데 표에서 0건') });
  const m = await mount({ rooms });
  assert.match(m.text('warn'), /1일은 확인 불가라 제외/);
  assert.match(m.text('empty'), /찾지 못했습니다/);
  assert.doesNotMatch(m.text('empty'), /없습니다/);
});
await ta('한쪽 훑기가 죽으면 실패 이유와 못 읽은 날 수를 적고, 결과는 짧게만 믿는다', async () => {
  const rooms = fakeScan('room', { [TODAY]: day('room', TODAY, [room({ mine: true })]) });
  const cars = fakeScan('car', {}, { fail: new Error('HTTP 500') });
  const m = await mount({ rooms, cars });
  assert.equal(m.items().length, 1, '읽은 회의실 예약은 보여야 한다');
  assert.match(m.text('warn'), /차량 훑기 실패: HTTP 500/);
  assert.match(m.text('warn'), /30일은 아예 읽지 못했습니다/);
  const saved = m.storage.data[CACHE_KEY];
  assert.equal(saved.failed.length, 1);
  assert.ok(cacheFresh(saved, NOW + PARTIAL_STALE_MS - 1000));
  assert.ok(!cacheFresh(saved, NOW + PARTIAL_STALE_MS + 1000));
});
await ta('이름이 없으면 넣으라고 한다', async () => {
  const m = await mount();
  assert.match(m.text('warn'), /이름을 넣으면/);
});
await ta('한 날도 못 읽었고 로그인이 끊긴 것이면 그 사실을 말하고 담지 않는다', async () => {
  const err = new AuthError('로그인이 필요합니다. eclass 에 로그인한 뒤 다시 조회하세요.');
  const m = await mount({ rooms: fakeScan('room', {}, { fail: err }), cars: fakeScan('car', {}, { fail: err }) });
  assert.match(m.text('warn'), /로그인이 필요합니다/);
  assert.equal(m.storage.data[CACHE_KEY], undefined);
  assert.equal(m.items().length, 0);
});
await ta('한 날도 못 읽었지만 담긴 것이 있으면 그것을 보여주고 언제 것인지 말한다', async () => {
  const err = new Error('응답이 20초 안에 오지 않았습니다.');
  const m = await mount({
    storage: fakeStorage({ [CACHE_KEY]: { ...cached, at: NOW - STALE_MS - 1 } }),
    rooms: fakeScan('room', {}, { fail: err }), cars: fakeScan('car', {}, { fail: err }),
  });
  assert.equal(m.items().length, 1);
  assert.match(m.text('warn'), /읽어 둔 것입니다/);
  assert.match(m.text('warn'), /응답이 20초/);
});

console.log('패널과 주고받기');
await ta('패널이 캐시를 지우면(예약·취소 뒤) 다시 훑는다', async () => {
  const rooms = fakeScan('room');
  const m = await mount({ storage: fakeStorage({ [CACHE_KEY]: cached }), rooms });
  assert.equal(rooms.calls.length, 0);
  await m.storage.remove(CACHE_KEY);
  await tick(30);
  assert.equal(rooms.calls.length, 1);
});
await ta('내 이름·예약 기록·기간이 바뀌어도 다시 훑는다', async () => {
  const rooms = fakeScan('room');
  const m = await mount({ storage: fakeStorage({ [CACHE_KEY]: cached }), rooms });
  await m.storage.set({ myName: '홍길동' });
  await tick(30);
  assert.equal(rooms.calls.length, 1);
});
await ta('알림이 몰려오면 모아서 한 번만 훑는다', async () => {
  const rooms = fakeScan('room');
  const m = await mount({ storage: fakeStorage({ [CACHE_KEY]: cached }), rooms });
  await m.storage.remove(CACHE_KEY);
  await m.storage.set({ justBooked: [] });
  await tick(30);
  assert.equal(rooms.calls.length, 1);
});
await ta('안 보이는 탭은 보일 때 훑는다', async () => {
  let shown = false;
  const rooms = fakeScan('room');
  const m = await mount({ storage: fakeStorage({ [CACHE_KEY]: cached }), rooms, visible: () => shown });
  await m.storage.remove(CACHE_KEY);
  await tick(30);
  assert.equal(rooms.calls.length, 0, '안 보이는데 훑었다');
  shown = true;
  m.doc.dispatchEvent(new m.doc.defaultView.Event('visibilitychange'));
  await tick(30);
  assert.equal(rooms.calls.length, 1);
});
await ta('한 건을 누르면 날짜·종류를 남기고 패널을 연다', async () => {
  const rooms = fakeScan('room', { [TODAY]: day('room', TODAY, [room({ mine: true })]) });
  const cars = fakeScan('car', {
    '2026-09-20': day('car', '2026-09-20', [{ date: '2026-09-20', room: '카니발', start: 540, end: 600, owner: '', mine: true }]),
  });
  const m = await mount({ rooms, cars });
  m.items()[1].click();
  await tick();
  assert.deepEqual(m.storage.data[JUMP_KEY], { date: '2026-09-20', mode: 'car', at: NOW });
  assert.equal(m.panelCalls.length, 1);
});
await ta('패널 열기 버튼', async () => {
  const m = await mount();
  m.root.querySelector('[data-act="panel"]').click();
  await tick();
  assert.equal(m.panelCalls.length, 1);
});
await ta('패널을 못 열면 어떻게 열지 말한다', async () => {
  const m = await mount({ openPanel: async () => ({ ok: false, error: 'no gesture' }) });
  m.root.querySelector('[data-act="panel"]').click();
  await tick();
  assert.match(m.text('warn'), /툴바의 확장 아이콘/);
});

console.log('켜고 끄기 (패널 머리의 체크박스)');
t('값이 없으면 켠 것, false 일 때만 끈 것', () => {
  assert.equal(homeEnabled(undefined), true);
  assert.equal(homeEnabled(true), true);
  assert.equal(homeEnabled(false), false);
});

/** 설정을 따라 붙이는 쪽(startHome)을 가짜로 돌린다. wait:false 면 첫 조회를 기다리지 않는다. */
async function start(init = {}, { rooms = fakeScan('room'), cars = fakeScan('car'), wait = true } = {}) {
  const storage = fakeStorage(init);
  const doc = homeDoc();
  const started = startHome(doc, {
    storage, onChanged: storage.onChanged, now: () => NOW, today: () => TODAY,
    scanRooms: rooms, scanCars: cars, visible: () => true, debounceMs: 5,
    openPanel: async () => ({ ok: true }),
  });
  const ctl = wait ? await started : null;
  return {
    ctl, started, doc, storage, rooms, cars,
    root: () => doc.getElementById(ROOT_ID),
    count: () => doc.querySelectorAll(`#${ROOT_ID}`).length,
  };
}

await ta('설정이 없으면 켠 것으로 보고 붙인다', async () => {
  const s = await start();
  assert.ok(s.root());
  assert.equal(s.rooms.calls.length, 1);
});
await ta('꺼져 있으면 붙이지도 훑지도 않는다', async () => {
  const s = await start({ [ENABLE_KEY]: false });
  assert.equal(s.root(), null);
  assert.equal(s.ctl.card, null);
  assert.equal(s.rooms.calls.length, 0);
  assert.equal(s.cars.calls.length, 0);
});
await ta('끄면 열려 있는 홈에서 카드가 곧바로 사라진다', async () => {
  const s = await start({ [CACHE_KEY]: cached });
  assert.ok(s.root());
  await s.storage.set({ [ENABLE_KEY]: false });
  assert.equal(s.root(), null);
  assert.equal(s.ctl.card, null);
});
await ta('끈 뒤에는 패널이 캐시를 지워도 훑지 않는다', async () => {
  const s = await start({ [CACHE_KEY]: cached });
  await s.storage.set({ [ENABLE_KEY]: false });
  await s.storage.remove(CACHE_KEY);
  await s.storage.set({ myName: '홍길동' });
  await tick(30);
  assert.equal(s.rooms.calls.length, 0);
  assert.equal(s.storage.listenerCount(), 1, '카드가 듣던 것을 떼지 않았다');
});
await ta('다시 켜면 새로고침 없이 붙는다 (담긴 것이 신선하면 훑지 않고)', async () => {
  const s = await start({ [ENABLE_KEY]: false, [CACHE_KEY]: cached });
  await s.storage.set({ [ENABLE_KEY]: true });
  await tick();
  assert.ok(s.root());
  assert.equal(s.root().querySelectorAll('li.krs-mine-item').length, 1);
  assert.equal(s.rooms.calls.length, 0);
});
await ta('켜기를 거듭 받아도 카드는 하나', async () => {
  const s = await start({ [CACHE_KEY]: cached });
  await s.storage.set({ [ENABLE_KEY]: true });
  await s.storage.set({ [ENABLE_KEY]: true });
  await tick();
  assert.equal(s.count(), 1);
});
await ta('끄고 켜기를 빠르게 반복해도 카드는 하나', async () => {
  const s = await start({ [CACHE_KEY]: cached });
  for (const on of [false, true, false, true]) await s.storage.set({ [ENABLE_KEY]: on });
  await tick();
  assert.equal(s.count(), 1);
});
await ta('훑는 도중에 끄면 남은 날은 읽지 않고, 반쯤 읽은 것을 담지 않는다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const rooms = fakeScan('room', {}, { gate, pauseAfter: 3 });
  const s = await start({}, { rooms, wait: false });
  await tick();
  assert.equal(rooms.fed, 3);
  assert.ok(s.root(), '훑는 동안에도 카드는 떠 있어야 한다');

  await s.storage.set({ [ENABLE_KEY]: false });
  assert.equal(s.root(), null, '끄자마자 사라져야 한다');
  release();
  const ctl = await s.started;
  await tick();

  assert.equal(rooms.fed, 3, '끈 뒤에도 회의실을 더 읽었다');
  assert.equal(s.cars.calls.length, 0, '끈 뒤에 차량 바퀴를 돌았다');
  assert.equal(s.storage.data[CACHE_KEY], undefined, '반쯤 읽은 것을 담았다');
  assert.equal(ctl.card, null);
  assert.equal(s.root(), null, '끝난 훑기가 카드를 되살렸다');
});
await ta('stop 하면 카드를 떼고 설정 변화도 더 듣지 않는다', async () => {
  const s = await start({ [CACHE_KEY]: cached });
  assert.equal(s.storage.listenerCount(), 2);
  s.ctl.stop();
  assert.equal(s.root(), null);
  assert.equal(s.storage.listenerCount(), 0);
  await s.storage.set({ [ENABLE_KEY]: true });
  assert.equal(s.root(), null);
});

console.log('진짜 훑기도 멈춤 신호를 본다');
{
  const { window } = new JSDOM('');
  globalThis.DOMParser = window.DOMParser;
  const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const serve = (html) => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push(init?.method || 'GET');
      return {
        ok: true, status: 200, statusText: '', url: String(url),
        headers: { get: () => 'text/html; charset=utf-8' },
        arrayBuffer: async () => new TextEncoder().encode(html).buffer,
      };
    };
    return calls;
  };
  const dates = ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'];

  for (const [label, scan, file] of [
    ['회의실', scanDays, 'list-2026-09-16.html'],
    ['차량', scanCarDays, 'rentcar-2026-09-16.html'],
  ]) {
    await ta(`${label}: 처음부터 멈춰 있으면 목록 한 번만 받고 날짜는 읽지 않는다`, async () => {
      const calls = serve(fixture(file));
      const ac = new AbortController();
      ac.abort();
      const out = await scan(dates, () => {}, { signal: ac.signal });
      assert.equal(out.length, 0);
      assert.deepEqual(calls, ['GET']);
    });
    await ta(`${label}: 도중에 멈추면 거기까지만 읽는다`, async () => {
      serve(fixture(file));
      const ac = new AbortController();
      const seen = [];
      const out = await scan(dates, () => {}, {
        signal: ac.signal,
        onDay: (d) => { seen.push(d.date); if (seen.length === 1) ac.abort(); },
      });
      assert.deepEqual(out.map((d) => d.date), ['2026-09-16']);
      assert.deepEqual(seen, ['2026-09-16']);
    });
  }
}

console.log('확장 배선');
{
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'));
  const boot = fs.readFileSync(new URL('home.js', root), 'utf8');
  const bg = fs.readFileSync(new URL('background.js', root), 'utf8');
  t('홈에 콘텐츠 스크립트가 붙는다', () => {
    const cs = (manifest.content_scripts || []).find((c) => c.js.includes('home.js'));
    assert.ok(cs, 'content_scripts 에 home.js 가 없다');
    assert.ok(cs.matches.some((m) => m.startsWith('https://eclass.krs.co.kr/')));
  });
  t('콘텐츠 스크립트가 src/ 모듈을 불러올 수 있다(web_accessible_resources)', () => {
    const war = manifest.web_accessible_resources || [];
    assert.ok(war.some((w) => w.resources.includes('src/*.js') && w.matches.includes('https://eclass.krs.co.kr/*')));
  });
  t('시동 스크립트는 src/home.js 를 동적으로 불러온다', () => assert.match(boot, /getURL\('src\/home\.js'\)/));
  t('시동 스크립트는 설정을 따르는 startHome 을 부른다', () => assert.match(boot, /startHome\(document\)/));
  t('시동 스크립트는 홈 경로에서만 붙인다', () => assert.match(boot, /eclassver4/i));
  t('배경이 패널 열기 부탁을 받는다', () => {
    assert.match(bg, /openSidePanel/);
    assert.match(bg, /sidePanel\.open/);
  });
}

console.log(`\n통과 ${pass}건`);
