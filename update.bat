@echo off
rem Storm Royale aktualisieren und neu starten (Windows, Doppelklick)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
pause
