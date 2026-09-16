// 차량 신청 폼 감지기(src/carform.js)와 차량 쓰기 흐름의 순수 부분을 검증한다.
//
// 이 테스트가 쓰는 폼 fixture 는 **합성**이다(진짜 캡처가 아니다 — 파일 맨 위 경고 참고).
// 그래서 여기서 증명하는 것은 "사이트에서 된다"가 아니라
//   1) 이런 모양을 만나면 이름이 아니라 **내용**으로 찾아낸다
//   2) 못 찾으면 **못 찾았다고 말하고 제출하지 않는다**
// 두 가지다. 이 앱에서 가장 나쁜 실패가 "모르면서 아는 척 제출하기"이기 때문이다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

const formHtml = fs.readFileSync(new URL('./fixtures/rentcar-form-synthetic.html', import.meta.url), 'utf8');
const parse = (html) => new JSDOM(html).window.document;

const {
  detectCarForm, buildCarFields, readAlert, selectTimeKind, pairBySide,
  telerikDatePickerNames, PLATE_RE,
} = await import('../src/carform.js');
const { extractCars, findCarDeleteTarget, carFormUrl } = await import('../src/rentcar.js');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

/* ------------------------------------------------------------------ 감지 */

console.log('합성 신청 폼 — 필수 칸을 다 찾아낸다');
const doc = parse(formHtml);
const got = detectCarForm(doc);

t('ok:true', () => assert.equal(got.ok, true, `missing: ${got.missing.join(', ')}`));
t('못 찾은 칸 없음', () => assert.deepEqual(got.missing, []));
t('차량 드롭다운', () => assert.equal(got.fields.car, 'DDL_CARNAME'));
t('사용목적', () => assert.equal(got.fields.title, 'TXT_TITLE'));
t('행선지', () => assert.equal(got.fields.place, 'TXT_PLACE'));
t('운전자', () => assert.equal(got.fields.driver, 'TXT_DRIVER'));
t('운전자 부서', () => assert.equal(got.fields.driverDept, 'TXT_DRIVER_DEPT_NAME'));
t('운전자 사번(숨은 칸)', () => assert.equal(got.fields.driverId, 'hidDriverID'));
t('동승자', () => assert.equal(got.fields.passenger, 'TXT_PASSENGER'));
t('시작 시/분', () => {
  assert.equal(got.fields.startHour, 'DDL_SHOUR');
  assert.equal(got.fields.startMinute, 'DDL_SMINUTE');
});
t('종료 시/분', () => {
  assert.equal(got.fields.endHour, 'DDL_EHOUR');
  assert.equal(got.fields.endMinute, 'DDL_EMINUTE');
});
t('날짜는 Telerik 피커', () => assert.equal(got.fields.dateKind, 'telerik'));
t('시작/종료 날짜 칸이 둘 다', () => {
  assert.equal(got.fields.startDate, 'DP_SDATE');
  assert.equal(got.fields.endDate, 'DP_EDATE');
});
t('저장은 이미지 버튼', () => {
  assert.equal(got.fields.save, 'BTN_SAVE');
  assert.equal(got.fields.saveKind, 'image');
});
t('취소 버튼을 저장으로 잘못 집지 않음', () => assert.notEqual(got.fields.save, 'BTN_CANCEL'));
t('무엇을 보고 그렇게 판단했는지 남긴다', () => {
  assert.ok(got.found.why.car.includes('번호판'), got.found.why.car);
  assert.ok(/옵션 내용/.test(got.found.why.hour), got.found.why.hour);
});

console.log('\n모르면 모른다고 한다 — 차량 select 를 뺀 문서');
const noCar = parse(formHtml.replace(/<select[^>]*DDL_CARNAME[\s\S]*?<\/select>/, ''));
const gotNoCar = detectCarForm(noCar);
t('ok:false', () => assert.equal(gotNoCar.ok, false));
t("missing 에 '차량'", () => assert.ok(gotNoCar.missing.includes('차량'), gotNoCar.missing.join(', ')));
t('시/분은 그대로 찾아냄(차량만 못 찾은 것)', () => {
  assert.equal(gotNoCar.fields.startHour, 'DDL_SHOUR');
  assert.deepEqual(gotNoCar.missing, ['차량']);
});
t('이유를 사람 말로 적는다', () => assert.ok(gotNoCar.reason.includes('차량'), gotNoCar.reason));

