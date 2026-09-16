import { ORIGIN } from './config.js';

/** 로그인이 필요하거나 세션이 끊겼을 때 던진다. */
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * ASP.NET 쪽은 미인증이면 200 으로 alert 스크립트 한 줄만 돌려준다.
 * ("You must sign in.") 상태 코드로는 구분할 수 없어 본문으로 판정한다.
 */
function looksUnauthenticated(html) {
  if (!html) return true;
  if (/You must sign in|다시 로그인|로그인이 필요/i.test(html)) return true;
  // 본문이 거의 없고 Login 페이지로 튕기는 스크립트만 있는 경우
  return html.length < 1500 && /location\.(href|replace)[^;]*Login/i.test(html);
}

/**
 * 오류 응답에서 **사람이 읽을 한 줄**을 뽑는다.
 *
 * "HTTP 500" 만 보여주면 무엇이 잘못됐는지 알 길이 없다. ASP.NET 오류 화면은 제목과 큰 글씨에
 * 예외 종류·문구를 적어 주므로 그것만 짧게 데려온다. 본문 전체는 err.body 로 따로 넘겨
 * 진단(buildSaveDigest)이 쓰게 한다.
 */
export function describeErrorPage(html) {
  const text = String(html || '');
  const pick = (re) => {
    const m = text.match(re);
    return m ? m[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '';
  };
  const detail = pick(/Exception Details:\s*<\/b>\s*([^<]{3,200})/i)
    || pick(/<title>\s*([^<]{3,200})<\/title>/i)
    || pick(/<h2>\s*(?:<i>)?\s*([\s\S]{3,200}?)<\/(?:i|h2)>/i);
  // 노란 화면의 기본 제목("Runtime Error")은 아무것도 알려주지 않는다. 없느니만 못하다.
  return /^(runtime error|오류|error)$/i.test(detail) ? '' : detail;
}

/** Content-Type / meta charset 을 존중해 디코딩한다(구형 페이지는 EUC-KR 일 수 있음). */
async function decodeResponse(res) {
  const buf = await res.arrayBuffer();
  const ct = res.headers.get('content-type') || '';
  let charset = (ct.match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!charset) {
    const head = new TextDecoder('utf-8').decode(buf.slice(0, 4096));
    charset = (head.match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  }
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** 확장 컨텍스트에서 직접 요청. host_permissions 덕분에 쿠키가 실린다. */
/** 응답이 안 오면 영원히 기다리게 된다. 화면이 "...중"에서 멈춰 버리므로 끊는다. */
export const REQUEST_TIMEOUT_MS = 20000;

async function directFetch(url, init) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'include', redirect: 'follow', ...init, signal: ac.signal,
    });
    if (!res.ok) {
      // 오류 본문을 버리지 않는다. 사이트가 왜 거절했는지는 여기에만 적혀 있다.
      const body = await decodeResponse(res).catch(() => '');
      throw httpError(res.status, res.statusText, body);
    }
    return { html: await decodeResponse(res), finalUrl: res.url || url };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`응답이 ${REQUEST_TIMEOUT_MS / 1000}초 안에 오지 않았습니다.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 약속이 제 시간에 안 끝나면 끊는다. */
/** HTTP 오류를 본문까지 달아 던진다. 부르는 쪽이 진단에 쓴다. */
function httpError(status, statusText, body) {
  const detail = describeErrorPage(body);
  const err = new Error(`HTTP ${status}${statusText ? ` ${statusText}` : ''}${detail ? ` — ${detail}` : ''}`);
  err.status = status;
  err.body = body || '';
  return err;
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}이 ${ms / 1000}초 안에 끝나지 않았습니다.`)), ms)),
  ]);
}

/** 로그인된 eclass 탭을 찾는다. */
async function findSiteTab() {
  const tabs = await chrome.tabs.query({ url: `${ORIGIN}/*` });
  if (!tabs.length) return null;
  return tabs.find((t) => t.status === 'complete') || tabs[0];
}

/**
 * 탭 안에서 같은 출처로 요청한다.
 * SameSite 등으로 확장에서의 직접 요청이 막히는 환경을 위한 폴백.
 */
async function tabFetch(url, init) {
  const tab = await findSiteTab();
  if (!tab) {
    throw new AuthError('열려 있는 eclass 탭이 없습니다. 로그인 후 다시 시도하세요.');
  }
  const [injection] = await withTimeout(chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (u, i) => {
      const res = await fetch(u, { credentials: 'include', redirect: 'follow', ...(i || {}) });
      const buf = await res.arrayBuffer();
      const ct = res.headers.get('content-type') || '';
      let cs = (ct.match(/charset=["']?([\w-]+)/i) || [])[1];
      if (!cs) {
        const head = new TextDecoder('utf-8').decode(buf.slice(0, 4096));
        cs = (head.match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
      }
      let text;
      try {
        text = new TextDecoder(cs).decode(buf);
      } catch {
        text = new TextDecoder('utf-8').decode(buf);
      }
      return { ok: res.ok, status: res.status, html: text, finalUrl: res.url || u };
    },
    args: [url, init || null],
  }), REQUEST_TIMEOUT_MS + 5000, '탭을 통한 요청');
  const r = injection?.result;
  if (!r) throw new Error('탭을 통한 요청에 실패했습니다.');
  if (!r.ok) throw httpError(r.status, '', r.html);
  return { html: r.html, finalUrl: r.finalUrl };
}

/**
 * 사이트에 요청한다. 직접 요청 → (실패/미인증 시) 탭 경유 순으로 시도한다.
 * @returns {Promise<{html: string, finalUrl: string, via: 'direct'|'tab'}>}
 */
export async function siteFetch(url, init) {
  let directError = null;
  try {
    const r = await directFetch(url, init);
    if (!looksUnauthenticated(r.html)) return { ...r, via: 'direct' };
  } catch (err) {
    directError = err;
  }

  try {
    const r = await tabFetch(url, init);
    if (looksUnauthenticated(r.html)) {
      throw new AuthError('로그인이 필요합니다. eclass 에 로그인한 뒤 다시 조회하세요.');
    }
    return { ...r, via: 'tab' };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    if (directError) throw directError;
    throw err;
  }
}
