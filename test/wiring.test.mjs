// sidepanel 의 init() 이 정말 모든 리스너를 붙이는지 확인한다.
// 저장된 상태(특히 mode:'car')에 따라 조기 return 으로 배선을 건너뛴 적이 있다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(process.env.JSDOM_BASE || import.meta.url);
const { JSDOM } = require('jsdom');

const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('sidepanel.html', root), 'utf8');
const js = fs.readFileSync(new URL('sidepanel.js', root), 'utf8');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

/** 저장된 설정을 주고 init 을 돌린 뒤, 어떤 요소에 리스너가 붙었는지 본다. */
async function boot(saved) {
  const dom = new JSDOM(html, { url: 'https://example.org/', runScripts: 'outside-only' });
  const { window } = dom;
  const wired = new Map();

  // addEventListener 호출을 기록한다
  const orig = window.Element.prototype.addEventListener;
  window.Element.prototype.addEventListener = function (type, fn, opts) {
    const id = this.id || this.tagName;
    if (!wired.has(id)) wired.set(id, new Set());
    wired.get(id).add(type);
    return orig.call(this, type, fn, opts);
  };

  const calls = { load: 0, urls: [] };
  window.chrome = {
    storage: { local: {
      get: async () => saved,
      set: async () => {},
    } },
    runtime: { sendNativeMessage: async () => { throw new Error('no host'); } },
    tabs: { query: async () => [], create: async () => {} },
    downloads: { download: async () => {} },
    scripting: { executeScript: async () => [{ result: null }] },
  };
  // 네트워크는 막는다. load() 가 실패해도 배선은 이미 끝나 있어야 한다.
  // 어느 화면을 두드렸는지는 남긴다 — 시작하자마자 한 달을 훑는지 여기서 본다.
  window.fetch = async (url) => { calls.load++; calls.urls.push(String(url)); throw new Error('offline'); };

  // 타이머는 Node 것을 그대로 쓴다. jsdom 의 setTimeout 을 전역에 덮으면 서로를 불러 무한 재귀가 된다.
  const globals = ['document', 'chrome', 'fetch', 'DOMParser', 'Option', 'Blob', 'URL', 'Element', 'HTMLElement'];
  for (const g of globals) globalThis[g] = window[g] ?? globalThis[g];
  globalThis.window = window;
  globalThis.document = window.document;

  await import(`../sidepanel.js?bust=${Math.random()}`);
  await new Promise((r) => setTimeout(r, 60));   // init 의 await 가 풀릴 시간
  return { wired, window, calls };
}

console.log('회의실 모드로 시작');
{
  const { wired } = await boot({ mode: 'room' });
  t('날짜 입력에 change', () => assert.ok(wired.get('date')?.has('change')));
  t('날짜 입력에 input', () => assert.ok(wired.get('date')?.has('input')));
  t('회의실 탭 클릭', () => assert.ok(wired.get('tabRoom')?.has('click')));
  t('차량 탭 클릭', () => assert.ok(wired.get('tabCar')?.has('click')));
  t('내 예약 탭 클릭', () => assert.ok(wired.get('tabMine')?.has('click')));
  t('내 예약 목록 클릭', () => assert.ok(wired.get('mineList')?.has('click')));
  t('기간 선택', () => assert.ok(wired.get('spanDays')?.has('change')));
  t('내 이름 입력', () => assert.ok(wired.get('myName')?.has('change')));
  t('새로고침 클릭', () => assert.ok(wired.get('refresh')?.has('click')));
  t('이전/다음 날', () => {
    assert.ok(wired.get('prevDay')?.has('click'));
    assert.ok(wired.get('nextDay')?.has('click'));
  });
  t('오늘 버튼', () => assert.ok(wired.get('today')?.has('click')));
  t('현황 옆 페이지 열기 아이콘', () => assert.ok(wired.get('openPageInline')?.has('click')));
  t('예약/연장/취소/수정 버튼', () => {
    assert.ok(wired.get('submit')?.has('click'));
    assert.ok(wired.get('extend')?.has('click'));
    assert.ok(wired.get('cancelBooking')?.has('click'));
    assert.ok(wired.get('modify')?.has('click'), '수정 버튼에 리스너가 없다');
  });
}

