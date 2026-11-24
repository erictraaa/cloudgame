// Storm Royale – First-Person-Client (Three.js).
// Server-Koordinaten: x/y = Boden, h = Höhe. Three.js: X = x, Y = Höhe, Z = y.
import * as THREE from 'three';

const $ = id => document.getElementById(id);
const INTERP = 100;      // ms Verzögerung für flüssige Darstellung
const EYE = 62;          // Augenhöhe (wie Server)
const SENS = 0.0022;     // Maus-Empfindlichkeit

// ---------- Renderer / Szene / Kamera ----------
const cv = $('c');
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const SKY = '#9ccfff';
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 1100, 3200);

const camera = new THREE.PerspectiveCamera(75, 1, 0.5, 4000);
scene.add(camera);

scene.add(new THREE.HemisphereLight('#ffffff', '#4a6b3a', 1.1));
const sun = new THREE.DirectionalLight('#fff4d6', 1.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -700, right: 700, top: 700, bottom: -700, near: 10, far: 2000 });
scene.add(sun, sun.target);

// Viewmodel: Waffe vor der Kamera
const viewGun = new THREE.Group();
const vgMat = new THREE.MeshLambertMaterial({ color: 0x495057 });
const vgMesh = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.36), vgMat);
vgMesh.position.set(0, 0, -0.18);
vgMesh.castShadow = false;
viewGun.add(vgMesh);
viewGun.position.set(0.22, -0.2, -0.42);
camera.add(viewGun);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const rand = (a, b) => a + Math.random() * (b - a);
const lerpAngle = (a, b, f) => a + ((b - a + Math.PI * 3) % (Math.PI * 2) - Math.PI) * f;

// ---------- Konstanten ----------
const WEAPON_NAME = { pistol: 'Pistole', smg: 'Maschinenpistole', rifle: 'Sturmgewehr', shotgun: 'Schrotflinte', sniper: 'Scharfschützengewehr' };
const GUN_COL = { pistol: 0xadb5bd, smg: 0x495057, rifle: 0x343a40, shotgun: 0x212529, sniper: 0x1a1b1e };
const GUN_LEN = { pistol: 14, smg: 16, rifle: 22, shotgun: 19, sniper: 28 };
const VM_LEN = { pistol: 0.8, smg: 1, rifle: 1.4, shotgun: 1.3, sniper: 1.9 };
const PICK_COL = { smg: 0xf783ac, rifle: 0xffa94d, shotgun: 0xff6b6b, sniper: 0xb197fc, medkit: 0x51cf66, shield: 0x4dabf7, chest: 0xffd43b };
const PICK_LABEL = { smg: 'SM', rifle: 'AR', shotgun: 'SG', sniper: 'SN', medkit: '+', shield: 'S', chest: 'T' };
const PICK_CSS = { smg: '#f783ac', rifle: '#ffa94d', shotgun: '#ff6b6b', sniper: '#b197fc', medkit: '#51cf66', shield: '#4dabf7', chest: '#ffd43b' };

// ---------- Zustand ----------
let MAP = 4000, CX = 2000, CY = 2000;
let POIS = [];
let groundCanvas = null;
let snaps = [];
let myId = null, myName = '';
let ws = null, inputTimer = null;
let alive = 0;
let firing = false, diff = 'medium';
let yaw = 0, pitch = 0, yawInit = false;
let zone = { x: 2000, y: 2000, r: 2800, st: 'hold', tm: 0, ph: 1 };
let lastPs = [];
let chestsNear = false;
let pickupsNow = [];
const keys = new Set();
let shake = 0, lastHp = 100, lastState = 'menu', recoil = 0;
let bannerTimer = 0, hitTimer = 0, ac = null;

const playerObjs = new Map();
const pickupObjs = new Map();
const shots = [];
const parts = [];
const labelTex = {};
let zoneWall = null, zoneRing = null;
let worldBuilt = false;

