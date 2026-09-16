// 차량 신청 폼 감지기를 **실제 캡처**로 검증한다.
//
// test/fixtures/rentcar-form-2026-09-16.html 은 로그인 상태에서 받은 진짜
// Admin_View_New.aspx?CARIDX=73&SDATE=2026-09-16 이다. 이 파일이 생기기 전까지
// 필드 이름은 전부 추측이었고, 실제로 그 추측은 **대부분 틀렸다**:
//   목록 페이지의 죽은 fnSave() 는 TXT_TITLE/TXT_PLACE/TXT_DRIVER 라고 했지만
//   진짜 폼은 txtTitle/txtPlace/txtDriver 다. DDL_CARNAME 하나만 맞았다.
// 그래서 이 테스트는 "이름을 몰라도 내용으로 찾아내는가"를 붙잡아 둔다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

const { detectCarForm, buildCarFields, carFormProblems, readFormWho } =
  await import('../src/carform.js');

const html = fs.readFileSync(new URL('./fixtures/rentcar-form-2026-09-16.html', import.meta.url), 'utf8');
const docOf = (src) => new JSDOM(src).window.document;
const doc = docOf(html);

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

console.log('실제 신청 폼에서 모든 칸을 찾아낸다');
const got = detectCarForm(doc);
{
  t('ok:true, 빠진 칸 없음', () => {
    assert.equal(got.ok, true, got.reason);
    assert.deepEqual(got.missing, []);
  });
  const f = got.fields;
  t('차량 = DDL_CARNAME', () => assert.equal(f.car, 'DDL_CARNAME'));
  t('사용목적 = txtTitle (추측했던 TXT_TITLE 이 아니다)', () => assert.equal(f.title, 'txtTitle'));
  t('행선지 = txtPlace', () => assert.equal(f.place, 'txtPlace'));
  t('사용자 = txtDriver', () => assert.equal(f.driver, 'txtDriver'));
  t('부서 = txtDriverDeptName', () => assert.equal(f.driverDept, 'txtDriverDeptName'));
  t('동승자 = txtPassenger', () => assert.equal(f.passenger, 'txtPassenger'));
  t('시작일 = txtSdate (Telerik)', () => {
    assert.equal(f.startDate, 'txtSdate');
    assert.equal(f.dateKind, 'telerik');
  });
  t('종료일 = txtEdate — 차량은 여러 날에 걸친다', () => assert.equal(f.endDate, 'txtEdate'));
  t('시작 시/분 = ddlStimeH / ddlStimeM', () => {
    assert.equal(f.startHour, 'ddlStimeH');
    assert.equal(f.startMinute, 'ddlStimeM');
  });
  t('종료 시/분 = ddlEtimeH / ddlEtimeM', () => {
    assert.equal(f.endHour, 'ddlEtimeH');
    assert.equal(f.endMinute, 'ddlEtimeM');
  });
  t('저장 = ibtnITSave, 이미지 버튼', () => {
    assert.equal(f.save, 'ibtnITSave');
    assert.equal(f.saveKind, 'image');
  });
}

console.log('\n폼이 로그인한 사람을 알려준다 (조회 화면에는 없는 정보)');
{
  const who = readFormWho(doc, got);
  t('이름·부서·사번을 읽는다', () => {
    assert.equal(who.name, '고민수');
    assert.equal(who.dept, '연구3팀');
    assert.equal(who.id, 'testuser');
  });
}

const base = {
  carValue: '73', car: '아반테CN74',
  date: '2026-09-18', start: '09:00', end: '18:30',
  title: '출장', place: '부산 본사', passenger: '홍길동',
};
const current = { txtDriver: '고민수', txtDriverDeptName: '연구3팀' };

