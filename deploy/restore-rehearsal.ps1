<#
  Prove a backup can actually be restored - WITHOUT going anywhere near the production database.

      powershell -ExecutionPolicy Bypass -File deploy\restore-rehearsal.ps1

  HOW THE ISOLATION WORKS, because this is the part that has to be right:

    * `initdb` creates a BRAND NEW PostgreSQL cluster in a temporary directory. It is a separate
      data directory with its own catalogues - not a database inside the existing server.
    * It is started with `pg_ctl` on PORT 55432, bound to 127.0.0.1 only. The production service
      on 5432 is never contacted, never reconfigured and never restarted.
    * The rehearsal database is created INSIDE that temporary cluster.
    * Everything is stopped and deleted at the end, in a `finally` block, so an error part way
      through still cleans up.

  So no existing database on the production server is read, written, created or dropped - not
  company_chat_db, and not any of the other projects sharing that PostgreSQL installation.

  Needs no elevation and installs nothing: initdb, pg_ctl and pg_restore all ship with the
  PostgreSQL 16 that is already here.
#>

[CmdletBinding()]
param(
    [string]$Backup,
    [string]$Destination = 'C:\company-chat\backups',
    [int]$Port = 55432
)

$ErrorActionPreference = 'Stop'
$PGBIN = 'C:\Program Files\PostgreSQL\16\bin'

$REHEARSAL_DB = 'rehearsal_restore_check'
$EXPECTED_TABLES = @('User', 'Session', 'Device', 'Conversation', 'ConversationMember', 'Message', 'Attachment')

$fail = 0
function Pass($t) { Write-Host "  PASS  $t" }
function Fail($t) { Write-Host "  FAIL  $t"; $script:fail++ }
function Step($t) { Write-Host "`n--- $t ---" }