console.log('차량 모드로 시작 (조기 return 회귀 방지)');
{
  const { wired, window } = await boot({ mode: 'car' });
  const doc = window.document;
  t('날짜 입력에 change', () => assert.ok(wired.get('date')?.has('change')));
  t('회의실 탭 클릭', () => assert.ok(wired.get('tabRoom')?.has('click')));
  t('차량 탭 클릭', () => assert.ok(wired.get('tabCar')?.has('click')));
  t('새로고침 클릭', () => assert.ok(wired.get('refresh')?.has('click')));
  t('시간 선택', () => assert.ok(wired.get('hourStart')?.has('change')));
  t('현황 옆 페이지 열기 아이콘', () => assert.ok(wired.get('openPageInline')?.has('click')));
  t('자동 갱신 토글', () => assert.ok(wired.get('auto')?.has('change')));

  // 차량은 오래 "조회 전용"이었다. 신청 칸이 뜨는지 여기서 붙잡아 둔다.
  t('차량 탭에서 신청 칸(행선지·동승자)이 보인다', () => {
    assert.ok(!doc.getElementById('carFields').classList.contains('hidden'));
    assert.ok(doc.getElementById('fPlace'));
    assert.ok(doc.getElementById('fPassenger'));
  });
  t('차량 탭에서는 회의주제가 아니라 사용목적', () =>
    assert.equal(doc.getElementById('lblTitle').textContent, '사용목적'));
  t('더 이상 조회 전용이라고 하지 않는다', () =>
    assert.doesNotMatch(doc.querySelector('.selection-hint').textContent, /조회 전용/));
  t('수정 버튼이 DOM 에 있다', () => assert.ok(doc.getElementById('modify')));
}

console.log('회의실 탭에서는 차량 신청 칸이 숨는다');
{
  const { window } = await boot({ mode: 'room' });
  const doc = window.document;
  t('행선지 칸이 숨어 있다', () =>
    assert.ok(doc.getElementById('carFields').classList.contains('hidden')));
  t('회의 주제 라벨', () => assert.equal(doc.getElementById('lblTitle').textContent, '회의 주제'));
  t('수정 중 안내는 처음엔 숨어 있다', () =>
    assert.ok(doc.getElementById('editNote').classList.contains('hidden')));
}

console.log('Claude 가 안 붙어 있으면 말로 찾기 칸이 잠긴다');
{
  // 이 harness 의 sendNativeMessage 는 늘 던진다 = 로컬 CLI 없음.
  const { window } = await boot({ mode: 'room' });
  const doc = window.document;
  t('입력칸과 버튼이 잠겨 있다', () => {
    assert.ok(doc.getElementById('askInput').disabled, '입력칸이 열려 있다');
    assert.ok(doc.getElementById('askGo').disabled, '찾기 버튼이 눌린다');
  });
  t('왜 잠겼는지 플레이스홀더에 적혀 있다', () =>
    assert.equal(doc.getElementById('askInput').placeholder, 'claude가 연결되지 않았습니다'));
}

console.log('API 키가 있으면 말로 찾기 칸이 열린다');
{
  const { window } = await boot({ mode: 'room', apiKey: 'sk-ant-test' });
  const doc = window.document;
  t('입력칸이 열려 있다', () => assert.ok(!doc.getElementById('askInput').disabled));
  t('제목 몫을 하던 플레이스홀더로 돌아온다', () =>
    assert.equal(doc.getElementById('askInput').placeholder, '말로 찾는 회의실/차량'));
}

console.log('내 예약 모드로 시작 (조기 return 회귀 방지)');
{
  const { wired, window } = await boot({ mode: 'mine' });
  const doc = window.document;
  t('회의실 탭 클릭', () => assert.ok(wired.get('tabRoom')?.has('click')));
  t('내 예약 탭 클릭', () => assert.ok(wired.get('tabMine')?.has('click')));
  t('내 예약 목록 클릭', () => assert.ok(wired.get('mineList')?.has('click')));
  t('기간 선택', () => assert.ok(wired.get('spanDays')?.has('change')));
  t('새로고침 클릭', () => assert.ok(wired.get('refresh')?.has('click')));
  t('내 예약 탭이 켜져 있다', () =>
    assert.ok(doc.getElementById('tabMine').classList.contains('active')));
  t('목록이 보이고 격자는 숨는다', () => {
    assert.ok(!doc.getElementById('mineWrap').classList.contains('hidden'));
    assert.ok(doc.getElementById('grid').classList.contains('hidden'));
  });
  t('제목 옆에 훑는 기간이 찍힌다', () =>
    assert.match(doc.getElementById('scheduleDate').textContent, /^\d+\/\d+ ~ \d+\/\d+$/));
}

