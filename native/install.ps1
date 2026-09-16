<#
  브라우저(크롬·엣지)가 이 확장에서만 로컬 Claude CLI 다리를 열 수 있게 등록한다.

  크롬과 엣지는 매니페스트 형식과 origin(chrome-extension://…)이 같고 레지스트리 키만 다르다.
  같은 폴더에서 불러오면 확장 ID 도 같으므로 매니페스트 하나를 두 키에 같이 건다.
  설치되지 않은 브라우저의 키는 놀 뿐 해가 없다 — 그래서 묻지 않고 둘 다 등록한다.

  사용법:
    1) chrome://extensions 또는 edge://extensions 에서 이 확장의 ID 를 복사한다
    2) powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId <붙여넣기>
#>
param(
  [Parameter(Mandatory = $true)][string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostName = 'com.krs.meetingroom'
$batPath = Join-Path $here 'claude-bridge.bat'

if ($ExtensionId -notmatch '^[a-p]{32}$') { throw "확장 ID 모양이 아닙니다 (a~p 32글자): $ExtensionId" }
if (-not (Test-Path $batPath)) { throw "claude-bridge.bat 을 찾을 수 없습니다: $batPath" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node 가 PATH 에 없습니다.' }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw 'claude CLI 가 PATH 에 없습니다.' }

$manifest = [ordered]@{
  name           = $hostName
  description    = 'KRS 회의실 예약 - 로컬 Claude CLI 다리'
  path           = $batPath
  type           = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$manifestPath = Join-Path $here "$hostName.json"
$json = $manifest | ConvertTo-Json -Depth 4
# 내용이 같으면 다시 쓰지 않는다 — 파일 시각이 "등록이 바뀐 때" 로 남아야 재시작 판단에 쓸 수 있다.
$old = if (Test-Path $manifestPath) { [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) } else { '' }
$changed = ($old -ne $json)
if ($changed) { [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false))) }

# 브라우저마다 읽는 키가 다르다. 매니페스트는 하나, 키는 둘.
$targets = @(
  @{ Label = '크롬'; Exe = 'chrome.exe'; Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName" }
  @{ Label = '엣지'; Exe = 'msedge.exe'; Key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName" }
)

# 설치 여부는 안내에만 쓴다. 안 깔렸어도 키는 건다 — 나중에 깔면 그대로 먹는다.
function Test-Installed([string]$Exe) {
  foreach ($hive in 'HKLM:', 'HKCU:') {
    try {
      $p = (Get-ItemProperty "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$Exe" -ErrorAction Stop).'(default)'
      if ($p -and (Test-Path $p)) { return $true }
    } catch { }
  }
  $false
}

$lines = @()
$anyBumped = $false
foreach ($t in $targets) {
  $isNew = -not (Test-Path $t.Key)
  if ($isNew) { New-Item -Path $t.Key -Force | Out-Null }
  $prev = if ($isNew) { $null } else { (Get-ItemProperty $t.Key).'(default)' }
  Set-ItemProperty -Path $t.Key -Name '(default)' -Value $manifestPath
  # 등록이 실제로 바뀐 때만 시각을 남긴다. 브라우저 본체가 이보다 먼저 떴으면 다시 떠야 한다.
  # 크로미엄은 키의 기본값만 읽으므로 값을 하나 더 두어도 무해하다.
  $bumped = $isNew -or ($prev -ne $manifestPath) -or $changed
  if ($bumped) { Set-ItemProperty -Path $t.Key -Name 'RegisteredAt' -Value (Get-Date).ToString('o'); $anyBumped = $true }
  $state = if ($bumped) { '새로 등록' } else { '이미 같은 등록' }
  $note = if (Test-Installed $t.Exe) { '' } else { ' (설치 안 된 것으로 보임 — 키만 걸어 둠)' }
  $lines += "  $($t.Label)     : $state$note  $($t.Key)"
}

Write-Host ''
Write-Host '등록 완료' -ForegroundColor Green
Write-Host "  호스트   : $hostName"
Write-Host "  매니페스트: $manifestPath"
Write-Host "  확장 ID  : $ExtensionId"
foreach ($l in $lines) { Write-Host $l }
Write-Host ''
if ($anyBumped) {
  Write-Host '새로 등록된 브라우저는 완전히 종료했다가 다시 열어야 적용됩니다.' -ForegroundColor Yellow
  Write-Host '엣지는 창을 다 닫아도 시작 부스트로 msedge.exe 가 남습니다 — 작업 관리자에 없어야 다시 뜬 것입니다.'
} else {
  Write-Host '등록이 바뀌지 않았으므로 브라우저를 다시 열 필요는 없습니다.'
}
