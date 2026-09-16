// 사이트 고유 설정. 2026-09-16 로그인 상태 캡처로 확인한 실제 구조.
export const ORIGIN = 'https://eclass.krs.co.kr';

// 회의실 앱 본체(로그인 필요). 사내 포털은 이 주소를 iframe 으로 감싸고 있을 뿐이다.
export const LIST_URL = `${ORIGIN}/intra/intranet/VSDotnet/MeetingRoom/List.aspx`;

// 사용자가 로그인할 때 여는 바깥 페이지.
export const SHELL_URL = `${ORIGIN}/GAPSU/GeneralAffairs/MeetingRoom/MeetingRoom_New.aspx?s_code=0103010100`;

export const DEFAULT_HOURS = { start: 8, end: 20 };
export const SLOT_MINUTES = 60;

/**
 * 조회 화면(Telerik RadGrid) 구조.
 * 헤더 행이 `display:none` 에 `&nbsp;` 뿐이라 헤더 이름으로는 컬럼을 찾을 수 없다.
 * 컬럼 위치는 colgroup 으로 고정되어 있어 인덱스로 읽는다.
 */
export const GRID = {
  tableId: 'RG_MAIN_ctl00',
  tableClass: 'rgMasterTable',
  detailClass: 'rgDetailTable',
  minCells: 6,
  col: { region: 2, room: 3, time: 4, status: 5 },
};

/** 선택된 날짜를 그대로 보여주는 라벨. 요청한 날짜가 맞는지 확인하는 데 쓴다. */
export const DATE_LABEL_ID = 'LB_DATE';

/** 차량 화면은 라벨 id 가 다르다. */
export const CAR_DATE_LABEL_ID = 'LB_DATE_M';

/** 차량 예약표 컬럼. 회의실과 달리 시간은 상세 표에 있다. */
export const CAR_GRID = {
  tableId: 'RG_MAIN_ctl00',
  tableClass: 'rgMasterTable',
  detailClass: 'rgDetailTable',
  main: { name: 1, status: 3 },
  detail: { purpose: 0, time: 1, owner: 2 },
};

/** 월 달력. 날짜별 예약 건수가 찍혀 있어 파싱 결과 대조에 쓴다. */
export const CALENDAR = { id: 'CAL_MAIN', selectedField: 'CAL_MAIN_SD' };

/** 예약 폼(같은 페이지 안의 숨겨진 div_write). */
export const FORM = {
  region: 'DDL_REGION',
  room: 'DDL_ROOMNAME',
  date: 'DP_ROOMDATE',
  dateInput: 'DP_ROOMDATE$dateInput',
  // Telerik 날짜 피커는 위 두 칸의 글자를 믿지 않고 아래 ClientState 를 읽는다.
  // 이걸 비워 보내면 서버가 ViewState 의 날짜(보통 오늘)를 그대로 쓴다.
  dateClientState: 'DP_ROOMDATE_ClientState',
  dateInputClientState: 'DP_ROOMDATE_dateInput_ClientState',
  dateCalendarSelected: 'DP_ROOMDATE_calendar_SD',
  // 폼 날짜 피커의 팝업 달력. 사람이 날짜를 고를 때 여기로 포스트백이 간다.
  dateCalendar: 'DP_ROOMDATE$calendar',
  startHour: 'DDL_ROOMSHOUR',
  startMinute: 'DDL_ROOMSMINUTE',
  endHour: 'DDL_ROOMEHOUR',
  endMinute: 'DDL_ROOMEMINUTE',
  repeat: 'RB_REPEAT',
  title: 'TXT_TITLE',
  save: 'BTN_SAVE',
};

/** 회의실 드롭다운에서 실제 회의실이 아닌 항목. */
export const ROOM_PLACEHOLDER_VALUES = ['-', ''];

/** 예약 폼의 분 드롭다운은 10분 단위만 허용한다. */
export const MINUTE_STEP = 10;

/**
 * 예약 삭제. 사이트의 fn_del(idx, group_idx) 가 하는 일을 그대로 흉내 낸다.
 *   HF_DEL_YN='N'(한 건만) / 'Y'(같이 신청된 건까지)
 *   HF_IDX, HF_GROUP_IDX, hdn_pIDX, hdn_GROUP_pIDX 를 채우고 lbDelete 를 누른다.
 */
