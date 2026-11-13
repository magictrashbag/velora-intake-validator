# Kame - one-click local setup and start for Windows 10/11.
#
# Run it (from the folder where you saved this file):
#     powershell -ExecutionPolicy Bypass -File .\kame.ps1
#
# First run: installs Node.js LTS and Git with winget (if missing), downloads Kame into
# %USERPROFILE%\kame, installs dependencies, starts Postgres in Docker, creates the tables and
# demo data, then opens the API and the app in two new windows.
# Later runs: skips what is already done and just starts everything again.
#
# Requires Docker Desktop (installed and running). Development use only: demo data is fictional.

# 'Continue', not 'Stop': in Windows PowerShell 5.1, 'Stop' turns any stderr output of native tools
# (docker, git, npm) into a fatal error. Every step checks `$LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
$RepoUrl = 'https://github.com/magictrashbag/velora-intake-validator.git'
$Branch  = 'claude/kontigo-repo-repurpose-vl2exb'
$AppDir  = Join-Path $env:USERPROFILE 'kame'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Winget-Install($id, $name) {
  if (-not (Has 'winget')) { Fail "winget is not available. Install $name manually, then run this script again." }
  Write-Host "Installing $name (a Windows prompt may ask for permission)..."
  winget install -e --id $id --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0) { Fail "Could not install $name with winget (exit code $LASTEXITCODE)." }
  Refresh-Path
}

# --- 1. Node.js 22.9+ ------------------------------------------------------------------------
Step 'Checking Node.js'
$needNode = $true
if (Has 'node') {
  $v = (node -v).TrimStart('v').Split('.')
  if ([int]$v[0] -gt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -ge 9)) { $needNode = $false }
  else { Write-Host "Node $(node -v) is too old; installing the current LTS." }
}
if ($needNode) { Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS' }
if (-not (Has 'node')) { Fail 'Node.js was installed but is not on PATH yet. Close this window, open a new PowerShell and run the script again.' }
Write-Host "Node $(node -v) OK"

# --- 2. Git ----------------------------------------------------------------------------------
Step 'Checking Git'
if (-not (Has 'git')) { Winget-Install 'Git.Git' 'Git' }
if (-not (Has 'git')) { Fail 'Git was installed but is not on PATH yet. Close this window, open a new PowerShell and run the script again.' }
Write-Host "$(git --version) OK"

# --- 3. Docker -------------------------------------------------------------------------------
Step 'Checking Docker'
if (-not (Has 'docker')) { Fail 'Docker is not installed or not on PATH. Install Docker Desktop and run this script again.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  $dd = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $dd) { Write-Host 'Starting Docker Desktop...'; Start-Process $dd }
  Write-Host 'Waiting for Docker to be ready (up to 3 minutes)...'
  $ok = $false
  for ($i = 0; $i -lt 90; $i++) { Start-Sleep -Seconds 2; docker info *> $null; if ($LASTEXITCODE -eq 0) { $ok = $true; break } }
  if (-not $ok) { Fail 'Docker is not running. Open Docker Desktop, wait until it says it is running, then run this script again.' }
}
Write-Host 'Docker OK'

# --- 4. Get / update the code ----------------------------------------------------------------
Step "Getting Kame into $AppDir"
if (-not (Test-Path (Join-Path $AppDir '.git'))) {
  git clone --branch $Branch $RepoUrl $AppDir
  if ($LASTEXITCODE -ne 0) { Fail 'git clone failed. If a GitHub sign-in window appeared, complete it and run the script again.' }
} else {
  Push-Location $AppDir
  git fetch origin $Branch
  git checkout $Branch
  git pull --ff-only origin $Branch
  if ($LASTEXITCODE -ne 0) { Write-Host 'Could not fast-forward (local changes?). Continuing with the current code.' -ForegroundColor DarkYellow }
  Pop-Location
}
Set-Location $AppDir

# --- 5. Dependencies and settings --------------------------------------------------------------
Step 'Installing dependencies (first time takes a few minutes)'
npm.cmd install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Fail 'npm.cmd install failed. See the messages above.' }
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }
if (-not (Test-Path 'apps\mobile\.env')) { Copy-Item 'apps\mobile\.env.example' 'apps\mobile\.env' }

# --- 6. Database -------------------------------------------------------------------------------
Step 'Starting the database'
npm.cmd run db:up
if ($LASTEXITCODE -ne 0) { Fail 'Could not start the database container. Is Docker Desktop running? Is port 5432 already used by another Postgres?' }
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  docker compose exec -T db pg_isready -U kame *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { Fail 'The database did not become ready in time. Run the script again.' }
npm.cmd run -s db:migrate
if ($LASTEXITCODE -ne 0) { Fail 'Database migration failed. See the messages above.' }

Step 'Creating demo data and staff logins'
$seed = npm.cmd run -s seed | Out-String
if ($LASTEXITCODE -ne 0) { Write-Host $seed; Fail 'Seeding demo data failed.' }
$logins = Join-Path $AppDir 'kame-logins.txt'
$seed | Set-Content -Path $logins -Encoding UTF8
Write-Host $seed

# --- 7. Start API and app in their own windows ------------------------------------------------
Step 'Starting the API (new window - keep it open)'
Start-Process powershell -ArgumentList @('-NoExit', '-Command', "Set-Location '$AppDir'; `$host.UI.RawUI.WindowTitle = 'Kame API'; npm.cmd run dev:api")
$up = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try { Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/health' -TimeoutSec 2 | Out-Null; $up = $true; break } catch {}
}
if (-not $up) { Fail 'The API did not start. Look at the "Kame API" window for the error.' }

Step 'Starting the app (new window - keep it open; the browser opens by itself)'
Start-Process powershell -ArgumentList @('-NoExit', '-Command', "Set-Location '$AppDir'; `$host.UI.RawUI.WindowTitle = 'Kame app'; npm.cmd run dev:web")
Start-Process 'http://localhost:3000/staff'

Write-Host ''
Write-Host 'Kame is running.' -ForegroundColor Green
Write-Host '  App:            opens in your browser (Expo web, usually http://localhost:8081)'
Write-Host '  Review console: http://localhost:3000/staff'
Write-Host "  Logins and staff tokens were saved to: $logins"
Write-Host '  Log in with +584121234567; the 6-digit code is shown on screen.'
Write-Host '  To stop: close the "Kame API" and "Kame app" windows. Run this script again to restart.'
Read-Host "`nPress Enter to close this window"
