'use strict';
// Storm Royale – Server (3D-Welt, 2D-Physik auf der Bodenebene).
// Koordinaten: x/y = Bodenebene, h = Höhe. Blickrichtung: yaw (a) und pitch (pt).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAP = 4000;
const CX = 2000, CY = 2000;
const TICK_HZ = 30;
const SNAP_HZ = 15;
const MAX_TOTAL = 24;          // Spieler + Bots
const PLAYER_R = 18;
const PLAYER_H = 72;
const EYE = 62;                // Augenhöhe
const SPEED = 260;
const PICK_R = 30;
const CHEST_R = 70;            // Reichweite zum Öffnen einer Truhe
const MEDKIT_HEAL = 50;
const SHIELD_MAX = 50;
const RESTART_DELAY = 8000;
const WALL_H = 130, WALL_T = 8, DOOR_W = 40;
const ZONE_START = 2800;
const ZONE_PHASES = [
  { hold: 40, shrink: 30, to: 1400, dps: 3 },
  { hold: 30, shrink: 25, to: 700,  dps: 6 },
  { hold: 25, shrink: 20, to: 300,  dps: 10 },
  { hold: 20, shrink: 15, to: 40,   dps: 16 },
];

const WEAPONS = {
  pistol:  { dmg: 14, cd: 0.28, speed: 900,  range: 700,  spread: 0.03,  pellets: 1, ammo: 0 },
  smg:     { dmg: 8,  cd: 0.07, speed: 1000, range: 600,  spread: 0.09,  pellets: 1, ammo: 45 },
  rifle:   { dmg: 11, cd: 0.10, speed: 1100, range: 900,  spread: 0.06,  pellets: 1, ammo: 30 },
  shotgun: { dmg: 9,  cd: 0.70, speed: 800,  range: 380,  spread: 0.22,  pellets: 6, ammo: 8 },
  sniper:  { dmg: 70, cd: 1.20, speed: 1800, range: 1400, spread: 0.005, pellets: 1, ammo: 5 },
};

// Benannte Orte auf der Karte (Mitte, Radius, Anzahl Häuser)
const POIS = [
  { name: 'Stadt',         x: 2000, y: 2000, r: 380, houses: 14 },
  { name: 'Leuchtturm',    x: 420,  y: 420,  r: 200, houses: 3 },
  { name: 'Fabrik',        x: 3200, y: 700,  r: 260, houses: 6 },
  { name: 'Dorf Nord',     x: 1900, y: 3300, r: 300, houses: 8 },
  { name: 'Farm',          x: 700,  y: 2600, r: 240, houses: 5 },
  { name: 'Hafenviertel',  x: 3300, y: 3200, r: 240, houses: 6 },
  { name: 'Wald-Lichtung', x: 600,  y: 1200, r: 180, houses: 2 },
  { name: 'Bergdorf',      x: 3000, y: 1800, r: 220, houses: 5 },
];

const PALETTE = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8',
                 '#ff922b', '#20c997', '#f06595', '#94d82d', '#748ffc'];
const BOT_NAMES = ['Fuchs', 'Wolf', 'Pixel', 'Blitz', 'Nova', 'Rex', 'Luna', 'Kira',
                   'Otto', 'Max', 'Ninja', 'Ghost', 'Viper', 'Taco', 'Mika', 'Zed',
                   'Ruby', 'Jet', 'Echo', 'Kai', 'Bruno', 'Yuki', 'Hugo', 'Lia'];

// Bot-Stärke: wirkt auf alle Bots sofort
const BOT_LEVELS = {
  easy:   { aim: 0.45, think: [0.6, 1.0],  engage: 420, fire: 0.5 },
  medium: { aim: 0.24, think: [0.25, 0.5], engage: 650, fire: 1 },
  hard:   { aim: 0.07, think: [0.12, 0.2], engage: 850, fire: 1 },
};
let botLevel = 'medium';
function setDiff(v) { if (BOT_LEVELS[v]) botLevel = v; }

