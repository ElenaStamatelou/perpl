# Launcher for the Perpl SOL volume bot. Refuses to start if this folder's bot
# is already running (a hidden second instance would double-trade the account).
$host.UI.RawUI.WindowTitle = "Perpl SOL bot"
Set-Location $PSScriptRoot

$folder = [regex]::Escape($PSScriptRoot + [IO.Path]::DirectorySeparatorChar)
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $folder }
if ($existing) {
  Write-Host "This bot appears to be running already (node PID $($existing.ProcessId -join ', '))." -ForegroundColor Yellow
  Write-Host "Close the other window first (or kill the process) - two instances would double-trade the account."
  Read-Host "Press Enter to close"
  exit 1
}

npm run bot
