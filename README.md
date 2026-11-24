# Storm Royale (3D, First-Person)

Battle Royale im Browser mit Multiplayer, Bots, Häusern, Truhen und benannten Orten.

## Starten
```bash
npm install
npm start
```
Dann `http://localhost:3000` öffnen. Im Menü steht eine Einladungs-Adresse für Freunde im gleichen WLAN (mit Kopieren-Knopf).

## Steuerung
- **WASD** bewegen, **Maus** umsehen (Klick aufs Spiel fängt die Maus ein, **Esc** gibt sie frei)
- **Linksklick** oder **Leertaste** schießen, **E** Truhe öffnen
- Waffen und Medkits: einfach drüberlaufen

## Features
- First-Person mit 3D-Zielen (auch nach oben/unten), Kopfschuss macht doppelten Schaden
- Karte 4000×4000 mit 8 benannten Orten (Stadt, Fabrik, Leuchtturm, …)
- Häuser mit Türen, Truhen (in Häusern und draußen), Bäume und Felsen als Deckung
- Waffen: Pistole, Maschinenpistole, Sturmgewehr, Schrotflinte, Scharfschützengewehr
- Schild, Medkits, Rangliste, Minimap mit Ortsnamen, schrumpfende Zone in 4 Phasen
- Bots in drei Stärken (Leicht/Mittel/Schwer)

## Technik
- `server.js`: autoritative Simulation (Node + `ws`), 30 Ticks/s, Snapshots 15/s
- `public/game.js`: Three.js-Client (ES-Modul), Three.js wird lokal vom Server ausgeliefert

## Bekannte Grenzen
- Keine Client-Prediction: eigene Bewegung ist ~100 ms verzögert
- Keine Sprünge, keine Stockwerke (Häuser sind eingeschossig)
- Kein Touch-Support
- Bots sind noch sehr stark (Balance ausstehend)