console.log('\n보낼 값이 사이트 형식과 맞는다');
{
  const f = buildCarFields(got, base, current);
  t('시 값은 0 패딩 없이 "9"', () => assert.equal(f.ddlStimeH, '9'));
  t('분 값은 "0" (00 이 아니다)', () => assert.equal(f.ddlStimeM, '0'));
  t('종료 18:30 → "18" / "30"', () => {
    assert.equal(f.ddlEtimeH, '18');
    assert.equal(f.ddlEtimeM, '30');
  });
  t('Telerik 날짜는 글자 칸만으로는 안 먹는다 — ClientState 까지 채운다', () => {
    assert.equal(f.txtSdate, '2026-09-18');
    assert.equal(f['txtSdate$dateInput'], '2026-09-18');
    const cs = JSON.parse(f.txtSdate_dateInput_ClientState);
    assert.equal(cs.valueAsString, '2026-09-18-00-00-00');
    assert.equal(f.txtSdate_calendar_SD, '[[2026,9,18]]');
  });
  t('종료 날짜 칸도 같이 채운다', () => assert.equal(f.txtEdate, '2026-09-18'));
  t('이미지 저장 버튼은 좌표로 누른다', () => {
    assert.equal(f['ibtnITSave.x'], '10');
    assert.equal(f['ibtnITSave.y'], '10');
  });
  t('사이트가 채워 준 사용자 값을 지우지 않는다 (빈 값을 얹지 않는다)', () =>
    assert.ok(!('txtDriver' in f)));
}

console.log('\nfnSaveCheck() 가 막는 것을 제출 전에 먼저 막는다');
{
  t('행선지가 비면 막는다', () =>
    assert.deepEqual(carFormProblems(got, { ...base, place: '' }, current),
      ['행선지는 필수 입력 사항입니다.']));
  t('같은 날 시작 >= 종료면 막는다', () =>
    assert.ok(carFormProblems(got, { ...base, start: '18:00', end: '09:00' }, current)
      .includes('시작시간이 종료시간보다 클 수 없습니다.')));
  t('사이트는 시(hour)만 보지만 우리는 분까지 본다 (09:50~09:00 을 막는다)', () =>
    assert.ok(carFormProblems(got, { ...base, start: '09:50', end: '09:00' }, current)
      .includes('시작시간이 종료시간보다 클 수 없습니다.')));
  t('같은 시 안의 정상 범위(09:30~09:50)는 통과', () =>
    assert.deepEqual(carFormProblems(got, { ...base, start: '09:30', end: '09:50' }, current), []));
  t('시작일 > 종료일이면 막는다', () =>
    assert.ok(carFormProblems(got, { ...base, endDate: '2026-09-17' }, current)
      .includes('시작일이 종료일보다 클 수 없습니다.')));
  t('여러 날에 걸친 신청은 통과', () =>
    assert.deepEqual(carFormProblems(got, { ...base, endDate: '2026-09-20', start: '18:00', end: '09:00' }, current), []));
  t('사용자가 비어 있으면 막는다 (폼에도 payload 에도 없을 때)', () =>
    assert.ok(carFormProblems(got, base, {}).includes('사용자는 필수 입력 사항입니다.')));
  t('사용목적은 사이트가 요구하지 않는다 — 우리도 막지 않는다', () =>
    assert.deepEqual(carFormProblems(got, { ...base, title: '' }, current), []));
  t('buildCarFields 는 막힌 값을 받으면 던진다', () =>
    assert.throws(() => buildCarFields(got, { ...base, place: '' }, current), /행선지/));
}

console.log('\n구조가 달라져도 내용으로 찾아낸다 (이름만 믿지 않는다)');
{
  // 실제로 추측한 이름이 전부 틀렸었다. 이름을 통째로 바꿔도 찾아내야 한다.
  const renamed = html
    .replace(/txtTitle/g, 'zzQ1').replace(/txtPlace/g, 'zzQ2')
    .replace(/ddlStimeH/g, 'zzH1').replace(/ddlStimeM/g, 'zzM1')
    .replace(/ddlEtimeH/g, 'zzH2').replace(/ddlEtimeM/g, 'zzM2');
  const r = detectCarForm(docOf(renamed));
  t('이름을 바꿔도 시/분 네 칸을 찾아낸다', () => {
    assert.equal(r.fields.startHour, 'zzH1');
    assert.equal(r.fields.startMinute, 'zzM1');
    assert.equal(r.fields.endHour, 'zzH2');
    assert.equal(r.fields.endMinute, 'zzM2');
  });
  t('이름을 바꿔도 행선지를 라벨로 찾아낸다', () => assert.equal(r.fields.place, 'zzQ2'));
}