if (-not $Backup) {
    $Backup = (Get-ChildItem $Destination -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName
}
$dump = Join-Path $Backup 'company_chat_db.dump'
if (-not (Test-Path $dump)) { throw "No dump found at $dump" }
$manifest = Get-Content (Join-Path $Backup 'backup-manifest.json') -Raw | ConvertFrom-Json

$cluster = Join-Path ([IO.Path]::GetTempPath()) ("rp-rehearsal-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$pwFile  = Join-Path ([IO.Path]::GetTempPath()) ("rp-rehearsal-pw-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.txt')
$logFile = Join-Path $cluster 'server.log'
$server  = $null

Write-Host "`n=== Restore rehearsal ==="
Write-Host "  backup    $Backup"
Write-Host "  cluster   $cluster  (temporary, port $Port)"
Write-Host "  isolation the production service on 5432 is not touched"

# TRUST AUTH, DELIBERATELY, and only for this throwaway cluster.
#
# The cluster listens on 127.0.0.1 alone, on a non-standard port, holds nothing but a copy of a
# backup we already possess, and is deleted in the `finally` block below - typically inside a
# minute. Against that, password auth bought nothing and cost correctness: any libpq tool that
# decides to prompt has no console to prompt on, so it blocks on stdin forever and the whole
# rehearsal hangs with the cluster left running. That happened twice while this was being written.
#
# Every client call below also passes --no-password, so if a prompt is ever reached anyway it
# fails immediately and loudly instead of hanging.
$env:PGPASSWORD = $null

try {
    Step 'Create an isolated cluster'
    & "$PGBIN\initdb.exe" --pgdata=$cluster --username=rehearsal --encoding=UTF8 `
        --auth-local=trust --auth-host=trust 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "initdb failed ($LASTEXITCODE)" }
    Pass "initdb created a new cluster (separate data directory)"

    Step 'Start it on a private port'
    #
    # postgres.exe is launched DIRECTLY, not through pg_ctl.
    #
    # `pg_ctl start` does not reliably exit on this machine - both -w and Start-Process -Wait sat
    # there forever while the cluster underneath was up and healthy, leaving an orphaned pg_ctl
    # behind each time. Starting the server process itself removes the middleman: we hold the PID,
    # we poll for readiness ourselves, and we can stop it deterministically.
    $server = Start-Process -FilePath "$PGBIN\postgres.exe" `
        -ArgumentList @('-D', "`"$cluster`"", '-p', "$Port", '-h', '127.0.0.1') `
        -NoNewWindow -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"

    $ready = $false
    foreach ($attempt in 1..30) {
        Start-Sleep -Milliseconds 700
        & "$PGBIN\pg_isready.exe" --host=127.0.0.1 --port=$Port --quiet
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    }
    if (-not $ready) { throw "the temporary cluster did not become ready - see $logFile" }
    Pass "cluster running on 127.0.0.1:$Port (pid $($server.Id))"

    Step 'Create the rehearsal database and restore into it'
    & "$PGBIN\createdb.exe" --host=127.0.0.1 --port=$Port --username=rehearsal --no-password $REHEARSAL_DB
    if ($LASTEXITCODE -ne 0) { throw "createdb failed ($LASTEXITCODE)" }

    & "$PGBIN\pg_restore.exe" --host=127.0.0.1 --port=$Port --username=rehearsal --no-password `
        --dbname=$REHEARSAL_DB --no-owner --no-privileges --exit-on-error $dump
    if ($LASTEXITCODE -ne 0) { throw "pg_restore failed ($LASTEXITCODE)" }
    Pass "pg_restore completed with --exit-on-error"

    Step 'Check what was restored'

    #
    # EVERY QUERY GOES THROUGH A FILE, not --command.
    #
    # The table names are CamelCase and therefore need double quotes in SQL. PowerShell 5.1
    # strips double quotes out of native-command arguments, so an inline query arrives as
    # `FROM message` and PostgreSQL answers "relation does not exist" - which looks exactly like a
    # failed restore and is nothing of the kind. A file has no argument parsing to survive.
    #
    $checkSql = Join-Path ([IO.Path]::GetTempPath()) ("rp-check-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.sql')
    $parts = @()
    foreach ($t in $EXPECTED_TABLES) {
        $parts += "SELECT 'exists:$t', CASE WHEN to_regclass('public.`"$t`"') IS NULL THEN '0' ELSE '1' END"
        $parts += "SELECT 'count:$t', count(*)::text FROM `"$t`""
    }
    $parts += "SELECT 'count:_prisma_migrations', count(*)::text FROM _prisma_migrations"
    Set-Content -Path $checkSql -Encoding ascii -Value (($parts -join "`nUNION ALL`n") + ';')

    $raw = & "$PGBIN\psql.exe" --host=127.0.0.1 --port=$Port --username=rehearsal --dbname=$REHEARSAL_DB `
        --no-password --tuples-only --no-align --field-separator='|' --file=$checkSql 2>&1
    Remove-Item $checkSql -Force -ErrorAction SilentlyContinue

    $result = @{}
    foreach ($line in $raw) { if ("$line" -match '^([a-zA-Z_:]+)\|(.+)$') { $result[$Matches[1]] = $Matches[2].Trim() } }

    foreach ($t in $EXPECTED_TABLES) {
        if ($result["exists:$t"] -eq '1') { Pass "table restored: $t" }
        else { Fail "table MISSING after restore: $t" }
    }

    $migrations = $result['count:_prisma_migrations']
    if ($migrations -eq '2') { Pass "_prisma_migrations has exactly 2 rows" }
    else { Fail "_prisma_migrations has $migrations rows, expected 2" }

    $namesSql = Join-Path ([IO.Path]::GetTempPath()) ("rp-names-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.sql')
    Set-Content -Path $namesSql -Encoding ascii -Value 'SELECT migration_name FROM _prisma_migrations ORDER BY migration_name;'
    $names = & "$PGBIN\psql.exe" --host=127.0.0.1 --port=$Port --username=rehearsal --dbname=$REHEARSAL_DB `
        --no-password --tuples-only --no-align --file=$namesSql 2>&1
    Remove-Item $namesSql -Force -ErrorAction SilentlyContinue
    foreach ($n in $names) { if ("$n".Trim()) { Write-Host "        $($n.Trim())" } }

    Step 'Row counts must match the manifest'
    foreach ($prop in $manifest.rowCounts.PSObject.Properties) {
        $actual = $result["count:$($prop.Name)"]
        if ($actual -eq "$($prop.Value)") { Pass "$($prop.Name): $actual" }
        else { Fail "$($prop.Name): restored $actual, backup recorded $($prop.Value)" }
    }

    Step 'Attachment metadata correlates with the copied files'
    $attSql = Join-Path ([IO.Path]::GetTempPath()) ("rp-att-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.sql')
    Set-Content -Path $attSql -Encoding ascii -Value 'SELECT "storageKey", "byteSize" FROM "Attachment";'
    $rows = & "$PGBIN\psql.exe" --host=127.0.0.1 --port=$Port --username=rehearsal --dbname=$REHEARSAL_DB `
        --no-password --tuples-only --no-align --field-separator='|' --file=$attSql 2>&1
    Remove-Item $attSql -Force -ErrorAction SilentlyContinue
    $checked = 0
    foreach ($row in $rows) {
        if ("$row" -notmatch '^(.+)\|(\d+)$') { continue }
        $key = $Matches[1]; $size = [int64]$Matches[2]
        $copied = Join-Path (Join-Path $Backup 'uploads') ($key -replace '/', '\')
        if (-not (Test-Path $copied)) { Fail "restored row references a file the backup does not have: $key" ; continue }
        $onDisk = (Get-Item $copied).Length
        if ($onDisk -ne $size) { Fail "$key size $onDisk, row says $size"; continue }
        $checked++
    }
    if ($checked -gt 0) { Pass "$checked attachment row(s) correlate with files in the backup" }
    elseif ($manifest.rowCounts.Attachment -eq 0) { Pass 'no attachments in this backup (nothing to correlate)' }
}
finally {
    Step 'Tear down the isolated cluster'
    # Stop the exact process we started. No pg_ctl, for the reason given above.
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    if (Test-Path $cluster) { Remove-Item $cluster -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $pwFile) { Remove-Item $pwFile -Force -ErrorAction SilentlyContinue }
    $env:PGPASSWORD = $null
    if (Test-Path $cluster) { Write-Host "  WARN  temporary cluster still at $cluster" }
    else { Write-Host "  OK    temporary cluster removed" }
}

if ($fail) { Write-Host "`n$fail CHECK(S) FAILED."; exit 1 }
Write-Host "`nRestore rehearsal passed. The backup reconstructs the schema, the data and the migration history."
