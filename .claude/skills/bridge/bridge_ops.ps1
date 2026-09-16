<#
  KRS 회의실 예약 확장 — 로컬 Claude CLI 다리(네이티브 메시징) 설정·진단.

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
$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

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
  크롬(crx_file::id_util::GenerateId)이 쓰는 것과 같은 계산 — 경로를 UTF-16LE 로 SHA-256 하고
  앞 16바이트의 hex 를 a~p 로 옮긴다. 윈도우에서는 드라이브 문자만 대문자로 맞춘다.

  정식 API 가 아니라 구현 세부라 크롬이 바꾸면 틀어질 수 있다. 그래서 install 은
  ID 를 인자로 받는 길을 늘 열어둔다 — chrome://extensions 에서 복사해 넘기면 된다.
#>
function Get-ExtensionId([string]$Path) {
  $p = (Resolve-Path $Path).Path.TrimEnd('\')
  if ($p.Length -ge 2 -and $p[1] -eq ':') { $p = $p.Substring(0, 1).ToUpper() + $p.Substring(1) }
  $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::Unicode.GetBytes($p))
  $hex = ($sha[0..15] | ForEach-Object { $_.ToString('x2') }) -join ''
  -join ($hex.ToCharArray() | ForEach-Object { [char]([int][char]'a' + [Convert]::ToInt32($_.ToString(), 16)) })
}

function Get-ChromeCmdLines {
  try { Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop | Select-Object -ExpandProperty CommandLine } catch { @() }
}

# 크롬을 --user-data-dir 로 따로 띄워 쓰는 경우가 흔하다. 기본 프로필만 보면 확장을 못 찾는다.
function Get-UserDataDirs {
  $dirs = @()
  $def = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  if (Test-Path $def) { $dirs += $def }
  foreach ($c in (Get-ChromeCmdLines)) {
    if ($c -match '--user-data-dir=(?:"([^"]+)"|([^\s"]+))') {
      $d = if ($matches[1]) { $matches[1] } else { $matches[2] }
      if ((Test-Path $d) -and ($dirs -notcontains $d)) { $dirs += $d }
    }
  }
  $dirs
}

function Find-LoadedExtension([string]$Id) {
  foreach ($udd in (Get-UserDataDirs)) {
    foreach ($prof in (Get-ChildItem $udd -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile*' })) {
      if (Test-Path (Join-Path $prof.FullName "Local Extension Settings\$Id")) {
        return "$udd\$($prof.Name)"
      }
    }
  }
  $null
}

function Write-Row([string]$Label, [bool]$Ok, [string]$Detail) {
  $mark = if ($Ok) { '[OK]' } else { '[--]' }
  Write-Output ("  {0} {1,-16} {2}" -f $mark, $Label, $Detail)
}

function Invoke-Check {
  $root = Get-ProjectRoot
  $id = Get-ExtensionId $root
  Write-Output "프로젝트 : $root"
  Write-Output "확장 ID  : $id  (경로에서 계산)"
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

  $regOk = $false
  $detail = '등록 안 됨 — install 필요'
  if (Test-Path $RegKey) {
    $mf = (Get-ItemProperty $RegKey).'(default)'
    if (Test-Path $mf) {
      $j = [System.IO.File]::ReadAllText($mf, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
      $origin = @($j.allowed_origins)[0]
      if ($origin -match $id) { $regOk = $true; $detail = "매니페스트 + ID 일치" }
      else { $detail = "ID 불일치! 등록된 것: $origin" }
    } else { $detail = "레지스트리는 있는데 매니페스트가 없음: $mf" }
  }
  Write-Row '다리 등록' $regOk $detail

  $where = Find-LoadedExtension $id
  Write-Row '확장 로드' ($null -ne $where) $(if ($where) { $where } else { '어느 프로필에서도 흔적 없음 (한 번도 안 열었을 수도)' })

  $running = @(Get-ChromeCmdLines).Count -gt 0
  Write-Output ''
  Write-Output '다음 할 일:'
  if (-not $node -or -not $claude) { Write-Output '  - node / claude 를 설치하고 PATH 에 넣으세요'; return }
  if (-not $regOk) { Write-Output '  - install 로 등록하세요'; return }
  if ($running) { Write-Output '  - 크롬을 완전히 종료했다 다시 여세요 (등록은 크롬이 뜰 때 한 번만 읽습니다). chrome 명령으로 재시작 명령을 뽑을 수 있습니다' }
  else { Write-Output '  - 크롬을 열고 패널에서 배지가 [연결됨] 인지 보세요' }
  Write-Output '  - 그래도 안 되면 test 로 claude 호출까지 확인하세요'
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

function Invoke-Chrome {
  # 렌더러·GPU 등 자식 프로세스는 --type= 을 달고 있다. 다시 띄울 때 쓸 것은 본체뿐이다.
  $lines = @(Get-ChromeCmdLines) |
    Where-Object { $_ -and $_ -notmatch '--type=' -and $_ -notmatch '--single-argument' } |
    Select-Object -Unique
  if ($lines.Count -eq 0) { Write-Output '실행 중인 크롬이 없습니다. 그냥 열면 등록이 반영됩니다.'; return }
  Write-Output '실행 중인 크롬(본체):'
  foreach ($l in $lines) { Write-Output "  $l" }
  Write-Output ''
  Write-Output '위 명령줄 그대로 다시 띄우면 프로필과 옵션이 유지됩니다.'
  Write-Output '(--user-data-dir 를 쓰고 있다면 그 인자를 빠뜨리면 다른 프로필로 열립니다)'
}

switch ($Command.ToLower()) {
  'id' { Get-ExtensionId $(if ($Arg) { $Arg } else { Get-ProjectRoot }) }
  'check' { Invoke-Check }
  'install' { Invoke-Install }
  'ping' { & node (Join-Path (Split-Path -Parent $PSCommandPath) 'ping.mjs') (Get-ProjectRoot) }
  'test' { & node (Join-Path (Split-Path -Parent $PSCommandPath) 'ping.mjs') (Get-ProjectRoot) '--parse' }
  'log' { & node (Join-Path (Split-Path -Parent $PSCommandPath) 'logs.mjs') (Get-ProjectRoot) $(if ($Arg) { $Arg } else { '20' }) }
  'uninstall' { & powershell -ExecutionPolicy Bypass -File (Join-Path (Get-ProjectRoot) 'native\uninstall.ps1') }
  'chrome' { Invoke-Chrome }
  default { Write-Output '명령: id | check | install [<ID>] | ping | test | log [<건수>] | uninstall | chrome' }
}
