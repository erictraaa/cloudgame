'use strict';
// Weltgenerator für Storm Royale.
// Erzeugt deterministisch aus einem Seed: Gelände (Heightmap mit Bergen, Hügeln, Klippen),
// Orte (Städte, Dörfer, Industrie), Straßen und Wege, Gebäude mit Wänden/Türen,
// Bäume und Felsen. Der Server schickt das Ergebnis an alle Clients.
//
// Koordinaten: x/y = Bodenebene (0..MAP), Höhe in denselben Einheiten (Spieler ≈ 72 hoch).

const MAP = 12000;
const GRID = 301;                    // Heightmap-Punkte pro Seite
const CELL = MAP / (GRID - 1);       // 40 Einheiten pro Heightmap-Zelle
const WALL_T = 10;                   // Wandstärke

// ---------- Zufall & Rauschen ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x, y, oct, seed) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x * f, y * f, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// ---------- Gelände ----------
function rawHeight(x, y, seed) {
  const base = fbm(x / 3200, y / 3200, 4, seed);
  const hills = fbm(x / 800, y / 800, 4, seed + 100);
  const mMask = smoothstep(0.52, 0.72, fbm(x / 4500, y / 4500, 3, seed + 200));
  const ridge = 1 - Math.abs(fbm(x / 1800, y / 1800, 5, seed + 300) * 2 - 1);
  let h = 40 + base * 260 + hills * 120;

  // Berge
  let m = mMask * Math.pow(ridge, 2.2) * 1700;
  // Klippen: in manchen Gegenden werden die Berge zu Terrassen mit steilen Kanten
  const step = 160;
  const t = m / step, k = Math.floor(t), f = t - k;
  const terr = (k + smoothstep(0.72, 0.95, f)) * step;
  const cliffMask = smoothstep(0.4, 0.6, fbm(x / 2600, y / 2600, 2, seed + 400));
  m += (terr - m) * cliffMask;
  h += m;

  // Gebirge am Kartenrand als natürliche Grenze
  const edge = Math.min(x, y, MAP - x, MAP - y);
  h += (1 - smoothstep(0, 1100, edge)) * 1300;
  return h;
}

