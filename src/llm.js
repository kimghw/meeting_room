// 질의 해석과 실패 원인 분석을 어디에 맡길지 고른다.
//
//   1) 로컬 Claude Code CLI (네이티브 메시징) — API 키가 필요 없다
//   2) Anthropic API 키
//   3) 규칙 기반 해석 — 아무 설정 없이도 흔한 문장은 처리된다
//
// 앞의 것이 안 되면 다음으로 내려가고, 무엇을 썼는지 항상 같이 돌려준다.

import { parseQuery, diagnoseSave } from './ai.js';
import { parseLocal } from './nlq.js';

export const NATIVE_HOST = 'com.krs.meetingroom';

/** 네이티브 다리가 설치돼 있는지 본다. */
export async function nativeAvailable() {
  try {
    const r = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { task: 'ping' });
    return !!r?.pong;
  } catch {
    return false;
  }
}

/**
 * 다리가 native/logs 에 남긴 최근 호출 기록을 받아 온다.
 * 로그 복사는 클릭 직후 클립보드에 써야 하므로 오래 기다리지 않는다.
 * @returns {Promise<{entries: object[]|null, error?: string}>}
 */
export async function nativeLogs(limit = 30, timeoutMs = 3000) {
  let timer;
  try {
    const r = await Promise.race([
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { task: 'logs', limit }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${timeoutMs / 1000}초 안에 응답 없음`)), timeoutMs);
      }),
    ]);
    if (!r?.ok || !Array.isArray(r.entries)) return { entries: null, error: r?.error || '다리가 기록을 돌려주지 않았습니다' };
    return { entries: r.entries };
  } catch (err) {
    return { entries: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function nativeTask(task, input) {
  const r = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { task, input });
  if (!r?.ok) throw new Error(r?.error || '로컬 Claude 호출이 실패했습니다.');
  return r;
}

/**
 * 자연어를 조회 조건으로 바꾼다.
 *
 * 회의실과 차량은 **조건의 모양이 같다**(날짜·시간·길이). 다른 것은 말투뿐이라
 * 무엇을 찾는지만 알려주고 같은 길을 쓴다. 좌석 수는 차량에 없으니 부르는 쪽에서 버린다.
 *
 * @param {{apiKey?:string, today:string, useNative?:boolean, kind?:'room'|'car'}} opts
 * @returns {{filter: object, via: 'cli'|'api'|'local', costUsd?: number, note?: string}}
 */
export async function parseSmart(text, opts) {
  const { apiKey, today, useNative, kind = 'room' } = opts;
  const what = kind === 'car' ? '차량' : '회의실';
  let note = '';

  if (useNative) {
    try {
      const r = await nativeTask('parse', `오늘은 ${today} 입니다.\n찾는 대상: ${what}\n\n요청: ${text}`);
      return { filter: r.data, via: 'cli', costUsd: r.costUsd };
    } catch (err) {
      note = `로컬 CLI 실패(${err.message})`;
    }
  }

  if (apiKey) {
    try {
      return { filter: await parseQuery(text, { apiKey, today, kind }), via: 'api', note };
    } catch (err) {
      note = note ? `${note}, API 실패(${err.message})` : `API 실패(${err.message})`;
    }
  }

  return { filter: parseLocal(text, today), via: 'local', note };
}

/**
 * 예약 실패 원인을 설명한다. 성공 여부 판정은 재조회가 이미 했다.
 * @returns {{result: object, via: 'cli'|'api'} | null}
 */
export async function diagnoseSmart(digest, opts) {
  const { apiKey, useNative } = opts;

  if (useNative) {
    try {
      const r = await nativeTask('diagnose', JSON.stringify(digest, null, 2));
      return { result: r.data, via: 'cli' };
    } catch { /* API 로 내려간다 */ }
  }
  if (apiKey) {
    try {
      return { result: await diagnoseSave(digest, { apiKey }), via: 'api' };
    } catch { /* 분석 없이 넘어간다 */ }
  }
  return null;
}
