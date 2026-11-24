# Storm Royale aktualisieren (Windows):
#   1. laufenden Server stoppen
#   2. neue Version von GitHub holen (falls vorhanden)
#   3. Server im Hintergrund neu starten
# Aufruf: Doppelklick auf update.bat  (oder: powershell -ExecutionPolicy Bypass -File update.ps1)
# Hinweis: Datei absichtlich ohne Umlaute (Windows PowerShell 5.1 liest sonst falsch).

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$PidFile = Join-Path $PSScriptRoot '.server.pid'
$LogFile = Join-Path $PSScriptRoot 'server.log'
$ErrFile = Join-Path $PSScriptRoot 'server.err.log'
$Port = if ($env:PORT) { $env:PORT } else { 3000 }

function Get-ServerPid {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content $PidFile -Raw).Trim()
  if ($raw -match '^\d+$') { return [int]$raw }
  return $null
}

function Stop-Game {
  $id = Get-ServerPid
  if ($null -eq $id) { Write-Host 'Kein laufender Server gefunden.'; return }
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p) {
    Write-Host "Stoppe Server (PID $id) ..."
    Stop-Process -Id $id -Force
    $p.WaitForExit(5000) | Out-Null
  } else {
    Write-Host 'Alte PID-Datei gefunden, Server lief nicht mehr.'
  }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
}

function Install-Deps {
  npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install fehlgeschlagen' }
}

function Update-Game {
  if (-not (Test-Path (Join-Path $PSScriptRoot '.git'))) {
    Write-Host "Kein Git-Repository - Update uebersprungen (Spiel mit 'git clone' installieren)."
    return
  }
  Write-Host 'Suche nach Updates ...'
  git fetch --quiet
  if ($LASTEXITCODE -ne 0) { throw 'git fetch fehlgeschlagen (Internet?)' }

  $upstream = git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Host 'Kein Upstream-Branch eingestellt - Update uebersprungen.'; return }

  $localRev = (git rev-parse HEAD).Trim()
  $remoteRev = (git rev-parse $upstream).Trim()
  if ($localRev -eq $remoteRev) { Write-Host "Bereits aktuell ($($localRev.Substring(0,7)))."; return }

  Write-Host "Neue Version gefunden: $($localRev.Substring(0,7)) -> $($remoteRev.Substring(0,7))"
  git pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { throw 'git pull fehlgeschlagen (lokale Aenderungen?)' }
  Install-Deps
  Write-Host 'Update installiert.'
}

function Start-Game {
  if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host 'Installiere Abhaengigkeiten ...'
    Install-Deps
  }
  Write-Host 'Starte Server ...'
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile

  for ($i = 0; $i -lt 20 -and -not (Test-Path $PidFile); $i++) { Start-Sleep -Milliseconds 250 }
  $id = Get-ServerPid
  if ($null -ne $id -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) {
    Write-Host "Laeuft: http://localhost:$Port  (Log: server.log, PID $id)" -ForegroundColor Green
  } else {
    Write-Host 'Start fehlgeschlagen. Letzte Zeilen aus server.err.log:' -ForegroundColor Red
    if (Test-Path $ErrFile) { Get-Content $ErrFile -Tail 20 }
    exit 1
  }
}

Stop-Game
try {
  Update-Game
} catch {
  Write-Host "Update fehlgeschlagen: $_ - starte die bisherige Version neu." -ForegroundColor Yellow
}
Start-Game
