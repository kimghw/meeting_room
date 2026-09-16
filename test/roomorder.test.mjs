// 실제 회의실 페이지로 화면 차례와 접기를 확인한다.
// 사이트 드롭다운 차례와 화면 차례가 다르다는 것이 이 기능의 전부이므로,
// 가짜 이름이 아니라 진짜 목록으로 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

import { parseRooms } from '../src/parse.js';
import { sortRooms, isFoldedRoom, foldLabels } from '../src/roomorder.js';
import { buildGrid } from '../src/parse.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const html = fs.readFileSync(new URL('./fixtures/list-2026-09-16.html', import.meta.url), 'utf8');
const doc = new JSDOM(html).window.document;

const { rooms: raw } = parseRooms(doc);
const rooms = sortRooms(raw);
const names = rooms.map((r) => r.name);

console.log('화면 차례 (부산)');
t('방 수는 그대로 (빠뜨리지 않는다)', () => assert.equal(rooms.length, raw.length));
t('제1~제5회의실이 맨 위', () =>
  assert.deepEqual(names.slice(0, 5).map((n) => n.slice(0, 5)),
    ['제1회의실', '제2회의실', '제3회의실', '제4회의실', '제5회의실']));
t('그 다음이 미팅룸1, 2', () =>
  assert.deepEqual(names.slice(5, 7).map((n) => n.slice(0, 4)), ['미팅룸1', '미팅룸2']));
t('접는 방은 맨 아래로 모인다', () =>
  assert.deepEqual(names.slice(-4),
    ['부산지부 제1회의실', '부산지부 제2회의실', '스마트홀(18층)', '오션홀(3층)']));
t('접힌 것 말고는 접히지 않는다', () =>
  assert.deepEqual(rooms.filter(isFoldedRoom).map((r) => r.name), names.slice(-4)));
t('부산지부 제1회의실은 제1회의실이 아니다', () =>
  assert.equal(names[0], '제1회의실(11층)-56석'));
t('접힌 무리 이름', () =>
  assert.deepEqual(foldLabels(rooms), ['부산지부', '스마트홀', '오션홀']));
t('원본 목록은 건드리지 않는다', () =>
  assert.equal(raw[0].name, '부산지부 제1회의실'));

console.log('격자 줄 번호');
const grid = buildGrid(rooms, [], { start: 8, end: 20 });
t('격자 줄 차례 = 화면 차례', () =>
  assert.deepEqual(grid.map((g) => g.room.name), names));
t('두 번 세워도 같은 차례 (줄 번호가 흔들리지 않는다)', () =>
  assert.deepEqual(sortRooms(sortRooms(raw)).map((r) => r.name), names));

console.log('차량 이름은 건드리지 않는다');
const cars = [{ name: '쏘나타DN2 (203도7306)' }, { name: '아반테CN74 (181허4310)' }];
t('차량은 접히지 않는다', () => assert.ok(!cars.some(isFoldedRoom)));
t('차량 차례는 그대로', () =>
  assert.deepEqual(sortRooms(cars).map((c) => c.name), cars.map((c) => c.name)));

console.log(`\n통과 ${pass}건`);
