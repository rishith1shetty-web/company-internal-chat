<#
  Phase 10.4 — install the Stage-A production services on THIS server PC.

  MUST RUN ELEVATED. Everything here needs administrator rights: the machine trust store, the
  service control manager, Windows Firewall and the power policy.

      powershell -ExecutionPolicy Bypass -File deploy\install-services.ps1

  NO SECRETS. This script names paths; every secret stays in C:\company-chat\production.env and
  the TLS private key stays in C:\company-chat-pki\server. Neither is read, copied or printed here.

  Idempotent: safe to re-run. Existing services are stopped and replaced, existing firewall rules
  are removed and recreated.
#>

[CmdletBinding()]
param(
    [switch]$SkipPowerSetting
)

$ErrorActionPreference = 'Stop'

$REPO        = 'C:\dev\company-internal-chat'
$BASE        = 'C:\company-chat'
$SERVICES    = Join-Path $BASE 'services'
$LOGS        = Join-Path $BASE 'logs'
$UPLOADS     = Join-Path $BASE 'uploads'
$PROD_ENV    = Join-Path $BASE 'production.env'
$PKI_SERVER  = 'C:\company-chat-pki\server'
$ROOT_CA     = 'C:\company-chat-pki\dist\rising-path-root-ca.crt'

# The root CA issued in Phase 10.2. Checked before it is trusted, so this script cannot install
# some other certificate that happens to be sitting at that path.
$ROOT_CA_SHA256 = '50A34952B68F99C1D98AAC2C1300345F4859530B72B6367CB5D809B90C5E36AB'

$LAN = '192.168.29.0/24'

New-Item -ItemType Directory -Force -Path $LOGS | Out-Null
Start-Transcript -Path (Join-Path $LOGS 'install-services.log') -Append | Out-Null

function Step($text) { Write-Host "`n=== $text ===" }
function Ok($text)   { Write-Host "  OK   $text" }
function Warn($text) { Write-Host "  WARN $text" }

