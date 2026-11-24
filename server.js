'use strict';
// Storm Royale – Server. Simuliert die Welt autoritativ.
// Koordinaten: x/y = Bodenebene, Höhe getrennt (Gelände + Augenhöhe).
// Schüsse sind Hitscan: ein exakter Strahltest gegen Wände, Dächer, Bäume, Felsen,
// Gelände und Spieler – durch Wände schießen ist damit nicht möglich.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { generateWorld } = require('./world.js');

const PORT = process.env.PORT || 3000;
const SEED = Number(process.env.SEED) || Math.floor(Math.random() * 1e9);
const TICK_HZ = 30;
const SNAP_HZ = 15;
const MAX_TOTAL = 40;          // Spieler + Bots
const PLAYER_R = 18;
const PLAYER_H = 72;
const EYE = 62;
const SPEED = 300;
const SPRINT = 1.55;
const MAX_SLOPE = 1.1;         // steiler bergauf geht nicht (Klippen)
const PICK_R = 32;
const CHEST_R = 80;
const MEDKIT_HEAL = 50;
const SHIELD_MAX = 50;
const RESTART_DELAY = 8000;
const ZONE_START = 8500;
const ZONE_PHASES = [
  { hold: 60, shrink: 50, to: 5000, dps: 2 },
  { hold: 50, shrink: 40, to: 2600, dps: 4 },
  { hold: 40, shrink: 35, to: 1300, dps: 7 },
  { hold: 35, shrink: 30, to: 600,  dps: 10 },
  { hold: 30, shrink: 25, to: 250,  dps: 14 },
  { hold: 25, shrink: 20, to: 40,   dps: 20 },
];

const WEAPONS = {
  pistol:  { dmg: 14, cd: 0.28, range: 900,  spread: 0.02,  pellets: 1, ammo: 0 },
  smg:     { dmg: 8,  cd: 0.07, range: 700,  spread: 0.06,  pellets: 1, ammo: 45 },
  rifle:   { dmg: 12, cd: 0.10, range: 1600, spread: 0.03,  pellets: 1, ammo: 30 },
  shotgun: { dmg: 9,  cd: 0.70, range: 420,  spread: 0.16,  pellets: 7, ammo: 8 },
  sniper:  { dmg: 75, cd: 1.20, range: 4000, spread: 0.002, pellets: 1, ammo: 5 },
};

const PALETTE = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8',
                 '#ff922b', '#20c997', '#f06595', '#94d82d', '#748ffc'];
const BOT_NAMES = ['Fuchs', 'Wolf', 'Pixel', 'Blitz', 'Nova', 'Rex', 'Luna', 'Kira', 'Otto', 'Max',
                   'Ninja', 'Ghost', 'Viper', 'Taco', 'Mika', 'Zed', 'Ruby', 'Jet', 'Echo', 'Kai',
                   'Bruno', 'Yuki', 'Hugo', 'Lia', 'Finn', 'Mats', 'Ida', 'Juna', 'Paul', 'Emil',
                   'Rosa', 'Theo', 'Nele', 'Ben', 'Mila', 'Oskar', 'Lotta', 'Anton', 'Frieda', 'Karl'];

const BOT_LEVELS = {
  easy:   { aim: 0.40, think: [0.6, 1.0],  engage: 500,  fire: 0.5 },
  medium: { aim: 0.20, think: [0.25, 0.5], engage: 800,  fire: 0.9 },
  hard:   { aim: 0.06, think: [0.12, 0.2], engage: 1100, fire: 1 },
};
let botLevel = 'medium';
function setDiff(v) { if (BOT_LEVELS[v]) botLevel = v; }

// ---------- Helfer ----------
let nextId = 1;
const nid = () => nextId++;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// ---------- Welt ----------
console.log(`Erzeuge Welt (Seed ${SEED}) …`);
const world = generateWorld(SEED);
const MAP = world.MAP;
const groundAt = world.heightAt;

// Solids: Kreise (Baumstämme, Felsen) und Quader (Wände, Dächer, Türme)
// jeweils mit Höhenbereich h0..h1
const solids = [];
const GC = 250, GN = Math.ceil(MAP / GC);
const grid = Array.from({ length: GN * GN }, () => []);

function addSolid(s) {
  const id = solids.length;
  solids.push(s);
  const x0 = s.t === 'c' ? s.x - s.r : s.minX, x1 = s.t === 'c' ? s.x + s.r : s.maxX;
  const y0 = s.t === 'c' ? s.y - s.r : s.minY, y1 = s.t === 'c' ? s.y + s.r : s.maxY;
  for (let cy = clamp(Math.floor(y0 / GC), 0, GN - 1); cy <= clamp(Math.floor(y1 / GC), 0, GN - 1); cy++) {
    for (let cx = clamp(Math.floor(x0 / GC), 0, GN - 1); cx <= clamp(Math.floor(x1 / GC), 0, GN - 1); cx++) {
      grid[cy * GN + cx].push(id);
    }
  }
}

