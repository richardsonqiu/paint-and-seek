// Doodle Guys — 3D client (Three.js).
// Loads Three from a CDN via the importmap in index.html (the player's
// browser fetches it). Home/lobby are plain DOM; the game is a WebGL scene.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MAPS, POSES } from '/shared/maps.js';

const AVATARS = ['🦎', '🐙', '🐸', '🦊', '🐼', '🐯', '🐧', '🦄', '🐳', '👾', '🤖', '👻'];
const socket = io();
const $ = (id) => document.getElementById(id);

// ---- UI state -----------------------------------------------------------
let myId = null, snap = null, serverSkew = 0, inRoom = false;
let chosenAvatar = AVATARS[0];
let curSeg = 'head';

// Hider working body (local, smooth); seeker first-person position.
let myBody = null, myBodyRound = -1;
let seekerPos = null, seekerRound = -1;
let lastPaintSent = 0;

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
  $('startBtn').disabled = !(isHost && snap.players.length >= 2);
  $('lobbyHint').textContent = snap.players.length < 2 ? 'Need at least 2 players to start.' : '';
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
let renderer, scene, camera, raycaster, clock, composer;
let roomGroup = null, builtMapId = null;
let envMeshes = [];                 // eyedropper raycast targets
let spinProps = [];                 // slowly-rotating display models
const charGroups = new Map();       // hider id -> Group (hunt phase)
let myChar = null;                  // hider's own Group (prep)
let threeReady = false;

const cam = { yaw: 0, pitch: 0.4 };       // shared look angles
const TP = { dist: 6.5, pitchMin: 0.08, pitchMax: 1.25 };
const FP = { eye: 1.65, pitchMin: -1.15, pitchMax: 1.15 };
const MOVE_SPEED = 5.0;

function initThree() {
  if (threeReady) return;
  const canvas = $('stage');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // Filmic tone mapping + correct color space — the single biggest jump
  // away from the flat "plastic primitives" look toward a lit game frame.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0612, 26, 70);
  camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);
  raycaster = new THREE.Raycaster();
  clock = new THREE.Clock();

  // Image-based lighting from a procedural studio room (no HDR file to
  // host). Gives soft ambient + real reflections on glossy surfaces.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const hemi = new THREE.HemisphereLight(0xfff4e0, 0x3a2a60, 0.6);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xfffaf0, 2.2);
  dir.position.set(10, 22, 8);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.near = 0.5; dir.shadow.camera.far = 90;
  dir.shadow.camera.left = dir.shadow.camera.bottom = -24;
  dir.shadow.camera.right = dir.shadow.camera.top = 24;
  dir.shadow.bias = -0.0008;
  dir.shadow.normalBias = 0.02;
  scene.add(dir);
  const fill = new THREE.PointLight(0xff9952, 18, 40, 2);
  fill.position.set(-7, 5, -7);
  scene.add(fill);

  // Post-processing: bloom so emissive props (TV, lamp shade) glow.
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.7, 0.85);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  window.addEventListener('resize', resize);
  threeReady = true;
  animate();
}

function resize() {
  if (!renderer) return;
  const w = $('stage').clientWidth || window.innerWidth;
  const h = $('stage').clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  if (composer) composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function mat(color, roughness = 0.85, metalness = 0.0, emissive = null, emissiveIntensity = 0.5) {
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness, metalness });
  if (emissive) { m.emissive.set(emissive); m.emissiveIntensity = emissiveIntensity; }
  return m;
}
function segMat(color) { return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.75, metalness: 0.0 }); }

