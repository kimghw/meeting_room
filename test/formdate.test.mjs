// 예약 폼 날짜 처리 검증.
// 글자 칸만 채우면 서버가 무시하고 오늘로 저장된다 — 실제로 그랬던 적이 있다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(new URL('./fixtures/list-2026-09-16.html', import.meta.url), 'utf8');
const doc = new JSDOM(html).window.document;

const { telerikDateFields, parseFormDate } = await import('../src/parse.js');
const { FORM } = await import('../src/config.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('폼 날짜 읽기');
t('실제 페이지의 폼 날짜', () => assert.equal(parseFormDate(doc), '2026-09-16'));

console.log('날짜 필드 만들기');
const f = telerikDateFields('2026-09-19');

t('글자 칸 두 개', () => {
  assert.equal(f[FORM.date], '2026-09-19');
  assert.equal(f[FORM.dateInput], '2026-09-19');
});

t('ClientState 도 함께 보낸다', () => {
  assert.ok(f[FORM.dateInputClientState], 'ClientState 가 비면 서버가 날짜를 무시한다');
  const cs = JSON.parse(f[FORM.dateInputClientState]);
  assert.equal(cs.valueAsString, '2026-09-19-00-00-00');
  assert.equal(cs.validationText, '2026-09-19-00-00-00');
  assert.equal(cs.lastSetTextBoxValue, '2026-09-19');
  assert.equal(cs.enabled, true);
});

t('달력 선택값도 함께 보낸다', () =>
  assert.deepEqual(JSON.parse(f[FORM.dateCalendarSelected]), [[2026, 9, 19]]));

t('한 자리 월/일도 숫자로 들어간다', () => {
  const g = telerikDateFields('2026-01-05');
  assert.deepEqual(JSON.parse(g[FORM.dateCalendarSelected]), [[2026, 1, 5]]);
  assert.equal(JSON.parse(g[FORM.dateInputClientState]).valueAsString, '2026-01-05-00-00-00');
});

t('필드 이름이 실제 페이지에 있는 것과 맞는다', () => {
  for (const name of Object.keys(f)) {
    assert.ok(doc.getElementsByName(name).length > 0, `${name} 이 페이지에 없다`);
  }
});

console.log('제출 전 확인');
t('폼 날짜가 목표와 다르면 잡아낸다', () => {
  // 실제 페이지는 09-16 을 들고 있다. 09-19 로 예약하려면 옮겨야 한다.
  assert.notEqual(parseFormDate(doc), '2026-09-19');
});

console.log(`\n통과 ${pass}건`);