for (const b of world.buildings) {
  for (const [minX, maxX, minY, maxY] of b.walls) addSolid({ t: 'b', minX, maxX, minY, maxY, h0: b.g - 20, h1: b.g + b.wh });
  // Dach als Kugelfang (Spieler kommen nicht so hoch)
  if (b.type !== 'tower') {
    const rh = b.roof === 'gable' ? Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.38 : 8;
    addSolid({ t: 'b', minX: b.x0, maxX: b.x1, minY: b.y0, maxY: b.y1, h0: b.g + b.wh, h1: b.g + b.wh + rh });
  }
}
for (const [x, y, s] of world.trees) {
  const g = groundAt(x, y);
  addSolid({ t: 'c', x, y, r: 9 * s, h0: g - 10, h1: g + 130 * s });
}
for (const [x, y, r] of world.rocks) {
  const g = groundAt(x, y);
  addSolid({ t: 'c', x, y, r: r * 0.85, h0: g - 20, h1: g + r * 0.8 });
}
const seen = new Uint32Array(solids.length);
let stamp = 0;

function forSolidsInRect(x0, y0, x1, y1, fn) {
  stamp++;
  const cx0 = clamp(Math.floor(x0 / GC), 0, GN - 1), cx1 = clamp(Math.floor(x1 / GC), 0, GN - 1);
  const cy0 = clamp(Math.floor(y0 / GC), 0, GN - 1), cy1 = clamp(Math.floor(y1 / GC), 0, GN - 1);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (const id of grid[cy * GN + cx]) {
        if (seen[id] === stamp) continue;
        seen[id] = stamp;
        fn(solids[id]);
      }
    }
  }
}

// blockiert ein Solid einen Kreis (r) auf Höhe g..g+PLAYER_H?
function blockedAt(x, y, r) {
  const g = groundAt(x, y);
  let hit = false;
  forSolidsInRect(x - r, y - r, x + r, y + r, s => {
    if (hit || s.h1 < g + 2 || s.h0 > g + PLAYER_H) return;
    if (s.t === 'c') hit = dist(x, y, s.x, s.y) < s.r + r;
    else hit = dist(x, y, clamp(x, s.minX, s.maxX), clamp(y, s.minY, s.maxY)) < r;
  });
  return hit;
}

function slopeAt(x, y) {
  return Math.max(Math.abs(groundAt(x + 30, y) - groundAt(x - 30, y)),
                  Math.abs(groundAt(x, y + 30) - groundAt(x, y - 30))) / 60;
}

// ---------- Strahltests ----------
function rayBox(ox, oy, oh, dx, dy, dh, s, maxT) {
  let t0 = 0, t1 = maxT;
  const axes = [[ox, dx, s.minX, s.maxX], [oy, dy, s.minY, s.maxY], [oh, dh, s.h0, s.h1]];
  for (const [o, d, mn, mx] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < mn || o > mx) return -1;
    } else {
      let a = (mn - o) / d, b = (mx - o) / d;
      if (a > b) { const tmp = a; a = b; b = tmp; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
  }
  return t0;
}

function rayCyl(ox, oy, oh, dx, dy, dh, cx, cy, r, h0, h1, maxT) {
  const fx = ox - cx, fy = oy - cy;
  const a = dx * dx + dy * dy;
  let best = -1;
  if (a > 1e-12) {
    const b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t >= 0 && t <= maxT) {
        const h = oh + dh * t;
        if (h >= h0 && h <= h1) best = t;
      }
    }
  }
  // Treffer von oben durch den Deckel (z. B. von einer Klippe herab)
  if (dh < 0) {
    const t = (h1 - oh) / dh;
    if (t >= 0 && t <= maxT && (best < 0 || t < best)) {
      const x = fx + dx * t, y = fy + dy * t;
      if (x * x + y * y <= r * r) best = t;
    }
  }
  return best;
}

