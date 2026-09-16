// 활동 기록: 남기기·겹치면 횟수만 올리기·오래된 것 버리기, 그리고 복사할 보고서 모양.
import assert from 'node:assert/strict';
import {
  createLogbook, formatEntries, formatBridgeEntries, buildLogReport, stamp, LOG_KEY,
} from '../src/logbook.js';

let pass = 0;
const ta = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };

/** chrome.storage.local 흉내. 읽을 때마다 복사본을 준다(진짜 저장소처럼 참조가 새지 않게). */
function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    writes: 0,
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(obj) { this.writes++; Object.assign(data, structuredClone(obj)); },
  };
}

let clock = new Date(2026, 8, 16, 9, 0, 0).getTime();
const now = () => (clock += 1000);

console.log('남기기');
{
  const storage = memoryStorage();
  const book = createLogbook({ storage, now });
  await ta('빈 저장소에서 시작한다', async () => assert.deepEqual(await book.list(), []));
  await ta('한 건 남긴다', async () => {
    const e = await book.add('reserve', { ok: true, text: '제1회의실 10:00~11:00', data: { room: '제1회의실' } });
    assert.equal(e.kind, 'reserve');
    assert.equal(e.ok, true);
    assert.deepEqual(storage.data[LOG_KEY][0].data, { room: '제1회의실' });
  });
  await ta('상세가 없으면 data 칸을 만들지 않는다', async () => {
    await book.add('open', { text: '패널 열림' });
    const list = await book.list();
    assert.ok(!('data' in list[1]));
  });
  await ta('ok 를 안 주면 성공으로 본다, 거짓 값은 false 로 맞춘다', async () => {
    const e = await book.add('load', { ok: 0, text: '실패' });
    assert.equal(e.ok, false);
  });
}

console.log('같은 일이 이어지면 횟수만 올린다 (자동 갱신 실패로 목록이 차지 않게)');
{
  const storage = memoryStorage();
  const book = createLogbook({ storage, now });
  for (let i = 0; i < 5; i++) await book.add('load', { ok: false, text: '조회 실패: offline', data: { i } });
  const list = await book.list();
  await ta('한 줄로 합친다', async () => assert.equal(list.length, 1));
  await ta('횟수와 마지막 시각을 적는다', async () => {
    assert.equal(list[0].repeat, 5);
    assert.ok(list[0].lastAt > list[0].at);
  });
  await ta('상세는 마지막 것으로 바뀐다', async () => assert.deepEqual(list[0].data, { i: 4 }));
  await ta('성패가 다르면 합치지 않는다', async () => {
    await book.add('load', { ok: true, text: '조회 실패: offline' });
    assert.equal((await book.list()).length, 2);
  });
}

console.log('바뀔 때만 남기기 (다리 연결 상태)');
{
  const book = createLogbook({ storage: memoryStorage(), now });
  await book.add('cli', { ok: true, text: '연결됨', onlyIfChanged: true });
  await book.add('open', { text: '패널 열림' });
  const skipped = await book.add('cli', { ok: true, text: '연결됨', onlyIfChanged: true });
  await ta('사이에 다른 기록이 있어도 같은 상태면 건너뛴다', async () => {
    assert.equal(skipped, null);
    assert.equal((await book.list()).length, 2);
  });
  await ta('상태가 바뀌면 남긴다', async () => {
    await book.add('cli', { ok: false, text: '없음', onlyIfChanged: true });
    assert.equal((await book.list()).at(-1).text, '없음');
  });
}

console.log('오래된 것 버리기와 크기 제한');
{
  const storage = memoryStorage();
  const book = createLogbook({ storage, max: 3, now });
  for (let i = 0; i < 5; i++) await book.add('ask', { text: `질문 ${i}` });
  await ta('최근 max 건만 남는다', async () =>
    assert.deepEqual((await book.list()).map((e) => e.text), ['질문 2', '질문 3', '질문 4']));

  const big = await book.add('reserve', { text: '큰 상세', data: { html: 'x'.repeat(20000) } });
  await ta('큰 상세는 잘라 둔다', async () => {
    assert.ok(big.data.truncated.length < 7000);
    assert.ok(big.data.length > 20000);
  });

  const cyc = {};
  cyc.self = cyc;
  const odd = await book.add('reserve', { text: '순환 참조', data: cyc });
  await ta('직렬화할 수 없는 상세도 기록 자체는 남는다', async () =>
    assert.ok(odd.data.note));
}

console.log('동시에 남겨도 사라지지 않는다');
{
  const storage = memoryStorage();
  const book = createLogbook({ storage, now });
  await Promise.all(Array.from({ length: 20 }, (_, i) => book.add('reserve', { text: `건 ${i}` })));
  await ta('20건 모두 남는다', async () => assert.equal((await book.list()).length, 20));
  await ta('순서도 부른 차례대로', async () =>
    assert.equal((await book.list()).map((e) => e.text).join(','), Array.from({ length: 20 }, (_, i) => `건 ${i}`).join(',')));
}

