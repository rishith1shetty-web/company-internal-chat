<#
  Stop the isolated test database started by deploy\test-db-up.ps1.

      powershell -ExecutionPolicy Bypass -File deploy\test-db-down.ps1
      powershell -ExecutionPolicy Bypass -File deploy\test-db-down.ps1 -Remove

  Stops only the process whose PID this script recorded — it never searches for "a postgres" and
  never touches the production service. `-Remove` also deletes the cluster's data directory, so
  the next start is a fresh database.
#>

[CmdletBinding()]
param(
    [string]$Root = 'C:\company-chat-devdb',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$pidFile = Join-Path $Root 'server.pid'

if (-not (Test-Path $pidFile)) {
    Write-Host "Nothing to stop: no PID file at $pidFile"
} else {
    $recorded = Get-Content $pidFile -ErrorAction SilentlyContinue
    $process = if ($recorded) { Get-Process -Id $recorded -ErrorAction SilentlyContinue } else { $null }

    if ($process) {
        # Checked before stopping. A recycled PID belonging to something else must not be killed
        # because a stale file happens to name it.
        if ($process.ProcessName -ne 'postgres') {
            throw "PID $recorded is '$($process.ProcessName)', not postgres. Refusing to stop it."
        }
        Stop-Process -Id $recorded -Force
        Start-Sleep -Seconds 2
        Write-Host "stopped the test cluster (pid $recorded)"
    } else {
        Write-Host "not running (stale PID file)"
    }

    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

if ($Remove -and (Test-Path $Root)) {
    Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $Root) { Write-Host "WARN  could not fully remove $Root" }
    else { Write-Host "removed $Root" }
}

# Proof that the production service was not what we just stopped.
& 'C:\Program Files\PostgreSQL\16\bin\pg_isready.exe' --host=127.0.0.1 --port=5432