// erster Treffer mit Welt (Solids + Gelände), Rückgabe: Distanz oder maxD
function raycastWorld(ox, oy, oh, dx, dy, dh, maxD) {
  let best = maxD;
  // Solids entlang des Strahls (Rasterzellen um Stützpunkte sammeln)
  stamp++;
  const step = GC * 0.5;
  for (let t = 0; t <= maxD + step && t <= best + step; t += step) {
    const x = ox + dx * Math.min(t, maxD), y = oy + dy * Math.min(t, maxD);
    const cx = Math.floor(x / GC), cy = Math.floor(y / GC);
    for (let yy = cy - 1; yy <= cy + 1; yy++) {
      if (yy < 0 || yy >= GN) continue;
      for (let xx = cx - 1; xx <= cx + 1; xx++) {
        if (xx < 0 || xx >= GN) continue;
        for (const id of grid[yy * GN + xx]) {
          if (seen[id] === stamp) continue;
          seen[id] = stamp;
          const s = solids[id];
          const ht = s.t === 'b'
            ? rayBox(ox, oy, oh, dx, dy, dh, s, best)
            : rayCyl(ox, oy, oh, dx, dy, dh, s.x, s.y, s.r, s.h0, s.h1, best);
          if (ht >= 0 && ht < best) best = ht;
        }
      }
    }
  }
  // Gelände abtasten
  const ts = 10;
  for (let t = ts; t <= best; t += ts) {
    if (oh + dh * t < groundAt(ox + dx * t, oy + dy * t)) {
      let lo = t - ts, hi = t;
      for (let k = 0; k < 6; k++) {
        const m = (lo + hi) / 2;
        if (oh + dh * m < groundAt(ox + dx * m, oy + dy * m)) hi = m; else lo = m;
      }
      best = hi;
      break;
    }
  }
  return best;
}

// Strahl gegen Welt und Spieler
function raycast(ox, oy, oh, dx, dy, dh, maxD, ignoreId) {
  const wt = raycastWorld(ox, oy, oh, dx, dy, dh, maxD);
  let best = wt, ent = null, head = false;
  for (const e of ents.values()) {
    if (!e.alive || e.id === ignoreId) continue;
    const t = rayCyl(ox, oy, oh, dx, dy, dh, e.x, e.y, PLAYER_R, e.g, e.g + PLAYER_H, best);
    if (t >= 0 && t < best) {
      best = t; ent = e;
      head = oh + dh * t >= e.g + PLAYER_H - 16;
    }
  }
  const kind = ent ? 2 : (wt < maxD ? 1 : 0);
  return { t: best, kind, ent, head };
}

function zoneAt(t) {
  let from = ZONE_START, tt = t;
  for (let i = 0; i < ZONE_PHASES.length; i++) {
    const p = ZONE_PHASES[i];
    if (tt < p.hold) return { r: from, st: 'hold', tm: p.hold - tt, ph: i + 1, dps: p.dps };
    tt -= p.hold;
    if (tt < p.shrink) return { r: from + (p.to - from) * (tt / p.shrink), st: 'shrink', tm: p.shrink - tt, ph: i + 1, dps: p.dps };
    tt -= p.shrink;
    from = p.to;
  }
  const last = ZONE_PHASES[ZONE_PHASES.length - 1];
  return { r: last.to, st: 'final', tm: 0, ph: ZONE_PHASES.length, dps: last.dps };
}

// ---------- Spielzustand ----------
let pickups = [];
let pkAdd = [], pkDel = [], pkReset = false;
let events = [];
let matchT = 0;
let endT = null;
let zoneC = { x: MAP / 2, y: MAP / 2 };
let zoneNow = zoneAt(0);
const ents = new Map();
let lastTick = Date.now();
let snapAcc = 0;

function walkable(x, y) {
  return x > 300 && y > 300 && x < MAP - 300 && y < MAP - 300 &&
         groundAt(x, y) < 1400 && slopeAt(x, y) < 0.8 && !blockedAt(x, y, PLAYER_R + 2);
}

function randomWalkable(cx, cy, radius) {
  for (let i = 0; i < 200; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * radius;
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    if (walkable(x, y)) return { x, y };
  }
  return { x: cx, y: cy };
}

function pkJson(p) { return { i: p.id, t: p.type, x: Math.round(p.x), y: Math.round(p.y) }; }
function addPickup(type, x, y, ammo) {
  const p = { id: nid(), type, x, y, ammo: ammo ?? (WEAPONS[type] ? WEAPONS[type].ammo : 0) };
  pickups.push(p);
  pkAdd.push(p);
  return p;
}
function removePickup(p) {
  if (p.dead) return;
  p.dead = true;
  pkDel.push(p.id);
}

const LOOT = ['medkit', 'medkit', 'shield', 'smg', 'smg', 'rifle', 'rifle', 'shotgun', 'sniper'];
const randLoot = () => LOOT[Math.floor(Math.random() * LOOT.length)];

