// Doodle Guys — 3D client (Three.js).
// Loads Three from a CDN via the importmap in index.html (the player's
// browser fetches it). Home/lobby are plain DOM; the game is a WebGL scene.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { MAPS, POSES, DEFAULT_MAP_ID, KIT_SCALE } from '/shared/maps.js';

// Accelerate raycasts (collision/floor/cling) with a BVH — the per-frame
// raycasts against high-poly building meshes were the main FPS killer.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

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
// A little person silhouette, white when alive / red when caught.
function personIcon(color) {
  return `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="${color}" d="M12 12a4.6 4.6 0 1 0-4.6-4.6A4.6 4.6 0 0 0 12 12Zm0 1.8c-3.7 0-8.4 1.9-8.4 5.6V21h16.8v-1.6c0-3.7-4.7-5.6-8.4-5.6Z"/></svg>`;
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
// Mesh names that should NOT block movement (glass doors/partitions, curtains,
// mirrors, windows) — so the doodler can move freely between rooms.
const PASSTHROUGH = /glass|vidro|cortina|curtain|espelho|mirror|janela|window/i;
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
function loadModelByUrl(url, pointFilter, castShadow = true) {
  if (!modelCache.has(url)) {
    modelCache.set(url, new Promise((resolve, reject) => {
      gltfLoader.load(url, (gltf) => {
        const proto = gltf.scene;
        proto.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = castShadow;
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
  // Scene GLBs are high-poly + baked-lit, so skip them in the shadow pass (big FPS win).
  try { proto = await loadModelByUrl(encodeURI('/models/' + file), false, false); } catch (_) { return null; }
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
  // Per-mesh collision — but glass partitions / doors / curtains are left
  // pass-through so you can move freely between rooms.
  if (collide) inst.traverse((o) => {
    if (o.isMesh && !PASSTHROUGH.test(o.name)) {
      try { if (!o.geometry.boundsTree) o.geometry.computeBoundsTree(); } catch (_) {}
      collisionMeshes.push(o);
    }
  });
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
const TP = { dist: 0.9, pitchMin: -0.9, pitchMax: 1.25 };  // world distance (zoomable); negative pitch = look up
const FP = { eye: 1.65, pitchMin: -1.15, pitchMax: 1.15 };
const MOVE_SPEED = 5.0;                    // seeker (full-size hunter)
// Hiders are tiny — ~1/6 the size of the seekers and the world's props — so
// they can nestle into and behind the scenery like a real chameleon.
const HIDER_SCALE = 1 / 6;
const HIDER_MOVE_SPEED = 2.0;              // scaled down so they scurry, not blur

function initThree() {
  if (threeReady) return;
  const canvas = $('stage');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); // cap for FPS
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
  sunLight.shadow.mapSize.set(1024, 1024);
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
  try { floor.geometry.computeBoundsTree(); } catch (_) {}
  collisionMeshes.push(floor); // counts as walkable floor

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

// A little flattened-oval foot (rounded, not a box).
function roundedFoot() { const g = new THREE.SphereGeometry(0.15, 16, 12); g.scale(1, 0.5, 1.45); return g; }

let humanoidGeos = null;
function buildHumanoidGeos() {
  if (humanoidGeos) return humanoidGeos;
  const mk = (geo, region) => { remapUV(geo, REGIONS[region]); return geo; };
  // Chunky, smooth, rounded proportions (à la the "Hidden in Plain Sight" toy):
  // big round head, fat barrel torso, thick rounded limbs that overlap so the
  // joints blend, little oval feet. High segment counts keep it smooth.
  humanoidGeos = {
    head:  { geo: mk(new THREE.SphereGeometry(0.37, 30, 22), 'head') },
    torso: { geo: mk(new THREE.CapsuleGeometry(0.34, 0.46, 10, 28), 'torso') },
    armL:  { geo: mk(new THREE.CapsuleGeometry(0.13, 0.46, 8, 18), 'armL') },
    armR:  { geo: mk(new THREE.CapsuleGeometry(0.13, 0.46, 8, 18), 'armR') },
    handL: { geo: mk(new THREE.SphereGeometry(0.135, 16, 14), 'handL') },
    handR: { geo: mk(new THREE.SphereGeometry(0.135, 16, 14), 'handR') },
    legL:  { geo: mk(new THREE.CapsuleGeometry(0.165, 0.34, 8, 18), 'legL') },
    legR:  { geo: mk(new THREE.CapsuleGeometry(0.165, 0.34, 8, 18), 'legR') },
    footL: { geo: mk(roundedFoot(), 'footL') },
    footR: { geo: mk(roundedFoot(), 'footR') },
  };
  return humanoidGeos;
}

// Joint pivot heights (local, before HIDER_SCALE).
const HIP_Y = 0.6;       // waist / hip pivot
const SHO_Y = 1.2;       // shoulder pivot

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

  // Upper body rotates at the waist. Parts overlap so the joints blend smoothly.
  const upper = pivot(0, HIP_Y, 0);
  upper.add(mesh('torso', 0, 0.92 - HIP_Y), mesh('head', 0, 1.55 - HIP_Y));
  const armL = pivot(-0.40, SHO_Y - HIP_Y, 0);
  armL.add(mesh('armL', 0, 0.90 - SHO_Y), mesh('handL', 0, 0.56 - SHO_Y));
  const armR = pivot(0.40, SHO_Y - HIP_Y, 0);
  armR.add(mesh('armR', 0, 0.90 - SHO_Y), mesh('handR', 0, 0.56 - SHO_Y));
  upper.add(armL, armR);

  // Legs rotate at the hips.
  const legL = pivot(-0.15, HIP_Y, 0);
  legL.add(mesh('legL', 0, 0.40 - HIP_Y), mesh('footL', 0, 0.05 - HIP_Y, 0.06));
  const legR = pivot(0.15, HIP_Y, 0);
  legR.add(mesh('legR', 0, 0.40 - HIP_Y), mesh('footR', 0, 0.05 - HIP_Y, 0.06));

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

  // The 8 poses (à la "Hidden in Plain Sight"). Arms hang -Y from the shoulder
  // pivots; rotation.x ~ PI swings them up, rotation.z spreads them out.
  switch (pose) {
    case 'cheer':                     // both arms up in a V
      j.armL.rotation.set(2.7, 0, -0.45); j.armR.rotation.set(2.7, 0, 0.45);
      break;
    case 'head':                      // hands on head (arms up & inward)
      j.armL.rotation.set(2.7, 0, 0.8); j.armR.rotation.set(2.7, 0, -0.8);
      break;
    case 'wide':                      // star: arms & legs spread
      j.armL.rotation.z = -1.3; j.armR.rotation.z = 1.3;
      j.legL.rotation.z = -0.45; j.legR.rotation.z = 0.45;
      break;
    case 'wave':                      // one arm up, leaning
      j.armR.rotation.set(2.8, 0, -0.2);
      j.upper.rotation.z = -0.12;
      break;
    case 'ball':                      // curl into a round ball
      j.upper.rotation.x = 1.7;
      j.armL.rotation.set(-1.5, 0, 0.35); j.armR.rotation.set(-1.5, 0, -0.35);
      j.legL.rotation.x = -1.7; j.legR.rotation.x = -1.7;
      g.userData.baseY = 0.15 * S;
      break;
    case 'flat':                      // lie flat on the ground
      g.rotation.x = Math.PI / 2; g.userData.baseY = 0.4 * S;
      break;
    case 'kneel':                     // kneel / sit low
      g.scale.set(S, S * 0.62, S);
      j.legL.rotation.x = 0.5; j.legR.rotation.x = 0.5;
      j.armL.rotation.x = 0.4; j.armR.rotation.x = 0.4;
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
  myChar.position.set(body.x, (body.y || 0) + (myChar.userData.baseY || 0), body.z);
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
    g.position.set(b.x, (b.y || 0) + (g.userData.baseY || 0), b.z);
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
  if (hit && hit.uv) { paintAtUV(hit.uv); paintSplash(clientX, clientY); return true; }
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
  const map = snap && MAPS[snap.mapId];
  if (map && map.bounds) {
    const b = map.bounds;
    return { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
  }
  const s = (snap && snap.mapSize) || { x: 24, z: 24 };
  return { minX: -(s.x / 2 - 1), maxX: s.x / 2 - 1, minZ: -(s.z / 2 - 1), maxZ: s.z / 2 - 1 };
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
_rc.firstHitOnly = true; // BVH fast path — we only need the nearest hit
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

// ---- Jumping & clinging -------------------------------------------------
const GRAVITY = 22, JUMP_VEL = 7, CLING_RANGE = 2.4, TURN_RATE = 2.6;
const ROOF = 2.0; // ceiling cap (below wall height) so you can't climb/jump over the walls into the sky
let jumpRequested = false, clinging = false, nearSurface = false;

function angleDelta(a, b) { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }

// Push a point out of any wall/object it's overlapping (so you can never end up
// inside geometry). Casts short rays on the 4 axes and shoves out.
function depenetrate(p, rayY, rad) {
  if (!collisionMeshes.length) return;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const d = castDist(p.x, rayY, p.z, dx, dz);
    if (d < rad) { p.x -= dx * (rad - d + 0.01); p.z -= dz * (rad - d + 0.01); }
  }
}

// Is there a building floor under (x,z)? Used to keep players ON the floors and
// out of the surrounding void (anti-escape).
function hasFloor(x, z, fromY) {
  if (!collisionMeshes.length) return true;
  _ro.set(x, (fromY || 0) + 0.6, z); _rd.set(0, -1, 0);
  _rc.set(_ro, _rd); _rc.far = (fromY || 0) + 12;
  return _rc.intersectObjects(collisionMeshes, true).length > 0;
}

// Surface height directly under (x,z), so the actor stands on floors/furniture.
function groundUnder(x, y, z) {
  if (collisionMeshes.length) {
    _ro.set(x, y + 0.5, z); _rd.set(0, -1, 0);
    _rc.set(_ro, _rd); _rc.far = y + 2;
    const h = _rc.intersectObjects(collisionMeshes, true)[0];
    if (h) return h.point.y;
  }
  return 0;
}

// Is there a clingable surface within reach (facing or joystick direction)?
// When found, remember the direction toward it (surfaceDir) so cling can climb it.
const surfaceDir = { x: 0, z: 1 };
const clingDir = { x: 0, z: 1 };
function detectSurface(p) {
  if (!collisionMeshes.length) return false;
  const dirs = [[Math.sin(p.ry), Math.cos(p.ry)]];
  if (joyVec.x || joyVec.y) dirs.push([Math.sin(p.ry), Math.cos(p.ry)]);
  for (const [dx, dz] of dirs) {
    _ro.set(p.x, (p.y || 0) + 0.12, p.z); _rd.set(dx, 0, dz).normalize();
    _rc.set(_ro, _rd); _rc.far = CLING_RANGE;
    if (_rc.intersectObjects(collisionMeshes, true).length) {
      surfaceDir.x = _rd.x; surfaceDir.z = _rd.z;
      return true;
    }
  }
  return false;
}

function applyMovement(dt) {
  const b = bounds();
  const turn = joyVec.x;   // A / left  = turn left,  D / right = turn right
  const fwd = joyVec.y;    // W / up    = forward,    S / down  = backward
  if (!hiderControls()) clinging = false;

  if (hiderControls()) {
    const p = myBody; p.vy = p.vy || 0;
    const HRAD = 0.16, RAYY = (p.y || 0) + 0.12;
    if (clinging) {
      // Climb up/down the surface and strafe sideways along it.
      if (fwd > 0) { const ny = (p.y || 0) + fwd * HIDER_MOVE_SPEED * dt; if (ny <= ROOF) p.y = ny; }
      else if (fwd < 0) { p.y = Math.max(0, (p.y || 0) + fwd * HIDER_MOVE_SPEED * dt); }
      if (turn) {                                      // strafe perpendicular to the surface
        const px = -clingDir.z, pz = clingDir.x;
        let nx = clamp(p.x + px * turn * HIDER_MOVE_SPEED * dt, b.minX, b.maxX);
        let nz = clamp(p.z + pz * turn * HIDER_MOVE_SPEED * dt, b.minZ, b.maxZ);
        [nx, nz] = slideMove(p.x, p.z, nx, nz, (p.y || 0) + 0.12, HRAD);
        p.x = nx; p.z = nz;
      }
      // Re-stick to the surface; let go (and fall) once it's no longer there —
      // i.e. you climbed over its top edge or strafed past its side.
      _ro.set(p.x, (p.y || 0) + 0.12, p.z); _rd.set(clingDir.x, 0, clingDir.z).normalize();
      _rc.set(_ro, _rd); _rc.far = 1.3;
      const sh = _rc.intersectObjects(collisionMeshes, true)[0];
      const gy = groundUnder(p.x, (p.y || 0) + 0.5, p.z);
      if ((p.y || 0) <= gy + 0.05) { p.y = gy; clinging = false; }      // reached the floor
      else if (sh) { p.x = sh.point.x - clingDir.x * 0.3; p.z = sh.point.z - clingDir.z * 0.3; } // stay glued
      else {                                                            // surface ended
        const fx = clamp(p.x + clingDir.x * 0.35, b.minX, b.maxX);
        const fz = clamp(p.z + clingDir.z * 0.35, b.minZ, b.maxZ);
        if (fwd > 0 && hasFloor(fx, fz, p.y)) {                         // crested the top → step on
          p.x = fx; p.z = fz; p.y = groundUnder(p.x, (p.y || 0) + 0.4, p.z);
        }
        clinging = false;                                              // otherwise drop (gravity resumes)
      }
      if (clinging) p.vy = 0; // hold position while stuck; once detached, gravity takes over
      if (jumpRequested) { clinging = false; p.vy = JUMP_VEL * 0.5; }
    } else {
      // TANK controls: turn to face, then move forward/back along that facing.
      if (turn) p.ry -= turn * TURN_RATE * dt;   // A/left turns left (char POV)
      if (fwd) {
        const f = forwardXZ(p.ry);
        let nx = clamp(p.x + f.x * fwd * HIDER_MOVE_SPEED * dt, b.minX, b.maxX);
        let nz = clamp(p.z + f.z * fwd * HIDER_MOVE_SPEED * dt, b.minZ, b.maxZ);
        [nx, nz] = slideMove(p.x, p.z, nx, nz, RAYY, HRAD);
        if (hasFloor(nx, nz, p.y)) { p.x = nx; p.z = nz; } // stay on the building floor
      }
      depenetrate(p, RAYY, HRAD);
      if (turn || fwd) cam.yaw += angleDelta(cam.yaw, p.ry) * Math.min(1, dt * 8); // camera follows facing
      if (jumpRequested && (p.y || 0) <= groundUnder(p.x, p.y || 0, p.z) + 0.03) p.vy = JUMP_VEL;
      p.vy -= GRAVITY * dt;
      let ny = (p.y || 0) + p.vy * dt;
      const g = groundUnder(p.x, ny, p.z);
      if (ny <= g) { ny = g; p.vy = 0; }
      if (ny > ROOF) { ny = ROOF; if (p.vy > 0) p.vy = 0; }
      p.y = ny;
    }
    jumpRequested = false;
    nearSurface = !clinging && detectSurface(p);
    ensureMyChar(myBody);
    if (turn || fwd || clinging || p.vy !== 0) sendMove(false);
  } else if (snap.phase === 'hunt' && snap.myRole === 'seeker' && seekerPos) {
    const p = seekerPos; p.vy = p.vy || 0;
    const SRAD = 0.4, RAYY = (p.y || 0) + 1.0;
    // First-person tank: A/D turn the view, W/S move along it.
    if (turn) cam.yaw -= turn * TURN_RATE * dt;   // A/left turns view left
    if (fwd) {
      const f = forwardXZ(cam.yaw);
      let nx = clamp(p.x + f.x * fwd * MOVE_SPEED * dt, b.minX, b.maxX);
      let nz = clamp(p.z + f.z * fwd * MOVE_SPEED * dt, b.minZ, b.maxZ);
      [nx, nz] = slideMove(p.x, p.z, nx, nz, RAYY, SRAD);
      if (hasFloor(nx, nz, p.y)) { p.x = nx; p.z = nz; } // stay on the building floor
    }
    depenetrate(p, RAYY, SRAD);
    if (jumpRequested && (p.y || 0) <= groundUnder(p.x, p.y || 0, p.z) + 0.03) p.vy = JUMP_VEL;
    jumpRequested = false;
    p.vy -= GRAVITY * dt;
    let ny = (p.y || 0) + p.vy * dt;
    const g = groundUnder(p.x, ny, p.z);
    if (ny <= g) { ny = g; p.vy = 0; }
    if (ny > ROOF) { ny = ROOF; if (p.vy > 0) p.vy = 0; }
    p.y = ny;
    sendSeek();
  } else if (iSpectate()) {
    // Caught: roam freely as a spectator (tank controls, on the floor).
    const p = myBody;
    if (turn) p.ry += turn * TURN_RATE * dt;
    if (fwd) {
      const f = forwardXZ(p.ry);
      let nx = clamp(p.x + f.x * fwd * HIDER_MOVE_SPEED * dt, b.minX, b.maxX);
      let nz = clamp(p.z + f.z * fwd * HIDER_MOVE_SPEED * dt, b.minZ, b.maxZ);
      [nx, nz] = slideMove(p.x, p.z, nx, nz, (p.y || 0) + 0.12, 0.16);
      if (hasFloor(nx, nz, p.y)) { p.x = nx; p.z = nz; }
    }
    depenetrate(p, (p.y || 0) + 0.12, 0.16);
    if (turn || fwd) cam.yaw += angleDelta(cam.yaw, p.ry) * Math.min(1, dt * 8);
    p.y = groundUnder(p.x, (p.y || 0) + 0.5, p.z);
    jumpRequested = false;
  } else {
    jumpRequested = false;
  }
}

// Seeker tells the server its position (so spectators' minimaps update).
let lastSeekSent = 0;
function sendSeek() {
  const now = Date.now();
  if (now - lastSeekSent < 120) return;
  lastSeekSent = now;
  socket.emit('seekmove', { x: seekerPos.x, z: seekerPos.z, ry: cam.yaw });
}

function updateCamera() {
  if (window.__ov) { // debug: top-down overview (set window.__ov = height)
    camera.position.set(0.01, window.__ov, 0.01); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); return;
  }
  // `s` scales the framing to the actor's size (hiders are tiny).
  const thirdPerson = (target, s = 1) => {
    cam.pitch = clamp(cam.pitch, TP.pitchMin, TP.pitchMax);
    const f = forwardXZ(cam.yaw);
    const dist = TP.dist; // a WORLD distance, so you can zoom right out to survey
    const horiz = dist * Math.cos(cam.pitch);
    let cx = target.x - f.x * horiz;
    let cz = target.z - f.z * horiz;
    // The camera never drops below the floor; instead, when you drag down past
    // level the look target rises so you look UP (at the ceiling / up the walls).
    const cyMin = (target.y || 0) + 0.12;
    const cyWant = (target.y || 0) + 1.2 * s + dist * Math.sin(cam.pitch);
    let cy = Math.max(cyMin, cyWant);
    const lookY = (target.y || 0) + 1.0 * s + Math.max(0, cyMin - cyWant);
    // Pull the camera in if geometry is between it and the doodler, so it never
    // buries inside a wall/furniture (raycast from the doodler out to the camera).
    if (collisionMeshes.length) {
      _ro.set(target.x, lookY, target.z);
      _rd.set(cx - target.x, cy - lookY, cz - target.z);
      const full = _rd.length() || 1; _rd.normalize();
      _rc.set(_ro, _rd); _rc.far = full;
      const h = _rc.intersectObjects(collisionMeshes, true)[0];
      if (h && h.distance < full) {
        const d = Math.max(0.12, h.distance - 0.1);
        cx = target.x + _rd.x * d; cy = lookY + _rd.y * d; cz = target.z + _rd.z * d;
      }
    } else {
      [cx, cz] = resolveCollision(cx, cz, 0.2);
    }
    camera.position.set(cx, cy, cz);
    camera.lookAt(target.x, lookY, target.z);
  };
  const firstPerson = (pos) => {
    cam.pitch = clamp(cam.pitch, FP.pitchMin, FP.pitchMax);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const lx = Math.sin(cam.yaw) * cp, lz = Math.cos(cam.yaw) * cp;
    const eye = (pos.y || 0) + FP.eye;
    camera.position.set(pos.x, eye, pos.z);
    camera.lookAt(pos.x + lx, eye + sp, pos.z + lz);
  };

  if (hiderControls() || iSpectate()) thirdPerson(myBody, HIDER_SCALE);
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
  if (!myChar || !hiderControls() || clinging) return;
  const pose = myBody.pose;
  if (pose !== 'standing') return; // other poses are held
  const j = myChar.userData.joints;
  if (Math.abs(joyVec.y) > 0.05) {            // walking forward/back
    walkPhase += dt * 11;
    const a = Math.sin(walkPhase) * 0.5;
    j.legL.rotation.x = a; j.legR.rotation.x = -a;
    j.armL.rotation.x = -a * 0.8; j.armR.rotation.x = a * 0.8;
  } else if (walkPhase !== 0) {
    walkPhase = 0;
    setPose(myChar, pose); // restore straight limbs
  }
}

let _jumpVis = null, _clingVis = null;
function updateActionButtons() {
  const canMove = hiderControls();
  const seekerHunt = snap && snap.phase === 'hunt' && snap.myRole === 'seeker';
  const jv = canMove || seekerHunt;
  const cv = canMove && (nearSurface || clinging);
  if (jv !== _jumpVis) { _jumpVis = jv; $('jumpBtn').classList.toggle('hidden', !jv); }
  if (cv !== _clingVis) { _clingVis = cv; $('clingBtn').classList.toggle('hidden', !cv); }
  $('clingBtn').textContent = clinging ? '⤓' : '🧲';
  // Crosshair turns red while the seeker's paint gun reloads.
  if (seekerHunt) $('crosshair').classList.toggle('reloading', (Date.now() - lastShotAt) < 1000);
}

function animate() {
  requestAnimationFrame(animate);
  if (!threeReady || !snap || snap.phase === 'lobby') return;
  const dt = Math.min(clock.getDelta(), 0.05);
  if (joyId === null) joyVec = keyboardVec(); // keyboard drives movement when the stick is idle
  applyMovement(dt);
  updateWalk(dt);
  updateActionButtons();
  updateCamera();
  renderer.render(scene, camera);
}

// Start clinging: lock onto the detected surface and face it (so climb/strafe
// are relative to that surface).
function startCling() {
  if (!nearSurface || !myBody) return;
  clinging = true;
  clingDir.x = surfaceDir.x; clingDir.z = surfaceDir.z;
  // Snap right up against the surface so climbing stays glued to it.
  _ro.set(myBody.x, (myBody.y || 0) + 0.12, myBody.z); _rd.set(clingDir.x, 0, clingDir.z).normalize();
  _rc.set(_ro, _rd); _rc.far = CLING_RANGE;
  const h = _rc.intersectObjects(collisionMeshes, true)[0];
  if (h) { myBody.x = h.point.x - clingDir.x * 0.3; myBody.z = h.point.z - clingDir.z * 0.3; }
  myBody.ry = Math.atan2(clingDir.x, clingDir.z);
}
$('jumpBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); jumpRequested = true; });
$('clingBtn').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (clinging) clinging = false; else startCling();
});

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

// ---- Input: keyboard + mouse (desktop) ----------------------------------
// WASD / arrows move, Space jumps, E clings; mouse drag looks, click acts,
// wheel zooms while painting. Keyboard drives the joystick vector when the
// on-screen stick isn't being touched.
const keyState = {};
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (document.getElementById('screen-game') && !document.getElementById('screen-game').classList.contains('active')) return;
  keyState[k] = true;
  if (k === ' ') { jumpRequested = true; e.preventDefault(); }
  if (k === 'e') { if (clinging) clinging = false; else startCling(); }
});
window.addEventListener('keyup', (e) => { keyState[e.key.toLowerCase()] = false; });
function keyboardVec() {
  let x = 0, y = 0;
  if (keyState['w'] || keyState['arrowup']) y += 1;
  if (keyState['s'] || keyState['arrowdown']) y -= 1;
  if (keyState['d'] || keyState['arrowright']) x += 1;
  if (keyState['a'] || keyState['arrowleft']) x -= 1;
  const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
  return { x, y };
}
// Zoom the third-person camera in/out (paint detail up close, survey from afar).
function canZoom() { return hiderControls() || iSpectate(); }
function applyZoom(delta) { TP.dist = clamp(TP.dist + delta, 0.5, 5); } // max keeps you within the room
$('stage').addEventListener('wheel', (e) => {
  if (canZoom()) { applyZoom(e.deltaY * 0.004); e.preventDefault(); }
}, { passive: false });

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
// A caught hider becomes a free-roaming spectator (can't be tagged again).
function iSpectate() {
  return snap && snap.myRole === 'hider' && iAmFound() && myBody &&
    (snap.phase === 'hunt' || snap.phase === 'roundover');
}

// Two fingers on the stage = pinch-to-zoom (mobile); one finger = look/paint.
const pointers = new Map();
let pinching = false, pinchDist = 0;
canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    if (painting) endStroke();
    lookId = null; painting = false; pinching = true;
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    return;
  }
  if (lookId !== null) return;
  lookId = e.pointerId; lookStart = { x: e.clientX, y: e.clientY, t: Date.now() }; moved = 0;
  painting = false;
  if (hiderControls() && paintRaycast(e.clientX, e.clientY)) painting = true;
});
canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinching && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (canZoom()) applyZoom((pinchDist - d) * 0.03); // spread = zoom in
    pinchDist = d;
    return;
  }
  if (e.pointerId !== lookId) return;
  if (painting) { paintRaycast(e.clientX, e.clientY); return; }
  const dx = e.movementX || 0, dy = e.movementY || 0;
  moved += Math.abs(dx) + Math.abs(dy);
  cam.yaw -= dx * 0.005;
  cam.pitch -= dy * 0.005;
});
canvas.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinching = false;
  if (e.pointerId !== lookId) return;
  if (painting) endStroke();
  else if ((Date.now() - lookStart.t) < 320 && moved < 12) handleTap(e.clientX, e.clientY);
  lookId = null; painting = false;
});
canvas.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinching = false;
  if (painting) endStroke(); lookId = null; painting = false;
});

