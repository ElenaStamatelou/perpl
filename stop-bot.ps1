# Stop switch for the Perpl SOL volume bot: kills this folder's bot processes,
# then closes any stranded position (kills can leave a just-filled open position
# behind - closing the terminal window is NOT a reliable stop on Windows).
$host.UI.RawUI.WindowTitle = "Stop Perpl SOL bot"
Set-Location $PSScriptRoot

$folder = [regex]::Escape($PSScriptRoot + [IO.Path]::DirectorySeparatorChar)
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $folder }
if ($procs) {
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
  Write-Host "Killed bot processes: $($procs.ProcessId -join ', ')"
  Start-Sleep -Seconds 2
} else {
  Write-Host "No bot processes running for this folder."
}

Write-Host "Cancelling any working orders and closing any stranded position..."
npx tsx scripts/flatten.ts

Read-Host "Done - press Enter to close this window"