const GEO = {
  trunk: new THREE.CylinderGeometry(4, 5, 40, 6).translate(0, 20, 0),
  leaves: new THREE.ConeGeometry(30, 60, 7).translate(0, 70, 0),
  leaves2: new THREE.ConeGeometry(22, 46, 7).translate(0, 105, 0),
  rock: new THREE.DodecahedronGeometry(1, 0),
  wall: new THREE.BoxGeometry(1, 1, 1),
  body: new THREE.CapsuleGeometry(10, 22, 4, 10).translate(0, 21, 0),
  head: new THREE.SphereGeometry(8, 14, 10).translate(0, 48, 0),
  gunBox: new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0, 0),
  tracer: new THREE.BoxGeometry(0.6, 0.6, 22),
  spark: new THREE.SphereGeometry(2.2, 6, 4),
  pick: new THREE.BoxGeometry(16, 16, 16),
};
const MAT = {
  trunk: new THREE.MeshLambertMaterial({ color: 0x6b4a2b }),
  leaves: new THREE.MeshLambertMaterial({ color: 0x2f7d32 }),
  leaves2: new THREE.MeshLambertMaterial({ color: 0x3f9a3f }),
  rock: new THREE.MeshLambertMaterial({ color: 0x868e96, flatShading: true }),
  wall: new THREE.MeshLambertMaterial({ color: 0xd9c9a3 }),
  roof: new THREE.MeshLambertMaterial({ color: 0x8a4b2e }),
  skin: new THREE.MeshLambertMaterial({ color: 0xffd8b1 }),
  tracer: new THREE.MeshBasicMaterial({ color: 0xffe066 }),
};

// ---------- Welt ----------
function buildGround() {
  groundCanvas = document.createElement('canvas');
  groundCanvas.width = groundCanvas.height = MAP / 2;
  const g = groundCanvas.getContext('2d');
  g.scale(0.5, 0.5);
  g.fillStyle = '#5c9a3e';
  g.fillRect(0, 0, MAP, MAP);
  for (let i = 0; i < 400; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,40,0,0.09)';
    g.beginPath(); g.arc(rand(0, MAP), rand(0, MAP), rand(40, 160), 0, Math.PI * 2); g.fill();
  }
  // Wege zwischen den Orten
  g.strokeStyle = '#b8945c';
  g.lineWidth = 60;
  g.lineCap = 'round';
  for (let i = 0; i < POIS.length; i++) {
    const a = POIS[i], b = POIS[(i + 1) % POIS.length];
    g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  }
  // Stadt-Platz
  const c = POIS[0];
  g.fillStyle = '#c9b48a';
  g.beginPath(); g.arc(c.x, c.y, 120, 0, Math.PI * 2); g.fill();

  const tex = new THREE.CanvasTexture(groundCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP, MAP), new THREE.MeshLambertMaterial({ map: tex }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(MAP / 2, 0, MAP / 2);
  ground.receiveShadow = true;
  scene.add(ground);

  const outside = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000), new THREE.MeshLambertMaterial({ color: '#2b3d2a' }));
  outside.rotation.x = -Math.PI / 2;
  outside.position.set(MAP / 2, -1, MAP / 2);
  scene.add(outside);
}

