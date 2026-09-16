// 실제 크롬에서 돌려 보는 검사. jsdom 이 흉내 낼 수 없는 것만 여기서 본다.
//
//   node test/cdp/run.mjs
//
// 미리 디버그 포트를 연 크롬이 떠 있어야 한다(기본 9333, CDP_PORT 로 바꾼다).
// **크롬 136+ 는 기본 프로필에 디버그 포트를 붙여주지 않는다.** 따로 --user-data-dir 을
// 줘야 하고, 그러면 쿠키 항아리가 달라져 로그인도 그 창에서 따로 해야 한다.
//
//   chrome.exe --remote-debugging-port=9333 --user-data-dir=<빈 폴더> \
//              --load-extension=E:\dev\meeting_room
//
// 로그인해야 되는 검사는 로그인이 안 되어 있으면 **건너뛴다고 말하고** 넘어간다.
// 조용히 통과시키면 "확인했다"는 거짓말이 된다 — 이 저장소가 가장 싫어하는 실패다.
import crypto from 'node:crypto';
import { version, targets, newTab, closeTab, attach, sawSignInAlert, loadUnpacked, PORT } from './cdp.mjs';

const EXT_PATH = 'E:\\dev\\meeting_room';
const ORIGIN = 'https://eclass.krs.co.kr';
const CAR_LIST = `${ORIGIN}/intra/intranet/VSDotnet/RentCar/New_List.aspx?s_code=0102010300`;
const ROOM_LIST = `${ORIGIN}/intra/intranet/VSDotnet/MeetingRoom/List.aspx`;

let pass = 0;
let skip = 0;
const fails = [];

const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  ok    ' + name);
  } catch (err) {
    fails.push(`${name} — ${err.message}`);
    console.log('  FAIL  ' + name + ' — ' + err.message);
  }
};
const skipped = (name, why) => { skip++; console.log(`  skip  ${name} — ${why}`); };
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '거짓'); };

/**
 * 크롬이 --load-extension 경로에 부여하는 확장 ID.
 * 경로의 SHA-256 앞 16바이트를 a~p 로 적는다. 윈도 경로는 std::wstring 이라 UTF-16LE 로 해시된다.
 */
