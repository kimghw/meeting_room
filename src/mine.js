// "내 예약"만 골라낸다.
//
// 사이트는 **로그인한 사람이 누구인지 페이지 어디에도 적어주지 않는다.**
// 숨은 입력칸에도, 머리글에도 없다(2026-09-16 캡처로 확인). 그래서 신호를 셋 합쳐서 본다.
// 어느 신호로 잡혔는지 항목마다 남겨 두므로, 화면에서 "왜 내 것이라고 봤는지" 말할 수 있다.
//
//   button — 사이트가 본인 건에만 붙이는 수정/삭제 버튼. 가장 확실하지만 화면·승인 상태에 따라 없을 수 있다.
//   name   — 예약자 이름이 내 이름과 같음. 이름을 알고 있을 때만 쓴다.
//   booked — 이 확장으로 넣어 확인까지 끝난 예약 기록과 겹침.
//
// 신호가 하나도 없으면 내 것이 아니라고 단정하지 않고, **못 찾았다고 말한다**(화면 쪽 책임).

const squeeze = (s) => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, '').trim();

/** 이름이 같은지. 사이트마다 공백·직급 표기가 들쭉날쭉해서 공백을 지우고 본다. */
export function sameName(a, b) {
  const x = squeeze(a);
  const y = squeeze(b);
  return !!x && !!y && x === y;
}

/**
 * 이 예약을 내 것으로 볼 근거가 있는지.
 * @returns {'button'|'name'|'booked'|''} 근거. 빈 문자열이면 내 것이라고 볼 이유가 없다.
 */
export function mineReason(res, { name = '', booked = [], kind = 'room' } = {}) {
  if (res.mine) return 'button';
  if (name && sameName(res.owner, name)) return 'name';
  const hit = (booked || []).find((b) =>
    b.mode === kind && b.date === res.date && b.room === res.room &&
    b.start < res.end && b.end > res.start);
  return hit ? 'booked' : '';
}

/** 시작 날짜부터 하루씩 days 일치. */
export function datesFrom(startDate, days) {
  const out = [];
  const d = new Date(`${startDate}T00:00:00`);
  for (let i = 0; i < days; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function toItem(kind, res, why) {
  // 차량은 여러 날에 걸칠 수 있어 하루 안으로 자르기 전의 원래 구간을 쓴다.
  const from = res.spanStart || { date: res.date, minutes: res.start };
  const to = res.spanEnd || { date: res.date, minutes: res.end };
  return {
    kind,
    why,
    date: from.date,
    room: res.room || res.name || '',
    region: res.region || '',
    status: res.status || '',
    title: res.title || '',
    owner: res.owner || '',
    dept: res.dept || '',
    from,
    to,
    // 취소하려면 사이트가 준 삭제 정보(DelCheck 인자)가 필요하다
    del: res.del || null,
    record: res,
  };
}

const keyOf = (it) =>
  `${it.kind}|${it.room}|${it.from.date} ${it.from.minutes}|${it.to.date} ${it.to.minutes}|${it.owner}`;

/**
 * 날짜별 조회 결과에서 내 예약만 추린다.
 *
 * 확신할 수 없는 날은 **결과에서 빼고 따로 알린다.** 못 읽은 날을 조용히
 * "예약 없음"으로 넘기면 "내 예약이 없다"는 거짓 안내가 된다 — 이 앱에서 가장 나쁜 실패다.
 *
 * @param {Array<{kind:string, date:string, reservations:Array, confident:boolean, reason:string}>} days
 * @param {{name?: string, booked?: Array}} opts
 * @returns {{items: Array, skipped: Array<{kind:string, date:string, reason:string}>}}
 */
export function collectMine(days, opts = {}) {
  const seen = new Map();
  const skipped = [];

  for (const day of days) {
    if (!day.confident) {
      skipped.push({ kind: day.kind, date: day.date, reason: day.reason || '확인 불가' });
      continue;
    }
    for (const res of day.reservations || []) {
      const why = mineReason(res, { ...opts, kind: day.kind });
      if (!why) continue;
      const item = toItem(day.kind, res, why);
      const key = keyOf(item);
      // 차량 다중일 예약은 겹치는 날마다 한 번씩 읽힌다. 같은 건은 하나로 본다.
      const prev = seen.get(key);
      if (!prev || (prev.why !== 'button' && why === 'button')) seen.set(key, item);
    }
  }

  const items = [...seen.values()].sort((a, b) =>
    a.from.date.localeCompare(b.from.date) ||
    a.from.minutes - b.from.minutes ||
    a.room.localeCompare(b.room));

  return { items, skipped };
}
