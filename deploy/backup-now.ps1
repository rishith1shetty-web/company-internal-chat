<#
  Take a production backup: company_chat_db and the upload directory.

      powershell -ExecutionPolicy Bypass -File deploy\backup-now.ps1

  Does not need to run elevated, and does not stop any service. It only reads.

  CREDENTIALS never appear on a command line, in a log, or in this repository. The password is
  read from the protected production.env and handed to pg_dump through PGPASSFILE - PostgreSQL's
  own mechanism for exactly this - which is written once to C:\company-chat\pgpass.conf with the
  same ACL as production.env.

  ORDER MATTERS: the database is dumped BEFORE the uploads are copied. An attachment's file is
  written and renamed into place before its database row is committed
  (lib/files/storage.ts), so:

    DB then files  -> at worst an extra file with no row. A harmless orphan.
    files then DB  -> a row whose file was never copied. A broken download.

  NO WRITE PAUSE IS NEEDED for a routine backup. pg_dump takes an MVCC snapshot, so the dump is
  internally consistent whatever happens during it, and the ordering above makes the file set safe.
  A SERVER MIGRATION is different: there the application is stopped first, so that no message can
  be accepted after the dump was taken. See docs/20 for the cutover ordering.
#>

[CmdletBinding()]
param(
    [string]$EnvFile = 'C:\company-chat\production.env',
    [string]$Destination = 'C:\company-chat\backups'
)

$ErrorActionPreference = 'Stop'

$PGBIN = 'C:\Program Files\PostgreSQL\16\bin'
$PGPASS = 'C:\company-chat\pgpass.conf'

function Ok($t)   { Write-Host "  OK   $t" }
function Info($t) { Write-Host "  $t" }

# ---------------------------------------------------------------------------------------------
# Read the connection details out of the production configuration.
# Nothing here is ever echoed: the password is placed straight into the pgpass file.
# ---------------------------------------------------------------------------------------------
function Read-EnvValue($file, $name) {
    $line = Select-String -Path $file -Pattern "^$name=" | Select-Object -First 1
    if (-not $line) { throw "$name is not set in $file" }
    $value = $line.Line.Substring($name.Length + 1).Trim()
    # Values may be quoted - Node's loadEnvFile strips the quotes, so anything reading the same
    # file has to as well or it ends up with a connection string that begins with a quote mark.
    if ($value.Length -ge 2) {
        if (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        }
    }
    return $value
}

if (-not (Test-Path $EnvFile)) { throw "Production configuration not found: $EnvFile" }

$dbUrl = Read-EnvValue $EnvFile 'DATABASE_URL'
$uploadDir = Read-EnvValue $EnvFile 'UPLOAD_DIR'

$u = $null
if (-not [uri]::TryCreate($dbUrl, [UriKind]::Absolute, [ref]$u)) {
    throw 'DATABASE_URL in the production configuration is not a URL this tool can parse.'
}
$dbHost = $u.Host
$dbPort = if ($u.Port -gt 0) { $u.Port } else { 5432 }
$dbName = $u.AbsolutePath.TrimStart('/')
$dbUser = [uri]::UnescapeDataString($u.UserInfo.Split(':')[0])
$dbPass = [uri]::UnescapeDataString($u.UserInfo.Split(':')[1])

# The one database this project may touch (docs/02-database.md §0).
if ($dbName -ne 'company_chat_db') {
    throw "Refusing to back up '$dbName'. This tool only ever touches company_chat_db."
}

# pgpass format: host:port:database:user:password. Rewritten each run so a rotated password is
# picked up automatically, and locked down immediately.
Set-Content -Path $PGPASS -Value "${dbHost}:${dbPort}:${dbName}:${dbUser}:${dbPass}" -Encoding ascii -NoNewline
$me = "$env:USERDOMAIN\$env:USERNAME"
& icacls $PGPASS /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" "${me}:F" | Out-Null
$env:PGPASSFILE = $PGPASS
$dbPass = $null

$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$root = Join-Path $Destination $stamp
New-Item -ItemType Directory -Force -Path $root | Out-Null

Write-Host "`n=== Backup $stamp ==="
Info "database   $dbUser@${dbHost}:${dbPort}/$dbName"
Info "uploads    $uploadDir"
Info "into       $root"

# ---------------------------------------------------------------------------------------------
Write-Host "`n--- 1. Database (custom format) ---"