function tapNDC(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
}

function handleTap(clientX, clientY) {
  if (!snap) return;

  if (hiderControls()) {
    // Eyedropper: sample the exact pixel colour under the tap and load it into
    // the brush. Reading the rendered image (with lighting + fog) gives the
    // colour the surface actually shows on screen — the best camouflage match.
    const color = sampleScreenColor(clientX, clientY);
    if (color) setBrushColor(color);
  } else if (snap.phase === 'hunt' && snap.myRole === 'seeker') {
    seekerShoot(clientX, clientY);
  }
}

// Seeker fires a paint blast at the tapped point. 1s reload (no spam). The
// blast (and any catch) is resolved + broadcast by the server, so the splat
// shows for everyone via the 'blast' event.
const SHOOT_COLORS = ['#ff3bd0', '#ffd23b', '#3bd1ff', '#7CFC00', '#ff6b3b', '#b14bff'];
let lastShotAt = 0;
function seekerShoot(clientX, clientY) {
  const now = Date.now();
  if (now - lastShotAt < 1000) return; // reloading
  raycaster.setFromCamera(tapNDC(clientX, clientY), camera);
  const targets = [];
  if (roomGroup) targets.push(roomGroup);
  for (const g of charGroups.values()) targets.push(g);
  const hit = raycaster.intersectObjects(targets, true)[0];
  const p = hit ? hit.point : raycaster.ray.at(25, new THREE.Vector3());
  lastShotAt = now;
  const color = SHOOT_COLORS[Math.floor(Math.random() * SHOOT_COLORS.length)];
  socket.emit('shoot', { x: p.x, y: p.y, z: p.z, color });
  pingTag(clientX, clientY);
}

