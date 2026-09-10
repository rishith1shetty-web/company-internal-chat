<#
  Check that a backup is actually usable, without restoring it anywhere.

      powershell -ExecutionPolicy Bypass -File deploy\verify-backup.ps1 -Backup C:\company-chat\backups\<stamp>

  Read-only. It never connects to the production database and never writes outside the backup
  directory. Omit -Backup to check the most recent one.

  A backup nobody has verified is a hope, not a backup.
#>

[CmdletBinding()]
param(
    [string]$Backup,
    [string]$Destination = 'C:\company-chat\backups'
)

$ErrorActionPreference = 'Stop'
$PGBIN = 'C:\Program Files\PostgreSQL\16\bin'

$EXPECTED_TABLES = @('User', 'Session', 'Device', 'Conversation', 'ConversationMember', 'Message', 'Attachment')
$MIGRATIONS_TABLE = '_prisma_migrations'

$fail = 0
function Pass($t) { Write-Host "  PASS  $t" }
function Fail($t) { Write-Host "  FAIL  $t"; $script:fail++ }

if (-not $Backup) {
    $Backup = (Get-ChildItem $Destination -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
}
if (-not (Test-Path $Backup)) { throw "No such backup: $Backup" }

Write-Host "`n=== Verifying $Backup ==="

$dump = Join-Path $Backup 'company_chat_db.dump'
$manifestPath = Join-Path $Backup 'backup-manifest.json'
$checks = Join-Path $Backup 'checksums.txt'

foreach ($f in @($dump, $manifestPath, $checks)) {
    if (Test-Path $f) { Pass "present: $(Split-Path $f -Leaf)" } else { Fail "MISSING: $(Split-Path $f -Leaf)" }
}
if ($fail) { exit 1 }

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

# --- the dump is intact -----------------------------------------------------------------------
$hash = (Get-FileHash $dump -Algorithm SHA256).Hash
if ($hash -eq $manifest.dumpSha256) { Pass "dump SHA-256 matches the manifest" }
else { Fail "dump SHA-256 MISMATCH - the file changed since it was written" }

# --- pg_restore can read it -------------------------------------------------------------------
$toc = & "$PGBIN\pg_restore.exe" --list $dump 2>&1
if ($LASTEXITCODE -ne 0) { Fail "pg_restore could not read the dump"; exit 1 }
Pass "pg_restore --list reads the archive ($($toc.Count) entries)"

# --- it contains what it should ---------------------------------------------------------------
$tocText = $toc -join "`n"
foreach ($t in $EXPECTED_TABLES) {
    if ($tocText -match "TABLE (public )?`"?$t`"?\s") { Pass "table present: $t" }
    else { Fail "table MISSING from the dump: $t" }
}
if ($tocText -match [regex]::Escape($MIGRATIONS_TABLE)) { Pass "$MIGRATIONS_TABLE is preserved in the dump" }
else { Fail "$MIGRATIONS_TABLE is MISSING - migration history would be lost on restore" }

# --- uploads ----------------------------------------------------------------------------------
$uploadCopy = Join-Path $Backup 'uploads'
$files = @(Get-ChildItem $uploadCopy -Recurse -File -ErrorAction SilentlyContinue)
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
if (-not $bytes) { $bytes = 0 }

if ($files.Count -eq $manifest.uploadFileCount) { Pass "upload file count matches the manifest ($($files.Count))" }
else { Fail "upload file count is $($files.Count), manifest says $($manifest.uploadFileCount)" }

if ([int64]$bytes -eq [int64]$manifest.uploadTotalBytes) { Pass "upload byte total matches ($bytes)" }
else { Fail "upload bytes $bytes, manifest says $($manifest.uploadTotalBytes)" }

# --- every recorded checksum still holds ------------------------------------------------------
$bad = 0
foreach ($line in Get-Content $checks) {
    if ($line -notmatch '^([0-9A-Fa-f]{64})\s\s(.+)$') { continue }
    $want = $Matches[1]; $rel = $Matches[2]
    $path = if ($rel -eq 'company_chat_db.dump') { $dump } else { Join-Path $Backup ($rel -replace '/', '\') }
    if (-not (Test-Path $path)) { $bad++; continue }
    if ((Get-FileHash $path -Algorithm SHA256).Hash -ne $want) { $bad++ }
}
if ($bad -eq 0) { Pass "every checksum in checksums.txt still holds" } else { Fail "$bad checksum(s) do not match" }

# --- no secrets ---------------------------------------------------------------------------------
# The manifest and checksums are the only human-readable files; the dump is application data.
$secretish = Select-String -Path $manifestPath, $checks -Pattern 'ADMIN_TOKEN|DATABASE_URL|password|BEGIN .*PRIVATE KEY' -ErrorAction SilentlyContinue
if ($secretish) { Fail "possible secret in backup metadata: $($secretish[0].Line)" }
else { Pass "no secrets in backup-manifest.json or checksums.txt" }

Write-Host "`nManifest summary:"
Write-Host "  taken           $($manifest.backupTimestamp)"
Write-Host "  database        $($manifest.databaseName) (PostgreSQL $($manifest.postgresqlVersion))"
Write-Host "  migrations      $($manifest.migrationsApplied)"
Write-Host "  uploads         $($manifest.uploadFileCount) file(s), $($manifest.uploadTotalBytes) bytes"
Write-Host "  row counts      $(($manifest.rowCounts.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '  ')"

if ($fail) { Write-Host "`n$fail CHECK(S) FAILED."; exit 1 }
Write-Host "`nAll checks passed."
