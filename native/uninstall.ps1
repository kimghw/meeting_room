$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.krs.meetingroom'
if (Test-Path $key) { Remove-Item -Path $key -Force; Write-Host '등록 해제 완료' -ForegroundColor Green }
else { Write-Host '등록되어 있지 않습니다.' }
