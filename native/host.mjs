// 크롬 확장과 로컬 Claude Code CLI 를 잇는 네이티브 메시징 호스트.
//
// 확장은 임의의 명령을 보낼 수 없다. 여기서 정해둔 작업(task)만 실행하고
// 시스템 프롬프트도 이 파일 안에 고정돼 있다. 확장이 보내는 것은 입력 텍스트뿐이다.
// 호출마다 native/logs/<날짜>.jsonl 에 한 줄씩 남기고, logs 작업으로 최근 것을 돌려준다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'claude-haiku-4-5';

// PATH 에서 찾는다. 다른 곳에 있으면 CLAUDE_BIN 환경변수로 알려주면 된다.
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

const TASKS = {
  parse: {
    system:
      'You convert Korean meeting-room or company-car booking requests into JSON. ' +
      'The input names which one it is (찾는 대상). Both use the same keys. ' +
      'Output ONLY a JSON object. No prose, no markdown, no code fence. ' +
      'Keys: dateFrom, dateTo (YYYY-MM-DD), hourFrom, hourTo (integers 0-24), ' +
      'minSeats (integer or null), minHours (number or null), ' +
      'region ("부산", "서울", or null), summary (one Korean line describing the parsed filter). ' +
      'If no date is given use today for both dateFrom and dateTo. ' +
      'If no time is given use hourFrom 9 and hourTo 18. ' +
      'Cars have no seat data, so minSeats is null for 차량 requests. ' +
      'Resolve relative dates like 내일 / 이번 주 / 다음 주 against today.',
    max: 1200,
  },
  diagnose: {
    system:
      'You diagnose a failed meeting-room reservation on an ASP.NET WebForms intranet site. ' +
      'The reservation was submitted but a follow-up query did not find it. ' +
      'The user gives you a digest of what changed in the response. ' +
      'Output ONLY a JSON object. No prose, no markdown, no code fence. ' +
      'Keys: verdict ("rejected" | "maybe_saved" | "unknown"), siteMessage (string, "" if none), ' +
      'cause (one or two Korean sentences), fix (one Korean sentence, "" if none). ' +
      'Whether it saved was already decided by the re-query — you only explain why. ' +
      'Do not state guesses as facts.',
    max: 1200,
  },
};

/* ------------------------------------------------------------- 호출 기록 */

