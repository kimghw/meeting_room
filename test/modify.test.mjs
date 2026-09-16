// 수정(취소 → 재예약) 조율 규칙. 가짜 콜백만으로 모든 갈림길을 덮는다.
//
// 여기서 가장 중요한 건 **"제출은 됐는데 확인이 안 된" 새 예약을 복구하지 않는 것**이다.
// 되살리면 이중 예약이 되므로, 모를 때는 모른다고(uncertain) 말하고 사람에게 넘긴다.
import assert from 'node:assert/strict';
import { modifyReservation, describeModifyResult } from '../src/modify.js';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const ta = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };

/** 부른 횟수를 세는 가짜 콜백. */
function spy(impl) {
  const f = async (...args) => { f.calls++; return impl(...args); };
  f.calls = 0;
  return f;
}
/** 재조회까지 끝난 성공 응답(site.js 가 주는 모양). */
const done = (extra = {}) => spy(async () => ({ ok: true, submitted: true, verified: true, message: '', ...extra }));
/** 제출 자체를 못 한 실패(겹침 검사·폼 날짜 확인에서 멈춘 경우). */
const notSent = (message) => spy(async () => ({ ok: false, submitted: false, message }));
/** 제출은 했는데 재조회로 확인 못 한 경우 — 저장됐을 수도 있다. */
const unsure = (message) => spy(async () => ({ ok: false, submitted: true, verified: false, message }));
/** 예외를 던지는 콜백(네트워크가 끊긴 경우 등). */
const boom = (message) => spy(async () => { throw new Error(message); });

console.log('1) 취소가 실패하면 아무것도 건드리지 않는다');
await ta('stage:cancel, restored:true, lost:false', async () => {
  const plan = { cancel: notSent('삭제 정보를 찾지 못했습니다.'), reserve: done(), restore: done() };
  const r = await modifyReservation(plan);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'cancel');
  assert.equal(r.restored, true);
  assert.equal(r.lost, false);
  assert.equal(r.uncertain, false);
  assert.match(r.message, /삭제 정보를 찾지 못했습니다/);
  assert.equal(plan.reserve.calls, 0, '취소도 못 했는데 새로 넣으면 안 된다');
  assert.equal(plan.restore.calls, 0);
});

console.log('2) 취소 + 예약 성공');
await ta('stage:done, record 가 그대로 전달된다', async () => {
  const record = { room: '미팅룸1(1층)-8석', start: 540, end: 660 };
  const plan = { cancel: done(), reserve: done({ record }), restore: done() };
  const r = await modifyReservation(plan);
  assert.equal(r.ok, true);
  assert.equal(r.stage, 'done');
  assert.equal(r.restored, false);
  assert.equal(r.lost, false);
  assert.equal(r.uncertain, false);
  assert.equal(r.record, record);
  assert.equal(plan.restore.calls, 0, '성공했는데 되살리면 이중 예약이다');
});
await ta('사이트 alert 문구가 있으면 메시지에 남는다', async () => {
  const r = await modifyReservation({ cancel: done(), reserve: done({ message: '저장되었습니다' }), restore: done() });
  assert.equal(r.ok, true);
  assert.match(r.message, /저장되었습니다/);
});

console.log('3) 예약이 제출조차 못 하면 되살린다');
await ta('stage:reserve, restored:true, 원래 실패 이유가 남는다', async () => {
  const plan = { cancel: done(), reserve: notSent('그 시간에 이미 예약이 있습니다.'), restore: done() };
  const r = await modifyReservation(plan);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'reserve');
  assert.equal(r.restored, true);
  assert.equal(r.lost, false);
  assert.equal(r.uncertain, false);
  assert.equal(plan.restore.calls, 1);
  assert.match(r.message, /이미 예약이 있습니다/);
});