// Statische Objekte (Bäume, Felsen, Wände) als Instancing – schnell bei vielen Objekten
function buildSolids(list) {
  const trees = list.filter(s => s.t === 'c' && s.h >= 100);
  const rocks = list.filter(s => s.t === 'c' && s.h < 100);
  const walls = list.filter(s => s.t === 'b');
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const pos = new THREE.Vector3();

  const trunks = new THREE.InstancedMesh(GEO.trunk, MAT.trunk, trees.length);
  const l1 = new THREE.InstancedMesh(GEO.leaves, MAT.leaves, trees.length);
  const l2 = new THREE.InstancedMesh(GEO.leaves2, MAT.leaves2, trees.length);
  trees.forEach((t, i) => {
    const s = t.r / 26;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
    pos.set(t.x, 0, t.y);
    sc.set(s, s, s);
    m.compose(pos, q, sc);
    trunks.setMatrixAt(i, m); l1.setMatrixAt(i, m); l2.setMatrixAt(i, m);
  });
  for (const im of [trunks, l1, l2]) { im.castShadow = true; im.receiveShadow = true; scene.add(im); }

  const rk = new THREE.InstancedMesh(GEO.rock, MAT.rock, rocks.length);
  rocks.forEach((r, i) => {
    q.setFromEuler(new THREE.Euler(Math.random(), Math.random(), Math.random()));
    pos.set(r.x, r.r * 0.35, r.y);
    sc.set(r.r * 0.95, r.r * 0.6, r.r * 0.95);
    m.compose(pos, q, sc);
    rk.setMatrixAt(i, m);
  });
  rk.castShadow = true; rk.receiveShadow = true;
  scene.add(rk);

  const wl = new THREE.InstancedMesh(GEO.wall, MAT.wall, walls.length);
  walls.forEach((w, i) => {
    const sx = w.maxX - w.minX, sz = w.maxY - w.minY;
    pos.set((w.minX + w.maxX) / 2, w.h / 2, (w.minY + w.maxY) / 2);
    sc.set(sx, w.h, sz);
    m.compose(pos, new THREE.Quaternion(), sc);
    wl.setMatrixAt(i, m);
  });
  wl.castShadow = true; wl.receiveShadow = true;
  scene.add(wl);

  // Dächer über jedem Haus (flach, sichtbar von oben und außen)
  const roofs = new THREE.InstancedMesh(GEO.wall, MAT.roof, walls.length / 5 | 0);
  let ri = 0;
  for (let i = 0; i + 4 < walls.length && ri < roofs.count; i += 5) {
    const n = walls[i], w = walls[i + 2];
    const minX = n.minX, maxX = n.maxX, minY = n.minY, maxY = walls[i + 1].maxY;
    pos.set((minX + maxX) / 2, WALL_TOP + 6, (minY + maxY) / 2);
    sc.set(maxX - minX + 8, 12, maxY - minY + 8);
    m.compose(pos, new THREE.Quaternion(), sc);
    roofs.setMatrixAt(ri++, m);
  }
  roofs.count = ri;
  roofs.castShadow = true; roofs.receiveShadow = true;
  scene.add(roofs);
}
const WALL_TOP = 130;

function buildZone() {
  zoneWall = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 500, 128, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x9b59ff, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
  );
  scene.add(zoneWall);
  const pts = [];
  for (let i = 0; i <= 160; i++) {
    const a = (i / 160) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a), 3, Math.sin(a)));
  }
  zoneRing = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xd2aaff }));
  scene.add(zoneRing);
}

function updateZone() {
  if (!zoneWall) return;
  zoneWall.position.set(zone.x, 250, zone.y);
  zoneWall.scale.set(zone.r, 1, zone.r);
  zoneRing.position.set(zone.x, 0, zone.y);
  zoneRing.scale.set(zone.r, 1, zone.r);
}

function labelTexture(type) {
  if (labelTex[type]) return labelTex[type];
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = PICK_CSS[type] || '#fff';
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
  g.lineWidth = 8; g.strokeStyle = '#fff'; g.stroke();
  g.fillStyle = '#111'; g.font = 'bold 60px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(PICK_LABEL[type] || '?', 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  labelTex[type] = t;
  return t;
}

function rebuildPickups(list) {
  for (const m of pickupObjs.values()) scene.remove(m);
  pickupObjs.clear();
  pickupsNow = list;
  for (const p of list) {
    const col = PICK_COL[p.t] || 0xffffff;
    const isChest = p.t === 'chest';
    const mat = new THREE.MeshLambertMaterial({ color: col, emissive: col, emissiveIntensity: isChest ? 0.15 : 0.35 });
    const box = new THREE.Mesh(GEO.pick, mat);
    if (isChest) box.scale.set(1.4, 0.9, 1);
    box.castShadow = true;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(p.t), depthWrite: false }));
    sprite.scale.set(isChest ? 40 : 26, isChest ? 40 : 26, 1);
    sprite.position.y = 34;
    const grp = new THREE.Group();
    grp.add(box, sprite);
    grp.position.set(p.x, isChest ? 10 : 18, p.y);
    grp.userData.baseY = isChest ? 10 : 18;
    grp.userData.phase = p.i * 0.7;
    grp.userData.chest = isChest;
    scene.add(grp);
    pickupObjs.set(p.i, grp);
  }
}

// ---------- Spieler (Remote-Figuren) ----------
function drawName(pl, p) {
  const g = pl.ctx;
  g.clearRect(0, 0, 256, 64);
  g.font = `${p.i === myId ? 'bold ' : ''}30px system-ui`;
  g.textAlign = 'center';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.7)';
  g.strokeText(p.n, 128, 30);
  g.fillStyle = '#ffffff';
  g.fillText(p.n, 128, 30);
  g.fillStyle = 'rgba(0,0,0,.6)';
  g.fillRect(58, 42, 140, 12);
  g.fillStyle = p.h > 50 ? '#51cf66' : p.h > 25 ? '#fcc419' : '#ff6b6b';
  g.fillRect(58, 42, 140 * (p.h / 100), 12);
  pl.tex.needsUpdate = true;
}

