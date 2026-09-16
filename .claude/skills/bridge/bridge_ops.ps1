<#
  KRS 회의실 예약 확장 — 로컬 Claude CLI 다리(네이티브 메시징) 설정·진단.

  크롬과 엣지를 같이 본다. 둘은 크로미엄이라 확장 ID 계산, origin 스킴(chrome-extension://),
  매니페스트 형식이 같고, 레지스트리 키·프로필 폴더·프로세스 이름만 다르다. 그 차이는
  아래 $Browsers 표에만 있고 나머지 코드는 표를 돈다.

  등록만으로는 돌지 않는다. 여섯 가지가 다 맞아야 하고 check 가 그걸 한 번에 본다.
  표를 읽는 쪽이 사람이므로 성공/실패를 [OK]/[--] 로만 찍고 판단은 붙이지 않는다.

  사용: powershell -ExecutionPolicy Bypass -File bridge_ops.ps1 <명령> [인자]
#>
param(
  [Parameter(Position = 0)][string]$Command = 'check',
  [Parameter(Position = 1)][string]$Arg
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.krs.meetingroom'

$Browsers = @(
  [pscustomobject]@{
    Key = 'chrome'; Label = '크롬'; Exe = 'chrome.exe'; ExtPage = 'chrome://extensions'
    RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
    UserData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  }
  [pscustomobject]@{
    Key = 'edge'; Label = '엣지'; Exe = 'msedge.exe'; ExtPage = 'edge://extensions'
    RegKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
    UserData = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'
  }
)

function Get-ProjectRoot {
  foreach ($c in @($env:CLAUDE_PROJECT_DIR, (Join-Path (Split-Path -Parent $PSCommandPath) '..\..\..'), '.')) {
    if (-not $c) { continue }
    try { $p = (Resolve-Path $c -ErrorAction Stop).Path } catch { continue }
    if (Test-Path (Join-Path $p 'native\host.mjs')) { return $p }
  }
  throw '프로젝트 루트를 찾지 못했습니다 (native\host.mjs 가 있는 폴더여야 합니다).'
}

<#
  압축해제 확장의 ID 는 랜덤이 아니라 폴더 절대경로에서 나온다.
  크로미엄(crx_file::id_util::GenerateId)이 쓰는 것과 같은 계산 — 경로를 UTF-16LE 로 SHA-256 하고
  앞 16바이트의 hex 를 a~p 로 옮긴다. 윈도우에서는 드라이브 문자만 대문자로 맞춘다.
  크롬과 엣지가 같은 코드를 쓰므로 같은 폴더면 두 브라우저에서 ID 가 같다.

  정식 API 가 아니라 구현 세부라 크로미엄이 바꾸면 틀어질 수 있다. 그래서 install 은
  ID 를 인자로 받는 길을 늘 열어둔다 — chrome://extensions 나 edge://extensions 에서 복사해 넘기면 된다.
#>
function Get-ExtensionId([string]$Path) {
  $p = (Resolve-Path $Path).Path.TrimEnd('\')
  if ($p.Length -ge 2 -and $p[1] -eq ':') { $p = $p.Substring(0, 1).ToUpper() + $p.Substring(1) }
  $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::Unicode.GetBytes($p))
  $hex = ($sha[0..15] | ForEach-Object { $_.ToString('x2') }) -join ''
  -join ($hex.ToCharArray() | ForEach-Object { [char]([int][char]'a' + [Convert]::ToInt32($_.ToString(), 16)) })
}

<# ------------------------------------------------------------ 브라우저 #>

# 설치 여부는 App Paths 로 본다 — 크롬·엣지 설치기가 모두 여기에 적는다(시스템 설치는 HKLM, 사용자 설치는 HKCU).
function Get-BrowserExePath($b) {
  foreach ($hive in 'HKLM:', 'HKCU:') {
    $k = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$($b.Exe)"
    try {
      $p = (Get-ItemProperty $k -ErrorAction Stop).'(default)'
      if ($p -and (Test-Path $p)) { return $p }
    } catch { }
  }
  $null
}

function Get-BrowserProcs($b) {
  @(Get-Process ($b.Exe -replace '\.exe$', '') -ErrorAction SilentlyContinue)
}

# 떠 있는지 여부는 프로세스만으로 모자란다. 엣지는 시작 부스트, 크롬은 "백그라운드 앱 계속 실행" 이
# 켜져 있으면 창을 다 닫아도 본체가 남는다. 창이 있는 프로세스가 하나라도 있으면 on, 없이 떠 있으면 background.
function Get-BrowserState($b) {
  $procs = Get-BrowserProcs $b
  if ($procs.Count -eq 0) { return 'off' }
  if (@($procs | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0) { return 'on' }
  'background'
}

# 가장 먼저 뜬 프로세스가 본체다. 이 시각이 등록(매니페스트 파일 시각)보다 앞이면 새 등록을 모른다.
function Get-BrowserStart($b) {
  $t = $null
  foreach ($p in (Get-BrowserProcs $b)) {
    try { if (-not $t -or $p.StartTime -lt $t) { $t = $p.StartTime } } catch { }
  }
  $t
}

function Get-BrowserCmdLines($b) {
  try {
    @(Get-CimInstance Win32_Process -Filter "Name='$($b.Exe)'" -ErrorAction Stop | Select-Object -ExpandProperty CommandLine)
  } catch { @() }
}

# 렌더러·GPU 등 자식 프로세스는 --type= 을 달고 있다. 다시 띄울 때 쓸 것은 본체뿐이다.
function Get-BrowserMainLines($b) {
  @(Get-BrowserCmdLines $b) |
    Where-Object { $_ -and $_ -notmatch '--type=' -and $_ -notmatch '--single-argument' } |
    Select-Object -Unique
}

function Get-InstalledBrowsers {
  @($Browsers | Where-Object { (Get-BrowserExePath $_) -or ((Get-BrowserState $_) -ne 'off') })
}

# shortcut 명령이 만드는 전용 프로필 자리. 엣지만 쓴다.
$DedicatedProfile = Join-Path $env:LOCALAPPDATA 'KRS-MeetingRoom\Edge'

# 브라우저를 --user-data-dir 로 따로 띄워 쓰는 경우가 흔하다. 기본 프로필만 보면 확장을 못 찾는다.
function Get-UserDataDirs($b) {
  $dirs = @()
  if (Test-Path $b.UserData) { $dirs += $b.UserData }
  if ($b.Key -eq 'edge' -and (Test-Path $DedicatedProfile)) { $dirs += $DedicatedProfile }
  foreach ($c in (Get-BrowserCmdLines $b)) {
    if ($c -match '--user-data-dir=(?:"([^"]+)"|([^\s"]+))') {
      $d = if ($matches[1]) { $matches[1] } else { $matches[2] }
      if ((Test-Path $d) -and ($dirs -notcontains $d)) { $dirs += $d }
    }
  }
  $dirs
}

# 확장이 열린 적 있는 프로필을 브라우저마다 찾는다. 두 브라우저에 다 불러왔으면 둘 다 나온다.
function Find-LoadedExtension([string]$Id) {
  $found = @()
  foreach ($b in $Browsers) {
    foreach ($udd in (Get-UserDataDirs $b)) {
      foreach ($prof in (Get-ChildItem $udd -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile*' })) {
        if (Test-Path (Join-Path $prof.FullName "Local Extension Settings\$Id")) {
          $found += "$($b.Label) $udd\$($prof.Name)"
        }
      }
    }
  }
  $found
}

# 등록 시각. install.ps1 이 등록이 바뀔 때 키에 RegisteredAt 값을 남긴다(크로미엄은 기본값만 읽으므로 무해).
# 예전 등록에는 이 값이 없다 — 그때는 매니페스트 파일 시각으로 대신한다.
function Get-RegisteredTime($b) {
  try {
    $v = (Get-ItemProperty $b.RegKey -ErrorAction Stop).RegisteredAt
    if ($v) { return [datetime]::Parse($v) }
  } catch { }
  $mf = Join-Path (Get-ProjectRoot) "native\$HostName.json"
  if (Test-Path $mf) { (Get-Item $mf).LastWriteTime } else { $null }
}

# 재시작이 정말 필요한지 — 브라우저 본체가 등록 전에 떴는지로 판단한다. "혹시 모르니 재시작" 은 말하지 않는다.
function Get-RestartAdvice($b) {
  $state = Get-BrowserState $b
  if ($state -eq 'off') { return '안 떠 있음 — 열면 등록이 반영됩니다. 패널에서 배지가 [연결됨] 인지 보세요' }
  $bg = if ($state -eq 'background') { ' (창은 없고 백그라운드 본체만 남아 있음)' } else { '' }
  $started = Get-BrowserStart $b
  $mfTime = Get-RegisteredTime $b
  if (-not $started -or -not $mfTime -or $started -ge $mfTime) {
    return "등록 뒤에 뜬 프로세스라 재시작 필요 없음$bg. 패널에서 배지가 [연결됨] 인지 보세요"
  }
  $when = "등록($($mfTime.ToString('HH:mm:ss'))) 전인 $($started.ToString('HH:mm:ss')) 에 뜬"
  if ($state -eq 'background') {
    return "$when 본체가 창 없이 남아 있습니다. 열린 탭이 없으니 'restart $($b.Key)' 가 끝내고 다시 띄웁니다"
  }
  $how = if ($b.Key -eq 'edge') {
    "창을 모두 닫은 뒤 'restart edge' 로 마무리하세요 — 엣지는 창을 닫아도 시작 부스트로 본체가 남는데 그걸 정리하고 다시 띄웁니다 (매번 남는 게 싫으면 edge://settings/system 에서 시작 부스트·백그라운드 실행 끄기)."
  } else {
    "창을 모두 닫은 뒤 'restart chrome' 으로 마무리하세요 — 남은 chrome.exe 를 정리하고 다시 띄웁니다."
  }
  "$when 프로세스라 완전히 종료했다 다시 열어야 합니다. $how"
}

<# ------------------------------------------------------------ 명령 #>

function Write-Row([string]$Label, [bool]$Ok, [string]$Detail) {
  $mark = if ($Ok) { '[OK]' } else { '[--]' }
  Write-Output ("  {0} {1,-16} {2}" -f $mark, $Label, $Detail)
}

function Invoke-Check {
  $root = Get-ProjectRoot
  $id = Get-ExtensionId $root
  Write-Output "프로젝트 : $root"
  Write-Output "확장 ID  : $id  (경로에서 계산 — 크롬·엣지 같은 값)"
  Write-Output ''

  $node = Get-Command node -ErrorAction SilentlyContinue
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  Write-Row 'node' ($null -ne $node) $(if ($node) { $node.Source } else { 'PATH 에 없음' })
  Write-Row 'claude' ($null -ne $claude) $(if ($claude) { $claude.Source } else { 'PATH 에 없음' })

  # claude 가 PATH 에 있는 것과 쓸 수 있는 상태인 것은 다르다. 토큰 파일 존재만 본다
  # (내용은 읽지 않는다). 확실한 판정은 test 명령이 실제 호출로 한다.
  $cred = Join-Path $env:USERPROFILE '.claude\.credentials.json'
  $hasKey = [bool]$env:ANTHROPIC_API_KEY
  Write-Row '로그인' ((Test-Path $cred) -or $hasKey) $(
    if (Test-Path $cred) { '.claude\.credentials.json 있음' }
    elseif ($hasKey) { 'ANTHROPIC_API_KEY 환경변수' }
    else { 'claude login 필요 (추정 — test 로 확인)' })

  $bat = Join-Path $root 'native\claude-bridge.bat'
  $hostFile = Join-Path $root 'native\host.mjs'
  Write-Row '다리 파일' ((Test-Path $bat) -and (Test-Path $hostFile)) 'claude-bridge.bat + host.mjs'

  # 등록은 설치된 브라우저마다 따로 본다. 안 깔린 브라우저 줄은 찍지 않는다 — 실패처럼 보일 뿐이다.
  $installed = Get-InstalledBrowsers
  if ($installed.Count -eq 0) { Write-Row '브라우저' $false '크롬도 엣지도 찾지 못함 (App Paths 에 없고 떠 있지도 않음)' }
  $regOk = @{}
  foreach ($b in $installed) {
    $ok = $false
    $detail = '등록 안 됨 — install 필요'
    if (Test-Path $b.RegKey) {
      $mf = (Get-ItemProperty $b.RegKey).'(default)'
      if ($mf -and (Test-Path $mf)) {
        $j = [System.IO.File]::ReadAllText($mf, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $origin = @($j.allowed_origins)[0]
        if ($origin -match $id) { $ok = $true; $detail = '매니페스트 + ID 일치' }
        else { $detail = "ID 불일치! 등록된 것: $origin" }
      } else { $detail = "레지스트리는 있는데 매니페스트가 없음: $mf" }
    }
    $regOk[$b.Key] = $ok
    Write-Row "등록($($b.Label))" $ok $detail
  }

  $where = @(Find-LoadedExtension $id)
  Write-Row '확장 로드' ($where.Count -gt 0) $(if ($where.Count -gt 0) { $where -join ' / ' } else { '어느 프로필에서도 흔적 없음 (한 번도 안 열었을 수도)' })

  Write-Output ''
  Write-Output '다음 할 일:'
  if (-not $node -or -not $claude) { Write-Output '  - node / claude 를 설치하고 PATH 에 넣으세요'; return }
  if ($installed.Count -eq 0) { Write-Output '  - 크롬이나 엣지를 설치하세요'; return }
  $missing = @($installed | Where-Object { -not $regOk[$_.Key] })
  if ($missing.Count -gt 0) {
    Write-Output "  - install 로 등록하세요 (크롬·엣지 키에 한 번에 들어갑니다). 지금 빠진 곳: $(($missing | ForEach-Object { $_.Label }) -join ', ')"
    return
  }
  foreach ($b in $installed) {
    $loaded = @($where | Where-Object { $_ -like "$($b.Label) *" }).Count -gt 0
    if (-not $loaded) { Write-Output "  - $($b.Label): $($b.ExtPage) → 개발자 모드 → 압축해제된 확장 로드 → $root" }
    Write-Output "  - $($b.Label): $(Get-RestartAdvice $b)"
  }
  Write-Output '  - 그래도 안 되면 log 로 다리 기록을, test 로 claude 호출까지 확인하세요'
}

function Invoke-Install {
  $root = Get-ProjectRoot
  $id = if ($Arg) { $Arg } else { Get-ExtensionId $root }
  if (-not $Arg) { Write-Output "확장 ID 를 경로에서 계산했습니다: $id" }
  & powershell -ExecutionPolicy Bypass -File (Join-Path $root 'native\install.ps1') -ExtensionId $id
  if ($LASTEXITCODE -ne 0) { throw '등록에 실패했습니다.' }
  Write-Output ''
  Write-Output '다리 왕복 확인:'
  & node (Join-Path (Split-Path -Parent $PSCommandPath) 'ping.mjs') $root
}

# 실행 상태와 본체 명령줄. 끄지는 않는다 — 열린 탭이 있을 수 있어 사람이 결정한다.
function Invoke-Browser([string]$Only) {
  $list = if ($Only) { @($Browsers | Where-Object { $_.Key -eq $Only }) } else { $Browsers }
  foreach ($b in $list) {
    $state = Get-BrowserState $b
    $desc = switch ($state) {
      'off' { '안 떠 있음 — 그냥 열면 등록이 반영됩니다' }
      'background' { '창 없이 백그라운드로만 떠 있음' }
      default { '떠 있음' }
    }
    $exe = Get-BrowserExePath $b
    $where = if ($exe) { "  [$exe]" } else { '  [App Paths 에 없음]' }
    Write-Output "$($b.Label) ($($b.Exe)): $desc$where"
    foreach ($l in (Get-BrowserMainLines $b)) { Write-Output "  $l" }
    if ($state -ne 'off') {
      $started = Get-BrowserStart $b
      $mfTime = Get-RegisteredTime $b
      $reg = if ($mfTime) { "  / 등록: $($mfTime.ToString('yyyy-MM-dd HH:mm:ss'))" } else { '' }
      if ($started) { Write-Output "  본체 시작: $($started.ToString('yyyy-MM-dd HH:mm:ss'))$reg" }
      if ($started -and $mfTime -and $started -lt $mfTime) { Write-Output '  → 등록 전에 뜬 본체입니다. 완전히 끝내고 다시 열어야 등록을 읽습니다.' }
    }
    if ($state -eq 'background') {
      Write-Output "  이 본체는 창을 열어도 그대로 이어 쓰입니다. 열린 탭은 없으니 'restart $($b.Key)' 로 끝내고 다시 띄워도 잃는 것이 없습니다."
      if ($b.Key -eq 'edge') { Write-Output '  매번 남는 게 싫으면 edge://settings/system 에서 "시작 부스트" 와 "백그라운드 확장 및 앱 계속 실행" 을 끄세요.' }
    }
    Write-Output ''
  }
  Write-Output "restart 는 창이 없을 때만 끝내고 다시 띄웁니다. 본체 명령줄의 인자(--user-data-dir 등)는 그대로 넘기고 --no-startup-window 만 뺍니다."
}

# 본체 명령줄에서 다시 띄울 때 넘길 인자만 남긴다. 실행 파일 경로와 --no-startup-window 는 뺀다.
function Get-RelaunchArgs([string]$Line) {
  $rest = $Line -replace '^\s*(?:"[^"]+"|\S+)\s*', ''
  $rest = $rest -replace '(^|\s)--no-startup-window(?=\s|$)', ' '
  $rest.Trim()
}

# 창이 없을 때만 끝내고 다시 띄운다. 창이 있으면 탭을 잃으므로 사람이 닫는다 — 여기서 강제로 끄는 길은 두지 않는다.
function Invoke-Restart([string]$Only) {
  $list = if ($Only) { @($Browsers | Where-Object { $_.Key -eq $Only }) } else { Get-InstalledBrowsers }
  if ($list.Count -eq 0) { Write-Output "그런 브라우저가 없습니다: $Only (chrome | edge)"; return }
  foreach ($b in $list) {
    $exe = Get-BrowserExePath $b
    if (-not $exe) { Write-Output "$($b.Label): 설치돼 있지 않음"; continue }
    $state = Get-BrowserState $b
    if ($state -eq 'on') {
      $n = @(Get-BrowserProcs $b | Where-Object { $_.MainWindowHandle -ne 0 }).Count
      Write-Output "$($b.Label): 창 ${n}개가 열려 있어 끝내지 않습니다. 창을 모두 닫은 뒤 다시 'restart $($b.Key)' 하세요 — 창을 닫아도 남는 본체는 그때 정리합니다."
      continue
    }
    $relaunch = ''
    if ($state -eq 'background') {
      $main = @(Get-BrowserMainLines $b)
      if ($main.Count -gt 0) { $relaunch = Get-RelaunchArgs $main[0] }
      Get-BrowserProcs $b | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
      Write-Output "$($b.Label): 창 없는 본체를 끝냈습니다 (남은 프로세스 $(@(Get-BrowserProcs $b).Count)개)"
    }
    if ($relaunch) { Start-Process -FilePath $exe -ArgumentList $relaunch | Out-Null } else { Start-Process -FilePath $exe | Out-Null }
    Start-Sleep -Seconds 3
    $started = Get-BrowserStart $b
    $reg = Get-RegisteredTime $b
    $reads = $started -and (-not $reg -or $started -ge $reg)
    $stamp = if ($started) { $started.ToString('HH:mm:ss') } else { '?' }
    $with = if ($relaunch) { ", 인자: $relaunch" } else { '' }
    $tail = if ($reads) { ' — 이제 등록을 읽습니다. 패널의 설정 및 연결에서 배지를 보세요' } else { '' }
    Write-Output "$($b.Label): 다시 띄웠습니다 (본체 시작 $stamp$with)$tail"
  }
}

<#
  edge://extensions 의 "압축해제 로드" 클릭은 프로그램으로 대신할 수 없다 — 기본 프로필은 디버그 포트를
  막고(크로미엄 136+), CDP Extensions.loadUnpacked 나 --load-extension 으로 올린 확장은 그 세션에만 있고
  Preferences 에 남지 않으며(2026-09-16 엣지 153 에서 확인), Preferences 는 HMAC 으로 보호돼 직접 쓸 수 없다.
  그래서 클릭 없는 길은 하나뿐이다: 전용 프로필을 --load-extension 으로 매번 띄우는 바로가기.
  엣지는 이 플래그를 아직 받는다(크롬은 137부터 무시). 대신 eclass 로그인·북마크가 그 프로필에 따로 생긴다.
  다리 등록은 HKCU 라 프로필과 무관하고, 확장 ID 도 같은 폴더라 같다.
#>
function Invoke-Shortcut([string]$Dir) {
  $b = $Browsers | Where-Object { $_.Key -eq 'edge' }
  $exe = Get-BrowserExePath $b
  if (-not $exe) { Write-Output '엣지가 설치돼 있지 않습니다.'; return }
  $root = Get-ProjectRoot
  $outDir = if ($Dir) { $Dir } else { [Environment]::GetFolderPath('Desktop') }
  if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force $outDir | Out-Null }
  $lnk = Join-Path $outDir 'KRS 회의실 예약 (엣지).lnk'
  $arguments = "--user-data-dir=`"$DedicatedProfile`" --load-extension=`"$root`""
  # WScript.Shell 은 경로를 ANSI 로 바꿔 쓰므로 시스템 로캘이 영어면 한글 파일명에서 실패한다. IShellLinkW 는 유니코드다.
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
class ShellLinkCoClass { }
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, int fFlags);
  void GetIDList(out IntPtr ppidl);
  void SetIDList(IntPtr pidl);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
  void GetHotkey(out short pwHotkey);
  void SetHotkey(short wHotkey);
  void GetShowCmd(out int piShowCmd);
  void SetShowCmd(int iShowCmd);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
  void Resolve(IntPtr hwnd, int fFlags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}
public static class KrsShortcut {
  public static void Create(string lnk, string target, string args, string workDir, string icon, string desc) {
    var link = (IShellLinkW)new ShellLinkCoClass();
    link.SetPath(target);
    link.SetArguments(args);
    link.SetWorkingDirectory(workDir);
    link.SetIconLocation(icon, 0);
    link.SetDescription(desc);
    ((IPersistFile)link).Save(lnk, false);
  }
  public static string[] Read(string lnk) {
    var link = (IShellLinkW)new ShellLinkCoClass();
    ((IPersistFile)link).Load(lnk, 0);
    var sb = new StringBuilder(2048);
    link.GetPath(sb, sb.Capacity, IntPtr.Zero, 0);
    var target = sb.ToString();
    sb.Length = 0;
    link.GetArguments(sb, sb.Capacity);
    return new string[] { target, sb.ToString() };
  }
}
'@
  [KrsShortcut]::Create($lnk, $exe, $arguments, (Split-Path $exe), $exe, 'KRS 회의실 예약 확장을 전용 프로필로 띄운다')
  $back = [KrsShortcut]::Read($lnk)
  Write-Output "바로가기: $lnk"
  Write-Output "  대상  : $($back[0])"
  Write-Output "  인자  : $($back[1])"
  Write-Output "  프로필: $DedicatedProfile (처음 열면 eclass 에 한 번 로그인해야 합니다)"
  Write-Output '  확장 ID 는 같은 폴더라 같고, 다리 등록(HKCU)도 그대로 먹습니다. edge://extensions 클릭은 필요 없습니다.'
}

switch ($Command.ToLower()) {
  'id' { Get-ExtensionId $(if ($Arg) { $Arg } else { Get-ProjectRoot }) }
  'check' { Invoke-Check }
  'install' { Invoke-Install }
  'ping' { & node (Join-Path (Split-Path -Parent $PSCommandPath) 'ping.mjs') (Get-ProjectRoot) }
  'test' { & node (Join-Path (Split-Path -Parent $PSCommandPath) 'ping.mjs') (Get-ProjectRoot) '--parse' }
  'log' { & node (Join-Path (Split-Path -Parent $PSCommandPath) 'logs.mjs') (Get-ProjectRoot) $(if ($Arg) { $Arg } else { '20' }) }
  'uninstall' { & powershell -ExecutionPolicy Bypass -File (Join-Path (Get-ProjectRoot) 'native\uninstall.ps1') }
  'browser' { Invoke-Browser '' }
  'chrome' { Invoke-Browser 'chrome' }
  'edge' { Invoke-Browser 'edge' }
  'restart' { Invoke-Restart $(if ($Arg) { $Arg.ToLower() } else { '' }) }
  'shortcut' { Invoke-Shortcut $Arg }
  default { Write-Output '명령: id | check | install [<ID>] | ping | test | log [<건수>] | uninstall | browser | chrome | edge | restart [chrome|edge] | shortcut [<폴더>]' }
}