function genPickups() {
  pickups = [];
  pkAdd = []; pkDel = [];
  // draußen: gleichmäßiges Raster über die ganze Karte
  const N = 24, cell = MAP / N;
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      for (let t = 0; t < 12; t++) {
        const x = (gx + Math.random()) * cell, y = (gy + Math.random()) * cell;
        if (!walkable(x, y)) continue;
        addPickup(randLoot(), x, y);
        break;
      }
    }
  }
  // in Gebäuden: Beute und Truhen
  for (const b of world.buildings) {
    if (b.type === 'tower') continue;
    const n = b.type === 'apartment' || b.type === 'warehouse' ? 3 : 1 + (Math.random() < 0.5 ? 1 : 0);
    const chests = b.type === 'warehouse' ? 2 : (Math.random() < 0.45 ? 1 : 0);
    const spots = [];
    for (let t = 0; t < 40 && spots.length < n + chests; t++) {
      const x = rand(b.x0 + 30, b.x1 - 30), y = rand(b.y0 + 30, b.y1 - 30);
      if (blockedAt(x, y, 16) || spots.some(s => dist(s.x, s.y, x, y) < 40)) continue;
      spots.push({ x, y });
    }
    spots.forEach((s, i) => addPickup(i < chests ? 'chest' : randLoot(), s.x, s.y));
  }
  // ein paar Truhen in der Wildnis
  for (let i = 0; i < 40; i++) {
    const p = randomWalkable(MAP / 2, MAP / 2, MAP * 0.48);
    addPickup('chest', p.x, p.y);
  }
  pkReset = true;
}

// Spawn: Kandidat mit größtem Abstand zu anderen Spielern, innerhalb der Zone
function spawnPoint(e) {
  const others = [...ents.values()].filter(o => o !== e && o.alive);
  let best = null, bestD = -1;
  for (let i = 0; i < 30; i++) {
    const p = randomWalkable(zoneC.x, zoneC.y, Math.min(zoneNow.r * 0.85, MAP * 0.45));
    let md = Infinity;
    for (const o of others) md = Math.min(md, dist(p.x, p.y, o.x, o.y));
    if (md > bestD) { bestD = md; best = p; }
  }
  return best;
}

function resolve(e) {
  for (let it = 0; it < 2; it++) {
    forSolidsInRect(e.x - PLAYER_R - 2, e.y - PLAYER_R - 2, e.x + PLAYER_R + 2, e.y + PLAYER_R + 2, s => {
      if (s.h1 < e.g + 2 || s.h0 > e.g + PLAYER_H) return;
      if (s.t === 'c') {
        const dx = e.x - s.x, dy = e.y - s.y, d = Math.hypot(dx, dy), min = s.r + PLAYER_R;
        if (d < min) {
          if (d > 0.001) { const k = (min - d) / d; e.x += dx * k; e.y += dy * k; }
          else e.x += min;
        }
      } else {
        const cx = clamp(e.x, s.minX, s.maxX), cy = clamp(e.y, s.minY, s.maxY);
        const dx = e.x - cx, dy = e.y - cy, d = Math.hypot(dx, dy);
        if (d < PLAYER_R) {
          if (d > 0.001) {
            const k = (PLAYER_R - d) / d;
            e.x += dx * k; e.y += dy * k;
          } else {
            const l = e.x - s.minX, r = s.maxX - e.x, dn = e.y - s.minY, up = s.maxY - e.y;
            const m = Math.min(l, r, dn, up);
            if (m === l) e.x = s.minX - PLAYER_R;
            else if (m === r) e.x = s.maxX + PLAYER_R;
            else if (m === dn) e.y = s.minY - PLAYER_R;
            else e.y = s.maxY + PLAYER_R;
          }
        }
      }
    });
  }
  e.x = clamp(e.x, PLAYER_R, MAP - PLAYER_R);
  e.y = clamp(e.y, PLAYER_R, MAP - PLAYER_R);
  e.g = groundAt(e.x, e.y);
}

// Schritt auf dem Gelände: zu steil bergauf (Klippe) ist blockiert
function moveEntity(e, mx, my) {
  const tryMove = (dx, dy) => {
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return true;
    const nx = clamp(e.x + dx, PLAYER_R, MAP - PLAYER_R), ny = clamp(e.y + dy, PLAYER_R, MAP - PLAYER_R);
    const g1 = groundAt(nx, ny);
    if (g1 - e.g > d * MAX_SLOPE + 1) return false;
    e.x = nx; e.y = ny; e.g = g1;
    return true;
  };
  if (!tryMove(mx, my)) { if (!tryMove(mx, 0)) tryMove(0, my); }
  resolve(e);
}

