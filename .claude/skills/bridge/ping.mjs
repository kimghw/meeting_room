// 다리를 크롬이 하는 방식 그대로 한 번 두드려 본다.
//
// 크롬은 claude-bridge.bat 을 띄우고 stdin/stdout 으로 네이티브 메시징 프레임
// (4바이트 리틀엔디언 길이 + UTF-8 JSON)을 주고받는다. 여기서도 같은 길로 간다 —
// 중간에 다른 길을 쓰면 정작 크롬이 쓰는 경로는 확인되지 않는다.
//
// 사용: node ping.mjs <프로젝트루트> [--parse]
//   기본     : ping 한 번. claude 를 부르지 않으므로 공짜고 빠르다.
//   --parse  : 실제 parse 작업까지. claude 로그인 여부가 여기서 드러난다(과금 있음).

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const root = process.argv[2];
const full = process.argv.includes('--parse');
if (!root) { console.log('FAIL 프로젝트 루트를 인자로 주세요'); process.exit(2); }

const bat = path.join(root, 'native', 'claude-bridge.bat');
if (!fs.existsSync(bat)) { console.log(`FAIL claude-bridge.bat 없음: ${bat}`); process.exit(2); }

// Node 24 는 보안상 .bat 직접 spawn 을 막는다(EINVAL). 크롬도 셸을 거치므로 cmd 로 띄운다.
const child = spawn('cmd.exe', ['/c', bat], { windowsHide: true });

const today = new Date().toISOString().slice(0, 10);
const msg = full
  ? { task: 'parse', input: `오늘은 ${today} 입니다.\n찾는 대상: 회의실\n\n요청: 내일 오후 2시 회의실` }
  : { task: 'ping' };

const body = Buffer.from(JSON.stringify(msg), 'utf8');
const len = Buffer.alloc(4);
len.writeUInt32LE(body.length, 0);
child.stdin.write(len);
child.stdin.write(body);

let acc = Buffer.alloc(0);
let err = '';
const limit = full ? 90_000 : 10_000;
const timer = setTimeout(() => {
  console.log(`FAIL ${limit / 1000}초 안에 응답이 없습니다${err ? ` (stderr: ${err.trim().slice(0, 200)})` : ''}`);
  child.kill();
  process.exit(1);
}, limit);

child.stderr.on('data', (d) => { err += d; });
child.on('error', (e) => {
  clearTimeout(timer);
  console.log(`FAIL 다리를 띄우지 못했습니다: ${e.message}`);
  process.exit(1);
});

child.stdout.on('data', (d) => {
  acc = Buffer.concat([acc, d]);
  if (acc.length < 4) return;
  const size = acc.readUInt32LE(0);
  if (acc.length < 4 + size) return;

  clearTimeout(timer);
  const res = JSON.parse(acc.subarray(4, 4 + size).toString('utf8'));
  child.kill();

  if (!res.ok) {
    console.log(`FAIL 다리는 떴지만 작업이 실패했습니다: ${res.error}`);
    // claude 미로그인·만료는 대개 여기서 잡힌다.
    process.exit(1);
  }
  if (full) {
    const cost = res.costUsd ? ` ($${res.costUsd.toFixed(4)})` : '';
    console.log(`OK claude 호출까지 정상${cost} — 해석: ${res.data?.summary || JSON.stringify(res.data).slice(0, 80)}`);
  } else {
    console.log('OK 다리 왕복 정상 (pong)');
  }
  process.exit(0);
});
