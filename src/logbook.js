// 무엇을 했고 어떻게 됐는지 이 브라우저에 남기는 활동 기록.
//
// 사이트는 실패 이유를 거의 알려주지 않고, 패널의 상태줄은 다음 조회가 곧바로 덮어쓴다.
// "아까 왜 안 됐지"를 되짚으려면 어딘가 남아 있어야 한다. 확장은 파일을 쓸 수 없으므로
// chrome.storage 에 최근 것만 둔다. 저장소는 주입받는다 — 테스트는 가짜 객체로 된다.
//
// 파일로 남는 기록은 로컬 Claude 다리 쪽(native/logs)에 따로 있다. 복사할 때 둘을 합친다.

export const LOG_KEY = 'activityLog';
export const LOG_MAX = 500;

/** 한 건의 상세가 이보다 크면 잘라 둔다. 한 건이 저장소 한도를 먹어 들어가지 않게. */
const DATA_MAX = 6000;

export const KIND_LABEL = {
  open: '열림',
  cli: '다리',
  load: '조회',
  scan: '훑기',
  reserve: '예약',
  diagnose: '원인',
  cancel: '취소',
  modify: '수정',
  extend: '이어붙이기',
  ask: '말로찾기',
  capture: '캡처',
  setting: '설정',
};

const pad = (n) => String(n).padStart(2, '0');

/** 기록 시각은 사람이 읽는다. 로컬 시각으로 적는다. */
export function stamp(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at ?? '');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function clip(data) {
  let s;
  try {
    s = JSON.stringify(data);
  } catch {
    return { note: '상세를 기록하지 못했습니다.' };
  }
  if (s === undefined || s.length <= DATA_MAX) return data;
  return { truncated: `${s.slice(0, DATA_MAX)}…`, length: s.length };
}

/**
 * @param {{ storage: {get: Function, set: Function}, max?: number, now?: () => number }} opts
 */
export function createLogbook({ storage, max = LOG_MAX, now = () => Date.now() }) {
  // 쓰기는 줄을 세운다. 두 기록이 동시에 읽고-고치고-쓰면 하나가 사라진다.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  // 매번 저장소에서 읽는다. 창마다 패널이 따로 떠 있을 수 있어 메모리에 쥐고 있으면 서로 덮는다.
  const read = async () => {
    try {
      const got = await storage.get(LOG_KEY);
      return Array.isArray(got?.[LOG_KEY]) ? got[LOG_KEY] : [];
    } catch {
      return [];
    }
  };

  /**
   * 한 건 남긴다. 바로 앞 기록과 종류·문장·성패가 같으면 새 줄을 만들지 않고 횟수만 올린다
   * (60초마다 도는 자동 갱신이 같은 실패로 목록을 채우지 않게).
   *
   * `onlyIfChanged` 는 같은 종류의 마지막 기록과 같으면 아예 남기지 않는다.
   * 패널을 열 때마다 확인하는 다리 연결 상태처럼, 바뀔 때만 의미 있는 것에 쓴다.
   *
   * @returns {Promise<object|null>} 남긴(또는 횟수를 올린) 기록. 건너뛰었으면 null
   */
  function add(kind, { ok = true, text = '', data, onlyIfChanged = false } = {}) {
    return serial(async () => {
      const list = await read();
      if (onlyIfChanged) {
        const prev = list.findLast((e) => e.kind === kind);
        if (prev && prev.text === text && prev.ok === ok) return null;
      }

      const at = now();
      const last = list[list.length - 1];
      let entry;
      if (last && last.kind === kind && last.text === text && last.ok === ok) {
        entry = last;
        entry.repeat = (entry.repeat || 1) + 1;
        entry.lastAt = at;
        if (data !== undefined) entry.data = clip(data);
      } else {
        entry = { at, kind, ok: !!ok, text };
        if (data !== undefined) entry.data = clip(data);
        list.push(entry);
        if (list.length > max) list.splice(0, list.length - max);
      }
      try {
        await storage.set({ [LOG_KEY]: list });
      } catch {
        // 기록을 못 남겼다고 본 작업을 막지 않는다
      }
      return entry;
    });
  }

  return {
    add,
    list: () => serial(read),
    clear: () => serial(() => storage.set({ [LOG_KEY]: [] })),
  };
}

/** 확장 기록을 사람이 읽는 줄로. `detail` 이면 상세를 한 줄 더 붙인다. */
export function formatEntries(entries, { detail = true } = {}) {
  return (entries || []).map((e) => {
    const label = KIND_LABEL[e.kind] || e.kind;
    const repeat = e.repeat > 1 ? ` (×${e.repeat}, 마지막 ${stamp(e.lastAt)})` : '';
    const head = `${stamp(e.at)}  ${e.ok ? '✓' : '✕'} [${label}] ${e.text}${repeat}`;
    return detail && e.data !== undefined ? `${head}\n    ${JSON.stringify(e.data)}` : head;
  }).join('\n');
}

/** 다리(native/host.mjs)가 남긴 기록을 사람이 읽는 줄로. */
export function formatBridgeEntries(entries) {
  return (entries || []).map((e) => {
    const { at, task, ok, ms, costUsd, error, ...rest } = e;
    const bits = [
      ms != null ? `${ms}ms` : '',
      costUsd != null ? `$${Number(costUsd).toFixed(4)}` : '',
      error || '',
    ].filter(Boolean).join(' · ');
    return `${stamp(at)}  ${ok ? '✓' : '✕'} [${task}]${bits ? ` ${bits}` : ''}\n    ${JSON.stringify(rest)}`;
  }).join('\n');
}

/**
 * 붙여 넣을 보고서 한 벌. 사람도 읽고 Claude 에게 그대로 넘겨도 되도록 머리말에 환경을 적는다.
 *
 * @param {{ entries: object[], bridge?: {entries?: object[]|null, error?: string}|null,
 *           meta?: Record<string, unknown>, now?: number }} input
 */
export function buildLogReport({ entries, bridge, meta = {}, now = Date.now() }) {
  const list = entries || [];
  const fails = list.filter((e) => !e.ok).length;
  const env = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');

  const out = [
    'KRS 회의실 예약 — 활동 로그',
    `복사한 때: ${stamp(now)} · 확장 기록 ${list.length}건 (실패 ${fails})`,
  ];
  if (env) out.push(`환경: ${env}`);

  out.push('', '== 확장 기록 (오래된 것부터) ==');
  out.push(list.length ? formatEntries(list) : '(기록 없음)');

  out.push('', '== 로컬 Claude 다리 기록 (native/logs, 최근 것) ==');
  if (bridge?.entries?.length) out.push(formatBridgeEntries(bridge.entries));
  else if (bridge?.entries) out.push('(기록 없음)');
  else out.push(`(가져오지 못했습니다${bridge?.error ? `: ${bridge.error}` : ''})`);

  return `${out.join('\n')}\n`;
}