// ---------- Entities ----------
function resetEntity(e) {
  const p = spawnPoint(e);
  e.x = p.x; e.y = p.y; e.g = groundAt(e.x, e.y);
  e.ang = Math.atan2(zoneC.y - e.y, zoneC.x - e.x);
  e.hp = 100; e.shield = 0; e.alive = true; e.kills = 0;
  e.weapon = 'pistol'; e.ammo = Infinity; e.cd = 0;
  e.input = { mx: 0, my: 0, ang: e.ang, pitch: 0, shoot: false, use: false, sprint: false };
  e.mode = 'wander'; e.goal = null; e.target = null; e.think = Math.random() * 0.5;
  e.px = e.x; e.py = e.y;
}

function makeEntity(name, isBot) {
  const e = {
    id: nid(), name, isBot, ws: null,
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    aimOff: 0, strafe: Math.random() < 0.5 ? 1 : -1,
  };
  resetEntity(e);
  ents.set(e.id, e);
  return e;
}

function addBot() {
  const used = new Set([...ents.values()].map(e => e.name));
  const pool = BOT_NAMES.filter(n => !used.has(n));
  const name = pool.length ? pool[Math.floor(Math.random() * pool.length)] : 'Bot' + nid();
  return makeEntity(name, true);
}
function fillBots() { while (ents.size < MAX_TOTAL) addBot(); }
function removeOneBot() {
  let victim = null;
  for (const e of ents.values()) {
    if (!e.isBot) continue;
    if (!e.alive) { victim = e; break; }
    if (!victim) victim = e;
  }
  if (victim) ents.delete(victim.id);
}

function nearestPickup(e, pred, maxd) {
  let best = null, bd = maxd;
  for (const p of pickups) {
    if (p.dead || !pred(p)) continue;
    const d = Math.abs(p.x - e.x) + Math.abs(p.y - e.y);
    if (d > bd * 1.5) continue;
    const dd = dist(e.x, e.y, p.x, p.y);
    if (dd < bd) { bd = dd; best = p; }
  }
  return best;
}

function dropWeapon(e) {
  if (e.weapon === 'pistol' || !(e.ammo > 0)) return;
  const p = addPickup(e.weapon, e.x, e.y, e.ammo);
  p.noPick = e.id; p.noPickUntil = matchT + 2;
}

function pickupCheck(e) {
  for (const p of pickups) {
    if (p.dead || p.type === 'chest') continue;
    if (Math.abs(p.x - e.x) > PICK_R || Math.abs(p.y - e.y) > PICK_R) continue;
    if (dist(e.x, e.y, p.x, p.y) > PICK_R) continue;
    if (p.noPick === e.id && matchT < p.noPickUntil) continue;
    if (p.type === 'medkit') {
      if (e.hp >= 100) continue;
      e.hp = Math.min(100, e.hp + MEDKIT_HEAL);
    } else if (p.type === 'shield') {
      if (e.shield >= SHIELD_MAX) continue;
      e.shield = Math.min(SHIELD_MAX, e.shield + 50);
    } else if (e.weapon === p.type) {
      e.ammo += p.ammo;
    } else {
      dropWeapon(e);
      e.weapon = p.type;
      e.ammo = p.ammo;
    }
    removePickup(p);
  }
}

function openChest(e) {
  let best = null, bd = CHEST_R;
  for (const p of pickups) {
    if (p.dead || p.type !== 'chest') continue;
    const d = dist(e.x, e.y, p.x, p.y);
    if (d < bd) { bd = d; best = p; }
  }
  if (!best) return;
  removePickup(best);
  const loot = ['rifle', 'shotgun', 'smg', 'sniper', 'medkit', 'shield', 'smg', 'rifle'];
  for (let k = 0; k < 3; k++) {
    let x = best.x, y = best.y;
    for (let t = 0; t < 10; t++) {
      const cx = best.x + rand(-28, 28), cy = best.y + rand(-28, 28);
      if (!blockedAt(cx, cy, 10)) { x = cx; y = cy; break; }
    }
    addPickup(loot[Math.floor(Math.random() * loot.length)], x, y);
  }
  events.push({ t: 'open', x: Math.round(best.x), y: Math.round(best.y), by: e.id });
}

function hurt(e, dmg, killer, cause) {
  if (!e.alive) return;
  if (e.shield > 0) {
    const absorbed = Math.min(e.shield, dmg);
    e.shield -= absorbed;
    dmg -= absorbed;
  }
  e.hp -= dmg;
  if (e.hp > 0) return;
  e.hp = 0;
  e.alive = false;
  if (killer && killer !== e) killer.kills++;
  events.push({ t: 'kill', k: killer ? killer.name : (cause || 'Unbekannt'), v: e.name, z: killer ? 0 : 1 });
  dropWeapon(e);
}