console.log('4) 되살리기까지 실패하면 사람에게 넘긴다');
await ta('stage:restore, lost:true, 사이트에서 확인하라고 말한다', async () => {
  const plan = { cancel: done(), reserve: notSent('폼 날짜가 옮겨지지 않았습니다.'), restore: notSent('복구 제출 실패') };
  const r = await modifyReservation(plan);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'restore');
  assert.equal(r.restored, false);
  assert.equal(r.lost, true);
  assert.equal(r.uncertain, false);
  assert.match(r.message, /사이트에서 확인/);
  assert.match(r.message, /폼 날짜가 옮겨지지 않았습니다/);
});

console.log('5) 제출은 됐는데 확인 못 한 새 예약 — 복구하지 않는다 (이중 예약 방지)');
await ta('uncertain:true, restore 를 부르지 않는다', async () => {
  const plan = { cancel: done(), reserve: unsure('다시 조회했지만 해당 시간에 예약이 보이지 않습니다.'), restore: done() };
  const r = await modifyReservation(plan);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'reserve');
  assert.equal(r.uncertain, true);
  assert.equal(r.restored, false);
  assert.equal(r.lost, false, '새 예약이 그 자리를 잡았을 수 있어 사라졌다고 단정하지 않는다');
  assert.equal(plan.restore.calls, 0, '되살리면 이중 예약이 된다');
  assert.match(r.message, /이중 예약/);
  assert.match(r.message, /사이트에서 확인/);
});

console.log('6~8) 예외가 밖으로 새지 않는다');
await ta('cancel 이 던져도 stage:cancel 실패로 잡힌다', async () => {
  const plan = { cancel: boom('네트워크 끊김'), reserve: done(), restore: done() };
  const r = await modifyReservation(plan);
  assert.equal(r.stage, 'cancel');
  assert.equal(r.ok, false);
  assert.equal(r.restored, true);
  assert.equal(r.lost, false);
  assert.match(r.message, /네트워크 끊김/);
  assert.equal(plan.reserve.calls, 0);
});
await ta('reserve 가 던지면 복구를 시도한다', async () => {
  const plan = { cancel: done(), reserve: boom('제출 실패'), restore: done() };
  const r = await modifyReservation(plan);
  assert.equal(plan.restore.calls, 1);
  assert.equal(r.stage, 'reserve');
  assert.equal(r.restored, true);
  assert.equal(r.uncertain, false);
  assert.match(r.message, /제출 실패/);
});
await ta('restore 가 던지면 lost:true', async () => {
  const r = await modifyReservation({
    cancel: done(),
    reserve: notSent('시간 범위가 올바르지 않습니다.'),
    restore: boom('복구 중 오류'),
  });
  assert.equal(r.stage, 'restore');
  assert.equal(r.lost, true);
  assert.equal(r.restored, false);
  assert.match(r.message, /사이트에서 확인/);
  assert.match(r.message, /복구 중 오류/);
});

console.log('9) 진행 표시');
await ta('단계마다 한 번씩 부른다', async () => {
  const seen = [];
  await modifyReservation({
    cancel: done(), reserve: notSent('실패'), restore: done(),
    onStage: (stage, text) => seen.push([stage, text]),
  });
  assert.deepEqual(seen.map(([s]) => s), ['cancel', 'reserve', 'restore']);
  assert.ok(seen.every(([, text]) => typeof text === 'string' && text.length > 0), '문구도 함께 준다');
});
await ta('성공하면 복구 단계는 알리지 않는다', async () => {
  const seen = [];
  await modifyReservation({ cancel: done(), reserve: done(), restore: done(), onStage: (s) => seen.push(s) });
  assert.deepEqual(seen, ['cancel', 'reserve']);
});
await ta('onStage 를 안 줘도 동작한다', async () => {
  const r = await modifyReservation({ cancel: done(), reserve: done() });
  assert.equal(r.ok, true);
});
await ta('onStage 가 던져도 수정 흐름은 계속된다', async () => {
  const r = await modifyReservation({
    cancel: done(), reserve: done(),
    onStage: () => { throw new Error('UI 오류'); },
  });
  assert.equal(r.ok, true);
});

