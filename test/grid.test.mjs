// 컬럼 감지기를 실제 회의실 페이지로 검증한다.
// 여기서 위치를 정확히 맞혀야 구조를 못 본 차량 페이지에도 쓸 수 있다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(new URL('./fixtures/list-2026-09-16.html', import.meta.url), 'utf8');
const doc = new JSDOM(html).window.document;

const { dataRows, detectColumns, readRows } = await import('../src/grid.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const table = doc.getElementById('RG_MAIN_ctl00');
const rows = dataRows(table, 6);

console.log('데이터 행 고르기');
t('예약 10건', () => assert.equal(rows.length, 10));

console.log('컬럼 자동 감지 (정답: 지역2 회의실3 시간4 상태5)');
const cols = detectColumns(rows);
t('시간 컬럼 = 4', () => assert.equal(cols.time, 4));
t('이름 컬럼 = 3', () => assert.equal(cols.name, 3));
t('지역 컬럼 = 2', () => assert.equal(cols.region, 2));
t('상태 컬럼 = 5', () => assert.equal(cols.status, 5));

console.log('감지한 컬럼으로 읽기');
const { rows: recs, unreadable } = readRows(rows, cols, () => false);
t('10건 다 읽힘', () => assert.equal(recs.length, 10));
t('못 읽은 행 없음', () => assert.equal(unreadable, 0));
t('첫 건 이름', () => assert.equal(recs[0].name, '미팅룸1(1층)-8석'));
t('첫 건 지역', () => assert.equal(recs[0].region, '부산'));
t('첫 건 상태', () => assert.equal(recs[0].status, '승인'));
t('첫 건 시간', () => assert.equal(recs[0].start, 9 * 60));
t('종일 건도 읽힘', () => {
  const r = recs.find((x) => x.name.startsWith('제5회의실'));
  assert.equal(r.start, 0);
  assert.equal(r.end, 23 * 60 + 50);
});
t('서울 건도 읽힘', () => {
  const r = recs.find((x) => x.region === '서울');
  assert.equal(r.name, '제2회의실');
});

console.log('컬럼 순서가 달라도 찾아내는지 (차량 표를 가정)');
const fake = new JSDOM(`<table id="t"><tbody>
 <tr><td>1</td><td>쏘나타 12가3456</td><td>09:00~ 12:00</td><td>승인</td><td>홍길동</td><td></td></tr>
 <tr><td>2</td><td>카니발 34나5678</td><td>13:00~ 18:00</td><td>대기</td><td>김철수</td><td></td></tr>
 <tr><td>3</td><td>아이오닉 56다7890</td><td>08:00~ 09:30</td><td>승인</td><td>이영희</td><td></td></tr>
</tbody></table>`).window.document;
const fr = dataRows(fake.getElementById('t'), 5);
const fc = detectColumns(fr);
t('차량 가정: 시간 = 2', () => assert.equal(fc.time, 2));
t('차량 가정: 이름 = 1', () => assert.equal(fc.name, 1));
t('차량 가정: 상태 = 3', () => assert.equal(fc.status, 3));
const fres = readRows(fr, fc, () => false);
t('차량 가정: 3건 읽힘', () => assert.equal(fres.rows.length, 3));
t('차량 가정: 이름 정확', () => assert.equal(fres.rows[0].name, '쏘나타 12가3456'));

console.log(`\n통과 ${pass}건`);
