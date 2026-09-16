import assert from 'node:assert/strict';
import { parseTime, parseTimeRange, parseDate, fmtTime, buildGrid, findOverlap, telerikDateFields } from '../src/parse.js';
import { FORM } from '../src/config.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('시간 파싱');
t('HH:MM', () => assert.equal(parseTime('09:30'), 570));
t('한글 시', () => assert.equal(parseTime('14시'), 840));
t('4자리', () => assert.equal(parseTime('0900'), 540));
t('3자리', () => assert.equal(parseTime('930'), 570));
t('시간만', () => assert.equal(parseTime('15'), 900));
t('빈 값', () => assert.equal(parseTime(''), null));
t('숫자 아님', () => assert.equal(parseTime('미정'), null));

console.log('범위 파싱');
t('물결', () => assert.deepEqual(parseTimeRange('09:00 ~ 11:00'), { start: 540, end: 660 }));
t('하이픈', () => assert.deepEqual(parseTimeRange('13:00-14:30'), { start: 780, end: 870 }));
t('한글 시 범위', () => assert.deepEqual(parseTimeRange('9시 ~ 10시'), { start: 540, end: 600 }));
t('범위 아님', () => assert.equal(parseTimeRange('09:00'), null));

console.log('날짜 파싱');
t('하이픈', () => assert.equal(parseDate('2026-09-16'), '2026-09-16'));
t('점', () => assert.equal(parseDate('2026.9.6'), '2026-09-06'));
t('한글', () => assert.equal(parseDate('2026년 9월 16일'), '2026-09-16'));
t('8자리', () => assert.equal(parseDate('20260916'), '2026-09-16'));

console.log('포맷');
t('fmtTime', () => assert.equal(fmtTime(570), '09:30'));
t('fmtTime 정시', () => assert.equal(fmtTime(540), '09:00'));

console.log('슬롯 격자');
const rooms = [{ value: 'A', name: '대회의실' }, { value: 'B', name: '소회의실' }];
const res = [
  { room: '대회의실', start: 600, end: 720, title: '주간회의' },  // 10:00~12:00
  { room: '소회의실', start: 810, end: 840, title: '면담' },      // 13:30~14:00
];
const grid = buildGrid(rooms, res, { start: 9, end: 18 }, { confident: true });

t('회의실 수', () => assert.equal(grid.length, 2));
t('슬롯 수 9시간', () => assert.equal(grid[0].slots.length, 9));
t('09시 비어있음', () => assert.equal(grid[0].slots[0].state, 'free'));
t('10시 사용중', () => assert.equal(grid[0].slots[1].state, 'busy'));
t('11시 사용중', () => assert.equal(grid[0].slots[2].state, 'busy'));
t('12시 비어있음', () => assert.equal(grid[0].slots[3].state, 'free'));
t('예약자 표기', () => assert.equal(grid[0].slots[1].by, '주간회의'));
t('부분 점유도 사용중', () => assert.equal(grid[1].slots[4].state, 'busy'));
t('인접 슬롯은 비어있음', () => assert.equal(grid[1].slots[5].state, 'free'));

console.log('확신하지 못할 때는 빈 칸으로 보이면 안 된다');
const unsure = buildGrid(rooms, [], { start: 9, end: 12 }, { confident: false });
t('모두 unknown', () => assert.ok(unsure[0].slots.every((s) => s.state === 'unknown')));
t('free 가 하나도 없음', () => assert.ok(!unsure[0].slots.some((s) => s.state === 'free')));

const unsureWithSome = buildGrid(rooms, res, { start: 9, end: 18 }, { confident: false });
t('읽힌 예약은 busy 유지', () => assert.equal(unsureWithSome[0].slots[1].state, 'busy'));
t('나머지는 unknown', () => assert.equal(unsureWithSome[0].slots[0].state, 'unknown'));

// 글자 칸만 보내면 서버가 ViewState 의 오늘 날짜를 써버려 엉뚱한 날에 예약된다.
console.log('예약 폼 날짜 필드');
const df = telerikDateFields('2026-09-19');
t('글자 칸 둘 다', () => {
  assert.equal(df[FORM.date], '2026-09-19');
  assert.equal(df[FORM.dateInput], '2026-09-19');
});
t('ClientState 가 비어 있지 않음', () => assert.ok(df[FORM.dateInputClientState].length > 10));
t('Telerik 날짜 표기', () => {
  const cs = JSON.parse(df[FORM.dateInputClientState]);
  assert.equal(cs.validationText, '2026-09-19-00-00-00');
  assert.equal(cs.valueAsString, '2026-09-19-00-00-00');
  assert.equal(cs.lastSetTextBoxValue, '2026-09-19');
});
t('달력 선택일', () => assert.deepEqual(JSON.parse(df[FORM.dateCalendarSelected]), [[2026, 9, 19]]));