// A paint splat at a world point — grows and fades; visible to everyone.
function paintSplat(x, y, z, color) {
  if (!scene) return;
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 12, 10),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.9 }));
  m.position.set(x, y, z); scene.add(m);
  const t0 = performance.now();
  (function fade() {
    const t = (performance.now() - t0) / 1600;
    if (t >= 1) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); return; }
    m.scale.setScalar(1 + t * 2.4); m.material.opacity = 0.9 * (1 - t);
    requestAnimationFrame(fade);
  })();
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
  socket.emit('paint', { x: myBody.x, y: myBody.y, z: myBody.z, ry: myBody.ry, pose: myBody.pose });
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

// Colour palette: quick-pick swatches.
const PALETTE = ['#ffffff', '#111111', '#e23b3b', '#f59e0b', '#ffe14d', '#3bd16a',
  '#27a3c4', '#3b5ec0', '#9b51e0', '#e36bd0', '#7a5b46', '#c9b48f'];
(function buildPalette() {
  const wrap = $('palette'); if (!wrap) return;
  PALETTE.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = c;
    b.addEventListener('click', () => setBrushColor(c));
    wrap.appendChild(b);
  });
})();

// Minimise/expand a tool group.
document.querySelectorAll('#hiderTools .tool-min').forEach((b) =>
  b.addEventListener('click', () => {
    const g = b.dataset.group;
    document.querySelectorAll(`#hiderTools .tool-group[data-group="${g}"]`).forEach((el) => el.classList.toggle('collapsed'));
    b.classList.toggle('off');
  }));