function buildScene(mapId) {
  if (builtMapId === mapId && roomGroup) return;
  if (roomGroup) { scene.remove(roomGroup); roomGroup = null; }
  envMeshes = [];
  spinProps = [];
  const map = MAPS[mapId] || MAPS.living_room;
  const g = new THREE.Group();
  const { x: sx, z: sz, h: sh } = map.size;

  // floor — low roughness so it picks up the environment map as a soft
  // reflection (the "wet"/polished look in the reference), mobile-cheap.
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(sx, 0.2, sz),
    mat(map.floorColor, 0.28, 0.0)
  );
  floor.position.y = -0.1; floor.receiveShadow = true;
  g.add(floor); envMeshes.push(floor);
  // ceiling
  const ceil = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.2, sz), mat(map.ceilColor, 0.95));
  ceil.position.y = sh; g.add(ceil);
  // 4 walls
  const wallMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(map.wallColor), roughness: 0.92, side: THREE.DoubleSide });
  const mkWall = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat.clone());
    m.position.set(x, y, z); m.receiveShadow = true;
    g.add(m); envMeshes.push(m);
  };
  mkWall(sx, sh, 0.2, 0, sh / 2, -sz / 2);
  mkWall(sx, sh, 0.2, 0, sh / 2, sz / 2);
  mkWall(0.2, sh, sz, -sx / 2, sh / 2, 0);
  mkWall(0.2, sh, sz, sx / 2, sh / 2, 0);

  // furniture boxes
  for (const b of map.boxes) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]),
      mat(b.color, b.roughness, b.metalness, b.emissive, b.emissiveIntensity)
    );
    m.position.set(b.pos[0], b.pos[1], b.pos[2]);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m); envMeshes.push(m);
    // Optional authored GLB prop — loads over the box and swaps it out on
    // success. If the fetch fails (offline, CORS, slow phone) the box stays,
    // so the game never regresses below the all-primitives version.
    if (b.model) loadProp(b, m, g);
  }
  scene.add(g);
  roomGroup = g; builtMapId = mapId;
}

const gltfLoader = new GLTFLoader();
const modelCache = new Map();        // url -> cloned-ready gltf.scene template

function placeProp(template, b, fallbackMesh, group) {
  if (roomGroup !== group) return;   // map was rebuilt mid-load; drop it
  const m = b.model;
  const obj = template.clone(true);
  // Recenter the model on its own origin, then drop it where the box was.
  const box3 = new THREE.Box3().setFromObject(obj);
  const center = box3.getCenter(new THREE.Vector3());
  obj.position.sub(center);
  const holder = new THREE.Group();
  holder.add(obj);
  holder.position.set(b.pos[0], m.y != null ? m.y : b.pos[1], b.pos[2]);
  holder.scale.setScalar(m.scale || 1);
  if (m.yaw) holder.rotation.y = m.yaw;
  obj.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; envMeshes.push(o); }
  });
  if (m.spin) { holder.userData.spin = m.spin; spinProps.push(holder); }
  group.add(holder);
  // Retire the placeholder box.
  group.remove(fallbackMesh);
  const i = envMeshes.indexOf(fallbackMesh);
  if (i >= 0) envMeshes.splice(i, 1);
}

function loadProp(b, fallbackMesh, group) {
  const url = b.model.url;
  const cached = modelCache.get(url);
  if (cached) { placeProp(cached, b, fallbackMesh, group); return; }
  gltfLoader.load(
    url,
    (gltf) => { modelCache.set(url, gltf.scene); placeProp(gltf.scene, b, fallbackMesh, group); },
    undefined,
    () => { /* keep the fallback box; non-fatal */ }
  );
}