console.log('저장소가 말썽이어도 본 작업을 막지 않는다');
{
  const broken = { get: async () => { throw new Error('quota'); }, set: async () => { throw new Error('quota'); } };
  const book = createLogbook({ storage: broken, now });
  await ta('add 가 예외를 내지 않는다', async () => assert.ok(await book.add('load', { text: 'x' })));
  await ta('list 는 빈 목록', async () => assert.deepEqual(await book.list(), []));
  const book2 = createLogbook({ storage: memoryStorage({ [LOG_KEY]: 'garbage' }), now });
  await ta('저장된 값이 목록이 아니면 빈 목록으로 본다', async () => assert.deepEqual(await book2.list(), []));
}

console.log('비우기');
{
  const storage = memoryStorage();
  const book = createLogbook({ storage, now });
  await book.add('reserve', { text: 'a' });
  await book.clear();
  await ta('다 지워진다', async () => assert.deepEqual(await book.list(), []));
}

console.log('사람이 읽는 줄');
{
  const at = new Date(2026, 8, 16, 14, 5, 9).getTime();
  await ta('시각은 로컬 시각 YYYY-MM-DD HH:MM:SS', async () => assert.equal(stamp(at), '2026-09-16 14:05:09'));
  await ta('ISO 문자열도 읽는다', async () => assert.equal(stamp(new Date(at).toISOString()), '2026-09-16 14:05:09'));
  await ta('못 읽는 시각은 그대로 둔다', async () => assert.equal(stamp('어제'), '어제'));

  const entries = [
    { at, kind: 'reserve', ok: false, text: '제1회의실 실패', data: { message: '겹침' } },
    { at, kind: 'load', ok: false, text: '조회 실패', repeat: 3, lastAt: at + 120000 },
    { at, kind: 'mystery', ok: true, text: '모르는 종류' },
  ];
  const text = formatEntries(entries);
  await ta('성패 표시와 종류 이름', async () => assert.match(text, /^2026-09-16 14:05:09 {2}✕ \[예약\] 제1회의실 실패$/m));
  await ta('상세는 들여 쓴 다음 줄에', async () => assert.match(text, /\n {4}\{"message":"겹침"\}\n/));
  await ta('합친 횟수를 적는다', async () => assert.match(text, /조회 실패 \(×3, 마지막 2026-09-16 14:07:09\)/));
  await ta('모르는 종류는 이름 그대로', async () => assert.match(text, /\[mystery\]/));
  await ta('detail:false 면 상세를 빼고 한 줄씩', async () =>
    assert.equal(formatEntries(entries, { detail: false }).split('\n').length, 3));

  const bridge = formatBridgeEntries([
    { at: new Date(at).toISOString(), task: 'parse', ok: true, ms: 5400, costUsd: 0.0123, input: '내일', data: { summary: 's' } },
    { at: new Date(at).toISOString(), task: 'diagnose', ok: false, ms: 80, error: 'claude 종료 코드 1', exitCode: 1 },
  ]);
  await ta('다리 기록: 작업·시간·비용', async () => assert.match(bridge, /✓ \[parse\] 5400ms · \$0\.0123/));
  await ta('다리 기록: 실패 이유와 나머지 사정', async () => {
    assert.match(bridge, /✕ \[diagnose\] 80ms · claude 종료 코드 1/);
    assert.match(bridge, /"exitCode":1/);
  });
}

console.log('복사할 보고서');
{
  const at = new Date(2026, 8, 16, 14, 0, 0).getTime();
  const entries = [
    { at, kind: 'reserve', ok: true, text: '성공' },
    { at, kind: 'reserve', ok: false, text: '실패' },
  ];
  const report = buildLogReport({
    entries,
    bridge: { entries: [{ at, task: 'parse', ok: true, ms: 1 }] },
    meta: { 확장: '0.2.0', 지역: null, 다리: '연결됨' },
    now: at,
  });
  await ta('머리말에 건수와 실패 수', async () => assert.match(report, /확장 기록 2건 \(실패 1\)/));
  await ta('비어 있는 환경 값은 빼고 적는다', async () => {
    assert.match(report, /환경: 확장=0\.2\.0 · 다리=연결됨/);
    assert.doesNotMatch(report, /지역=/);
  });
  await ta('두 기록이 다 들어간다', async () => {
    assert.match(report, /== 확장 기록/);
    assert.match(report, /\[parse\]/);
  });
  await ta('다리를 못 부르면 이유를 적는다', async () =>
    assert.match(buildLogReport({ entries: [], bridge: { entries: null, error: '호스트 없음' } }),
      /\(가져오지 못했습니다: 호스트 없음\)/));
  await ta('다리 기록이 비어 있으면 비었다고 적는다', async () =>
    assert.match(buildLogReport({ entries: [], bridge: { entries: [] } }), /로컬 Claude 다리 기록[^\n]*\n\(기록 없음\)/));
  await ta('확장 기록이 없으면 없다고 적는다', async () =>
    assert.match(buildLogReport({ entries: [], bridge: null }), /확장 기록 \(오래된 것부터\) ==\n\(기록 없음\)/));
}

console.log(`\n통과 ${pass}건`);