function fire(e) {
  const w = WEAPONS[e.weapon];
  e.cd = w.cd;
  if (e.weapon !== 'pistol') {
    e.ammo -= 1;
    if (e.ammo <= 0) { e.weapon = 'pistol'; e.ammo = Infinity; }
  }
  const ox = e.x, oy = e.y, oh = e.g + EYE;
  const ends = [];
  for (let i = 0; i < w.pellets; i++) {
    const aa = e.ang + (Math.random() - 0.5) * 2 * w.spread;
    const pp = e.input.pitch + (Math.random() - 0.5) * 2 * w.spread * 0.6;
    const cp = Math.cos(pp);
    const dx = Math.cos(aa) * cp, dy = Math.sin(aa) * cp, dh = Math.sin(pp);
    const r = raycast(ox, oy, oh, dx, dy, dh, w.range, e.id);
    const ex = ox + dx * r.t, ey = oy + dy * r.t, eh = oh + dh * r.t;
    if (r.kind === 2) {
      events.push({ t: 'hit', x: Math.round(ex), y: Math.round(ey), h: Math.round(eh), v: r.ent.id, s: e.id, hd: r.head });
      hurt(r.ent, r.head ? w.dmg * 2 : w.dmg, e, 'Unbekannt');
    }
    ends.push([Math.round(ex), Math.round(ey), Math.round(eh), r.kind]);
  }
  events.push({ t: 'shot', o: e.id, x: Math.round(ox), y: Math.round(oy), h: Math.round(oh), e: ends });
}

// ---------- Bot-KI ----------
function hasLOS(e, t) {
  const oh = e.g + EYE, th = t.g + 45;
  const dx = t.x - e.x, dy = t.y - e.y, dh = th - oh;
  const d = Math.hypot(dx, dy, dh);
  if (d < 1) return true;
  return raycastWorld(e.x, e.y, oh, dx / d, dy / d, dh / d, d) >= d - 1;
}

