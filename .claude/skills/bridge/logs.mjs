// 다리가 native/logs 에 남긴 최근 호출 기록을 보여준다. claude 를 부르지 않는다(공짜).
//
// 읽는 규칙은 다리(host.mjs)의 것을, 찍는 모양은 패널의 '로그 복사'(src/logbook.js)의 것을
// 그대로 가져다 쓴다 — 여기서 따로 지어내면 셋이 서로 다른 말을 하게 된다.
//
// 사용: node logs.mjs <프로젝트루트> [건수(기본 20, 최대 50)]

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const n = Number(process.argv[3]) || 20;
if (!root) { console.log('FAIL 프로젝트 루트를 인자로 주세요'); process.exit(2); }

const host = path.join(root, 'native', 'host.mjs');
if (!fs.existsSync(host)) { console.log(`FAIL host.mjs 없음: ${host}`); process.exit(2); }

// 불러오기만 한다. 이 변수가 없으면 host.mjs 가 stdin 을 기다리며 멈춘다.
process.env.KRS_HOST_NO_MAIN = '1';
const { tailLogs } = await import(pathToFileURL(host).href);
const { formatBridgeEntries } = await import(pathToFileURL(path.join(root, 'src', 'logbook.js')).href);

const dir = process.env.KRS_BRIDGE_LOG_DIR || path.join(root, 'native', 'logs');
const entries = tailLogs(n);
const fails = entries.filter((e) => !e.ok).length;
console.log(`기록 폴더: ${dir}`);
console.log(`최근 ${entries.length}건 · 실패 ${fails}건 (14일 보관)`);
console.log('');
console.log(entries.length
  ? formatBridgeEntries(entries)
  : '(기록 없음 — 다리가 아직 claude 를 부르지 않았습니다. ping 은 기록하지 않습니다)');
