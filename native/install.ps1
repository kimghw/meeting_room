<#
  크롬이 이 확장에서만 로컬 Claude CLI 다리를 열 수 있게 등록한다.

  사용법:
    1) chrome://extensions 에서 이 확장의 ID 를 복사한다
    2) powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId <붙여넣기>
#>
param(
  [Parameter(Mandatory = $true)][string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostName = 'com.krs.meetingroom'
$batPath = Join-Path $here 'claude-bridge.bat'

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
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath

Write-Host ''
Write-Host '등록 완료' -ForegroundColor Green
Write-Host "  호스트   : $hostName"
Write-Host "  매니페스트: $manifestPath"
Write-Host "  확장 ID  : $ExtensionId"
Write-Host ''
Write-Host '크롬을 완전히 종료했다가 다시 열어야 적용됩니다.' -ForegroundColor Yellow
