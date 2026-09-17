// e-Class 홈에 "내 예약" 카드를 붙이는 콘텐츠 스크립트의 시동 부분.
//
// 콘텐츠 스크립트는 ES 모듈이 아니라 import 문을 못 쓴다. 그래서 여기서 확장 안의 모듈을
// 동적으로 불러온다 — manifest 의 web_accessible_resources 가 src/ 를 이 사이트에 열어 둔다.
// 매니페스트는 eclass 전체에 붙이지만(경로 대소문자가 들쭉날쭉해서), 실제로 카드를 붙이는 건 홈뿐이다.
// 붙일지 말지는 패널 머리의 체크박스(storage 의 homeCard)를 따른다. 꺼져 있어도 모듈은 불러 둔다
// — 패널에서 다시 켜면 새로고침 없이 카드가 붙어야 하기 때문이다.
(() => {
  // /eClassVer4/Home/Index, /eClassVer4/Home, /eClassVer4/ — MVC 기본 경로는 대소문자를 가리지 않는다.
  if (!/^\/eclassver4\/(home(\/index)?)?\/?$/i.test(location.pathname)) return;

  import(chrome.runtime.getURL('src/home.js'))
    .then(({ startHome }) => startHome(document))
    .catch((err) => console.warn('[KRS 회의실 예약] 홈 내 예약 카드를 붙이지 못했습니다:', err));
})();