function buildCharacter(seg) {
  const grp = new THREE.Group();
  const PI = Math.PI;
  const add = (geo, color, x, y, z, rx, rz) => {
    const m = new THREE.Mesh(geo, segMat(color));
    m.position.set(x, y, z);
    if (rx) m.rotation.x = rx;
    if (rz) m.rotation.z = rz;
    m.castShadow = true; m.receiveShadow = true;
    grp.add(m); return m;
  };

  // Head + neck
  const head  = add(new THREE.SphereGeometry(0.3, 20, 16),            seg.head,  0,     1.60, 0);
  const neck  = add(new THREE.CylinderGeometry(0.09, 0.11, 0.18, 8),  seg.head,  0,     1.32, 0);
  // Torso (CapsuleGeometry = cylinder with rounded caps — much less blocky)
  const torso = add(new THREE.CapsuleGeometry(0.23, 0.48, 6, 12),     seg.torso, 0,     1.00, 0);
  // Hip bridge
  const hip   = add(new THREE.CapsuleGeometry(0.21, 0.14, 4, 10),     seg.legs,  0,     0.61, 0);
  // Upper arms (torso colour)
  const luArm = add(new THREE.CapsuleGeometry(0.082, 0.28, 4, 8),     seg.torso, -0.40, 1.08, 0, 0,  PI / 7);
  const ruArm = add(new THREE.CapsuleGeometry(0.082, 0.28, 4, 8),     seg.torso,  0.40, 1.08, 0, 0, -PI / 7);
  // Forearms (skin = head colour)
  const llArm = add(new THREE.CapsuleGeometry(0.067, 0.25, 4, 8),     seg.head,  -0.50, 0.73, 0, 0,  PI / 11);
  const rlArm = add(new THREE.CapsuleGeometry(0.067, 0.25, 4, 8),     seg.head,   0.50, 0.73, 0, 0, -PI / 11);
  // Legs (split into two capsules)
  const lLeg  = add(new THREE.CapsuleGeometry(0.10, 0.38, 4, 8),      seg.legs,  -0.12, 0.27, 0);
  const rLeg  = add(new THREE.CapsuleGeometry(0.10, 0.38, 4, 8),      seg.legs,   0.12, 0.27, 0);
  // Feet
  const lFt   = add(new THREE.BoxGeometry(0.14, 0.09, 0.26),          seg.legs,  -0.12, 0.03, 0.04);
  const rFt   = add(new THREE.BoxGeometry(0.14, 0.09, 0.26),          seg.legs,   0.12, 0.03, 0.04);

  grp.userData.segMeshes = {
    head:  [head, neck, llArm, rlArm],
    torso: [torso, luArm, ruArm],
    legs:  [hip, lLeg, rLeg, lFt, rFt],
  };
  return grp;
}
function setColors(g, seg) {
  const sm = g.userData.segMeshes;
  for (const m of sm.head)  m.material.color.set(seg.head);
  for (const m of sm.torso) m.material.color.set(seg.torso);
  for (const m of sm.legs)  m.material.color.set(seg.legs);
}
function setPose(g, pose) {
  g.scale.set(1, 1, 1); g.rotation.x = 0; g.position.y = 0;
  if (pose === 'crouching') g.scale.set(1.05, 0.6, 1.05);
  else if (pose === 'flat') { g.rotation.x = Math.PI / 2; g.position.y = 0.30; }
}
function setFound(g, found) {
  for (const meshes of Object.values(g.userData.segMeshes)) {
    for (const m of meshes) {
      m.material.emissive.set(found ? 0xff2d6b : 0x000000);
      m.material.emissiveIntensity = found ? 0.7 : 0;
      m.material.transparent = !!found;
      m.material.opacity = found ? 0.5 : 1;
    }
  }
}

function ensureMyChar(body) {
  if (!myChar) { myChar = buildCharacter(body.segments); scene.add(myChar); }
  setColors(myChar, body.segments);
  setPose(myChar, body.pose);
  myChar.position.set(body.x, body.y || 0, body.z);
  myChar.rotation.y = body.ry || 0;
}
function removeMyChar() { if (myChar) { scene.remove(myChar); myChar = null; } }