console.log('\n이름이 아니라 옵션 내용으로 시/분을 고른다');
const renamed = formHtml
  .replace(/DDL_SHOUR/g, 'AAA').replace(/DDL_SMINUTE/g, 'BBB')
  .replace(/DDL_EHOUR/g, 'CCC').replace(/DDL_EMINUTE/g, 'DDD');
const gotRenamed = detectCarForm(parse(renamed));
t('이름이 AAA/BBB/CCC/DDD 여도 ok:true', () =>
  assert.equal(gotRenamed.ok, true, `missing: ${gotRenamed.missing.join(', ')}`));
t('앞의 짝이 시작', () => {
  assert.equal(gotRenamed.fields.startHour, 'AAA');
  assert.equal(gotRenamed.fields.startMinute, 'BBB');
});
t('뒤의 짝이 종료', () => {
  assert.equal(gotRenamed.fields.endHour, 'CCC');
  assert.equal(gotRenamed.fields.endMinute, 'DDD');
});

console.log('\nselect 종류 판정 (옵션 내용만 본다)');
const sel = (html) => parse(`<select name="X">${html}</select>`).querySelector('select');
t('0~23 은 시', () => {
  const opts = Array.from({ length: 24 }, (_, i) => `<option value="${i}">${i}</option>`).join('');
  assert.equal(selectTimeKind(sel(opts)), 'hour');
});
t('00~23 (0 채움)도 시', () => {
  const opts = Array.from({ length: 24 }, (_, i) => `<option value="${String(i).padStart(2, '0')}">${i}</option>`).join('');
  assert.equal(selectTimeKind(sel(opts)), 'hour');
});
t('10분 단위는 분', () =>
  assert.equal(selectTimeKind(sel('<option value="00">00</option><option value="10">10</option><option value="20">20</option><option value="30">30</option><option value="40">40</option><option value="50">50</option>')), 'minute'));
t('차량 목록은 시도 분도 아니다', () =>
  assert.equal(selectTimeKind(sel('<option value="0">== 선택 ==</option><option value="70">아반테CN74 (181허4360)</option>')), null));
t('안내 항목이 섞여도 시로 본다', () => {
  const opts = '<option value="">선택</option>' +
    Array.from({ length: 24 }, (_, i) => `<option value="${i}">${i}</option>`).join('');
  assert.equal(selectTimeKind(sel(opts)), 'hour');
});

console.log('\n시작/종료 짝짓기');
t('이름 힌트가 갈라주면 그걸 쓴다', () =>
  assert.deepEqual(pairBySide(['DDL_ROOMEHOUR', 'DDL_ROOMSHOUR']), { start: 'DDL_ROOMSHOUR', end: 'DDL_ROOMEHOUR', by: 'hint' }));
t('힌트가 없으면 문서 순서', () =>
  assert.deepEqual(pairBySide(['AAA', 'CCC']), { start: 'AAA', end: 'CCC', by: 'order' }));
t('하나뿐이면 시작만', () =>
  assert.deepEqual(pairBySide(['ONLY']), { start: 'ONLY', end: null, by: 'single' }));
t('번호판 모양', () => {
  assert.ok(PLATE_RE.test('아반테CN74 (181허4360)'));
  assert.ok(PLATE_RE.test('카니발 (203도7395)'));
  assert.ok(!PLATE_RE.test('미팅룸1(1층)-8석'));
});

/* -------------------------------------------------------------- 폼 채우기 */

console.log('\nbuildCarFields — Telerik 날짜 칸은 ClientState 까지 채운다');
const payload = {
  carValue: '70', car: '아반테CN74 (181허4360)',
  date: '2026-09-20', endDate: '2026-09-22',
  start: '09:00', end: '18:30',
  title: '고객사 방문', place: '서울 본사', driver: '홍길동', passenger: '김철수',
};
// 사이트는 사용자·부서를 폼에 미리 채워서 내려준다(실제 캡처로 확인). reserveCar 도
// formState(doc) 를 그대로 넘기므로, 테스트도 그 상태를 흉내 낸다.
const current = { TXT_DRIVER: '홍길동', TXT_DRIVER_DEPT_NAME: '총무팀' };
const fields = buildCarFields(got, payload, current);