// ---------- Helfer ----------
let nextId = 1;
const nid = () => nextId++;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function zoneAt(t) {
  let from = ZONE_START, tt = t;
  for (let i = 0; i < ZONE_PHASES.length; i++) {
    const p = ZONE_PHASES[i];
    if (tt < p.hold) return { r: from, st: 'hold', tm: p.hold - tt, ph: i + 1, dps: p.dps };
    tt -= p.hold;
    if (tt < p.shrink) {
      return { r: from + (p.to - from) * (tt / p.shrink), st: 'shrink', tm: p.shrink - tt, ph: i + 1, dps: p.dps };
    }
    tt -= p.shrink;
    from = p.to;
  }
  const last = ZONE_PHASES[ZONE_PHASES.length - 1];
  return { r: last.to, st: 'final', tm: 0, ph: ZONE_PHASES.length, dps: last.dps };
}

// ---------- Welt: Solids (Kreise = Bäume/Felsen, Boxen = Hauswände) ----------
let solids = [];
let chestSpots = [];
let pickups = [];      // inkl. Truhen (type 'chest')
let bullets = [];
let events = [];
let pkDirty = true;
let matchT = 0;
let endT = null;
let zoneNow = zoneAt(0);
const ents = new Map();
let lastTick = Date.now();
let snapAcc = 0;

function blockedAt(x, y, r) {
  for (const s of solids) {
    if (s.t === 'c') {
      if (dist(x, y, s.x, s.y) < s.r + r) return true;
    } else {
      const cx = clamp(x, s.minX, s.maxX), cy = clamp(y, s.minY, s.maxY);
      if (dist(x, y, cx, cy) < r) return true;
    }
  }
  return false;
}

function boxOverlaps(b, margin) {
  for (const s of solids) {
    if (s.t === 'b') {
      if (b.minX < s.maxX + margin && b.maxX > s.minX - margin &&
          b.minY < s.maxY + margin && b.maxY > s.minY - margin) return true;
    } else {
      const cx = clamp(s.x, b.minX, b.maxX), cy = clamp(s.y, b.minY, b.maxY);
      if (dist(s.x, s.y, cx, cy) < s.r + margin) return true;
    }
  }
  return false;
}

function addHouse(b) {
  const T = WALL_T, H = WALL_H, cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  solids.push({ t: 'b', minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.minY + T, h: H });   // Nord
  solids.push({ t: 'b', minX: b.minX, maxX: b.minX + T, minY: b.minY, maxY: b.maxY, h: H });   // West
  solids.push({ t: 'b', minX: b.maxX - T, maxX: b.maxX, minY: b.minY, maxY: b.maxY, h: H });   // Ost
  // Süd mit Tür in der Mitte
  solids.push({ t: 'b', minX: b.minX, maxX: cx - DOOR_W / 2, minY: b.maxY - T, maxY: b.maxY, h: H });
  solids.push({ t: 'b', minX: cx + DOOR_W / 2, maxX: b.maxX, minY: b.maxY - T, maxY: b.maxY, h: H });
  if (Math.random() < 0.6) chestSpots.push({ x: cx + rand(-15, 15), y: cy + rand(-10, 10) });
}

function genWorld() {
  solids = [];
  chestSpots = [];
  // Häuser in den Orten
  for (const poi of POIS) {
    let placed = 0;
    for (let t = 0; t < poi.houses * 80 && placed < poi.houses; t++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * poi.r;
      const cx = poi.x + Math.cos(a) * d, cy = poi.y + Math.sin(a) * d;
      const w = rand(70, 100), h = rand(55, 80);
      const b = { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2 };
      if (b.minX < 60 || b.maxX > MAP - 60 || b.minY < 60 || b.maxY > MAP - 60) continue;
      if (boxOverlaps(b, 24)) continue;
      addHouse(b);
      placed++;
    }
  }
  // Bäume und Felsen, verstreut
  let trees = 0;
  for (let t = 0; t < 3000 && trees < 520; t++) {
    const x = rand(40, MAP - 40), y = rand(40, MAP - 40);
    const rock = Math.random() < 0.25;
    const r = rock ? rand(16, 28) : rand(20, 32);
    if (dist(x, y, CX, CY) < 120) continue;
    if (blockedAt(x, y, r + 14)) continue;
    solids.push({ t: 'c', x, y, r, h: rock ? 40 : 110 });
    trees++;
  }
  // Zusätzliche Truhen draußen
  for (let i = 0; i < 16; i++) {
    const p = randomFree(20, 2200);
    chestSpots.push(p);
  }
}

