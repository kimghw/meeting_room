$ErrorActionPreference = 'Stop'
$hostName = 'com.krs.meetingroom'

# install.ps1 이 건 두 키를 모두 지운다. 매니페스트 파일은 남겨 둔다 — 다시 install 하면 덮어쓴다.
$keys = @(
  @{ Label = '크롬'; Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName" }
  @{ Label = '엣지'; Key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName" }
)

$removed = 0
foreach ($k in $keys) {
  if (Test-Path $k.Key) {
    Remove-Item -Path $k.Key -Force
    Write-Host "등록 해제 완료: $($k.Label)" -ForegroundColor Green
    $removed++
  }
}
if ($removed -eq 0) { Write-Host '등록되어 있지 않습니다 (크롬·엣지 모두).' }