t('차량/사용목적/행선지', () => {
  assert.equal(fields.DDL_CARNAME, '70');
  assert.equal(fields.TXT_TITLE, '고객사 방문');
  assert.equal(fields.TXT_PLACE, '서울 본사');
});
t('운전자/동승자', () => {
  assert.equal(fields.TXT_DRIVER, '홍길동');
  assert.equal(fields.TXT_PASSENGER, '김철수');
});
t('시/분은 드롭다운이 실제로 가진 값으로', () => {
  // 합성 폼은 "09" 처럼 0 을 채운 값을 쓴다. "9" 를 보내면 서버가 조용히 첫 항목을 쓴다.
  assert.equal(fields.DDL_SHOUR, '09');
  assert.equal(fields.DDL_SMINUTE, '00');
  assert.equal(fields.DDL_EHOUR, '18');
  assert.equal(fields.DDL_EMINUTE, '30');
});
t('글자 칸만이 아니라 ClientState JSON 도 채운다', () => {
  assert.equal(fields.DP_SDATE, '2026-09-20');
  assert.equal(fields['DP_SDATE$dateInput'], '2026-09-20');
  const cs = JSON.parse(fields.DP_SDATE_dateInput_ClientState);
  assert.equal(cs.valueAsString, '2026-09-20-00-00-00');
  assert.equal(cs.validationText, '2026-09-20-00-00-00');
  assert.equal(cs.lastSetTextBoxValue, '2026-09-20');
  assert.equal(fields.DP_SDATE_calendar_SD, '[[2026,9,20]]');
});
t('여러 날짜 신청 — 종료 날짜 칸은 endDate 로', () => {
  assert.equal(fields.DP_EDATE, '2026-09-22');
  assert.equal(JSON.parse(fields.DP_EDATE_dateInput_ClientState).valueAsString, '2026-09-22-00-00-00');
  assert.equal(fields.DP_EDATE_calendar_SD, '[[2026,9,22]]');
});
t('endDate 가 없으면 하루짜리', () => {
  const one = buildCarFields(got, { ...payload, endDate: undefined }, current);
  assert.equal(one.DP_EDATE, '2026-09-20');
});
t('이미지 버튼은 좌표로 누른다', () => {
  assert.equal(fields['BTN_SAVE.x'], '10');
  assert.equal(fields['BTN_SAVE.y'], '10');
});
t('빈 값은 얹지 않는다(폼이 미리 채워둔 값을 지우면 안 된다)', () => {
  const bare = buildCarFields(got, { ...payload, driver: '', passenger: undefined }, current);
  assert.ok(!('TXT_DRIVER' in bare));
  assert.ok(!('TXT_PASSENGER' in bare));
});
t('Telerik 칸 이름 규칙', () =>
  assert.deepEqual(telerikDatePickerNames('DP_X'), {
    date: 'DP_X',
    dateInput: 'DP_X$dateInput',
    dateInputClientState: 'DP_X_dateInput_ClientState',
    dateCalendarSelected: 'DP_X_calendar_SD',
    // 스킨에 따라 보이는 글자 칸이 따로 있다. 폼에 실제로 있을 때만 쓴다.
    dateInputText: 'DP_X_dateInput_text',
  }));

console.log('\nbuildCarFields — 모르는 폼에는 값을 밀어 넣지 않는다');
t('ok:false 감지 결과를 받으면 던진다', () =>
  assert.throws(() => buildCarFields(gotNoCar, payload, current), /확인하지 못해/));
t('감지 결과가 아예 없어도 던진다', () =>
  assert.throws(() => buildCarFields(null, payload, current), /확인하지 못해/));
t('시간 형식이 틀리면 던진다', () =>
  assert.throws(() => buildCarFields(got, { ...payload, start: '아침' }, current), /시간을 읽지 못했습니다/));

/* ---------------------------------------------------------------- alert */

console.log('\nreadAlert — 새로 생긴 문구만 고른다');
t('정적으로 박힌 문구는 무시한다', () =>
  assert.equal(readAlert(formHtml, formHtml), ''));
t('새로 생긴 문구는 잡는다', () =>
  assert.equal(readAlert(`${formHtml}<script>alert('저장되었습니다.')</script>`, formHtml), '저장되었습니다.'));