function createPlayer(p) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(p.c || '#4dabf7') });
  const gunMat = new THREE.MeshLambertMaterial({ color: GUN_COL[p.w] || 0xadb5bd });
  const body = new THREE.Mesh(GEO.body, bodyMat);
  const head = new THREE.Mesh(GEO.head, MAT.skin);
  const gun = new THREE.Mesh(GEO.gunBox, gunMat);
  gun.position.set(8, 34, 4);
  gun.scale.set(GUN_LEN[p.w] || 14, 5, 5);
  for (const m of [body, head, gun]) { m.castShadow = true; m.receiveShadow = true; group.add(m); }

  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set(64, 16, 1);
  sprite.position.y = 80;
  group.add(sprite);

  scene.add(group);
  const pl = { group, gun, gunMat, sprite, canvas, ctx, tex, key: '' };
  playerObjs.set(p.i, pl);
  return pl;
}

function updatePlayers(ps) {
  const seen = new Set();
  for (const p of ps) {
    seen.add(p.i);
    const pl = playerObjs.get(p.i) || createPlayer(p);
    pl.group.visible = !!p.al && p.i !== myId;   // man sieht sich selbst nicht
    pl.group.position.set(p.x, 0, p.y);
    pl.group.rotation.y = -p.a;
    const gc = GUN_COL[p.w] || 0xadb5bd;
    if (pl.gunMat.color.getHex() !== gc) {
      pl.gunMat.color.setHex(gc);
      pl.gun.scale.set(GUN_LEN[p.w] || 14, 5, 5);
    }
    const key = `${p.n}|${p.h}`;
    if (key !== pl.key) { pl.key = key; drawName(pl, p); }
  }
  for (const [id, pl] of playerObjs) {
    if (!seen.has(id)) { scene.remove(pl.group); playerObjs.delete(id); }
  }
}

// ---------- Netzwerk ----------
function handleMsg(m) {
  if (m.t === 'welcome') {
    myId = m.id;
    MAP = m.map; CX = m.cx; CY = m.cy;
    POIS = m.pois;
    if (!worldBuilt) {
      buildGround();
      buildSolids(m.so);
      buildZone();
      worldBuilt = true;
    }
    rebuildPickups(m.pk || []);
    startGame();
  } else if (m.t === 's') {
    onSnap(m);
  }
}

function onSnap(m) {
  const now = performance.now();
  const map = new Map(m.ps.map(p => [p.i, p]));
  snaps.push({ t: now, ps: m.ps, map });
  while (snaps.length > 2 && now - snaps[0].t > 1500) snaps.shift();
  lastPs = m.ps;

  if (m.pk) rebuildPickups(m.pk);
  zone = m.z;
  alive = m.al;

  const me = map.get(myId);
  if (me) {
    if (!yawInit) { yaw = me.a; yawInit = true; }
    if (me.h < lastHp - 0.5) shake = Math.min(12, shake + (lastHp - me.h) * 0.2);
    lastHp = me.h;
    if (!me.al && lastState === 'play') {
      lastState = 'dead';
      document.exitPointerLock && document.pointerLockElement && document.exitPointerLock();
      $('dead').style.display = 'flex';
      $('deadTxt').textContent = `Kills: ${me.k} · Noch ${alive} am Leben`;
    } else if (me.al && lastState === 'dead') {
      lastState = 'play';
      $('dead').style.display = 'none';
    }
  }
  for (const ev of m.ev) handleEvent(ev);
}

function handleEvent(ev) {
  switch (ev.t) {
    case 'shot': spawnShot(ev); break;
    case 'hit': {
      if (ev.s === myId) {
        hitTimer = 0.18;
        $('hitm').style.opacity = 1;
        sfx(1200, 900, 0.05, 0.03);
      }
      for (let i = 0; i < 8; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffd43b, transparent: true });
        const mesh = new THREE.Mesh(GEO.spark, mat);
        scene.add(mesh);
        parts.push({ mesh, mat, x: ev.x, y: ev.h, z: ev.y, vx: rand(-90, 90), vy: rand(60, 200), vz: rand(-90, 90), life: .4, max: .4 });
      }
      break;
    }
    case 'open':
      sfx(600, 900, 0.18, 0.05);
      break;
    case 'kill': addFeed(ev); break;
    case 'end':
      showBanner(ev.h && ev.w === myName ? '🏆 DU GEWINNST!' : `🏆 ${ev.w} gewinnt`, 4500);
      break;
    case 'start':
      $('dead').style.display = 'none';
      lastState = 'play';
      showBanner('Neues Match – viel Glück!', 2000);
      break;
  }
}