// 확장은 파일을 쓸 수 없다. 다리 쪽 사정(종료 코드, stderr, 모델이 돌려준 원문)은
// 여기서 남기지 않으면 어디에도 남지 않는다. 날짜별 JSONL 로 쓰고 오래된 것은 지운다.
const LOG_DIR = process.env.KRS_BRIDGE_LOG_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'logs');
const LOG_KEEP_DAYS = 14;
const LOG_TAIL_MAX = 50;
// 다리 → 크롬 메시지는 1MB 까지다. 기록을 돌려줄 때 넉넉히 그 절반에서 끊는다.
const LOG_TAIL_BYTES = 512 * 1024;
const LOG_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const clip = (s, n) =>
  (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(${s.length}자)` : s);

/** 한 줄 남긴다. 실패해도 응답은 보내야 하므로 삼킨다 — stdout 에는 절대 쓰지 않는다(프레임이 깨진다). */
export function writeLog(entry, dir = LOG_DIR) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    fs.appendFileSync(path.join(dir, `${localDay(new Date())}.jsonl`), `${line}\n`);
  } catch {
    // 기록 실패로 다리가 멈추면 안 된다
  }
}

/** 보관 기간이 지난 날짜 파일을 지운다. */
export function pruneLogs(dir = LOG_DIR, now = new Date()) {
  try {
    const cutoff = localDay(new Date(now.getTime() - LOG_KEEP_DAYS * 86_400_000));
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(LOG_FILE);
      if (m && m[1] < cutoff) fs.unlinkSync(path.join(dir, f));
    }
  } catch {
    // 폴더가 아직 없으면 지울 것도 없다
  }
}

/** 최근 기록 n 건(오래된 것부터). 반쯤 쓰인 줄은 건너뛴다. */
export function tailLogs(n, dir = LOG_DIR) {
  const want = Math.min(Math.max(Number(n) || LOG_TAIL_MAX, 1), LOG_TAIL_MAX);
  const out = [];
  try {
    const files = fs.readdirSync(dir).filter((f) => LOG_FILE.test(f)).sort().reverse();
    for (const f of files) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < want; i--) {
        if (!lines[i].trim()) continue;
        try { out.push(JSON.parse(lines[i])); } catch { /* 건너뛴다 */ }
      }
      if (out.length >= want) break;
    }
  } catch {
    return [];
  }
  out.reverse();
  while (out.length > 1 && Buffer.byteLength(JSON.stringify(out)) > LOG_TAIL_BYTES) out.shift();
  return out;
}

/* ------------------------------------------------- 네이티브 메시징 프레임 */

function send(obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(buf.length, 0);
  process.stdout.write(len);
  process.stdout.write(buf);
}

function onMessage(handler) {
  let acc = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    for (;;) {
      if (acc.length < 4) return;
      const size = acc.readUInt32LE(0);
      if (acc.length < 4 + size) return;
      const body = acc.subarray(4, 4 + size);
      acc = acc.subarray(4 + size);
      let msg;
      try {
        msg = JSON.parse(body.toString('utf8'));
      } catch {
        writeLog({ task: '(읽지 못함)', ok: false, error: '요청을 읽지 못했습니다.', bytes: size });
        send({ ok: false, error: '요청을 읽지 못했습니다.' });
        continue;
      }
      handler(msg);
    }
  });
}

/* ------------------------------------------------------------- CLI 호출 */

/** 모델이 ```json 펜스를 붙여 오는 경우가 있어 벗겨낸다. */
function stripFence(text) {
  const t = (text || '').trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (m ? m[1] : t).trim();
}

/** 기록에 남길 사정을 붙인 오류. 확장에는 message 만 간다. */
const fail = (message, detail) => Object.assign(new Error(message), { detail });

function runClaude(task, input) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', input,
      '--output-format', 'json',
      '--model', MODEL,
      '--system-prompt', task.system,
      // 기본 에이전트 프롬프트를 빼면 캐시 토큰이 38K -> 4K 로 줄고 지시도 잘 따른다
      '--exclude-dynamic-system-prompt-sections',
      '--disallowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebFetch', 'WebSearch', 'Task',
    ];

    // shell 을 쓰면 Windows 에서 인자가 이어붙기만 해서 공백 섞인 프롬프트가 깨진다.
    // claude 는 실제 실행 파일이므로 셸 없이 직접 띄운다.
    const child = spawn(CLAUDE_BIN, args, { shell: false, windowsHide: true });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CLI 응답이 60초 안에 오지 않았습니다.'));
    }, 60_000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(fail(`claude 실행 실패: ${e.message}`, { bin: CLAUDE_BIN, code: e.code }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(fail(err.trim().slice(0, 300) || `claude 종료 코드 ${code}`,
          { exitCode: code, stderr: clip(err.trim(), 2000), stdout: clip(out.trim(), 1000) }));
      }

      let env;
      try {
        env = JSON.parse(out);
      } catch {
        return reject(fail('CLI 출력을 해석하지 못했습니다.', { stdout: clip(out.trim(), 2000) }));
      }
      if (env.is_error) {
        return reject(fail(env.result || 'CLI 오류', { subtype: env.subtype, costUsd: env.total_cost_usd }));
      }

      try {
        resolve({ data: JSON.parse(stripFence(env.result)), costUsd: env.total_cost_usd });
      } catch {
        reject(fail('모델이 JSON 을 돌려주지 않았습니다.',
          { raw: clip(env.result, 2000), costUsd: env.total_cost_usd }));
      }
    });
  });
}

/* ------------------------------------------------------------ 요청 처리 */

/**
 * 요청 하나를 처리해 돌려줄 응답을 만든다. claude 를 부른 것은 성패와 상관없이 기록한다.
 * ping 과 logs 는 부를 때마다 남기면 기록이 그것으로 찬다 — 남기지 않는다.
 *
 * @param {object} msg
 * @param {{ run?: Function, log?: Function, tail?: Function }} [deps] 테스트가 갈아 끼운다
 */
export async function handle(msg, { run = runClaude, log = writeLog, tail = tailLogs } = {}) {
  if (msg?.task === 'ping') return { ok: true, pong: true };
  if (msg?.task === 'logs') return { ok: true, entries: tail(msg.limit) };

  const task = TASKS[msg?.task];
  if (!task) {
    const error = `알 수 없는 작업: ${msg?.task}`;
    log({ task: String(msg?.task), ok: false, error });
    return { ok: false, error };
  }

  const input = typeof msg.input === 'string' ? msg.input : '';
  if (!input.trim()) {
    log({ task: msg.task, ok: false, error: '입력이 비어 있습니다.' });
    return { ok: false, error: '입력이 비어 있습니다.' };
  }

  const started = Date.now();
  const base = { task: msg.task, model: MODEL, input: clip(input, 1500) };
  try {
    const { data, costUsd } = await run(task, input.slice(0, 20000));
    log({ ...base, ok: true, ms: Date.now() - started, costUsd, data });
    return { ok: true, data, costUsd };
  } catch (e) {
    log({ ...base, ok: false, ms: Date.now() - started, error: e.message, ...e.detail });
    return { ok: false, error: e.message };
  }
}

/* ---------------------------------------------------------------- 진입 */

// 테스트는 handle 만 가져다 쓴다. 크롬이 띄울 때는 이 변수가 없으므로 늘 아래가 돈다.
if (process.env.KRS_HOST_NO_MAIN !== '1') {
  pruneLogs();
  onMessage(async (msg) => {
    // 기록을 먼저 쓰고 응답한다. 응답을 받은 크롬은 곧바로 이 프로세스를 끊을 수 있다.
    send(await handle(msg));
  });
}
