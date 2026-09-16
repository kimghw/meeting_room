import { loadDay } from './site.js';
import { fmtTime } from './parse.js';

/** 하루에 여러 번 조회하므로 너무 넓은 범위는 막는다. */
export const MAX_DAYS = 14;

function dateRange(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (d <= end && out.length < MAX_DAYS) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * 찾은 후보를 화면에 보이게 하려면 시간대가 그 구간을 덮어야 한다.
 *
 * 검색은 문장의 시간대로 돌a고 격자는 화면의 시간 선택을 쓰기 때문에,
 * 08시 후보를 09시부터 보는 화면에서 누르면 골라낼 칸이 없다.
 *
 * @returns {{start:number, end:number}} 넓혔거나 그대로인 시간대
 */
export function widenHours(current, startMin, endMin) {
  return {
    start: Math.min(current.start, Math.floor(startMin / 60)),
    end: Math.max(current.end, Math.ceil(endMin / 60)),
  };
}

/** 한 회의실의 슬롯 줄에서 연속으로 비어 있는 구간을 뽑는다. */
export function freeRuns(slots, minSlots) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= slots.length; i++) {
    const free = i < slots.length && slots[i].state === 'free';
    if (free && start < 0) start = i;
    if (!free && start >= 0) {
      if (i - start >= minSlots) runs.push({ from: start, to: i - 1 });
      start = -1;
    }
  }
  return runs;
}

/**
 * 조건에 맞는 빈 시간대를 날짜별로 찾는다.
 *
 * 현황을 확신할 수 없는 날(confident=false)은 **결과에서 빼고 따로 알린다.**
 * 못 읽은 날을 조용히 "자리 없음"으로 넘기면 거짓 안내가 된다.
 *
 * @param {object} filter parseQuery 결과
 * @param {(msg: string, i: number, n: number) => void} onProgress
 * @param {(date: string, hours: object, region: string|null) => Promise} loader
 *        하루치를 가져오는 함수. 기본은 회의실 조회이고, 테스트는 가짜를 넘긴다.
 */
export async function findSlots(filter, onProgress = () => {}, loader = loadDay) {
  const hours = { start: filter.hourFrom, end: filter.hourTo };
  const dates = dateRange(filter.dateFrom, filter.dateTo);
  const minSlots = Math.max(1, Math.ceil(filter.minHours || 1));

  const results = [];
  const skipped = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    onProgress(date, i + 1, dates.length);

    let day;
    try {
      day = await loader(date, hours, filter.region || null);
    } catch (err) {
      skipped.push({ date, reason: err.message });
      continue;
    }

    if (!day.confident) {
      skipped.push({ date, reason: day.reason });
      continue;
    }

    for (const row of day.grid) {
      if (filter.minSeats && (row.room.seats == null || row.room.seats < filter.minSeats)) continue;

      for (const run of freeRuns(row.slots, minSlots)) {
        results.push({
          date,
          region: day.region,
          room: row.room,
          fromSlot: run.from,
          toSlot: run.to,
          start: row.slots[run.from].start,
          end: row.slots[run.to].end,
          hours: (row.slots[run.to].end - row.slots[run.from].start) / 60,
          label: `${fmtTime(row.slots[run.from].start)}~${fmtTime(row.slots[run.to].end)}`,
        });
      }
    }
  }

  // 긴 자리, 이른 날짜, 큰 방 순
  results.sort((a, b) =>
    b.hours - a.hours ||
    a.date.localeCompare(b.date) ||
    a.start - b.start ||
    (b.room.seats || 0) - (a.room.seats || 0));

  return { results, skipped, dates };
}