function sendInput() {
  if (!ws || ws.readyState !== 1 || myId == null) return;
  const mx = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const my = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const s = firing || keys.has('Space') ? 1 : 0;
  ws.send(JSON.stringify({ t: 'in', mx, my, a: yaw, pt: pitch, s }));
}

function connect(name) {
  myName = name;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, d: diff }));
  ws.onmessage = e => handleMsg(JSON.parse(e.data));
  ws.onclose = () => showBanner('Verbindung verloren – Seite neu laden', 1e9);
  clearInterval(inputTimer);
  inputTimer = setInterval(sendInput, 33);
}

function startGame() {
  $('menu').style.display = 'none';
  lastState = 'play';
}

// ---------- Effekte ----------
function sfx(f0, f1, dur, vol) {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const t = ac.currentTime;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(ac.destination);
    o.start(t); o.stop(t + dur);
  } catch (e) { /* kein Audio */ }
}

const _d = new THREE.Vector3();
const UP = new THREE.Vector3(0, 0, 1);
function spawnShot(ev) {
  const me = lastMe();
  if (me && Math.hypot(me.x - ev.x, me.y - ev.y) < 900) sfx(700, 140, 0.09, 0.04);
  if (ev.o === myId) recoil = 1;
  for (let i = 0; i < ev.n; i++) {
    const aa = ev.a + (Math.random() - 0.5) * 2 * ev.sd;
    const pp = ev.p + (Math.random() - 0.5) * ev.sd * 0.6;
    const dir = new THREE.Vector3(Math.cos(aa) * Math.cos(pp), Math.sin(pp), Math.sin(aa) * Math.cos(pp));
    const mesh = new THREE.Mesh(GEO.tracer, MAT.tracer);
    mesh.quaternion.setFromUnitVectors(UP, dir);
    mesh.position.set(ev.x, ev.h, ev.y);
    scene.add(mesh);
    shots.push({ mesh, x: ev.x, y: ev.h, z: ev.y, dir, speed: ev.sp, life: ev.r / ev.sp });
  }
}

function addFeed(ev) {
  const el = document.createElement('div');
  el.className = 'fl' + (ev.k === myName || ev.v === myName ? ' mine' : '');
  el.textContent = `${ev.k} ${ev.z ? '☠' : '🔫'} ${ev.v}`;
  const feed = $('feed');
  feed.prepend(el);
  setTimeout(() => el.remove(), 5000);
  while (feed.children.length > 6) feed.lastChild.remove();
}

function showBanner(text, ms) {
  const b = $('banner');
  b.textContent = text;
  b.style.opacity = 1;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.style.opacity = 0; }, ms || 2500);
}

// ---------- Interpolation ----------
function sample(now) {
  if (!snaps.length) return [];
  const rt = now - INTERP;
  let i = snaps.length - 1;
  while (i > 0 && snaps[i].t > rt) i--;
  const a = snaps[i], b = snaps[i + 1];
  if (!b) return a.ps;
  const f = Math.min(1, Math.max(0, (rt - a.t) / (b.t - a.t)));
  return a.ps.map(p => {
    const q = b.map.get(p.i);
    if (!q) return p;
    return { ...p, x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f, a: lerpAngle(p.a, q.a, f) };
  });
}

function lastMe() {
  if (!snaps.length) return null;
  return snaps[snaps.length - 1].map.get(myId) || null;
}

