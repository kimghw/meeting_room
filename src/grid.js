// Telerik RadGrid 공통 처리.
//
// 회의실 표는 헤더가 display:none 이라 컬럼 이름으로 찾을 수 없고 위치도 화면마다 다르다.
// 그래서 **행 내용을 보고** 어느 칸이 시간이고 어느 칸이 이름인지 알아낸다.
// 이 방식은 회의실 실제 페이지로 검증했다(test/grid.test.mjs).

import { parseTimeRange } from './parse.js';

const clean = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

/** 지역처럼 값이 몇 개 안 되는 짧은 라벨. */
const REGIONISH = /^(부산|서울|인천|대전|대구|광주|울산|경기|본사|지부)$/;
/** 진행 상태 라벨. */
const STATUSISH = /^(승인|대기|반려|취소|신청|완료|사용중|예약)$/;

/** 표에서 데이터 행만 고른다(헤더·상세 행 제외). */
export function dataRows(table, minCells) {
  return [...table.rows].filter((r) => r.cells.length >= minCells && !r.querySelector('th'));
}

/**
 * 데이터 행들을 훑어 각 컬럼이 무엇인지 추정한다.
 *
 * @returns {{time:number|null, name:number|null, region:number|null, status:number|null}}
 */
export function detectColumns(rows) {
  if (!rows.length) return { time: null, name: null, region: null, status: null };

  const width = Math.max(...rows.map((r) => r.cells.length));
  const stat = [];

  for (let c = 0; c < width; c++) {
    const texts = rows.map((r) => clean(r.cells[c]?.textContent)).filter(Boolean);
    const seen = texts.length;
    stat.push({
      col: c,
      filled: seen / rows.length,
      timeRate: seen ? texts.filter((t) => parseTimeRange(t)).length / seen : 0,
      regionRate: seen ? texts.filter((t) => REGIONISH.test(t)).length / seen : 0,
      statusRate: seen ? texts.filter((t) => STATUSISH.test(t)).length / seen : 0,
      avgLen: seen ? texts.reduce((a, t) => a + t.length, 0) / seen : 0,
      distinct: new Set(texts).size,
      numericRate: seen ? texts.filter((t) => /^\d+$/.test(t)).length / seen : 0,
    });
  }

  const pick = (fn) => {
    const best = stat.filter(fn).sort((a, b) => b.filled - a.filled)[0];
    return best ? best.col : null;
  };

  const time = pick((s) => s.timeRate >= 0.6);
  const region = pick((s) => s.regionRate >= 0.6);
  const status = pick((s) => s.statusRate >= 0.6);

  // 이름 칸: 거의 모든 행이 차 있고, 시간·지역·상태가 아니고,
  // 숫자만 있지 않으며 글자가 어느 정도 길고 값이 다양한 칸
  const nameCand = stat
    .filter((s) => s.col !== time && s.col !== region && s.col !== status)
    .filter((s) => s.filled >= 0.9 && s.numericRate < 0.5 && s.avgLen >= 2)
    .sort((a, b) => b.distinct - a.distinct || b.avgLen - a.avgLen);
  const name = nameCand.length ? nameCand[0].col : null;

  return { time, name, region, status };
}

/**
 * 감지한 컬럼으로 예약 목록을 뽑는다.
 * @param {HTMLElement[]} rows 데이터 행
 * @param {object} cols detectColumns 결과
 * @param {(row) => boolean} isMine 내 예약 판정
 */
export function readRows(rows, cols, isMine) {
  const out = [];
  let unreadable = 0;

  for (const row of rows) {
    const cellText = (i) => (i == null ? '' : clean(row.cells[i]?.textContent));
    const name = cellText(cols.name);
    const range = parseTimeRange(cellText(cols.time));

    if (!name || !range) {
      if (clean(row.textContent)) unreadable++;
      continue;
    }
    out.push({
      name,
      start: range.start,
      end: range.end,
      region: cellText(cols.region),
      status: cellText(cols.status),
      mine: isMine ? isMine(row) : false,
      row,
    });
  }
  return { rows: out, unreadable };
}
