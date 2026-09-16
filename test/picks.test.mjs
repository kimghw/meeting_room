// 선택 규칙: 예약 / 취소 / 연장 대상 판정과 "예약이 취소를 덮는다" 규칙.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

/* --- sidepanel 의 규칙을 그대로 옮겨 검증한다 --- */

const addBook = (picks, pick) => [...picks.filter((p) => p.kind !== 'cancel'), { ...pick, kind: 'book' }];
const addCancel = (picks, pick) =>
  picks.some((p) => p.kind === 'book') ? picks : [...picks, { ...pick, kind: 'cancel' }];

console.log('예약이 취소를 덮는다');
t('취소만 고른 상태', () => {
  const p = addCancel([], { room: 0, from: 0, to: 0 });
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'cancel');
});
t('취소 고른 뒤 예약을 고르면 취소가 빠진다', () => {
  let p = addCancel([], { room: 0, from: 0, to: 0 });
  p = addBook(p, { room: 0, from: 2, to: 2 });
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'book');
});
t('예약 고른 뒤 취소는 들어오지 못한다', () => {
  let p = addBook([], { room: 0, from: 2, to: 2 });
  p = addCancel(p, { room: 0, from: 0, to: 0 });
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'book');
});
t('예약은 여러 건 쌓인다', () => {
  let p = addBook([], { room: 0, from: 1, to: 1 });
  p = addBook(p, { room: 1, from: 3, to: 4 });
  assert.equal(p.filter((x) => x.kind === 'book').length, 2);
});

console.log('버튼 결정');
const decide = (picks) => {
  const books = picks.filter((p) => p.kind !== 'cancel');
  const cancels = picks.filter((p) => p.kind === 'cancel');
  const onlyCancel = cancels.length > 0 && books.length === 0;
  return { cancel: onlyCancel, submit: !onlyCancel, count: onlyCancel ? cancels.length : books.length };
};
t('취소만 → 취소하기', () => {
  const d = decide(addCancel([], { room: 0, from: 0, to: 0 }));
  assert.deepEqual([d.cancel, d.submit], [true, false]);
});
t('예약만 → 예약하기', () => {
  const d = decide(addBook([], { room: 0, from: 0, to: 0 }));
  assert.deepEqual([d.cancel, d.submit], [false, true]);
});
t('섞이면 예약하기', () => {
  const d = decide(addBook(addCancel([], { room: 0, from: 0, to: 0 }), { room: 0, from: 2, to: 2 }));
  assert.deepEqual([d.cancel, d.submit], [false, true]);
});

console.log('연장 대상 판정 (내 예약과 맞닿아야 한다)');
const MINE = { room: '대회의실', mine: true, start: 480, end: 540, title: '아침회의' };
const OTHER = { room: '대회의실', mine: false, start: 660, end: 720, title: '남의 회의' };
const extendTarget = (reservations, roomName, startMin, endMin) =>
  reservations.find((r) => r.mine && r.room === roomName && (r.end === startMin || r.start === endMin)) || null;

t('바로 뒤 칸이면 연장 대상', () => assert.equal(extendTarget([MINE], '대회의실', 540, 600), MINE));
t('바로 앞 칸이어도 연장 대상', () => assert.equal(extendTarget([MINE], '대회의실', 420, 480), MINE));
t('한 칸 떨어지면 아님', () => assert.equal(extendTarget([MINE], '대회의실', 600, 660), null));
t('남의 예약 옆은 아님', () => assert.equal(extendTarget([OTHER], '대회의실', 720, 780), null));
t('다른 방은 아님', () => assert.equal(extendTarget([MINE], '소회의실', 540, 600), null));

console.log('삭제 정보 읽기 (실제 fn_del 형태)');
const { rowDeleteHandle } = await import('../src/parse.js');
const mk = (html) => new JSDOM(`<table><tr>${html}</tr></table>`).window.document.querySelector('tr');
t('fn_del(idx, group)', () =>
  assert.deepEqual(rowDeleteHandle(mk(`<td><a href="javascript:fn_del(1234,56);">삭제</a></td>`)), { idx: '1234', group: '56' }));
t('따옴표가 있어도 읽는다', () =>
  assert.deepEqual(rowDeleteHandle(mk(`<td><img onclick="fn_del('1234','0')" /></td>`)), { idx: '1234', group: '0' }));
t('group 이 비면 0', () =>
  assert.deepEqual(rowDeleteHandle(mk(`<td><a href="javascript:fn_del(77,);">x</a></td>`)), { idx: '77', group: '0' }));
t("실제 화면의 DelCheck('69497','69497')", () =>
  assert.deepEqual(rowDeleteHandle(mk(`<td><a href="javascript:return DelCheck('69497','69497');__doPostBack('x','')">삭제</a></td>`)), { idx: '69497', group: '69497' }));
t('버튼이 없으면 null (남의 예약)', () =>
  assert.equal(rowDeleteHandle(mk(`<td>남의 예약</td>`)), null));

console.log(`\n통과 ${pass}건`);
