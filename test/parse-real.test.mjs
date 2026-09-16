// 실제 로그인 상태에서 받은 페이지로 파서를 검증한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// jsdom 은 테스트 전용이라 프로젝트에 설치하지 않는다.
// JSDOM_BASE 로 설치된 곳의 package.json 경로를 넘겨준다.
const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');
import {
  extractSchedule, parseRooms, parseRegions, parseSelectedRegion,
  parseShownDate, parseDayCounts, parseRoomName, buildGrid, fmtTime,
} from '../src/parse.js';

const html = fs.readFileSync(new URL('./fixtures/list-2026-09-16.html', import.meta.url), 'utf8');
const doc = new JSDOM(html).window.document;
const DATE = '2026-09-16';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('페이지 상태');
t('화면 날짜', () => assert.equal(parseShownDate(doc), DATE));
t('선택된 지역', () => assert.equal(parseSelectedRegion(doc), '부산'));
t('지역 목록', () => assert.deepEqual(parseRegions(doc), ['부산', '서울']));

console.log('달력 건수');
const counts = parseDayCounts(doc);
t('9/16 은 10건', () => assert.equal(counts.get('2026-09-16'), 10));
t('9/02 는 17건', () => assert.equal(counts.get('2026-09-02'), 17));
t('여러 날 읽힘', () => assert.ok(counts.size >= 28));

console.log('회의실 목록 (부산)');
const { rooms, source } = parseRooms(doc);
t('드롭다운에서 옴', () => assert.equal(source, 'select'));
t('14곳', () => assert.equal(rooms.length, 14));
t('===선 택=== 제외됨', () => assert.ok(!rooms.some((r) => r.value === '-')));
t('좌석 수 파싱', () => assert.equal(rooms.find((r) => r.name.startsWith('미팅룸1')).seats, 8));
t('층 파싱', () => assert.equal(rooms.find((r) => r.name.startsWith('미팅룸1')).floor, 1));
t('56석 회의실', () => assert.equal(rooms.find((r) => r.name.startsWith('제1회의실')).seats, 56));
t('좌석 없는 방은 null', () => assert.equal(rooms.find((r) => r.name === '스마트홀(18층)').seats, null));
t('라벨에서 석 제거', () => assert.equal(parseRoomName('미팅룸1(1층)-8석').label, '미팅룸1(1층)'));

console.log('예약 현황');
const sch = extractSchedule(doc, DATE);
t('확신함', () => assert.equal(sch.confident, true, sch.reason));
t('달력과 일치(10건)', () => assert.equal(sch.reservations.length, 10));
t('달력 기대값도 10', () => assert.equal(sch.expected, 10));

const first = sch.reservations[0];
t('회의실명', () => assert.equal(first.room, '미팅룸1(1층)-8석'));
t('지역', () => assert.equal(first.region, '부산'));
t('시간 09:00~18:00', () => assert.equal(`${fmtTime(first.start)}~${fmtTime(first.end)}`, '09:00~18:00'));
t('회의명(상세행)', () => assert.equal(first.title, '보안 인증 준비'));
t('예약자', () => assert.equal(first.owner, '도민준'));
t('부서', () => assert.equal(first.dept, '개발1팀'));
t('승인 상태', () => assert.equal(first.status, '승인'));

const seoul = sch.reservations.filter((r) => r.region === '서울');
t('서울 건도 읽힘', () => assert.equal(seoul.length, 1));
t('서울 회의실명', () => assert.equal(seoul[0].room, '제2회의실'));
t('서울 14:00~17:00', () => assert.equal(`${fmtTime(seoul[0].start)}~${fmtTime(seoul[0].end)}`, '14:00~17:00'));

const allDay = sch.reservations.find((r) => r.room.startsWith('제5회의실'));
t('00:00~23:50 종일건', () => assert.equal(`${fmtTime(allDay.start)}~${fmtTime(allDay.end)}`, '00:00~23:50'));

console.log('격자');
const busan = sch.reservations.filter((r) => r.region === '부산');
const grid = buildGrid(rooms, busan, { start: 8, end: 20 }, { confident: true });
t('회의실 14행', () => assert.equal(grid.length, 14));
const m1 = grid.find((g) => g.room.name.startsWith('미팅룸1'));
t('미팅룸1 08시 비어있음', () => assert.equal(m1.slots[0].state, 'free'));
t('미팅룸1 09시 사용중', () => assert.equal(m1.slots[1].state, 'busy'));
t('미팅룸1 09시 회의명', () => assert.equal(m1.slots[1].by, '보안 인증 준비'));
t('미팅룸1 18시 비어있음', () => assert.equal(m1.slots[10].state, 'free'));

const r5 = grid.find((g) => g.room.name.startsWith('제5회의실'));
t('제5회의실 종일 사용중', () => assert.ok(r5.slots.every((s) => s.state === 'busy')));

const smart = grid.find((g) => g.room.name === '스마트홀(18층)');
t('예약 없는 방은 전부 비어있음', () => assert.ok(smart.slots.every((s) => s.state === 'free')));

console.log(`\n통과 ${pass}건`);
