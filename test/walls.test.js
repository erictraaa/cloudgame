// Prüft: Schüsse gehen nicht durch Wände oder Dächer, aber durch offene Türen.
// Aufruf: npm test
'use strict';
process.env.SEED = process.env.SEED || '12345';
const { world, raycastWorld } = require('../server.js');

let checked = 0, leaks = 0, doorChecks = 0, doorBlocked = 0;
const EYE = 62;

function shoot(ox, oy, oh, tx, ty, th) {
  const dx = tx - ox, dy = ty - oy, dh = th - oh, d = Math.hypot(dx, dy, dh);
  return { hit: raycastWorld(ox, oy, oh, dx / d, dy / d, dh / d, d), d };
}

for (const b of world.buildings) {
  if (b.type === 'tower') continue;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, g = b.g;
  // Ziele im Inneren: Ecken-nah, damit der Strahl nicht durch die Türöffnung führt
  const targets = [[b.x0 + 25, b.y0 + 25], [b.x1 - 25, b.y0 + 25], [b.x0 + 25, b.y1 - 25], [b.x1 - 25, b.y1 - 25]];
  const doorSide = b.door;
  // Schützen außen vor jeder Wand, die keine Tür hat, in Augen-, Bauch- und Fußhöhe
  const shooters = [];
  if (doorSide !== 'n' && !(b.type === 'warehouse' && doorSide === 's')) shooters.push([cx * 0.7 + b.x0 * 0.3, b.y0 - 60]);
  if (doorSide !== 's' && !(b.type === 'warehouse' && doorSide === 'n')) shooters.push([cx * 0.7 + b.x1 * 0.3, b.y1 + 60]);
  if (doorSide !== 'w' && !(b.type === 'warehouse' && doorSide === 'e')) shooters.push([b.x0 - 60, cy * 0.7 + b.y0 * 0.3]);
  if (doorSide !== 'e' && !(b.type === 'warehouse' && doorSide === 'w')) shooters.push([b.x1 + 60, cy * 0.7 + b.y1 * 0.3]);
  for (const [sx, sy] of shooters) {
    for (const h of [EYE, 30, 5]) {
      for (const [tx, ty] of targets) {
        const r = shoot(sx, sy, g + h, tx, ty, g + 40);
        checked++;
        if (r.hit >= r.d - 1) leaks++;
      }
    }
  }
  // Von oben (Berg/Klippe) steil durchs Dach
  const r = shoot(cx + 40, cy + 30, g + b.wh + 600, cx, cy, g + 40);
  checked++;
  if (r.hit >= r.d - 1) { leaks++; console.log('Dach-Leck', b.type, b.x0, b.y0); }

  // Gegenprobe: gerade durch die Tür muss frei sein (falls kein Hindernis davor)
  const o = { n: [cx, b.y0 - 50], s: [cx, b.y1 + 50], w: [b.x0 - 50, cy], e: [b.x1 + 50, cy] }[doorSide];
  const t = { n: [cx, b.y0 + 30], s: [cx, b.y1 - 30], w: [b.x0 + 30, cy], e: [b.x1 - 30, cy] }[doorSide];
  if (o) {
    const rr = shoot(o[0], o[1], g + EYE, t[0], t[1], g + EYE);
    doorChecks++;
    if (rr.hit < rr.d - 1) doorBlocked++;
  }
}

console.log(`Gebäude: ${world.buildings.length}, Schüsse auf Wände/Dächer: ${checked}, durchgekommen: ${leaks}`);
console.log(`Türen geprüft: ${doorChecks}, davon blockiert (z. B. Baum davor): ${doorBlocked}`);
if (leaks > 0) { console.error('FEHLER: Schüsse gehen durch Wände!'); process.exit(1); }
if (doorBlocked > doorChecks * 0.02) { console.error('FEHLER: zu viele Türen blockiert'); process.exit(1); }
console.log('OK – keine Schüsse durch Wände.');