function makeHeightAt(H) {
  return function heightAt(x, y) {
    const gx = clamp(x / CELL, 0, GRID - 1.0001), gy = clamp(y / CELL, 0, GRID - 1.0001);
    const ix = Math.floor(gx), iy = Math.floor(gy);
    const fx = gx - ix, fy = gy - iy;
    const i = iy * GRID + ix;
    const a = H[i], b = H[i + 1], c = H[i + GRID], d = H[i + GRID + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

// Höhe in einem Kreis auf "target" ziehen (weicher Rand)
function blendDisc(H, cx, cy, r0, r1, target, strength = 1) {
  const gx0 = Math.max(0, Math.floor((cx - r1) / CELL)), gx1 = Math.min(GRID - 1, Math.ceil((cx + r1) / CELL));
  const gy0 = Math.max(0, Math.floor((cy - r1) / CELL)), gy1 = Math.min(GRID - 1, Math.ceil((cy + r1) / CELL));
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const d = dist(gx * CELL, gy * CELL, cx, cy);
      if (d > r1) continue;
      const f = (1 - smoothstep(r0, r1, d)) * strength;
      const i = gy * GRID + gx;
      H[i] += (target - H[i]) * f;
    }
  }
}

// ---------- Orte ----------
const CITY_NAMES = ['Neustadt', 'Altheim', 'Bergstadt', 'Rosenburg'];
const VILLAGE_NAMES = ['Moosdorf', 'Eichenau', 'Kieselbach', 'Lindenhof', 'Wolfsgrund',
                       'Birkenfeld', 'Tannenberg', 'Rotmühle', 'Hasenwinkel'];
const INDUSTRY_NAMES = ['Industriepark', 'Steinbruch'];

function pickPois(rng, heightAt) {
  const pois = [];
  const kinds = [
    ...CITY_NAMES.map(n => ({ kind: 'city', name: n, r: 650, spacing: 2600 })),
    ...INDUSTRY_NAMES.map(n => ({ kind: 'industry', name: n, r: 420, spacing: 1800 })),
    ...VILLAGE_NAMES.map(n => ({ kind: 'village', name: n, r: 380, spacing: 1700 })),
  ];
  for (const k of kinds) {
    for (let t = 0; t < 6000; t++) {
      const x = 1600 + rng() * (MAP - 3200), y = 1600 + rng() * (MAP - 3200);
      const h = heightAt(x, y);
      if (h > 650) continue;
      const rr = k.r * 0.7;
      let rough = 0;
      for (const [dx, dy] of [[rr, 0], [-rr, 0], [0, rr], [0, -rr]]) rough = Math.max(rough, Math.abs(heightAt(x + dx, y + dy) - h));
      if (rough > 140 - t * 0.02) continue;               // zuerst flache Stellen, später auch hügeligere
      if (pois.some(p => dist(p.x, p.y, x, y) < Math.max(k.spacing, p.spacing) * (1 - t / 12000))) continue;
      pois.push({ ...k, x: Math.round(x), y: Math.round(y), g: 0 });
      break;
    }
  }
  return pois;
}

// ---------- Straßen ----------
function buildRoadNetwork(rng, pois) {
  // Minimaler Spannbaum + ein paar Zusatzverbindungen
  const n = pois.length;
  const inTree = new Set([0]);
  const edges = [];
  while (inTree.size < n) {
    let best = null;
    for (const a of inTree) {
      for (let b = 0; b < n; b++) {
        if (inTree.has(b)) continue;
        const d = dist(pois[a].x, pois[a].y, pois[b].x, pois[b].y);
        if (!best || d < best.d) best = { a, b, d };
      }
    }
    edges.push(best);
    inTree.add(best.b);
  }
  const extra = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (edges.some(e => (e.a === a && e.b === b) || (e.a === b && e.b === a))) continue;
      extra.push({ a, b, d: dist(pois[a].x, pois[a].y, pois[b].x, pois[b].y) });
    }
  }
  extra.sort((p, q) => p.d - q.d);
  edges.push(...extra.slice(0, 4));

  return edges.map(({ a, b }) => {
    const A = pois[a], B = pois[b];
    const big = A.kind !== 'village' && B.kind !== 'village';
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len;
    const pts = [[A.x, A.y]];
    for (const f of [1 / 3, 2 / 3]) {
      const off = (rng() - 0.5) * len * 0.16;
      pts.push([A.x + dx * f + nx * off, A.y + dy * f + ny * off]);
    }
    pts.push([B.x, B.y]);
    return { type: big ? 'asphalt' : 'dirt', w: big ? 56 : 38, pts: densify(pts, 40) };
  });
}

function densify(pts, step) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const n = Math.max(1, Math.ceil(dist(x0, y0, x1, y1) / step));
    for (let k = 0; k < n; k++) out.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
  }
  out.push(pts[pts.length - 1]);
  return out.map(([x, y]) => [Math.round(x), Math.round(y)]);
}

// Gelände entlang einer Straße glätten (Einschnitte durch Berge, Dämme über Senken)
function carveRoad(H, heightAt, road) {
  const raw = road.pts.map(([x, y]) => heightAt(x, y));
  let sm = raw;
  for (let pass = 0; pass < 3; pass++) {
    const nxt = sm.slice();
    for (let i = 0; i < sm.length; i++) {
      let s = 0, c = 0;
      for (let k = -10; k <= 10; k++) {
        const j = i + k;
        if (j >= 0 && j < sm.length) { s += sm[j]; c++; }
      }
      nxt[i] = s / c;
    }
    sm = nxt;
  }
  road.pts.forEach(([x, y], i) => blendDisc(H, x, y, road.w * 0.7, road.w * 2.2, sm[i], 0.9));
}

