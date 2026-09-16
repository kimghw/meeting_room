/* eclass 에 로그인한 상태에서
   https://eclass.krs.co.kr/intra/intranet/VSDotnet/MeetingRoom/List.aspx
   를 연 뒤 F12 → Console 에 아래 한 줄을 붙여넣고 Enter. */

(()=>{const h=document.documentElement.outerHTML;const b=new Blob([h],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='meetingroom-list.html';a.click();console.log('저장됨:',h.length,'바이트');})()


/* 차량 예약 페이지 캡처
   https://eclass.krs.co.kr/intra/intranet/VSDotnet/RentCar/New_List.aspx?s_code=0102010300
   를 연 뒤 F12 -> Console 에 아래 한 줄. */

(()=>{const h=document.documentElement.outerHTML;const b=new Blob([h],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='rentcar-list.html';a.click();console.log('저장됨:',h.length,'바이트');})()


/* ───────────────────────────────────────────────────────────────
   차량 **신청 폼** 캡처  (이게 지금 유일하게 구조를 모르는 화면이다)

   1) 로그인된 크롬에서 차량 목록을 연다
      https://eclass.krs.co.kr/intra/intranet/VSDotnet/RentCar/New_List.aspx?s_code=0102010300
   2) 아무 차량 행의 [예약] 버튼을 누른다 → 팝업 창이 뜬다
      (주소가 Admin_View_New.aspx?CARIDX=..&SDATE=.. 인 그 창)
   3) **팝업 창에서** F12 → Console → 아래 한 줄을 붙여넣고 Enter
   ─────────────────────────────────────────────────────────────── */

(()=>{const h=document.documentElement.outerHTML;const b=new Blob([h],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='rentcar-form.html';a.click();console.log('저장됨:',h.length,'바이트',location.href);})()


/* 다운로드가 막히면 이 한 줄. 입력칸 목록이 콘솔에 찍히고 클립보드에도 들어간다. */

(()=>{const f=[...document.querySelectorAll('input,select,textarea')].filter(e=>!/^__(VIEWSTATE|EVENTVALIDATION|VIEWSTATEGENERATOR)/.test(e.name||'')).map(e=>`${e.tagName}|${e.type||''}|name=${e.name||''}|id=${e.id||''}|v=${(e.value||'').slice(0,24)}`+(e.tagName==='SELECT'?`|opts(${e.options.length})=${[...e.options].slice(0,8).map(o=>o.value).join(',')}`:''));const out=location.href+'\n'+f.join('\n');console.log(out);try{copy(out);console.log('— 클립보드에 복사됨 —')}catch{}})()
