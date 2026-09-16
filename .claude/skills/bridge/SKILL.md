---
name: bridge
description: KRS 회의실 예약 확장의 로컬 Claude CLI 다리(네이티브 메시징) 설정·진단. 크롬·엣지 둘 다 다룬다. 인자 없으면 여섯 항목 점검표를 출력하고 다음 할 일을 짚어준다. 등록(install)·왕복 확인(ping)·claude 호출까지 확인(test)·다리 호출 기록 보기(log)·해제(uninstall)·확장 ID 계산(id)·브라우저 실행 상태와 재시작 명령(browser|chrome|edge). 등록·점검·브라우저 실행 확인은 bridge_ops.ps1 로 위임한다. TRIGGER when 사용자가 /bridge 호출, 말로 찾기 칸이 잠김, 배지가 '없음', 'claude가 연결되지 않았습니다' 문구, 다리 등록·재등록, 새 PC 에 설치, 엣지에서 쓰고 싶다. DO NOT TRIGGER when eclass 로그인 문제, 예약 실패 진단, 포트·서비스 관리.
allowed-tools: Bash PowerShell AskUserQuestion Read
argument-hint: "[check|install [<ID>]|ping|test|log [N]|browser|chrome|edge|restart [chrome|edge]|shortcut [<폴더>]|id|uninstall|help]"
---

# bridge — 로컬 Claude CLI 다리 설정·진단

브라우저 확장은 샌드박스 안에 있어 `claude.exe` 를 띄울 수 없다. 크로미엄이 뚫어둔 유일한 통로가
**네이티브 메시징**이고, 이 스킬은 그 통로를 놓고 점검한다. 조작은 전부 `bridge_ops.ps1` 이 한다.

크롬과 엣지를 같이 다룬다. 둘은 확장 ID 계산·origin(`chrome-extension://`)·매니페스트 형식이 같고,
레지스트리 키 위치·프로필 폴더·프로세스 이름(`chrome.exe`/`msedge.exe`)만 다르다. 그 차이는
`bridge_ops.ps1` 맨 위 `$Browsers` 표에만 있다.

> 부작용: `HKCU` 레지스트리 쓰기(크롬·엣지 키 둘 다), `native\com.krs.meetingroom.json` 생성, `test` 는 실제 claude
> 호출(해구 모델, 1센트 남짓). 되돌리기는 `uninstall` 하나면 된다.

## 핵심 원칙

- **하나로는 안 된다**: 아래 여섯이 다 맞아야 돈다. "등록 완료" 는 그중 하나일 뿐이다.
- **인증이 아니라 통로 문제**: `.credentials.json` 을 확장에 넘겨도 소용없다. 확장은 파일을
  읽을 수도, 프로세스를 띄울 수도 없다. 그 토큰은 `claude` 가 쓰는 구독 로그인 토큰이지
  API 키가 아니라서 `api.anthropic.com` 직접 호출에도 못 쓴다.
  **인증정보만으로 되는 길을 원하면 그건 다리가 아니라 API 키다** (`설정 및 연결` 에 `sk-ant-...`).
- **추측하지 말고 check**: 증상만 보고 원인을 짚지 않는다. 여섯 줄을 먼저 찍는다.
- **끝은 늘 브라우저 재시작**: 등록은 브라우저가 뜰 때 한 번만 읽는다. 켜둔 채 등록하면 반영되지 않는다.
  `check` 는 브라우저 본체가 등록(매니페스트 파일 시각)보다 먼저 떴는지 비교해 재시작이 정말 필요한지만 말한다.

## 여섯 조건

| # | 조건 | 어긋나면 |
|:--|:---|:---|
| 1 | `node` PATH | 다리가 뜨지 못함 |
| 2 | `claude` PATH | 호스트가 CLI 를 못 찾음 |
| 3 | `claude` 로그인 (`~\.claude\.credentials.json`) | 등록은 성공, 쓸 때 실패 → `test` 로만 드러남 |
| 4 | `native\host.mjs` + `claude-bridge.bat` | 폴더가 덜 복사된 것 |
| 5 | 레지스트리 등록(설치된 브라우저마다) + 매니페스트의 ID 일치 | 배지 `없음` |
| 6 | 확장이 그 경로에서 로드 + **브라우저 완전 재시작** (엣지는 창을 닫아도 남는다) | 배지 `없음` |

## 인자 분기 (`$ARGUMENTS`)

