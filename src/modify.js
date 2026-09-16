// 예약 "수정" = 기존 건을 취소하고 새 조건으로 다시 넣기.
//
// 사이트에는 수정 기능이 없다. 그래서 취소 → 재예약 두 번을 우리가 이어 붙이는데,
// 중간에서 실패하면 **원래 예약까지 없어진다.** 그 되돌리기 판단을 한 곳에 모은 파일이다.
// (지금까지는 sidepanel.js 의 extendBooking 안에 손으로 박혀 있었다.)
//
// 여기는 네트워크를 모른다. 취소/예약/복구를 콜백으로 받는다. 그래서 회의실(site.js)이든
// 차량(rentcar.js)이든 같은 규칙을 쓰고, 테스트도 가짜 콜백만으로 전부 된다.

/** 복구 못 한 경우 반드시 들어가야 하는 말. 문구를 한 군데서만 고치려고 상수로 둔다. */
const LOST_HINT = '원래 예약이 사라졌을 수 있으니 사이트에서 확인해 주세요.';

/** 단계 시작을 알리는 문구(진행 표시용). */
const STAGE_TEXT = {
  cancel: '기존 예약을 취소하는 중...',
  reserve: '새 조건으로 예약하는 중...',
  restore: '원래 예약을 되살리는 중...',
};

/**
 * 성공 판정. `ok:true` 인데 `verified:false` 인 엇갈린 결과는 **성공으로 보지 않는다.**
 * 이 프로젝트에서 ok 는 "재조회로 확인까지 끝났다"는 뜻이라, 둘이 어긋나면 확인이 안 된 것이다.
 */
function succeeded(r) {
  return r?.ok === true && r?.verified !== false;
}

/**
 * 콜백 하나를 안전하게 부른다.
 * 예외를 밖으로 흘리지 않는다 — 수정 흐름이 중간에 끊기면 되돌릴 기회 자체가 사라진다.
 * 예외는 `submitted` 를 알려주지 않으므로 계약대로 "제출도 못 함"(submitted:false)으로 본다.
 */
async function runStep(fn, label) {
  if (typeof fn !== 'function') {
    // 부를 방법이 없었으니 제출도 없었다. 성공으로 넘기지 않고 실패로 내려간다.
    return { ok: false, submitted: false, message: `${label} 방법이 없습니다.` };
  }
  try {
    const r = await fn();
    if (r && typeof r === 'object') return r;
    // 아무것도 안 돌려주면 성공으로 치지 않는다 — 모를 때는 모른다고 한다.
    return { ok: false, submitted: false, message: `${label} 결과를 읽지 못했습니다.` };
  } catch (err) {
    return { ok: false, submitted: false, message: `${label} 실패: ${err?.message || err}` };
  }
}

/** 단계 알림. UI 콜백이 터져도 수정 흐름까지 같이 죽으면 안 되므로 감싼다. */
function notify(onStage, stage) {
  if (typeof onStage !== 'function') return;
  try {
    onStage(stage, STAGE_TEXT[stage]);
  } catch {
    // 진행 표시가 실패하는 건 예약 자체와 상관없다. 조용히 넘어간다.
  }
}

/** 단계 메시지가 비어 있을 때 대신 쓸 말. 빈 문자열을 그대로 내보내면 UI 가 아무 말도 못 한다. */
function reason(r) {
  const m = (r?.message || '').trim();
  return m || '이유를 알 수 없습니다.';
}

/**
 * 예약을 수정한다 = 기존 건을 취소하고 새 조건으로 다시 예약한다.
 * **실패하면 기존 예약을 유지/복구한다.**
 *
 * @param {{
 *   cancel:  () => Promise<{ok:boolean, submitted?:boolean, message?:string}>,
 *   reserve: () => Promise<{ok:boolean, submitted?:boolean, verified?:boolean, message?:string, record?:object}>,
 *   restore: () => Promise<{ok:boolean, submitted?:boolean, verified?:boolean, message?:string, record?:object}>,
 *   onStage?: (stage:'cancel'|'reserve'|'restore', text:string) => void,
 * }} plan
 * @returns {Promise<{
 *   ok: boolean,
 *   stage: 'cancel'|'reserve'|'restore'|'done',
 *   restored: boolean,   // 원래 예약이 그대로거나 되살아났다
 *   lost: boolean,       // 원래 예약이 사라졌을 수 있다 — 사람이 확인해야 한다
 *   uncertain: boolean,  // 새 예약이 저장됐는지 알 수 없다
 *   message: string,
 *   record?: object,
 * }>}
 */
