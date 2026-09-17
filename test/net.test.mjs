// 탭 경유 폴백이 없는 문맥(홈의 콘텐츠 스크립트)에서 siteFetch 가 바르게 끝나는지.
// chrome.tabs 가 없다고 TypeError 로 죽으면 카드는 "Cannot read properties of undefined" 를 보여주게 된다.
import assert from 'node:assert/strict';
import { siteFetch, AuthError, canTabFetch } from '../src/net.js';

let pass = 0;
const ta = async (name, fn) => { await fn(); pass++; console.log('  ok  ' + name); };

const page = (html, { ok = true, status = 200, url = 'https://eclass.krs.co.kr/x' } = {}) => ({
  ok, status, statusText: '', url,
  headers: { get: () => 'text/html; charset=utf-8' },
  arrayBuffer: async () => new TextEncoder().encode(html).buffer,
});
const LOGGED_IN = '<html><body>' + 'x'.repeat(2000) + '<table id="RG_MAIN_ctl00"></table></body></html>';
const SIGN_IN = '<script>alert("You must sign in.");</script>';

console.log('콘텐츠 스크립트 문맥 (chrome.tabs 없음)');
globalThis.chrome = { runtime: {} };
await ta('탭 경유를 쓸 수 없다고 안다', async () => assert.equal(canTabFetch(), false));
await ta('직접 요청이 되면 그대로 돌려준다', async () => {
  globalThis.fetch = async () => page(LOGGED_IN);
  const r = await siteFetch('https://eclass.krs.co.kr/x');
  assert.equal(r.via, 'direct');
  assert.match(r.html, /RG_MAIN/);
});
await ta('미인증 응답이면 TypeError 가 아니라 AuthError', async () => {
  globalThis.fetch = async () => page(SIGN_IN);
  await assert.rejects(siteFetch('https://eclass.krs.co.kr/x'),
    (err) => err instanceof AuthError && /로그인이 필요/.test(err.message));
});
await ta('직접 요청이 실패하면 그 실패를 그대로 말한다', async () => {
  globalThis.fetch = async () => { throw new Error('Failed to fetch'); };
  await assert.rejects(siteFetch('https://eclass.krs.co.kr/x'), /Failed to fetch/);
});
await ta('HTTP 오류도 본문 한 줄과 함께', async () => {
  globalThis.fetch = async () => page(
    '<html><head><title>Runtime Error</title></head><body><b>Exception Details: </b>System.NullReferenceException: 개체 참조</body></html>',
    { ok: false, status: 500 },
  );
  await assert.rejects(siteFetch('https://eclass.krs.co.kr/x'), /HTTP 500.*NullReference/);
});

console.log('패널 문맥 (chrome.tabs 있음)');
await ta('탭 경유를 쓸 수 있다고 안다', async () => {
  globalThis.chrome = { tabs: { query: async () => [] }, scripting: { executeScript: async () => [] } };
  assert.equal(canTabFetch(), true);
});
await ta('미인증인데 열린 탭이 없으면 AuthError', async () => {
  globalThis.fetch = async () => page(SIGN_IN);
  await assert.rejects(siteFetch('https://eclass.krs.co.kr/x'), (err) => err instanceof AuthError);
});

console.log(`\n통과 ${pass}건`);
