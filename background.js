// 툴바 아이콘 클릭 시 사이드 패널이 열리도록 한다.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('sidePanel.setPanelBehavior 실패:', err));

// 홈의 내 예약 카드(콘텐츠 스크립트)는 sidePanel API 를 직접 못 부른다. 그 탭에 패널을 열어 달라는
// 부탁을 대신 들어준다. sidePanel.open 은 사용자 동작에 응해서만 열리는데, 카드의 버튼 클릭에서
// 온 메시지는 그 동작을 물려받는다.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'openSidePanel') return false;
  const tabId = sender.tab?.id;
  const opening = tabId == null
    ? Promise.reject(new Error('어느 탭인지 알 수 없습니다.'))
    : chrome.sidePanel.open({ tabId });
  opening.then(
    () => sendResponse({ ok: true }),
    (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
  );
  return true;   // 답은 나중에 준다
});