function idForPath(path, encoding) {
  const hash = crypto.createHash('sha256').update(Buffer.from(path, encoding)).digest();
  return [...hash.subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');
}

console.log(`CDP ${PORT} 에 붙는다`);
let v;
try {
  v = await version();
} catch (err) {
  console.error(`\n크롬이 ${PORT} 에서 응답하지 않습니다: ${err.message}`);
  console.error('디버그 포트를 연 크롬을 먼저 띄우세요(이 파일 맨 위 주석 참고).');
  process.exit(1);
}
t(`브라우저가 응답한다 (${v.Browser})`, () => assert(/Chrome/.test(v.Browser)));

/* ------------------------------------------------------- 확장 찾기 */

console.log('\n확장이 로드돼 있나');
let extId = null;
{
  // 크롬이 기본으로 들고 있는 확장(월렛·행아웃)은 빼고 본다.
  const live = (await targets())
    .find((x) => /^chrome-extension:\/\//.test(x.url || '') && !/nmmhkkeg|nkeimhog/.test(x.url));

  const guesses = [...new Set([
    live ? live.url.split('/')[2] : null,
    idForPath(EXT_PATH, 'utf16le'),
    idForPath(EXT_PATH, 'utf8'),
  ].filter(Boolean))];

  const probe = await newTab('about:blank');
  const cli = await attach(probe);
  const manifestLoads = async (id) => {
    await cli.goto(`chrome-extension://${id}/manifest.json`, 8000);
    return cli
      .evaluate('document.body ? document.body.innerText.includes("manifest_version") : false')
      .catch(() => false);
  };

  for (const id of guesses) {
    if (await manifestLoads(id)) { extId = id; break; }
  }

  // 크롬 137+ 는 명령줄 --load-extension 을 무시한다. 그럴 때는 CDP 로 직접 올린다.
  if (!extId) {
    const loaded = await loadUnpacked(EXT_PATH);
    if (loaded && await manifestLoads(loaded)) {
      extId = loaded;
      console.log('  note  명령줄로는 안 올라가서 CDP(Extensions.loadUnpacked)로 올렸습니다');
    }
  }

  cli.close();
  await closeTab(probe.id);

  if (extId) {
    t(`확장 ID 를 찾았다 (${extId})`, () => assert(true));
  } else {
    fails.push('확장을 찾지 못했다');
    console.log('  FAIL  확장을 찾지 못했다 — --load-extension 으로 띄웠는지 확인하세요');
    console.log('        시도한 ID: ' + guesses.join(', '));
  }
}

/* --------------------------------------------- 사이드패널 (로그인 불필요) */

if (extId) {
  console.log('\n사이드패널이 실제 크롬에서 뜨는가 (로그인 없이)');
  const tab = await newTab('about:blank');
  const cli = await attach(tab);
  await cli.goto(`chrome-extension://${extId}/sidepanel.html`, 20000);
  await new Promise((r) => setTimeout(r, 2500));   // init() 이 한 달 훑기를 시작했다 실패할 시간

  const view = await cli.evaluate(`(() => {
    const q = (id) => document.getElementById(id);
    const need = ['date','hourStart','hourEnd','refresh','submit','cancelBooking',
                  'extend','modify','fPlace','fPassenger','fTitle','editNote','carFields'];
    return {
      tabs: ['tabRoom','tabCar','tabMine'].every((id) => !!q(id)),
      missing: need.filter((id) => !q(id)),
      status: (q('status')?.textContent || '').trim(),
      grid: !!q('grid'),
      // 실제로 칠해진 칸 수. 0 이면 현황을 못 그린 것이다.
      slots: q('grid') ? q('grid').querySelectorAll('td.slot').length : 0,
    };
  })()`);

  t('JS 예외 없이 뜬다', () => assert(
    cli.errors.length === 0,
    '예외: ' + cli.errors.map((e) => `${e.text} (${e.url}:${e.line})`).join(' | '),
  ));
  t('탭 세 개가 다 있다', () => assert(view.tabs));
  t('빠진 컨트롤이 없다', () => assert(view.missing.length === 0, '없는 것: ' + view.missing.join(', ')));
  t('격자가 있다', () => assert(view.grid));

  // 격자를 못 그렸으면 **왜 못 그렸는지** 말해야 한다. 빈 화면을 말없이 두면
  // 쓰는 사람은 "예약이 하나도 없다"로 읽는다 — 이 앱에서 가장 나쁜 실패다.
  // 로그인 여부에 따라 둘 중 하나여야 하고, 어느 쪽도 아니면 잘못이다.
  t('현황을 그리거나, 못 그린 이유를 말하거나 (둘 중 하나)', () => assert(
    view.slots > 0 || /로그인|sign in|확인 불가|읽지 못|실패/i.test(view.status),
    `칸 ${view.slots}개인데 상태줄이 "${view.status}" 라 이유를 말하지 않는다`,
  ));
  if (view.slots > 0) {
    t(`로그인 상태에서 현황을 그렸다 (${view.slots}칸 · "${view.status.slice(0, 40)}")`, () => assert(true));
  }

  const carView = await cli.evaluate(`(async () => {
    document.getElementById('tabCar').click();
    await new Promise((r) => setTimeout(r, 1200));
    const q = (id) => document.getElementById(id);
    return {
      active: q('tabCar').classList.contains('active'),
      carFields: !q('carFields').classList.contains('hidden'),
      titleLabel: q('lblTitle').textContent,
      hint: document.querySelector('.selection-hint').textContent,
    };
  })()`);
  t('차량 탭으로 바뀐다', () => assert(carView.active));
  t('차량 탭에 신청 칸(행선지·동승자)이 뜬다', () => assert(carView.carFields));
  t('차량 탭 라벨이 사용목적이다', () => assert(carView.titleLabel === '사용목적', carView.titleLabel));
  t('더 이상 조회 전용이 아니다', () => assert(!/조회 전용/.test(carView.hint), carView.hint));

  cli.close();
  await closeTab(tab.id);
} else {
  skipped('사이드패널 검사', '확장 ID 를 못 찾음');
}

/* ------------------------------------------- 실제 사이트 (로그인 필요) */

console.log('\n실제 사이트를 읽는다 (로그인 필요)');
{
  const tab = await newTab('about:blank');
  const cli = await attach(tab);
  await cli.goto(CAR_LIST, 25000);

  if (sawSignInAlert(cli)) {
    const why = `로그인 안 됨 — 사이트가 "${cli.dialogs[0].message}" 라고 했습니다. `
      + `포트 ${PORT} 크롬 창에서 eclass 에 로그인한 뒤 다시 돌리세요.`;
    skipped('차량 목록 파싱', why);
    skipped('신청 폼 구조 확인', why);
    skipped('회의실 목록 파싱', why);
  } else {
    const car = await cli.evaluate(`(() => {
      const grid = document.getElementById('RG_MAIN_ctl00');
      const btns = [...document.querySelectorAll('input[onclick*="Admin_View_New"]')];
      const m = btns.length
        ? (btns[0].getAttribute('onclick') || '').match(/CARIDX=(\\d+)[^']*?SDATE=([0-9-]+)/)
        : null;
      return {
        hasGrid: !!grid,
        rows: grid ? grid.rows.length : 0,
        dateLabel: (document.getElementById('LB_DATE_M')?.textContent || '').trim() || null,
        buttons: btns.length,
        carIdx: m ? m[1] : null,
        date: m ? m[2] : null,
      };
    })()`);

    t('차량 표를 읽는다', () => assert(car.hasGrid && car.rows > 1, JSON.stringify(car)));
    t('화면 날짜 라벨(LB_DATE_M)이 있다', () => assert(!!car.dateLabel, '라벨 없음'));
    t('예약 버튼에서 CARIDX 를 꺼낸다', () => assert(!!car.carIdx, JSON.stringify(car)));

    // 신청 폼 — **저장 버튼은 절대 누르지 않는다.** 구조만 읽는다.
    if (car.carIdx) {
      await cli.goto(
        `${ORIGIN}/intra/intranet/VSDotnet/RentCar/Admin_View_New.aspx?CARIDX=${car.carIdx}&SDATE=${car.date}`,
        25000,
      );
      const form = await cli.evaluate(`(() => {
        const names = [...document.querySelectorAll('input,select')].map((e) => e.name).filter(Boolean);
        const save = document.querySelector('input[type=image]');
        return { names, count: names.length, save: save ? save.name : null };
      })()`);

      t('신청 폼이 열린다', () => assert(form.count > 10, JSON.stringify(form).slice(0, 180)));
      t('시작/종료 시각 칸이 캡처 때와 같다', () => assert(
        ['ddlStimeH', 'ddlStimeM', 'ddlEtimeH', 'ddlEtimeM'].every((n) => form.names.includes(n)),
        '실제로 있는 시각 칸: ' + form.names.filter((n) => /time/i.test(n)).join(', '),
      ));
      t('날짜 칸이 캡처 때와 같다', () => assert(
        form.names.includes('txtSdate') && form.names.includes('txtEdate'),
        '실제: ' + form.names.filter((n) => /date/i.test(n)).join(', '),
      ));
      t('저장 버튼이 캡처 때와 같다 (누르지 않는다)', () =>
        assert(form.save === 'ibtnITSave', String(form.save)));
    }

    await cli.goto(ROOM_LIST, 25000);
    const room = await cli.evaluate(`(() => {
      const g = document.getElementById('RG_MAIN_ctl00');
      return {
        hasGrid: !!g,
        rows: g ? g.rows.length : 0,
        date: (document.getElementById('LB_DATE')?.textContent || '').trim() || null,
      };
    })()`);
    t('회의실 표도 읽는다', () => assert(room.hasGrid, JSON.stringify(room)));
  }

  cli.close();
  await closeTab(tab.id);
}

console.log(`\n통과 ${pass}건 / 건너뜀 ${skip}건 / 실패 ${fails.length}건`);
if (fails.length) {
  for (const f of fails) console.log('  ✕ ' + f);
  process.exit(1);
}
process.exit(0);