console.log('예약 확인(재조회 검증용)');
t('걹치면 찾음', () => assert.ok(findOverlap(res, '대회의실', 600, 660)));
t('끝닿으면 아님', () => assert.equal(findOverlap(res, '대회의실', 720, 780), null));
t('다른 방은 아님', () => assert.equal(findOverlap(res, '소회의실', 600, 660), null));

console.log(`
통과 ${pass}건`);

const { freeRuns } = await import('../src/search.js');
console.log('빈 구간 찾기');
const S = (spec) => [...spec].map((c) => ({ state: c === '.' ? 'free' : c === '#' ? 'busy' : 'unknown' }));
t('전부 비면 한 구간', () => assert.deepEqual(freeRuns(S('....'), 1), [{ from: 0, to: 3 }]));
t('가운데가 막히면 둘', () => assert.deepEqual(freeRuns(S('..#..'), 1), [{ from: 0, to: 1 }, { from: 3, to: 4 }]));
t('끝까지 비어도 닫힘', () => assert.deepEqual(freeRuns(S('#...'), 1), [{ from: 1, to: 3 }]));
t('최소 길이 미달은 제외', () => assert.deepEqual(freeRuns(S('.#...'), 2), [{ from: 2, to: 4 }]));
t('확인 불가는 빈 칸이 아님', () => assert.deepEqual(freeRuns(S('.?.'), 1), [{ from: 0, to: 0 }, { from: 2, to: 2 }]));
t('전부 막히면 없음', () => assert.deepEqual(freeRuns(S('###'), 1), []));

console.log('내 예약 표시 (방금 넣은 건 기억해서 표시)');
// sidepanel 의 markMine 과 같은 규칙: 같은 날짜·같은 방·시간이 겹치면 내 것
const overlaps = (b, r) => b.date === r.date && b.room === r.room && b.start < r.end && b.end > r.start;

const booked = { mode: 'room', date: '2026-09-17', room: '제4회의실(11층)-12석', start: 480, end: 540 };
const list = [
  { date: '2026-09-17', room: '제4회의실(11층)-12석', start: 480, end: 540, mine: false },
  { date: '2026-09-17', room: '제4회의실(11층)-12석', start: 540, end: 600, mine: false },
  { date: '2026-09-17', room: '제1회의실(11층)-56석', start: 480, end: 540, mine: false },
  { date: '2026-09-18', room: '제4회의실(11층)-12석', start: 480, end: 540, mine: false },
];
t('같은 방·같은 시간은 내 것', () => assert.equal(overlaps(booked, list[0]), true));
t('같은 방 다른 시간은 아님', () => assert.equal(overlaps(booked, list[1]), false));
t('다른 방은 아님', () => assert.equal(overlaps(booked, list[2]), false));
t('다른 날짜는 아님', () => assert.equal(overlaps(booked, list[3]), false));
t('걸쳐 있으면 내 것', () =>
  assert.equal(overlaps(booked, { date: '2026-09-17', room: booked.room, start: 510, end: 600 }), true));
t('끝이 맞닿으면 아님', () =>
  assert.equal(overlaps(booked, { date: '2026-09-17', room: booked.room, start: 540, end: 600 }), false));


console.log('연장 안내: 가장 가까운 빈 칸 찾기');
// sidepanel 의 nextFreeAfter 와 같은 규칙: 사용 중인 칸을 만나면 멈춘다
function nextFreeAfter(slots, slot) {
  for (let i = slot + 1; i < slots.length; i++) {
    if (slots[i].state === 'free') return i;
    if (slots[i].state === 'busy') break;
  }
  for (let i = slot - 1; i >= 0; i--) {
    if (slots[i].state === 'free') return i;
    if (slots[i].state === 'busy') break;
  }
  return null;
}
const S2 = (spec) => [...spec].map((c) => ({ state: c === '.' ? 'free' : c === '#' ? 'busy' : 'unknown' }));
t('뒤쪽 빈 칸을 먼저 본다', () => assert.equal(nextFreeAfter(S2('.#..'), 1), 2));
t('뒤가 막히면 앞을 본다', () => assert.equal(nextFreeAfter(S2('.##'), 1), 0));
t('양쪽 다 막히면 없음', () => assert.equal(nextFreeAfter(S2('###'), 1), null));
t('연속 예약 사이는 건너뛰지 않는다', () => assert.equal(nextFreeAfter(S2('#.##.'), 2), 1));

console.log(`\n총 통과 ${pass}건`);
