// 의존성 없는 최소 CDP(Chrome DevTools Protocol) 클라이언트.
//
// Node 22+ 의 내장 WebSocket 만 쓴다 — puppeteer 를 받지 않는다. 이 저장소는 확장이라
// 빌드 도구가 없고, 테스트 하나 때문에 300MB 짜리 브라우저를 또 받게 하고 싶지 않다.
//
// 이 파일에 박혀 있는 두 가지 함정은 실제로 겪은 것이다.
//  1) **미인증이면 사이트가 alert("You must sign in.") 를 띄운다.** 그 모달이 렌더러를
//     막아 Runtime.evaluate 가 영영 돌아오지 않는다. 그래서 다이얼로그를 반드시 받아
//     처리하고, 무슨 문구였는지 남긴다 — 로그인 여부를 판정하는 가장 확실한 신호다.
//  2) 모든 호출에 시간 제한을 둔다. 없으면 테스트가 멈춘 채로 영원히 기다린다.

export const PORT = +(process.env.CDP_PORT || 9333);
const base = () => `http://127.0.0.1:${PORT}`;

export async function version() {
  const r = await fetch(`${base()}/json/version`, { signal: AbortSignal.timeout(4000) });
  return r.json();
}

export async function targets() {
  const r = await fetch(`${base()}/json/list`, { signal: AbortSignal.timeout(4000) });
  return r.json();
}

export async function newTab(url = 'about:blank') {
  const r = await fetch(`${base()}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT', signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`탭을 열지 못했습니다: HTTP ${r.status}`);
  return r.json();
}

export async function closeTab(id) {
  try { await fetch(`${base()}/json/close/${id}`, { signal: AbortSignal.timeout(4000) }); } catch { /* 이미 닫힘 */ }
}

/**
 * 탭 하나에 붙는다.
 * @returns {Promise<object>} send/on/evaluate/goto/close 를 가진 손잡이
 */
export async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Map();
  let seq = 0;

  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP 소켓을 열지 못했습니다.'));
    setTimeout(() => rej(new Error('CDP 소켓이 10초 안에 열리지 않았습니다.')), 10000);
  });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`${msg.error.message}`));
      else res(msg.result);
      return;
    }
    if (msg.method) for (const fn of listeners.get(msg.method) || []) fn(msg.params);
  };

  const send = (method, params = {}, ms = 20000) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} 가 ${ms / 1000}초 안에 응답하지 않았습니다.`)); }, ms);
  });

  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) || []), fn]);

  // 페이지가 말한 것들을 모아 둔다. 확장의 JS 오류를 잡는 그물이다.
  const dialogs = [];
  const errors = [];
  const logs = [];

  await send('Page.enable');
  await send('Runtime.enable');
  on('Page.javascriptDialogOpening', async (p) => {
    dialogs.push({ type: p.type, message: p.message });
    try { await send('Page.handleJavaScriptDialog', { accept: true }); } catch { /* 이미 닫힘 */ }
  });
  on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    errors.push({
      text: d.exception?.description || d.text || '알 수 없는 예외',
      url: d.url || '',
      line: d.lineNumber,
    });
  });
  on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      logs.push({ type: p.type, text: (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ') });
    }
  });

  /** 페이지에서 식을 평가해 값을 받는다. 예외는 던져서 올린다. */
  const evaluate = async (expression, ms = 20000) => {
    const r = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, ms);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '평가 실패');
    }
    return r.result.value;
  };

  /** 이동하고 load 를 기다린다. 안 오면 시간 제한으로 그냥 넘어간다(다이얼로그가 막을 수 있다). */
  const goto = async (url, ms = 20000) => {
    const loaded = new Promise((r) => on('Page.loadEventFired', r));
    await send('Page.navigate', { url }, ms);
    await Promise.race([loaded, new Promise((r) => setTimeout(r, ms))]);
    await new Promise((r) => setTimeout(r, 400));   // 포스트백·스크립트가 정착할 틈
  };

  return {
    send, on, evaluate, goto,
    dialogs, errors, logs,
    targetId: target.id,
    close: () => { try { ws.close(); } catch { /* 이미 닫힘 */ } },
  };
}

/** 페이지가 미인증 alert 를 띄웠는가. 이 사이트에서 로그인 여부를 아는 가장 확실한 신호다. */
export const sawSignInAlert = (cli) =>
  cli.dialogs.some((d) => /must sign in|로그인/i.test(d.message || ''));

/**
 * 브라우저 자체(탭이 아닌)에 붙는다. 확장을 올리는 데 쓴다.
 */
export async function attachBrowser() {
  const v = await version();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('브라우저 소켓을 열지 못했습니다.'));
    setTimeout(() => rej(new Error('브라우저 소켓이 10초 안에 열리지 않았습니다.')), 10000);
  });
  let seq = 0;
  const send = (method, params = {}, ms = 15000) => new Promise((res, rej) => {
    const id = ++seq;
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', h);
      if (m.error) rej(new Error(m.error.message));
      else res(m.result);
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => rej(new Error(`${method} 가 ${ms / 1000}초 안에 응답하지 않았습니다.`)), ms);
  });
  return { send, close: () => { try { ws.close(); } catch { /* 이미 닫힘 */ } } };
}

/**
 * 압축 해제 확장을 올린다.
 *
 * **크롬 137+ 는 명령줄 --load-extension 을 무시한다**(보안 때문에 막혔다).
 * 그래서 CDP 의 Extensions.loadUnpacked 로 올린다. 경로는 역슬래시를 받지 않고
 * ("File path cannot be resolved") **슬래시로 줘야** 한다 — 실제로 겪은 함정이다.
 *
 * @returns {Promise<string|null>} 확장 ID
 */
export async function loadUnpacked(dir) {
  const browser = await attachBrowser();
  try {
    const r = await browser.send('Extensions.loadUnpacked', { path: dir.split('\\').join('/') });
    return r?.id || null;
  } catch {
    return null;
  } finally {
    browser.close();
  }
}
