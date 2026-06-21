// Doodle Guys — 3D client (Three.js).
// Loads Three from a CDN via the importmap in index.html (the player's
// browser fetches it). Home/lobby are plain DOM; the game is a WebGL scene.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MAPS, POSES, DEFAULT_MAP_ID, KIT_SCALE } from '/shared/maps.js';

const AVATARS = ['🦎', '🐙', '🐸', '🦊', '🐼', '🐯', '🐧', '🦄', '🐳', '👾', '🤖', '👻'];
const socket = io();
const $ = (id) => document.getElementById(id);

// ---- UI state -----------------------------------------------------------
let myId = null, snap = null, serverSkew = 0, inRoom = false;
let chosenAvatar = AVATARS[0];

// Brush state for free-form painting.
let brushColor = '#3bd16a';
let brushSize = 'm';                 // 's' | 'm' | 'l'
const BRUSH_PX = { s: 5, m: 12, l: 26 };

// Hider working body (local, smooth); seeker first-person position.
let myBody = null, myBodyRound = -1;
let seekerPos = null, seekerRound = -1;
let lastMoveSent = 0, lastTexSent = 0, paintDirtyForSync = false;

// ---- Screens ------------------------------------------------------------
function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(`screen-${screen}`).classList.add('active');
}
function toast(msg, ms = 1800) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- Home ---------------------------------------------------------------
function buildAvatars() {
  const wrap = $('avatarPicker'); wrap.innerHTML = '';
  AVATARS.forEach((a) => {
    const b = document.createElement('button');
    b.textContent = a;
    if (a === chosenAvatar) b.classList.add('sel');
    b.onclick = () => { chosenAvatar = a; buildAvatars(); };
    wrap.appendChild(b);
  });
}
function myInfo() {
  const name = ($('nameInput').value || '').trim().slice(0, 12) || 'Doodler';
  return { name, avatar: chosenAvatar };
}
$('createBtn').onclick = () => socket.emit('create', myInfo(), (res) => {
  if (res && res.ok) { inRoom = true; $('homeError').textContent = ''; }
});
$('joinBtn').onclick = () => doJoin($('codeInput').value);
function doJoin(code) {
  code = (code || '').trim().toUpperCase();
  if (code.length < 4) { $('homeError').textContent = 'Enter a 4-letter code.'; return; }
  socket.emit('join', { code, ...myInfo() }, (res) => {
    if (res && res.ok) { inRoom = true; $('homeError').textContent = ''; }
    else $('homeError').textContent = (res && res.error) || 'Could not join.';
  });
}