function syncHunt(bodies) {
  const seen = new Set();
  for (const b of bodies) {
    seen.add(b.id);
    let g = charGroups.get(b.id);
    if (!g) {
      g = buildCharacter(b.segments);
      g.userData.hiderId = b.id;
      scene.add(g); charGroups.set(b.id, g);
    }
    setColors(g, b.segments);
    setPose(g, b.pose);
    g.position.set(b.x, b.y || 0, b.z);
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

// ---- Camera + movement --------------------------------------------------
function forwardXZ(yaw) { return { x: Math.sin(yaw), z: Math.cos(yaw) }; }

function bounds() {
  const s = (snap && snap.mapSize) || { x: 24, z: 24 };
  return { mx: s.x / 2 - 1, mz: s.z / 2 - 1 };
}

function applyMovement(dt) {
  const j = joyVec;
  if (snap.phase === 'prep' && snap.myRole === 'hider' && myBody) {
    if (j.x || j.y) {
      const f = forwardXZ(cam.yaw);
      const r = { x: Math.cos(cam.yaw), z: -Math.sin(cam.yaw) };
      let nx = myBody.x + (r.x * j.x + f.x * j.y) * MOVE_SPEED * dt;
      let nz = myBody.z + (r.z * j.x + f.z * j.y) * MOVE_SPEED * dt;
      const { mx, mz } = bounds();
      myBody.x = clamp(nx, -mx, mx); myBody.z = clamp(nz, -mz, mz);
      myBody.ry = Math.atan2(r.x * j.x + f.x * j.y, r.z * j.x + f.z * j.y);
      ensureMyChar(myBody);
      sendPaint(false);
    }
  } else if (snap.phase === 'hunt' && snap.myRole === 'seeker' && seekerPos) {
    if (j.x || j.y) {
      const f = forwardXZ(cam.yaw);
      const r = { x: Math.cos(cam.yaw), z: -Math.sin(cam.yaw) };
      let nx = seekerPos.x + (r.x * j.x + f.x * j.y) * MOVE_SPEED * dt;
      let nz = seekerPos.z + (r.z * j.x + f.z * j.y) * MOVE_SPEED * dt;
      const { mx, mz } = bounds();
      seekerPos.x = clamp(nx, -mx, mx); seekerPos.z = clamp(nz, -mz, mz);
    }
  }
}

function updateCamera() {
  const thirdPerson = (target) => {
    cam.pitch = clamp(cam.pitch, TP.pitchMin, TP.pitchMax);
    const f = forwardXZ(cam.yaw);
    const horiz = TP.dist * Math.cos(cam.pitch);
    camera.position.set(
      target.x - f.x * horiz,
      (target.y || 0) + 1.2 + TP.dist * Math.sin(cam.pitch),
      target.z - f.z * horiz
    );
    camera.lookAt(target.x, (target.y || 0) + 1.0, target.z);
  };
  const firstPerson = (pos) => {
    cam.pitch = clamp(cam.pitch, FP.pitchMin, FP.pitchMax);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const lx = Math.sin(cam.yaw) * cp, lz = Math.cos(cam.yaw) * cp;
    camera.position.set(pos.x, FP.eye, pos.z);
    camera.lookAt(pos.x + lx, FP.eye + sp, pos.z + lz);
  };

  if (snap.phase === 'prep' && snap.myRole === 'hider' && myBody) thirdPerson(myBody);
  else if (snap.phase === 'hunt' && snap.myRole === 'seeker' && seekerPos) firstPerson(seekerPos);
  else {
    const mine = snap.bodies && snap.bodies.find((b) => b.mine);
    if (mine) thirdPerson(mine);
    else firstPerson(seekerPos || { x: 0, z: -8 });
  }
}

function animate() {
  requestAnimationFrame(animate);
  if (!threeReady || !snap || snap.phase === 'lobby') return;
  const dt = Math.min(clock.getDelta(), 0.05);
  applyMovement(dt);
  for (const p of spinProps) p.rotation.y += p.userData.spin * dt;
  updateCamera();
  if (composer) composer.render(); else renderer.render(scene, camera);
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

// ---- Input: look-drag + tap (eyedrop / tag) -----------------------------
let lookId = null, lookStart = null, moved = 0;
const canvas = $('stage');
canvas.addEventListener('pointerdown', (e) => {
  if (lookId !== null) return;
  lookId = e.pointerId; lookStart = { x: e.clientX, y: e.clientY, t: Date.now() }; moved = 0;
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== lookId) return;
  const dx = e.movementX || 0, dy = e.movementY || 0;
  moved += Math.abs(dx) + Math.abs(dy);
  cam.yaw -= dx * 0.005;
  cam.pitch -= dy * 0.005;
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerId !== lookId) return;
  const quick = (Date.now() - lookStart.t) < 320 && moved < 12;
  if (quick) handleTap(e.clientX, e.clientY);
  lookId = null;
});
canvas.addEventListener('pointercancel', () => { lookId = null; });

function tapNDC(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
}

function handleTap(clientX, clientY) {
  if (!snap) return;
  const ndc = tapNDC(clientX, clientY);
  raycaster.setFromCamera(ndc, camera);

  if (snap.phase === 'prep' && snap.myRole === 'hider' && myBody) {
    const hit = raycaster.intersectObjects(envMeshes, false)[0];
    if (hit && hit.object.material && hit.object.material.color) {
      applyColor('#' + hit.object.material.color.getHexString());
    }
  } else if (snap.phase === 'hunt' && snap.myRole === 'seeker') {
    const targets = [...charGroups.values()];
    const hit = raycaster.intersectObjects(targets, true)[0];
    if (hit) {
      let o = hit.object;
      while (o && o.userData.hiderId === undefined) o = o.parent;
      if (o && o.userData.hiderId) { socket.emit('tag', { targetId: o.userData.hiderId }); pingTag(clientX, clientY); }
    }
  }
}
function pingTag(x, y) {
  const f = document.createElement('div'); f.className = 'fly'; f.textContent = '🎯';
  f.style.left = x - 16 + 'px'; f.style.top = y - 16 + 'px';
  $('emoteFloat').appendChild(f); setTimeout(() => f.remove(), 1000);
}

// ---- Painting tools -----------------------------------------------------
function applyColor(color) {
  if (!myBody) return;
  myBody.segments[curSeg] = color;
  $('colorInput').value = color;
  ensureMyChar(myBody);
  sendPaint(true);
}
function sendPaint(force) {
  if (!myBody) return;
  const now = Date.now();
  if (!force && now - lastPaintSent < 70) return;
  lastPaintSent = now;
  socket.emit('paint', myBody);
}
document.querySelectorAll('#hiderTools .seg').forEach((b) =>
  b.addEventListener('click', () => {
    curSeg = b.dataset.seg;
    document.querySelectorAll('#hiderTools .seg').forEach((x) => x.classList.toggle('active', x === b));
    if (myBody) $('colorInput').value = myBody.segments[curSeg];
  }));
document.querySelectorAll('#hiderTools .pose').forEach((b) =>
  b.addEventListener('click', () => {
    if (!myBody) return;
    myBody.pose = b.dataset.pose;
    document.querySelectorAll('#hiderTools .pose').forEach((x) => x.classList.toggle('active', x === b));
    ensureMyChar(myBody); sendPaint(true);
  }));
$('colorInput').addEventListener('input', (e) => applyColor(e.target.value));
$('fillAllBtn').addEventListener('click', () => {
  if (!myBody) return;
  const c = $('colorInput').value;
  myBody.segments = { head: c, torso: c, legs: c };
  ensureMyChar(myBody); sendPaint(true);
});

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

  // Init local actors per round
  if (phase === 'prep' && role === 'hider' && snap.myBody && myBodyRound !== snap.round) {
    myBody = { x: snap.myBody.x, y: snap.myBody.y, z: snap.myBody.z, ry: snap.myBody.ry,
               pose: snap.myBody.pose, segments: { ...snap.myBody.segments } };
    myBodyRound = snap.round;
    cam.yaw = 0; cam.pitch = 0.4;
    $('colorInput').value = myBody.segments[curSeg];
  }
  if (phase === 'hunt' && role === 'seeker' && seekerRound !== snap.round) {
    const { mz } = bounds();
    seekerPos = { x: 0, z: -(mz - 1) };
    cam.yaw = 0; cam.pitch = 0;
    seekerRound = snap.round;
  }

  // Scene occupants
  if (phase === 'prep' && role === 'hider' && myBody) { clearChars(); ensureMyChar(myBody); }
  else { removeMyChar(); }
  if (phase === 'hunt' || phase === 'roundover') syncHunt(snap.bodies || []);
  else clearChars();

  // Controls visibility
  const isHiderPrep = phase === 'prep' && role === 'hider';
  const isSeekerHunt = phase === 'hunt' && role === 'seeker';
  $('hiderTools').classList.toggle('hidden', !isHiderPrep);
  $('seekerTools').classList.toggle('hidden', !isSeekerHunt);
  $('joystick').classList.toggle('hidden', !(isHiderPrep || isSeekerHunt));
  $('crosshair').classList.toggle('hidden', !isSeekerHunt);
  $('emoteBar').classList.toggle('hidden', phase !== 'hunt');

  // Overlays
  const wait = $('waitOverlay');
  if (phase === 'prep' && role === 'seeker') {
    wait.classList.remove('hidden');
    $('waitEmoji').textContent = '🎨';
    $('waitTitle').textContent = 'Hiders are painting…';
    $('waitText').textContent = 'Memorise the room. The hunt is coming.';
  } else if (phase === 'hunt' && role === 'hider') {
    wait.classList.add('hidden'); toastFrozenOnce();
  } else wait.classList.add('hidden');

  $('scoreOverlay').classList.toggle('hidden', phase !== 'roundover');
  if (phase === 'roundover') renderScores();
}

let _frozen = -1;
function toastFrozenOnce() { if (_frozen === snap.round) return; _frozen = snap.round; toast('❄️ Frozen! Hold still.', 2400); }

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
