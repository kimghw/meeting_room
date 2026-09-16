// 저장 응답 요약(digest)이 "달라진 것"만 제대로 집어내는지 실제 페이지로 확인한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

const base = fs.readFileSync(new URL('./fixtures/list-2026-09-16.html', import.meta.url), 'utf8');
global.DOMParser = new JSDOM('').window.DOMParser;

const { buildSaveDigest } = await import('../src/diagnose.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const payload = {
  region: '부산', roomValue: '제4회의실(11층)-12석', room: '제4회의실(11층)-12석',
  date: '2026-09-16', start: '08:00', end: '09:00', title: '아침회의',
};
const fields = { DDL_REGION: '부산', DDL_ROOMNAME: '제4회의실(11층)-12석', __VIEWSTATE: 'x'.repeat(500) };

console.log('변화 없는 응답');
const same = buildSaveDigest(base, base, fields, payload);
t('새 스크립트 없음', () => assert.deepEqual(same.새로_나타난_스크립트, []));
t('새 안내문구 없음', () => assert.deepEqual(same.새로_나타난_안내문구, []));
t('정적 alert 은 잡히지 않음', () =>
  assert.ok(!JSON.stringify(same.새로_나타난_스크립트).includes('회의장을 선택해')));
t('예약표 행수 읽음', () => assert.equal(same.예약표_행수, 10));
t('보낸값 보존', () => assert.equal(same.보낸값.회의실, '제4회의실(11층)-12석'));
t('ViewState 는 필드이름에서 제외', () =>
  assert.ok(!same.보낸_필드이름.includes('__VIEWSTATE')));
t('폼값 읽힘(지역)', () => assert.equal(same.응답에_남은_폼값.지역, '부산'));

console.log('사이트가 거부 문구를 새로 띄운 응답');
const rejected = base.replace('</body>',
  '<script type="text/javascript">alert("이미 예약된 시간입니다.");</script></body>');
const d2 = buildSaveDigest(rejected, base, fields, payload);
t('새 스크립트 1개', () => assert.equal(d2.새로_나타난_스크립트.length, 1));
t('거부 문구 포함', () => assert.ok(d2.새로_나타난_스크립트[0].includes('이미 예약된 시간입니다')));

console.log('붉은 글씨 안내가 새로 뜬 응답');
const noticed = base.replace('</body>',
  '<span style="color:red;">필수 항목을 입력하세요</span></body>');
const d3 = buildSaveDigest(noticed, base, fields, payload);
t('새 안내문구 잡힘', () => assert.ok(d3.새로_나타난_안내문구.includes('필수 항목을 입력하세요')));

console.log('요약 크기');
t('digest 가 작다(8KB 미만)', () => {
  const size = JSON.stringify(d2).length;
  assert.ok(size < 8000, `실제 ${size}바이트`);
});

console.log(`\n통과 ${pass}건`);