function botThink(e, dt) {
  e.think -= dt;
  const L = BOT_LEVELS[botLevel];
  if (e.think <= 0) {
    e.think = L.think[0] + Math.random() * (L.think[1] - L.think[0]);
    e.aimOff = (Math.random() - 0.5) * L.aim;

    // nächster sichtbarer Gegner
    const cands = [];
    for (const o of ents.values()) {
      if (o === e || !o.alive) continue;
      const d = dist(e.x, e.y, o.x, o.y);
      if (d < L.engage) cands.push([d, o]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    let target = null;
    for (const [, o] of cands.slice(0, 3)) { if (hasLOS(e, o)) { target = o; break; } }

    let g;
    const inZone = dist(e.x, e.y, zoneC.x, zoneC.y) < zoneNow.r - 100;
    const stuck = dist(e.x, e.y, e.px, e.py) < 15 && e.mode !== 'fight';
    e.px = e.x; e.py = e.y;

    if (!inZone && !stuck) {
      e.mode = 'zone'; e.goal = { x: zoneC.x, y: zoneC.y }; e.target = null;
    } else if (target) {
      e.mode = 'fight'; e.target = target; e.goal = null;
    } else if (e.hp < 55 && (g = nearestPickup(e, p => p.type === 'medkit', 900))) {
      e.mode = 'loot'; e.goal = g; e.target = null;
    } else if (e.shield < 20 && (g = nearestPickup(e, p => p.type === 'shield', 700))) {
      e.mode = 'loot'; e.goal = g; e.target = null;
    } else if (e.weapon === 'pistol' && (g = nearestPickup(e, p => p.type === 'chest' || (!!WEAPONS[p.type] && p.type !== 'pistol'), 900))) {
      e.mode = 'loot'; e.goal = g; e.target = null;
    } else if (e.mode !== 'wander' || !e.goal || stuck || dist(e.goal.x, e.goal.y, e.x, e.y) < 50) {
      e.mode = 'wander'; e.target = null;
      // Ziel in der Nähe, aber in der Zone
      const toward = inZone ? { x: e.x, y: e.y } : { x: (e.x + zoneC.x) / 2, y: (e.y + zoneC.y) / 2 };
      e.goal = randomWalkable(toward.x, toward.y, stuck ? 400 : 1000);
      if (dist(e.goal.x, e.goal.y, zoneC.x, zoneC.y) > zoneNow.r) e.goal = { x: zoneC.x, y: zoneC.y };
    }
  }

  let wx = 0, wy = 0, shoot = false, use = false;
  if (e.mode === 'fight' && e.target && e.target.alive) {
    const t = e.target;
    const dx = t.x - e.x, dy = t.y - e.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    e.ang = Math.atan2(dy, dx) + e.aimOff;
    e.input.pitch = Math.atan2((t.g + 45) - (e.g + EYE), d) + e.aimOff * 0.3;
    if (d > 300) { wx = dx / d; wy = dy / d; }
    else { wx = -dy / d * e.strafe; wy = dx / d * e.strafe; if (Math.random() < 0.02) e.strafe *= -1; }
    shoot = d < WEAPONS[e.weapon].range * 0.9 && Math.random() < L.fire;
  } else {
    const g = e.goal || zoneC;
    const dx = g.x - e.x, dy = g.y - e.y;
    const d = Math.hypot(dx, dy);
    if (d > 8) { wx = dx / d; wy = dy / d; }
    e.ang = Math.atan2(dy, dx);
    e.input.pitch = 0;
    if (e.goal && e.goal.type === 'chest' && d < CHEST_R - 10) use = true;
  }
  const fx = Math.cos(e.ang), fy = Math.sin(e.ang);
  e.input.ang = e.ang;
  e.input.my = wx * fx + wy * fy;
  e.input.mx = -wx * fy + wy * fx;
  e.input.shoot = shoot;
  e.input.use = use;
  e.input.sprint = e.mode === 'zone';
}

// ---------- Simulation ----------
function simulate(dt) {
  matchT += dt;
  zoneNow = zoneAt(matchT);

  for (const e of ents.values()) {
    if (!e.alive) continue;
    if (e.isBot) botThink(e, dt);
    if (e.input.use) { e.input.use = false; openChest(e); }

    let mx = e.input.mx, my = e.input.my;
    const ml = Math.hypot(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; }
    e.ang = e.input.ang;
    const fx = Math.cos(e.ang), fy = Math.sin(e.ang);
    const sp = SPEED * (e.input.sprint && my > 0 ? SPRINT : 1) * dt;
    moveEntity(e, (fx * my - fy * mx) * sp, (fy * my + fx * mx) * sp);

    e.cd = Math.max(0, e.cd - dt);
    if (e.input.shoot && e.cd <= 0) fire(e);

    pickupCheck(e);
    if (dist(e.x, e.y, zoneC.x, zoneC.y) > zoneNow.r) hurt(e, zoneNow.dps * dt, null, 'Zone');
  }

  if (pkDel.length > 50 || pickups.length > 3000) pickups = pickups.filter(p => !p.dead);

  if (ents.size > 1) {
    const alive = [...ents.values()].filter(e => e.alive);
    if (alive.length <= 1) {
      const w = alive[0];
      events.push({ t: 'end', w: w ? w.name : 'Niemand', h: !!(w && !w.isBot) });
      endT = Date.now() + RESTART_DELAY;
    }
  }
}

function resetMatch() {
  endT = null;
  matchT = 0;
  zoneC = { x: rand(MAP * 0.3, MAP * 0.7), y: rand(MAP * 0.3, MAP * 0.7) };
  zoneNow = zoneAt(0);
  events.push({ t: 'start' });
  for (const e of [...ents.values()]) {
    if (e.isBot) ents.delete(e.id);
    else resetEntity(e);
  }
  genPickups();
  fillBots();
}

// ---------- Snapshots ----------
function snapshot() {
  const ps = [];
  for (const e of ents.values()) {
    ps.push({
      i: e.id, n: e.name,
      x: Math.round(e.x), y: Math.round(e.y),
      a: +e.input.ang.toFixed(3), pt: +e.input.pitch.toFixed(3),
      h: Math.ceil(e.hp), sh: Math.ceil(e.shield), w: e.weapon,
      am: Number.isFinite(e.ammo) ? e.ammo : -1,
      al: e.alive ? 1 : 0, k: e.kills, b: e.isBot ? 1 : 0, c: e.color,
    });
  }
  const msg = {
    t: 's', tm: +matchT.toFixed(1),
    z: { x: Math.round(zoneC.x), y: Math.round(zoneC.y), r: Math.round(zoneNow.r), st: zoneNow.st, tm: +zoneNow.tm.toFixed(1), ph: zoneNow.ph, n: ZONE_PHASES.length },
    al: ps.filter(p => p.al).length,
    ps, ev: events,
  };
  if (pkReset) {
    msg.pk = pickups.filter(p => !p.dead).map(pkJson);
    pkReset = false;
  } else {
    if (pkAdd.length) msg.pa = pkAdd.filter(p => !p.dead).map(pkJson);
    if (pkDel.length) msg.pr = pkDel;
  }
  pkAdd = []; pkDel = [];
  events = [];
  return JSON.stringify(msg);
}

// Welt einmal serialisieren (für jeden Spieler gleich)
const WORLD_JSON = JSON.stringify({
  map: MAP, grid: world.GRID, seed: SEED,
  hm: Buffer.from(world.heights.buffer, world.heights.byteOffset, world.heights.byteLength).toString('base64'),
  pois: world.pois.map(p => ({ n: p.name, k: p.kind, x: p.x, y: p.y, r: p.r, g: p.g })),
  roads: world.roads.map(r => ({ t: r.type, w: r.w, p: r.pts })),
  buildings: world.buildings.map(b => ({
    t: b.type, x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, g: b.g, wh: b.wh, d: b.door,
    rf: b.roof, m: b.mat, rm: b.roofMat, rg: b.ridge, w: b.walls,
  })),
  trees: world.trees, rocks: world.rocks,
});

// ---------- HTTP + WebSocket ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
               '.jpg': 'image/jpeg', '.png': 'image/png', '.md': 'text/plain; charset=utf-8' };
const PUBLIC = path.join(__dirname, 'public');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  }
  return out;
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/vendor/three.module.js') return serveFile(res, path.join(THREE_DIR, 'build', 'three.module.js'));
  if (urlPath.startsWith('/vendor/addons/')) {
    const file = path.normalize(path.join(THREE_DIR, 'examples', 'jsm', urlPath.slice('/vendor/addons/'.length)));
    if (!file.startsWith(path.join(THREE_DIR, 'examples', 'jsm'))) { res.writeHead(403); return res.end(); }
    return serveFile(res, file);
  }
  if (urlPath === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ urls: lanUrls() }));
  }
  const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? '/index.html' : urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  serveFile(res, file);
});

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'diff') { setDiff(m.v); return; }

    if (m.t === 'join' && !ws.entity) {
      setDiff(m.d);
      const name = String(m.name || 'Spieler').replace(/[<>]/g, '').trim().slice(0, 14) || 'Spieler';
      const e = makeEntity(name, false);
      e.ws = ws;
      ws.entity = e;
      while (ents.size > MAX_TOTAL && [...ents.values()].some(x => x.isBot)) removeOneBot();
      const pk = JSON.stringify(pickups.filter(p => !p.dead).map(pkJson));
      if (ws.readyState === 1) ws.send(`{"t":"welcome","id":${e.id},"world":${WORLD_JSON},"pk":${pk}}`);
      return;
    }

    if (!ws.entity) return;
    const inp = ws.entity.input;
    if (m.t === 'in') {
      inp.mx = clamp(Number(m.mx) || 0, -1, 1);
      inp.my = clamp(Number(m.my) || 0, -1, 1);
      inp.ang = Number(m.a) || 0;
      inp.pitch = clamp(Number(m.pt) || 0, -1.45, 1.45);
      inp.shoot = !!m.s;
      inp.sprint = !!m.sp;
    } else if (m.t === 'use') {
      inp.use = true;
    }
  });
  ws.on('close', () => { if (ws.entity) ents.delete(ws.entity.id); });
});

