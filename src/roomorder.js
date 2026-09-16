// 화면에 회의실을 어떤 차례로 세울지, 무엇을 접어 둘지 정한다.
//
// 사이트 드롭다운 차례는 **자주 쓰는 방이 아래에 몰려** 있다(부산지부·미팅룸이 먼저 오고
// 11층 제1~5회의실이 맨 끝). 격자는 위에서부터 읽히므로 자주 쓰는 방을 위로 올린다.
// 접는 방은 아예 빼지 않는다 — 없는 방으로 보이면 안 되므로 맨 아래에 모아 두고
// 화면에서 펼칠 수 있게 한다.
//
// 이름은 사이트가 주는 그대로다: "제1회의실(11층)-56석", "부산지부 제1회의실".

/** 위로 올릴 방. 앞에 오는 규칙일수록 위. 붙잡은 숫자로 같은 무리 안 차례를 정한다. */
const TOP = [
  /^제\s*(\d+)\s*회의실/,   // 제1~제5회의실 (11층)
  /^미팅룸\s*(\d+)/,        // 미팅룸1, 미팅룸2
];

/** 평소에 쓸 일이 없어 접어 두는 방. */
const FOLD = [/^부산지부/, /^스마트홀/, /^오션홀/];

const nameOf = (room) => String(room?.name || room?.label || '');

/** 접어 둘 방인가. 격자에서는 줄을 지우지 않고 감추기만 한다. */
export function isFoldedRoom(room) {
  const name = nameOf(room);
  return FOLD.some((re) => re.test(name));
}

/** 접은 무리를 한 줄로 알리는 이름. 부산지부처럼 여러 개인 것은 하나로 묶는다. */
export function foldLabels(rooms) {
  const out = [];
  for (const room of rooms) {
    const name = nameOf(room);
    const hit = FOLD.find((re) => re.test(name));
    if (!hit) continue;
    // 규칙이 붙잡은 앞머리("부산지부", "스마트홀")를 무리 이름으로 쓴다
    const label = name.match(hit)[0];
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** 차례 매기기: [무리, 무리 안 번호, 사이트 차례]. 값이 작을수록 위. */
function rankOf(room, index) {
  const name = nameOf(room);
  if (isFoldedRoom(room)) return [TOP.length + 1, 0, index];
  for (let g = 0; g < TOP.length; g++) {
    const m = name.match(TOP[g]);
    if (m) return [g, +m[1] || 0, index];
  }
  return [TOP.length, 0, index];
}

/**
 * 방 목록을 화면 차례로 다시 세운다. 원본은 건드리지 않는다.
 *
 * 격자의 줄 번호가 선택(picks)의 열쇠라서, 격자를 만드는 모든 길목에서 **같은 차례**가
 * 나와야 한다. 그래서 방 목록을 읽는 자리에서 한 번만 세워 두고, 캐시에도 그대로 담는다.
 */
export function sortRooms(rooms) {
  return rooms
    .map((room, index) => ({ room, rank: rankOf(room, index) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])
    .map((x) => x.room);
}
