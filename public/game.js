// Storm Royale – First-Person-Client (Three.js).
// Server-Koordinaten: x/y = Boden, Höhe getrennt. Three.js: X = x, Y = Höhe, Z = y.
// Die Welt (Gelände, Straßen, Gebäude, Bäume) kommt vom Server und wird hier gebaut.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const $ = id => document.getElementById(id);
const INTERP = 100;      // ms Verzögerung für flüssige Darstellung
const EYE = 62;          // Augenhöhe (wie Server)
const SENS = 0.0022;     // Maus-Empfindlichkeit
const PICKUP_VIEW = 1800;

// ---------- Renderer / Szene / Kamera ----------
const cv = $('c');
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const HORIZON = new THREE.Color('#cfe3f2');
const scene = new THREE.Scene();
scene.background = HORIZON.clone();
scene.fog = new THREE.Fog(HORIZON, 2200, 8000);

const camera = new THREE.PerspectiveCamera(75, 1, 1, 12000);
scene.add(camera);

scene.add(new THREE.HemisphereLight('#dceeff', '#5b6b3a', 1.0));
const sun = new THREE.DirectionalLight('#fff1d6', 1.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 1.5;
Object.assign(sun.shadow.camera, { left: -800, right: 800, top: 800, bottom: -800, near: 10, far: 4000 });
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.35).normalize();

// Waffe in der Hand (vor der Kamera, in Welt-Einheiten: 72 Einheiten ≈ 1,8 m)
const viewGun = new THREE.Group();
const vgMat = new THREE.MeshLambertMaterial({ color: 0x3a3f45 });
const vgBody = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.5, 9).translate(0, 0, -4.5), vgMat);
const vgGrip = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.2, 1.1), vgMat);
vgGrip.position.set(0, -1.6, -1);
viewGun.add(vgBody, vgGrip);
const MUZZLE = new THREE.Vector3(0, 0.3, -10);
viewGun.position.set(3.4, -3.6, -6);
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

