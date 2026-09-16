// 툴바 아이콘 클릭 시 사이드 패널이 열리도록 한다.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('sidePanel.setPanelBehavior 실패:', err));