// freier Punkt im Kreis um die Mitte
function randomFree(r, radius) {
  for (let i = 0; i < 300; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * radius;
    const x = clamp(CX + Math.cos(a) * d, r, MAP - r);
    const y = clamp(CY + Math.sin(a) * d, r, MAP - r);
    if (!blockedAt(x, y, r)) return { x, y };
  }
  return { x: CX, y: CY };
}

function inSolid(x, y, h) {
  for (const s of solids) {
    if (h >= s.h) continue;
    if (s.t === 'c') {
      if (dist(x, y, s.x, s.y) < s.r) return true;
    } else if (x >= s.minX && x <= s.maxX && y >= s.minY && y <= s.maxY) {
      return true;
    }
  }
  return false;
}

// Pickups: Raster über die ganze Karte, pro Zelle genau ein Pickup
function genPickups() {
  pickups = [];
  const pool = ['medkit', 'medkit', 'shield', 'smg', 'smg', 'rifle', 'rifle', 'shotgun', 'sniper'];
  const N = 12, margin = 200, cell = (MAP - 2 * margin) / N;
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      let p = null;
      for (let t = 0; t < 40 && !p; t++) {
        const x = margin + (gx + Math.random()) * cell;
        const y = margin + (gy + Math.random()) * cell;
        if (!blockedAt(x, y, 12)) p = { x, y };
      }
      if (!p) continue;
      const type = pool[Math.floor(Math.random() * pool.length)];
      pickups.push({ id: nid(), type, x: p.x, y: p.y, ammo: WEAPONS[type] ? WEAPONS[type].ammo : 0 });
    }
  }
  // Truhen (in Häusern und draußen)
  for (const c of chestSpots) {
    pickups.push({ id: nid(), type: 'chest', x: c.x, y: c.y, ammo: 0 });
  }
  pkDirty = true;
}

function pkList() {
  return pickups.map(p => ({ i: p.id, t: p.type, x: Math.round(p.x), y: Math.round(p.y) }));
}

// Spawn: von 30 Kandidaten im Zonenbereich den nehmen, der am weitesten
// von allen lebenden Spielern entfernt ist.
function spawnPoint(e) {
  const others = [...ents.values()].filter(o => o !== e && o.alive);
  const rad = Math.max(200, zoneNow.r * 0.85);
  let best = null, bestD = -1;
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * rad;
    const x = CX + Math.cos(a) * d, y = CY + Math.sin(a) * d;
    if (x < PLAYER_R || x > MAP - PLAYER_R || y < PLAYER_R || y > MAP - PLAYER_R) continue;
    if (blockedAt(x, y, PLAYER_R)) continue;
    let md = Infinity;
    for (const o of others) md = Math.min(md, dist(x, y, o.x, o.y));
    if (md > bestD) { bestD = md; best = { x, y }; }
  }
  return best || randomFree(PLAYER_R, 1400);
}

function resolve(e) {
  for (let it = 0; it < 2; it++) {
    for (const s of solids) {
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
            // im Quader: an der nächsten Seite herausschieben
            const left = e.x - s.minX, right = s.maxX - e.x, down = e.y - s.minY, up = s.maxY - e.y;
            const m = Math.min(left, right, down, up);
            if (m === left) e.x = s.minX - PLAYER_R;
            else if (m === right) e.x = s.maxX + PLAYER_R;
            else if (m === down) e.y = s.minY - PLAYER_R;
            else e.y = s.maxY + PLAYER_R;
          }
        }
      }
    }
  }
  e.x = clamp(e.x, PLAYER_R, MAP - PLAYER_R);
  e.y = clamp(e.y, PLAYER_R, MAP - PLAYER_R);
}