t('기준 없이 읽으면 정적 문구가 잡힌다(그래서 기준이 필요하다)', () =>
  assert.equal(readAlert(formHtml, ''), '렌트할 차량을 선택 하세요.'));

/* -------------------------------------------------- 목록: 삭제 손잡이 */

console.log('\nextractCars — 예약 한 건에 삭제 손잡이를 붙인다');
const listDoc = parse(`<html><body><form>
<table id="RG_MAIN_ctl00" class="rgMasterTable"><tbody>
  <tr>
    <td>1</td><td>아반테CN74 (181허4360)</td><td>중형</td><td>사용중 예약</td>
    <td><input type="button" onclick="return fnview('Admin_View_New.aspx?CARIDX=70&amp;SDATE=2026-09-16','70','2026-09-16','False','True');" /></td>
  </tr>
  <tr><td colspan="5"><table class="rgDetailTable"><tbody>
    <tr>
      <td>ㄴ 운행정보 : 고객사 방문</td>
      <td>26.09.16 (수) 09:00 ~ 26.09.16 (수) 18:00</td>
      <td>홍길동(기술본부)</td>
      <td><a href="javascript:void(0);" onclick="fn_del('123','0')">삭제</a></td>
    </tr>
  </tbody></table></td></tr>
  <tr>
    <td>2</td><td>카니발 (203도7395)</td><td>승합</td><td>예약가능</td><td></td>
  </tr>
  <tr><td colspan="5"><table class="rgDetailTable"><tbody>
    <tr>
      <td>ㄴ 운행정보 : 자재 운반</td>
      <td>26.09.16 (수) 13:00 ~ 26.09.17 (목) 10:00</td>
      <td>이영희(총무팀)</td>
      <td></td>
    </tr>
  </tbody></table></td></tr>
</tbody></table>
<input type="hidden" name="HF_DEL_YN" id="HF_DEL_YN" />
<input type="hidden" name="HF_IDX" id="HF_IDX" />
<input type="hidden" name="HF_GROUP_IDX" id="HF_GROUP_IDX" />
<input type="submit" name="RG_MAIN$ctl00$ctl09$BTN_DEL" id="RG_MAIN_ctl00_ctl09_BTN_DEL" value="" />
</form></body></html>`);

const list = extractCars(listDoc, '2026-09-16');
t('차량 2대', () => assert.equal(list.cars.length, 2));
t("fn_del('123','0') → del:{idx:'123',group:'0'}", () =>
  assert.deepEqual(list.reservations[0].del, { idx: '123', group: '0' }));
t('삭제 버튼이 붙었으면 내 예약', () => assert.equal(list.reservations[0].mine, true));
t('삭제 버튼이 없으면 del:null (취소를 막아야 한다)', () => {
  assert.equal(list.reservations[1].del, null);
  assert.equal(list.reservations[1].mine, false);
});
t('여러 날 건은 그날 구간으로 잘린다', () => {
  assert.equal(list.reservations[1].start, 13 * 60);
  assert.equal(list.reservations[1].end, 24 * 60);
});

console.log('\n삭제 포스트백 대상 — 문서에서 먼저 찾는다');
t('문서에 있는 진짜 버튼 이름을 쓴다(ctl04 는 하드코딩이라 못 믿는다)', () =>
  assert.equal(findCarDeleteTarget(listDoc), 'RG_MAIN$ctl00$ctl09$BTN_DEL'));
t('없으면 null 을 돌려 부르는 쪽이 기본값을 쓰게 한다', () =>
  assert.equal(findCarDeleteTarget(parse('<html><body><form></form></body></html>')), null));
t('스크립트에 박힌 대상도 찾는다', () =>
  assert.equal(
    findCarDeleteTarget(parse(`<html><body><script>__doPostBack('RG_MAIN$ctl00$ctl04$BTN_DEL','')</script></body></html>`)),
    'RG_MAIN$ctl00$ctl04$BTN_DEL',
  ));

console.log('\n신청 폼 주소');
t('CARIDX 와 SDATE 를 붙인다', () =>
  assert.equal(
    carFormUrl('70', '2026-09-16'),
    'https://eclass.krs.co.kr/intra/intranet/VSDotnet/RentCar/Admin_View_New.aspx?CARIDX=70&SDATE=2026-09-16',
  ));

console.log(`\n통과 ${pass}건`);
