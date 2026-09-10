<#
  Phase 10.4 — prove the Stage-A services behave correctly.

  MUST RUN ELEVATED (service control requires it).

      powershell -ExecutionPolicy Bypass -File deploy\verify-services.ps1

  Read-only with respect to data: it starts and stops services and makes HTTP requests. It never
  touches the database, the uploads or any configuration.

  Re-run this after any change to the services, and as part of the Phase 10.11 acceptance check.
#>

$ErrorActionPreference = 'Stop'
$LOGS = 'C:\company-chat\logs'
$URL  = 'https://192.168.29.244/api/health'

New-Item -ItemType Directory -Force -Path $LOGS | Out-Null
Start-Transcript -Path (Join-Path $LOGS 'verify-services.log') -Append | Out-Null

# Schannel hard-fails when it cannot fetch revocation information, and a private CA publishes
# none. Chromium and Electron soft-fail there, so this switch makes curl behave like the clients
# that matter. It is NOT a trust bypass: the certificate still has to chain to the trusted root.
function Probe {
    $code = & "$env:SystemRoot\System32\curl.exe" -s -o NUL --ssl-revoke-best-effort -w '%{http_code}' --max-time 15 $URL 2>$null
    return $code
}

function Show($label) {
    $s = Get-Service RisingPathChat, RisingPathCaddy | ForEach-Object { "$($_.Name)=$($_.Status)" }
    "{0,-34} {1,-46} https={2}" -f $label, ($s -join ' '), (Probe)
}

try {
    Write-Host "`n=== Service configuration ==="
    foreach ($id in 'RisingPathChat', 'RisingPathCaddy') {
        Write-Host "`n--- $id"
        (& sc.exe qc $id) | Where-Object { $_ -match 'START_TYPE|SERVICE_START_NAME|DEPENDENCIES|BINARY_PATH' } | ForEach-Object { "  " + $_.Trim() }
        (& sc.exe qfailure $id) | Where-Object { $_ -match 'RESET_PERIOD|RESTART|FAILURE_ACTIONS' } | ForEach-Object { "  " + $_.Trim() }
    }

    Write-Host "`n=== Baseline ==="
    Show 'both running'

    Write-Host "`n=== Application stopped (Caddy stays up) ==="
    # The deliberate absence of a service dependency: employees should get a 502 from a working
    # HTTPS endpoint, not a refused connection that looks like the server being switched off.
    Stop-Service RisingPathChat
    Start-Sleep -Seconds 3
    Show 'chat stopped'

    Write-Host "`n=== Application restarted ==="
    Start-Service RisingPathChat
    Start-Sleep -Seconds 8
    Show 'chat started'

    Write-Host "`n=== Proxy restarted ==="
    Restart-Service RisingPathCaddy
    Start-Sleep -Seconds 5
    Show 'caddy restarted'

    Write-Host "`n=== Both stopped ==="
    Stop-Service RisingPathCaddy
    Stop-Service RisingPathChat
    Start-Sleep -Seconds 3
    Show 'both stopped'

    Write-Host "`n=== Both started (boot order: chat, then caddy) ==="
    Start-Service RisingPathChat
    Start-Sleep -Seconds 8
    Start-Service RisingPathCaddy
    Start-Sleep -Seconds 5
    Show 'both started'

    Write-Host "`n=== Final state ==="
    Get-Service RisingPathChat, RisingPathCaddy, postgresql-x64-16 |
        Select-Object Name, Status, StartType | Format-Table -AutoSize | Out-String | Write-Host

    Write-Host 'DONE.'
}
catch {
    Write-Host "`nFAILED: $($_.Exception.Message)"
    exit 1
}
finally {
    Stop-Transcript | Out-Null
}
