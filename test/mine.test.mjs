// "내 예약" 판정과 모으기.
// 여기서 가장 중요한 건 **못 읽은 날을 "예약 없음"으로 넘기지 않는 것**이다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { sameName, mineReason, collectMine, datesFrom } from '../src/mine.js';
import { parseDayCounts } from '../src/parse.js';
import { extractCars } from '../src/rentcar.js';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('이름 비교');
t('같은 이름', () => assert.equal(sameName('홍길동', '홍길동'), true));
t('공백은 무시', () => assert.equal(sameName(' 홍 길동 ', '홍길동'), true));
t('다른 이름', () => assert.equal(sameName('홍길동', '김철수'), false));
t('빈 값끼리는 같지 않다', () => assert.equal(sameName('', ''), false));
t('한쪽만 비어도 아니다', () => assert.equal(sameName('홍길동', ''), false));

console.log('내 예약 판정');
const res = { date: '2026-09-17', room: '미팅룸1(1층)-8석', start: 540, end: 660, owner: '홍길동', mine: false };

t('사이트 버튼이 최우선', () =>
  assert.equal(mineReason({ ...res, mine: true }, {}), 'button'));
t('이름이 같으면 name', () =>
  assert.equal(mineReason(res, { name: '홍길동' }), 'name'));
t('이름을 모르면 안 잡힌다', () =>
  assert.equal(mineReason(res, {}), ''));
t('남의 이름이면 안 잡힌다', () =>
  assert.equal(mineReason(res, { name: '김철수' }), ''));

const booked = [{ mode: 'room', date: '2026-09-17', room: '미팅룸1(1층)-8석', start: 600, end: 620 }];
t('내가 넣은 기록과 겹치면 booked', () =>
  assert.equal(mineReason(res, { booked }), 'booked'));
t('같은 방 다른 시간은 아니다', () =>
  assert.equal(mineReason({ ...res, start: 700, end: 720 }, { booked }), ''));
t('같은 시간 다른 종류는 아니다', () =>
  assert.equal(mineReason(res, { booked, kind: 'car' }), ''));

console.log('모으기');
const day = (over) => ({ kind: 'room', date: '2026-09-17', confident: true, reason: '', reservations: [], ...over });

{
  const days = [day({
    reservations: [
      { ...res, mine: true, title: '주간회의', status: '승인', region: '부산' },
      { ...res, room: '미팅룸2', owner: '김철수', title: '남의 회의' },
    ],
  })];
  const { items, skipped } = collectMine(days, {});
  t('내 것만 남는다', () => assert.equal(items.length, 1));
  t('회의주제', () => assert.equal(items[0].title, '주간회의'));
  t('근거를 남긴다', () => assert.equal(items[0].why, 'button'));
  t('종류', () => assert.equal(items[0].kind, 'room'));
  t('하루짜리는 시작·종료 날짜가 같다', () =>
    assert.equal(items[0].from.date, items[0].to.date));
  t('건너뛴 날 없음', () => assert.equal(skipped.length, 0));
}

console.log('확인 못 한 날은 결과에서 빼고 알린다');
{
  const days = [
    day({ date: '2026-09-17', confident: false, reason: '달력은 3건인데 1건만 읽었습니다.' }),
    day({ date: '2026-09-18', reservations: [{ ...res, date: '2026-09-18', mine: true }] }),
  ];
  const { items, skipped } = collectMine(days, {});
  t('읽은 날 것만 나온다', () => assert.equal(items.length, 1));
  t('못 읽은 날은 따로 알린다', () => assert.equal(skipped.length, 1));
  t('이유도 함께', () => assert.match(skipped[0].reason, /달력은 3건/));
  t('빈 결과를 "예약 없음"이라고 하지 않는다', () => {
    const only = collectMine([days[0]], {});
    assert.equal(only.items.length, 0);
    assert.equal(only.skipped.length, 1);
  });
}

console.log('차량 다중일 예약');
{
  // 09.15~09.18 한 건이 겹치는 날마다 한 번씩 읽힌다. 같은 건으로 묶여야 한다.
  const span = {
    spanStart: { date: '2026-09-15', minutes: 960 },
    spanEnd: { date: '2026-09-18', minutes: 1260 },
    room: '아반테CN74 (181허4360)', owner: '홍길동', title: '내부심사', mine: true,
  };
  const days = [
    { kind: 'car', date: '2026-09-16', confident: true, reservations: [{ ...span, date: '2026-09-16', start: 0, end: 1440 }] },
    { kind: 'car', date: '2026-09-17', confident: true, reservations: [{ ...span, date: '2026-09-17', start: 0, end: 1440 }] },
  ];
  const { items } = collectMine(days, {});
  t('한 건으로 묶인다', () => assert.equal(items.length, 1));
  t('원래 구간을 지킨다', () => {
    assert.equal(items[0].from.date, '2026-09-15');
    assert.equal(items[0].to.date, '2026-09-18');
  });
  t('차량으로 분류', () => assert.equal(items[0].kind, 'car'));
}

console.log('정렬과 날짜 범위');
{
  const days = [
    { kind: 'car', date: '2026-09-18', confident: true, reservations: [{ date: '2026-09-18', room: '차', start: 540, end: 600, mine: true }] },
    day({ date: '2026-09-17', reservations: [{ ...res, date: '2026-09-17', start: 780, mine: true }] }),
    day({ date: '2026-09-17', reservations: [{ ...res, date: '2026-09-17', room: '미팅룸9', start: 540, mine: true }] }),
  ];
  const { items } = collectMine(days, {});
  t('날짜·시간 순', () => assert.deepEqual(
    items.map((i) => `${i.from.date} ${i.from.minutes}`),
    ['2026-09-17 540', '2026-09-17 780', '2026-09-18 540']));
}

t('datesFrom 는 하루씩 센다', () =>
  assert.deepEqual(datesFrom('2026-09-29', 4),
    ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']));
t('datesFrom 길이', () => assert.equal(datesFrom('2026-09-16', 14).length, 14));

console.log('훑기가 기대는 전제 (실제 차량 페이지)');
{
  // scanCarDays 는 두 가지를 달력 건수에 기댄다.
  //   1) 0건인 날은 화면을 옮기지 않고 건너뛴다
  //   2) 건수와 읽은 수가 다르면 그 날을 확인 불가로 본다
  // 둘 다 "차량 달력의 건수 = 그날에 걸치는 예약 수" 라야 성립한다. 실제 페이지로 확인한다.
  const html = fs.readFileSync(new URL('./fixtures/rentcar-2026-09-16.html', import.meta.url), 'utf8');
  const doc = new JSDOM(html).window.document;
  const got = extractCars(doc, '2026-09-16');
  const counts = parseDayCounts(doc);

  t('차량 표를 읽었다', () => assert.equal(got.ok, true, got.reason));
  t('달력 건수 = 그날 걸치는 예약 수', () =>
    assert.equal(counts.get('2026-09-16'), got.reservations.length));
  t('여러 날 건수가 읽힌다', () => assert.ok(counts.size >= 28));
  t('0건인 날이 있으면 건너뛸 수 있다', () =>
    assert.ok([...counts.values()].every((n) => Number.isInteger(n) && n >= 0)));
}

console.log(`\n통과 ${pass}건`);
