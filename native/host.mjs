// 크롬 확장과 로컬 Claude Code CLI 를 잇는 네이티브 메시징 호스트.
//
// 확장은 임의의 명령을 보낼 수 없다. 여기서 정해둔 작업(task)만 실행하고
// 시스템 프롬프트도 이 파일 안에 고정돼 있다. 확장이 보내는 것은 입력 텍스트뿐이다.

import { spawn } from 'node:child_process';

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
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`claude 실행 실패: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().slice(0, 300) || `claude 종료 코드 ${code}`));

      let env;
      try {
        env = JSON.parse(out);
      } catch {
        return reject(new Error('CLI 출력을 해석하지 못했습니다.'));
      }
      if (env.is_error) return reject(new Error(env.result || 'CLI 오류'));

      try {
        resolve({ data: JSON.parse(stripFence(env.result)), costUsd: env.total_cost_usd });
      } catch {
        reject(new Error('모델이 JSON 을 돌려주지 않았습니다.'));
      }
    });
  });
}

/* ---------------------------------------------------------------- 진입 */

onMessage(async (msg) => {
  if (msg?.task === 'ping') return send({ ok: true, pong: true });

  const task = TASKS[msg?.task];
  if (!task) return send({ ok: false, error: `알 수 없는 작업: ${msg?.task}` });

  const input = typeof msg.input === 'string' ? msg.input : '';
  if (!input.trim()) return send({ ok: false, error: '입력이 비어 있습니다.' });

  try {
    const { data, costUsd } = await runClaude(task, input.slice(0, 20000));
    send({ ok: true, data, costUsd });
  } catch (e) {
    send({ ok: false, error: e.message });
  }
});
