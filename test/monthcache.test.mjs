// 한 달 미리 훑기가 기대는 두 가지를 확인한다.
//
//   1) 보관소가 **언제 읽었는지**로 신선/묵음을 가른다 — 묵은 현황을 지금 것처럼 보여주면
//      이미 찬 칸을 "예약 가능"으로 칠하게 된다.
//   2) 훑기가 남기는 하루 기록만으로 **격자를 그릴 수 있다** — 예약 목록만 담으면
//      빈 회의실이 몇 곳인지 알 수 없어 캐시가 쓸모없어진다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

import { createDayStore, MONTH_DAYS, STALE_MS } from '../src/monthcache.js';
import { extractSchedule, parseRooms, parseSelectedRegion, buildGrid } from '../src/parse.js';
import { extractCars } from '../src/rentcar.js';
import { datesFrom } from '../src/mine.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const room = (date, extra = {}) => ({ kind: 'room', date, reservations: [], confident: true, reason: '', ...extra });
const car = (date, extra = {}) => ({ kind: 'car', date, reservations: [], confident: true, reason: '', ...extra });

console.log('보관소 기본');
{
  const store = createDayStore();
  store.put(room('2026-09-16', { rooms: [{ name: '제1회의실' }] }));

  t('담은 것을 꺼낸다', () => assert.equal(store.get('room', '2026-09-16').rooms.length, 1));
  t('읽은 시각이 붙는다', () => assert.ok(store.get('room', '2026-09-16').at > 0));
  t('없는 날은 null', () => assert.equal(store.get('room', '2026-09-17'), null));
  t('종류가 다르면 다른 칸', () => assert.equal(store.get('car', '2026-09-16'), null));
  t('kind/date 없는 것은 안 담는다', () => {
    assert.equal(store.put({ date: '2026-09-16' }), null);
    assert.equal(store.put(null), null);
    assert.equal(store.size(), 1);
  });
}

console.log('신선도 — 묵으면 다시 읽어야 한다');
{
  let now = 1_000_000;
  const store = createDayStore({ staleMs: 60_000, now: () => now });
  store.put(room('2026-09-16'));
  store.put(car('2026-09-16'));

  t('방금 담은 건 신선하다', () => assert.equal(store.fresh('room', '2026-09-16'), true));
  t('신선하면 훑을 것이 없다', () => assert.deepEqual(store.missing(['2026-09-16']), []));
  t('신선하면 covers 가 참', () => assert.equal(store.covers(['2026-09-16']), true));

  now += 61_000;
  t('묵으면 다시 훑을 날이 된다', () => assert.deepEqual(store.missing(['2026-09-16']), ['2026-09-16']));
  t('묵어도 꺼내 볼 수는 있다 (언제 읽었는지와 함께)', () =>
    assert.ok(store.get('room', '2026-09-16').at > 0));
  t('기본 신선도는 10분', () => assert.equal(STALE_MS, 10 * 60_000));
}

console.log('회의실·차량 둘 다 있어야 그 날을 읽은 것이다');
{
  const store = createDayStore();
  store.put(room('2026-09-16'));

  t('한쪽만 있으면 아직 덜 읽었다', () =>
    assert.deepEqual(store.missing(['2026-09-16']), ['2026-09-16']));
  t('covers 도 거짓', () => assert.equal(store.covers(['2026-09-16']), false));

  store.put(car('2026-09-16'));
  t('둘 다 담기면 끝', () => assert.deepEqual(store.missing(['2026-09-16']), []));
  t('종류를 찍어 물으면 그것만 본다', () =>
    assert.deepEqual(store.missing(['2026-09-16'], ['room']), []));
}

console.log('범위로 꺼내기');
{
  const store = createDayStore();
  const dates = datesFrom('2026-09-16', 3);
  store.put(room(dates[0]));
  store.put(car(dates[0]));
  store.put(room(dates[2]));

  t('담긴 것만 날짜 순으로', () => assert.deepEqual(
    store.list(dates).map((d) => d.date + ' ' + d.kind),
    ['2026-09-16 room', '2026-09-16 car', '2026-09-18 room']));
  t('빈 날은 그냥 빠진다', () => assert.equal(store.list([dates[1]]).length, 0));
  t('안 읽은 날을 셀 수 있다', () =>
    assert.deepEqual(store.missing(dates), [dates[1], dates[2]]));
}

