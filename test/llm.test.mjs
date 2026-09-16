// 백엔드 선택: 로컬 CLI → API 키 → 규칙 해석 순으로 내려가는지 확인한다.
import assert from 'node:assert/strict';

const TODAY = '2026-09-16';
let pass = 0;
const ta = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };

/** chrome.runtime.sendNativeMessage 와 fetch 를 상황별로 흉내낸다. */
function setup({ native, api }) {
  globalThis.chrome = {
    runtime: {
      sendNativeMessage: async (_host, msg) => {
        if (native === 'absent') throw new Error('호스트를 찾을 수 없습니다');
        if (msg.task === 'ping') return { ok: true, pong: true };
        if (native === 'error') return { ok: false, error: 'CLI 오류' };
        return { ok: true, costUsd: 0.01, data: { summary: 'CLI 해석', dateFrom: '2026-09-20', dateTo: '2026-09-20', hourFrom: 8, hourTo: 12, minSeats: 10, minHours: null, region: null } };
      },
    },
  };
  globalThis.fetch = async () => {
    if (api === 'error') return { ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) };
    return {
      ok: true,
      json: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ summary: 'API 해석', dateFrom: '2026-09-21', dateTo: '2026-09-21', hourFrom: 9, hourTo: 18, minSeats: null, minHours: null, region: null }) }],
      }),
    };
  };
}

const load = async () => import(`../src/llm.js?b=${Math.random()}`);

console.log('해석 백엔드 선택');

await ta('CLI 가 되면 CLI 를 쓴다', async () => {
  setup({ native: 'ok', api: 'ok' });
  const { parseSmart } = await load();
  const r = await parseSmart('9월 20일 8시~12시 10명', { apiKey: 'sk-x', today: TODAY, useNative: true });
  assert.equal(r.via, 'cli');
  assert.equal(r.filter.summary, 'CLI 해석');
});

await ta('CLI 가 실패하면 API 키로 내려간다', async () => {
  setup({ native: 'error', api: 'ok' });
  const { parseSmart } = await load();
  const r = await parseSmart('아무거나', { apiKey: 'sk-x', today: TODAY, useNative: true });
  assert.equal(r.via, 'api');
  assert.ok(r.note.includes('로컬 CLI 실패'), r.note);
});

await ta('둘 다 실패하면 규칙으로 내려간다', async () => {
  setup({ native: 'error', api: 'error' });
  const { parseSmart } = await load();
  const r = await parseSmart('내일 오후 10명', { apiKey: 'sk-x', today: TODAY, useNative: true });
  assert.equal(r.via, 'local');
  assert.equal(r.filter.dateFrom, '2026-09-17');
  assert.equal(r.filter.minSeats, 10);
});

await ta('설정이 아무것도 없으면 바로 규칙을 쓴다', async () => {
  setup({ native: 'absent', api: 'error' });
  const { parseSmart } = await load();
  const r = await parseSmart('9/22 오전 부산', { apiKey: '', today: TODAY, useNative: false });
  assert.equal(r.via, 'local');
  assert.equal(r.filter.region, '부산');
});

await ta('CLI 를 끄면 API 를 쓴다', async () => {
  setup({ native: 'ok', api: 'ok' });
  const { parseSmart } = await load();
  const r = await parseSmart('아무거나', { apiKey: 'sk-x', today: TODAY, useNative: false });
  assert.equal(r.via, 'api');
});

console.log('CLI 연결 확인');
await ta('호스트가 있으면 true', async () => {
  setup({ native: 'ok', api: 'ok' });
  const { nativeAvailable } = await load();
  assert.equal(await nativeAvailable(), true);
});
await ta('호스트가 없으면 false (예외를 밖으로 던지지 않는다)', async () => {
  setup({ native: 'absent', api: 'ok' });
  const { nativeAvailable } = await load();
  assert.equal(await nativeAvailable(), false);
});

console.log('실패 원인 분석 백엔드');
await ta('CLI 로 분석한다', async () => {
  setup({ native: 'ok', api: 'ok' });
  const { diagnoseSmart } = await load();
  const r = await diagnoseSmart({ 보낸값: {} }, { apiKey: 'sk-x', useNative: true });
  assert.equal(r.via, 'cli');
});
await ta('둘 다 안 되면 null 을 주고 조용히 넘어간다', async () => {
  setup({ native: 'absent', api: 'error' });
  const { diagnoseSmart } = await load();
  assert.equal(await diagnoseSmart({}, { apiKey: '', useNative: false }), null);
});

console.log(`\n통과 ${pass}건`);