// ---------- Gebäude ----------
const BUILDING_TYPES = {
  house:     { w: [90, 120],  d: [80, 100],  wh: 120, roof: 'gable', mats: ['plaster', 'bricks', 'wood'], roofMats: ['roof', 'roof_slate'], door: 44, rooms: true },
  apartment: { w: [140, 180], d: [110, 130], wh: 300, roof: 'flat',  mats: ['concrete', 'bricks', 'plaster'], roofMats: ['concrete'], door: 50, rooms: true },
  shop:      { w: [110, 140], d: [90, 110],  wh: 140, roof: 'flat',  mats: ['plaster', 'bricks'], roofMats: ['concrete'], door: 60 },
  barn:      { w: [140, 170], d: [100, 120], wh: 150, roof: 'gable', mats: ['planks'], roofMats: ['metal'], door: 110 },
  warehouse: { w: [220, 280], d: [160, 200], wh: 190, roof: 'gable', mats: ['metal'], roofMats: ['metal'], door: 140, backDoor: true },
  church:    { w: [140, 150], d: [230, 250], wh: 200, roof: 'gable', mats: ['plaster'], roofMats: ['roof_slate'], door: 60 },
};

function makeWalls(b, doorW, backDoor, rooms) {
  const { x0, x1, y0, y1 } = b, T = WALL_T;
  const walls = [];
  const side = (s, gap) => {
    // Wandseite mit optionaler Türöffnung in der Mitte
    if (s === 'n' || s === 's') {
      const yy0 = s === 'n' ? y0 : y1 - T, yy1 = s === 'n' ? y0 + T : y1;
      if (!gap) return walls.push([x0, x1, yy0, yy1]);
      const cx = (x0 + x1) / 2;
      walls.push([x0, cx - gap / 2, yy0, yy1], [cx + gap / 2, x1, yy0, yy1]);
    } else {
      const xx0 = s === 'w' ? x0 : x1 - T, xx1 = s === 'w' ? x0 + T : x1;
      if (!gap) return walls.push([xx0, xx1, y0, y1]);
      const cy = (y0 + y1) / 2;
      walls.push([xx0, xx1, y0, cy - gap / 2], [xx0, xx1, cy + gap / 2, y1]);
    }
  };
  const opposite = { n: 's', s: 'n', e: 'w', w: 'e' };
  for (const s of ['n', 's', 'e', 'w']) {
    const gap = s === b.door ? doorW : (backDoor && s === opposite[b.door] ? doorW : 0);
    side(s, gap);
  }
  // Innenwand (zwei Räume) parallel zur Türseite, mit Durchgang
  if (rooms) {
    if (b.door === 'n' || b.door === 's') {
      const ym = (y0 + y1) / 2, cx = (x0 + x1) / 2 + (x1 - x0) * 0.2;
      walls.push([x0 + T, cx - 22, ym - T / 2, ym + T / 2], [cx + 22, x1 - T, ym - T / 2, ym + T / 2]);
    } else {
      const xm = (x0 + x1) / 2, cy = (y0 + y1) / 2 + (y1 - y0) * 0.2;
      walls.push([xm - T / 2, xm + T / 2, y0 + T, cy - 22], [xm - T / 2, xm + T / 2, cy + 22, y1 - T]);
    }
  }
  return walls.map(w => w.map(v => Math.round(v)));
}

function rectsOverlap(a, b, m) {
  return a.x0 < b.x1 + m && a.x1 > b.x0 - m && a.y0 < b.y1 + m && a.y1 > b.y0 - m;
}

