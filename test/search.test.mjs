// "글로 예약" 흐름 검증: 문장 해석 → 날짜 훑기 → 예약 가능 목록.
import assert from 'node:assert/strict';
import { parseLocal } from '../src/nlq.js';
import { findSlots, MAX_DAYS, widenHours } from '../src/search.js';
import { buildGrid } from '../src/parse.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const ta = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };

const TODAY = '2026-09-16';   // 수요일

/* ------------------------------------------------ 규칙 해석기 */

console.log('문장 해석 (API 키 없이)');
{
  const f = parseLocal('9월 20일부터 27일 사이 8시부터 12시까지 10명', TODAY);
  t('날짜 범위', () => { assert.equal(f.dateFrom, '2026-09-20'); assert.equal(f.dateTo, '2026-09-27'); });
  t('시간대', () => { assert.equal(f.hourFrom, 8); assert.equal(f.hourTo, 12); });
  t('인원', () => assert.equal(f.minSeats, 10));
  t('추정 아님', () => assert.equal(f.guessed, false));
}
{
  const f = parseLocal('내일 오후에 회의실 아무거나', TODAY);
  t('내일', () => { assert.equal(f.dateFrom, '2026-09-17'); assert.equal(f.dateTo, '2026-09-17'); });
  t('오후 = 12~18', () => { assert.equal(f.hourFrom, 12); assert.equal(f.hourTo, 18); });
  t('인원 없음', () => assert.equal(f.minSeats, null));
}
{
  const f = parseLocal('다음 주 화요일 2시간짜리 서울 회의실', TODAY);
  t('다음 주 평일 범위', () => { assert.equal(f.dateFrom, '2026-09-21'); assert.equal(f.dateTo, '2026-09-25'); });
  t('2시간 연속', () => assert.equal(f.minHours, 2));
  t('서울', () => assert.equal(f.region, '서울'));
}
{
  const f = parseLocal('그냥 회의실 예약 가능한거 조회해줘', TODAY);
  t('오늘 기본값', () => { assert.equal(f.dateFrom, TODAY); assert.equal(f.dateTo, TODAY); });
  t('업무시간 기본값', () => { assert.equal(f.hourFrom, 9); assert.equal(f.hourTo, 18); });
  t('추정했다고 알림', () => assert.equal(f.guessed, true));
}
{
  const f = parseLocal('9/22 오전 부산 6명', TODAY);
  t('슬래시 날짜', () => assert.equal(f.dateFrom, '2026-09-22'));
  t('오전 = 9~12', () => { assert.equal(f.hourFrom, 9); assert.equal(f.hourTo, 12); });
  t('부산', () => assert.equal(f.region, '부산'));
}
{
  const f = parseLocal('오늘 14시부터 16시까지', TODAY);
  t('오후 표기 없어도 24시간제', () => { assert.equal(f.hourFrom, 14); assert.equal(f.hourTo, 16); });
}
{
  const f = parseLocal('이번 주 8시~12시', TODAY);
  t('이번 주 월~금', () => { assert.equal(f.dateFrom, '2026-09-14'); assert.equal(f.dateTo, '2026-09-18'); });
}

/* ------------------------------------------------ 검색 */

const ROOMS = [
  { value: 'A', name: '대회의실', label: '대회의실', seats: 20 },
  { value: 'B', name: '소회의실', label: '소회의실', seats: 4 },
  { value: 'C', name: '강당', label: '강당', seats: null },
];

/** 날짜별 예약을 받아 가짜 조회 함수를 만든다. */
function fakeLoader(byDate, opts = {}) {
  return async (date, hours) => {
    const res = byDate[date] ?? [];
    const confident = !(opts.unsure || []).includes(date);
    if ((opts.throws || []).includes(date)) throw new Error('세션 만료');
    return {
      date, region: '부산', rooms: ROOMS, reservations: res, confident,
      reason: confident ? '' : '표를 읽지 못했습니다.',
      grid: buildGrid(ROOMS, res, hours, { confident }),
    };
  };
}

console.log('예약 가능 목록');
await ta('하루, 예약 없으면 방마다 통으로 빈다', async () => {
  const { results } = await findSlots(
    { dateFrom: TODAY, dateTo: TODAY, hourFrom: 9, hourTo: 12, minSeats: null, minHours: null, region: null },
    () => {}, fakeLoader({}));
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.label === '09:00~12:00'));
});

await ta('예약을 피해 두 조각으로 나뉜다', async () => {
  const { results } = await findSlots(
    { dateFrom: TODAY, dateTo: TODAY, hourFrom: 9, hourTo: 13, minSeats: null, minHours: null, region: null },
    () => {}, fakeLoader({ [TODAY]: [{ room: '대회의실', start: 600, end: 660 }] }));
  const big = results.filter((r) => r.room.name === '대회의실').map((r) => r.label).sort();
  assert.deepEqual(big, ['09:00~10:00', '11:00~13:00']);
});