console.log('10) 엇갈린 결과를 성공으로 보지 않는다');
await ta('예약이 ok:true, verified:false 면 성공이 아니고 복구도 안 한다', async () => {
  const plan = {
    cancel: done(),
    reserve: spy(async () => ({ ok: true, submitted: true, verified: false, message: '확인 조회 실패' })),
    restore: done(),
  };
  const r = await modifyReservation(plan);
  assert.equal(r.ok, false);
  assert.equal(r.uncertain, true, '저장됐을 수 있으니 모른다고 말한다');
  assert.equal(plan.restore.calls, 0);
});
await ta('취소가 ok:true, verified:false 면 취소 실패로 본다', async () => {
  const plan = {
    cancel: spy(async () => ({ ok: true, verified: false, message: '취소를 확인하지 못했습니다.' })),
    reserve: done(), restore: done(),
  };
  const r = await modifyReservation(plan);
  assert.equal(r.stage, 'cancel');
  assert.equal(plan.reserve.calls, 0);
});
await ta('콜백이 아무것도 안 돌려줘도 성공이 아니다', async () => {
  const plan = { cancel: spy(async () => undefined), reserve: done() };
  const r = await modifyReservation(plan);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'cancel');
  assert.equal(plan.reserve.calls, 0);
});
await ta('reserve 콜백이 아예 없으면 제출 전 실패로 보고 되살린다', async () => {
  const plan = { cancel: done(), restore: done() };
  const r = await modifyReservation(plan);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'reserve');
  assert.equal(r.restored, true);
  assert.equal(plan.restore.calls, 1);
});
await ta('빈 계획을 줘도 예외를 던지지 않는다', async () => {
  const r = await modifyReservation();
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'cancel');
  assert.ok(r.message.length > 0);
});

console.log('11) 한 문장으로 만들기');
await ta('성공은 kind 없이, 확인 링크도 없이', async () => {
  const d = describeModifyResult(await modifyReservation({ cancel: done(), reserve: done() }));
  assert.equal(d.kind, '');
  assert.equal(d.needsSiteCheck, false);
  assert.match(d.text, /수정했습니다/);
});
await ta('취소 실패는 error, 확인 링크는 없다', async () => {
  const d = describeModifyResult(await modifyReservation({ cancel: notSent('취소 실패'), reserve: done() }));
  assert.equal(d.kind, 'error');
  assert.equal(d.needsSiteCheck, false);
  assert.match(d.text, /취소 실패/);
});
await ta('되살린 경우도 error, 확인 링크는 없다', async () => {
  const d = describeModifyResult(await modifyReservation({ cancel: done(), reserve: notSent('예약 실패'), restore: done() }));
  assert.equal(d.kind, 'error');
  assert.equal(d.needsSiteCheck, false);
  assert.match(d.text, /예약 실패/);
});
await ta('lost 면 확인 링크를 붙인다', async () => {
  const d = describeModifyResult(await modifyReservation({
    cancel: done(), reserve: notSent('예약 실패'), restore: notSent('복구 실패'),
  }));
  assert.equal(d.kind, 'error');
  assert.equal(d.needsSiteCheck, true);
  assert.match(d.text, /사이트에서 확인/);
});
await ta('uncertain 이면 확인 링크를 붙인다', async () => {
  const d = describeModifyResult(await modifyReservation({ cancel: done(), reserve: unsure('확인 불가'), restore: done() }));
  assert.equal(d.kind, 'error');
  assert.equal(d.needsSiteCheck, true);
  assert.match(d.text, /이중 예약/);
});
t('결과가 없으면 모른다고 말한다', () => {
  const d = describeModifyResult(null);
  assert.equal(d.kind, 'error');
  assert.equal(d.needsSiteCheck, true);
  assert.match(d.text, /사이트에서 확인/);
});
t('메시지가 비어 있어도 빈 문장을 주지 않는다', () => {
  assert.ok(describeModifyResult({ ok: true }).text.length > 0);
  assert.ok(describeModifyResult({ ok: false }).text.length > 0);
});

console.log(`\n통과 ${pass}건`);