$dump = Join-Path $root 'company_chat_db.dump'
& "$PGBIN\pg_dump.exe" --format=custom --compress=6 --no-owner --no-privileges `
    --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName --file=$dump
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

$dumpHash = (Get-FileHash $dump -Algorithm SHA256).Hash
Ok ("pg_dump wrote {0:N0} bytes" -f (Get-Item $dump).Length)
Info "sha256 $dumpHash"

# ---------------------------------------------------------------------------------------------
Write-Host "`n--- 2. Uploads (after the dump, deliberately) ---"

$uploadCopy = Join-Path $root 'uploads'
New-Item -ItemType Directory -Force -Path $uploadCopy | Out-Null

# /MIR mirrors, /R:2 /W:2 keeps a locked file from stalling the run, /NFL /NDL quiet the listing.
& robocopy $uploadDir $uploadCopy /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS | Out-Null
# robocopy uses exit codes 0-7 for success; 8+ is a real failure.
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
$global:LASTEXITCODE = 0

$files = @(Get-ChildItem $uploadCopy -Recurse -File)
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
if (-not $bytes) { $bytes = 0 }
Ok ("{0} file(s), {1:N0} bytes" -f $files.Count, $bytes)

# ---------------------------------------------------------------------------------------------
Write-Host "`n--- 3. Checksums ---"

$checks = Join-Path $root 'checksums.txt'
$lines = @("$dumpHash  company_chat_db.dump")
foreach ($f in $files | Sort-Object FullName) {
    $rel = $f.FullName.Substring($uploadCopy.Length + 1) -replace '\\', '/'
    $lines += "$((Get-FileHash $f.FullName -Algorithm SHA256).Hash)  uploads/$rel"
}
Set-Content -Path $checks -Value $lines -Encoding ascii
Ok "$($lines.Count) checksum line(s)"

# ---------------------------------------------------------------------------------------------
Write-Host "`n--- 4. Manifest ---"

$pgVersion = (& "$PGBIN\psql.exe" --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName `
    --tuples-only --no-align --command "SHOW server_version") 2>$null
$migrations = (& "$PGBIN\psql.exe" --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName `
    --tuples-only --no-align --command "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL") 2>$null
# The SQL goes through a FILE, not --command.
#
# PowerShell 5.1 mangles double quotes inside native-command arguments, and every table here needs
# quoting because the names are CamelCase - passed inline, "Session" arrives as session and
# PostgreSQL reports that the relation does not exist.
$sqlFile = Join-Path $root '.rowcounts.sql'
Set-Content -Path $sqlFile -Encoding ascii -Value @'
SELECT 'User', count(*) FROM "User" UNION ALL
SELECT 'Session', count(*) FROM "Session" UNION ALL
SELECT 'Device', count(*) FROM "Device" UNION ALL
SELECT 'Conversation', count(*) FROM "Conversation" UNION ALL
SELECT 'ConversationMember', count(*) FROM "ConversationMember" UNION ALL
SELECT 'Message', count(*) FROM "Message" UNION ALL
SELECT 'Attachment', count(*) FROM "Attachment";
'@
$rows = (& "$PGBIN\psql.exe" --host=$dbHost --port=$dbPort --username=$dbUser --dbname=$dbName `
    --tuples-only --no-align --field-separator=':' --file=$sqlFile) 2>$null
Remove-Item $sqlFile -Force

$rowCounts = @{}
foreach ($r in $rows) { if ($r -match '^(\w+):(\d+)$') { $rowCounts[$Matches[1]] = [int]$Matches[2] } }

# NOTHING SECRET IN HERE. No password, no DATABASE_URL, no admin token - just enough to identify
# the backup and check it later.
$manifest = [ordered]@{
    backupTimestamp   = (Get-Date).ToString('o')
    backupFormat      = 'postgresql-custom (pg_dump -Fc, compress=6)'
    databaseName      = $dbName
    databaseHost      = "${dbHost}:${dbPort}"
    postgresqlVersion = "$pgVersion".Trim()
    dumpFile          = 'company_chat_db.dump'
    dumpBytes         = (Get-Item $dump).Length
    dumpSha256        = $dumpHash
    migrationsApplied = [int]"$migrations".Trim()
    rowCounts         = $rowCounts
    uploadFileCount   = $files.Count
    uploadTotalBytes  = [int64]$bytes
    uploadSourceDir   = $uploadDir
    toolVersions      = @{ pgDump = ((& "$PGBIN\pg_dump.exe" --version) -join '').Trim() }
}
$manifestPath = Join-Path $root 'backup-manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding utf8
Ok "backup-manifest.json"

Write-Host "`nBackup complete: $root"
Write-Host "Verify it with: powershell -ExecutionPolicy Bypass -File deploy\verify-backup.ps1 -Backup `"$root`""
