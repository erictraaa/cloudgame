#!/usr/bin/env bash
# Storm Royale aktualisieren (Linux/macOS):
#   1. laufenden Server stoppen
#   2. neue Version von GitHub holen (falls vorhanden)
#   3. Server im Hintergrund neu starten
# Aufruf: ./update.sh   (oder: npm run update)
set -uo pipefail
cd "$(dirname "$0")"

PID_FILE=.server.pid
LOG_FILE=server.log
PORT="${PORT:-3000}"

stop_server() {
  if [[ ! -f $PID_FILE ]]; then
    echo "Kein laufender Server gefunden."
    return
  fi
  local pid
  pid=$(tr -d '[:space:]' < "$PID_FILE")
  if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
    echo "Stoppe Server (PID $pid) …"
    kill "$pid"
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "Server reagiert nicht – erzwinge Stopp."
      kill -9 "$pid"
    fi
  else
    echo "Alte PID-Datei gefunden, Server lief nicht mehr."
  fi
  rm -f "$PID_FILE"
}

install_deps() {
  npm install --omit=dev --no-audit --no-fund || return 1
}

update_code() {
  if [[ ! -d .git ]]; then
    echo "Kein Git-Repository – Update übersprungen (Spiel mit 'git clone' installieren)."
    return 0
  fi
  echo "Suche nach Updates …"
  git fetch --quiet || { echo "git fetch fehlgeschlagen (Internet?)."; return 1; }

  local upstream
  if ! upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
    echo "Kein Upstream-Branch eingestellt – Update übersprungen."
    return 0
  fi

  local local_rev remote_rev
  local_rev=$(git rev-parse HEAD)
  remote_rev=$(git rev-parse "$upstream")
  if [[ $local_rev == "$remote_rev" ]]; then
    echo "Bereits aktuell (${local_rev:0:7})."
    return 0
  fi

  echo "Neue Version gefunden: ${local_rev:0:7} → ${remote_rev:0:7}"
  git pull --ff-only --quiet || { echo "git pull fehlgeschlagen (lokale Änderungen?)."; return 1; }
  install_deps || { echo "npm install fehlgeschlagen."; return 1; }
  echo "Update installiert."
}

start_server() {
  if [[ ! -d node_modules ]]; then
    echo "Installiere Abhängigkeiten …"
    install_deps || { echo "npm install fehlgeschlagen."; exit 1; }
  fi
  echo "Starte Server …"
  nohup node server.js >> "$LOG_FILE" 2>&1 &
  # warten, bis der Server seine PID-Datei geschrieben hat
  for _ in {1..20}; do
    [[ -f $PID_FILE ]] && break
    sleep 0.25
  done
  if [[ -f $PID_FILE ]] && kill -0 "$(tr -d '[:space:]' < "$PID_FILE")" 2>/dev/null; then
    echo "Läuft: http://localhost:$PORT  (Log: $LOG_FILE, PID $(cat "$PID_FILE"))"
  else
    echo "Start fehlgeschlagen. Letzte Zeilen aus $LOG_FILE:"
    tail -n 20 "$LOG_FILE"
    exit 1
  fi
}

stop_server
if ! update_code; then
  echo "Update fehlgeschlagen – starte die bisherige Version neu."
fi
start_server