export const DELETE = {
  flag: 'HF_DEL_YN',
  idx: 'HF_IDX',
  groupIdx: 'HF_GROUP_IDX',
  pIdx: 'hdn_pIDX',
  pGroupIdx: 'hdn_GROUP_pIDX',
  submit: 'lbDelete',
};

/* ------------------------------------------------------------ 차량 신청 */

/**
 * 차량 신청 폼. 목록 행의 예약 버튼이 여는 **팝업 페이지**다.
 *
 * 확인된 것: 주소와 질의 문자열. 2026-09-16 목록 fixture 의 예약 버튼 onclick 에
 *   fnview('Admin_View_New.aspx?CARIDX=32&SDATE=2026-09-16', ...) 로 박혀 있다.
 * 확인 못 한 것: **이 페이지의 폼 구조 전체.** 한 번도 캡처된 적이 없다.
 *   그래서 필드 이름을 여기에 박아두지 않고 src/carform.js 가 문서를 보고 찾아낸다.
 */
export const CAR_RESERVE_URL = `${ORIGIN}/intra/intranet/VSDotnet/RentCar/Admin_View_New.aspx`;

/**
 * 신청 폼 필드 이름 **후보**. 확인된 이름이 아니다.
 *
 * 출처는 차량 목록 페이지에 죽은 채로 남아 있는 스크립트(fnSave/fnCancel)다.
 * 목록 페이지에는 정작 이 입력칸들이 없다 — 스크립트만 남고 마크업은 신청 페이지로 갔다.
 * 그래서 "아마 이 이름일 것"까지가 우리가 아는 전부이고, carform.js 는 이 목록을
 * **힌트로만** 쓰고 실제 판정은 문서 내용(옵션 값·라벨 글자)으로 한다.
 */
export const CAR_FORM_HINTS = {
  car: ['DDL_CARNAME', 'DDL_CAR', 'CARNAME', 'CARIDX'],
  driver: ['TXT_DRIVER'],
  driverDept: ['TXT_DRIVER_DEPT_NAME'],
  driverId: ['hidDriverID'],
  title: ['TXT_TITLE'],
  place: ['TXT_PLACE'],
  passenger: ['TXT_PASSENGER'],
  // 아래는 순전히 추측이다. 목록 페이지 스크립트에도 안 나온다.
  startDate: ['DP_SDATE', 'DP_STARTDATE', 'TXT_SDATE'],
  endDate: ['DP_EDATE', 'DP_ENDDATE', 'TXT_EDATE'],
  startHour: ['DDL_SHOUR', 'DDL_CARSHOUR'],
  startMinute: ['DDL_SMINUTE', 'DDL_CARSMINUTE'],
  endHour: ['DDL_EHOUR', 'DDL_CAREHOUR'],
  endMinute: ['DDL_EMINUTE', 'DDL_CAREMINUTE'],
  save: ['BTN_SAVE', 'BTN_REG', 'BTN_INSERT', 'BTN_OK'],
};

/**
 * 차량 예약 삭제. 회의실(lbDelete 클릭)과 **경로가 다르다.**
 *
 * 목록 페이지의 fn_del(idx, group_idx) 가 하는 일:
 *   HF_DEL_YN = 'N'(한 건만) / 'Y'(같이 신청된 건까지)
 *   HF_IDX, HF_GROUP_IDX 를 채우고 __doPostBack('RG_MAIN$ctl00$ctl04$BTN_DEL','')
 *
 * 확인된 것: HF_* 세 칸은 fixture 에 실제 hidden input 으로 있다.
 * 확인 못 한 것: eventTarget 의 `ctl04`. 스크립트에 하드코딩돼 있지만 화면마다 다를 수 있고,
 *   2026-09-16 fixture 에는 삭제 버튼을 가진 행이 하나도 없어 마크업을 대조하지 못했다.
 *   그래서 rentcar.js 는 문서에서 실제 버튼 이름을 먼저 찾아보고, 없을 때만 이 값을 쓴다.
 */
export const CAR_DELETE = {
  flag: 'HF_DEL_YN',
  idx: 'HF_IDX',
  groupIdx: 'HF_GROUP_IDX',
  updateFlag: 'HF_UPDATE_YN',
  eventTarget: 'RG_MAIN$ctl00$ctl04$BTN_DEL',
};