| 인자 | 동작 |
|:---|:---|
| (없음) 또는 `check` | 여섯 항목 점검표 + 다음 할 일. **먼저 이것부터 돌린다.** 설치된 브라우저마다 등록 줄이 하나씩 찍힌다 |
| `install` | 폴더 경로로 확장 ID 를 계산해 크롬·엣지 키에 한 번에 등록하고, 곧바로 `ping` 으로 왕복 확인 |
| `install <ID>` | 준 ID 로 등록. 계산이 틀어졌거나 `chrome://extensions`·`edge://extensions` 에서 복사해 왔을 때 |
| `ping` | 다리 왕복만 확인. claude 를 부르지 않아 공짜·빠름 |
| `test` | `parse` 작업을 한 번 태워 **로그인까지** 확인 (과금 있음). 사용자에게 알리고 돌린다 |
| `log [N]` | 다리가 `native\logs` 에 남긴 최근 호출 N건(기본 20, 최대 50). 종료 코드·stderr·모델 원문까지. 공짜 |
| `browser` | 크롬·엣지 실행 상태(안 떠 있음 / 떠 있음 / 창 없이 백그라운드)와 본체 명령줄, 본체 시작 시각과 등록 시각 비교 |
| `chrome` / `edge` | `browser` 와 같되 한쪽만 |
| `restart [chrome\|edge]` | **창이 없을 때만** 본체를 끝내고 다시 띄운다(본체 명령줄의 인자는 유지, `--no-startup-window` 만 뺌). 창이 있으면 끝내지 않고 닫아 달라고만 한다. 뜬 뒤 본체 시작 시각이 등록 시각 뒤인지 확인해 준다 |
| `shortcut [<폴더>]` | 엣지 전용 프로필(`%LOCALAPPDATA%\KRS-MeetingRoom\Edge`)을 `--load-extension` 으로 띄우는 바로가기를 만든다(기본 바탕화면). `edge://extensions` 클릭 없이 매번 확장이 올라온다. 사용자가 원할 때만 |

## 자동화 경계 (2026-09-16 엣지 153 에서 확인)

| 단계 | 자동? | 근거 |
|:---|:---|:---|
| 다리 등록 (크롬·엣지 키) | O `install` | HKCU 레지스트리 |
| 등록 후 브라우저 재시작 | 창 없을 때만 O `restart` | 창이 있으면 탭을 잃으므로 사람이 닫는다 |
| 일상 프로필에 확장 올리기 | **X** | 기본 프로필은 디버그 포트를 막고(크로미엄 136+), CDP `Extensions.loadUnpacked`·`--load-extension` 은 세션에만 있고 Preferences 에 남지 않으며, Preferences 는 HMAC 보호라 직접 못 쓴다 |
| 전용 프로필로 확장 올리기 | O `shortcut` | 엣지는 `--load-extension` 을 아직 받는다(크롬은 137부터 무시). 로그인·북마크가 따로 생기는 대가 |
| 배지 `연결됨` 확인 | 일상 프로필 X / 전용 프로필은 CDP 로 가능 | 기본 프로필엔 붙을 길이 없다 |
| `id` | 확장 ID 만 계산해 출력 (크롬·엣지 같은 값) |
| `uninstall` | 크롬·엣지 키 둘 다 등록 해제 |
| `help` | 이 표 출력 |

호출: `powershell -ExecutionPolicy Bypass -File <스킬폴더>\bridge_ops.ps1 <인자>`

## 절차

1. **`check`** 를 돌리고 표를 그대로 사용자에게 보인다. 판단은 표 아래 "다음 할 일" 을 따른다.
2. 등록 줄에 `[--]` 가 있으면 **`install`**. ID 를 계산해 두 키에 등록하고 왕복까지 확인한다.
3. 6번이 남으면 **`browser`** 로 상태를 본다. "창 없이 백그라운드" 면 잃을 탭이 없으니 말하고 **`restart`** 를 돌린다.
   창이 있으면 **브라우저를 임의로 끄지 않는다** — 열린 탭이 다 닫히므로 사용자에게 창을 닫아 달라고 하고,
   닫힌 뒤 `restart` 로 남은 본체를 정리하며 다시 띄운다. `restart` 자체가 창이 있으면 거부하므로 실수로 끊길 일은 없다.
4. 등록도 왕복도 정상인데 패널이 여전히 실패하면 **먼저 `log`** 를 본다. 패널에서 실제로 부른
   호출의 종료 코드와 stderr 가 남아 있어 대개 거기서 끝난다(공짜).
   기록이 없거나 부족할 때만 **`test`** 로 로그인을 확인한다(과금 고지 후).

## 기록

- 다리는 `claude` 를 부를 때마다 성패와 상관없이 `native\logs\<날짜>.jsonl` 에 한 줄 남긴다.
  `ping`·`logs` 는 남기지 않는다. 14일이 지난 파일은 다리가 뜰 때 지운다.