console.log('가장 오래전에 읽은 시각 — 화면에 "언제 읽은 것"인지 말하는 데 쓴다');
{
  let now = 5_000;
  const store = createDayStore({ now: () => now });
  store.put(room('2026-09-16'));
  now = 9_000;
  store.put(room('2026-09-17'));

  t('둘 중 오래된 쪽', () => assert.equal(store.oldest(datesFrom('2026-09-16', 2), ['room']), 5_000));
  t('담긴 게 없으면 0', () => assert.equal(store.oldest(['2026-10-01']), 0));
}

console.log('예약·취소로 낡아진 날은 버린다');
{
  const store = createDayStore();
  store.put(room('2026-09-16'));
  store.put(car('2026-09-16'));

  store.drop(['2026-09-16'], ['room']);
  t('찍은 종류만 버린다', () => {
    assert.equal(store.get('room', '2026-09-16'), null);
    assert.ok(store.get('car', '2026-09-16'));
  });

  store.drop(['2026-09-16']);
  t('종류를 안 찍으면 둘 다', () => assert.equal(store.size(), 0));
}

console.log('훑기가 남기는 하루로 격자를 그릴 수 있어야 한다 (실제 회의실 페이지)');
{
  const html = fs.readFileSync(new URL('./fixtures/list-2026-09-16.html', import.meta.url), 'utf8');
  const doc = new JSDOM(html).window.document;
  const DATE = '2026-09-16';
  const hours = { start: 8, end: 20 };

  // scanDays 가 하루에 담아 두는 것과 같은 모양
  const region = parseSelectedRegion(doc);
  const { rooms, source: roomSource } = parseRooms(doc);
  const sch = extractSchedule(doc, DATE);

  const store = createDayStore();
  store.put({
    kind: 'room', date: DATE, reservations: sch.reservations,
    rooms, roomSource, region, regions: ['부산', '서울'],
    confident: sch.confident, reason: sch.reason,
  });

  const rec = store.get('room', DATE);
  t('방 목록이 함께 담긴다', () => assert.ok(rec.rooms.length > 0));
  t('지역이 함께 담긴다', () => assert.equal(rec.region, '부산'));

  // 캐시만 보고 격자를 만든다 (sidepanel 의 cachedDay 가 하는 일)
  const here = rec.reservations.filter((r) => !r.region || r.region === rec.region);
  const grid = buildGrid(rec.rooms, here, hours, { confident: rec.confident });
  const live = buildGrid(rooms, here, hours, { confident: sch.confident });

  t('캐시로 만든 격자가 그대로 나온다', () => assert.deepEqual(
    grid.map((r) => r.slots.map((s) => s.state).join('')),
    live.map((r) => r.slots.map((s) => s.state).join(''))));
  t('사용 중인 칸이 실제로 있다', () =>
    assert.ok(grid.some((r) => r.slots.some((s) => s.state === 'busy'))));
  t('담긴 예약에는 전 지역이 들어 있다', () =>
    assert.ok(rec.reservations.length >= here.length));
}

console.log('차량도 마찬가지 (실제 차량 페이지)');
{
  const html = fs.readFileSync(new URL('./fixtures/rentcar-2026-09-16.html', import.meta.url), 'utf8');
  const doc = new JSDOM(html).window.document;
  const DATE = '2026-09-16';
  const got = extractCars(doc, DATE);

  const store = createDayStore();
  store.put({
    kind: 'car', date: DATE, reservations: got.reservations,
    rooms: got.cars, roomSource: 'table', confident: got.ok, reason: got.reason,
  });

  const rec = store.get('car', DATE);
  t('차량 목록이 함께 담긴다', () => assert.ok(rec.rooms.length > 0));
  t('캐시만으로 차량 격자가 나온다', () => {
    const grid = buildGrid(rec.rooms, rec.reservations, { start: 8, end: 20 }, { confident: rec.confident });
    assert.equal(grid.length, rec.rooms.length);
    assert.ok(grid.some((r) => r.slots.some((s) => s.state === 'busy')));
  });
}

console.log('미리 훑는 범위');
t('한 달은 30일', () => assert.equal(MONTH_DAYS, 30));
t('오늘부터 30일을 센다', () => {
  const dates = datesFrom('2026-09-16', MONTH_DAYS);
  assert.equal(dates.length, 30);
  assert.equal(dates[0], '2026-09-16');
  assert.equal(dates[29], '2026-10-15');
});

console.log('\n통과 ' + pass + '건');