// ---------- Entities ----------
function resetEntity(e) {
  const p = spawnPoint(e);
  e.x = p.x; e.y = p.y;
  e.ang = Math.atan2(CY - e.y, CX - e.x);
  e.hp = 100;
  e.shield = 0;
  e.alive = true;
  e.kills = 0;
  e.weapon = 'pistol';
  e.ammo = Infinity;
  e.cd = 0;
  e.input = { mx: 0, my: 0, ang: e.ang, pitch: 0, shoot: false, use: false };
  e.mode = 'wander';
  e.goal = null;
  e.target = null;
  e.think = 0;
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

function fillBots() {
  while (ents.size < MAX_TOTAL) addBot();
}

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
    const d = dist(e.x, e.y, p.x, p.y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function dropWeapon(e) {
  if (e.weapon === 'pistol' || !(e.ammo > 0)) return;
  pickups.push({ id: nid(), type: e.weapon, x: e.x, y: e.y, ammo: e.ammo, noPick: e.id, noPickUntil: matchT + 2 });
  pkDirty = true;
}

function pickupCheck(e) {
  for (const p of pickups.slice()) {
    if (p.dead || p.type === 'chest') continue;
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
    p.dead = true;
    pkDirty = true;
  }
}

// Truhe öffnen: nächste Truhe in Reichweite -> 3 Beute-Items
function openChest(e) {
  let best = null, bd = CHEST_R;
  for (const p of pickups) {
    if (p.dead || p.type !== 'chest') continue;
    const d = dist(e.x, e.y, p.x, p.y);
    if (d < bd) { bd = d; best = p; }
  }
  if (!best) return;
  best.dead = true;
  pkDirty = true;
  const loot = ['rifle', 'shotgun', 'smg', 'sniper', 'medkit', 'shield', 'smg', 'rifle'];
  for (let k = 0; k < 3; k++) {
    const type = loot[Math.floor(Math.random() * loot.length)];
    pickups.push({ id: nid(), type, x: best.x + rand(-25, 25), y: best.y + rand(-25, 25),
                   ammo: WEAPONS[type] ? WEAPONS[type].ammo : 0 });
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
  const a = e.ang, p = e.input.pitch;
  const ox = e.x + Math.cos(a) * (PLAYER_R + 4);
  const oy = e.y + Math.sin(a) * (PLAYER_R + 4);
  const oh = EYE - 8;
  for (let i = 0; i < w.pellets; i++) {
    const aa = a + (Math.random() - 0.5) * 2 * w.spread;
    const pp = p + (Math.random() - 0.5) * w.spread * 0.6;
    const v = w.speed;
    bullets.push({
      x: ox, y: oy, h: oh,
      vx: Math.cos(aa) * Math.cos(pp) * v,
      vy: Math.sin(aa) * Math.cos(pp) * v,
      vh: Math.sin(pp) * v,
      owner: e.id, dmg: w.dmg, life: w.range / w.speed, dead: false,
    });
  }
  events.push({ t: 'shot', x: Math.round(ox), y: Math.round(oy), h: Math.round(oh),
                a: +a.toFixed(3), p: +p.toFixed(3), n: w.pellets, sp: w.speed, r: w.range, sd: w.spread, o: e.id });
}

function updateBullets(dt) {
  for (const b of bullets) {
    const steps = 3;
    for (let s = 0; s < steps && !b.dead; s++) {
      b.x += b.vx * dt / steps;
      b.y += b.vy * dt / steps;
      b.h += b.vh * dt / steps;
      if (b.x < 0 || b.y < 0 || b.x > MAP || b.y > MAP || b.h < 0 || b.h > 400 || inSolid(b.x, b.y, b.h)) {
        b.dead = true;
        break;
      }
      for (const e of ents.values()) {
        if (!e.alive || e.id === b.owner) continue;
        if (dist(e.x, e.y, b.x, b.y) < PLAYER_R && b.h <= PLAYER_H) {
          const headshot = b.h >= PLAYER_H - 16;
          const dmg = headshot ? b.dmg * 2 : b.dmg;
          events.push({ t: 'hit', x: Math.round(b.x), y: Math.round(b.y), h: Math.round(b.h),
                        v: e.id, s: b.owner, hd: headshot });
          hurt(e, dmg, ents.get(b.owner) || null, 'Unbekannt');
          b.dead = true;
          break;
        }
      }
    }
    b.life -= dt;
    if (b.life <= 0) b.dead = true;
  }
  bullets = bullets.filter(b => !b.dead);
}

// ---------- Bot-KI ----------
function randomInZone() {
  return randomFree(40, Math.max(100, zoneNow.r - 80));
}

function botThink(e, dt) {
  e.think -= dt;
  if (e.think <= 0) {
    const L = BOT_LEVELS[botLevel];
    e.think = L.think[0] + Math.random() * (L.think[1] - L.think[0]);
    e.aimOff = (Math.random() - 0.5) * L.aim;

    let target = null, bd = Infinity;
    for (const o of ents.values()) {
      if (o === e || !o.alive) continue;
      const d = dist(e.x, e.y, o.x, o.y);
      if (d < bd) { bd = d; target = o; }
    }

    let g;
    const inZone = dist(e.x, e.y, CX, CY) < zoneNow.r - 60;
    const stuck = dist(e.x, e.y, e.px, e.py) < 12 && e.mode !== 'fight';
    e.px = e.x; e.py = e.y;

    if (!inZone) {
      e.mode = 'zone'; e.goal = { x: CX, y: CY }; e.target = null;
    } else if (target && bd < L.engage) {
      e.mode = 'fight'; e.target = target; e.goal = null;
    } else if (e.hp < 55 && (g = nearestPickup(e, p => p.type === 'medkit', 1000))) {
      e.mode = 'loot'; e.goal = g; e.target = null;
    } else if (e.shield < 20 && (g = nearestPickup(e, p => p.type === 'shield', 800))) {
      e.mode = 'loot'; e.goal = g; e.target = null;
    } else if (e.weapon === 'pistol' && (g = nearestPickup(e, p => p.type === 'chest', 500))) {
      e.mode = 'loot'; e.goal = g; e.target = null;
    } else if (e.weapon === 'pistol' && (g = nearestPickup(e, p => !!WEAPONS[p.type] && p.type !== 'pistol', 900))) {
      e.mode = 'loot'; e.goal = g; e.target = null;
    } else if (e.mode !== 'wander' || !e.goal || stuck || dist(e.goal.x, e.goal.y, e.x, e.y) < 40) {
      e.mode = 'wander'; e.goal = randomInZone(); e.target = null;
    }
  }

  let wx = 0, wy = 0, shoot = false, use = false;
  if (e.mode === 'fight' && e.target && e.target.alive) {
    const t = e.target;
    const dx = t.x - e.x, dy = t.y - e.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    e.ang = Math.atan2(dy, dx) + e.aimOff;
    // auf Brusthöhe zielen
    e.input.pitch = Math.atan2(40 - EYE, d);
    if (d > 280) { wx = dx / d; wy = dy / d; }
    else { wx = -dy / d * e.strafe; wy = dx / d * e.strafe; if (Math.random() < 0.02) e.strafe *= -1; }
    shoot = d < WEAPONS[e.weapon].range * 0.9 && Math.random() < BOT_LEVELS[botLevel].fire;
  } else {
    const g = e.goal || { x: CX, y: CY };
    const dx = g.x - e.x, dy = g.y - e.y;
    const d = Math.hypot(dx, dy);
    if (d > 8) { wx = dx / d; wy = dy / d; }
    e.ang = Math.atan2(dy, dx);
    e.input.pitch = 0;
    if (e.goal && e.goal.type === 'chest' && d < CHEST_R) use = true;
  }
  // Weltrichtung in lokale Richtung (vor/rechts) umrechnen
  const fx = Math.cos(e.ang), fy = Math.sin(e.ang);
  e.input.ang = e.ang;
  e.input.my = wx * fx + wy * fy;
  e.input.mx = -wx * fy + wy * fx;
  e.input.shoot = shoot;
  e.input.use = use;
}

// ---------- Simulation ----------
function simulate(dt) {
  matchT += dt;
  zoneNow = zoneAt(matchT);

  for (const e of ents.values()) {
    if (!e.alive) continue;
    if (e.isBot) botThink(e, dt);
    if (e.input.use) { e.input.use = false; openChest(e); }

    // Bewegung: my = vor/zurück, mx = rechts/links, relativ zur Blickrichtung
    let mx = e.input.mx, my = e.input.my;
    const ml = Math.hypot(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; }
    e.ang = e.input.ang;
    const fx = Math.cos(e.ang), fy = Math.sin(e.ang);
    const rx = -fy, ry = fx;
    e.x += (fx * my + rx * mx) * SPEED * dt;
    e.y += (fy * my + ry * mx) * SPEED * dt;
    resolve(e);

    e.cd = Math.max(0, e.cd - dt);
    if (e.input.shoot && e.cd <= 0) fire(e);

    pickupCheck(e);
    if (dist(e.x, e.y, CX, CY) > zoneNow.r) hurt(e, zoneNow.dps * dt, null, 'Zone');
  }

  updateBullets(dt);

  if (pickups.some(p => p.dead)) {
    pickups = pickups.filter(p => !p.dead);
    pkDirty = true;
  }

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
  bullets = [];
  events.push({ t: 'start' });
  for (const e of [...ents.values()]) {
    if (e.isBot) ents.delete(e.id);
    else resetEntity(e);
  }
  genPickups();
  fillBots();
  zoneNow = zoneAt(0);
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
    z: { x: CX, y: CY, r: Math.round(zoneNow.r), st: zoneNow.st, tm: +zoneNow.tm.toFixed(1), ph: zoneNow.ph },
    al: ps.filter(p => p.al).length,
    ps, ev: events,
  };
  if (pkDirty) { msg.pk = pkList(); pkDirty = false; }
  events = [];
  return JSON.stringify(msg);
}

// ---------- HTTP + WebSocket ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const PUBLIC = path.join(__dirname, 'public');

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const urlPath0 = (req.url || '/').split('?')[0];
  if (urlPath0 === '/vendor/three.module.js') {
    return fs.readFile(path.join(__dirname, 'node_modules/three/build/three.module.js'), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(data);
    });
  }
  if (urlPath0 === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ urls: lanUrls() }));
  }
  let urlPath = decodeURIComponent(urlPath0);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nicht gefunden'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

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
      send(ws, {
        t: 'welcome', id: e.id, map: MAP, cx: CX, cy: CY,
        so: solids, pois: POIS.map(p => ({ n: p.name, x: p.x, y: p.y, r: p.r })),
        pk: pkList(),
      });
      return;
    }

    if (!ws.entity) return;
    const inp = ws.entity.input;
    if (m.t === 'in') {
      inp.mx = clamp(Number(m.mx) || 0, -1, 1);
      inp.my = clamp(Number(m.my) || 0, -1, 1);
      inp.ang = Number(m.a) || 0;
      inp.pitch = clamp(Number(m.pt) || 0, -1.4, 1.4);
      inp.shoot = !!m.s;
    } else if (m.t === 'use') {
      inp.use = true;
    }
  });

  ws.on('close', () => {
    if (ws.entity) ents.delete(ws.entity.id);
  });
});

function broadcast(str) {
  for (const c of wss.clients) if (c.readyState === 1) c.send(str);
}

// ---------- Game loop ----------
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

genWorld();
resetMatch();
setInterval(tick, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log(`Storm Royale läuft auf http://localhost:${PORT}`);
  const lan = lanUrls();
  if (lan.length) {
    console.log('Einladen (gleiches Netzwerk):');
    for (const u of lan) console.log('  ' + u);
  }
});