- 응답보다 기록을 먼저 쓴다. 응답을 받은 브라우저가 곧바로 다리 프로세스를 끊을 수 있어서다.
- 패널의 `활동 로그 → 로그 복사` 는 확장 기록에 이 파일의 최근 30건을 붙여 준다(`logs` 작업).
- 기록에는 사용자가 입력한 문장과 예약 요약이 들어 있다. **공개 저장소라 `.gitignore` 로 뺐다** —
  `git status` 에 `native/logs` 가 보이면 무시 규칙이 깨진 것이다. 폴더째 복사해 넘길 때는 지운다.

## 새 PC 에 설치

1. `git clone https://github.com/kimghw/meeting_room` — 다른 사람 PC 도 같은 절차다. 코드에 고칠 개인 값은 없다
2. `chrome://extensions` 또는 `edge://extensions` → 개발자 모드 → 압축해제된 확장 로드 → 폴더 선택
3. `install` — 크롬·엣지 키에 한 번에 들어간다 (경로가 이전 PC 와 같으면 ID 도 같다)
4. 브라우저 완전 재시작 → `check` 로 확인

확장에 저장된 것(API 키·탭·시간대·내 이름)은 브라우저 프로필에 있어 **따라가지 않는다.** 크롬과 엣지에
둘 다 불러와도 서로 다른 프로필이라 설정은 따로 간다. 내 이름은 첫 예약 때
자동으로 채워지고, API 키는 다리를 쓰면 필요 없다. `claude` 로그인은 그 PC 에서 각자 한다 —
`.credentials.json` 을 복사해 옮기지 않는다.

## 함정 (겪은 것들)

- **확장 ID 는 폴더 절대경로에서 나온다.** 폴더를 옮기면 ID 가 바뀌고 재등록해야 한다.
  `id` 로 언제든 다시 계산할 수 있다. 다만 이건 공개 API 가 아니라 크로미엄 구현 세부라,
  어긋나면 `chrome://extensions`·`edge://extensions` 의 값을 `install <ID>` 로 넘긴다.
- **크롬·엣지 ID 는 같다.** 같은 폴더면 같은 계산이라 매니페스트 하나를 두 키에 건다. `install` 은 묻지 않고
  둘 다 등록한다 — 설치 안 된 쪽 키는 놀 뿐이다. 두 브라우저에 다 불러와도 등록은 한 번이면 된다.
- **엣지는 창을 다 닫아도 안 죽는다.** "시작 부스트" 와 "Microsoft Edge 가 닫혀 있을 때도 백그라운드 확장 및 앱
  계속 실행" 이 기본으로 켜져 있어 `--no-startup-window` 본체가 남고, 창을 다시 열면 그 본체가 그대로 쓰인다.
  새 등록은 못 읽는다. 작업 관리자에서 `msedge.exe` 를 전부 끝내거나 `edge://settings/system` 에서 둘을 끈다.
  크롬도 "백그라운드 앱 계속 실행" 을 켜 두면 같다. `check`·`browser` 는 창 유무(MainWindowHandle)와
  본체 시작 시각으로 이 상태를 짚는다.
- **`--user-data-dir` 프로필.** 브라우저를 별도 프로필로 띄워 쓰면 기본 프로필만 봐서는 확장을
  찾지 못한다. `bridge_ops.ps1` 은 실행 중인 크롬·엣지 명령줄에서 그 경로를 읽어 함께 뒤진다.
  등록 자체는 `HKCU` 라 프로필과 무관하게 먹는다.
- **PowerShell 5.1 + BOM 없는 UTF-8 = 파싱 에러.** 한글 주석이 ANSI 로 읽혀 스크립트가 깨진다.
  이 폴더와 `native\*.ps1` 은 **UTF-8 BOM** 으로 저장한다. 편집했다면 인코딩을 다시 확인할 것.
- **Node 는 `.bat` 을 직접 spawn 하지 못한다**(24부터, EINVAL). `ping.mjs` 는 브라우저처럼 `cmd /c` 로 띄운다.
- **`host.mjs` 를 import 하면 stdin 을 기다리며 멈춘다.** 불러오기만 할 때는 `KRS_HOST_NO_MAIN=1`
  을 먼저 세운다(`logs.mjs`·`test/host.test.mjs` 가 그렇게 한다). 브라우저가 띄울 때는 이 변수가 없다.
- **"등록 완료" 는 성공이 아니다.** 3·6번은 등록 시점에 확인되지 않는다. 그래서 `install` 이
  끝나자마자 `ping` 을 돌리고, 의심되면 `test` 까지 간다.