// ---------- Minimap & HUD ----------
const mm = $('mm');
const mctx = mm.getContext('2d');
function drawMini(ps) {
  const S = 360, k = S / MAP;
  mctx.clearRect(0, 0, S, S);
  mctx.fillStyle = '#2d5a24';
  mctx.fillRect(0, 0, S, S);
  mctx.beginPath();
  mctx.rect(0, 0, S, S);
  mctx.moveTo(zone.x * k + zone.r * k, zone.y * k);
  mctx.arc(zone.x * k, zone.y * k, zone.r * k, 0, Math.PI * 2, true);
  mctx.fillStyle = 'rgba(90, 20, 160, .6)';
  mctx.fill('evenodd');
  mctx.beginPath();
  mctx.arc(zone.x * k, zone.y * k, zone.r * k, 0, Math.PI * 2);
  mctx.strokeStyle = '#b197fc'; mctx.lineWidth = 3; mctx.stroke();

  mctx.font = 'bold 12px system-ui';
  mctx.textAlign = 'center';
  mctx.fillStyle = 'rgba(255,255,255,.85)';
  for (const p of POIS) mctx.fillText(p.n, p.x * k, p.y * k - 6);

  for (const p of ps) {
    if (!p.al) continue;
    const isMe = p.i === myId;
    mctx.fillStyle = isMe ? '#fff' : p.b ? '#adb5bd' : p.c;
    mctx.beginPath();
    mctx.arc(p.x * k, p.y * k, isMe ? 6 : 4, 0, Math.PI * 2);
    mctx.fill();
    if (isMe) {  // Blickrichtung
      mctx.strokeStyle = '#fff'; mctx.lineWidth = 2;
      mctx.beginPath(); mctx.moveTo(p.x * k, p.y * k);
      mctx.lineTo(p.x * k + Math.cos(yaw) * 16, p.y * k + Math.sin(yaw) * 16); mctx.stroke();
    }
  }
}

function currentPoi(me) {
  let best = null, bd = Infinity;
  for (const p of POIS) {
    const d = Math.hypot(me.x - p.x, me.y - p.y);
    if (d < p.r + 80 && d < bd) { bd = d; best = p; }
  }
  return best;
}

function updateHud(me) {
  if (!me) return;
  $('alive').textContent = alive;
  $('kills').textContent = me.k;
  $('hp').style.width = Math.max(0, me.h) + '%';
  $('sh').style.width = (me.sh || 0) * 2 + '%';
  $('weapon').textContent = '🔫 ' + (WEAPON_NAME[me.w] || me.w);
  $('ammo').textContent = me.am < 0 ? '∞' : me.am;

  const top = (lastPs || []).slice().sort((a, b) => b.k - a.k || a.n.localeCompare(b.n)).slice(0, 5);
  $('boardList').innerHTML = '';
  for (const p of top) {
    const row = document.createElement('div');
    if (p.i === myId) row.className = 'me';
    const n = document.createElement('span');
    n.textContent = p.n + (p.al ? '' : ' ✝');
    const k = document.createElement('span');
    k.textContent = p.k;
    row.append(n, k);
    $('boardList').appendChild(row);
  }

  let zt;
  if (zone.st === 'hold') zt = `Schrumpft in <b>${Math.ceil(zone.tm)}s</b>`;
  else if (zone.st === 'shrink') zt = `Schrumpft noch <b>${Math.ceil(zone.tm)}s</b>`;
  else zt = '<b>Finale Zone</b>';
  $('zoneTxt').innerHTML = `Phase ${zone.ph}/4 · ${zt}`;

  const outside = Math.hypot(me.x - zone.x, me.y - zone.y) > zone.r;
  $('warn').style.display = outside && me.al ? 'block' : 'none';

  const poi = currentPoi(me);
  $('poi').textContent = poi ? '📍 ' + poi.n : '';
  $('poi').style.display = poi ? 'block' : 'none';

  chestsNear = !!me.al && pickupsNow.some(p => p.t === 'chest' && Math.hypot(p.x - me.x, p.y - me.y) < 70);
  $('hint').style.display = chestsNear ? 'block' : 'none';
}