await ta('인원 조건이 작은 방과 좌석 미상을 걸러낸다', async () => {
  const { results } = await findSlots(
    { dateFrom: TODAY, dateTo: TODAY, hourFrom: 9, hourTo: 12, minSeats: 10, minHours: null, region: null },
    () => {}, fakeLoader({}));
  assert.deepEqual([...new Set(results.map((r) => r.room.name))], ['대회의실']);
});

await ta('연속 시간 조건을 못 채우면 빠진다', async () => {
  const { results } = await findSlots(
    { dateFrom: TODAY, dateTo: TODAY, hourFrom: 9, hourTo: 13, minSeats: null, minHours: 3, region: null },
    () => {}, fakeLoader({ [TODAY]: [{ room: '대회의실', start: 600, end: 660 }] }));
  assert.ok(!results.some((r) => r.room.name === '대회의실'));
  assert.ok(results.some((r) => r.room.name === '소회의실'));
});

await ta('확인 불가인 날은 결과에서 빼고 따로 알린다', async () => {
  const { results, skipped } = await findSlots(
    { dateFrom: '2026-09-16', dateTo: '2026-09-17', hourFrom: 9, hourTo: 12, minSeats: null, minHours: null, region: null },
    () => {}, fakeLoader({}, { unsure: ['2026-09-17'] }));
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].date, '2026-09-17');
  assert.ok(results.every((r) => r.date === '2026-09-16'), '못 읽은 날이 빈자리로 새면 안 된다');
});

await ta('조회가 터진 날도 결과에 섞이지 않는다', async () => {
  const { results, skipped } = await findSlots(
    { dateFrom: '2026-09-16', dateTo: '2026-09-17', hourFrom: 9, hourTo: 12, minSeats: null, minHours: null, region: null },
    () => {}, fakeLoader({}, { throws: ['2026-09-16'] }));
  assert.equal(skipped.length, 1);
  assert.ok(results.every((r) => r.date === '2026-09-17'));
});

await ta('긴 자리가 먼저 온다', async () => {
  const { results } = await findSlots(
    { dateFrom: TODAY, dateTo: TODAY, hourFrom: 9, hourTo: 13, minSeats: null, minHours: null, region: null },
    () => {}, fakeLoader({ [TODAY]: [{ room: '대회의실', start: 600, end: 660 }] }));
  for (let i = 1; i < results.length; i++) assert.ok(results[i - 1].hours >= results[i].hours);
});

await ta(`범위가 길어도 ${MAX_DAYS}일까지만 본다`, async () => {
  const seen = [];
  await findSlots(
    { dateFrom: '2026-09-01', dateTo: '2026-12-31', hourFrom: 9, hourTo: 10, minSeats: null, minHours: null, region: null },
    () => {}, async (date, hours) => { seen.push(date); return fakeLoader({})(date, hours); });
  assert.equal(seen.length, MAX_DAYS);
});

await ta('진행 상황을 날짜마다 알려준다', async () => {
  const seen = [];
  await findSlots(
    { dateFrom: '2026-09-16', dateTo: '2026-09-18', hourFrom: 9, hourTo: 10, minSeats: null, minHours: null, region: null },
    (date, i, n) => seen.push(`${i}/${n} ${date}`), fakeLoader({}));
  assert.deepEqual(seen, ['1/3 2026-09-16', '2/3 2026-09-17', '3/3 2026-09-18']);
});

console.log('문장 → 목록 (이어서)');
await ta('"내일 오후 10명" 이 그대로 조건이 되어 걸러진다', async () => {
  const f = parseLocal('내일 오후 10명', TODAY);
  const { results } = await findSlots(f, () => {}, fakeLoader({}));
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.date === '2026-09-17'));
  assert.ok(results.every((r) => r.room.seats >= 10));
  assert.ok(results.every((r) => r.start >= 12 * 60 && r.end <= 18 * 60));
});

console.log('후보 클릭 시 시간대 넓히기');
t('밖이면 넓힌다', () =>
  assert.deepEqual(widenHours({ start: 9, end: 18 }, 8 * 60, 12 * 60), { start: 8, end: 18 }));
t('닿히면 그대로 둔다', () =>
  assert.deepEqual(widenHours({ start: 8, end: 20 }, 9 * 60, 12 * 60), { start: 8, end: 20 }));
t('뒤쪽도 넓힌다', () =>
  assert.deepEqual(widenHours({ start: 9, end: 18 }, 19 * 60, 21 * 60), { start: 9, end: 21 }));
t('분 단위는 올림해서 덮는다', () =>
  assert.deepEqual(widenHours({ start: 9, end: 18 }, 8 * 60 + 30, 18 * 60 + 10), { start: 8, end: 19 }));

console.log(`\n통과 ${pass}건`);
