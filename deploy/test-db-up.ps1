<#
  Start the ISOLATED test database.

      powershell -ExecutionPolicy Bypass -File deploy\test-db-up.ps1

  WHY THIS EXISTS. This machine is both the development computer and the live company server, so
  the development `.env` points DATABASE_URL at the PRODUCTION database. The test suite creates
  and deletes rows, so it must never be pointed there — and since Batch 1 the suite refuses to
  start unless it has somewhere else to go (tests/test-database-guard.ts).

  WHAT ISOLATION MEANS HERE, because this is the part that has to be right:

    * `initdb` creates a BRAND NEW PostgreSQL cluster in its own data directory. It is not a
      database inside the existing server — it has its own catalogues, its own configuration and
      its own process.
    * It listens on 127.0.0.1:55433. The production service on 5432 is never contacted, never
      reconfigured and never restarted, and `listen_addresses` is not touched — that installation
      is shared with other projects.
    * Trust auth, deliberately, and only for this cluster: it is loopback-only, on a non-standard
      port, and holds nothing but disposable test rows. Password auth bought nothing and cost
      correctness — a libpq tool that decides to prompt has no console here and blocks forever.

  Needs no elevation and installs nothing: initdb and postgres.exe ship with the PostgreSQL 16
  that is already on this machine. Stop it again with deploy\test-db-down.ps1.
#>

[CmdletBinding()]
param(
    [int]$Port = 55433,
    [string]$Root = 'C:\company-chat-devdb'
)

$ErrorActionPreference = 'Stop'
$PGBIN = 'C:\Program Files\PostgreSQL\16\bin'

# The application's own target guard requires this exact name, test cluster included
# (lib/db/target.ts). Isolation therefore comes from the PORT, never from the database name.
$DATABASE = 'company_chat_db'

$cluster = Join-Path $Root 'cluster'
$logFile = Join-Path $Root 'server.log'
$pidFile = Join-Path $Root 'server.pid'

if ($Port -eq 5432) { throw 'Refusing to use port 5432 — that is the live PostgreSQL service.' }

if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }

# Already up? Then there is nothing to do, and starting a second postmaster on the same data
# directory would fail anyway.
if (Test-Path $pidFile) {
    $existing = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
        & "$PGBIN\pg_isready.exe" --host=127.0.0.1 --port=$Port --quiet
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Already running on 127.0.0.1:$Port (pid $existing)"
            Write-Host ""
            Write-Host "  TEST_DATABASE_ALLOWED=yes DATABASE_URL=`"postgresql://devuser@127.0.0.1:$Port/$DATABASE`" npm test"
            exit 0
        }
    }
}

if (-not (Test-Path (Join-Path $cluster 'PG_VERSION'))) {
    Write-Host "initdb -> $cluster"
    & "$PGBIN\initdb.exe" --pgdata=$cluster --username=devuser --encoding=UTF8 `
        --auth-local=trust --auth-host=trust 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "initdb failed ($LASTEXITCODE)" }
}

Write-Host "starting postgres on 127.0.0.1:$Port"
#
# postgres.exe is launched DIRECTLY, not through pg_ctl.
#
# `pg_ctl start` does not reliably exit on this machine — both -w and Start-Process -Wait sat
# there forever while the cluster underneath was up and healthy. Starting the server process
# itself removes the middleman: we hold the PID and poll for readiness ourselves.
#
$server = Start-Process -FilePath "$PGBIN\postgres.exe" `
    -ArgumentList @('-D', "`"$cluster`"", '-p', "$Port", '-h', '127.0.0.1') `
    -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"

Set-Content -Path $pidFile -Value $server.Id -Encoding ascii

$ready = $false
foreach ($attempt in 1..40) {
    Start-Sleep -Milliseconds 500
    & "$PGBIN\pg_isready.exe" --host=127.0.0.1 --port=$Port --quiet
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
}
if (-not $ready) { throw "the test cluster did not become ready - see $logFile" }

$exists = & "$PGBIN\psql.exe" --host=127.0.0.1 --port=$Port --username=devuser --dbname=postgres `
    --no-password --tuples-only --no-align `
    --command="SELECT 1 FROM pg_database WHERE datname='$DATABASE'"

if ("$exists".Trim() -ne '1') {
    & "$PGBIN\createdb.exe" --host=127.0.0.1 --port=$Port --username=devuser --no-password $DATABASE
    if ($LASTEXITCODE -ne 0) { throw "createdb failed ($LASTEXITCODE)" }
    Write-Host "created database $DATABASE"
}

Write-Host ""
Write-Host "READY  127.0.0.1:$Port/$DATABASE  (pid $($server.Id))"
Write-Host ""
Write-Host "  Apply migrations:"
Write-Host "    DATABASE_URL=`"postgresql://devuser@127.0.0.1:$Port/$DATABASE`" npx prisma migrate deploy"
Write-Host ""
Write-Host "  Run the suite:"
Write-Host "    TEST_DATABASE_ALLOWED=yes DATABASE_URL=`"postgresql://devuser@127.0.0.1:$Port/$DATABASE`" npm test"
Write-Host ""
