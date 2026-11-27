param([int]$ParentPid,[string]$Target,[string]$Replacement,[string]$Container,[string]$ProfileRoot,[string]$Transaction,[string]$Ticket)
$ErrorActionPreference='Stop'
$Target=[IO.Path]::GetFullPath($Target)
$Container=[IO.Path]::GetFullPath($Container)
if ((Split-Path $Container -Parent) -ne (Split-Path $Target -Parent) -or (Split-Path $Container -Leaf) -notlike '.syncvault-update-*' -or [IO.Path]::GetFullPath($Replacement) -ne (Join-Path $Container 'new')) { throw 'Invalid staging directory' }
$backup=Join-Path $Container 'previous'
$program='Sync Vault.exe'
Set-Content -LiteralPath (Join-Path $Transaction 'started') -Value $Ticket -Encoding ASCII
Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
if ((Get-Content -LiteralPath (Join-Path $Transaction 'commit') -Raw -ErrorAction SilentlyContinue) -ne $Ticket) { exit 2 }
try {
  Move-Item -LiteralPath $Target -Destination $backup
  Move-Item -LiteralPath $Replacement -Destination $Target
  $env:SYNC_VAULT_HEALTH=$Transaction
  $env:SYNC_VAULT_TICKET=$Ticket
  $app=Start-Process -FilePath (Join-Path $Target $program) -ArgumentList ('"--user-data-dir='+$ProfileRoot+'"') -PassThru -WorkingDirectory $Target
  $deadline=[DateTime]::UtcNow.AddSeconds(90)
  while ($true) {
    if ((Get-Content -LiteralPath (Join-Path $Transaction 'healthy') -Raw -ErrorAction SilentlyContinue) -eq $Ticket) {
      if ([IO.Path]::GetFullPath($backup) -eq (Join-Path $Container 'previous')) { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue }
      foreach ($name in 'update.zip','state.json','state.json.bak') {
        Remove-Item -LiteralPath (Join-Path $Transaction $name) -Force -ErrorAction SilentlyContinue
      }
      Set-Content -LiteralPath (Join-Path $Transaction 'complete') -Value $Ticket
      exit 0
    }
    if ($app.HasExited) { break }
    if ([DateTime]::UtcNow -gt $deadline) { $app.Kill(); $app.WaitForExit(); break }
    Start-Sleep -Milliseconds 500
  }
  throw 'New application exited before startup completed'
} catch {
  if (Test-Path -LiteralPath $backup) {
    if (Test-Path -LiteralPath $Target) { Move-Item -LiteralPath $Target -Destination (Join-Path $Container 'failed') }
    Move-Item -LiteralPath $backup -Destination $Target
    foreach ($name in 'state.json','state.json.bak') {
      $saved=Join-Path $Transaction $name
      if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination (Join-Path $ProfileRoot $name) -Force }
    }
    Remove-Item Env:SYNC_VAULT_HEALTH -ErrorAction SilentlyContinue
    Remove-Item Env:SYNC_VAULT_TICKET -ErrorAction SilentlyContinue
    Start-Process -FilePath (Join-Path $Target $program) -ArgumentList ('"--user-data-dir='+$ProfileRoot+'"') -WorkingDirectory $Target
  }
  Set-Content -LiteralPath (Join-Path $Transaction 'failed.txt') -Value 'Update rolled back'
  exit 1
}