try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This script must be run as Administrator.'
    }
    Ok "Running elevated as $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"

    # -----------------------------------------------------------------------------------------
    Step 'Trust the internal root CA (machine store)'

    if (-not (Test-Path $ROOT_CA)) { throw "Root CA certificate not found at $ROOT_CA" }

    $actual = (Get-FileHash $ROOT_CA -Algorithm SHA256).Hash
    $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2($ROOT_CA)
    Write-Host "  file SHA-256 : $actual"
    Write-Host "  subject      : $($cert.Subject)"
    Write-Host "  thumbprint   : $($cert.Thumbprint)"

    # Hex by hand: [Convert]::ToHexString is .NET 5+, and Windows PowerShell 5.1 runs on .NET
    # Framework, where it does not exist.
    $sha = [Security.Cryptography.SHA256]::Create()
    $der = (($sha.ComputeHash($cert.RawData)) | ForEach-Object { $_.ToString('x2') }) -join ''
    if ($der -ne $ROOT_CA_SHA256.ToLower()) {
        throw "Root CA fingerprint mismatch. Expected $ROOT_CA_SHA256, got $der. NOT trusting it."
    }
    Ok 'Certificate fingerprint matches the one issued in Phase 10.2'

    if ($cert.HasPrivateKey) { throw 'That file contains a PRIVATE KEY. Only the public certificate may be distributed.' }
    Ok 'File contains no private key'

    Import-Certificate -FilePath $ROOT_CA -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    Ok 'Imported into LocalMachine\Root'

    # -----------------------------------------------------------------------------------------
    Step 'Install the services'

    New-Item -ItemType Directory -Force -Path $SERVICES | Out-Null
    Copy-Item (Join-Path $REPO 'deploy\RisingPathChat.xml')  (Join-Path $SERVICES 'RisingPathChat.xml')  -Force
    Copy-Item (Join-Path $REPO 'deploy\RisingPathCaddy.xml') (Join-Path $SERVICES 'RisingPathCaddy.xml') -Force
    Ok 'Service definitions copied'

    foreach ($id in 'RisingPathChat', 'RisingPathCaddy') {
        $exe = Join-Path $SERVICES "$id.exe"
        $existing = Get-Service -Name $id -ErrorAction SilentlyContinue
        if ($existing) {
            Warn "$id already exists — stopping and uninstalling first"
            & $exe stop   2>&1 | Out-Null
            & $exe uninstall 2>&1 | Out-Null
            Start-Sleep -Seconds 3
        }
        & $exe install 2>&1 | ForEach-Object { Write-Host "  $_" }
        if ($LASTEXITCODE -ne 0) { throw "$id install failed with exit code $LASTEXITCODE" }

        # Set the account here rather than trusting the XML.
        #
        # WinSW 2.x ignores the 3.x <username> spelling without a word of complaint and leaves the
        # service as LocalSystem. That happened on the first install of this system, so the account
        # is now set explicitly and then ASSERTED below - a silent fallback to LocalSystem is the
        # difference between least privilege and total privilege.
        # Via WMI rather than `sc.exe config`. sc's `obj= value` syntax needs a space after the
        # equals sign, which PowerShell mangles into an invalid command line (error 1639); the
        # Change method takes the account as a plain argument and the password as $null, which is
        # what a virtual account requires.
        $svc = Get-WmiObject Win32_Service -Filter "Name='$id'"
        $rc = $svc.Change($null, $null, $null, $null, $null, $null, "NT SERVICE\$id", $null, $null, $null, $null).ReturnValue
        if ($rc -ne 0) { throw "Could not set the service account for $id (WMI Change returned $rc)" }

        $account = (& sc.exe qc $id | Select-String 'SERVICE_START_NAME').ToString().Split(':')[-1].Trim()
        if ($account -ne "NT SERVICE\$id") {
            throw "$id is running as '$account', not the virtual service account. Refusing to continue."
        }
        Ok "$id installed and running as $account"
    }

    # -----------------------------------------------------------------------------------------
    Step 'Grant least-privilege access to the service accounts'

    # The NT SERVICE\<id> SIDs exist only once the services are created, which is why this runs
    # after the install rather than before it.
    function Grant($path, $account, $rights) {
        if (-not (Test-Path $path)) { Warn "missing, skipped: $path"; return }
        $inherit = if (Test-Path $path -PathType Container) { '(OI)(CI)' } else { '' }
        & icacls $path /grant "${account}:${inherit}${rights}" | Out-Null
        if ($LASTEXITCODE -ne 0) { Warn "icacls failed for $account on $path" } else { Ok "$account  $rights  $path" }
    }

    Grant $REPO     'NT SERVICE\RisingPathChat' 'RX'
    # Next.js writes its runtime cache under .next at run time, so this one subtree needs more
    # than read. Kept as narrow as that: the rest of the repository stays read-and-execute.
    Grant (Join-Path $REPO '.next') 'NT SERVICE\RisingPathChat' 'M'
    Grant $SERVICES 'NT SERVICE\RisingPathChat' 'RX'
    Grant $PROD_ENV 'NT SERVICE\RisingPathChat' 'R'
    Grant $UPLOADS  'NT SERVICE\RisingPathChat' 'M'
    Grant $LOGS     'NT SERVICE\RisingPathChat' 'M'

    Grant (Join-Path $REPO 'deploy\Caddyfile')     'NT SERVICE\RisingPathCaddy' 'R'
    Grant (Join-Path $PKI_SERVER 'stage-a.crt')    'NT SERVICE\RisingPathCaddy' 'R'
    Grant (Join-Path $PKI_SERVER 'stage-a.key')    'NT SERVICE\RisingPathCaddy' 'R'
    Grant 'C:\company-chat\caddy'                  'NT SERVICE\RisingPathCaddy' 'RX'
    Grant $LOGS                                    'NT SERVICE\RisingPathCaddy' 'M'
    # Caddy keeps its own small state directory under the service profile.
    Grant 'C:\Windows\ServiceProfiles'             'NT SERVICE\RisingPathCaddy' 'RX'
    Grant $SERVICES                                'NT SERVICE\RisingPathCaddy' 'RX'

    Write-Host "  NOTE: nothing is granted under C:\company-chat-pki\ca — the root CA is not the proxy's business."

    # -----------------------------------------------------------------------------------------
    Step 'Windows Firewall'

    foreach ($name in 'Rising Path Chat HTTPS (443)', 'Rising Path Chat HTTP redirect (80)', 'Rising Path Chat block PostgreSQL (5432)', 'Rising Path Chat block Node direct (3000)') {
        Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    }

    New-NetFirewallRule -DisplayName 'Rising Path Chat HTTPS (443)' -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort 443 -RemoteAddress $LAN -Profile Any | Out-Null
    Ok "allow TCP 443 inbound from $LAN"

    New-NetFirewallRule -DisplayName 'Rising Path Chat HTTP redirect (80)' -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort 80 -RemoteAddress $LAN -Profile Any | Out-Null
    Ok "allow TCP 80 inbound from $LAN (redirect only)"

    # PostgreSQL listens on 0.0.0.0:5432. The application reaches it over loopback, so nothing on
    # the network has any business connecting — blocked explicitly rather than left to chance.
    New-NetFirewallRule -DisplayName 'Rising Path Chat block PostgreSQL (5432)' -Direction Inbound -Action Block `
        -Protocol TCP -LocalPort 5432 -Profile Any | Out-Null
    Ok 'block TCP 5432 inbound (defence in depth; the app uses loopback)'

    # The Node process binds 127.0.0.1 only, so this rule should never match anything. It exists so
    # that a future BIND_HOST mistake cannot quietly publish the application.
    New-NetFirewallRule -DisplayName 'Rising Path Chat block Node direct (3000)' -Direction Inbound -Action Block `
        -Protocol TCP -LocalPort 3000 -Profile Any | Out-Null
    Ok 'block TCP 3000 inbound (belt and braces; it binds loopback only)'

    # -----------------------------------------------------------------------------------------
    Step 'Power policy'

    if ($SkipPowerSetting) {
        Warn 'skipped by request'
    } else {
        $before = powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String 'Current AC Power Setting Index' | Select-Object -First 1
        Write-Host "  before: $($before -replace '\s+', ' ')"
        powercfg /change standby-timeout-ac 0
        $after = powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String 'Current AC Power Setting Index' | Select-Object -First 1
        Write-Host "  after : $($after -replace '\s+', ' ')"
        Ok 'standby on AC disabled (revert with: powercfg /change standby-timeout-ac 30)'
    }

    # -----------------------------------------------------------------------------------------
    Step 'Start the services'

    Start-Service RisingPathChat
    Start-Sleep -Seconds 6
    Start-Service RisingPathCaddy
    Start-Sleep -Seconds 4

    Get-Service RisingPathChat, RisingPathCaddy, postgresql-x64-16 |
        Select-Object Name, Status, StartType | Format-Table -AutoSize | Out-String | Write-Host

    Write-Host "`nDONE."
}
catch {
    Write-Host "`nFAILED: $($_.Exception.Message)"
    Write-Host $_.ScriptStackTrace
    exit 1
}
finally {
    Stop-Transcript | Out-Null
}
