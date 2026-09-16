// 한 번 읽은 하루치 현황을 담아 두는 곳. 회의실·차량·내 예약 세 탭이 같은 것을 본다.
//
// 훑기는 하루에 요청 한 번이지만 한 달이면 서른 번이다. 탭을 옮기거나 날짜를 바꿀 때마다
// 다시 훑으면 느린 사이트를 계속 두드리게 된다. 그래서 **패널이 열릴 때 한 달을 한 번 훑고,
// 그 뒤로는 여기서 꺼내 쓴다.**
//
// 담은 값에는 **언제 읽었는지**가 붙는다. 현황은 금방 낡는다. 얼마나 묵었는지 말할 수 없는
// 캐시는 이미 찬 칸을 "예약 가능"으로 보여주게 되는데, 이 앱에서 가장 나쁜 실패다.
// 그래서 묵은 기록은 조회 대상에서 빠지고(missing), 화면에 그릴 때는 읽은 시각을 함께 말한다.

/** 시작할 때 미리 훑는 날 수. "한 달". */
export const MONTH_DAYS = 30;

/** 이보다 묵은 기록은 다시 읽는다. */
export const STALE_MS = 10 * 60_000;

/** 세 탭이 쓰는 두 가지 현황. */
export const KINDS = ['room', 'car'];

const keyOf = (kind, date) => `${kind}|${date}`;

/**
 * 날짜별 기록 보관소.
 *
 * @param {{staleMs?: number, now?: () => number}} opts 시각은 주입받는다 — 테스트에서 묵히려고.
 */
export function createDayStore({ staleMs = STALE_MS, now = () => Date.now() } = {}) {
  const days = new Map();

  const isFresh = (rec) => !!rec && now() - rec.at < staleMs;
  const pick = (kind, date) => days.get(keyOf(kind, date)) || null;

  const store = {
    /** 하루치를 담는다. 읽은 시각(at)을 붙여 돌려준다. */
    put(day) {
      if (!day || !day.kind || !day.date) return null;
      const rec = { ...day, at: now() };
      days.set(keyOf(day.kind, day.date), rec);
      return rec;
    },

    /** 담긴 기록. 묵었어도 준다 — 부르는 쪽이 '언제 읽은 것'인지 말할 수 있게. */
    get(kind, date) { return pick(kind, date); },

    /** 담겨 있고 아직 묵지 않았는가. */
    fresh(kind, date) { return isFresh(pick(kind, date)); },

    /** 그 날짜들이 모두(회의실·차량 둘 다) 신선하게 담겨 있는가. */
    covers(dates, kinds = KINDS) {
      return dates.every((date) => kinds.every((kind) => isFresh(pick(kind, date))));
    },

    /** 아직 읽지 않았거나 묵어서 다시 읽어야 할 날짜만. 훑을 목록이 된다. */
    missing(dates, kinds = KINDS) {
      return dates.filter((date) => kinds.some((kind) => !isFresh(pick(kind, date))));
    },

    /** 그 날짜들의 기록. 없는 날은 그냥 빠진다(내 예약 집계에 그대로 넘긴다). */
    list(dates, kinds = KINDS) {
      const out = [];
      for (const date of dates) {
        for (const kind of kinds) {
          const rec = pick(kind, date);
          if (rec) out.push(rec);
        }
      }
      return out;
    },

    /** 그 범위에서 가장 오래전에 읽은 시각. 0 이면 담긴 게 없다. */
    oldest(dates, kinds = KINDS) {
      let min = 0;
      for (const rec of store.list(dates, kinds)) if (!min || rec.at < min) min = rec.at;
      return min;
    },

    /** 예약·취소로 낡아진 날을 버린다. 버린 날은 다음에 다시 읽는다. */
    drop(dates, kinds = KINDS) {
      for (const date of dates) for (const kind of kinds) days.delete(keyOf(kind, date));
    },

    size() { return days.size; },
    clear() { days.clear(); },
  };

  return store;
}
