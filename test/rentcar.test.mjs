// 차량 파서를 실제 로그인 페이지로 검증한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(new URL('./fixtures/rentcar-2026-09-16.html', import.meta.url), 'utf8');
const doc = new JSDOM(html).window.document;
const DATE = '2026-09-16';

const {
  parseCarMoment, parseCarRange, clipToDate, parseCarShownDate, extractCars,
  CAR_LIST_URL, CAR_SHELL_URL,
} = await import('../src/rentcar.js');
const { buildGrid, fmtTime } = await import('../src/parse.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('새 탭 주소');
// 사이트 메뉴의 '본부공용차량 이용신청' 탭은 GAPSU 껍데기 없이 intra 목록 페이지를 새 창으로 연다.
// 한때 옆 탭 '차량리스트'(BVM_Car_List.aspx) 로 가서 예약 버튼이 없는 화면에 떨어졌다.
t("새 탭은 '본부공용차량 이용신청'(New_List.aspx?s_code=0102010300) 을 연다", () => {
  assert.equal(CAR_SHELL_URL, CAR_LIST_URL);
  assert.ok(CAR_SHELL_URL.endsWith('/intra/intranet/VSDotnet/RentCar/New_List.aspx?s_code=0102010300'));
});
t("옆 탭 '차량리스트'(BVM_Car_List) 로 가지 않는다", () =>
  assert.doesNotMatch(CAR_SHELL_URL, /BVM_Car_List/));

console.log('시각 파싱');
t('26.09.16 (수) 09:00', () =>
  assert.deepEqual(parseCarMoment('26.09.16 (수) 09:00'), { date: '2026-09-16', minutes: 540 }));
t('요일 없어도 됨', () =>
  assert.deepEqual(parseCarMoment('26.09.18 21:00'), { date: '2026-09-18', minutes: 1260 }));
t('4자리 연도', () =>
  assert.deepEqual(parseCarMoment('2026.09.16 07:30'), { date: '2026-09-16', minutes: 450 }));
t('시각 없으면 null', () => assert.equal(parseCarMoment('26.09.16 (수)'), null));

console.log('범위 파싱 (여러 날 포함)');
t('사흘짜리', () => {
  const r = parseCarRange('26.09.16 (수) 09:00 ~ 26.09.18 (금) 21:00');
  assert.deepEqual(r.start, { date: '2026-09-16', minutes: 540 });
  assert.deepEqual(r.end, { date: '2026-09-18', minutes: 1260 });
});
t('끝에 날짜 생략', () => {
  const r = parseCarRange('26.09.16 (수) 09:00 ~ 18:00');
  assert.equal(r.end.date, '2026-09-16');
  assert.equal(r.end.minutes, 1080);
});

console.log('날짜로 자르기');
const span = parseCarRange('26.09.16 (수) 09:00 ~ 26.09.18 (금) 21:00');
t('첫날은 09:00~24:00', () => assert.deepEqual(clipToDate(span, '2026-09-16'), { start: 540, end: 1440 }));
t('중간날은 하루 종일', () => assert.deepEqual(clipToDate(span, '2026-09-17'), { start: 0, end: 1440 }));
t('마지막날은 00:00~21:00', () => assert.deepEqual(clipToDate(span, '2026-09-18'), { start: 0, end: 1260 }));
t('범위 밖은 null', () => assert.equal(clipToDate(span, '2026-09-19'), null));
t('시작 전날도 null', () => assert.equal(clipToDate(span, '2026-09-15'), null));

console.log('실제 페이지');
t('화면 날짜', () => assert.equal(parseCarShownDate(doc), DATE));

const got = extractCars(doc, DATE);
t('확신함', () => assert.equal(got.ok, true, got.reason));
t('못 읽은 예약 없음', () => assert.equal(got.unreadable, 0));
t('차량이 여러 대', () => assert.ok(got.cars.length >= 5, `실제 ${got.cars.length}대`));
t('첫 차량 이름', () => assert.ok(got.cars[0].name.includes('아반테CN74')));
t('차량번호(CARIDX) 읽음', () => assert.equal(got.cars[0].value, '70'));
t('상태 읽음', () => assert.ok(/사용중|예약가능|대기/.test(got.cars[0].status), got.cars[0].status));

t('그날 이용 건이 있음', () => assert.ok(got.reservations.length >= 1, `실제 ${got.reservations.length}건`));
t('다른 날 예약은 걸러짐', () =>
  assert.ok(got.reservations.every((r) => r.date === DATE)));

const sample = got.reservations[0];
t('예약자 이름/부서 분리', () => assert.ok(sample.owner && !sample.owner.includes('(')));
t('시간 범위가 유효', () => assert.ok(sample.end > sample.start));

const multi = got.reservations.find((r) => r.spanStart.date !== r.spanEnd.date);
t('여러 날짜 건이 잘려 들어옴', () => {
  assert.ok(multi, '여러 날 걸친 예약이 있어야 한다');
  assert.ok(multi.end === 1440 || multi.start === 0);
});

console.log('격자');
const grid = buildGrid(got.cars, got.reservations, { start: 8, end: 20 }, { confident: true });
t('차량 수만큼 행', () => assert.equal(grid.length, got.cars.length));
t('슬롯 12칸', () => assert.equal(grid[0].slots.length, 12));
t('빈 칸과 사용 칸이 섞임', () => {
  const all = grid.flatMap((g) => g.slots);
  assert.ok(all.some((s) => s.state === 'free'), '빈 칸이 있어야 한다');
  assert.ok(all.some((s) => s.state === 'busy'), '사용 중 칸이 있어야 한다');
});

console.log('\n읽어낸 차량');
for (const c of got.cars.slice(0, 6)) {
  const used = got.reservations.filter((r) => r.room === c.name)
    .map((r) => `${fmtTime(r.start)}~${fmtTime(r.end)}`).join(', ');
  console.log(`  ${c.name}  [${c.status}] ${used || '(그날 이용 없음)'}`);
}

console.log('');
console.log('취소 손잡이 — 내 예약에만 붙는 취소 버튼');
{
  const { rowDeleteSubmit, rowDeleteHandle, canDelete } = await import('../src/parse.js');

  // 2026-09-30 실제 화면에서 그대로 옮긴 마크업. 내가 넣은 건의 상세 행 끝에 이렇게 붙는다.
  // 그동안 fn_del(idx, group) 인자만 찾다가 못 찾아 취소가 통째로 막혀 있었다.
  const realRow = `<tr><td>ㄴ 운행정보 : 확인용</td><td>06:00 ~ 07:00</td><td>고민수</td><td>
      <input type="submit" name="RG_MAIN$ctl00$ctl06$Detail10$ctl04$BTN_RETURN_CAR" value="반납"
             onclick="fnReturnCar('1227', '74946'); return false;">
      <input type="submit" name="RG_MAIN$ctl00$ctl06$Detail10$ctl04$BTN_DEL" value="취소"
             onclick="return fnDelete();"></td></tr>`;
  const rowOf = (h) => new JSDOM(`<table><tbody>${h}</tbody></table>`).window.document.querySelector('tr');

  t('행의 취소 submit 버튼을 찾아낸다', () => {
    const del = rowDeleteSubmit(rowOf(realRow));
    assert.equal(del.submit, 'RG_MAIN$ctl00$ctl06$Detail10$ctl04$BTN_DEL');
    assert.equal(del.value, '취소');
  });

  t('반납 버튼을 취소로 착각하지 않는다', () => {
    const only = `<tr><td><input type="submit" name="RG_MAIN$ctl00$BTN_RETURN_CAR" value="반납"></td></tr>`;
    assert.equal(rowDeleteSubmit(rowOf(only)), null);
  });

  t('취소 버튼이 없으면 null (남의 예약)', () => {
    const other = `<tr><td>ㄴ 운행정보 : 업무회의</td><td>09:00 ~ 18:00</td><td>김호선</td><td></td></tr>`;
    assert.equal(rowDeleteSubmit(rowOf(other)), null);
    assert.equal(rowDeleteHandle(rowOf(other)), null);
  });

  t('두 모양 다 지울 수 있다고 본다', () => {
    assert.equal(canDelete({ submit: 'RG_MAIN$ctl00$BTN_DEL', value: '취소' }), true);
    assert.equal(canDelete({ idx: '69497', group: '0' }), true);
    assert.equal(canDelete(null), false);
    assert.equal(canDelete({}), false);
  });

  t('2026-09-16 페이지에는 내 건이 없어 취소 버튼도 없다', () =>
    assert.equal(got.reservations.filter((r) => canDelete(r.del)).length, 0));
}

console.log(`\n통과 ${pass}건`);