// A quick colour splash at the screen point you painted (visual feedback).
let lastSplash = 0;
function paintSplash(clientX, clientY) {
  const now = Date.now(); if (now - lastSplash < 90) return; lastSplash = now;
  const f = document.createElement('div'); f.className = 'splash';
  f.style.left = clientX + 'px'; f.style.top = clientY + 'px';
  f.style.background = brushColor;
  $('emoteFloat').appendChild(f); setTimeout(() => f.remove(), 450);
}

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

  // Alive/caught hiders shown as person icons for everyone (white = alive,
  // red = caught).
  const hiders = snap.players.filter((p) => p.role === 'hider');
  $('aliveBar').innerHTML = hiders.map((p) => personIcon(p.found ? '#ff4d4d' : '#ffffff')).join('');
  $('aliveBar').classList.toggle('hidden', hiders.length === 0);

  // Init local actors per round. The hider keeps one local body across prep AND
  // hunt (so painting + position carry over into the chase).
  if (role === 'hider' && (phase === 'prep' || phase === 'hunt') && snap.myBody && myBodyRound !== snap.round) {
    myBody = { x: snap.myBody.x, y: snap.myBody.y, z: snap.myBody.z, ry: snap.myBody.ry,
               pose: snap.myBody.pose, paint: snap.myBody.paint || null };
    myBodyRound = snap.round;
    cam.yaw = 0; cam.pitch = 0.45; TP.dist = 0.9; // reset zoom
    removeMyChar();                 // fresh blank doodler (or restored paint)
    $('colorInput').value = brushColor;
    document.querySelectorAll('#hiderTools .brush').forEach((x) =>
      x.classList.toggle('active', x.dataset.size === brushSize));
  }
  if (phase === 'hunt' && role === 'seeker' && seekerRound !== snap.round) {
    const sb = snap.myBody || { x: 0, z: 0 };  // server-assigned spawn (different room from hiders)
    seekerPos = { x: sb.x, y: sb.y || 0, z: sb.z, vy: 0 };
    cam.yaw = sb.ry || 0; cam.pitch = 0;
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
  const spectating = iSpectate();
  const isSeekerHunt = phase === 'hunt' && role === 'seeker';
  $('hiderTools').classList.toggle('hidden', !canMove); // paint during prep AND the hunt
  $('seekerTools').classList.toggle('hidden', !isSeekerHunt);
  $('joystick').classList.toggle('hidden', !(canMove || isSeekerHunt || spectating));
  $('crosshair').classList.toggle('hidden', !isSeekerHunt);
  $('emoteBar').classList.toggle('hidden', phase !== 'hunt');

  // Spectator minimap (you can roam + see everyone once caught).
  $('minimap').classList.toggle('hidden', !snap.spectating);
  if (snap.spectating) drawMinimap();

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

// Top-down minimap for spectators: every player as a labelled dot.
function drawMinimap() {
  const cv = $('minimap'); const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const map = MAPS[snap.mapId];
  const b = (map && map.bounds) || { minX: -30, maxX: 30, minZ: -30, maxZ: 30 };
  const wWorld = b.maxX - b.minX, dWorld = b.maxZ - b.minZ;
  const s = Math.min((W - 14) / wWorld, (H - 14) / dWorld);
  const ox = (W - wWorld * s) / 2, oy = (H - dWorld * s) / 2;
  for (const d of (snap.dots || [])) {
    const px = ox + (d.x - b.minX) * s, py = oy + (d.z - b.minZ) * s;
    let color = d.role === 'seeker' ? '#ff4d4d' : (d.found ? '#9aa' : '#ffffff');
    if (d.mine) color = '#4dd2ff';
    ctx.beginPath(); ctx.arc(px, py, d.role === 'seeker' ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    if (d.role === 'seeker') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.font = '9px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.fillText((d.name || '').slice(0, 8), px + 6, py + 3);
  }
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
socket.on('tagged', ({ name, by }) => toast(`🎯 ${by} caught ${name}!`));
socket.on('miss', () => {});
socket.on('blast', ({ x, y, z, color }) => paintSplat(x, y, z, color));
socket.on('emote', ({ emoji }) => flyEmote(emoji));
socket.on('disconnect', () => toast('Disconnected. Reconnecting…'));

// ---- Boot ---------------------------------------------------------------
buildAvatars();
show('home');
const params = new URLSearchParams(location.search);
if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase();