console.log('현황 제목은 보고 있는 날짜를 말해야 한다');
{
  const { window } = await boot({ mode: 'room' });
  const doc = window.document;
  doc.getElementById('date').value = '2026-09-19';
  doc.getElementById('date').dispatchEvent(new window.Event('change'));
  await new Promise((r) => setTimeout(r, 30));
  t('9월 19일 (토)', () =>
    assert.equal(doc.getElementById('scheduleDate').textContent, '9월 19일 (토)'));
}

console.log('오늘 버튼은 오늘을 볼 때만 켜진다');
{
  const { window } = await boot({ mode: 'room' });
  const doc = window.document;
  const today = doc.getElementById('today');
  t('시작하면 오늘이라 켜져 있다', () => assert.ok(today.classList.contains('on')));

  const date = doc.getElementById('date');
  date.value = '2000-01-01';
  date.dispatchEvent(new window.Event('change'));
  await new Promise((r) => setTimeout(r, 30));
  t('다른 날로 옮기면 꺼진다', () => {
    assert.ok(!today.classList.contains('on'));
    assert.equal(today.getAttribute('aria-current'), null);
  });

  today.click();
  await new Promise((r) => setTimeout(r, 30));
  t('오늘을 누르면 다시 켜진다', () => assert.ok(today.classList.contains('on')));
}

console.log('시작하면 세 탭 몫을 한 번에 — 오늘부터 한 달을 미리 훑는다');
{
  const { window, calls } = await boot({ mode: 'room' });
  await new Promise((r) => setTimeout(r, 150));   // 미리 훑기가 두 화면을 두드릴 시간
  const doc = window.document;

  t('회의실 화면을 두드린다', () =>
    assert.ok(calls.urls.some((u) => /MeetingRoom\/List\.aspx/.test(u))));
  t('차량 화면도 두드린다 (보고 있지 않아도)', () =>
    assert.ok(calls.urls.some((u) => /RentCar\/New_List\.aspx/.test(u)),
      '두드린 곳: ' + calls.urls.join(', ')));
  t('기간 기본값은 한 달', () => assert.equal(doc.getElementById('spanDays').value, '30'));
  t('한 달 훑기 막대가 붙어 있다', () => assert.ok(doc.getElementById('scanBar')));
}

console.log('내 예약 탭으로 열려도 미리 훑기와 겹치지 않는다');
{
  const { window, calls } = await boot({ mode: 'mine' });
  await new Promise((r) => setTimeout(r, 150));
  const doc = window.document;

  // 훑기는 한 번에 하나만 돈다. 내 예약이 먼저 돌면 미리 훑기는 그것을 기다렸다 빈 날만 채운다.
  // 로그인이 막힌 이 환경에서는 화면당 한 번씩만 두드려야 한다 — 겹쳐 돌면 두 배로 두드린다.
  t('회의실 화면을 두 번 넘게 두드리지 않는다', () =>
    assert.ok(calls.urls.filter((u) => /MeetingRoom\/List\.aspx/.test(u)).length <= 2,
      '두드린 곳: ' + calls.urls.join(', ')));
  t('차량 화면도 마찬가지', () =>
    assert.ok(calls.urls.filter((u) => /RentCar\/New_List\.aspx/.test(u)).length <= 2,
      '두드린 곳: ' + calls.urls.join(', ')));
  t('훑는 기간이 한 달로 찍힌다', () =>
    assert.match(doc.getElementById('scheduleDate').textContent, /^\d+\/\d+ ~ \d+\/\d+$/));
}

console.log(`\n통과 ${pass}건`);

// sidepanel 이 자동 갱신 타이머를 붙여 두어 jsdom 에서는 이벤트 루프가 비지 않는다.
// 명시적으로 끝낸다 — 안 그러면 테스트가 통과하고도 프로세스가 매달려 있다.
process.exit(0);