// ---------- Render-Loop ----------
const _dir = new THREE.Vector3();
const _look = new THREE.Vector3();
const _sunT = new THREE.Vector3();
let lastFrame = performance.now();
let hudT = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const t = now / 1000;

  // Tracer
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    s.x += s.dir.x * s.speed * dt;
    s.y += s.dir.y * s.speed * dt;
    s.z += s.dir.z * s.speed * dt;
    s.mesh.position.set(s.x, s.y, s.z);
    s.life -= dt;
    if (s.life <= 0) { scene.remove(s.mesh); shots.splice(i, 1); }
  }
  // Funken
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.vy -= 500 * dt;
    p.life -= dt;
    p.mesh.position.set(p.x, Math.max(1, p.y), p.z);
    p.mat.opacity = Math.max(0, p.life / p.max);
    if (p.life <= 0) { scene.remove(p.mesh); p.mat.dispose(); parts.splice(i, 1); }
  }

  const ps = sample(now);
  const me = ps.find(p => p.i === myId);

  if (worldBuilt) {
    updatePlayers(ps);
    updateZone();
    for (const [, g] of pickupObjs) {
      g.position.y = g.userData.baseY + Math.sin(t * 3 + g.userData.phase) * 2.5;
      g.rotation.y += dt * (g.userData.chest ? 0 : 1.5);
    }
  }

  // Blick: lokal aus Maus (sofort, ohne Netzwerk-Verzögerung)
  shake = Math.max(0, shake - dt * 30);
  hitTimer = Math.max(0, hitTimer - dt);
  if (hitTimer <= 0) $('hitm').style.opacity = 0;
  recoil = Math.max(0, recoil - dt * 6);
  viewGun.position.z = -0.42 + recoil * 0.06;
  viewGun.rotation.x = recoil * 0.12;

  if (me) {
    const cx = me.x, cz = me.y;
    camera.position.set(cx, EYE, cz);
    if (shake) {
      camera.position.x += rand(-shake, shake) * 0.4;
      camera.position.y += rand(-shake, shake) * 0.4;
    }
    const cp = Math.cos(pitch);
    _dir.set(Math.cos(yaw) * cp, Math.sin(pitch), Math.sin(yaw) * cp);
    _look.copy(camera.position).add(_dir);
    camera.lookAt(_look);

    sun.position.set(cx + 400, 900, cz + 300);
    _sunT.set(cx, 0, cz);
    sun.target.position.copy(_sunT);
    sun.target.updateMatrixWorld();
  }

  renderer.render(scene, camera);

  if (now - hudT > 100) {
    hudT = now;
    updateHud(lastMe());
  }
  drawMini(ps);
}
requestAnimationFrame(frame);

// ---------- Eingaben ----------
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyE' && !e.repeat && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'use' }));
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); firing = false; });

// Maus-Look über Pointer Lock (Maus wird eingefangen)
cv.addEventListener('click', () => {
  if (lastState === 'play' && !document.pointerLockElement) cv.requestPointerLock && cv.requestPointerLock();
});
addEventListener('mousemove', e => {
  if (!document.pointerLockElement) return;
  yaw += e.movementX * SENS;   // nach rechts drehen = Yaw wächst
  pitch = Math.max(-1.4, Math.min(1.4, pitch - e.movementY * SENS));
});
cv.addEventListener('mousedown', e => { if (e.button === 0) firing = true; });
addEventListener('mouseup', e => { if (e.button === 0) firing = false; });
cv.addEventListener('contextmenu', e => e.preventDefault());

// ---------- Menü ----------
function go() {
  const name = ($('name').value.trim() || 'Spieler').slice(0, 14);
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    ac.resume && ac.resume();
  } catch (e) { /* ok */ }
  $('go').disabled = true;
  $('go').textContent = 'Verbinde …';
  connect(name);
}
$('go').addEventListener('click', go);
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
$('name').value = 'Spieler' + Math.floor(rand(10, 99));

$('diff').addEventListener('change', e => {
  diff = e.target.value;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'diff', v: diff }));
});

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => copyFallback(text));
  }
  return copyFallback(text);
}
function copyFallback(text) {
  return new Promise((resolve, reject) => {
    const t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    ok ? resolve() : reject(new Error('copy failed'));
  });
}

fetch('/api/info').then(r => r.json()).then(j => {
  if (!j.urls || !j.urls.length) return;
  const url = j.urls[0];
  $('inviteUrl').textContent = url;
  $('invite').style.display = 'block';
  const btn = $('copy');
  const flash = text => {
    btn.textContent = text;
    setTimeout(() => { btn.textContent = 'Kopieren'; }, 1600);
  };
  const doCopy = () => copyText(url).then(() => flash('Kopiert ✓')).catch(() => flash('Fehlgeschlagen'));
  btn.addEventListener('click', doCopy);
  $('inviteUrl').addEventListener('click', doCopy);
}).catch(() => { /* keine Einladung */ });