function layoutTown(rng, poi, roads, buildings) {
  const R = poi.r;
  const streets = [];   // Achsen-parallele Straßen-Rechtecke
  const addStreet = (axis, off, half, w, type) => {
    const pts = axis === 'x'
      ? [[poi.x - half, poi.y + off], [poi.x + half, poi.y + off]]
      : [[poi.x + off, poi.y - half], [poi.x + off, poi.y + half]];
    roads.push({ type, w, pts: densify(pts, 40), town: true });
    streets.push({ axis, off, half, w,
      x0: Math.min(pts[0][0], pts[1][0]) - (axis === 'y' ? w / 2 : 0), x1: Math.max(pts[0][0], pts[1][0]) + (axis === 'y' ? w / 2 : 0),
      y0: Math.min(pts[0][1], pts[1][1]) - (axis === 'x' ? w / 2 : 0), y1: Math.max(pts[0][1], pts[1][1]) + (axis === 'x' ? w / 2 : 0) });
  };

  let typePick;
  if (poi.kind === 'city') {
    for (const off of [-280, 0, 280]) { addStreet('x', off, R * 0.92, 52, 'asphalt'); addStreet('y', off, R * 0.92, 52, 'asphalt'); }
    roads.push({ type: 'plaza', w: 240, pts: [[poi.x, poi.y]], town: true });
    typePick = () => { const r = rng(); return r < 0.3 ? 'apartment' : r < 0.55 ? 'shop' : r < 0.95 ? 'house' : 'warehouse'; };
  } else if (poi.kind === 'industry') {
    addStreet('x', 0, R * 0.95, 56, 'asphalt');
    addStreet('y', 0, R * 0.6, 56, 'asphalt');
    typePick = () => (rng() < 0.75 ? 'warehouse' : 'shop');
  } else {
    const axis = rng() < 0.5 ? 'x' : 'y';
    addStreet(axis, 0, R * 0.95, 40, 'dirt');
    if (rng() < 0.6) addStreet(axis === 'x' ? 'y' : 'x', (rng() - 0.5) * R * 0.6, R * 0.55, 36, 'dirt');
    typePick = () => { const r = rng(); return r < 0.62 ? 'house' : r < 0.9 ? 'barn' : 'shop'; };
  }

  const placed = [];
  const tryPlace = (type, cx, cy, door, alongAxis) => {
    const T = BUILDING_TYPES[type];
    const wAlong = T.w[0] + rng() * (T.w[1] - T.w[0]);
    const dDepth = T.d[0] + rng() * (T.d[1] - T.d[0]);
    // Breite entlang der Straße, Tiefe senkrecht dazu
    const sx = alongAxis === 'x' ? wAlong : dDepth, sy = alongAxis === 'x' ? dDepth : wAlong;
    let x = cx, y = cy;
    // vom Straßenrand nach hinten verschieben
    if (door === 's') y -= sy / 2; else if (door === 'n') y += sy / 2;
    else if (door === 'e') x -= sx / 2; else if (door === 'w') x += sx / 2;
    const b = { x0: x - sx / 2, x1: x + sx / 2, y0: y - sy / 2, y1: y + sy / 2 };
    if (dist(x, y, poi.x, poi.y) > R) return null;
    if (b.x0 < 200 || b.y0 < 200 || b.x1 > MAP - 200 || b.y1 > MAP - 200) return null;
    if (streets.some(s => rectsOverlap(b, s, 8))) return null;
    if (poi.kind === 'city' && dist(x, y, poi.x, poi.y) < 150 + Math.max(sx, sy) / 2) return null; // Marktplatz frei
    if (buildings.some(o => rectsOverlap(b, o, 18)) || placed.some(o => rectsOverlap(b, o, 18))) return null;
    // vor der Tür muss Platz bleiben (sonst steht man vor einer fremden Wand)
    const front = door === 'n' ? { x0: b.x0, x1: b.x1, y0: b.y0 - 90, y1: b.y0 }
      : door === 's' ? { x0: b.x0, x1: b.x1, y0: b.y1, y1: b.y1 + 90 }
      : door === 'w' ? { x0: b.x0 - 90, x1: b.x0, y0: b.y0, y1: b.y1 }
      : { x0: b.x1, x1: b.x1 + 90, y0: b.y0, y1: b.y1 };
    if (buildings.some(o => rectsOverlap(front, o, 0)) || placed.some(o => rectsOverlap(front, o, 0))) return null;
    const mats = T.mats, rmats = T.roofMats;
    const bld = {
      type, x0: Math.round(b.x0), x1: Math.round(b.x1), y0: Math.round(b.y0), y1: Math.round(b.y1),
      g: Math.round(poi.g), wh: T.wh, door, roof: T.roof,
      mat: mats[Math.floor(rng() * mats.length)], roofMat: rmats[Math.floor(rng() * rmats.length)],
      ridge: sx >= sy ? 'x' : 'y',
    };
    bld.walls = makeWalls(bld, T.door, !!T.backDoor, !!T.rooms && dDepth > 85);
    placed.push(bld);
    return bld;
  };

  // Gebäude beidseitig entlang jeder Straße, Tür zur Straße
  for (const s of streets) {
    for (const side of [-1, 1]) {
      let t = -s.half + 70;
      while (t < s.half - 70) {
        const type = typePick();
        const edge = s.w / 2 + 16;
        let cx, cy, door;
        if (s.axis === 'x') { cx = poi.x + t; cy = poi.y + s.off + side * edge; door = side < 0 ? 's' : 'n'; }
        else { cx = poi.x + s.off + side * edge; cy = poi.y + t; door = side < 0 ? 'e' : 'w'; }
        const b = tryPlace(type, cx, cy, door, s.axis);
        t += b ? (s.axis === 'x' ? b.x1 - b.x0 : b.y1 - b.y0) + 26 + rng() * 40 : 60;
      }
    }
  }

  // Kirche mit Turm in Städten und manchen Dörfern
  if (poi.kind === 'city' || (poi.kind === 'village' && rng() < 0.5)) {
    for (let k = 0; k < 40; k++) {
      const a = rng() * Math.PI * 2, d = R * (0.3 + rng() * 0.45);
      const doorSide = ['n', 's', 'e', 'w'][Math.floor(rng() * 4)];
      const b = tryPlace('church', poi.x + Math.cos(a) * d, poi.y + Math.sin(a) * d, doorSide, doorSide === 'n' || doorSide === 's' ? 'x' : 'y');
      if (!b) continue;
      // Turm an der Rückseite
      const tw = 64, th = 430;
      let tx, ty;
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      if (doorSide === 's') { tx = cx; ty = b.y0 - tw / 2 + 4; }
      else if (doorSide === 'n') { tx = cx; ty = b.y1 + tw / 2 - 4; }
      else if (doorSide === 'e') { tx = b.x0 - tw / 2 + 4; ty = cy; }
      else { tx = b.x1 + tw / 2 - 4; ty = cy; }
      const tower = { type: 'tower', x0: Math.round(tx - tw / 2), x1: Math.round(tx + tw / 2), y0: Math.round(ty - tw / 2), y1: Math.round(ty + tw / 2),
        g: b.g, wh: th, door: null, roof: 'spire', mat: 'plaster', roofMat: 'roof_slate', ridge: 'x' };
      tower.walls = [[tower.x0, tower.x1, tower.y0, tower.y1]];
      placed.push(tower);
      break;
    }
  }

  buildings.push(...placed);
  return placed;
}