// ---- Lobby --------------------------------------------------------------
$('leaveLobbyBtn').onclick = () => { socket.emit('leave'); inRoom = false; snap = null; show('home'); };
$('startBtn').onclick = () => socket.emit('start');
$('shareBtn').onclick = async () => {
  const url = `${location.origin}/?room=${snap.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Doodle Guys', text: `Join my game! Code: ${snap.code}`, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied!'); }
  } catch (_) {}
};
function buildMapSelect() {
  const sel = $('mapSelect'); if (sel.options.length) return;
  Object.values(MAPS).forEach((m) => {
    const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; sel.appendChild(o);
  });
}
['mapSelect', 'modeSelect'].forEach((id) =>
  $(id).addEventListener('change', () => socket.emit('settings', { [id.replace('Select', '')]: $(id).value })));
$('prepInput').addEventListener('change', () => socket.emit('settings', { prepTime: +$('prepInput').value }));
$('huntInput').addEventListener('change', () => socket.emit('settings', { huntTime: +$('huntInput').value }));
$('roundsInput').addEventListener('change', () => socket.emit('settings', { rounds: +$('roundsInput').value }));

function renderLobby() {
  $('lobbyCode').textContent = snap.code;
  const isHost = snap.hostId === myId;
  $('playerCount').textContent = `(${snap.players.length}/12)`;
  $('playerList').innerHTML = snap.players.map((p) => `
    <li><span class="pemoji">${p.avatar}</span><span class="pname">${escapeHtml(p.name)}</span>
    ${p.isHost ? '<span class="tagbadge host">HOST</span>' : ''}</li>`).join('');
  $('hostSettings').classList.toggle('hidden', !isHost);
  $('guestWait').classList.toggle('hidden', isHost);
  $('startBtn').classList.toggle('hidden', !isHost);
  $('startBtn').disabled = !(isHost && snap.players.length >= 1);
  $('lobbyHint').textContent = snap.players.length < 1 ? 'Need at least 1 player to start.' : '';
  if (isHost) {
    buildMapSelect();
    $('mapSelect').value = snap.settings.map; $('modeSelect').value = snap.settings.mode;
    $('prepInput').value = snap.settings.prepTime; $('huntInput').value = snap.settings.huntTime;
    $('roundsInput').value = snap.settings.rounds;
  }
}

// ======================================================================
//  THREE.JS SCENE
// ======================================================================
let renderer, scene, camera, raycaster, clock, sunLight;
let roomGroup = null, builtMapId = null;
let collisionBoxes = [];            // solid AABBs for wall/landmark collision (Kenney maps)
let collisionMeshes = [];           // meshes raycast for collision (scene GLBs)
const charGroups = new Map();       // hider id -> Group (hunt phase)
let myChar = null;                  // hider's own Group (prep)
let threeReady = false;

// ---- Kenney GLB model loading ------------------------------------------
const gltfLoader = new GLTFLoader();
const modelCache = new Map();       // url -> Promise<THREE.Group prototype>

function modelUrl(kit, name) {
  // The "GLB format" folder has a space; encode the whole path safely.
  return encodeURI(`/models/${kit}/Models/GLB format/${name}.glb`);
}

// Load a GLB once (by URL), then hand out lightweight clones. `pointFilter`
// point-samples the texture (for Kenney's tiny palette atlas); leave it off
// for full-resolution scene textures.
function loadModelByUrl(url, pointFilter) {
  if (!modelCache.has(url)) {
    modelCache.set(url, new Promise((resolve, reject) => {
      gltfLoader.load(url, (gltf) => {
        const proto = gltf.scene;
        proto.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            if (pointFilter && o.material && o.material.map) {
              o.material.map.magFilter = THREE.NearestFilter;
              o.material.map.minFilter = THREE.NearestFilter;
              o.material.map.generateMipmaps = false;
            }
          }
        });
        resolve(proto);
      }, undefined, reject);
    }));
  }
  return modelCache.get(url);
}
function loadModel(kit, name) { return loadModelByUrl(modelUrl(kit, name), true); }

// Place a large standalone scene GLB (e.g. a downloaded building) by file path
// under /models. These come at wildly different scales/origins, so we auto-fit
// (scale so the footprint's longest side == `fit`), centre it on (x,z) and drop
// its base to the ground.
async function placeScene(group, file, { x = 0, z = 0, rot = 0, rotX = 0, fit = 30, yOff = 0, solid = false, collide = false } = {}) {
  let proto;
  try { proto = await loadModelByUrl(encodeURI('/models/' + file), false); } catch (_) { return null; }
  const inst = proto.clone(true);
  inst.rotation.set(rotX, rot, 0);
  inst.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(inst);
  const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) || 1;
  inst.scale.setScalar(fit / span);
  inst.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(inst);
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  inst.position.set(x - cx, -box.min.y, z - cz);
  group.add(inst);
  inst.updateMatrixWorld(true);
  // Settle so the *walkable floor* sits at y=0 (not the model's lowest stray
  // geometry). Probe a few columns straight down and take the lowest first-hit
  // — open-floor columns give the real floor; furniture columns read higher.
  let floorTop = Infinity;
  const probe = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.3;
  for (const [ox, oz] of [[0, 0], [probe, 0], [-probe, 0], [0, probe], [0, -probe]]) {
    _rc.set(_ro.set(x + ox, 1000, z + oz), _rd.set(0, -1, 0)); _rc.far = 5000;
    const h = _rc.intersectObject(inst, true);
    if (h.length) floorTop = Math.min(floorTop, h[0].point.y);
  }
  if (isFinite(floorTop)) { inst.position.y += (yOff - floorTop); inst.updateMatrixWorld(true); }
  else inst.position.y += yOff;
  if (solid) {
    const b = new THREE.Box3().setFromObject(inst);
    collisionBoxes.push({ minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z });
  }
  // Per-mesh collision: walk into walls/objects and stick against them.
  if (collide) inst.traverse((o) => { if (o.isMesh) collisionMeshes.push(o); });
  return inst;
}

// Place a model instance into `group`, scaled, rotated and dropped so its
// base rests on the ground (y=0) plus an optional offset.
async function placeModel(group, kit, name, { x = 0, z = 0, rot = 0, scale = 1, yOff = 0, solid = false } = {}) {
  let proto;
  try { proto = await loadModel(kit, name); } catch (_) { return null; }
  const inst = proto.clone(true);
  inst.scale.setScalar(scale);
  inst.rotation.y = rot;
  inst.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inst);
  inst.position.set(x, -box.min.y + yOff, z);
  group.add(inst);
  if (solid) {
    collisionBoxes.push({ minX: x + box.min.x, maxX: x + box.max.x, minZ: z + box.min.z, maxZ: z + box.max.z });
  }
  return inst;
}

// Effective scale for a piece: an absolute `scale` wins, else the kit's
// calibrated base scale times a per-piece multiplier `s`.
function pieceScale(kit, p) {
  if (p.scale != null) return p.scale;
  return (KIT_SCALE[kit] || 1) * (p.s || 1);
}

// Deterministic PRNG so every client lays scattered props in the same spots.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cam = { yaw: 0, pitch: 0.4 };       // shared look angles
const TP = { dist: 4.2, pitchMin: 0.02, pitchMax: 1.25 };  // close, for painting
const FP = { eye: 1.65, pitchMin: -1.15, pitchMax: 1.15 };
const MOVE_SPEED = 5.0;                    // seeker (full-size hunter)
// Hiders are tiny — ~1/6 the size of the seekers and the world's props — so
// they can nestle into and behind the scenery like a real chameleon.
const HIDER_SCALE = 1 / 6;
const HIDER_MOVE_SPEED = 2.0;              // scaled down so they scurry, not blur

function initThree() {
  if (threeReady) return;
  const canvas = $('stage');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, 1, 0.1, 300);
  raycaster = new THREE.Raycaster();
  clock = new THREE.Clock();

  // Sky-and-ground ambient + a warm sun that casts shadows.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7a5a, 1.0));
  sunLight = new THREE.DirectionalLight(0xfff4e0, 1.6);
  sunLight.position.set(18, 30, 14);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.04;
  const sc = sunLight.shadow.camera;
  sc.near = 1; sc.far = 120; sc.left = -28; sc.right = 28; sc.top = 28; sc.bottom = -28;
  scene.add(sunLight);
  scene.add(sunLight.target);

  window.addEventListener('resize', resize);
  threeReady = true;
  animate();
}

function resize() {
  if (!renderer) return;
  const w = $('stage').clientWidth || window.innerWidth;
  const h = $('stage').clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function buildScene(mapId) {
  if (builtMapId === mapId && roomGroup) return;
  if (roomGroup) { scene.remove(roomGroup); roomGroup = null; }
  collisionBoxes = [];
  collisionMeshes = [];
  const map = MAPS[mapId] || MAPS[DEFAULT_MAP_ID];
  const g = new THREE.Group();
  const { x: sx, z: sz } = map.size;

  // Sky + fog.
  scene.background = new THREE.Color(map.sky);
  scene.fog = new THREE.Fog(new THREE.Color(map.fog.color), map.fog.near, map.fog.far);

  // Ground: a generous plane (a bit larger than the play area so the edges
  // disappear into the fog) that receives shadows. It's nudged just below y=0
  // and uses polygon offset so it never z-fights the building floors that sit
  // on top of it (that was the jagged shimmer at the floor edges).
  const groundMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(map.ground), roughness: 1.0, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(sx * 2.4, sz * 2.4), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  g.add(ground);

  scene.add(g);
  roomGroup = g; builtMapId = mapId;

  // Aim the sun at this map's centre and size its shadow frustum to fit.
  if (sunLight) {
    const half = Math.min(75, Math.max(map.size.x, map.size.z) / 2 + 4);
    sunLight.position.set(half * 0.5, half * 1.2, half * 0.4);
    sunLight.target.position.set(0, 0, 0); sunLight.target.updateMatrixWorld();
    const sc = sunLight.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.near = 1; sc.far = half * 4;
    sc.updateProjectionMatrix();
  }

  // Everything below loads asynchronously; the ground shows immediately.
  for (const p of (map.models || [])) {
    const kit = p.kit || map.kit;
    placeModel(g, kit, p.m, {
      x: p.pos[0], z: p.pos[1], rot: p.rot || 0,
      scale: pieceScale(kit, p), yOff: p.y || 0, solid: !!p.solid,
    });
  }
  for (const grp of (map.scatter || [])) scatterModels(g, map, grp);
  for (const run of (map.walls || [])) buildWallRun(g, map, run);
  if (map.perimeter) buildPerimeter(g, map);
  for (const sc of (map.scenes || [])) {
    placeScene(g, sc.file, {
      x: sc.pos[0], z: sc.pos[1], rot: sc.rot || 0, rotX: sc.rotX || 0,
      fit: sc.fit || 30, yOff: sc.y || 0, solid: !!sc.solid, collide: sc.collide !== false,
    });
  }
  for (const c of (map.connectors || [])) buildConnector(g, c);
}

// A simple covered walkway (floor + two side walls) bridging two buildings.
// The walls are colliders; the ends are open so you can pass through.
function buildConnector(group, c) {
  const [ax, az] = c.from, [bx, bz] = c.to;
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const ang = Math.atan2(dx, dz);
  const w = c.width || 6, h = c.height || 3, t = 0.25;
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  const dirx = dx / len, dirz = dz / len, perpx = -dirz, perpz = dirx;

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(w, 0.1, len),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(c.floor || '#b9b6ad'), roughness: 1 }));
  floor.position.set(mx, -0.05, mz); floor.rotation.y = ang; floor.receiveShadow = true;
  group.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(c.wall || '#d9d3c7'), roughness: 1 });
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(t, h, len), wallMat);
    wall.position.set(mx + perpx * (w / 2) * side, h / 2, mz + perpz * (w / 2) * side);
    wall.rotation.y = ang; wall.castShadow = true; wall.receiveShadow = true;
    group.add(wall);
    collisionMeshes.push(wall);
  }
}

// Place `count` props randomly (but deterministically, via the group seed)
// within an area rectangle. All clients produce identical layouts.
function scatterModels(group, map, grp) {
  const kit = grp.kit || map.kit;
  const rand = mulberry32(grp.seed || 1);
  const [x0, z0, x1, z1] = grp.area;
  const sMin = grp.sMin != null ? grp.sMin : 1;
  const sMax = grp.sMax != null ? grp.sMax : 1;
  for (let i = 0; i < grp.count; i++) {
    const name = grp.models[Math.floor(rand() * grp.models.length)];
    const x = x0 + rand() * (x1 - x0);
    const z = z0 + rand() * (z1 - z0);
    const s = (KIT_SCALE[kit] || 1) * (sMin + rand() * (sMax - sMin));
    const rot = grp.rotRandom ? rand() * Math.PI * 2 : 0;
    placeModel(group, kit, name, { x, z, rot, scale: s, solid: !!grp.solid });
  }
}

// Tile a wall model along a straight run from `from` to `to`, leaving a gap
// at each doorway. Each segment is a solid collider.
async function buildWallRun(group, map, run) {
  const kit = run.kit || map.kit;
  const model = run.model || (map.perimeter && map.perimeter.model) || 'wall';
  const scale = pieceScale(kit, run);
  let proto;
  try { proto = await loadModel(kit, model); } catch (_) { return; }

  const { segLen, longAlongX, baseY } = wallMetrics(proto, scale);
  const [ax, az] = run.from, [bx, bz] = run.to;
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz);
  const ux = dx / len, uz = dz / len;
  const n = Math.max(1, Math.round(len / segLen));
  const step = len / n;
  // Align the wall's long axis with the run direction.
  const runAlongX = Math.abs(ux) >= Math.abs(uz);
  const rotY = (runAlongX === longAlongX) ? 0 : Math.PI / 2;
  const doors = run.doors || [];

  for (let i = 0; i < n; i++) {
    const x = ax + ux * step * (i + 0.5);
    const z = az + uz * step * (i + 0.5);
    if (doors.some((d) => Math.hypot(d[0] - x, d[1] - z) < step * 0.7)) continue;
    placeWallSeg(group, proto, scale, x, baseY, z, rotY);
  }
}

async function buildPerimeter(group, map) {
  const spec = map.perimeter;
  const kit = spec.kit || map.kit;
  const scale = pieceScale(kit, spec);
  let proto;
  try { proto = await loadModel(kit, spec.model); } catch (_) { return; }
  const { segLen, longAlongX, baseY } = wallMetrics(proto, scale);
  const hx = map.size.x / 2 - 0.3;
  const hz = map.size.z / 2 - 0.3;
  const nX = Math.max(1, Math.round(map.size.x / segLen));
  const nZ = Math.max(1, Math.round(map.size.z / segLen));
  const stepX = map.size.x / nX, stepZ = map.size.z / nZ;
  const rotForX = longAlongX ? 0 : Math.PI / 2;
  const rotForZ = longAlongX ? Math.PI / 2 : 0;
  for (let i = 0; i < nX; i++) {
    const x = -hx + stepX * (i + 0.5);
    placeWallSeg(group, proto, scale, x, baseY, -hz, rotForX);
    placeWallSeg(group, proto, scale, x, baseY, hz, rotForX);
  }
  for (let i = 0; i < nZ; i++) {
    const z = -hz + stepZ * (i + 0.5);
    placeWallSeg(group, proto, scale, -hx, baseY, z, rotForZ);
    placeWallSeg(group, proto, scale, hx, baseY, z, rotForZ);
  }
}

function wallMetrics(proto, scale) {
  const probe = proto.clone(true);
  probe.scale.setScalar(scale);
  probe.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(probe);
  const sizeX = box.max.x - box.min.x;
  const sizeZ = box.max.z - box.min.z;
  return { segLen: Math.max(sizeX, sizeZ), longAlongX: sizeX >= sizeZ, baseY: -box.min.y };
}

function placeWallSeg(group, proto, scale, x, baseY, z, rotY) {
  const inst = proto.clone(true);
  inst.scale.setScalar(scale);
  inst.rotation.y = rotY;
  inst.position.set(x, baseY, z);
  group.add(inst);
  inst.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inst);
  collisionBoxes.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z });
}

// ---- Doodler character (humanoid) + paintable skin texture --------------
// Every doodler shares one geometry set whose UVs are packed into distinct
// regions of a 512² atlas, so a single canvas texture covers head, body,
// arms, hands, legs and feet — and a raycast onto any part gives the exact
// texel to paint.
const ATLAS = 512;
// Region rects [x0, y0, x1, y1] in UV space (y measured from the bottom).
const REGIONS = {
  head:  [0.00, 0.50, 0.50, 1.00],
  torso: [0.50, 0.50, 1.00, 1.00],
  armL:  [0.00, 0.25, 0.25, 0.50],
  armR:  [0.25, 0.25, 0.50, 0.50],
  legL:  [0.00, 0.00, 0.25, 0.25],
  legR:  [0.25, 0.00, 0.50, 0.25],
  handL: [0.50, 0.375, 0.625, 0.50],
  handR: [0.625, 0.375, 0.75, 0.50],
  footL: [0.50, 0.25, 0.625, 0.375],
  footR: [0.625, 0.25, 0.75, 0.375],
};

function remapUV(geo, region) {
  const uv = geo.attributes.uv;
  const [x0, y0, x1, y1] = region;
  for (let i = 0; i < uv.count; i++) {
    const u = Math.min(1, Math.max(0, uv.getX(i)));
    const v = Math.min(1, Math.max(0, uv.getY(i)));
    uv.setXY(i, x0 + u * (x1 - x0), y0 + v * (y1 - y0));
  }
  uv.needsUpdate = true;
}

let humanoidGeos = null;
function buildHumanoidGeos() {
  if (humanoidGeos) return humanoidGeos;
  const mk = (geo, region) => { remapUV(geo, REGIONS[region]); return geo; };
  humanoidGeos = {
    head:  { geo: mk(new THREE.SphereGeometry(0.32, 22, 16), 'head'),    pos: [0, 1.55, 0] },
    torso: { geo: mk(new THREE.CapsuleGeometry(0.30, 0.50, 6, 16), 'torso'), pos: [0, 0.95, 0] },
    armL:  { geo: mk(new THREE.CapsuleGeometry(0.10, 0.55, 4, 10), 'armL'), pos: [-0.42, 0.98, 0] },
    armR:  { geo: mk(new THREE.CapsuleGeometry(0.10, 0.55, 4, 10), 'armR'), pos: [0.42, 0.98, 0] },
    handL: { geo: mk(new THREE.SphereGeometry(0.13, 12, 10), 'handL'),   pos: [-0.42, 0.56, 0] },
    handR: { geo: mk(new THREE.SphereGeometry(0.13, 12, 10), 'handR'),   pos: [0.42, 0.56, 0] },
    legL:  { geo: mk(new THREE.CapsuleGeometry(0.14, 0.45, 4, 10), 'legL'), pos: [-0.16, 0.42, 0] },
    legR:  { geo: mk(new THREE.CapsuleGeometry(0.14, 0.45, 4, 10), 'legR'), pos: [0.16, 0.42, 0] },
    footL: { geo: mk(new THREE.BoxGeometry(0.20, 0.13, 0.36), 'footL'),  pos: [-0.16, 0.065, 0.07] },
    footR: { geo: mk(new THREE.BoxGeometry(0.20, 0.13, 0.36), 'footR'),  pos: [0.16, 0.065, 0.07] },
  };
  return humanoidGeos;
}

// Joint pivot heights (local, before HIDER_SCALE).
const HIP_Y = 0.6;       // waist / hip pivot
const SHO_Y = 1.25;      // shoulder pivot

// Build a doodler as a small rig: a waist-pivoted upper body (with shoulder
// pivots for the arms) and hip-pivoted legs, so postures can bend at the
// joints. Each doodler gets its own canvas/texture/material (per-player paint)
// but shares the cached geometry.
function buildCharacter(paintUrl) {
  const grp = new THREE.Group();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, ATLAS, ATLAS);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9, metalness: 0.0 });

  const geos = buildHumanoidGeos();
  const mesh = (name, x, y, z = 0) => {
    const m = new THREE.Mesh(geos[name].geo, material);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    return m;
  };
  const pivot = (x, y, z = 0) => { const p = new THREE.Group(); p.position.set(x, y, z); return p; };

  // Upper body rotates at the waist.
  const upper = pivot(0, HIP_Y, 0);
  upper.add(mesh('torso', 0, 0.95 - HIP_Y), mesh('head', 0, 1.55 - HIP_Y));
  const armL = pivot(-0.42, SHO_Y - HIP_Y, 0);
  armL.add(mesh('armL', 0, 0.98 - SHO_Y), mesh('handL', 0, 0.56 - SHO_Y));
  const armR = pivot(0.42, SHO_Y - HIP_Y, 0);
  armR.add(mesh('armR', 0, 0.98 - SHO_Y), mesh('handR', 0, 0.56 - SHO_Y));
  upper.add(armL, armR);

  // Legs rotate at the hips.
  const legL = pivot(-0.16, HIP_Y, 0);
  legL.add(mesh('legL', 0, 0.42 - HIP_Y), mesh('footL', 0, 0.065 - HIP_Y, 0.07));
  const legR = pivot(0.16, HIP_Y, 0);
  legR.add(mesh('legR', 0, 0.42 - HIP_Y), mesh('footR', 0, 0.065 - HIP_Y, 0.07));

  grp.add(upper, legL, legR);
  grp.userData = { canvas, ctx, texture, material, paintUrl: null, joints: { upper, armL, armR, legL, legR } };
  if (paintUrl) applyPaintUrl(grp, paintUrl);
  return grp;
}

// Paint a remote doodler's skin from a data-URL (drawn onto its own canvas).
function applyPaintUrl(grp, url) {
  if (!url || grp.userData.paintUrl === url) return;
  grp.userData.paintUrl = url;
  const img = new Image();
  img.onload = () => {
    const { ctx, texture } = grp.userData;
    ctx.clearRect(0, 0, ATLAS, ATLAS);
    ctx.drawImage(img, 0, 0, ATLAS, ATLAS);
    texture.needsUpdate = true;
  };
  img.src = url;
}

// Pose the rig. The caller positions the group using userData.baseY.
// Every doodler is a (tiny) hider, so the base scale is HIDER_SCALE.
function setPose(g, pose) {
  const S = HIDER_SCALE;
  const j = g.userData.joints;
  // Reset to a clean standing rig.
  g.scale.set(S, S, S); g.rotation.x = 0; g.userData.baseY = 0;
  j.upper.rotation.set(0, 0, 0);
  j.armL.rotation.set(0, 0, 0); j.armR.rotation.set(0, 0, 0);
  j.legL.rotation.set(0, 0, 0); j.legR.rotation.set(0, 0, 0);

  switch (pose) {
    case 'crouching':                 // squat low and compact
      g.scale.set(S * 1.06, S * 0.6, S * 1.06);
      j.upper.rotation.x = 0.25;
      j.armL.rotation.x = 0.3; j.armR.rotation.x = 0.3;
      break;
    case 'fold':                      // fold the body in half over the legs
      j.upper.rotation.x = 1.75;
      // counter-rotate the arms so they dangle toward the ground
      j.armL.rotation.x = -1.6; j.armR.rotation.x = -1.6;
      break;
    case 'ball':                      // curl into a round ball
      j.upper.rotation.x = 1.7;
      j.armL.rotation.set(-1.5, 0, 0.35); j.armR.rotation.set(-1.5, 0, -0.35);
      j.legL.rotation.x = -1.7; j.legR.rotation.x = -1.7;
      g.userData.baseY = 0.15 * S;
      break;
    case 'wide':                      // spread arms & legs into a star/bush
      j.armL.rotation.z = -1.25; j.armR.rotation.z = 1.25;
      j.legL.rotation.z = -0.4; j.legR.rotation.z = 0.4;
      break;
    case 'flat':                      // lie flat on the ground
      g.rotation.x = Math.PI / 2; g.userData.baseY = 0.4 * S;
      break;
    // 'standing' uses the clean reset above.
  }
}
function setFound(g, found) {
  const m = g.userData.material;
  m.emissive = new THREE.Color(found ? 0xff2d6b : 0x000000);
  m.emissiveIntensity = found ? 0.7 : 0;
  m.transparent = !!found;
  m.opacity = found ? 0.55 : 1;
}

function ensureMyChar(body) {
  if (!myChar) { myChar = buildCharacter(body.paint || null); scene.add(myChar); }
  setPose(myChar, body.pose);
  myChar.position.set(body.x, (myChar.userData.baseY || 0), body.z);
  myChar.rotation.y = body.ry || 0;
}
function removeMyChar() { if (myChar) { scene.remove(myChar); myChar = null; } }

function syncHunt(bodies, skipMine) {
  const seen = new Set();
  for (const b of bodies) {
    if (skipMine && b.mine) continue; // I render myself via myChar (local, smooth)
    seen.add(b.id);
    let g = charGroups.get(b.id);
    if (!g) {
      g = buildCharacter(b.paint);
      g.userData.hiderId = b.id;
      scene.add(g); charGroups.set(b.id, g);
    }
    applyPaintUrl(g, b.paint);
    setPose(g, b.pose);
    g.position.set(b.x, (g.userData.baseY || 0), b.z);
    g.rotation.y = b.ry || 0;       // setPose set rotation.x; keep yaw too
    setFound(g, b.found);
  }
  for (const [id, g] of [...charGroups]) {
    if (!seen.has(id)) { scene.remove(g); charGroups.delete(id); }
  }
}
function clearChars() {
  for (const [, g] of charGroups) scene.remove(g);
  charGroups.clear();
}

// ---- Free-form painting -------------------------------------------------
let lastDab = null;
function paintAtUV(uv) {
  if (!myChar) return;
  const ctx = myChar.userData.ctx;
  const px = uv.x * ATLAS, py = (1 - uv.y) * ATLAS;
  const rad = BRUSH_PX[brushSize];
  ctx.fillStyle = brushColor; ctx.strokeStyle = brushColor;
  ctx.lineWidth = rad * 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // Connect to the previous sample for a smooth stroke, but only when it's
  // close — a big jump means we crossed to a different body part / UV island.
  if (lastDab && Math.hypot(px - lastDab.px, py - lastDab.py) < ATLAS * 0.16) {
    ctx.beginPath(); ctx.moveTo(lastDab.px, lastDab.py); ctx.lineTo(px, py); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill();
  }
  lastDab = { px, py };
  myChar.userData.texture.needsUpdate = true;
  paintDirtyForSync = true;
  sendTexture(false);
}
// Raycast a screen point onto my doodler; paint if it lands on the body.
function paintRaycast(clientX, clientY) {
  if (!myChar) return false;
  raycaster.setFromCamera(tapNDC(clientX, clientY), camera);
  const hit = raycaster.intersectObject(myChar, true)[0];
  if (hit && hit.uv) { paintAtUV(hit.uv); return true; }
  return false;
}
function endStroke() { lastDab = null; if (paintDirtyForSync) sendTexture(true); }
function fillAll() {
  if (!myChar) return;
  const ctx = myChar.userData.ctx;
  ctx.fillStyle = brushColor; ctx.fillRect(0, 0, ATLAS, ATLAS);
  myChar.userData.texture.needsUpdate = true;
  sendTexture(true);
}

// ---- Camera + movement --------------------------------------------------
function forwardXZ(yaw) { return { x: Math.sin(yaw), z: Math.cos(yaw) }; }

function bounds() {
  const s = (snap && snap.mapSize) || { x: 24, z: 24 };
  return { mx: s.x / 2 - 1, mz: s.z / 2 - 1 };
}

// Slide a point out of any solid AABB it has entered (axis of least overlap).
function resolveCollision(x, z, rad = 0.42) {
  for (const b of collisionBoxes) {
    if (x > b.minX - rad && x < b.maxX + rad && z > b.minZ - rad && z < b.maxZ + rad) {
      const dxL = x - (b.minX - rad), dxR = (b.maxX + rad) - x;
      const dzL = z - (b.minZ - rad), dzR = (b.maxZ + rad) - z;
      const m = Math.min(dxL, dxR, dzL, dzR);
      if (m === dxL) x = b.minX - rad;
      else if (m === dxR) x = b.maxX + rad;
      else if (m === dzL) z = b.minZ - rad;
      else z = b.maxZ + rad;
    }
  }
  return [x, z];
}

// Per-mesh collision: raycast against the scene geometry so the actor stops
// flush against walls/objects (and can hug them to hide).
const _rc = new THREE.Raycaster();
const _ro = new THREE.Vector3(), _rd = new THREE.Vector3();
function castDist(x, y, z, dx, dz) {
  _ro.set(x, y, z); _rd.set(dx, 0, dz);
  _rc.set(_ro, _rd); _rc.far = 6;
  const hits = _rc.intersectObjects(collisionMeshes, true);
  return hits.length ? hits[0].distance : Infinity;
}
function slideMove(px, pz, nx, nz, y, rad) {
  if (!collisionMeshes.length) return [nx, nz];
  const dx = nx - px, dz = nz - pz;
  if (dx !== 0) {
    const s = Math.sign(dx), d = castDist(px, y, pz, s, 0);
    if (d < Math.abs(dx) + rad) nx = px + s * Math.max(0, d - rad);
  }
  if (dz !== 0) {
    const s = Math.sign(dz), d = castDist(nx, y, pz, 0, s);
    if (d < Math.abs(dz) + rad) nz = pz + s * Math.max(0, d - rad);
  }
  return [nx, nz];
}

function applyMovement(dt) {
  const j = joyVec;
  if (!(j.x || j.y)) return;
  const f = forwardXZ(cam.yaw);
  const r = { x: Math.cos(cam.yaw), z: -Math.sin(cam.yaw) };
  const { mx, mz } = bounds();
  const step = (p, faceMove, speed, rad, rayY) => {
    let nx = p.x + (r.x * j.x + f.x * j.y) * speed * dt;
    let nz = p.z + (r.z * j.x + f.z * j.y) * speed * dt;
    nx = clamp(nx, -mx, mx); nz = clamp(nz, -mz, mz);
    [nx, nz] = resolveCollision(nx, nz, rad);
    [nx, nz] = slideMove(p.x, p.z, nx, nz, rayY, rad);
    p.x = nx; p.z = nz;
    if (faceMove) p.ry = Math.atan2(r.x * j.x + f.x * j.y, r.z * j.x + f.z * j.y);
  };

  if (hiderControls()) {
    // Tiny hider: slow, with a small footprint so it can tuck into gaps.
    step(myBody, true, HIDER_MOVE_SPEED, 0.1, 0.12);
    ensureMyChar(myBody);
    sendMove(false);
  } else if (snap.phase === 'hunt' && snap.myRole === 'seeker' && seekerPos) {
    step(seekerPos, false, MOVE_SPEED, 0.4, 1.0);
  }
}

function updateCamera() {
  if (window.__ov) { // debug: top-down overview (set window.__ov = height)
    camera.position.set(0.01, window.__ov, 0.01); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); return;
  }
  // `s` scales the framing to the actor's size (hiders are tiny).
  const thirdPerson = (target, s = 1) => {
    cam.pitch = clamp(cam.pitch, TP.pitchMin, TP.pitchMax);
    const f = forwardXZ(cam.yaw);
    const dist = TP.dist * s;
    const horiz = dist * Math.cos(cam.pitch);
    let cx = target.x - f.x * horiz;
    let cz = target.z - f.z * horiz;
    // Keep the camera out of walls so it never buries inside geometry while
    // you orbit to paint.
    [cx, cz] = resolveCollision(cx, cz, 0.2);
    camera.position.set(cx, (target.y || 0) + 1.2 * s + dist * Math.sin(cam.pitch), cz);
    camera.lookAt(target.x, (target.y || 0) + 1.0 * s, target.z);
  };
  const firstPerson = (pos) => {
    cam.pitch = clamp(cam.pitch, FP.pitchMin, FP.pitchMax);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const lx = Math.sin(cam.yaw) * cp, lz = Math.cos(cam.yaw) * cp;
    camera.position.set(pos.x, FP.eye, pos.z);
    camera.lookAt(pos.x + lx, FP.eye + sp, pos.z + lz);
  };

  if (hiderControls()) thirdPerson(myBody, HIDER_SCALE);
  else if (snap.phase === 'hunt' && snap.myRole === 'seeker' && seekerPos) firstPerson(seekerPos);
  else {
    const mine = snap.bodies && snap.bodies.find((b) => b.mine);
    if (mine) thirdPerson(mine, HIDER_SCALE);
    else firstPerson(seekerPos || { x: 0, z: -8 });
  }
}

// Procedural walk cycle for the local hider: swing legs (and arms counter) while
// moving; settle back to the chosen pose when still.
let walkPhase = 0;
function updateWalk(dt) {
  if (!myChar || !hiderControls()) return;
  const pose = myBody.pose;
  if (pose !== 'standing' && pose !== 'crouching') return; // other poses are held
  const j = myChar.userData.joints;
  if (joyVec.x || joyVec.y) {
    walkPhase += dt * 11;
    const a = Math.sin(walkPhase) * 0.5;
    j.legL.rotation.x = a; j.legR.rotation.x = -a;
    j.armL.rotation.x = -a * 0.8; j.armR.rotation.x = a * 0.8;
  } else if (walkPhase !== 0) {
    walkPhase = 0;
    setPose(myChar, pose); // restore straight limbs
  }
}

function animate() {
  requestAnimationFrame(animate);
  if (!threeReady || !snap || snap.phase === 'lobby') return;
  const dt = Math.min(clock.getDelta(), 0.05);
  applyMovement(dt);
  updateWalk(dt);
  updateCamera();
  renderer.render(scene, camera);
}

// ---- Input: joystick ----------------------------------------------------
let joyVec = { x: 0, y: 0 }, joyId = null;
const joyEl = $('joystick'), knob = $('joyKnob');
function joyStart(e) {
  joyId = e.pointerId; joyEl.setPointerCapture(joyId); joyMove(e); e.preventDefault();
}
function joyMove(e) {
  if (e.pointerId !== joyId) return;
  const r = joyEl.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2);
  let dy = e.clientY - (r.top + r.height / 2);
  const max = r.width / 2;
  const d = Math.hypot(dx, dy);
  if (d > max) { dx = dx / d * max; dy = dy / d * max; }
  knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  joyVec = { x: dx / max, y: -dy / max };
}
function joyEnd(e) {
  if (e.pointerId !== joyId) return;
  joyId = null; joyVec = { x: 0, y: 0 };
  knob.style.transform = 'translate(-50%, -50%)';
}
joyEl.addEventListener('pointerdown', joyStart);
joyEl.addEventListener('pointermove', joyMove);
joyEl.addEventListener('pointerup', joyEnd);
joyEl.addEventListener('pointercancel', joyEnd);

// ---- Input: paint / look-drag / tap -------------------------------------
// While a hider preps: dragging on your doodler paints it; dragging on empty
// space orbits the camera; a tap on the environment eyedrops a colour.
let lookId = null, lookStart = null, moved = 0, painting = false;
const canvas = $('stage');
function isHiderPrep() { return snap && snap.phase === 'prep' && snap.myRole === 'hider' && myBody; }
// Has the local hider been caught?
function iAmFound() { const m = snap && snap.bodies && snap.bodies.find((b) => b.mine); return !!(m && m.found); }
// Can the local hider walk now? Hiders move during BOTH prep and the hunt
// (cat-and-mouse) until they're caught.
function hiderControls() {
  return snap && snap.myRole === 'hider' && myBody && !iAmFound() &&
    (snap.phase === 'prep' || snap.phase === 'hunt');
}

canvas.addEventListener('pointerdown', (e) => {
  if (lookId !== null) return;
  lookId = e.pointerId; lookStart = { x: e.clientX, y: e.clientY, t: Date.now() }; moved = 0;
  painting = false;
  if (isHiderPrep() && paintRaycast(e.clientX, e.clientY)) painting = true;
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== lookId) return;
  if (painting) { paintRaycast(e.clientX, e.clientY); return; }
  const dx = e.movementX || 0, dy = e.movementY || 0;
  moved += Math.abs(dx) + Math.abs(dy);
  cam.yaw -= dx * 0.005;
  cam.pitch -= dy * 0.005;
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerId !== lookId) return;
  if (painting) endStroke();
  else if ((Date.now() - lookStart.t) < 320 && moved < 12) handleTap(e.clientX, e.clientY);
  lookId = null; painting = false;
});
canvas.addEventListener('pointercancel', () => { if (painting) endStroke(); lookId = null; painting = false; });

function tapNDC(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
}

function handleTap(clientX, clientY) {
  if (!snap) return;

  if (isHiderPrep()) {
    // Eyedropper: sample the exact pixel colour under the tap and load it into
    // the brush. Reading the rendered image (with lighting + fog) gives the
    // colour the surface actually shows on screen — the best camouflage match.
    const color = sampleScreenColor(clientX, clientY);
    if (color) setBrushColor(color);
  } else if (snap.phase === 'hunt' && snap.myRole === 'seeker') {
    const ndc = tapNDC(clientX, clientY);
    raycaster.setFromCamera(ndc, camera);
    const targets = [...charGroups.values()];
    const hit = raycaster.intersectObjects(targets, true)[0];
    let targetId = null;
    if (hit) {
      let o = hit.object;
      while (o && o.userData.hiderId === undefined) o = o.parent;
      if (o) targetId = o.userData.hiderId;
    }
    // The hiders are tiny, so a direct ray hit is hard; fall back to the
    // nearest doodler within a small screen-space radius of the tap.
    if (!targetId) targetId = nearestHiderOnScreen(clientX, clientY, 44);
    if (targetId) { socket.emit('tag', { targetId }); pingTag(clientX, clientY); }
  }
}

// Closest painted hider whose centre projects within `maxPx` of the tap.
const _proj = new THREE.Vector3();
function nearestHiderOnScreen(clientX, clientY, maxPx) {
  const r = canvas.getBoundingClientRect();
  let best = null, bestD = maxPx;
  for (const [id, g] of charGroups) {
    _proj.set(g.position.x, (g.position.y || 0) + 0.18, g.position.z);
    _proj.project(camera);
    if (_proj.z > 1) continue;                 // behind the camera
    const sx = r.left + (_proj.x * 0.5 + 0.5) * r.width;
    const sy = r.top + (-_proj.y * 0.5 + 0.5) * r.height;
    const d = Math.hypot(sx - clientX, sy - clientY);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

// Render the scene to an off-screen target and read back one pixel under the
// tap, returning a "#rrggbb" string (or null if it landed on open sky).
let pickTarget = null;
function sampleScreenColor(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const dpr = renderer.getPixelRatio();
  const w = Math.max(1, Math.floor(r.width * dpr));
  const h = Math.max(1, Math.floor(r.height * dpr));
  if (!pickTarget) {
    pickTarget = new THREE.WebGLRenderTarget(w, h);
    pickTarget.texture.colorSpace = THREE.SRGBColorSpace; // read sRGB bytes
  } else {
    pickTarget.setSize(w, h);
  }
  renderer.setRenderTarget(pickTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);

  const px = Math.min(w - 1, Math.max(0, Math.floor((clientX - r.left) * dpr)));
  const py = Math.min(h - 1, Math.max(0, Math.floor((r.height - (clientY - r.top)) * dpr)));
  const buf = new Uint8Array(4);
  renderer.readRenderTargetPixels(pickTarget, px, py, 1, 1, buf);
  const hex = (n) => n.toString(16).padStart(2, '0');
  return '#' + hex(buf[0]) + hex(buf[1]) + hex(buf[2]);
}
function pingTag(x, y) {
  const f = document.createElement('div'); f.className = 'fly'; f.textContent = '🎯';
  f.style.left = x - 16 + 'px'; f.style.top = y - 16 + 'px';
  $('emoteFloat').appendChild(f); setTimeout(() => f.remove(), 1000);
}

// ---- Painting tools -----------------------------------------------------
function setBrushColor(color) {
  brushColor = color;
  $('colorInput').value = color;
}
// Movement/pose go out frequently but tiny; the painted texture is large so
// it's sent on its own throttle (and once at each stroke end).
function sendMove(force) {
  if (!myBody) return;
  const now = Date.now();
  if (!force && now - lastMoveSent < 70) return;
  lastMoveSent = now;
  socket.emit('paint', { x: myBody.x, z: myBody.z, ry: myBody.ry, pose: myBody.pose });
}
function sendTexture(force) {
  if (!myChar) return;
  const now = Date.now();
  if (!force && now - lastTexSent < 1000) return;
  lastTexSent = now; paintDirtyForSync = false;
  let url;
  try { url = myChar.userData.canvas.toDataURL('image/webp', 0.85); }
  catch (_) { url = myChar.userData.canvas.toDataURL('image/png'); }
  socket.emit('paint', { paint: url });
}
document.querySelectorAll('#hiderTools .brush').forEach((b) =>
  b.addEventListener('click', () => {
    brushSize = b.dataset.size;
    document.querySelectorAll('#hiderTools .brush').forEach((x) => x.classList.toggle('active', x === b));
  }));
document.querySelectorAll('#hiderTools .pose').forEach((b) =>
  b.addEventListener('click', () => {
    if (!myBody) return;
    myBody.pose = b.dataset.pose;
    document.querySelectorAll('#hiderTools .pose').forEach((x) => x.classList.toggle('active', x === b));
    ensureMyChar(myBody); sendMove(true);
  }));
$('colorInput').addEventListener('input', (e) => setBrushColor(e.target.value));
$('fillAllBtn').addEventListener('click', fillAll);

// ---- Emotes -------------------------------------------------------------
document.querySelectorAll('.emote').forEach((b) =>
  b.addEventListener('click', () => socket.emit('emote', { emoji: b.dataset.emoji })));
function flyEmote(emoji) {
  const f = document.createElement('div'); f.className = 'fly'; f.textContent = emoji;
  f.style.left = 20 + Math.random() * 60 + '%'; f.style.top = 55 + Math.random() * 20 + '%';
  $('emoteFloat').appendChild(f); setTimeout(() => f.remove(), 1700);
}

// ---- Per-snapshot game UI ----------------------------------------------
function renderGame() {
  initThree();
  buildScene(snap.mapId);
  resize();

  const phase = snap.phase, role = snap.myRole || '';
  $('phaseLabel').textContent = phase.toUpperCase();
  const rl = $('roleLabel'); rl.textContent = role ? role.toUpperCase() : ''; rl.className = 'pill role ' + role;
  $('remainLabel').textContent = (phase === 'hunt' || phase === 'roundover')
    ? `${snap.remaining}/${snap.totalHiders} hidden` : `R${snap.round}/${snap.totalRounds}`;

  // Init local actors per round. The hider keeps one local body across prep AND
  // hunt (so painting + position carry over into the chase).
  if (role === 'hider' && (phase === 'prep' || phase === 'hunt') && snap.myBody && myBodyRound !== snap.round) {
    myBody = { x: snap.myBody.x, y: snap.myBody.y, z: snap.myBody.z, ry: snap.myBody.ry,
               pose: snap.myBody.pose, paint: snap.myBody.paint || null };
    myBodyRound = snap.round;
    cam.yaw = 0; cam.pitch = 0.45;
    removeMyChar();                 // fresh blank doodler (or restored paint)
    $('colorInput').value = brushColor;
    document.querySelectorAll('#hiderTools .brush').forEach((x) =>
      x.classList.toggle('active', x.dataset.size === brushSize));
  }
  if (phase === 'hunt' && role === 'seeker' && seekerRound !== snap.round) {
    const { mz } = bounds();
    seekerPos = { x: 0, z: -(mz - 1) };
    cam.yaw = 0; cam.pitch = 0;
    seekerRound = snap.round;
  }

  // Scene occupants. The controlling hider draws itself via myChar (smooth,
  // local); everyone else (and a caught/spectating self) comes from syncHunt.
  if (hiderControls()) ensureMyChar(myBody);
  else removeMyChar();
  if (phase === 'hunt' || phase === 'roundover') syncHunt(snap.bodies || [], hiderControls());
  else clearChars();

  // Controls visibility
  const canMove = hiderControls();           // hider, prep or hunt, not caught
  const isHiderPrep = phase === 'prep' && role === 'hider';
  const isSeekerHunt = phase === 'hunt' && role === 'seeker';
  $('hiderTools').classList.toggle('hidden', !isHiderPrep); // painting: prep only
  $('seekerTools').classList.toggle('hidden', !isSeekerHunt);
  $('joystick').classList.toggle('hidden', !(canMove || isSeekerHunt));
  $('crosshair').classList.toggle('hidden', !isSeekerHunt);
  $('emoteBar').classList.toggle('hidden', phase !== 'hunt');

  // Overlays
  const wait = $('waitOverlay');
  if (phase === 'prep' && role === 'seeker') {
    wait.classList.remove('hidden');
    $('waitEmoji').textContent = '🎨';
    $('waitTitle').textContent = 'Hiders are painting…';
    $('waitText').textContent = 'Memorise the rooms. The hunt is coming.';
  } else { wait.classList.add('hidden'); if (phase === 'hunt' && role === 'hider') toastHuntOnce(); }

  $('scoreOverlay').classList.toggle('hidden', phase !== 'roundover');
  if (phase === 'roundover') renderScores();
}

let _huntToast = -1;
function toastHuntOnce() {
  if (_huntToast === snap.round) return; _huntToast = snap.round;
  toast('🏃 Hunt on — keep moving and stay hidden!', 2600);
}

function renderScores() {
  const sorted = [...snap.players].sort((a, b) => b.score - a.score);
  const isFinal = snap.round >= snap.totalRounds;
  $('scoreTitle').textContent = isFinal ? '🏆 Final Scores' : `Round ${snap.round} done`;
  $('scoreList').innerHTML = sorted.map((p, i) => `
    <li><span class="pemoji">${i === 0 ? '👑' : p.avatar}</span>
    <span class="pname">${escapeHtml(p.name)}</span>
    <span class="tagbadge ${p.role || ''}">${(p.role || '').toUpperCase()}</span>
    <span class="pscore">${p.score}</span></li>`).join('');
  $('nextHint').textContent = isFinal ? 'Returning to lobby…' : 'Next round starting soon…';
}

// ---- Timer --------------------------------------------------------------
setInterval(() => {
  if (!snap || snap.phase === 'lobby') return;
  const remaining = Math.max(0, snap.deadline - (Date.now() + serverSkew));
  const secs = Math.ceil(remaining / 1000);
  const el = $('timer'); el.textContent = String(Math.max(0, secs));
  el.classList.toggle('low', secs <= 10 && (snap.phase === 'prep' || snap.phase === 'hunt'));
}, 200);

// ---- Socket -------------------------------------------------------------
socket.on('connect', () => { myId = socket.id; });
socket.on('state', (s) => {
  snap = s; myId = s.myId || myId; serverSkew = s.now - Date.now();
  if (!inRoom) return;
  if (s.phase === 'lobby') { show('lobby'); renderLobby(); }
  else { show('game'); renderGame(); }
});
socket.on('tagged', ({ name, by }) => toast(`🎯 ${by} found ${name}!`));
socket.on('miss', () => {});
socket.on('emote', ({ emoji }) => flyEmote(emoji));
socket.on('disconnect', () => toast('Disconnected. Reconnecting…'));

// ---- Boot ---------------------------------------------------------------
buildAvatars();
show('home');
const params = new URLSearchParams(location.search);
if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase();
