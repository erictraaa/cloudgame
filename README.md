# Storm Royale (3D, First-Person)

Battle Royale im Browser mit Multiplayer, Bots und einer riesigen, zufällig erzeugten Welt:
Berge, Hügel, Klippen, Städte, Dörfer, Industriegebiete, Straßen und Wälder.

## Starten
```bash
npm install
npm start
```
Dann `http://localhost:3000` öffnen. Im Menü steht eine Einladungs-Adresse für Freunde im gleichen WLAN (mit Kopieren-Knopf).

Jeder Serverstart erzeugt eine neue Welt. Eine bestimmte Welt bekommst du mit einem festen Seed:
```bash
SEED=12345 npm start
```

## Aktualisieren
Stoppt den laufenden Server, holt die neueste Version von GitHub (falls vorhanden) und startet den Server im Hintergrund neu:

- **Linux/macOS:** `./update.sh` (oder `npm run update`)
- **Windows:** Doppelklick auf `update.bat`

Voraussetzung: Das Spiel wurde mit `git clone` installiert (nicht als ZIP). Die Ausgabe des Servers landet in `server.log`.
Schlägt das Update fehl (z. B. wegen lokaler Änderungen), startet die bisherige Version wieder.

Server ohne Update stoppen: `kill $(cat .server.pid)` (Linux/macOS) bzw. `Stop-Process -Id (Get-Content .server.pid)` (Windows).

## Steuerung
- **WASD** bewegen, **Shift** sprinten, **Maus** umsehen (Klick aufs Spiel fängt die Maus ein, **Esc** gibt sie frei)
- **Linksklick** oder **Leertaste** schießen, **E** Truhe öffnen, **M** große Karte
- Waffen, Medkits und Schilde: einfach drüberlaufen

## Die Welt
- Karte 12 000 × 12 000 Einheiten (9-fache Fläche der alten 4000er-Karte), Gelände als Heightmap
- Berge mit Schnee, Hügel, Klippen (zu steil zum Hochlaufen), Gebirge am Kartenrand
- 4 Städte mit Straßenraster und Marktplatz, 9 Dörfer, 2 Industriegebiete, verbunden durch Asphaltstraßen und Feldwege
- Gebäude: Wohnhäuser (mit zwei Räumen), Mehrfamilienhäuser, Läden, Scheunen, Lagerhallen, Kirchen mit Turm
- Rund 8 500 Bäume (Nadel- und Laubwälder) und 1 600 Felsen
- Texturen von [ambientCG](https://ambientcg.com) (CC0), siehe `public/textures/LICENSE.md`

## Kampf
- Schüsse sind Hitscan mit exaktem Strahltest: Wände, Dächer, Bäume, Felsen und Gelände halten Kugeln auf
- Kopfschuss = doppelter Schaden
- Waffen: Pistole, Maschinenpistole, Sturmgewehr, Schrotflinte, Scharfschützengewehr
- Schild, Medkits, Truhen (in Häusern und in der Wildnis), Rangliste, schrumpfende Zone in 6 Phasen
- Bots in drei Stärken; sie schießen nur auf Gegner, die sie wirklich sehen

## Technik
- `world.js`: Weltgenerator (Gelände, Orte, Straßen, Gebäude, Vegetation) – deterministisch aus einem Seed
- `server.js`: autoritative Simulation (Node + `ws`), 30 Ticks/s, Snapshots ~15/s, räumliches Raster für Kollisionen
- `public/game.js`: Three.js-Client; Gelände-Shader mischt Gras, Fels (Steilhänge), Schnee (Höhe) und Wege
- `npm test`: prüft für jedes Gebäude, dass Schüsse nicht durch Wände oder Dächer gehen

## Bekannte Grenzen
- Keine Client-Prediction: eigene Bewegung ist ~100 ms verzögert
- Keine Sprünge, Häuser sind eingeschossig begehbar
- Beim Beitreten werden ~500 KB Weltdaten übertragen; der Aufbau dauert einige Sekunden
- Kein Touch-Support