export async function modifyReservation(plan = {}) {
  const { onStage } = plan;

  // 1) 기존 건 취소. 여기서 막히면 아무것도 건드리지 않은 것이므로 되살릴 것도 없다.
  notify(onStage, 'cancel');
  const off = await runStep(plan.cancel, '기존 예약 취소');
  if (!succeeded(off)) {
    // reserve 를 부르지 않는 것이 핵심이다. 취소가 안 된 시간에 또 넣으면 사이트가 겹친다고 거절한다.
    return {
      ok: false,
      stage: 'cancel',
      restored: true,
      lost: false,
      uncertain: false,
      message: `기존 예약을 취소하지 못해 그대로 두었습니다: ${reason(off)}`,
    };
  }

  // 2) 새 조건으로 예약.
  notify(onStage, 'reserve');
  const made = await runStep(plan.reserve, '새 예약');
  if (succeeded(made)) {
    return {
      ok: true,
      stage: 'done',
      restored: false,
      lost: false,
      uncertain: false,
      message: made.message ? `수정했습니다. (사이트 응답: ${made.message})` : '수정했습니다.',
      record: made.record,
    };
  }

  // 3) 새 예약이 실패했다. 여기서 갈린다 — **제출이 있었는가.**
  //
  //    제출은 됐는데 확인이 안 된 경우(submitted:true, ok:false)에는 **복구하지 않는다.**
  //    저장이 실제로 됐을 수도 있어서, 원래 예약을 되살리면 **이중 예약**이 된다.
  //    조용히 둘 다 잡아 놓는 것보다 "모르겠다"고 말하는 편이 낫다 — 사람이 사이트에서
  //    한 번 보면 끝나지만, 이중 예약은 남이 못 쓰는 칸을 말없이 하나 더 만든다.
  //
  //    `ok:true` 인데 `verified:false` 인 엇갈린 결과도 같은 쪽으로 보낸다.
  //    성공이라고 할 수는 없지만 저장은 됐을 수 있어, 복구는 마찬가지로 위험하다.
  if (made.submitted === true || made.ok === true) {
    return {
      ok: false,
      stage: 'reserve',
      restored: false,
      lost: false,
      uncertain: true,
      message: `새 예약을 제출했지만 저장됐는지 확인하지 못했습니다(${reason(made)}). ` +
        '되살리면 이중 예약이 될 수 있어 원래 예약은 손대지 않았습니다 — 사이트에서 확인해 주세요.',
    };
  }

  // 4) 제출조차 못 했다 = 새 예약은 확실히 없다. 원래 예약을 되살린다.
  notify(onStage, 'restore');
  const back = await runStep(plan.restore, '원래 예약 복구');
  if (succeeded(back)) {
    return {
      ok: false,
      stage: 'reserve',
      restored: true,
      lost: false,
      uncertain: false,
      message: `새로 예약하지 못해 원래 예약을 되살렸습니다: ${reason(made)}`,
      record: back.record,
    };
  }

  return {
    ok: false,
    stage: 'restore',
    restored: false,
    lost: true,
    uncertain: false,
    message: `새로 예약하지 못했고(${reason(made)}) 원래 예약도 되살리지 못했습니다(${reason(back)}). ${LOST_HINT}`,
  };
}

/**
 * 결과를 사람이 읽을 한 문장으로 만든다. UI 가 상태줄에 그대로 쓴다.
 *
 * 문장은 modifyReservation 이 이미 만들어 두었으므로 그대로 옮긴다 — 같은 말을 두 군데서
 * 지어내면 한쪽만 고쳐져 어긋난다. 여기서 더하는 건 **UI 가 결정해야 할 두 가지**뿐이다.
 * `needsSiteCheck` 는 lost 이거나 uncertain 일 때 true — 그때만 "사이트에서 확인" 링크를 붙인다.
 *
 * @returns {{text: string, kind: '' | 'error', needsSiteCheck: boolean}}
 */
export function describeModifyResult(result) {
  if (!result || typeof result !== 'object') {
    // 결과를 못 받은 것도 "모른다"에 속한다. 성공처럼 보이게 두지 않는다.
    return { text: `수정 결과를 알 수 없습니다. ${LOST_HINT}`, kind: 'error', needsSiteCheck: true };
  }
  const ok = result.ok === true;
  const text = (result.message || '').trim() || (ok ? '수정했습니다.' : '수정하지 못했습니다.');
  return {
    text,
    kind: ok ? '' : 'error',
    needsSiteCheck: result.lost === true || result.uncertain === true,
  };
}