console.log('\n모르면 모른다고 한다');
{
  const noSave = html.replace(/ibtnITSave/g, 'xxx').replace(/type="image"/g, 'type="hidden"');
  const r = detectCarForm(docOf(noSave));
  t('저장 버튼이 없으면 ok:false', () => assert.equal(r.ok, false));
  t('buildCarFields 는 ok:false 를 받으면 던진다', () =>
    assert.throws(() => buildCarFields(r, base, current), /확인하지 못해/));
}

console.log('');
console.log('날짜 칸은 폼이 쓰는 표기를 그대로 지킨다');
{
  // 2026-09-16 실제 사고: `$dateInput` 에 "2026-09-16" 을 밀어 넣어 저장이 터졌다.
  //   HTTP 500 — "Text property cannot be set. 문자열이 유효한 DateTime으로 인식되지 않습니다."
  // 이 폼의 `$dateInput` 표기는 "2026-09-16-00-00-00" 이고 회의실 폼은 "2026-09-16" 이다.
  // 한쪽 표기를 박아 두면 다른 쪽이 터진다. 브라우저가 실제로 보내는 본문과 대조해 잡았다.
  t('폼이 이미 그 날짜를 들고 있으면 날짜 칸을 건드리지 않는다', () => {
    const f = buildCarFields({ ...got, doc }, { ...base, date: '2026-09-16', endDate: '2026-09-16' }, current);
    for (const name of Object.keys(f)) {
      assert.ok(!/txtSdate|txtEdate/.test(name), `${name} 을 덮어썼다 — 폼 값 그대로 두어야 한다`);
    }
  });

  t('날짜를 옮길 때는 시각 표기(-00-00-00)를 지킨다', () => {
    const f = buildCarFields({ ...got, doc }, { ...base, date: '2026-09-18', endDate: '2026-09-19' }, current);
    assert.equal(f['txtSdate$dateInput'], '2026-09-18-00-00-00');
    assert.equal(f['txtEdate$dateInput'], '2026-09-19-00-00-00');
    assert.equal(f.txtSdate, '2026-09-18');
    assert.equal(f.txtEdate, '2026-09-19');
  });

  t('보이는 글자 칸도 같이 맞춘다', () => {
    const f = buildCarFields({ ...got, doc }, { ...base, date: '2026-09-18', endDate: '2026-09-18' }, current);
    assert.equal(f.txtSdate_dateInput_text, '2026-09-18');
  });

  t('보내는 이름은 모두 이 폼에 실제로 있는 칸이다', () => {
    const f = buildCarFields({ ...got, doc }, { ...base, date: '2026-09-18', endDate: '2026-09-19' }, current);
    for (const name of Object.keys(f)) {
      if (name.endsWith('.x') || name.endsWith('.y')) continue;
      assert.ok(doc.getElementsByName(name).length > 0, `${name} 이 폼에 없다`);
    }
  });
}

console.log('');
console.log('저장이 터진 화면에서 이유를 뽑아낸다');
{
  const { describeErrorPage } = await import('../src/net.js');
  const err500 = fs.readFileSync(new URL('./fixtures/rentcar-save-500.html', import.meta.url), 'utf8');
  t('500 화면에서 사이트가 말한 이유를 읽는다', () =>
    assert.match(describeErrorPage(err500), /유효한 DateTime으로 인식되지 않습니다/));
  t('알맹이 없는 오류 화면은 빈 문자열', () =>
    assert.equal(describeErrorPage('<html><title>Runtime Error</title></html>'), ''));
  t('본문이 없어도 터지지 않는다', () => assert.equal(describeErrorPage(''), ''));
}

console.log(`\n통과 ${pass}건`);