// ---------- Hauptfunktion ----------
function generateWorld(seed) {
  const rng = mulberry32(seed);
  const H = new Float32Array(GRID * GRID);
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) H[gy * GRID + gx] = rawHeight(gx * CELL, gy * CELL, seed);
  }
  const heightAt = makeHeightAt(H);

  // Orte wählen und einebnen
  const pois = pickPois(rng, heightAt);
  for (const p of pois) {
    p.g = heightAt(p.x, p.y);
    blendDisc(H, p.x, p.y, p.r * 0.95, p.r * 1.45, p.g, 1);
  }

  // Überlandstraßen
  const roads = buildRoadNetwork(rng, pois);
  for (const r of roads) carveRoad(H, heightAt, r);
  // Orte nach dem Straßenbau nochmal exakt einebnen
  for (const p of pois) blendDisc(H, p.x, p.y, p.r * 0.95, p.r * 1.25, p.g, 1);

  // Höhen quantisieren (so überträgt sie der Server; Client und Server rechnen identisch)
  const Hq = new Uint16Array(GRID * GRID);
  for (let i = 0; i < H.length; i++) Hq[i] = clamp(Math.round(H[i]), 0, 65535);
  const hAt = makeHeightAt(Hq);
  for (const p of pois) p.g = Math.round(hAt(p.x, p.y));

  // Orte bebauen
  const buildings = [];
  for (const p of pois) layoutTown(rng, p, roads, buildings);

  // Belegte Zellen (Straßen, Orte, Gebäude) – dort keine Bäume/Felsen
  const occ = new Uint8Array(GRID * GRID);
  const mark = (x, y, r) => {
    const gx0 = Math.max(0, Math.floor((x - r) / CELL)), gx1 = Math.min(GRID - 1, Math.ceil((x + r) / CELL));
    const gy0 = Math.max(0, Math.floor((y - r) / CELL)), gy1 = Math.min(GRID - 1, Math.ceil((y + r) / CELL));
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) occ[gy * GRID + gx] = 1;
  };
  for (const r of roads) for (const [x, y] of r.pts) mark(x, y, r.w * 0.9 + 20);
  for (const p of pois) mark(p.x, p.y, p.r * 0.95);
  const occAt = (x, y) => occ[Math.round(clamp(y / CELL, 0, GRID - 1)) * GRID + Math.round(clamp(x / CELL, 0, GRID - 1))];
  const slopeAt = (x, y) => Math.max(Math.abs(hAt(x + CELL, y) - hAt(x - CELL, y)), Math.abs(hAt(x, y + CELL) - hAt(x, y - CELL))) / (2 * CELL);

  // Bäume (Wälder über Rauschmaske, dazu einzelne Bäume)
  const trees = [];
  for (let t = 0; t < 120000 && trees.length < 8500; t++) {
    const x = 150 + rng() * (MAP - 300), y = 150 + rng() * (MAP - 300);
    if (occAt(x, y)) continue;
    const h = hAt(x, y);
    if (h > 1250 || slopeAt(x, y) > 0.7) continue;
    const forest = smoothstep(0.47, 0.68, fbm(x / 1400, y / 1400, 3, seed + 500));
    if (rng() > forest * 0.9 + 0.025) continue;
    const conifer = h > 480 || rng() < 0.35;
    trees.push([Math.round(x), Math.round(y), Math.round((0.8 + rng() * 0.7) * 100) / 100, conifer ? 0 : 1]);
  }

  // Felsen (mehr in Bergen und an Hängen)
  const rocks = [];
  for (let t = 0; t < 40000 && rocks.length < 1600; t++) {
    const x = 150 + rng() * (MAP - 300), y = 150 + rng() * (MAP - 300);
    if (occAt(x, y)) continue;
    const h = hAt(x, y), s = slopeAt(x, y);
    const p = 0.04 + smoothstep(500, 1100, h) * 0.3 + smoothstep(0.2, 0.8, s) * 0.3;
    if (rng() > p) continue;
    rocks.push([Math.round(x), Math.round(y), Math.round(14 + rng() * 30)]);
  }

  return { seed, MAP, GRID, CELL, heights: Hq, heightAt: hAt, pois, roads, buildings, trees, rocks };
}

module.exports = { generateWorld, MAP, GRID, CELL, WALL_T, makeHeightAt };