// ---------- Texturen (ambientCG, CC0) ----------
const loader = new THREE.TextureLoader();
const TEX = {};
for (const name of ['grass', 'dirt', 'rock', 'snow', 'bricks', 'plaster', 'wood', 'concrete', 'metal',
                    'roof', 'roof_slate', 'planks', 'paving', 'bark', 'asphalt']) {
  const t = loader.load(`textures/${name}.jpg`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  TEX[name] = t;
}
// Kachelgröße in Welt-Einheiten (Breite, Höhe) – passend zum Seitenverhältnis der Bilder
const TILE = {
  bricks: [160, 80], plaster: [220, 220], wood: [140, 140], concrete: [260, 130], metal: [160, 160],
  roof: [140, 140], roof_slate: [140, 140], planks: [140, 140], paving: [120, 120],
};
const MATS = {};
function mat(name, opts = {}) {
  const key = name + JSON.stringify(opts);
  if (!MATS[key]) MATS[key] = new THREE.MeshLambertMaterial({ map: TEX[name], ...opts });
  return MATS[key];
}

// ---------- Konstanten ----------
const WEAPON_NAME = { pistol: 'Pistole', smg: 'Maschinenpistole', rifle: 'Sturmgewehr', shotgun: 'Schrotflinte', sniper: 'Scharfschützengewehr' };
const GUN_COL = { pistol: 0xadb5bd, smg: 0x495057, rifle: 0x343a40, shotgun: 0x5c3d2e, sniper: 0x1a1b1e };
const GUN_LEN = { pistol: 14, smg: 16, rifle: 22, shotgun: 19, sniper: 28 };
const VM_LEN = { pistol: 0.7, smg: 0.9, rifle: 1.3, shotgun: 1.2, sniper: 1.7 };
const PICK_COL = { smg: 0xf783ac, rifle: 0xffa94d, shotgun: 0xff6b6b, sniper: 0xb197fc, medkit: 0x51cf66, shield: 0x4dabf7, chest: 0xd4a017 };
const PICK_LABEL = { smg: 'SM', rifle: 'AR', shotgun: 'SG', sniper: 'SN', medkit: '+', shield: 'S', chest: 'T' };
const PICK_CSS = { smg: '#f783ac', rifle: '#ffa94d', shotgun: '#ff6b6b', sniper: '#b197fc', medkit: '#51cf66', shield: '#4dabf7', chest: '#ffd43b' };

// ---------- Zustand ----------
let W = null;             // Weltdaten vom Server
let MAP = 12000, GRID = 301, CELL = 40, HM = null;
let snaps = [];
let myId = null, myName = '';
let ws = null, inputTimer = null;
let alive = 0;
let firing = false, diff = 'medium';
let yaw = 0, pitch = 0, yawInit = false;
let zone = { x: 6000, y: 6000, r: 8500, st: 'hold', tm: 0, ph: 1, n: 6 };
let lastPs = [];
const keys = new Set();
let shake = 0, lastHp = 100, lastState = 'menu', recoil = 0;
let bannerTimer = 0, hitTimer = 0, ac = null;

const playerObjs = new Map();
const pickupObjs = new Map();   // id -> { grp, p }
const tracers = [];
const parts = [];
const labelTex = {};
let zoneWall = null;
let worldBuilt = false;
let mapBase = null;             // vorgerenderte Karte (Canvas)

// ---------- Gelände ----------
function heightAt(x, y) {
  const gx = Math.min(Math.max(x / CELL, 0), GRID - 1.0001), gy = Math.min(Math.max(y / CELL, 0), GRID - 1.0001);
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = gx - ix, fy = gy - iy;
  const i = iy * GRID + ix;
  const a = HM[i], b = HM[i + 1], c = HM[i + GRID], d = HM[i + GRID + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function decodeHeights(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Uint16Array(bytes.buffer);
}

// Straßenmaske: R = Feldweg, G = Asphalt, B = Pflaster
function buildRoadMask() {
  const S = 2048, k = S / MAP;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.lineCap = g.lineJoin = 'round';
  g.filter = 'blur(1px)';
  const order = { dirt: 0, asphalt: 1, plaza: 2 };
  for (const r of W.roads.slice().sort((a, b) => order[a.t] - order[b.t])) {
    if (r.t === 'plaza') {
      g.fillStyle = 'rgb(0,0,255)';
      g.beginPath(); g.arc(r.p[0][0] * k, r.p[0][1] * k, (r.w / 2) * k, 0, Math.PI * 2); g.fill();
      continue;
    }
    g.strokeStyle = r.t === 'asphalt' ? 'rgb(0,255,0)' : 'rgb(255,0,0)';
    g.lineWidth = r.w * k;
    g.beginPath();
    r.p.forEach(([x, y], i) => (i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k)));
    g.stroke();
  }
  // Bodenplatten unter Gebäuden (Pflaster) – verhindert Gras im Haus
  g.fillStyle = 'rgb(0,0,255)';
  for (const b of W.buildings) g.fillRect(b.x0 * k - 2, b.y0 * k - 2, (b.x1 - b.x0) * k + 4, (b.y1 - b.y0) * k + 4);
  const t = new THREE.CanvasTexture(c);
  t.flipY = false;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function buildTerrain() {
  const n = GRID;
  const pos = new Float32Array(n * n * 3);
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const i = gy * n + gx;
      pos[i * 3] = gx * CELL;
      pos[i * 3 + 1] = HM[i];
      pos[i * 3 + 2] = gy * CELL;
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let gy = 0; gy < n - 1; gy++) {
    for (let gx = 0; gx < n - 1; gx++) {
      const a = gy * n + gx, b = a + 1, c = a + n, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  const mask = buildRoadMask();
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      tGrass: { value: TEX.grass }, tDirt: { value: TEX.dirt }, tRock: { value: TEX.rock },
      tSnow: { value: TEX.snow }, tAsphalt: { value: TEX.asphalt }, tPaving: { value: TEX.paving },
      tMask: { value: mask }, uMap: { value: MAP },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
varying vec3 vWNormal;
uniform sampler2D tGrass, tDirt, tRock, tSnow, tAsphalt, tPaving, tMask;
uniform float uMap;
vec3 tri(sampler2D t, vec3 p, vec3 n, float s) {
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
  return texture2D(t, p.zy / s).rgb * w.x + texture2D(t, p.xz / s).rgb * w.y + texture2D(t, p.xy / s).rgb * w.z;
}`)
      .replace('#include <map_fragment>', `
vec3 n = normalize(vWNormal);
float slope = 1.0 - n.y;
vec2 uv = vWPos.xz;
vec3 grass = mix(texture2D(tGrass, uv / 170.0).rgb, texture2D(tGrass, uv / 1100.0).rgb, 0.45);
grass *= mix(0.85, 1.1, texture2D(tDirt, uv / 3000.0).g);
vec3 col = grass;
vec4 mk = texture2D(tMask, uv / uMap);
col = mix(col, texture2D(tDirt, uv / 160.0).rgb, smoothstep(0.15, 0.6, mk.r));
col = mix(col, texture2D(tAsphalt, uv / 220.0).rgb * 0.8, smoothstep(0.15, 0.6, mk.g));
col = mix(col, texture2D(tPaving, uv / 120.0).rgb, smoothstep(0.15, 0.6, mk.b));
vec3 rock = tri(tRock, vWPos, n, 380.0);
col = mix(col, rock, smoothstep(0.28, 0.45, slope) * (1.0 - mk.g) * (1.0 - mk.b));
float snowF = smoothstep(1250.0, 1450.0, vWPos.y + texture2D(tDirt, uv / 900.0).r * 120.0) * (1.0 - smoothstep(0.4, 0.6, slope));
col = mix(col, texture2D(tSnow, uv / 300.0).rgb * 1.05, snowF);
diffuseColor.rgb *= col;
`);
  };
  const mesh = new THREE.Mesh(geo, m);
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// Himmel: Farbverlauf-Kuppel, folgt der Kamera
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(10000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color('#4f8fd6') }, bottom: { value: HORIZON } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(vP.y * 2.2, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, h), 1.0); }',
  })
);
sky.renderOrder = -1;
scene.add(sky);

// ---------- Gebäude ----------
// Quader mit Texturkoordinaten in Welt-Einheiten (Texturen kacheln gleichmäßig)
function boxGeo(x0, x1, y0, y1, h0, h1, tile) {
  const w = x1 - x0, d = y1 - y0, h = h1 - h0;
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * dims[f][0] / tile[0], uv.getY(i) * dims[f][1] / tile[1]);
    }
  }
  g.translate((x0 + x1) / 2, (h0 + h1) / 2, (y0 + y1) / 2);
  return g;
}

// Satteldach als Prisma, First entlang 'x' oder 'y'
function gableGeo(b, base, rh, o, tile) {
  const { x0, x1, y0, y1 } = b;
  const pos = [], uv = [];
  const tri = (a, bb, c, ua, ub, uc) => { pos.push(...a, ...bb, ...c); uv.push(...ua, ...ub, ...uc); };
  const quad = (a, bb, c, d, len, sl) => {
    tri(a, bb, c, [0, 0], [len / tile[0], 0], [len / tile[0], sl / tile[1]]);
    tri(a, c, d, [0, 0], [len / tile[0], sl / tile[1]], [0, sl / tile[1]]);
  };
  if (b.rg === 'x') {
    const ym = (y0 + y1) / 2, L = x1 - x0 + 2 * o, half = (y1 - y0) / 2 + o, sl = Math.hypot(half, rh);
    const A = [x0 - o, base, y0 - o], B = [x1 + o, base, y0 - o], C = [x1 + o, base, y1 + o], D = [x0 - o, base, y1 + o];
    const R1 = [x0 - o, base + rh, ym], R2 = [x1 + o, base + rh, ym];
    quad(A, B, R2, R1, L, sl);
    quad(C, D, R1, R2, L, sl);
  } else {
    const xm = (x0 + x1) / 2, L = y1 - y0 + 2 * o, half = (x1 - x0) / 2 + o, sl = Math.hypot(half, rh);
    const A = [x0 - o, base, y1 + o], B = [x0 - o, base, y0 - o], C = [x1 + o, base, y0 - o], D = [x1 + o, base, y1 + o];
    const R1 = [xm, base + rh, y1 + o], R2 = [xm, base + rh, y0 - o];
    quad(A, B, R2, R1, L, sl);
    quad(C, D, R1, R2, L, sl);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// Giebel-Dreiecke (Wandmaterial) an den Stirnseiten
function gableEnds(b, base, rh, tile) {
  const { x0, x1, y0, y1 } = b;
  const pos = [], uv = [];
  const push = (pts, us) => { pts.forEach(p => pos.push(...p)); us.forEach(u => uv.push(...u)); };
  if (b.rg === 'x') {
    const ym = (y0 + y1) / 2, d = y1 - y0;
    for (const x of [x0, x1]) push([[x, base, y0], [x, base, y1], [x, base + rh, ym]], [[0, 0], [d / tile[0], 0], [d / 2 / tile[0], rh / tile[1]]]);
  } else {
    const xm = (x0 + x1) / 2, w = x1 - x0;
    for (const y of [y0, y1]) push([[x0, base, y], [x1, base, y], [xm, base + rh, y]], [[0, 0], [w / tile[0], 0], [w / 2 / tile[0], rh / tile[1]]]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function buildBuildings() {
  const groups = {};   // Material -> Geometrien
  const add = (key, geo) => (groups[key] = groups[key] || []).push(geo);
  const glass = [];
  const T = 10;

  for (const b of W.buildings) {
    const g = b.g, wh = b.wh, tile = TILE[b.m] || [200, 200];
    // Wände (inkl. Innenwände)
    for (const [x0, x1, y0, y1] of b.w) add(b.m, boxGeo(x0, x1, y0, y1, g - 20, g + wh, tile));
    if (b.t === 'tower') {
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, r = (b.x1 - b.x0) * 0.78;
      const cone = new THREE.ConeGeometry(r, 190, 4, 1).rotateY(Math.PI / 4).translate(cx, g + wh + 95, cy);
      add(b.rm, cone);
      // Turmuhr / Schallfenster
      for (const [dx, dy, rot] of [[0, -1, 0], [0, 1, 0], [-1, 0, 1], [1, 0, 1]]) {
        const s = (b.x1 - b.x0) / 2 + 0.6;
        const geo = rot ? new THREE.BoxGeometry(1, 50, 22) : new THREE.BoxGeometry(22, 50, 1);
        glass.push(geo.translate(cx + dx * s, g + wh - 70, cy + dy * s));
      }
      continue;
    }
    // Boden
    add(b.t === 'warehouse' || b.t === 'apartment' ? 'concrete' : 'planks', boxGeo(b.x0 + T, b.x1 - T, b.y0 + T, b.y1 - T, g - 4, g + 1.5, TILE.planks));
    // Dach
    if (b.rf === 'gable') {
      const rh = Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.38;
      add(b.rm, gableGeo(b, g + wh, rh, 12, TILE[b.rm] || [140, 140]));
      add(b.m, gableEnds(b, g + wh, rh, tile));
    } else {
      add('concrete', boxGeo(b.x0 - 4, b.x1 + 4, b.y0 - 4, b.y1 + 4, g + wh, g + wh + 8, TILE.concrete));
      // Brüstung
      add(b.m, boxGeo(b.x0 - 4, b.x1 + 4, b.y0 - 4, b.y0 + 2, g + wh + 8, g + wh + 22, tile));
      add(b.m, boxGeo(b.x0 - 4, b.x1 + 4, b.y1 - 2, b.y1 + 4, g + wh + 8, g + wh + 22, tile));
      add(b.m, boxGeo(b.x0 - 4, b.x0 + 2, b.y0 - 4, b.y1 + 4, g + wh + 8, g + wh + 22, tile));
      add(b.m, boxGeo(b.x1 - 2, b.x1 + 4, b.y0 - 4, b.y1 + 4, g + wh + 8, g + wh + 22, tile));
    }
    // Fenster (nur Optik) an den Außenseiten, nicht an der Tür
    const floors = Math.max(1, Math.floor((wh - 20) / 100));
    const winW = b.t === 'shop' ? 60 : 30, winH = b.t === 'shop' ? 60 : 38;
    const sides = [
      ['n', b.x0, b.x1, b.y0 - 0.8, 'x'], ['s', b.x0, b.x1, b.y1 + 0.8, 'x'],
      ['w', b.y0, b.y1, b.x0 - 0.8, 'y'], ['e', b.y0, b.y1, b.x1 + 0.8, 'y'],
    ];
    for (const [side, a0, a1, fixed, axis] of sides) {
      const len = a1 - a0, mid = (a0 + a1) / 2;
      const count = Math.floor((len - 40) / 80);
      for (let f = 0; f < floors; f++) {
        const hy = g + (b.t === 'barn' || b.t === 'warehouse' ? wh - 50 : 48 + f * 100) + winH / 2;
        for (let i = 0; i < count; i++) {
          const at = a0 + (len - (count - 1) * 80) / 2 + i * 80;
          if (side === b.d && f === 0 && Math.abs(at - mid) < 60) continue;   // Tür freilassen
          const geo = axis === 'x' ? new THREE.BoxGeometry(winW, winH, 1.5) : new THREE.BoxGeometry(1.5, winH, winW);
          glass.push(axis === 'x' ? geo.translate(at, hy, fixed) : geo.translate(fixed, hy, at));
        }
      }
    }
  }

  for (const [key, geos] of Object.entries(groups)) {
    const merged = mergeGeometries(geos.map(g => (g.index ? g.toNonIndexed() : g)), false);
    const mesh = new THREE.Mesh(merged, mat(key, { side: THREE.DoubleSide }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  if (glass.length) {
    const gm = new THREE.Mesh(mergeGeometries(glass.map(g => g.toNonIndexed()), false),
      new THREE.MeshLambertMaterial({ color: 0x2b3f55, emissive: 0x0d1b2a }));
    scene.add(gm);
  }
}

// ---------- Bäume & Felsen (Instancing) ----------
function buildVegetation() {
  const con = W.trees.filter(t => t[3] === 0), dec = W.trees.filter(t => t[3] === 1);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const col = new THREE.Color();
  const barkMat = new THREE.MeshLambertMaterial({ map: TEX.bark });
  const leafMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
  const Y = new THREE.Vector3(0, 1, 0);

  const make = (list, parts) => {
    for (const [geo, material, colorFn] of parts) {
      const im = new THREE.InstancedMesh(geo, material, list.length);
      list.forEach(([x, y, sc], i) => {
        q.setFromAxisAngle(Y, (x * 13 + y * 7) % 6.28);
        p.set(x, heightAt(x, y) - 4, y);
        s.set(sc, sc * (0.9 + ((x + y) % 7) / 30), sc);
        m4.compose(p, q, s);
        im.setMatrixAt(i, m4);
        if (colorFn) im.setColorAt(i, colorFn(col, x, y));
      });
      im.castShadow = true;
      im.receiveShadow = true;
      scene.add(im);
    }
  };
  const conColor = (c, x, y) => c.setHSL(0.30 + ((x * 3 + y) % 10) / 400, 0.45, 0.16 + ((x + y * 3) % 10) / 120);
  const decColor = (c, x, y) => c.setHSL(0.22 + ((x * 7 + y) % 10) / 150, 0.5, 0.22 + ((x + y * 5) % 10) / 90);
  make(con, [
    [new THREE.CylinderGeometry(4, 6, 40, 6).translate(0, 20, 0), barkMat],
    [new THREE.ConeGeometry(34, 70, 8).translate(0, 62, 0), leafMat, conColor],
    [new THREE.ConeGeometry(26, 56, 8).translate(0, 100, 0), leafMat, conColor],
    [new THREE.ConeGeometry(16, 40, 8).translate(0, 132, 0), leafMat, conColor],
  ]);
  make(dec, [
    [new THREE.CylinderGeometry(5, 7, 70, 6).translate(0, 35, 0), barkMat],
    [new THREE.IcosahedronGeometry(40, 1).scale(1, 0.85, 1).translate(0, 100, 0), leafMat, decColor],
    [new THREE.IcosahedronGeometry(26, 1).translate(18, 128, 6), leafMat, decColor],
  ]);

  const rockGeo = new THREE.DodecahedronGeometry(1, 1);
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ map: TEX.rock, flatShading: true }), W.rocks.length);
  W.rocks.forEach(([x, y, r], i) => {
    q.setFromEuler(new THREE.Euler(x % 3, y % 3, (x + y) % 3));
    p.set(x, heightAt(x, y) + r * 0.15, y);
    s.set(r, r * 0.7, r * 1.1);
    m4.compose(p, q, s);
    rocks.setMatrixAt(i, m4);
  });
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  scene.add(rocks);
}

function buildZone() {
  zoneWall = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 6000, 128, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x9b59ff, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false, fog: false })
  );
  scene.add(zoneWall);
}
function updateZone() {
  if (!zoneWall) return;
  zoneWall.position.set(zone.x, 2500, zone.y);
  zoneWall.scale.set(zone.r, 1, zone.r);
}

// ---------- Karte (vorgerendert) ----------
function buildMapBase() {
  const S = 1024, k = MAP / S;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const wx = x * k, wy = y * k, h = heightAt(wx, wy);
      const shade = Math.max(0.45, Math.min(1.25, 0.85 + (heightAt(wx - 20, wy - 20) - h) / 40));
      let r, gg, b;
      if (h > 1350) { r = 236; gg = 240; b = 244; }
      else if (h > 900) { r = 138; gg = 132; b = 118; }
      else { r = 92 + h * 0.04; gg = 140 - h * 0.02; b = 70; }
      const i = (y * S + x) * 4;
      img.data[i] = r * shade; img.data[i + 1] = gg * shade; img.data[i + 2] = b * shade; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.lineCap = 'round';
  for (const r of W.roads) {
    if (r.t === 'plaza') continue;
    g.strokeStyle = r.t === 'asphalt' ? '#5a5a5a' : '#b8945c';
    g.lineWidth = Math.max(1.5, r.w / k);
    g.beginPath();
    r.p.forEach(([x, y], i) => (i ? g.lineTo(x / k, y / k) : g.moveTo(x / k, y / k)));
    g.stroke();
  }
  g.fillStyle = '#7a3b2e';
  for (const b of W.buildings) g.fillRect(b.x0 / k, b.y0 / k, Math.max(1.5, (b.x1 - b.x0) / k), Math.max(1.5, (b.y1 - b.y0) / k));
  g.font = 'bold 15px system-ui';
  g.textAlign = 'center';
  for (const p of W.pois) {
    g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.65)';
    g.strokeText(p.n, p.x / k, p.y / k - p.r / k - 4);
    g.fillStyle = p.k === 'city' ? '#ffe066' : '#ffffff';
    g.fillText(p.n, p.x / k, p.y / k - p.r / k - 4);
  }
  mapBase = c;
}

// ---------- Pickups ----------
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

const pickGeo = new THREE.BoxGeometry(14, 14, 14);
const chestGeo = boxGeo(-16, 16, -11, 11, 0, 20, [40, 40]);
const chestLid = boxGeo(-17, 17, -12, 12, 20, 25, [40, 40]);
const pickMats = {};
function addPickup(p) {
  if (pickupObjs.has(p.i)) return;
  const isChest = p.t === 'chest';
  const grp = new THREE.Group();
  if (isChest) {
    const wood = mat('planks');
    const box = new THREE.Mesh(chestGeo, wood);
    const lid = new THREE.Mesh(chestLid, new THREE.MeshLambertMaterial({ color: 0xd4a017, emissive: 0x3a2a00 }));
    box.castShadow = lid.castShadow = true;
    grp.add(box, lid);
  } else {
    const col = PICK_COL[p.t] || 0xffffff;
    pickMats[p.t] = pickMats[p.t] || new THREE.MeshLambertMaterial({ color: col, emissive: col, emissiveIntensity: 0.35 });
    const box = new THREE.Mesh(pickGeo, pickMats[p.t]);
    box.position.y = 14;
    grp.add(box);
    grp.userData.box = box;
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(p.t), depthWrite: false }));
  sprite.scale.set(isChest ? 26 : 20, isChest ? 26 : 20, 1);
  sprite.position.y = isChest ? 48 : 38;
  grp.add(sprite);
  grp.position.set(p.x, heightAt(p.x, p.y), p.y);
  grp.rotation.y = (p.i * 1.7) % 6.28;
  grp.userData.phase = p.i * 0.7;
  grp.visible = false;
  scene.add(grp);
  pickupObjs.set(p.i, { grp, p });
}
function removePickup(id) {
  const o = pickupObjs.get(id);
  if (!o) return;
  scene.remove(o.grp);
  o.grp.children.forEach(c => c.isSprite && c.material.dispose());
  pickupObjs.delete(id);
}
function resetPickups(list) {
  for (const id of [...pickupObjs.keys()]) removePickup(id);
  list.forEach(addPickup);
}

// ---------- Spieler (andere) ----------
const GEO_BODY = new THREE.CapsuleGeometry(10, 26, 4, 10).translate(0, 23, 0);
const GEO_HEAD = new THREE.SphereGeometry(8, 14, 10).translate(0, 60, 0);
const GEO_GUN = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0, 0);
const MAT_SKIN = new THREE.MeshLambertMaterial({ color: 0xffd8b1 });

function drawName(pl, p) {
  const g = pl.ctx;
  g.clearRect(0, 0, 256, 64);
  g.font = '30px system-ui';
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
  const body = new THREE.Mesh(GEO_BODY, new THREE.MeshLambertMaterial({ color: new THREE.Color(p.c || '#4dabf7') }));
  const head = new THREE.Mesh(GEO_HEAD, MAT_SKIN);
  const gunMat = new THREE.MeshLambertMaterial({ color: GUN_COL[p.w] || 0xadb5bd });
  const gun = new THREE.Mesh(GEO_GUN, gunMat);
  gun.position.set(8, 42, 5);
  gun.scale.set(GUN_LEN[p.w] || 14, 4, 4);
  for (const m of [body, head, gun]) { m.castShadow = true; group.add(m); }
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set(64, 16, 1);
  sprite.position.y = 90;
  group.add(sprite);
  scene.add(group);
  const pl = { group, gun, gunMat, ctx: canvas.getContext('2d'), tex, key: '' };
  playerObjs.set(p.i, pl);
  return pl;
}

function updatePlayers(ps) {
  const seen = new Set();
  for (const p of ps) {
    seen.add(p.i);
    const pl = playerObjs.get(p.i) || createPlayer(p);
    pl.group.visible = !!p.al && p.i !== myId;
    if (!pl.group.visible) continue;
    pl.group.position.set(p.x, heightAt(p.x, p.y), p.y);
    pl.group.rotation.y = -p.a;
    const gc = GUN_COL[p.w] || 0xadb5bd;
    if (pl.gunMat.color.getHex() !== gc) {
      pl.gunMat.color.setHex(gc);
      pl.gun.scale.set(GUN_LEN[p.w] || 14, 4, 4);
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
    if (!worldBuilt) {
      $('go').textContent = 'Baue Welt …';
      W = m.world;
      MAP = W.map; GRID = W.grid; CELL = MAP / (GRID - 1);
      HM = decodeHeights(W.hm);
      buildTerrain();
      buildBuildings();
      buildVegetation();
      buildZone();
      buildMapBase();
      worldBuilt = true;
    }
    resetPickups(m.pk || []);
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

  if (worldBuilt) {
    if (m.pk) resetPickups(m.pk);
    if (m.pa) m.pa.forEach(addPickup);
    if (m.pr) m.pr.forEach(removePickup);
  }
  zone = m.z;
  alive = m.al;

  const me = map.get(myId);
  if (me) {
    if (!yawInit) { yaw = me.a; yawInit = true; }
    if (me.h < lastHp - 0.5) shake = Math.min(10, shake + (lastHp - me.h) * 0.15);
    lastHp = me.h;
    if (!me.al && lastState === 'play') {
      lastState = 'dead';
      if (document.pointerLockElement) document.exitPointerLock();
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
    case 'hit':
      if (ev.s === myId) {
        hitTimer = 0.18;
        $('hitm').style.opacity = 1;
        $('hitm').classList.toggle('head', !!ev.hd);
        sfx(ev.hd ? 1600 : 1200, 900, 0.05, 0.03);
      }
      sparks(ev.x, ev.h, ev.y, 0xff4d4d, 6);
      break;
    case 'open': sfx(600, 900, 0.18, 0.05); break;
    case 'kill': addFeed(ev); break;
    case 'end':
      showBanner(ev.h && ev.w === myName ? '🏆 DU GEWINNST!' : `🏆 ${ev.w} gewinnt`, 4500);
      break;
    case 'start':
      $('dead').style.display = 'none';
      lastState = 'play';
      yawInit = false;
      showBanner('Neues Match – viel Glück!', 2000);
      break;
  }
}

function sendInput() {
  if (!ws || ws.readyState !== 1 || myId == null) return;
  const mx = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const my = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const s = firing || keys.has('Space') ? 1 : 0;
  const sp = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0;
  ws.send(JSON.stringify({ t: 'in', mx, my, a: yaw, pt: pitch, s, sp }));
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

const GEO_SPARK = new THREE.SphereGeometry(1.6, 5, 3);
function sparks(x, h, y, color, n) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true });
    const mesh = new THREE.Mesh(GEO_SPARK, m);
    scene.add(mesh);
    parts.push({ mesh, mat: m, x, y: h, z: y, vx: rand(-80, 80), vy: rand(40, 160), vz: rand(-80, 80), life: .35, max: .35 });
  }
}

const GEO_TRACER = new THREE.BoxGeometry(0.7, 0.7, 1).translate(0, 0, 0.5);
const MAT_TRACER = new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9, fog: false });
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1);
function spawnShot(ev) {
  const me = lastMe();
  if (me) {
    const d = Math.hypot(me.x - ev.x, me.y - ev.y);
    if (d < 1500) sfx(700, 140, 0.09, 0.05 * (1 - d / 1500) + 0.005);
  }
  const own = ev.o === myId;
  if (own) recoil = 1;
  for (const [ex, ey, eh, kind] of ev.e) {
    if (own) _a.copy(MUZZLE).applyMatrix4(viewGun.matrixWorld);
    else _a.set(ev.x, ev.h - 8, ev.y);
    _b.set(ex, eh, ey);
    const len = _a.distanceTo(_b);
    if (len > 2) {
      const mesh = new THREE.Mesh(GEO_TRACER, MAT_TRACER);
      mesh.position.copy(_a);
      mesh.quaternion.setFromUnitVectors(_z, _b.clone().sub(_a).normalize());
      mesh.scale.set(1, 1, len);
      scene.add(mesh);
      tracers.push({ mesh, life: 0.06 });
    }
    if (kind === 1) sparks(ex, eh, ey, 0xffd43b, 4);
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

// ---------- Minimap, große Karte & HUD ----------
const mm = $('mm'), mctx = mm.getContext('2d');
const bm = $('bigmap'), bctx = bm.getContext('2d');

function drawMapLayer(g, S, x0, y0, span, ps, me) {
  // Ausschnitt [x0, x0+span] der Welt auf S×S Pixel
  const k = S / span, kb = mapBase.width / MAP;
  g.clearRect(0, 0, S, S);
  g.drawImage(mapBase, x0 * kb, y0 * kb, span * kb, span * kb, 0, 0, S, S);
  const zx = (zone.x - x0) * k, zy = (zone.y - y0) * k, zr = zone.r * k;
  g.beginPath(); g.rect(0, 0, S, S); g.moveTo(zx + zr, zy); g.arc(zx, zy, zr, 0, Math.PI * 2, true);
  g.fillStyle = 'rgba(90, 20, 160, .45)'; g.fill('evenodd');
  g.beginPath(); g.arc(zx, zy, zr, 0, Math.PI * 2);
  g.strokeStyle = '#d0b0ff'; g.lineWidth = 2; g.stroke();
  for (const p of ps) {
    if (!p.al || p.i === myId) continue;
    if (span > 5000 && p.b) continue;   // auf der großen Karte keine Bots
    g.fillStyle = p.b ? '#e9ecef' : p.c;
    g.beginPath(); g.arc((p.x - x0) * k, (p.y - y0) * k, 3, 0, Math.PI * 2); g.fill();
  }
  if (me) {
    const px = (me.x - x0) * k, py = (me.y - y0) * k;
    g.save(); g.translate(px, py); g.rotate(yaw);
    g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(9, 0); g.lineTo(-6, -6); g.lineTo(-3, 0); g.lineTo(-6, 6); g.closePath();
    g.fill(); g.stroke(); g.restore();
  }
}

function drawMini(ps, me) {
  if (!mapBase || !me) return;
  const span = 2400;
  drawMapLayer(mctx, mm.width, me.x - span / 2, me.y - span / 2, span, ps, me);
  if (bm.style.display === 'block') drawMapLayer(bctx, bm.width, 0, 0, MAP, ps, me);
}

function currentPoi(me) {
  if (!W) return null;
  let best = null, bd = Infinity;
  for (const p of W.pois) {
    const d = Math.hypot(me.x - p.x, me.y - p.y);
    if (d < p.r + 120 && d < bd) { bd = d; best = p; }
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
  vgMat.color.setHex(GUN_COL[me.w] || 0x3a3f45);
  vgBody.scale.z = VM_LEN[me.w] || 1;

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
  $('zoneTxt').innerHTML = `Phase ${zone.ph}/${zone.n || 6} · ${zt}`;

  const dz = Math.hypot(me.x - zone.x, me.y - zone.y);
  const outside = dz > zone.r;
  $('warn').style.display = outside && me.al ? 'block' : 'none';
  if (outside) $('warn').textContent = `⚠ Außerhalb der Zone – ${Math.round((dz - zone.r) / 40)} m bis zur Zone`;

  const poi = currentPoi(me);
  $('poi').textContent = poi ? '📍 ' + poi.n : '';
  $('poi').style.display = poi ? 'block' : 'none';

  let near = false;
  if (me.al) for (const { p } of pickupObjs.values()) {
    if (p.t === 'chest' && Math.abs(p.x - me.x) < 80 && Math.abs(p.y - me.y) < 80 && Math.hypot(p.x - me.x, p.y - me.y) < 80) { near = true; break; }
  }
  $('hint').style.display = near ? 'block' : 'none';

  // Pickups nur in der Nähe anzeigen
  for (const { grp, p } of pickupObjs.values()) {
    grp.visible = Math.abs(p.x - me.x) < PICKUP_VIEW && Math.abs(p.y - me.y) < PICKUP_VIEW;
  }
}

// ---------- Render-Loop ----------
const _dir = new THREE.Vector3();
const _look = new THREE.Vector3();
let lastFrame = performance.now();
let hudT = 0, miniT = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const t = now / 1000;

  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.life -= dt;
    if (tr.life <= 0) { scene.remove(tr.mesh); tracers.splice(i, 1); }
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.vy -= 500 * dt;
    p.life -= dt;
    p.mesh.position.set(p.x, p.y, p.z);
    p.mat.opacity = Math.max(0, p.life / p.max);
    if (p.life <= 0) { scene.remove(p.mesh); p.mat.dispose(); parts.splice(i, 1); }
  }

  const ps = sample(now);
  const me = ps.find(p => p.i === myId);

  if (worldBuilt) {
    updatePlayers(ps);
    updateZone();
    for (const { grp } of pickupObjs.values()) {
      if (!grp.visible || !grp.userData.box) continue;
      grp.userData.box.position.y = 14 + Math.sin(t * 3 + grp.userData.phase) * 2.5;
      grp.userData.box.rotation.y += dt * 1.5;
    }
  }

  shake = Math.max(0, shake - dt * 30);
  hitTimer = Math.max(0, hitTimer - dt);
  if (hitTimer <= 0) $('hitm').style.opacity = 0;
  recoil = Math.max(0, recoil - dt * 6);
  viewGun.position.z = -6 + recoil * 1.2;
  viewGun.rotation.x = recoil * 0.12;
  // leichtes Wippen beim Laufen
  const moving = keys.has('KeyW') || keys.has('KeyA') || keys.has('KeyS') || keys.has('KeyD');
  viewGun.position.y = -3.6 + (moving ? Math.sin(t * 10) * 0.25 : 0);

  if (me && worldBuilt) {
    const g = heightAt(me.x, me.y);
    camera.position.set(me.x, g + EYE, me.y);
    if (shake) {
      camera.position.x += rand(-shake, shake) * 0.3;
      camera.position.y += rand(-shake, shake) * 0.3;
    }
    const cp = Math.cos(pitch);
    _dir.set(Math.cos(yaw) * cp, Math.sin(pitch), Math.sin(yaw) * cp);
    _look.copy(camera.position).add(_dir);
    camera.lookAt(_look);

    sun.position.set(me.x + SUN_DIR.x * 2000, g + SUN_DIR.y * 2000, me.y + SUN_DIR.z * 2000);
    sun.target.position.set(me.x, g, me.y);
    sun.target.updateMatrixWorld();
    sky.position.copy(camera.position);
  }

  renderer.render(scene, camera);

  if (now - hudT > 100) { hudT = now; updateHud(lastMe()); }
  if (now - miniT > 50) { miniT = now; drawMini(ps, me); }
}
requestAnimationFrame(frame);

// ---------- Eingaben ----------
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyE' && !e.repeat && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'use' }));
  if (e.code === 'KeyM' && !e.repeat) bm.style.display = bm.style.display === 'block' ? 'none' : 'block';
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); firing = false; });

cv.addEventListener('click', () => {
  if (lastState === 'play' && !document.pointerLockElement) cv.requestPointerLock && cv.requestPointerLock();
});
addEventListener('mousemove', e => {
  if (!document.pointerLockElement) return;
  yaw += e.movementX * SENS;   // nach rechts drehen = Yaw wächst
  pitch = Math.max(-1.45, Math.min(1.45, pitch - e.movementY * SENS));
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

// Debug-Zugang für automatische Tests (nur mit #debug in der URL)
if (location.hash.includes('debug')) {
  window.__sr = {
    look(y, p) { yaw = y; pitch = p; yawInit = true; },
    state: () => ({ me: lastMe(), worldBuilt, pickups: pickupObjs.size, calls: renderer.info.render.calls, tris: renderer.info.render.triangles }),
  };
}