function broadcast(str) {
  for (const c of wss.clients) if (c.readyState === 1) c.send(str);
}

function tick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;
  if (endT !== null) {
    if (now >= endT) resetMatch();
  } else {
    simulate(dt);
  }
  snapAcc += dt;
  if (snapAcc >= 1 / SNAP_HZ) {
    snapAcc = 0;
    broadcast(snapshot());
  }
}

// Für Tests: beim Import (require) nicht starten, nur die Funktionen bereitstellen
module.exports = { world, solids, raycast, raycastWorld, blockedAt, groundAt, WEAPONS };
if (require.main === module) start();

function start() {
resetMatch();
setInterval(tick, 1000 / TICK_HZ);

// PID-Datei: damit update.sh / update.ps1 den laufenden Server finden und stoppen können
const PID_FILE = path.join(__dirname, '.server.pid');
function removePidFile() {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch { /* Datei existiert nicht – egal */ }
}
process.on('exit', removePidFile);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} ist schon belegt – läuft der Server bereits?`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  console.log(`Storm Royale läuft auf http://localhost:${PORT}`);
  console.log(`Welt: ${world.pois.length} Orte, ${world.buildings.length} Gebäude, ${world.trees.length} Bäume, Seed ${SEED}`);
  const lan = lanUrls();
  if (lan.length) {
    console.log('Einladen (gleiches Netzwerk):');
    for (const u of lan) console.log('  ' + u);
  }
});
}
