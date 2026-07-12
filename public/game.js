// Doodle Guys — 3D client (Three.js).
// A camouflage hide-and-seek party game à la Meccha Chameleon: hiders are
// little chameleons that paint/blend themselves into the scenery; the seeker
// hunts them down with a paint gun. Home/lobby are plain DOM; the game is a
// WebGL scene.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { MAPS, POSES, DEFAULT_MAP_ID, KIT_SCALE, spawnPoints } from '/shared/maps.js?v=47';

// Accelerate raycasts (collision/floor/climb) with a BVH — the per-frame
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

// Brush state for free-form painting. Generous sizes — fat, forgiving
// strokes make painting on a phone screen easy (à la Meccha Chameleon).
let brushColor = '#3bd16a';
let brushSize = 'm';                 // 's' | 'm' | 'l'
const BRUSH_PX = { s: 7, m: 16, l: 32 };

// Hider working body (local, smooth); seeker first-person position.
let myBody = null, myBodyRound = -1;
let seekerPos = null, seekerRound = -1;
let lastMoveSent = 0, lastTexSent = 0, paintDirtyForSync = false;

// ---- Screens ------------------------------------------------------------
function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(`screen-${screen}`).classList.add('active');
  // The whole game is landscape-only on phones (the rotate overlay blocks
  // portrait); every screen change re-tries the lock in case the last
  // attempt was denied for lacking a user gesture.
  document.body.classList.toggle('in-game', screen === 'game');
  tryLandscapeLock();
}

// Best effort: fullscreen + rotate to landscape (works on Android Chrome from
// a user gesture; iOS Safari doesn't allow locking, so the rotate overlay
// stays up there until the phone is physically turned).
async function tryLandscapeLock() {
  try {
    if (!matchMedia('(orientation: portrait)').matches) return;
    if (document.fullscreenElement == null && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
    }
  } catch (_) { /* not allowed here — the overlay asks the player to rotate */ }
}
$('rotateOverlay').addEventListener('click', tryLandscapeLock);
// Android needs a user gesture for fullscreen+lock: piggyback on the first tap.
window.addEventListener('pointerdown', () => tryLandscapeLock(), { once: true });
function toast(msg, ms = 1800) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms);
}
// A little doodler head-count icon (matches the egg mascots): white with
// eyes = still hidden, red with a cross = caught.
function lizardIcon(caught) {
  const c = caught ? '#ff6b6b' : '#ffffff';
  const face = caught
    ? '<path d="M6.8 9 L13.2 14.5 M13.2 9 L6.8 14.5" stroke="#7a1020" stroke-width="2.2" stroke-linecap="round"/>'
    : '<rect x="6.9" y="7.6" width="2" height="4.6" rx="1" fill="#26262b"/><rect x="11.1" y="7.6" width="2" height="4.6" rx="1" fill="#26262b"/>';
  return `<svg viewBox="0 0 20 24" width="17" height="20"><path fill="${c}" stroke="#20303e" stroke-width="1.6" d="M10 1.8 C15 1.8 17.6 6.8 17.6 13 C17.6 19 14.6 22.2 10 22.2 C5.4 22.2 2.4 19 2.4 13 C2.4 6.8 5 1.8 10 1.8 Z"/>${face}</svg>`;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- Sounds (tiny WebAudio synth — no assets) ----------------------------
let AC = null;
function ac() {
  if (!AC && (window.AudioContext || window.webkitAudioContext)) {
    AC = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (AC && AC.state === 'suspended') AC.resume();
  return AC;
}
function tone(freq, dur = 0.12, { type = 'square', vol = 0.12, when = 0, slide = 0 } = {}) {
  const a = ac(); if (!a) return;
  const t0 = a.currentTime + when;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function noise(dur = 0.15, { vol = 0.14, when = 0, freq = 900 } = {}) {
  const a = ac(); if (!a) return;
  const t0 = a.currentTime + when;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
  const g = a.createGain(); g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination);
  src.start(t0);
}
const SFX = {
  click: () => tone(660, 0.06, { type: 'triangle', vol: 0.08 }),
  tick: () => tone(880, 0.05, { type: 'square', vol: 0.06 }),
  banner: () => { tone(523, 0.12, { type: 'triangle' }); tone(659, 0.12, { type: 'triangle', when: 0.11 }); tone(784, 0.2, { type: 'triangle', when: 0.22 }); },
  blend: () => { noise(0.25, { freq: 2400, vol: 0.1 }); tone(1200, 0.22, { type: 'sine', vol: 0.07, slide: -900 }); },
  shoot: () => tone(300, 0.14, { type: 'square', vol: 0.1, slide: -180 }),
  splat: () => noise(0.18, { freq: 500, vol: 0.16 }),
  caught: () => { tone(520, 0.12, { vol: 0.12 }); tone(390, 0.12, { when: 0.11, vol: 0.12 }); tone(260, 0.22, { when: 0.22, vol: 0.12 }); },
  win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.15, { type: 'triangle', when: i * 0.12 })); },
};
window.addEventListener('pointerdown', () => ac(), { once: true });

// ---- Home ---------------------------------------------------------------
function buildAvatars() {
  const wrap = $('avatarPicker'); wrap.innerHTML = '';
  AVATARS.forEach((a) => {
    const b = document.createElement('button');
    b.textContent = a;
    if (a === chosenAvatar) b.classList.add('sel');
    b.onclick = () => { chosenAvatar = a; buildAvatars(); SFX.click(); };
    wrap.appendChild(b);
  });
}
// Body-shape picker: little SVG silhouettes of each body. The choice rides
// along with create/join and every other client renders you with it.
const SHAPE_CHOICES = [
  { id: 'egg', label: 'Egg', svg: '<svg viewBox="0 0 40 48"><path d="M20 4 C31 4 36 15 36 28 C36 40 29 45 20 45 C11 45 4 40 4 28 C4 15 9 4 20 4 Z" fill="#fff" stroke="#20303e" stroke-width="3"/><rect x="13" y="17" width="4" height="9" rx="2" fill="#26262b"/><rect x="23" y="17" width="4" height="9" rx="2" fill="#26262b"/></svg>' },
  { id: 'buddy', label: 'Buddy', svg: '<svg viewBox="0 0 40 48"><circle cx="20" cy="14" r="10.5" fill="#fff" stroke="#20303e" stroke-width="3"/><rect x="8" y="20" width="24" height="25" rx="12" fill="#fff" stroke="#20303e" stroke-width="3"/><rect x="14" y="10" width="4" height="8" rx="2" fill="#26262b"/><rect x="22" y="10" width="4" height="8" rx="2" fill="#26262b"/></svg>' },
  { id: 'bean', label: 'Bean', svg: '<svg viewBox="0 0 40 48"><circle cx="20" cy="10" r="8" fill="#fff" stroke="#20303e" stroke-width="3"/><rect x="12" y="15" width="16" height="30" rx="8" fill="#fff" stroke="#20303e" stroke-width="3"/><rect x="15.5" y="7" width="3.4" height="6.5" rx="1.7" fill="#26262b"/><rect x="21.5" y="7" width="3.4" height="6.5" rx="1.7" fill="#26262b"/></svg>' },
  { id: 'bobo', label: 'Bobo', svg: '<svg viewBox="0 0 40 48"><ellipse cx="20" cy="27" rx="17" ry="16" fill="#fff" stroke="#20303e" stroke-width="3"/><rect x="13" y="19" width="4.5" height="10" rx="2.2" fill="#26262b"/><rect x="22.5" y="19" width="4.5" height="10" rx="2.2" fill="#26262b"/></svg>' },
];
let chosenShape = localStorage.getItem('dg-shape') || 'egg';
if (!SHAPE_CHOICES.some((s) => s.id === chosenShape)) chosenShape = 'egg';
let myShape = chosenShape;
function buildShapes() {
  const wrap = $('shapePicker'); wrap.innerHTML = '';
  SHAPE_CHOICES.forEach((s) => {
    const b = document.createElement('button');
    b.innerHTML = `${s.svg}<small>${s.label}</small>`;
    if (s.id === chosenShape) b.classList.add('sel');
    b.onclick = () => {
      chosenShape = s.id; myShape = s.id;
      localStorage.setItem('dg-shape', s.id);
      buildShapes(); SFX.click();
    };
    wrap.appendChild(b);
  });
}
function myInfo() {
  const name = ($('nameInput').value || '').trim().slice(0, 12) || 'Chameleon';
  return { name, avatar: chosenAvatar, shape: chosenShape };
}

// Camera speed: phones vary hugely (screen size, refresh rate, thumb reach),
// so a per-player sensitivity setting is standard in every mobile shooter.
// Persisted; multiplies both look axes.
let lookSensMul = clamp(parseFloat(localStorage.getItem('dg-sens') || '1') || 1, 0.5, 2);
$('sensInput').value = Math.round(lookSensMul * 100);
$('sensVal').textContent = `${Math.round(lookSensMul * 100)}%`;
$('sensInput').addEventListener('input', () => {
  lookSensMul = clamp((+$('sensInput').value || 100) / 100, 0.5, 2);
  localStorage.setItem('dg-sens', lookSensMul);
  $('sensVal').textContent = `${Math.round(lookSensMul * 100)}%`;
});

// Light haptic taps (Android; iOS Safari has no vibration API — no-op there).
function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {} }

$('createBtn').onclick = () => socket.emit('create', myInfo(), (res) => {
  if (res && res.ok) { inRoom = true; $('homeError').textContent = ''; SFX.banner(); }
});
$('joinBtn').onclick = () => doJoin($('codeInput').value);
function doJoin(code) {
  code = (code || '').trim().toUpperCase();
  if (code.length < 4) { $('homeError').textContent = 'Enter a 4-letter code.'; return; }
  socket.emit('join', { code, ...myInfo() }, (res) => {
    if (res && res.ok) { inRoom = true; $('homeError').textContent = ''; SFX.banner(); }
    else $('homeError').textContent = (res && res.error) || 'Could not join.';
  });
}

// ---- Lobby --------------------------------------------------------------
$('leaveLobbyBtn').onclick = () => { socket.emit('leave'); inRoom = false; snap = null; show('home'); };

// ---- In-game quit (with confirmation) ------------------------------------
function setQuitOpen(open) {
  $('quitOverlay').classList.toggle('hidden', !open);
}
function quitGame() {
  socket.emit('leave');
  inRoom = false; snap = null;
  myBody = null; myBodyRound = -1;
  seekerPos = null; seekerRound = -1;
  climbing = false; seekerPeek = false;
  openSheet(null); setEmotesOpen(false); setQuitOpen(false);
  removeMyChar(); removeSeekerChar(); clearChars(); clearSplats(); syncBeacons([]);
  show('home');
  SFX.click();
}
$('quitBtn').addEventListener('click', () => { setQuitOpen(true); SFX.click(); });
$('quitCancel').addEventListener('click', () => { setQuitOpen(false); SFX.click(); });
$('quitConfirm').addEventListener('click', quitGame);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('screen-game').classList.contains('active')) {
    setQuitOpen($('quitOverlay').classList.contains('hidden'));
  }
});
// Starting scatters the hiders instantly, so the host gets a "everyone set?"
// nudge first (only the host ever sees the Start button).
$('startBtn').onclick = () => {
  if (!snap) return;
  $('startConfirmList').innerHTML = snap.players.map((p) => `
    <li><span class="pemoji">${p.avatar}</span><span class="pname">${escapeHtml(p.name)}</span>
    ${p.isBot ? '<span class="tagbadge bot">BOT</span>' : ''}
    ${p.isHost ? '<span class="tagbadge host">HOST</span>' : ''}</li>`).join('');
  $('startConfirm').classList.remove('hidden');
  SFX.click();
};
$('startCancel').onclick = () => { $('startConfirm').classList.add('hidden'); SFX.click(); };
$('startGo').onclick = () => { $('startConfirm').classList.add('hidden'); socket.emit('start'); };
$('shareBtn').onclick = async () => {
  const url = `${location.origin}/?room=${snap.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Doodle Guys', text: `Join my game! Code: ${snap.code}`, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied!'); }
  } catch (_) {}
};
// Effective ground you have to cover: bounds shrink-wrapped by the character
// scale (a 1.6x doodler crosses a 30m yard as fast as a 1x one crosses ~19m).
function mapSizeLabel(m) {
  const b = m.bounds || { minX: -(m.size.x / 2 - 1), maxX: m.size.x / 2 - 1, minZ: -(m.size.z / 2 - 1), maxZ: m.size.z / 2 - 1 };
  const rel = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / (m.charScale || 1);
  return rel < 15 ? 'Small' : rel < 22 ? 'Medium' : rel < 28 ? 'Large' : 'Huge';
}
function buildMapPicker() {
  const el = $('mapPicker'); if (el.childElementCount) return;
  const DIFF = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };
  Object.values(MAPS).forEach((m) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'map-card'; b.dataset.map = m.id;
    b.innerHTML = `
      <img src="/img/maps/${m.id}.jpg" alt="${m.name}" loading="lazy"
           onerror="this.style.display='none'">
      <div class="mc-name">${m.name}</div>
      <div class="mc-meta">
        <span class="mc-badge d${m.difficulty || 2}">${DIFF[m.difficulty] || 'Medium'}</span>
        <span class="mc-badge size">${mapSizeLabel(m)}</span>
      </div>
      <div class="mc-blurb">${m.blurb || ''}</div>`;
    b.addEventListener('click', () => { socket.emit('settings', { map: m.id }); SFX.click(); });
    el.appendChild(b);
  });
}
function syncMapPicker(mapId) {
  for (const c of $('mapPicker').children) c.classList.toggle('selected', c.dataset.map === mapId);
}
$('modeSelect').addEventListener('change', () => socket.emit('settings', { mode: $('modeSelect').value }));
$('prepInput').addEventListener('change', () => socket.emit('settings', { prepTime: +$('prepInput').value }));
$('huntInput').addEventListener('change', () => socket.emit('settings', { huntTime: +$('huntInput').value }));
$('roundsInput').addEventListener('change', () => socket.emit('settings', { rounds: +$('roundsInput').value }));
$('seekersInput').addEventListener('change', () => socket.emit('settings', { seekers: +$('seekersInput').value }));
$('botsInput').addEventListener('change', () => socket.emit('settings', { bots: +$('botsInput').value }));
$('whistleSelect').addEventListener('change', () => socket.emit('settings', { whistle: $('whistleSelect').value }));

function renderLobby() {
  $('lobbyCode').textContent = snap.code;
  const isHost = snap.hostId === myId;
  $('playerCount').textContent = `(${snap.players.length}/10)`;
  $('playerList').innerHTML = snap.players.map((p) => `
    <li><span class="pemoji">${p.avatar}</span><span class="pname">${escapeHtml(p.name)}</span>
    ${p.isBot ? '<span class="tagbadge bot">BOT</span>' : ''}
    ${p.isHost ? '<span class="tagbadge host">HOST</span>' : ''}</li>`).join('');
  $('hostSettings').classList.toggle('hidden', !isHost);
  $('guestWait').classList.toggle('hidden', isHost);
  $('startBtn').classList.toggle('hidden', !isHost);
  $('startBtn').disabled = !(isHost && snap.players.length >= 1);
  $('lobbyHint').textContent = snap.players.length < 2 ? 'Best with friends — share the code! (You can solo-test too.)' : '';
  if (isHost) {
    buildMapPicker();
    syncMapPicker(snap.settings.map);
    $('modeSelect').value = snap.settings.mode;
    $('prepInput').value = snap.settings.prepTime; $('huntInput').value = snap.settings.huntTime;
    $('roundsInput').value = snap.settings.rounds;
    $('seekersInput').value = snap.settings.seekers || 1;
    $('botsInput').value = snap.settings.bots || 0;
    $('whistleSelect').value = snap.settings.whistle || 'auto';
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
// mirrors, windows, doors) — so players can move freely between rooms. Door
// meshes are also hidden entirely: a closed door would seal off a room.
const PASSTHROUGH = /glass|vidro|cortina|curtain|espelho|mirror|janela|window|door|porta\b/i;
// Closed doors seal rooms; ceilings ("teto") make interiors dark and hide the
// action — both are removed, giving every map the bright doll-house look.
const REMOVE = /\bdoor|\bporta\b|teto|ceiling/i;
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
    const p = new Promise((resolve, reject) => {
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
    });
    // Never cache a failure — a lost fetch must not leave the world empty
    // for the rest of the session.
    p.catch((e) => {
      console.warn('model load failed, will retry on next request:', url, e);
      if (modelCache.get(url) === p) modelCache.delete(url);
    });
    modelCache.set(url, p);
  }
  return modelCache.get(url);
}
function loadModel(kit, name) { return loadModelByUrl(modelUrl(kit, name), true); }

// Place a large standalone scene GLB (e.g. a downloaded building) by file path
// under /models. These come at wildly different scales/origins, so we auto-fit
// (scale so the footprint's longest side == `fit`), centre it on (x,z) and drop
// its base to the ground.
async function placeScene(group, file, { x = 0, z = 0, rot = 0, rotX = 0, fit = 30, yOff = 0, solid = false, collide = false, trim = null } = {}) {
  let proto = null;
  // Scene GLBs are high-poly + baked-lit, so skip them in the shadow pass (big
  // FPS win). Retry a couple of times — one dropped fetch must not leave a
  // hole in the map.
  for (let attempt = 0; attempt < 3 && !proto; attempt++) {
    try { proto = await loadModelByUrl(encodeURI('/models/' + file), false, false); }
    catch (_) { await new Promise((r) => setTimeout(r, 700 * (attempt + 1))); }
  }
  if (!proto) { console.warn('scene failed to load after retries:', file); return null; }
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
  // Trim: genuinely REMOVE geometry outside the given world-x/z window
  // (e.g. The Flat plays only in its central rooms — the fenced-off wings
  // shouldn't exist at all). Meshes fully outside are dropped; meshes that
  // straddle the cut get GPU clipping planes so the building visibly ENDS
  // at the cut instead of showing ghost rooms behind an invisible wall.
  let clipPlanes = null;
  if (trim) {
    clipPlanes = [];
    if (trim.minX != null) clipPlanes.push(new THREE.Plane(new THREE.Vector3(1, 0, 0), -trim.minX));
    if (trim.maxX != null) clipPlanes.push(new THREE.Plane(new THREE.Vector3(-1, 0, 0), trim.maxX));
    if (trim.minZ != null) clipPlanes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -trim.minZ));
    if (trim.maxZ != null) clipPlanes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), trim.maxZ));
    renderer.localClippingEnabled = true;
  }
  const _mb = new THREE.Box3();
  const outsideTrim = (o) => {
    if (!trim) return false;
    _mb.setFromObject(o);
    return (trim.minX != null && _mb.max.x < trim.minX) ||
           (trim.maxX != null && _mb.min.x > trim.maxX) ||
           (trim.minZ != null && _mb.max.z < trim.minZ) ||
           (trim.maxZ != null && _mb.min.z > trim.maxZ);
  };
  // Per-mesh collision — but glass partitions / curtains are pass-through and
  // closed doors are removed outright, so you can move freely between rooms.
  inst.traverse((o) => {
    if (!o.isMesh) return;
    if (REMOVE.test(o.name)) { o.visible = false; return; }
    if (outsideTrim(o)) { o.visible = false; return; }   // trimmed away entirely
    if (clipPlanes) {
      // Materials are shared with other instances of this GLB (Mega City
      // reuses the same protos) — clone before clipping.
      const clip = (m) => { const c = m.clone(); c.clippingPlanes = clipPlanes; return c; };
      o.material = Array.isArray(o.material) ? o.material.map(clip) : clip(o.material);
    }
    if (collide && !PASSTHROUGH.test(o.name)) {
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
  // Kit props are solid, climbable cover: every mesh gets collision (this is
  // what stops you walking straight through furniture that had no AABB).
  inst.traverse((o) => {
    if (o.isMesh && !PASSTHROUGH.test(o.name)) {
      try { if (!o.geometry.boundsTree) o.geometry.computeBoundsTree(); } catch (_) {}
      collisionMeshes.push(o);
    }
  });
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

const cam = { yaw: 0, pitch: 0.35 };       // shared look angles
// Pitch range is deliberately modest: past ~±70° the orbit maths approaches
// straight-up/straight-down, where lookAt's up-vector flips the whole view.
const TP = { dist: 0.95, pitchMin: -0.42, pitchMax: 1.2 };  // world distance (zoomable); negative pitch = look up
const FP = { eye: 1.65, pitchMin: -1.15, pitchMax: 1.15 };
// Zoom range is deliberately tight: players should see roughly ONE room at a
// time from their point of view, not survey half the map.
const ZOOM_HIDER = { min: 0.45, max: 2.0 };
const ZOOM_SEEKER = { min: 1.2, max: 2.8 };
const LOOK_SENS = 0.0028;                  // horizontal drag-look sensitivity
// Standard mobile-FPS practice (CoD/PUBG Mobile): vertical aim runs ~30%
// slower than horizontal — fine pitch control without slowing scanning.
const LOOK_SENS_V = 0.0020;
const MOVE_SPEED = 2.8;                    // seeker: a careful stalk
// Hiders are tiny toy-sized mannequins (~0.34m tall) so they can genuinely
// melt into the furniture — the headroom rule still keeps them out of
// unspottable under-furniture gaps. The seeker is bigger, but not a giant —
// it has to fit through the same doorways.
const HIDER_SCALE = 0.18;
const SEEKER_SCALE = 0.35;
const SEEKER_CAM_DIST = 2.4;               // third-person framing for the hunter
const HIDER_MOVE_SPEED = 2.4;

// Per-map character scale: bigger maps get proportionally bigger characters
// so they don't drown in the environment. The multiplier applies to BOTH
// roles, so the hider:seeker ratio never changes.
function charScale() {
  const m = snap && MAPS[snap.mapId];
  return (m && m.charScale) || 1;
}

function initThree() {
  if (threeReady) return;
  const canvas = $('stage');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25)); // cap for FPS
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // cheaper than PCFSoft, near-identical here
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, 1, 0.05, 300);
  raycaster = new THREE.Raycaster();
  clock = new THREE.Clock();

  // Sky-and-ground ambient + a warm sun that casts shadows. The ground bounce
  // is kept near-neutral so the white mannequin reads as white, not green.
  // Slightly over-lit on purpose: the baked apartment interiors have very
  // dark corners that are unfair hiding spots on phone screens.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8b82, 1.35));
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));
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
  scene.add(camera);   // the camera carries the seeker's paint-gun viewmodel

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
  // on top of it.
  const groundMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(map.ground), roughness: 1.0, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(sx * 2.4, sz * 2.4), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  g.add(ground);
  // Open-terrain maps (city streets, the Kenney grounds) walk on the ground
  // plane itself, so it must be a collision mesh — otherwise hasFloor()
  // blocks every step taken off a building. Interior maps leave it out so
  // the building footprint stays the play area (anti-escape).
  if (map.groundWalk) {
    try { ground.geometry.computeBoundsTree(); } catch (_) {}
    collisionMeshes.push(ground);
  }

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
      trim: sc.trim || null,
    });
  }
  for (const w of (map.capWalls || [])) buildCapWall(g, map, w);
  for (const c of (map.connectors || [])) buildConnector(g, c);
}

// A plain solid wall sealing a trimmed play area (e.g. where The Flat's
// removed wings used to connect) — so the map ends in an honest wall, not a
// cut-open room. Spec: { x } or { z } for the wall line, plus optional
// len / h / color.
function buildCapWall(group, map, spec) {
  const h = spec.h || 3.2, t = 0.35;
  let geo, px = 0, pz = 0;
  if (spec.x != null) {
    geo = new THREE.BoxGeometry(t, h, spec.len || map.size.z);
    px = spec.x; pz = spec.at || 0;
  } else {
    geo = new THREE.BoxGeometry(spec.len || map.size.x, h, t);
    px = spec.at || 0; pz = spec.z;
  }
  const wall = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: new THREE.Color(spec.color || '#dbd7d0'), roughness: 0.95,
  }));
  wall.position.set(px, h / 2, pz);
  wall.castShadow = true; wall.receiveShadow = true;
  wall.userData.noCling = true;   // boundary walls are not climbable scenery
  group.add(wall);
  try { wall.geometry.computeBoundsTree(); } catch (_) {}
  collisionMeshes.push(wall);
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
    try { wall.geometry.computeBoundsTree(); } catch (_) {}
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
  // The movement system raycasts collisionMeshes — the AABB list above is
  // only a legacy camera fallback. Without this, walls didn't block walking.
  inst.traverse((o) => {
    if (o.isMesh) {
      o.userData.noCling = true;   // boundary/divider walls aren't climbable
      try { if (!o.geometry.boundsTree) o.geometry.computeBoundsTree(); } catch (_) {}
      collisionMeshes.push(o);
    }
  });
}

// ---- Chameleon character + paintable skin texture ------------------------
// The hider is Meccha Chameleon's icon: a plain WHITE bipedal chameleon
// mannequin. You paint it by hand to blend in — there's no auto-camouflage;
// "invisibility" is pure paint skill. Every chameleon shares one geometry set
// whose UVs are packed into distinct regions of a 512² atlas, so a single
// canvas texture covers the whole body — and a raycast onto any part gives the
// exact texel to paint. The googly eyes use a separate (unpainted) material.
const ATLAS = 512;
// Region rects [x0, y0, x1, y1] in UV space (y measured from the bottom).
const REGIONS = {
  head:  [0.00, 0.50, 0.50, 1.00],
  torso: [0.50, 0.50, 1.00, 1.00],
  armL:  [0.00, 0.25, 0.50, 0.50],
  armR:  [0.50, 0.25, 1.00, 0.50],
  legL:  [0.00, 0.00, 0.50, 0.25],
  legR:  [0.50, 0.00, 1.00, 0.25],
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
  return geo;
}

// Base (unscaled) mannequin height ~1.9; the model faces +Z.
const CHAR_LEN = 1.9;

// ---- Body shapes ---------------------------------------------------------
// Every player picks a body. All shapes share the same rig (waist pivot,
// shoulder pivots, hip-pivoted legs) so the pose set works everywhere, but
// the silhouettes — and therefore every pose — read differently per shape.
// dims drive the per-shape numbers: pivot heights, eye placement, and the
// ground offsets the poses need (flat/ball/kneel).
export const SHAPE_IDS = ['egg', 'buddy', 'bean', 'bobo'];
const charGeoCache = {};
function buildCharGeos(shape) {
  if (charGeoCache[shape]) return charGeoCache[shape];
  const mk = (geo, region) => remapUV(geo, Array.isArray(region) ? region : REGIONS[region]);
  let G;
  if (shape === 'buddy') {
    // The classic two-sphere mannequin: oversized head sunk into a chunky
    // torso, tube arms, stubby legs.
    const head = new THREE.SphereGeometry(0.43, 32, 24);
    head.scale(0.98, 1.03, 0.98);
    G = {
      head:  mk(head, 'head'),
      body:  mk(new THREE.CapsuleGeometry(0.40, 0.44, 12, 30), 'torso'),
      armL:  mk(new THREE.CapsuleGeometry(0.125, 0.34, 8, 20), 'armL'),
      armR:  mk(new THREE.CapsuleGeometry(0.125, 0.34, 8, 20), 'armR'),
      legL:  mk(new THREE.CapsuleGeometry(0.17, 0.14, 8, 20), 'legL'),
      legR:  mk(new THREE.CapsuleGeometry(0.17, 0.14, 8, 20), 'legR'),
      dims: { headY: 1.40, bodyY: 0.77, hipY: 0.48, armX: 0.46, armY: 1.02, armDrop: 0.24,
              legX: 0.19, legDrop: 0.24, eyeDX: 0.14, eyeY: 1.44, eyeZ: 0.40, gunY: 1.0,
              flatY: 0.38, ballY: 0.15, kneelY: -0.10 },
    };
  } else if (shape === 'bean') {
    // Tall and slim: small head, long torso, longer limbs.
    const head = new THREE.SphereGeometry(0.34, 32, 24);
    head.scale(0.95, 1.05, 0.95);
    G = {
      head:  mk(head, 'head'),
      body:  mk(new THREE.CapsuleGeometry(0.28, 0.78, 12, 30), 'torso'),
      armL:  mk(new THREE.CapsuleGeometry(0.105, 0.42, 8, 20), 'armL'),
      armR:  mk(new THREE.CapsuleGeometry(0.105, 0.42, 8, 20), 'armR'),
      legL:  mk(new THREE.CapsuleGeometry(0.13, 0.34, 8, 20), 'legL'),
      legR:  mk(new THREE.CapsuleGeometry(0.13, 0.34, 8, 20), 'legR'),
      dims: { headY: 1.55, bodyY: 0.92, hipY: 0.55, armX: 0.34, armY: 1.20, armDrop: 0.28,
              legX: 0.15, legDrop: 0.25, eyeDX: 0.12, eyeY: 1.58, eyeZ: 0.31, gunY: 1.15,
              flatY: 0.27, ballY: 0.12, kneelY: -0.12 },
    };
  } else if (shape === 'bobo') {
    // A chubby ball with a face: short, round, adorable, hard to spot behind
    // anything round.
    const body = new THREE.SphereGeometry(0.64, 32, 24);
    body.scale(1.02, 0.9, 1.02);
    G = {
      body:  mk(body, [0, 0.5, 1, 1]),  // one big skin: whole top half of the atlas
      armL:  mk(new THREE.CapsuleGeometry(0.11, 0.18, 8, 20), 'armL'),
      armR:  mk(new THREE.CapsuleGeometry(0.11, 0.18, 8, 20), 'armR'),
      legL:  mk(new THREE.CapsuleGeometry(0.14, 0.10, 8, 20), 'legL'),
      legR:  mk(new THREE.CapsuleGeometry(0.14, 0.10, 8, 20), 'legR'),
      dims: { bodyY: 0.72, hipY: 0.38, armX: 0.60, armY: 0.95, armDrop: 0.16,
              legX: 0.22, legDrop: 0.19, eyeDX: 0.17, eyeY: 0.95, eyeZ: 0.60, gunY: 0.85,
              flatY: 0.60, ballY: 0.10, kneelY: -0.05 },
    };
  } else {
    // 'egg' (default): one smooth egg from crown to hips — the menu mascot.
    const body = new THREE.SphereGeometry(0.52, 32, 24);
    body.scale(1.0, 1.72, 0.94);
    G = {
      body:  mk(body, [0, 0.5, 1, 1]),  // one big skin: whole top half of the atlas
      armL:  mk(new THREE.CapsuleGeometry(0.115, 0.30, 8, 20), 'armL'),
      armR:  mk(new THREE.CapsuleGeometry(0.115, 0.30, 8, 20), 'armR'),
      legL:  mk(new THREE.CapsuleGeometry(0.155, 0.16, 8, 20), 'legL'),
      legR:  mk(new THREE.CapsuleGeometry(0.155, 0.16, 8, 20), 'legR'),
      dims: { bodyY: 0.98, hipY: 0.42, armX: 0.50, armY: 1.05, armDrop: 0.22,
              legX: 0.20, legDrop: 0.185, eyeDX: 0.155, eyeY: 1.30, eyeZ: 0.43, gunY: 1.0,
              flatY: 0.46, ballY: 0.18, kneelY: -0.08 },
    };
  }
  charGeoCache[shape] = G;
  return G;
}

// Little dark eyes (like the menu mascots). Not painted, no shadows.
let _eyeGeo = null;
const EYE_MAT = new THREE.MeshStandardMaterial({ color: 0x26262b, roughness: 0.35 });
function eyeGeo() {
  if (!_eyeGeo) _eyeGeo = new THREE.CapsuleGeometry(0.042, 0.09, 6, 12);
  return _eyeGeo;
}

// Build the mannequin as a small rig: a waist-pivoted upper body (with
// shoulder pivots for the arms) and hip-pivoted legs, so poses can bend at
// the joints. Each player gets its own canvas/texture/material (per-player
// paint) but shares the cached per-shape geometry.
function buildCharacter(paintUrl, shape = 'egg') {
  if (!SHAPE_IDS.includes(shape)) shape = 'egg';
  const grp = new THREE.Group();
  grp.rotation.order = 'YXZ'; // yaw first, then pose pitch
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, ATLAS, ATLAS);  // plain white!
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Camouflage-true paint: the eyedropper samples the LIT, fogged colour the
  // wall shows on screen — if the body then re-lights that colour as albedo,
  // the sun multiplies it by 1.0–3.2x depending on facing and the "match"
  // reads several shades off (the old "picked colour never blends" bug).
  // Show the paint mostly EMISSIVE (exactly the picked shade) with a faint
  // lit component so the body still reads as 3D (±10% instead of ±150%).
  const material = new THREE.MeshStandardMaterial({
    map: texture, roughness: 0.9, metalness: 0.0,
    emissiveMap: texture, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.8,
    color: new THREE.Color('#1a1a1a'),
  });

  const G = buildCharGeos(shape);
  const D = G.dims;
  const paintMeshes = [];
  const mesh = (geo, x, y, z = 0) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    paintMeshes.push(m);       // every skin part participates in sphere painting
    return m;
  };
  const pivot = (x, y, z = 0) => { const p = new THREE.Group(); p.position.set(x, y, z); return p; };

  // Upper body rotates at the waist.
  const upper = pivot(0, D.hipY, 0);
  upper.add(mesh(G.body, 0, D.bodyY - D.hipY));
  if (G.head) upper.add(mesh(G.head, 0, D.headY - D.hipY));
  const armL = pivot(-D.armX, D.armY - D.hipY, 0);
  armL.add(mesh(G.armL, 0, -D.armDrop));
  const armR = pivot(D.armX, D.armY - D.hipY, 0);
  armR.add(mesh(G.armR, 0, -D.armDrop));
  upper.add(armL, armR);

  // Eyes ride the upper body (they pitch with poses). Not paintable.
  for (const dx of [-D.eyeDX, D.eyeDX]) {
    const eye = new THREE.Mesh(eyeGeo(), EYE_MAT);
    eye.position.set(dx, D.eyeY - D.hipY, D.eyeZ);
    upper.add(eye);
  }

  // Stubby legs rotate at the hips.
  const legL = pivot(-D.legX, D.hipY, 0);
  legL.add(mesh(G.legL, 0, -D.legDrop));
  const legR = pivot(D.legX, D.hipY, 0);
  legR.add(mesh(G.legR, 0, -D.legDrop));

  grp.add(upper, legL, legR);
  grp.userData = {
    canvas, ctx, texture, material, paintUrl: null,
    joints: { upper, armL, armR, legL, legR },
    paintMeshes,
    shape, dims: D,
    scale: HIDER_SCALE * charScale(),
  };
  if (paintUrl) applyPaintUrl(grp, paintUrl);
  return grp;
}

// Paint a remote chameleon's skin from a data-URL (drawn onto its own canvas).
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

// Pose the rig. Poses are half the camouflage (break the humanoid silhouette
// to imitate props). The set matches the classic Meccha Chameleon figure
// poses: cheer, hands-on-head, zombie, kneel, lie flat, ball, starfish — plus
// 'climb', the wall-flatten "picture frame trick" (back against the wall,
// spread wide, ry = facing OUT of the wall).
function setPose(g, pose) {
  const S = g.userData.scale || HIDER_SCALE;   // hiders are tiny, seekers full-size
  const D = g.userData.dims || { flatY: 0.38, ballY: 0.15, kneelY: -0.10 };
  const j = g.userData.joints;
  // Reset to a clean standing rig (arms splay slightly outward, like the
  // figures — they never hang dead straight).
  g.scale.set(S, S, S); g.rotation.x = 0; g.userData.baseY = 0;
  j.upper.rotation.set(0, 0, 0);
  j.armL.rotation.set(0, 0, -0.14); j.armR.rotation.set(0, 0, 0.14);
  j.legL.rotation.set(0, 0, 0); j.legR.rotation.set(0, 0, 0);

  switch (pose) {
    case 'cheer':                     // both arms up in a V
      j.armL.rotation.set(2.7, 0, -0.5); j.armR.rotation.set(2.7, 0, 0.5);
      break;
    case 'head':                      // hands pressed to the sides of the head
      // The head is huge and the arms are short — anything steeper than a
      // slight inward tilt buries the hands inside the skull.
      j.armL.rotation.set(2.9, 0, 0.1); j.armR.rotation.set(2.9, 0, -0.1);
      break;
    case 'zombie':                    // lean forward, arms out straight
      j.upper.rotation.x = 0.42;
      j.armL.rotation.x = 1.35; j.armR.rotation.x = 1.35;
      break;
    case 'kneel':                     // sit on folded legs
      // Fold the stub legs back and splay them out so the knees poke out
      // beside the torso instead of vanishing into it.
      j.legL.rotation.set(-1.9, 0, -0.35); j.legR.rotation.set(-1.9, 0, 0.35);
      j.armL.rotation.set(0.3, 0, -0.2); j.armR.rotation.set(0.3, 0, 0.2);
      g.userData.baseY = D.kneelY * S;
      break;
    case 'curl':                      // face-down fetal tuck (child's pose)
      // Fold the torso right over the knees, head to the floor; arms hug
      // the sides. Reads as a pebble/bundle from behind.
      j.upper.rotation.x = 1.35;
      j.legL.rotation.set(-1.9, 0, -0.3); j.legR.rotation.set(-1.9, 0, 0.3);
      j.armL.rotation.set(-0.7, 0, -0.25); j.armR.rotation.set(-0.7, 0, 0.25);
      g.userData.baseY = D.kneelY * S;
      break;
    case 'flat':                      // lie flat on the back, straight
      g.rotation.x = -Math.PI / 2; g.userData.baseY = D.flatY * S;
      break;
    case 'ball':                      // curl into a round ball, face down
      // Gentler tucks: the short limbs hug the ball's outside instead of
      // disappearing into the fat torso.
      j.upper.rotation.x = 1.7;
      j.armL.rotation.set(-1.05, 0, -0.45); j.armR.rotation.set(-1.05, 0, 0.45);
      j.legL.rotation.set(-1.15, 0, -0.35); j.legR.rotation.set(-1.15, 0, 0.35);
      g.userData.baseY = D.ballY * S;
      break;
    case 'star':                      // starfish flat on the floor, face down
      g.rotation.x = Math.PI / 2; g.userData.baseY = D.flatY * S;
      // Wider X: arms swing further out so the whole limb clears the torso.
      j.armL.rotation.set(2.5, 0, -1.15); j.armR.rotation.set(2.5, 0, 1.15);
      j.legL.rotation.z = -0.7; j.legR.rotation.z = 0.7;
      break;
    case 'climb':                     // flattened on a wall, spread-eagle
      j.armL.rotation.z = -2.35; j.armR.rotation.z = 2.35;
      j.legL.rotation.z = -0.5; j.legR.rotation.z = 0.5;
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
  if (!myChar) { myChar = buildCharacter(body.paint || null, myShape); scene.add(myChar); myChar.userData.pose = null; }
  if (myChar.userData.pose !== body.pose) { setPose(myChar, body.pose); myChar.userData.pose = body.pose; }
  myChar.position.set(body.x, (body.y || 0) + (myChar.userData.baseY || 0), body.z);
  myChar.rotation.y = body.ry || 0;
}
function removeMyChar() { if (myChar) { scene.remove(myChar); myChar = null; } }

// Turn a freshly built mannequin into a SEEKER: full-size and charcoal-dark,
// unmistakable next to the tiny white hiders.
function makeSeekerLook(g) {
  g.userData.scale = SEEKER_SCALE * charScale();
  const { ctx, texture } = g.userData;
  ctx.fillStyle = '#3a3f47'; ctx.fillRect(0, 0, ATLAS, ATLAS);
  texture.needsUpdate = true;
  setPose(g, 'standing');
  g.userData.pose = 'standing';
}

// The seeker plays OVER-THE-SHOULDER third person (shooter style): you see
// your own dark hunter from behind-right, holding a paint gun that tilts
// with your aim. The shoulder offset keeps the crosshair clear of the body.
let seekerChar = null, paintGun = null, gunPivot = null;

// A simple cheerful paint gun built from primitives.
function buildPaintGun() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.11, 0.32),
    new THREE.MeshStandardMaterial({ color: 0x3f8f5f, roughness: 0.5 }));
  const grip = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.16, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x2c2f36, roughness: 0.7 }));
  grip.position.set(0, -0.12, 0.1); grip.rotation.x = 0.25;
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.028, 0.18, 12),
    new THREE.MeshStandardMaterial({ color: 0x2c2f36, roughness: 0.4 }));
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.012, -0.24);
  const pot = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0xff8a00, roughness: 0.35 }));
  pot.position.set(0, 0.11, 0.03);
  g.add(body, grip, barrel, pot);
  return g;
}

function ensureSeekerChar(p) {
  if (!seekerChar) {
    seekerChar = buildCharacter(null, myShape);
    makeSeekerLook(seekerChar);
    // Gun held out front at chest height; the pivot pitches with the aim.
    gunPivot = new THREE.Group();
    gunPivot.position.set(0.34, seekerChar.userData.dims.gunY, 0.1);   // right hand, unscaled rig units
    paintGun = buildPaintGun();
    paintGun.position.set(0, 0, -0.28);
    gunPivot.add(paintGun);
    seekerChar.userData.joints.upper.add(gunPivot);
    scene.add(seekerChar);
  }
  seekerChar.position.set(p.x, p.y || 0, p.z);
  seekerChar.rotation.y = p.ry || 0;
  if (gunPivot) gunPivot.rotation.x = cam.pitch * 0.8;  // gun tracks the aim
}
function removeSeekerChar() {
  if (seekerChar) { scene.remove(seekerChar); seekerChar = null; paintGun = null; gunPivot = null; }
}

// Floating name tags over teammates' heads: hiders see fellow hiders' names,
// seekers see fellow seekers' — never the other team (that would give away
// hiding spots). At round end everyone sees every seeker's tag too (hiders
// get the big beacon labels instead).
const nameTags = new Map();
function makeNameTag(name) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
  const cx = cv.getContext('2d');
  const text = (name || '').slice(0, 12);
  cx.font = '800 30px "Baloo 2", sans-serif';
  const w = Math.min(248, cx.measureText(text).width + 30);
  cx.fillStyle = 'rgba(255,255,255,.92)';
  cx.beginPath(); cx.roundRect(128 - w / 2, 8, w, 42, 21); cx.fill();
  cx.lineWidth = 4; cx.strokeStyle = 'rgba(58,44,26,.7)'; cx.stroke();
  cx.fillStyle = '#3a2c1a'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText(text, 128, 30);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false,
  }));
  spr.renderOrder = 998;
  return spr;
}
function removeNameTag(id) {
  const t = nameTags.get(id);
  if (!t) return;
  scene.remove(t);
  t.material.map.dispose(); t.material.dispose();
  nameTags.delete(id);
}
function tagVisibleFor(b) {
  if (!b.name || b.mine) return false;
  if (snap.phase === 'roundover') return !!b.seeker;  // hiders have beacon labels
  return !!b.seeker === (snap.myRole === 'seeker');   // teammates only
}

function syncHunt(bodies, skipMine) {
  const seen = new Set();
  for (const b of bodies) {
    if (b.mine && (skipMine || b.seeker)) continue; // my own body renders locally
    seen.add(b.id);
    let g = charGroups.get(b.id);
    // Rebuild the rig when the role changes (infection mode) or the body
    // shape doesn't match (first sync after a shape is known).
    if (g && (!!g.userData.isSeeker !== !!b.seeker || g.userData.shape !== (b.shape || 'egg'))) {
      scene.remove(g); charGroups.delete(b.id); g = null;
    }
    if (!g) {
      g = buildCharacter(b.paint, b.shape || 'egg');
      g.userData.hiderId = b.id;
      // Leave pose null so the first sync ALWAYS runs setPose — presetting
      // 'standing' skipped it, so standing remote hiders never got their
      // tiny scale applied and rendered person-sized (the "giant hider" bug).
      g.userData.pose = null;
      g.userData.isSeeker = !!b.seeker;
      if (b.seeker) makeSeekerLook(g);   // hiders see the dark hunter coming
      scene.add(g); charGroups.set(b.id, g);
    }
    if (!b.seeker) applyPaintUrl(g, b.paint);
    if (g.userData.pose !== b.pose) { setPose(g, b.pose); g.userData.pose = b.pose; }
    // Snapshots arrive ~10×/s; store the target and glide there per-frame in
    // updateRemoteAnims so remote players move at full frame rate.
    const ty = (b.y || 0) + (g.userData.baseY || 0);
    if (!g.userData.init) { g.position.set(b.x, ty, b.z); g.rotation.y = b.ry || 0; g.userData.init = true; }
    g.userData.tgt = { x: b.x, y: ty, z: b.z, ry: b.ry || 0 };
    if (!b.seeker) setFound(g, b.found);
    // Name tag (teammates only; see tagVisibleFor).
    if (tagVisibleFor(b)) {
      if (!nameTags.has(b.id)) {
        const spr = makeNameTag(b.name);
        const w = 0.72 * charScale();
        spr.scale.set(w, w * 0.25, 1);
        scene.add(spr);
        nameTags.set(b.id, spr);
      }
    } else {
      removeNameTag(b.id);
    }
  }
  for (const [id, g] of [...charGroups]) {
    if (!seen.has(id)) { scene.remove(g); charGroups.delete(id); removeNameTag(id); }
  }
}

// Per-frame life: glide remote players toward their network targets, swing
// their limbs while they travel, and give everyone a subtle idle breath.
// The local hider also gets a stretch in the air (snappy cartoon jump).
function updateRemoteAnims(dt, t) {
  const k = Math.min(1, dt * 11);
  for (const [id, g] of charGroups) {
    const tgt = g.userData.tgt;
    if (!tgt) continue;
    const px = g.position.x, pz = g.position.z;
    g.position.x += (tgt.x - g.position.x) * k;
    g.position.y += (tgt.y - g.position.y) * k;
    g.position.z += (tgt.z - g.position.z) * k;
    g.rotation.y += angleDelta(g.rotation.y, tgt.ry) * k;
    // Keep the teammate name tag floating just above the head.
    const tag = nameTags.get(id);
    if (tag) {
      tag.position.set(
        g.position.x,
        g.position.y - (g.userData.baseY || 0) + CHAR_LEN * (g.userData.scale || HIDER_SCALE) + 0.12,
        g.position.z);
    }
    if ((g.userData.pose || 'standing') === 'climb') continue;   // held on the wall
    const j = g.userData.joints;
    const speed = Math.hypot(g.position.x - px, g.position.z - pz) / Math.max(dt, 0.001);
    if (speed > 0.25) {
      // Travelling remotes stand up and walk regardless of their held pose.
      if (!g.userData.rwalking) { setPose(g, 'standing'); g.userData.rwalking = true; }
      g.userData.wp = (g.userData.wp || 0) + dt * (6 + speed * 3.5);
      const a = Math.sin(g.userData.wp) * 0.5;
      j.legL.rotation.x = a; j.legR.rotation.x = -a;
      j.armL.rotation.x = -a * 0.8; j.armR.rotation.x = a * 0.8;
    } else if (g.userData.rwalking) {
      g.userData.rwalking = false;
      g.userData.wp = 0;
      setPose(g, g.userData.pose || 'standing');  // settle back into the pose
    }
    if ((g.userData.pose || 'standing') === 'standing' || g.userData.rwalking) {
      j.upper.scale.y = 1 + Math.sin(t * 2.1 + (g.userData.hiderId || '').length) * 0.015;
    }
  }
  if (myChar && myBody && !climbing && myBody.pose === 'standing') {
    const j = myChar.userData.joints;
    j.upper.scale.y = 1 + Math.sin(t * 2.1) * 0.015;
    const vy = myBody.vy || 0;
    const stretch = Math.abs(vy) > 0.6 ? clamp(1 + vy * 0.02, 0.88, 1.14) : 1;
    const baseS = myChar.userData.scale || HIDER_SCALE;
    myChar.scale.y += (baseS * stretch - myChar.scale.y) * Math.min(1, dt * 14);
  }
  // The local seeker's own body: swing the limbs while striding, and lean
  // the upper body forward while crouching (scanning the floor).
  if (seekerChar) {
    const jj = seekerChar.userData.joints;
    const lean = seekerPeek ? 0.55 : 0;
    jj.upper.rotation.x += (lean - jj.upper.rotation.x) * Math.min(1, dt * 9);
  }
  if (seekerChar && seekerPos && !seekerPeek) {
    const j = seekerChar.userData.joints;
    const lp = seekerChar.userData.lastPos || (seekerChar.userData.lastPos = { x: seekerPos.x, z: seekerPos.z });
    const speed = Math.hypot(seekerPos.x - lp.x, seekerPos.z - lp.z) / Math.max(dt, 0.001);
    lp.x = seekerPos.x; lp.z = seekerPos.z;
    if (speed > 0.3) {
      seekerChar.userData.wp = (seekerChar.userData.wp || 0) + dt * 9;
      const a = Math.sin(seekerChar.userData.wp) * 0.55;
      j.legL.rotation.x = a; j.legR.rotation.x = -a;
      j.armL.rotation.x = -a * 0.8; j.armR.rotation.x = a * 0.8;
    } else if (seekerChar.userData.wp) {
      seekerChar.userData.wp = 0;
      j.legL.rotation.x = j.legR.rotation.x = 0;
      j.armL.rotation.x = j.armR.rotation.x = 0;
    }
    j.upper.scale.y = 1 + Math.sin(t * 2.1) * 0.012;
  }
}
function clearChars() {
  for (const [, g] of charGroups) scene.remove(g);
  charGroups.clear();
  for (const id of [...nameTags.keys()]) removeNameTag(id);
}
const _v3 = new THREE.Vector3();

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
// Sphere brush: the body is six meshes whose UVs live in separate atlas
// regions, so a plain surface stroke leaves WHITE SEAMS wherever parts
// overlap (neck, shoulders, hips). Every dab therefore also paints all
// vertices of EVERY part that fall inside a 3D sphere around the contact
// point — strokes flow across the joints as if the body were one piece.
const _sphLocal = new THREE.Vector3(), _sphInv = new THREE.Matrix4();
function paintSphere(worldPoint) {
  if (!myChar) return;
  const ctx = myChar.userData.ctx;
  const brushPx = BRUSH_PX[brushSize];
  // Local rig units: ~95 atlas px per unit; +0.09 reaches into the joint
  // overlap so the hidden white collar under each part gets covered too.
  const localR = brushPx / 95 + 0.09;
  const r2 = localR * localR;
  const dabR = Math.max(brushPx * 0.8, 9);   // dabs overlap between vertices
  ctx.fillStyle = brushColor;
  for (const m of myChar.userData.paintMeshes) {
    _sphInv.copy(m.matrixWorld).invert();
    _sphLocal.copy(worldPoint).applyMatrix4(_sphInv);
    const pos = m.geometry.attributes.position;
    const uv = m.geometry.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - _sphLocal.x;
      const dy = pos.getY(i) - _sphLocal.y;
      const dz = pos.getZ(i) - _sphLocal.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      ctx.beginPath();
      ctx.arc(uv.getX(i) * ATLAS, (1 - uv.getY(i)) * ATLAS, dabR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Raycast a screen point onto my chameleon; paint if it lands on the body.
function paintRaycast(clientX, clientY) {
  if (!myChar) return false;
  raycaster.setFromCamera(tapNDC(clientX, clientY), camera);
  // Only the skin meshes — the eyes aren't paintable (their UVs would smear
  // paint into the wrong atlas region).
  const hit = raycaster.intersectObjects(myChar.userData.paintMeshes, false)[0];
  if (hit && hit.uv) {
    paintSphere(hit.point);        // seamless coverage across joints
    paintAtUV(hit.uv);             // smooth connected stroke on the hit part
    paintSplash(clientX, clientY);
    return true;
  }
  return false;
}
function endStroke() { lastDab = null; if (paintDirtyForSync) sendTexture(true); }
function fillAll() {
  if (!myChar) return;
  pushUndo();
  const ctx = myChar.userData.ctx;
  ctx.fillStyle = brushColor; ctx.fillRect(0, 0, ATLAS, ATLAS);
  myChar.userData.texture.needsUpdate = true;
  sendTexture(true);
  SFX.splat();
}

// Paint undo (the original has one): snapshot before every stroke/fill.
const undoStack = [];
function pushUndo() {
  if (!myChar) return;
  undoStack.push(myChar.userData.ctx.getImageData(0, 0, ATLAS, ATLAS));
  if (undoStack.length > 8) undoStack.shift();
}
function undoPaint() {
  if (!myChar || !undoStack.length) return;
  myChar.userData.ctx.putImageData(undoStack.pop(), 0, 0);
  myChar.userData.texture.needsUpdate = true;
  sendTexture(true);
  SFX.click();
}

// ---- WHISTLE: the anti-camping heartbeat ----------------------------------
// Every hider auto-whistles every 30s (server-driven), betraying their rough
// position by SOUND. Whistling manually resets that countdown — so you whistle
// on purpose while the seeker is far away to stay silent when it's near.
const WHISTLE_EVERY_MS = 30000;
let myWhistleDeadline = 0;      // local mirror of the server countdown

function sendWhistle() {
  if (!snap || snap.phase !== 'hunt' || snap.myRole !== 'hider' || iAmFound()) return;
  socket.emit('whistle');
}

// Spatialised-ish playback: volume by distance, stereo pan by direction
// relative to the camera. Seekers hunt by EAR — there's no visual marker.
function playWhistle(x, y, z) {
  const a = ac(); if (!a) return;
  const lp = camera ? camera.position : { x: 0, y: 0, z: 0 };
  const d = Math.hypot(x - lp.x, (y || 0) - lp.y, z - lp.z);
  const vol = clamp(0.35 / (1 + d * 0.12), 0.02, 0.35);
  // Pan by the direction to the source in camera space.
  let pan = 0;
  if (camera) {
    _v3.set(x, y || 0, z).sub(camera.position);
    const right = _v3b.setFromMatrixColumn(camera.matrixWorld, 0);
    pan = clamp(_v3.normalize().dot(right.normalize()), -1, 1) * 0.8;
  }
  const t0 = a.currentTime;
  const mk = (f0, f1, start, dur) => {
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t0 + start);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + start + dur);
    g.gain.setValueAtTime(vol, t0 + start);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + start + dur);
    let out = g;
    if (a.createStereoPanner) { const p = a.createStereoPanner(); p.pan.value = pan; g.connect(p); out = p; }
    o.connect(g); out.connect(a.destination);
    o.start(t0 + start); o.stop(t0 + start + dur + 0.02);
  };
  mk(880, 1500, 0, 0.18);      // fweee…
  mk(1500, 700, 0.2, 0.25);    // …fwooo
}
const _v3b = new THREE.Vector3();
function worldToScreen(pos) {
  const r = canvas.getBoundingClientRect();
  const p = _v3.copy(pos).project(camera);
  if (p.z > 1) return null;
  return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
}

// ---- Camera + movement --------------------------------------------------
function forwardXZ(yaw) { return { x: Math.sin(yaw), z: Math.cos(yaw) }; }
function lerpAngle(a, b, t) { return a + angleDelta(a, b) * t; }
function angleDelta(a, b) { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }

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
const _ro = new THREE.Vector3(), _rd = new THREE.Vector3(), _nrm = new THREE.Vector3();
function castDist(x, y, z, dx, dz) {
  _ro.set(x, y, z); _rd.set(dx, 0, dz).normalize();
  _rc.set(_ro, _rd); _rc.far = 6;
  const hits = _rc.intersectObjects(collisionMeshes, true);
  return hits.length ? hits[0].distance : Infinity;
}
// Move with wall-sliding, testing at ankle AND mid-body height so skirting
// boards / thin sills don't wedge the actor.
function slideMove(px, pz, nx, nz, y, rad, midY) {
  if (!collisionMeshes.length) return [nx, nz];
  const my = midY == null ? y + 0.25 : midY;
  const pass = (fx, fz, tx, tz) => Math.min(
    castDist(fx, y, fz, tx, tz), castDist(fx, my, fz, tx, tz));
  const dx = nx - px, dz = nz - pz;
  if (dx !== 0) {
    const s = Math.sign(dx), d = pass(px, pz, s, 0);
    if (d < Math.abs(dx) + rad) nx = px + s * Math.max(0, d - rad);
  }
  if (dz !== 0) {
    const s = Math.sign(dz), d = pass(nx, pz, 0, s);
    if (d < Math.abs(dz) + rad) nz = pz + s * Math.max(0, d - rad);
  }
  return [nx, nz];
}

// ---- Jumping & climbing ---------------------------------------------------
// Snappy arcade jumps scaled to each body: the tiny hider hops ~0.5m (onto
// sofa seats and low props — walls need the climb), the full-size seeker
// clears ~1.15m.
const GRAVITY = 32, HIDER_JUMP_VEL = 5.8, SEEKER_JUMP_VEL = 8.6;
const CLING_RANGE = 1.2, ROOF = 2.6;
const CLING_GAP = 0.09;  // half the tiny body's depth — flush without clipping in
const CLING_REACH = 0.5; // re-stick range: detach promptly once the surface ends
const JUMP_BUFFER_MS = 160; // press slightly early and it still fires on landing
let jumpAskedAt = 0, climbing = false, nearSurface = false, climbMiss = 0;
function wantJump() { return performance.now() - jumpAskedAt < JUMP_BUFFER_MS; }
function consumeJump() { jumpAskedAt = 0; }

// Push a point out of any wall/object it's overlapping (so you can never end
// up inside geometry). The per-frame version casts only the 4 cardinal rays
// at one height — cheap; spawn checks use the full 8-direction sweep.
const DEPEN_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]];
function depenetrate(p, rayY, rad) {
  if (!collisionMeshes.length) return;
  for (let i = 0; i < 4; i++) {
    const [dx, dz] = DEPEN_DIRS[i];
    const d = castDist(p.x, rayY + 0.12, p.z, dx, dz);
    if (d < rad) { p.x -= dx * (rad - d + 0.01); p.z -= dz * (rad - d + 0.01); }
  }
}

// Is (x,z) a clear spot (no wall within `rad`, floor under it, headroom to
// stand)? Used to fix bad spawns — never start wedged inside furniture.
function isClear(x, y, z, rad) {
  // Outside the play bounds is technically "clear" (no walls out there!) —
  // never let a spawn fix or unstick pop relocate a player out of the arena.
  const b = bounds();
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return false;
  if (!hasFloor(x, z, y)) return false;
  // Reject furniture tops: a spot that sits noticeably ABOVE its
  // surroundings is a counter/table/wardrobe, not floor — spawning up there
  // can trap players in cabinet channels. Gentle terrain (hills) passes,
  // since neighbours rise with it.
  const top = surfaceTop(x, z);
  let minAround = Infinity;
  for (const [dx, dz] of [[0.9, 0], [-0.9, 0], [0, 0.9], [0, -0.9]]) {
    minAround = Math.min(minAround, surfaceTop(x + dx, z + dz));
  }
  if (isFinite(minAround) && top - minAround > 0.35) return false;
  const gy = groundUnder(x, y + 0.4, z);
  if (clearanceAbove(x, gy, z) < MIN_HEADROOM_HIDER * charScale()) return false;
  for (const [dx, dz] of DEPEN_DIRS) {
    if (castDist(x, y + 0.15, z, dx, dz) < rad) return false;
  }
  return true;
}
function findClearSpawn(x, z, rad = 0.35) {
  if (isClear(x, 0.1, z, rad)) return [x, z];
  for (let ring = 1; ring <= 6; ring++) {
    const d = ring * 0.7;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + ring * 0.4;
      const nx = x + Math.cos(a) * d, nz = z + Math.sin(a) * d;
      if (isClear(nx, 0.1, nz, rad)) return [nx, nz];
    }
  }
  return [x, z]; // give up — depenetrate will keep trying each frame
}

// Open space above a point (to the first ceiling-ish surface). Used to stop
// hiders crawling UNDER sofas/beds/tables — a fully hidden hider is no fun to
// hunt. Room ceilings are ~2.4m+, so they never block normal movement.
function clearanceAbove(x, y, z) {
  if (!collisionMeshes.length) return Infinity;
  _ro.set(x, y + 0.06, z); _rd.set(0, 1, 0);
  _rc.set(_ro, _rd); _rc.far = 3;
  const h = _rc.intersectObjects(collisionMeshes, true)[0];
  return h ? h.distance : Infinity;
}
// 0.6 blocks the sofa/bed crawl-space (solid skirts → unspottable) but still
// lets you duck between open table legs, where a seeker CAN spot you.
const MIN_HEADROOM_HIDER = 0.6;
const MIN_HEADROOM_SEEKER = 0.75; // taller than a hider, so still no ducking under tables

// Allow a move if the destination has enough headroom — OR at least as much
// as where you already stand. Blocking on absolute clearance alone froze
// players solid when they spawned under a low soffit: every neighbouring
// spot was "too low" too, including the way out.
function headroomOK(fromX, fromY, fromZ, toX, toGy, toZ, min) {
  const dest = clearanceAbove(toX, toGy, toZ);
  if (dest >= min) return true;
  const here = clearanceAbove(fromX, groundUnder(fromX, fromY + 0.4, fromZ), fromZ);
  return dest >= here - 0.05;      // never into LOWER clearance, always out
}

// Highest walkable surface at (x,z), probed from far above — used to place
// spawns correctly on sloped/raised terrain (e.g. the plaza hill).
function surfaceTop(x, z) {
  if (!collisionMeshes.length) return 0;
  _ro.set(x, 40, z); _rd.set(0, -1, 0);
  _rc.set(_ro, _rd); _rc.far = 80;
  const h = _rc.intersectObjects(collisionMeshes, true)[0];
  return h ? h.point.y : 0;
}

// Vertical play limit: keeps players from hopping over the flat's wall tops,
// while still allowing genuinely tall maps (hillside plazas etc.).
function roofY() {
  const map = snap && MAPS[snap.mapId];
  return (map && map.roof) || ROOF;
}

// Is there a building floor under (x,z)? Used to keep players ON the floors
// and out of the surrounding void (anti-escape).
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

// Is there a climbable surface within reach of the chameleon's facing?
// Remember the direction straight INTO that surface (along its normal) so
// climbing can snap flush and align to it.
const surfaceDir = { x: 0, z: 1 };
const climbDir = { x: 0, z: 1 };
function detectSurface(p) {
  if (!collisionMeshes.length) return false;
  _ro.set(p.x, (p.y || 0) + 0.12, p.z); _rd.set(Math.sin(p.ry), 0, Math.cos(p.ry)).normalize();
  _rc.set(_ro, _rd); _rc.far = CLING_RANGE;
  // Boundary/divider walls are noCling: their hollow builds let clingers
  // snap INSIDE the wall (or through to the far side, out of the play area),
  // and boundary walls shouldn't be hiding spots anyway. Rocks, furniture
  // and building scenery stay climbable.
  const hit = _rc.intersectObjects(collisionMeshes, true)
    .find((h) => !h.object.userData.noCling);
  if (!hit) return false;
  let nx = _rd.x, nz = _rd.z;
  if (hit.face) {
    _nrm.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    if (Math.hypot(_nrm.x, _nrm.z) > 0.25) { // a wall, not a floor/ceiling
      const m = Math.hypot(_nrm.x, _nrm.z);
      nx = -_nrm.x / m; nz = -_nrm.z / m;
      // Baked interior meshes often have flipped normals; the ray direction is
      // ground truth for "into the wall" — never point back at the player.
      if (nx * _rd.x + nz * _rd.z < 0) { nx = -nx; nz = -nz; }
    }
  }
  surfaceDir.x = nx; surfaceDir.z = nz;
  return true;
}

// Camera-relative movement: the joystick/WASD vector is interpreted in the
// camera's frame — push up = away from camera, push right = SCREEN right —
// and the mannequin turns to face its direction of travel.
// Screen-right for a view direction d=(sin yaw, cos yaw) is d × up =
// (-cos yaw, sin yaw). (The old vector was negated: A strafed right.)
function moveVector() {
  const f = forwardXZ(cam.yaw);
  const rx = -f.z, rz = f.x;                 // camera-right on the XZ plane
  const x = f.x * joyVec.y + rx * joyVec.x;
  const z = f.z * joyVec.y + rz * joyVec.x;
  const m = Math.hypot(x, z);
  if (m < 0.001) return null;
  return { x: x / m, z: z / m, mag: Math.min(1, m) };
}

// Is the player actively steering (stick or keys)?
function isMovingInput() { return Math.hypot(joyVec.x, joyVec.y) > 0.06; }

// Chase camera: while moving, the camera eases back behind the character's
// facing; free orbit is only for standing still.
function followBehind(ry, dt) {
  // The player's look-drag always wins: while a finger is steering the
  // camera, the chase camera keeps its hands off the yaw.
  if (isLookDragging()) return;
  cam.yaw += angleDelta(cam.yaw, ry) * Math.min(1, dt * 3.5);
}
function isLookDragging() { return lookId !== null && !painting; }

// Last-resort trap escape. Baked interior models hide one-way pockets
// (depenetration can shove a body past a lip it can't walk back over).
// If the player is HOLDING a direction but hasn't actually moved for a
// couple of seconds, relocate to the nearest clear floor spot.
function autoUnstick(p, dt) {
  if (!isMovingInput() || climbing) { p._anchor = null; return; }
  // Anchor-based: wall-sliding jitters a little every frame, so measure NET
  // displacement over a window instead of per-frame movement.
  if (!p._anchor) p._anchor = { x: p.x, z: p.z, t: 0 };
  p._anchor.t += dt;
  if (Math.hypot(p.x - p._anchor.x, p.z - p._anchor.z) > 0.45) {
    p._anchor = { x: p.x, z: p.z, t: 0 };
    return;
  }
  if (p._anchor.t > 2.5) {
    p._anchor = null;
    const [nx, nz] = findClearSpawn(p.x, p.z, 0.3);
    if (nx !== p.x || nz !== p.z) {
      p.x = nx; p.z = nz; p.y = surfaceTop(nx, nz) + 0.02; p.vy = 0;
      toast('🪄 Popped free of a tight spot!', 1500);
    }
  }
}

function applyMovement(dt) {
  const b = bounds();
  if (!hiderControls()) climbing = false;

  if (hiderControls()) {
    const p = myBody; p.vy = p.vy || 0;
    // Move speed scales with the character (bigger toys on bigger maps stride
    // proportionally), so a large character never crawls across a big map.
    const HSPD = HIDER_MOVE_SPEED * charScale();
    const HRAD = 0.16 * charScale(), RAYY = (p.y || 0) + 0.1;
    if (climbing) {
      // On the wall: up/down climbs, left/right sidles along the surface.
      // Screen-right while the camera faces the wall (along climbDir) is
      // climbDir × up = (-dz, dx).
      const up = joyVec.y, side = joyVec.x;
      if (up > 0) { const ny = (p.y || 0) + up * HSPD * dt; if (ny <= roofY()) p.y = ny; }
      else if (up < 0) { p.y = Math.max(0, (p.y || 0) + up * HSPD * dt); }
      if (side) {
        const px = -climbDir.z, pz = climbDir.x;
        let nx = clamp(p.x + px * side * HSPD * dt, b.minX, b.maxX);
        let nz = clamp(p.z + pz * side * HSPD * dt, b.minZ, b.maxZ);
        [nx, nz] = slideMove(p.x, p.z, nx, nz, (p.y || 0) + 0.12, HRAD);
        p.x = nx; p.z = nz;
      }
      // Re-stick flush to the surface (probe at two heights — baked meshes
      // are lumpy); only let go after the surface is gone several frames in
      // a row, so a one-frame miss doesn't drop you off the wall.
      const probeStick = (hy) => {
        _ro.set(p.x - climbDir.x * 0.35, hy, p.z - climbDir.z * 0.35);
        _rd.set(climbDir.x, 0, climbDir.z).normalize();
        _rc.set(_ro, _rd); _rc.far = 0.35 + CLING_REACH;
        // Same rule as attaching: boundary walls never stick — sidling along
        // scenery must not hand the climber over to a perimeter wall.
        return _rc.intersectObjects(collisionMeshes, true)
          .find((h) => !h.object.userData.noCling);
      };
      const sh = probeStick((p.y || 0) + 0.12) || probeStick((p.y || 0) + 0.45);
      const gy = groundUnder(p.x, (p.y || 0) + 0.5, p.z);
      // Climbing DOWN onto the floor releases; resting flat at ground level
      // sticks (that's the picture-frame pose).
      if ((p.y || 0) <= gy + 0.05 && up < 0) { p.y = gy; stopClimb(); }
      else if (sh) {
        const sx = sh.point.x - climbDir.x * CLING_GAP;
        const sz = sh.point.z - climbDir.z * CLING_GAP;
        // A stick point far from where we are means the ray started inside
        // the wall and hit the FAR face — snapping there tunnels the player
        // through. Treat it as a miss instead of teleporting.
        if (Math.hypot(sx - p.x, sz - p.z) <= 0.45 * charScale()) {
          climbMiss = 0;
          p.x = clamp(sx, b.minX, b.maxX);
          p.z = clamp(sz, b.minZ, b.maxZ);
        } else if (++climbMiss >= 5) { stopClimb(); }
      } else if (++climbMiss >= 5) {                                       // surface really ended
        const fx = clamp(p.x + climbDir.x * 0.35, b.minX, b.maxX);
        const fz = clamp(p.z + climbDir.z * 0.35, b.minZ, b.maxZ);
        if (up > 0 && hasFloor(fx, fz, p.y)) {                             // crested the top → step on
          // ...but never onto a wall top: walls are the springboard for
          // hopping between rooms or clean out of the arena. Two tells —
          // the top sits at/above the roof cap, or it's a knife-edge (the
          // ground one step further along falls away). Furniture tops are
          // lower AND wide, so they still crest fine.
          const gy2 = groundUnder(fx, (p.y || 0) + 0.4, fz);
          const gy3 = groundUnder(fx + climbDir.x * 0.2, gy2 + 0.4, fz + climbDir.z * 0.2);
          if (gy2 <= roofY() - 0.15 && gy2 - gy3 <= 1.0 * charScale()) {
            p.x = fx; p.z = fz; p.y = gy2;
          }
        }
        stopClimb();                                                      // otherwise drop
      }
      if (climbing) p.vy = 0;
      if (wantJump()) { consumeJump(); stopClimb(); p.vy = HIDER_JUMP_VEL * 0.55; }
    } else {
      // Camera-relative walk.
      const mv = moveVector();
      if (mv) {
        p.ry = lerpAngle(p.ry, Math.atan2(mv.x, mv.z), Math.min(1, dt * 12));
        followBehind(p.ry, dt);        // moving: camera swings back behind you
        let nx = clamp(p.x + mv.x * mv.mag * HSPD * dt, b.minX, b.maxX);
        let nz = clamp(p.z + mv.z * mv.mag * HSPD * dt, b.minZ, b.maxZ);
        [nx, nz] = slideMove(p.x, p.z, nx, nz, RAYY, HRAD, (p.y || 0) + 0.3);
        // Stay on the building floor, and never crawl under furniture.
        const gy = groundUnder(nx, (p.y || 0) + 0.4, nz);
        if (hasFloor(nx, nz, p.y) && headroomOK(p.x, p.y || 0, p.z, nx, gy, nz, MIN_HEADROOM_HIDER * charScale())) {
          p.x = nx; p.z = nz;
        }
      }
      depenetrate(p, RAYY, HRAD);
      if (wantJump() && (p.y || 0) <= groundUnder(p.x, p.y || 0, p.z) + 0.04) {
        consumeJump(); p.vy = HIDER_JUMP_VEL; SFX.click();
      }
      p.vy -= GRAVITY * dt;
      let ny = (p.y || 0) + p.vy * dt;
      const g = groundUnder(p.x, ny, p.z);
      if (ny <= g) { ny = g; p.vy = 0; }
      const cap = roofY(); if (ny > cap) { ny = cap; if (p.vy > 0) p.vy = 0; }
      p.y = ny;
    }
    // Hard arena limit: no matter which mover wrote the position this frame
    // (walk, climb re-stick, depenetrate, unstick pop), it ends up in bounds.
    p.x = clamp(p.x, b.minX, b.maxX); p.z = clamp(p.z, b.minZ, b.maxZ);
    autoUnstick(p, dt);
    nearSurface = !climbing && (frameCount % 3 === 0 ? detectSurface(p) : nearSurface);
    ensureMyChar(myBody);
    if (joyVec.x || joyVec.y || climbing || p.vy !== 0) sendMove(false);
  } else if (snap.phase === 'hunt' && snap.myRole === 'seeker' && seekerPos) {
    const p = seekerPos; p.vy = p.vy || 0;
    // Slim on purpose: the flat's bedroom doorways are narrow, and a fat
    // radius trapped seekers inside. Slight visual clipping at door edges is
    // far better than being stuck.
    const SRAD = 0.15 * charScale(), RAYY = (p.y || 0) + 0.25 * charScale();
    // Third person: move camera-relative and turn the body to face travel.
    const mv = moveVector();
    // FPS: the body always faces where the camera looks (the gun IS the aim).
    p.ry = cam.yaw;
    if (mv) {
      const spd = (seekerPeek ? MOVE_SPEED * 0.45 : MOVE_SPEED) * charScale();  // creep while peeking; scales with size
      let nx = clamp(p.x + mv.x * mv.mag * spd * dt, b.minX, b.maxX);
      let nz = clamp(p.z + mv.z * mv.mag * spd * dt, b.minZ, b.maxZ);
      [nx, nz] = slideMove(p.x, p.z, nx, nz, RAYY, SRAD, (p.y || 0) + 0.5);
      const gy = groundUnder(nx, (p.y || 0) + 0.4, nz);
      if (hasFloor(nx, nz, p.y) && headroomOK(p.x, p.y || 0, p.z, nx, gy, nz, MIN_HEADROOM_SEEKER * charScale())) {
        p.x = nx; p.z = nz; // stay on the building floor, out from under furniture
      }
    }
    depenetrate(p, RAYY, SRAD);
    if (wantJump() && (p.y || 0) <= groundUnder(p.x, p.y || 0, p.z) + 0.04) { consumeJump(); p.vy = SEEKER_JUMP_VEL; }
    p.vy -= GRAVITY * dt;
    let ny = (p.y || 0) + p.vy * dt;
    const g = groundUnder(p.x, ny, p.z);
    if (ny <= g) { ny = g; p.vy = 0; }
    const cap = roofY(); if (ny > cap) { ny = cap; if (p.vy > 0) p.vy = 0; }
    p.y = ny;
    p.x = clamp(p.x, b.minX, b.maxX); p.z = clamp(p.z, b.minZ, b.maxZ);
    autoUnstick(p, dt);
    ensureSeekerChar(p);
    sendSeek();
  } else if (iSpectate()) {
    // Caught: roam freely as a spectator (camera-relative, on the floor).
    const p = myBody;
    const mv = moveVector();
    if (mv) {
      p.ry = lerpAngle(p.ry, Math.atan2(mv.x, mv.z), Math.min(1, dt * 12));
      followBehind(p.ry, dt);          // moving: camera swings back behind you
      let nx = clamp(p.x + mv.x * HIDER_MOVE_SPEED * 1.6 * charScale() * dt, b.minX, b.maxX);
      let nz = clamp(p.z + mv.z * HIDER_MOVE_SPEED * 1.6 * charScale() * dt, b.minZ, b.maxZ);
      [nx, nz] = slideMove(p.x, p.z, nx, nz, (p.y || 0) + 0.12, 0.16);
      if (hasFloor(nx, nz, p.y)) { p.x = nx; p.z = nz; }
    }
    depenetrate(p, (p.y || 0) + 0.12, 0.16);
    p.x = clamp(p.x, b.minX, b.maxX); p.z = clamp(p.z, b.minZ, b.maxZ);
    p.y = groundUnder(p.x, (p.y || 0) + 0.5, p.z);
  }
}

function stopClimb() {
  if (!climbing) return;
  climbing = false;
  if (myBody) myBody.pose = 'standing';
  syncPoseButtons();
}
function syncPoseButtons() {
  const pose = myBody ? myBody.pose : 'standing';
  document.querySelectorAll('#posePanel .pose').forEach((x) =>
    x.classList.toggle('active', x.dataset.pose === pose));
}

// Seeker tells the server its position (hiders see the hunter in-world, and
// spectators' minimaps update).
let lastSeekSent = 0;
function sendSeek() {
  const now = Date.now();
  if (now - lastSeekSent < 120) return;
  lastSeekSent = now;
  socket.emit('seekmove', {
    x: seekerPos.x, y: seekerPos.y || 0, z: seekerPos.z, ry: seekerPos.ry || 0,
    pose: seekerPeek ? 'kneel' : 'standing',
  });
}

// The server walks bot hiders to their spots without any geometry, so a bot
// can end up wedged INSIDE a cabinet — unfindable and unfair. At hunt start
// the host's client (which has the collision meshes) relocates any such bot
// to the nearest clear floor spot, exactly like the player spawn fix.
function fixBotHidingSpots() {
  if (!snap || snap.phase !== 'hunt' || snap.hostId !== myId) return;
  for (const b of (snap.bodies || [])) {
    if (b.seeker || !b.id || !String(b.id).startsWith('bot-')) continue;
    const [cx, cz] = findClearSpawn(b.x, b.z, 0.35);
    const cy = surfaceTop(cx, cz) + 0.02;
    if (Math.hypot(cx - b.x, cz - b.z) > 0.05 || Math.abs(cy - (b.y || 0)) > 0.25) {
      socket.emit('bothide', { id: b.id, x: cx, y: cy, z: cz });
    }
  }
}

// ---- Host-driven bot seeker AI --------------------------------------------
// The server has no level geometry, so the HOST's client simulates bot
// seekers with the real collision meshes:
//  - they walk with the same wall collision as players (never through walls),
//    picking patrol spots and RE-targeting when stuck, which makes them sweep
//    room to room through the doorways;
//  - they only "spot" a hider with a clear LINE OF SIGHT, inside a forward
//    cone, at short range — and silhouette-breaking poses HALVE that range,
//    so a well-hidden player is genuinely hard to find (the AI never reads
//    hider positions through walls);
//  - a whistle sends them to investigate the sound;
//  - shots go through the server ('botshoot') with the normal 3s reload.
// Host migration hands the AI to the next client automatically.
const botSim = new Map();   // bot id → simulation state

// Deterministic personality per bot id: every Botty hunts differently —
// pace, eyesight, patience (idle scans), reaction time, and how precisely
// they localise a whistle. Hashing the id means every client that ever
// hosts this bot gives it the SAME character, with no syncing.
function botTrait(id, salt) {
  let h = 2166136261;
  const str = id + ':' + salt;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 8) % 1000) / 1000;
}
function botTraits(id) {
  return {
    speed: 0.72 + botTrait(id, 'spd') * 0.33,       // 0.72–1.05× of the tuned pace
    sight: 0.75 + botTrait(id, 'sight') * 0.55,     // short- vs eagle-eyed
    pauseChance: 0.25 + botTrait(id, 'pc') * 0.5,   // how often it stops to scan
    pauseMs: 700 + botTrait(id, 'pm') * 1600,       // how long the scan lasts
    reactMs: 150 + botTrait(id, 're') * 600,        // spotting → giving chase
    earJitter: 1 + botTrait(id, 'ear') * 2.5,       // whistle localisation error (m)
  };
}

function updateBotSeekers(dt) {
  const hosting = snap && snap.phase === 'hunt' && snap.hostId === myId;
  if (!hosting) { if (botSim.size) botSim.clear(); return; }
  const bots = (snap.bodies || []).filter((b) => b.seeker && b.bot);
  if (!bots.length) { botSim.clear(); return; }
  const cs = charScale();
  const map = MAPS[snap.mapId] || MAPS[DEFAULT_MAP_ID];
  const pts = spawnPoints(map);
  const bnd = bounds();
  const now = Date.now();
  for (const bb of bots) {
    let s = botSim.get(bb.id);
    if (!s) {
      s = { x: bb.x, y: bb.y || 0, z: bb.z, ry: bb.ry || 0, target: null, mode: 'patrol',
            lastSeen: null, senseAt: 0, sendAt: 0, shotAt: now, idleUntil: 0, reactUntil: 0,
            traits: botTraits(bb.id), stuck: { x: bb.x, z: bb.z, t: 0 } };
      botSim.set(bb.id, s);
    }
    const T = s.traits;
    // ---- Sense (every 150ms — LOS raycasts aren't free) ----
    if (now >= s.senseAt) {
      s.senseAt = now + 150;
      const hadPrey = !!s.prey;
      s.prey = null;
      let pd = Infinity;
      const SIGHT = 3.4 * cs * T.sight;
      for (const h of snap.bodies) {
        if (h.seeker || h.found) continue;
        const dx = h.x - s.x, dz = h.z - s.z;
        const d = Math.hypot(dx, dz);
        // Hiding pays: any non-standing pose halves the spot range.
        const sight = (h.pose && h.pose !== 'standing') ? SIGHT * 0.5 : SIGHT;
        if (d > sight || d >= pd) continue;
        // Forward cone (~150°) — but skip it at arm's reach: a hider RIGHT
        // NEXT to the bot gets noticed no matter which way it faces.
        if (d > 1.2 * cs && (Math.sin(s.ry) * dx + Math.cos(s.ry) * dz) / (d || 1) < 0.25) continue;
        // True line of sight through the level.
        _ro.set(s.x, (s.y || 0) + 0.9 * cs, s.z);
        _rd.set(dx, ((h.y || 0) + 0.3 * cs) - ((s.y || 0) + 0.9 * cs), dz).normalize();
        _rc.set(_ro, _rd); _rc.far = Math.max(0.1, d - 0.25);
        if (collisionMeshes.length && _rc.intersectObjects(collisionMeshes, true).length) continue;
        s.prey = { x: h.x, z: h.z }; pd = d;
      }
      if (s.prey && !hadPrey) s.reactUntil = now + T.reactMs;   // "…wait, was that—?"
      if (s.prey && now < s.reactUntil) s.prey = null;          // still processing
      if (s.prey) { s.mode = 'chase'; s.lastSeen = { ...s.prey }; s.idleUntil = 0; }
      else if (s.mode === 'chase') { s.mode = 'investigate'; s.target = s.lastSeen; }
      // Point-blank + reloaded → fire (server re-validates the reload).
      if (s.prey && pd < 1.25 && now - s.shotAt >= 3050) {
        s.shotAt = now;
        socket.emit('botshoot', { id: bb.id, x: s.prey.x, z: s.prey.z });
      }
    }
    // ---- Idle scan: some bots stop and look around between rooms, which is
    // exactly the opening a hider needs to relocate. ----
    if (!s.prey && now < s.idleUntil) {
      s.ry += dt * 1.3;   // slow turn on the spot
      if (now - s.sendAt > 110) { s.sendAt = now; socket.emit('botmove', { id: bb.id, x: s.x, y: s.y, z: s.z, ry: s.ry }); }
      continue;
    }
    // ---- Steer ----
    let tx, tz;
    if (s.prey) { tx = s.prey.x; tz = s.prey.z; }
    else {
      if (s.whistle) { s.target = s.whistle; s.whistle = null; s.mode = 'investigate'; }
      if (!s.target || Math.hypot(s.target.x - s.x, s.target.z - s.z) < 0.7) {
        // Arrived: maybe pause for a scan (per-personality), then move on.
        if (s.target && Math.random() < T.pauseChance) s.idleUntil = now + T.pauseMs;
        const t = pts[Math.floor(Math.random() * pts.length)];
        s.target = {
          x: clamp(t[0] + (Math.random() * 3 - 1.5), bnd.minX, bnd.maxX),
          z: clamp(t[2] + (Math.random() * 3 - 1.5), bnd.minZ, bnd.maxZ),
        };
        s.mode = 'patrol';
      }
      tx = s.target.x; tz = s.target.z;
    }
    // ---- Move with the players' collision rules ----
    const dx = tx - s.x, dz = tz - s.z, d = Math.hypot(dx, dz);
    if (d > 0.06) {
      const spd = MOVE_SPEED * cs * 0.85 * T.speed;
      let nx = clamp(s.x + (dx / d) * spd * dt, bnd.minX, bnd.maxX);
      let nz = clamp(s.z + (dz / d) * spd * dt, bnd.minZ, bnd.maxZ);
      [nx, nz] = slideMove(s.x, s.z, nx, nz, (s.y || 0) + 0.25 * cs, 0.15 * cs, (s.y || 0) + 0.5 * cs);
      if (hasFloor(nx, nz, s.y)) { s.x = nx; s.z = nz; }
      s.ry = lerpAngle(s.ry, Math.atan2(dx, dz), Math.min(1, dt * 8));
      s.y = groundUnder(s.x, (s.y || 0) + 0.4, s.z);
    }
    // ---- Stuck? Re-target — this is what turns wall-humping into sweeping ----
    s.stuck.t += dt;
    if (Math.hypot(s.x - s.stuck.x, s.z - s.stuck.z) > 0.4) {
      s.stuck = { x: s.x, z: s.z, t: 0 };
    } else if (s.stuck.t > 1.4) {
      s.target = null; s.lastSeen = null; s.mode = 'patrol';
      s.stuck = { x: s.x, z: s.z, t: 0 };
    }
    // ---- Report to the server (~9 Hz per bot) ----
    if (now - s.sendAt > 110) {
      s.sendAt = now;
      socket.emit('botmove', { id: bb.id, x: s.x, y: s.y, z: s.z, ry: s.ry });
    }
  }
}

// ---- Camera anti-flimsiness (small rooms) ----------------------------------
// Two fixes for tight interiors:
//  1. smoothCamDist — the collision pull-in used to SNAP the camera frame to
//     frame off lumpy wall meshes; now it pulls in fast but eases back out,
//     so orbiting near a wall feels solid instead of jittery.
//  2. updateOccluderFade — whatever still sits between the camera and the
//     character (the wall the camera is pressed against, a cabinet you back
//     into) gets a small see-through window punched around the character,
//     so you can ALWAYS see yourself — without X-raying the rest of the map.
let _camLastT = 0;
function camFrameDt() {
  const now = performance.now();
  const dt = _camLastT ? Math.min(0.1, (now - _camLastT) / 1000) : 0.016;
  _camLastT = now;
  return dt;
}
const _camDistSm = { tp: null, ots: null };
function smoothCamDist(key, want, full, dt) {
  let cur = _camDistSm[key];
  if (cur == null || !isFinite(cur)) cur = want;
  const k = want < cur ? Math.min(1, dt * 16) : Math.min(1, dt * 5);  // in fast, out easy
  cur += (want - cur) * k;
  cur = Math.min(cur, full);
  _camDistSm[key] = cur;
  return cur;
}

// Occluder cutout: obstructing meshes do NOT go wholesale-transparent (in
// these GLBs one mesh can be half the building — fading it would X-ray the
// whole map and expose every hider). Instead the occluder's shader punches a
// small DITHERED CIRCULAR WINDOW around the character's screen position, and
// only for fragments CLOSER to the camera than the character. The rest of
// the mesh — and everyone hiding behind it elsewhere — stays fully solid.
const cutoutU = {
  center: { value: new THREE.Vector2(-1e4, -1e4) },  // gl_FragCoord pixels
  radius: { value: 0 },                              // pixels
  dist: { value: 0 },                                // view-space metres
};
function makeCutoutMaterial(m) {
  const c = m.clone();   // preserves trim clipping planes
  c.customProgramCacheKey = () => 'dg-cutout';
  c.onBeforeCompile = (shader) => {
    shader.uniforms.uCutC = cutoutU.center;
    shader.uniforms.uCutR = cutoutU.radius;
    shader.uniforms.uCutD = cutoutU.dist;
    // Own view-depth varying — vViewPosition isn't guaranteed to exist in
    // every material variant's fragment shader.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float dgViewZ;')
      .replace('#include <project_vertex>', '#include <project_vertex>\ndgViewZ = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float dgViewZ;\nuniform vec2 uCutC;\nuniform float uCutR;\nuniform float uCutD;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  {
    float dgD = distance(gl_FragCoord.xy, uCutC);
    if (dgD < uCutR && dgViewZ < uCutD) {
      float dgA = smoothstep(uCutR * 0.45, uCutR, dgD);        // 0 centre → 1 edge
      float dgR = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
      if (dgR > dgA * 0.85 + 0.06) discard;                    // screen-door dissolve
    }
  }`);
  };
  return c;
}
const fadedOccluders = new Set();
function setMeshFade(o, on) {
  if (on) {
    if (!o.userData._fadeMat) {
      o.userData._origMat = o.material;
      o.userData._fadeMat = Array.isArray(o.material)
        ? o.material.map(makeCutoutMaterial) : makeCutoutMaterial(o.material);
    }
    if (o.material !== o.userData._fadeMat) o.material = o.userData._fadeMat;
  } else if (o.userData._origMat && o.material !== o.userData._origMat) {
    o.material = o.userData._origMat;
  }
}
function updateOccluderFade(tx, ty, tz) {
  const seen = new Set();
  const camDist = camera.position.distanceTo(_v3.set(tx, ty, tz));
  if (collisionMeshes.length) {
    _ro.set(tx, ty, tz);
    _rd.set(camera.position.x - tx, camera.position.y - ty, camera.position.z - tz);
    const full = _rd.length() || 1; _rd.normalize();
    // Look a bit PAST the camera too: the wall the lens is pressed against
    // fills the screen even though its face is just behind the camera.
    _rc.set(_ro, _rd); _rc.far = full + 0.45;
    for (const h of _rc.intersectObjects(collisionMeshes, true)) seen.add(h.object);
  }
  // Aim the cutout window at the character: project the look target to
  // gl_FragCoord pixels, size the hole to roughly the character + a margin.
  if (seen.size || fadedOccluders.size) {
    const gl = renderer.getContext();
    _v3.set(tx, ty, tz).project(camera);
    cutoutU.center.value.set(
      (_v3.x * 0.5 + 0.5) * gl.drawingBufferWidth,
      (_v3.y * 0.5 + 0.5) * gl.drawingBufferHeight);
    const worldR = 0.9 * charScale();
    const px = (worldR / Math.max(0.3, camDist)) *
      (gl.drawingBufferHeight / (2 * Math.tan((camera.fov * Math.PI / 180) / 2)));
    cutoutU.radius.value = clamp(px, 48, gl.drawingBufferHeight * 0.3);
    cutoutU.dist.value = Math.max(0.05, camDist - 0.04);
  }
  for (const o of [...fadedOccluders]) {
    if (!seen.has(o)) { setMeshFade(o, false); fadedOccluders.delete(o); }
  }
  for (const o of seen) { setMeshFade(o, true); fadedOccluders.add(o); }
}
function clearOccluderFade() {
  for (const o of fadedOccluders) setMeshFade(o, false);
  fadedOccluders.clear();
}

function updateCamera() {
  if (window.__ov) { // debug: top-down overview (set window.__ov = height)
    camera.position.set(0.01, window.__ov, 0.01); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); return;
  }
  camera.up.set(0, 1, 0);   // restore after the debug top-down view
  const camDt = camFrameDt();
  // `s` scales the framing to the actor's size (hiders are small).
  const thirdPerson = (target, s = 1) => {
    cam.pitch = clamp(cam.pitch, TP.pitchMin, TP.pitchMax);
    const f = forwardXZ(cam.yaw);
    const dist = TP.dist; // a WORLD distance, so you can zoom right out to survey
    const horiz = dist * Math.cos(cam.pitch);
    let cx = target.x - f.x * horiz;
    let cz = target.z - f.z * horiz;
    // The camera never drops below the floor; instead, when you drag down past
    // level the look target rises so you look UP a little. The rise is CAPPED
    // relative to the camera distance — uncapped, a zoomed-out drag could tilt
    // the view past vertical, where lookAt's up-vector flips everything
    // upside down.
    const cyMin = (target.y || 0) + 0.12;
    const cyWant = (target.y || 0) + 1.2 * s + dist * Math.sin(cam.pitch);
    let cy = Math.max(cyMin, cyWant);
    const lift = Math.min(Math.max(0, cyMin - cyWant), dist * 0.55);
    let lookY = (target.y || 0) + 1.0 * s + lift;
    // Paint mode: aim below the body so it rides high on screen, clear of the
    // paint strip along the bottom.
    if (sheetOpen === 'paint') lookY -= 0.85 * s;
    // Pull the camera in when geometry blocks the view — SMOOTHED (snap in,
    // ease back out) so lumpy walls in small rooms don't make it jitter.
    if (collisionMeshes.length) {
      _ro.set(target.x, lookY, target.z);
      _rd.set(cx - target.x, cy - lookY, cz - target.z);
      const full = _rd.length() || 1; _rd.normalize();
      _rc.set(_ro, _rd); _rc.far = full;
      const h = _rc.intersectObjects(collisionMeshes, true)[0];
      const want = (h && h.distance < full) ? Math.max(0.12, h.distance - 0.1) : full;
      const d = smoothCamDist('tp', want, full, camDt);
      cx = target.x + _rd.x * d; cy = lookY + _rd.y * d; cz = target.z + _rd.z * d;
    } else {
      [cx, cz] = resolveCollision(cx, cz, 0.2);
    }
    camera.position.set(cx, cy, cz);
    camera.lookAt(target.x, lookY, target.z);
    // Whatever still intrudes (the wall the camera is pressed against in a
    // tight room) fades out so the character is NEVER hidden by it.
    updateOccluderFade(target.x, lookY, target.z);
  };
  const firstPerson = (pos, eyeH) => {
    cam.pitch = clamp(cam.pitch, FP.pitchMin, FP.pitchMax);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const lx = Math.sin(cam.yaw) * cp, lz = Math.cos(cam.yaw) * cp;
    const eye = (pos.y || 0) + (eyeH || FP.eye);
    camera.position.set(pos.x, eye, pos.z);
    camera.lookAt(pos.x + lx, eye + sp, pos.z + lz);
    clearOccluderFade();
  };

  // Over-the-shoulder shooter camera: pivot at the hunter's right shoulder,
  // fixed distance (no zooming out to survey rooms), crosshair clear of the
  // body. Peeking drops the pivot to floor level to see under furniture.
  const overShoulder = (p) => {
    cam.pitch = clamp(cam.pitch, -0.55, 0.85);
    const f = forwardXZ(cam.yaw);
    const rx = -f.z, rz = f.x;                       // camera-right
    const cs = charScale();                          // framing follows the hunter's size
    // Crouching leans the body toward the lens — offset wider + further back
    // so the low camera looks PAST the hunter instead of into its back.
    const side = (seekerPeek ? 0.45 : 0.25) * cs;
    const dist = (seekerPeek ? 1.2 : 0.95) * cs;
    const pivotY = (p.y || 0) + (seekerPeek ? 0.24 : 0.65) * cs;
    const px = p.x + rx * side, pz = p.z + rz * side;
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    // View direction (pitch+ looks down), camera sits behind the pivot.
    const vx = f.x * cp, vy = -sp, vz = f.z * cp;
    let cx = px - vx * dist, cy = Math.max(pivotY - vy * dist, (p.y || 0) + 0.15), cz = pz - vz * dist;
    if (collisionMeshes.length) {                    // never bury in a wall
      _ro.set(px, pivotY, pz);
      _rd.set(cx - px, cy - pivotY, cz - pz);
      const full = _rd.length() || 1; _rd.normalize();
      _rc.set(_ro, _rd); _rc.far = full;
      const h = _rc.intersectObjects(collisionMeshes, true)[0];
      const want = (h && h.distance < full) ? Math.max(0.15, h.distance - 0.1) : full;
      const d = smoothCamDist('ots', want, full, camDt);
      cx = px + _rd.x * d; cy = pivotY + _rd.y * d; cz = pz + _rd.z * d;
    }
    camera.position.set(cx, cy, cz);
    camera.lookAt(px + vx * 8, pivotY + vy * 8, pz + vz * 8);
    updateOccluderFade(px, pivotY, pz);   // never let a close wall hide the hunter
  };

  // Round-end reveal: a guided tour. Brief zoomed-out overview, then the
  // camera flies from hiding spot to hiding spot — in the order a seeker
  // would sweep them — pausing close-up at each so everyone sees HOW each
  // hider was tucked in. Ends back on the slow overview orbit.
  if (snap && snap.phase === 'roundover') {
    camera.up.set(0, 1, 0);
    clearOccluderFade();   // the reveal tour should see solid walls
    revealCamera();
    return;
  }

  if (hiderControls() || iSpectate()) thirdPerson(myBody, HIDER_SCALE * charScale() * 2);
  else if (snap.phase === 'hunt' && snap.myRole === 'seeker' && seekerPos) overShoulder(seekerPos);
  else {
    const mine = snap.bodies && snap.bodies.find((b) => b.mine);
    if (mine) thirdPerson(mine, HIDER_SCALE * charScale() * 2);
    else firstPerson(seekerPos || { x: 0, z: -8 });
  }
}

// Procedural walk cycle for the local hider. Works in EVERY pose: while
// travelling the figure stands up and walks (you can't stay curled in a ball
// mid-stride), then settles back into the chosen pose the moment it stops.
let walkPhase = 0;
function updateWalk(dt) {
  if (!myChar || !hiderControls() || climbing) return;
  const j = myChar.userData.joints;
  const moving = Math.abs(joyVec.x) > 0.05 || Math.abs(joyVec.y) > 0.05;
  if (moving) {
    if (!myChar.userData.walking) { setPose(myChar, 'standing'); myChar.userData.walking = true; }
    walkPhase += dt * 11;
    const a = Math.sin(walkPhase) * 0.5;
    j.legL.rotation.x = a; j.legR.rotation.x = -a;
    j.armL.rotation.x = -a * 0.8; j.armR.rotation.x = a * 0.8;
  } else if (myChar.userData.walking || walkPhase !== 0) {
    walkPhase = 0;
    myChar.userData.walking = false;
    setPose(myChar, myBody.pose); // settle back into the chosen pose
  }
}

let _jumpVis = null, _climbVis = null, _whisVis = null, _zoomVis = null, _fireVis = null;
function updateActionButtons() {
  const canMove = hiderControls();
  const seekerHunt = snap && snap.phase === 'hunt' && snap.myRole === 'seeker';
  const jv = canMove || seekerHunt;
  const cv = canMove && (nearSurface || climbing);
  const wmode = (snap.settings && snap.settings.whistle) || 'auto';
  const wv = canMove && snap.phase === 'hunt' && wmode !== 'off';
  const zv = canZoom();
  if (jv !== _jumpVis) { _jumpVis = jv; $('jumpBtn').classList.toggle('hidden', !jv); }
  if (cv !== _climbVis) { _climbVis = cv; $('clingBtn').classList.toggle('hidden', !cv); }
  if (zv !== _zoomVis) { _zoomVis = zv; $('zoomCtrls').classList.toggle('hidden', !zv); }
  if (wv !== _whisVis) {
    _whisVis = wv;
    $('whistleBtn').classList.toggle('hidden', !wv);
    // The countdown meter only means something with the AUTO whistle.
    $('whistleMeter').classList.toggle('hidden', !(wv && wmode === 'auto'));
  }
  if (seekerHunt !== _fireVis) {
    _fireVis = seekerHunt;
    $('fireBtn').classList.toggle('hidden', !seekerHunt);
    $('fireBtnL').classList.toggle('hidden', !seekerHunt);
    $('peekBtn').classList.toggle('hidden', !seekerHunt);
    if (!seekerHunt && seekerPeek) { seekerPeek = false; $('peekBtn').classList.remove('on'); }
  }
  $('clingBtn').classList.toggle('on', climbing);
  $('clingBtn').querySelector('.lbl').textContent = climbing ? 'Drop' : 'Wall';
  // Reload feedback: the crosshair turns red and a radial sweep drains off
  // BOTH Fire buttons while the paint gun reloads.
  if (seekerHunt) {
    const since = Date.now() - lastShotAt;
    const reloading = since < RELOAD_MS;
    $('crosshair').classList.toggle('reloading', reloading);
    const sweep = reloading
      ? `conic-gradient(transparent ${(since / RELOAD_MS) * 360}deg, rgba(30,30,40,.55) 0)`
      : 'none';
    $('fireCd').style.background = sweep;
    $('fireCdL').style.background = sweep;
    const txt = reloading ? `${Math.ceil((RELOAD_MS - since) / 1000)}s…` : 'Fire';
    for (const btn of [$('fireBtn'), $('fireBtnL')]) {
      const lbl = btn.querySelector('.lbl');
      if (lbl.textContent !== txt) lbl.textContent = txt;
    }
  }
}

let frameCount = 0;
function tick(dt, render) {
  frameCount++;
  if (joyId === null) joyVec = keyboardVec(); // keyboard drives movement when the stick is idle
  applyMovement(dt);
  updateBotSeekers(dt);   // host drives bot seekers (also in background ticks)
  if (!render) return;
  updateWalk(dt);
  const t = clock.elapsedTime;
  updateRemoteAnims(dt, t);
  updateProjectiles(dt);
  for (const [, g] of beacons) {          // [pillar, label] group per hider
    const pillar = g.children[0];
    if (pillar && pillar.material) { pillar.rotation.y += dt * 2; pillar.material.opacity = 0.4 + 0.25 * Math.sin(t * 5); }
  }
  updateWhistleCues();
  updateActionButtons();
  updateCamera();
  renderer.render(scene, camera);
}
function animate() {
  requestAnimationFrame(animate);
  if (!threeReady || !snap || snap.phase === 'lobby') return;
  tick(Math.min(clock.getDelta(), 0.05), true);
}
// Backgrounded tabs suspend requestAnimationFrame; keep the SIMULATION alive
// (movement, gravity, network sends) at 30 Hz so the round doesn't freeze —
// rendering stays paused.
setInterval(() => {
  if (!document.hidden) return;
  if (!threeReady || !snap || snap.phase === 'lobby') return;
  tick(Math.min(clock.getDelta(), 0.05), false);
}, 33);

// Start climbing: lock onto the detected surface, snap flush against it FACING
// the wall (eyes pressed to it, painted back to the room) — the picture-frame
// hide, where your body reads as decoration hung on the wall.
function startClimb() {
  if (!nearSurface || !myBody) return;
  climbDir.x = surfaceDir.x; climbDir.z = surfaceDir.z;
  _ro.set(myBody.x, (myBody.y || 0) + 0.12, myBody.z); _rd.set(climbDir.x, 0, climbDir.z).normalize();
  _rc.set(_ro, _rd); _rc.far = CLING_RANGE;
  const h = _rc.intersectObjects(collisionMeshes, true).find((x) => !x.object.userData.noCling);
  if (!h) return;
  // Sanity-check the snap: never let a cling place you outside the play
  // bounds or over the void (that hid players where seekers can't go).
  const bx = h.point.x - climbDir.x * CLING_GAP;
  const bz = h.point.z - climbDir.z * CLING_GAP;
  const bnd = bounds();
  if (bx < bnd.minX || bx > bnd.maxX || bz < bnd.minZ || bz > bnd.maxZ) return;
  if (!hasFloor(bx, bz, myBody.y)) return;
  climbing = true; climbMiss = 0;
  myBody.x = bx; myBody.z = bz;
  myBody.ry = Math.atan2(climbDir.x, climbDir.z);  // face INTO the wall (eyes to the wall)
  // Any pose can attach — 'climb' (the picture-frame spread) is just the
  // default when you cling while standing. Pick Ball first, cling second,
  // and you hang there curled up.
  if (!myBody.pose || myBody.pose === 'standing') myBody.pose = 'climb';
  syncPoseButtons();
  SFX.click();
  sendMove(true);
}
$('jumpBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); jumpAskedAt = performance.now(); });
$('clingBtn').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (climbing) { stopClimb(); sendMove(true); } else startClimb();
});
$('whistleBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); sendWhistle(); });

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
  // Deadzone + squared response: small deflections barely creep, so precise
  // positioning doesn't send you flying (the stick felt hair-trigger before).
  const raw = Math.min(1, Math.hypot(dx, dy) / max);
  const DEAD = 0.14;
  const t = raw < DEAD ? 0 : (raw - DEAD) / (1 - DEAD);
  const mag = t * t;
  if (mag === 0 || raw === 0) { joyVec = { x: 0, y: 0 }; return; }
  joyVec = { x: (dx / max / raw) * mag, y: (-dy / max / raw) * mag };
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
// WASD / arrows move (camera-relative), Space jumps, E climbs, B/F blends;
// mouse drag looks, click acts, wheel zooms.
const keyState = {};
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (document.getElementById('screen-game') && !document.getElementById('screen-game').classList.contains('active')) return;
  keyState[k] = true;
  if (k === ' ') { jumpAskedAt = performance.now(); e.preventDefault(); }
  if (k === 'e') { if (climbing) { stopClimb(); sendMove(true); } else startClimb(); }
  if (k === '1' || k === 'q') sendWhistle();
  if (k === 'x') seekerShoot();       // fire at the crosshair (desktop)
  if (k === 'c') togglePeek();        // crouch to check under furniture (desktop)
  if (k === 'f') { if (hiderControls()) openSheet(sheetOpen === 'paint' ? null : 'paint'); } // paint mode, like the original
  if (k === 'r') { if (hiderControls()) openSheet(sheetOpen === 'pose' ? null : 'pose'); }
  if (k === '=' || k === '+') applyZoom(-0.35);
  if (k === '-' || k === '_') applyZoom(0.35);
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
// Zoom the third-person camera in/out (paint detail up close, survey from
// afar): mouse wheel, pinch, +/- keys, or the on-screen buttons.
// Zoom is a third-person affordance; the FPS seeker has no camera distance.
function canZoom() { return hiderControls() || iSpectate(); }
function applyZoom(delta) {
  const z = (snap && snap.phase === 'hunt' && snap.myRole === 'seeker') ? ZOOM_SEEKER : ZOOM_HIDER;
  const cs = charScale();
  TP.dist = clamp(TP.dist + delta * cs, z.min * cs, z.max * cs);
}
$('stage').addEventListener('wheel', (e) => {
  if (canZoom()) { applyZoom(e.deltaY * 0.004); e.preventDefault(); }
}, { passive: false });
// Hold-to-zoom buttons (mobile-friendly).
function bindZoomBtn(id, dir) {
  let iv = null;
  const stop = () => { clearInterval(iv); iv = null; };
  $(id).addEventListener('pointerdown', (e) => {
    e.preventDefault();
    applyZoom(dir * 0.35);
    iv = setInterval(() => applyZoom(dir * 0.22), 90);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $(id).addEventListener(ev, stop);
}
bindZoomBtn('zoomInBtn', -1);
bindZoomBtn('zoomOutBtn', 1);

// ---- Input: paint / look-drag / tap -------------------------------------
// While a hider preps: dragging on your chameleon paints it; dragging on empty
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
  if (hiderControls()) {
    pushUndo();                                  // snapshot in case this becomes a stroke
    if (paintRaycast(e.clientX, e.clientY)) painting = true;
    else undoStack.pop();                        // it didn't — drop the snapshot
  }
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
  // Standard mobile-FPS mapping (à la CoD/PUBG Mobile): the swipe IS the look
  // direction — swipe right → look right, swipe up → look up — and the look
  // thumb works WHILE the move thumb steers (independent thumbs).
  const dx = e.movementX || 0, dy = e.movementY || 0;
  moved += Math.abs(dx) + Math.abs(dy);
  // Response curve (standard in mobile shooters): small drags stay ~linear
  // for precise aiming, fast flicks accelerate up to ~1.6× so a big swipe
  // whips the camera around without cranking base sensitivity.
  const curve = (v) => v * (1 + Math.min(1.2, Math.abs(v) / 36) * 0.5);
  const fpsSeeker = snap && snap.phase === 'hunt' && snap.myRole === 'seeker';
  cam.yaw -= curve(dx) * LOOK_SENS * lookSensMul;                    // swipe left = look left
  if (fpsSeeker) cam.pitch += curve(dy) * LOOK_SENS_V * lookSensMul; // aim: swipe up = look up
  else cam.pitch -= curve(dy) * LOOK_SENS_V * lookSensMul;           // orbit: drag down = orbit up
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
    if (color) { setBrushColor(color); rememberColor(color); SFX.click(); pickFeedback(clientX, clientY, color); }
  }
  // Seekers do NOT shoot on tap — taps/drags are camera-only. The gun always
  // points at the crosshair and fires from the Fire button (shooter-style),
  // so adjusting the view can never waste a paint charge.
}

// Seeker fires a paint blast at the CROSSHAIR (screen centre). 1s reload.
// The blast (and any catch) is resolved + broadcast by the server, so the
// splat shows for everyone via the 'blast' event.
const SHOOT_COLORS = ['#ff3bd0', '#ffd23b', '#3bd1ff', '#7CFC00', '#ff6b3b', '#b14bff'];
const RELOAD_MS = 3000;   // shots are free — missing just costs this wait
let lastShotAt = 0;
function seekerShoot() {
  if (!snap || snap.phase !== 'hunt' || snap.myRole !== 'seeker') return;
  const now = Date.now();
  if (now - lastShotAt < RELOAD_MS) return; // reloading
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);  // dead centre
  const targets = [];
  if (roomGroup) targets.push(roomGroup);
  for (const g of charGroups.values()) targets.push(g);
  const hit = raycaster.intersectObjects(targets, true)[0];
  const p = hit ? hit.point : raycaster.ray.at(25, new THREE.Vector3());
  lastShotAt = now;
  const color = SHOOT_COLORS[Math.floor(Math.random() * SHOOT_COLORS.length)];
  socket.emit('shoot', { x: p.x, y: p.y, z: p.z, color });
  // Local feedback: muzzle sound + a paintball flying from the gun barrel.
  SFX.shoot();
  buzz(20);                       // tactile shot feedback (Android)
  const muzzle = paintGun
    ? paintGun.getWorldPosition(new THREE.Vector3())
    : camera.position.clone().addScaledVector(_rd.set(0, -0.2, 0), 1);
  spawnProjectile(muzzle, p, color);
  // A tiny recoil kick on the gun sells the shot.
  if (paintGun) {
    paintGun.position.z = -0.18;
    setTimeout(() => { if (paintGun) paintGun.position.z = -0.28; }, 90);
  }
}
$('fireBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); seekerShoot(); });
$('fireBtnL').addEventListener('pointerdown', (e) => { e.preventDefault(); seekerShoot(); });

// Crouch: the seeker drops low to check UNDER furniture — camera sinks to
// floor level, the body kneels and leans forward as if scanning the ground
// (the lean itself is animated per-frame in updateRemoteAnims). Toggle.
let seekerPeek = false;
function togglePeek() {
  if (!snap || snap.phase !== 'hunt' || snap.myRole !== 'seeker') return;
  seekerPeek = !seekerPeek;
  $('peekBtn').classList.toggle('on', seekerPeek);
  if (seekerChar) {
    setPose(seekerChar, seekerPeek ? 'kneel' : 'standing');
    seekerChar.userData.pose = seekerPeek ? 'kneel' : 'standing';
  }
  SFX.click();
}
$('peekBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); togglePeek(); });

// ---- Paintball projectiles + splats --------------------------------------
const projectiles = [];
function spawnProjectile(from, to, color) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 10, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color) }));
  m.position.copy(from);
  scene.add(m);
  projectiles.push({ m, from: from.clone(), to: to.clone(), t: 0, color });
}
function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    pr.t += dt * 6.5;   // ~150ms flight
    if (pr.t >= 1) {
      scene.remove(pr.m); pr.m.geometry.dispose(); pr.m.material.dispose();
      projectiles.splice(i, 1);
      paintSplat(pr.to.x, pr.to.y, pr.to.z, pr.color);
      continue;
    }
    pr.m.position.lerpVectors(pr.from, pr.to, pr.t);
    // slight arc
    pr.m.position.y += Math.sin(pr.t * Math.PI) * 0.15;
  }
}

// A paint splat at a world point — a burst that fades, plus a blob of paint
// that STAYS for the rest of the round (the room slowly fills with evidence
// of the seeker's misses).
const splatDecals = [];
function paintSplat(x, y, z, color) {
  if (!scene) return;
  SFX.splat();
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
  // Skip the persistent blob if it landed basically in the shooter's face —
  // a wall of paint over the camera blinds the player.
  if (camera && camera.position.distanceTo(new THREE.Vector3(x, y, z)) < 1.6) return;
  const d = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 10, 8),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.5 }));
  d.scale.y = 0.22;                    // a squashed blob of dried paint
  d.position.set(x, y, z);
  scene.add(d); splatDecals.push(d);
}
function clearSplats() {
  for (const d of splatDecals) { scene.remove(d); d.geometry.dispose(); d.material.dispose(); }
  splatDecals.length = 0;
}

// Read the EXACT pixel the player sees under the tap, as a "#rrggbb" string.
// We re-render to the canvas and read the drawing buffer in the same task —
// an off-screen render target would skip three.js's linear→sRGB output
// conversion, so the sampled colour came back darker than the screen showed
// (the old "eyedropper doesn't match" bug).
function sampleScreenColor(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const gl = renderer.getContext();
  renderer.render(scene, camera);          // fresh frame in the drawing buffer
  const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
  const px = Math.min(bw - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * bw)));
  const py = Math.min(bh - 1, Math.max(0, Math.floor((1 - (clientY - r.top) / r.height) * bh)));
  const buf = new Uint8Array(4);
  gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const hex = (n) => n.toString(16).padStart(2, '0');
  return '#' + hex(buf[0]) + hex(buf[1]) + hex(buf[2]);
}

// Eyedropper feedback: an expanding ring at the tap plus a colour droplet
// that flies into the brush swatch — so "tap the room = steal its colour"
// is obvious even to first-timers.
function pickFeedback(x, y, color) {
  const ring = document.createElement('div');
  ring.className = 'pick-ring';
  ring.style.left = x + 'px'; ring.style.top = y + 'px';
  ring.style.borderColor = color;
  document.body.appendChild(ring);
  setTimeout(() => ring.remove(), 700);

  const drop = document.createElement('div');
  drop.className = 'pick-drop';
  drop.style.background = color;
  drop.style.left = x + 'px'; drop.style.top = y + 'px';
  document.body.appendChild(drop);
  // Fly to the brush colour swatch (or the Paint toggle when the panel is
  // closed) so the player sees WHERE the colour went.
  const targetEl = sheetOpen === 'paint' ? $('colorInput') : $('paintToggle');
  const tr = targetEl.getBoundingClientRect();
  requestAnimationFrame(() => {
    drop.style.transform =
      `translate(${tr.left + tr.width / 2 - x}px, ${tr.top + tr.height / 2 - y}px) scale(.35)`;
    drop.style.opacity = '0.15';
  });
  setTimeout(() => drop.remove(), 650);
  toast(`🎨 Colour copied!`, 800);
}

// ---- Painting tools -----------------------------------------------------
function setBrushColor(color) {
  brushColor = color;
  $('colorInput').value = color;
  document.querySelectorAll('#palette .swatch, #recentColors .swatch').forEach((s) =>
    s.classList.toggle('active', s.dataset.c === color));
}

// Eyedropped colours are remembered as quick swatches (the original's saved
// palette) — sample the wall once, keep repainting with it all round.
const recentColors = [];
function rememberColor(color) {
  const i = recentColors.indexOf(color);
  if (i !== -1) recentColors.splice(i, 1);
  recentColors.unshift(color);
  if (recentColors.length > 4) recentColors.pop();
  const wrap = $('recentColors'); wrap.innerHTML = '';
  for (const c of recentColors) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === brushColor ? ' active' : '');
    b.style.background = c; b.dataset.c = c;
    b.addEventListener('click', () => { setBrushColor(c); SFX.click(); });
    wrap.appendChild(b);
  }
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
// Paint / Pose tool strips (mobile-friendly: one open at a time). Opening the
// paint strip is a proper "paint mode" — the camera glides in close to your
// body so you can brush it comfortably (like the real game's paint mode),
// and glides back out when you close it.
let sheetOpen = null, prePaintDist = null;
function openSheet(which) {
  const wasPaint = sheetOpen === 'paint';
  sheetOpen = which;
  $('paintPanel').classList.toggle('hidden', which !== 'paint');
  $('paintHint').classList.toggle('hidden', which !== 'paint');
  $('posePanel').classList.toggle('hidden', which !== 'pose');
  $('paintToggle').classList.toggle('open', which === 'paint');
  $('poseToggle').classList.toggle('open', which === 'pose');
  document.body.classList.toggle('paint-mode', which === 'paint');
  if (which === 'paint' && !wasPaint && canZoom()) {
    prePaintDist = TP.dist;
    TP.dist = 0.75 * charScale();   // zoom in on your own body…
    cam.pitch = 0.25;               // …and level out so you see it side-on
  } else if (wasPaint && which !== 'paint' && prePaintDist != null) {
    TP.dist = prePaintDist;         // back out to the hiding view
    prePaintDist = null;
  }
}
$('paintToggle').addEventListener('click', () => { openSheet(sheetOpen === 'paint' ? null : 'paint'); SFX.click(); });
$('poseToggle').addEventListener('click', () => { openSheet(sheetOpen === 'pose' ? null : 'pose'); SFX.click(); });

document.querySelectorAll('#paintPanel .brush').forEach((b) =>
  b.addEventListener('click', () => {
    brushSize = b.dataset.size;
    document.querySelectorAll('#paintPanel .brush').forEach((x) => x.classList.toggle('active', x === b));
    SFX.click();
  }));
document.querySelectorAll('#posePanel .pose').forEach((b) =>
  b.addEventListener('click', () => {
    if (!myBody) return;
    if (climbing) stopClimb();
    myBody.pose = b.dataset.pose;
    syncPoseButtons();
    ensureMyChar(myBody); sendMove(true);
    SFX.click();
    openSheet(null);            // picked — get the panel out of the way
  }));
$('colorInput').addEventListener('input', (e) => setBrushColor(e.target.value));
$('fillAllBtn').addEventListener('click', fillAll);
$('undoBtn').addEventListener('click', undoPaint);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { undoPaint(); e.preventDefault(); }
});

// Colour palette: quick-pick swatches.
const PALETTE = ['#ffffff', '#111111', '#e23b3b', '#f59e0b', '#ffe14d', '#3bd16a',
  '#27a3c4', '#3b5ec0', '#9b51e0', '#e36bd0', '#7a5b46', '#c9b48f'];
(function buildPalette() {
  const wrap = $('palette'); if (!wrap) return;
  PALETTE.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = c; b.dataset.c = c;
    b.addEventListener('click', () => { setBrushColor(c); SFX.click(); });
    wrap.appendChild(b);
  });
})();

// A quick colour splash at the screen point you painted (visual feedback).
let lastSplash = 0;
function paintSplash(clientX, clientY) {
  const now = Date.now(); if (now - lastSplash < 90) return; lastSplash = now;
  const f = document.createElement('div'); f.className = 'splash';
  f.style.left = clientX + 'px'; f.style.top = clientY + 'px';
  f.style.background = brushColor;
  $('emoteFloat').appendChild(f); setTimeout(() => f.remove(), 450);
}

// ---- Emotes (collapsed behind one toggle so they never block the view) ---
let emotesOpen = false;
function setEmotesOpen(open) {
  emotesOpen = open;
  $('emoteBar').classList.toggle('hidden', !open);
  $('emoteToggle').classList.toggle('open', open);
}
$('emoteToggle').addEventListener('click', () => { setEmotesOpen(!emotesOpen); SFX.click(); });
document.querySelectorAll('.emote').forEach((b) =>
  b.addEventListener('click', () => {
    socket.emit('emote', { emoji: b.dataset.emoji });
    setEmotesOpen(false);            // picked — tuck the row away again
  }));
function flyEmote(emoji) {
  const f = document.createElement('div'); f.className = 'fly'; f.textContent = emoji;
  f.style.left = 20 + Math.random() * 60 + '%'; f.style.top = 55 + Math.random() * 20 + '%';
  $('emoteFloat').appendChild(f); setTimeout(() => f.remove(), 1700);
}

// ---- Banner (role reveal / phase changes) ---------------------------------
let bannerTimer = null;
function showBanner(emoji, title, text, cls = '', ms = 2400) {
  const el = $('banner');
  clearTimeout(bannerTimer);
  el.className = 'banner ' + cls;
  $('bannerEmoji').textContent = emoji;
  $('bannerTitle').textContent = title;
  $('bannerText').textContent = text;
  SFX.banner();
  bannerTimer = setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.classList.add('hidden'), 300);
  }, ms);
}

function confetti(n = 60) {
  const colors = ['#ff8a00', '#58c443', '#29b6f6', '#ffcf3f', '#ff5252', '#b14bff'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + '%';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = (1.6 + Math.random() * 1.6) + 's';
    c.style.animationDelay = (Math.random() * 0.6) + 's';
    $('screen-game').appendChild(c);
    setTimeout(() => c.remove(), 4000);
  }
}

// ---- Per-snapshot game UI ----------------------------------------------
let lastPhaseKey = '';
function renderGame() {
  initThree();
  buildScene(snap.mapId);
  resize();

  const phase = snap.phase, role = snap.myRole || '';
  // Snapshots stream in ~10×/s during the hunt — only touch the DOM when the
  // rendered value actually changed (innerHTML churn was a big lag source).
  const setText = (id, v) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };
  const setHTML = (id, v) => { const el = $(id); if (el._h !== v) { el._h = v; el.innerHTML = v; } };
  const phaseName = phase === 'prep' ? 'HIDE' : phase === 'hunt' ? 'SEEK' : phase.toUpperCase();
  setText('phaseLabel', phaseName);
  const rl = $('roleLabel');
  const roleTxt = role ? role.toUpperCase() : '';
  if (rl.textContent !== roleTxt) rl.textContent = roleTxt;
  const roleCls = 'pill role ' + role;
  if (rl.className !== roleCls) rl.className = roleCls;
  setText('remainLabel', (phase === 'hunt' || phase === 'roundover')
    ? `${snap.remaining}/${snap.totalHiders} hidden` : `R${snap.round}/${snap.totalRounds}`);

  // Alive/caught hiders shown as chameleon icons for everyone.
  const hiders = snap.players.filter((p) => p.role === 'hider');
  setHTML('aliveBar', hiders.map((p) => lizardIcon(p.found)).join(''));
  $('aliveBar').classList.toggle('hidden', hiders.length === 0);

  // Init local actors per round. The hider keeps one local body across prep AND
  // hunt (so painting + position carry over into the chase).
  if (role === 'hider' && (phase === 'prep' || phase === 'hunt') && snap.myBody && myBodyRound !== snap.round) {
    myBody = { x: snap.myBody.x, y: snap.myBody.y, z: snap.myBody.z, ry: snap.myBody.ry,
               pose: snap.myBody.pose || 'standing', paint: snap.myBody.paint || null };
    myBodyRound = snap.round;
    cam.yaw = (snap.myBody.ry || 0); cam.pitch = 0.35; TP.dist = 1.1 * charScale(); // reset zoom
    climbing = false;
    myWhistleDeadline = 0;
    removeMyChar();                 // fresh mannequin (or restored paint)
    $('colorInput').value = brushColor;
    syncPoseButtons();
    clearSplats();                  // last round's paint splats vanish
    undoStack.length = 0;
    // Never start wedged inside furniture/walls: shift to the nearest clear spot.
    // (Scene GLBs may still be loading; retry a few times as colliders appear.)
    const fix = (tries) => {
      if (!myBody || myBodyRound !== snap.round) return;
      const [cx, cz] = findClearSpawn(myBody.x, myBody.z);
      myBody.x = cx; myBody.z = cz;
      myBody.y = surfaceTop(cx, cz) + 0.02;   // sloped maps: start ON the terrain
      if (tries > 0) setTimeout(() => fix(tries - 1), 700);
    };
    fix(4);
  }
  if (phase === 'hunt' && role === 'seeker' && seekerRound !== snap.round) {
    const sb = snap.myBody || { x: 0, z: 0 };  // server-assigned spawn (different room from hiders)
    const [sx2, sz2] = findClearSpawn(sb.x, sb.z, 0.5);
    seekerPos = { x: sx2, y: Math.max(sb.y || 0, surfaceTop(sx2, sz2) + 0.02), z: sz2, ry: sb.ry || 0, vy: 0 };
    cam.yaw = sb.ry || 0; cam.pitch = 0.35;
    TP.dist = SEEKER_CAM_DIST;                 // third person behind the big hunter
    seekerRound = snap.round;
  }

  // Phase-change banners (once per phase per round).
  const key = `${snap.round}:${phase}:${role}`;
  if (key !== lastPhaseKey) {
    lastPhaseKey = key;
    if (phase === 'prep') {
      window.__ov = 0;   // a leftover debug overview must never hijack a round
      if (role === 'hider') showBanner('🦎', 'YOU HIDE!', 'Pick a spot, strike a pose, paint yourself into it!', 'hider');
      else showBanner('🔍', 'YOU SEEK!', 'The chameleons are painting up… get ready!', 'seeker');
    } else if (phase === 'hunt') {
      // Host duty: the server placed bot hiders blind (it has no geometry),
      // so nudge any bot that ended up inside furniture to clear floor.
      if (snap.hostId === myId) setTimeout(fixBotHidingSpots, 400);
      if (role === 'seeker') showBanner('🔫', 'GO SEEK!', 'Shoot to catch — reloading takes a moment, so aim well!', 'seeker');
      else {
        const wm = (snap.settings && snap.settings.whistle) || 'auto';
        const hint = wm === 'manual' ? 'No auto-whistle — a brave manual whistle earns +30!'
          : wm === 'off' ? 'Silent mode — stay painted and stay still!'
          : 'Stay painted! A brave manual whistle earns +10 points.';
        showBanner('🙈', 'HOLD STILL!', hint, 'hider');
      }
      // The countdown only runs in AUTO mode (manual/off never auto-betray).
      if (role === 'hider' && ((snap.settings && snap.settings.whistle) || 'auto') === 'auto') {
        myWhistleDeadline = Date.now() + WHISTLE_EVERY_MS;
      }
    } else if (phase === 'roundover') {
      // The signature reveal: overview first, then a guided close-up tour of
      // every hiding spot (see buildRevealTour), then the scoreboard.
      showBanner('🎉', 'REVEALED!', 'Look where everyone was hiding…', '', 2600);
      mapPeek = false;
      _revInit = false; _revLastT = performance.now();
      revealTour = buildRevealTour();
      revealUntil = Date.now() + revealTour.total + 600;
      setTimeout(() => { if (snap && snap.phase === 'roundover') renderGame(); }, revealTour.total + 700);
    }
  }

  // Scene occupants. The controlling hider draws itself via myChar (smooth,
  // local); the seeker draws itself via seekerChar; everyone else (and a
  // caught/spectating self) comes from syncHunt.
  if (hiderControls()) ensureMyChar(myBody);
  else removeMyChar();
  if (!(phase === 'hunt' && role === 'seeker')) removeSeekerChar();
  if (phase === 'hunt' || phase === 'roundover') syncHunt(snap.bodies || [], hiderControls());
  else clearChars();

  // Reveal beacons: at round end, a labelled pillar marks EVERY hider's spot
  // (gold = survived, red = caught) for the zoomed-out fly-over.
  syncBeacons(phase === 'roundover' ? (snap.bodies || []).filter((b) => !b.seeker) : []);

  // Controls visibility
  const canMove = hiderControls();           // hider, prep or hunt, not caught
  const spectating = iSpectate();
  const isSeekerHunt = phase === 'hunt' && role === 'seeker';
  $('hiderTools').classList.toggle('hidden', !canMove); // paint during prep AND the hunt
  if (!canMove && sheetOpen) openSheet(null);
  $('seekerTools').classList.toggle('hidden', !isSeekerHunt);
  $('joystick').classList.toggle('hidden', !(canMove || isSeekerHunt || spectating));
  $('crosshair').classList.toggle('hidden', !isSeekerHunt);
  $('emoteToggle').classList.toggle('hidden', phase !== 'hunt');
  if (phase !== 'hunt' && emotesOpen) setEmotesOpen(false);

  // Spectator minimap (you can roam + see everyone once caught).
  $('minimap').classList.toggle('hidden', !snap.spectating);
  if (snap.spectating) drawMinimap();

  // Overlays
  const wait = $('waitOverlay');
  if (phase === 'prep' && role === 'seeker') {
    wait.classList.remove('hidden');
    $('waitEmoji').textContent = '⏳';
    $('waitTitle').textContent = 'Chameleons are hiding…';
    $('waitText').textContent = 'Memorise the rooms. The hunt is coming.';
  } else { wait.classList.add('hidden'); }

  // Hold the scoreboard back while the fly-over plays, and let players tuck
  // it away ("view map") to keep studying the hiding spots before readying up.
  const showScores = phase === 'roundover' && Date.now() >= revealUntil && !mapPeek;
  $('scoreOverlay').classList.toggle('hidden', !showScores);
  $('showScoresBtn').classList.toggle('hidden', !(phase === 'roundover' && mapPeek));
  if (showScores) renderScores();
  // The big timer means nothing while waiting for everyone to press Next.
  $('timer').classList.toggle('hidden', phase === 'roundover');
}
let revealUntil = 0;
let mapPeek = false;

// ---- Round-end reveal tour ------------------------------------------------
// Visit every hider close-up, in the greedy nearest-neighbour order a seeker
// would sweep them (starting from the seeker's final position).
const TOUR_INTRO_MS = 1800, TOUR_STOP_MS = 3200, TOUR_MAX_STOPS = 6;
let revealTour = null;
function buildRevealTour() {
  const bodies = snap.bodies || [];
  const seekers = bodies.filter((b) => b.seeker);
  let cur = seekers[0] ? { x: seekers[0].x, z: seekers[0].z } : { x: 0, z: 0 };
  const rest = bodies.filter((b) => !b.seeker);
  const stops = [];
  while (rest.length && stops.length < TOUR_MAX_STOPS) {
    let bi = 0, bd = Infinity;
    rest.forEach((b, i) => {
      const d = Math.hypot(b.x - cur.x, b.z - cur.z);
      if (d < bd) { bd = d; bi = i; }
    });
    const b = rest.splice(bi, 1)[0];
    stops.push({ x: b.x, y: b.y || 0, z: b.z });
    cur = b;
  }
  return {
    t0: performance.now(),
    stops,
    total: TOUR_INTRO_MS + stops.length * TOUR_STOP_MS,
  };
}
// Where the camera WANTS to be at tour-time t (chase-lerped for smoothness).
const _revPos = new THREE.Vector3(), _revLook = new THREE.Vector3();
let _revLastT = 0, _revInit = false;
function tourPose(t) {
  const ms = snap.mapSize || { x: 30, z: 30 };
  const R = Math.max(ms.x, ms.z);
  const tour = revealTour;
  if (!tour || t < TOUR_INTRO_MS || !tour.stops.length || t >= tour.total) {
    const ang = performance.now() / 1000 * 0.1;      // slow overview orbit
    return {
      px: Math.sin(ang) * R * 0.42, py: R * 0.6, pz: Math.cos(ang) * R * 0.42,
      lx: 0, ly: 0, lz: 0,
    };
  }
  const seg = Math.min(tour.stops.length - 1, Math.floor((t - TOUR_INTRO_MS) / TOUR_STOP_MS));
  const stop = tour.stops[seg];
  const cs = charScale();
  // Close-up: a slow orbit around the hiding spot, low enough to see how the
  // hider is tucked against the furniture.
  const ang = 0.9 + seg * 1.7 + ((t - TOUR_INTRO_MS) - seg * TOUR_STOP_MS) / 1000 * 0.22;
  const d = 2.0 * cs, h = 1.15 * cs;
  return {
    px: stop.x + Math.sin(ang) * d, py: stop.y + h, pz: stop.z + Math.cos(ang) * d,
    lx: stop.x, ly: stop.y + 0.2 * cs, lz: stop.z,
  };
}
function revealCamera() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - _revLastT) / 1000); _revLastT = now;
  const t = revealTour ? now - revealTour.t0 : Infinity;
  const p = tourPose(t);
  if (!_revInit) { _revPos.set(p.px, p.py, p.pz); _revLook.set(p.lx, p.ly, p.lz); _revInit = true; }
  const k = Math.min(1, dt * 2.4);                    // chase-lerp = smooth flight
  _revPos.x += (p.px - _revPos.x) * k; _revPos.y += (p.py - _revPos.y) * k; _revPos.z += (p.pz - _revPos.z) * k;
  _revLook.x += (p.lx - _revLook.x) * k; _revLook.y += (p.ly - _revLook.y) * k; _revLook.z += (p.lz - _revLook.z) * k;
  let cx = _revPos.x, cy = _revPos.y, cz = _revPos.z;
  // Close-ups happen inside rooms: pull the camera in if a wall would block
  // the view of the hiding spot.
  if (revealTour && t >= TOUR_INTRO_MS && t < revealTour.total && collisionMeshes.length) {
    _ro.set(_revLook.x, _revLook.y + 0.15, _revLook.z);
    _rd.set(cx - _ro.x, cy - _ro.y, cz - _ro.z);
    const full = _rd.length() || 1; _rd.normalize();
    _rc.set(_ro, _rd); _rc.far = full;
    const hit = _rc.intersectObjects(collisionMeshes, true)[0];
    if (hit && hit.distance < full) {
      const d = Math.max(0.3, hit.distance - 0.12);
      cx = _ro.x + _rd.x * d; cy = _ro.y + _rd.y * d; cz = _ro.z + _rd.z * d;
    }
  }
  camera.position.set(cx, cy, cz);
  camera.lookAt(_revLook.x, _revLook.y, _revLook.z);
}

// Round-end reveal markers: a pillar + floating name over EVERY hider so the
// zoomed-out camera shows exactly who was hiding where. Gold = survived the
// round, red = caught. depthTest off so they read through walls/furniture.
const beacons = new Map();
function makeNameLabel(name, survived) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 80;
  const cx = cv.getContext('2d');
  const text = (name || '').slice(0, 12);
  cx.font = '800 34px "Baloo 2", sans-serif';
  const w = Math.min(248, cx.measureText(text).width + 36);
  cx.fillStyle = survived ? 'rgba(255,207,63,.95)' : 'rgba(50,54,63,.88)';
  cx.beginPath(); cx.roundRect(128 - w / 2, 6, w, 52, 26); cx.fill();
  cx.lineWidth = 5; cx.strokeStyle = 'rgba(58,44,26,.85)'; cx.stroke();
  cx.fillStyle = survived ? '#3a2a00' : '#ffd7de';
  cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText((survived ? '' : '✗ ') + text, 128, 33);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false,
  }));
  return spr;
}
function syncBeacons(bodies) {
  const seen = new Set();
  // Label size scales with the map so names stay legible from the sky camera.
  const R = (snap && snap.mapSize) ? Math.max(snap.mapSize.x, snap.mapSize.z) : 30;
  const lw = Math.max(1.6, R * 0.13);
  for (const b of bodies) {
    seen.add(b.id);
    if (!beacons.has(b.id)) {
      const survived = !b.found;
      const grp = new THREE.Group();
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.02, 3.2, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: survived ? 0xffcf3f : 0xff5252, transparent: true, opacity: 0.55,
          blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
        }));
      pillar.position.y = 1.6;
      const label = makeNameLabel(b.name, survived);
      label.scale.set(lw, lw * 0.3125, 1);   // canvas is 256×80
      label.position.y = 3.4;
      grp.add(pillar, label);
      grp.position.set(b.x, b.y || 0, b.z);
      grp.renderOrder = 999;
      scene.add(grp);
      beacons.set(b.id, grp);
    }
  }
  for (const [id, g] of [...beacons]) {
    if (!seen.has(id)) {
      scene.remove(g);
      g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      beacons.delete(id);
    }
  }
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

let _scoredRound = -1;
function renderScores() {
  const sorted = [...snap.players].sort((a, b) => b.score - a.score);
  const isFinal = snap.round >= snap.totalRounds;
  $('scoreTitle').textContent = isFinal ? '🏆 Final Scores' : `Round ${snap.round} done!`;
  $('scoreList').innerHTML = sorted.map((p, i) => `
    <li><span class="pemoji">${i === 0 ? '👑' : p.avatar}</span>
    <span class="pname">${escapeHtml(p.name)}</span>
    ${p.ready ? '<span class="tagbadge ready">✔ READY</span>' : ''}
    <span class="tagbadge ${p.role || ''}">${(p.role || '').toUpperCase()}</span>
    <span class="pscore">${p.score}</span></li>`).join('');
  // The round only advances once EVERYONE presses Next.
  const meP = snap.players.find((p) => p.id === myId);
  const readyCount = snap.players.filter((p) => p.ready).length;
  const btn = $('nextBtn');
  btn.textContent = meP && meP.ready
    ? `⏳ Waiting for others… (${readyCount}/${snap.players.length})`
    : (isFinal ? '🏁 Back to lobby' : '▶ Next round');
  btn.disabled = !!(meP && meP.ready);
  $('nextHint').textContent = meP && meP.ready
    ? '' : `Everyone must press to continue · ${readyCount}/${snap.players.length} ready`;
  if (_scoredRound !== snap.round) {
    _scoredRound = snap.round;
    SFX.win();
    confetti(isFinal ? 120 : 50);
  }
}
$('nextBtn').addEventListener('click', () => { SFX.click(); socket.emit('next'); });
$('peekMapBtn').addEventListener('click', () => {
  SFX.click();
  mapPeek = true;
  if (revealTour) revealTour.t0 = performance.now();  // replay the fly-through
  renderGame();
});
$('showScoresBtn').addEventListener('click', () => { SFX.click(); mapPeek = false; renderGame(); });

// ---- Timer --------------------------------------------------------------
let lastTickSec = -1;
setInterval(() => {
  if (!snap || snap.phase === 'lobby') return;
  const remaining = Math.max(0, snap.deadline - (Date.now() + serverSkew));
  const secs = Math.ceil(remaining / 1000);
  const el = $('timer'); el.textContent = String(Math.max(0, secs));
  const low = secs <= 10 && (snap.phase === 'prep' || snap.phase === 'hunt');
  el.classList.toggle('low', low);
  if (low && secs !== lastTickSec) { lastTickSec = secs; SFX.tick(); }
  // Seeker's waiting-room countdown mirrors the big timer.
  if (snap.phase === 'prep' && snap.myRole === 'seeker') $('waitCount').textContent = secs > 0 ? secs : '';
  // Whistle countdown bar: when it empties, you whistle automatically.
  if (myWhistleDeadline && snap.phase === 'hunt' && snap.myRole === 'hider') {
    const frac = clamp((myWhistleDeadline - Date.now()) / WHISTLE_EVERY_MS, 0, 1);
    $('whistleFill').style.width = (frac * 100).toFixed(1) + '%';
  }
}, 200);

// ---- Socket -------------------------------------------------------------
socket.on('connect', () => { myId = socket.id; });
socket.on('state', (s) => {
  snap = s; myId = s.myId || myId; serverSkew = s.now - Date.now();
  if (!inRoom) return;
  if (s.phase === 'lobby') { show('lobby'); renderLobby(); }
  else { show('game'); renderGame(); }
});
socket.on('tagged', ({ id, name, by }) => {
  toast(`🎯 ${by} caught ${name}!`);
  SFX.caught();
  if (id === myId) {
    // That was me — buzz, red flash + spectate hint.
    buzz([70, 40, 90]);
    const v = $('vignette'); v.classList.remove('hidden');
    setTimeout(() => v.classList.add('hidden'), 850);
    showBanner('😵', 'CAUGHT!', 'You can roam and watch the rest of the round.', '', 2000);
  } else {
    setTimeout(() => {
      if (snap && snap.phase === 'hunt' && snap.remaining > 0) toast(`🦎 ${snap.remaining} still hidden!`, 1400);
    }, 1900);
  }
});
socket.on('miss', () => {
  // My shot hit nothing — no paint lost, just the reload wait.
  SFX.caught();
  buzz(35);
  toast('💦 Miss — reloading…', 1200);
  const v = $('vignette'); v.classList.remove('hidden');
  setTimeout(() => v.classList.add('hidden'), 850);
});
socket.on('whistle', ({ id, x, y, z, auto, bonus }) => {
  playWhistle(x, y, z);
  if (id === myId) {
    myWhistleDeadline = Date.now() + WHISTLE_EVERY_MS;
    toast(auto ? '😗 Your auto-whistle went off!'
      : (bonus ? `😗 Brave whistle — +${bonus} points, timer reset!` : '😗 You whistled — timer reset!'), 1500);
  } else if (snap && snap.phase === 'hunt' && snap.myRole === 'seeker' && seekerPos) {
    addWhistleCue(id, x, z);
  }
  // Bot seekers (host-driven) head for the sound — each localises it with
  // its own error, so they don't all converge on the exact spot.
  for (const [, s] of botSim) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * ((s.traits && s.traits.earJitter) || 1.5);
    s.whistle = { x: x + Math.sin(a) * r, z: z + Math.cos(a) * r };
    s.idleUntil = 0;   // a sound interrupts the idle scan instantly
  }
});

// Directional whistle cues: one arrow PER whistling hider orbits the
// crosshair and keeps tracking the sound as the seeker pans the camera
// (sound alone is hard to localise on phone speakers).
const whistleCues = new Map();  // hider id → { x, z, until, el, arrow, face }
function addWhistleCue(id, x, z) {
  let w = whistleCues.get(id);
  if (!w) {
    const el = document.createElement('div');
    el.className = 'wcue';
    el.innerHTML = '<div class="warrow">➤</div><span class="wface">😗</span>';
    $('whistleDirs').appendChild(el);
    w = { el, arrow: el.querySelector('.warrow'), face: el.querySelector('.wface') };
    whistleCues.set(id, w);
  }
  w.x = x; w.z = z; w.until = Date.now() + 2600;
}
function updateWhistleCues() {
  if (!whistleCues.size) return;
  const now = Date.now();
  const live = snap && snap.phase === 'hunt' && snap.myRole === 'seeker' && seekerPos;
  for (const [id, w] of [...whistleCues]) {
    if (!live || now > w.until) { w.el.remove(); whistleCues.delete(id); continue; }
    const bearing = Math.atan2(w.x - seekerPos.x, w.z - seekerPos.z);
    const rel = angleDelta(cam.yaw, bearing);          // 0 = straight ahead
    // The cue sits on a ring around the crosshair in the sound's direction;
    // the face counter-rotates so it stays upright.
    w.el.style.transform = `rotate(${(-rel).toFixed(3)}rad) translateY(-96px)`;
    w.face.style.transform = `rotate(${rel.toFixed(3)}rad)`;
    const left = w.until - now;
    w.el.style.opacity = left < 500 ? (left / 500).toFixed(2) : '1';
  }
}
socket.on('playerleft', ({ name }) => {
  toast(`🚪 ${name} left the game`, 2200);
  SFX.caught();
});
socket.on('blast', ({ x, y, z, color }) => paintSplat(x, y, z, color));
socket.on('emote', ({ emoji }) => flyEmote(emoji));
socket.on('disconnect', () => toast('Disconnected. Reconnecting…'));

// Dev/debug helpers (harmless in production).
window.__tp = (x, z) => {
  const p = (snap && snap.myRole === 'seeker' && seekerPos) ? seekerPos : myBody;
  if (p) { p.x = x; p.z = z; p.y = 2; }
};
window.__look = (yaw) => { cam.yaw = yaw; if (myBody) myBody.ry = yaw; };
window.__shoot = (x, z) => socket.emit('shoot', { x, y: 0.5, z, color: '#ff3bd0' });
// Highest collision surface (wall/furniture top) under (x,z) — probe from high up.
window.__top = (x, z) => {
  _ro.set(x, 30, z); _rd.set(0, -1, 0); _rc.set(_ro, _rd); _rc.far = 60;
  const h = _rc.intersectObjects(collisionMeshes, true)[0];
  return h ? +h.point.y.toFixed(2) : null;
};
// Debug: capture the canvas as a JPEG data URL (fresh render first — the
// drawing buffer isn't preserved between frames). Used to author the lobby
// map-snapshot thumbnails.
window.__snapimg = (q = 0.85) => {
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/jpeg', q);
};
window.__state = () => ({
  body: myBody && { x: +myBody.x.toFixed(2), y: +(myBody.y || 0).toFixed(2), z: +myBody.z.toFixed(2), pose: myBody.pose },
  climbing, joy: joyVec, near: nearSurface,
  seeker: seekerPos && { x: +seekerPos.x.toFixed(2), y: +(seekerPos.y || 0).toFixed(2), z: +seekerPos.z.toFixed(2) },
  phase: snap && snap.phase, role: snap && snap.myRole,
  joyId, keyW: !!keyState['w'], frame: frameCount,
  camYaw: +cam.yaw.toFixed(2), ry: myBody ? +(myBody.ry || 0).toFixed(2) : null,
  tags: [...nameTags.entries()].map(([id, t]) => ({ id, x: +t.position.x.toFixed(1), y: +t.position.y.toFixed(1), z: +t.position.z.toFixed(1) })),
  bodies: (snap && snap.bodies || []).map((b) => ({ id: b.id, name: b.name, shape: b.shape, seeker: !!b.seeker, x: +b.x.toFixed(1), y: +(b.y || 0).toFixed(1), z: +b.z.toFixed(1), found: !!b.found })),
});

// ---- Boot ---------------------------------------------------------------
// iOS Safari/Chrome ignore user-scalable=no, so a double-tap or pinch could
// zoom the page with no way back, hiding half the controls. Kill both:
// gesture events cover pinch, the touchend guard covers double-tap (inputs
// are exempt so text fields still focus normally).
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
let _lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - _lastTouchEnd < 350 && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) {
    e.preventDefault();
  }
  _lastTouchEnd = now;
}, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());

buildAvatars();
buildShapes();
show('home');
// PWA install support: the service worker is what makes the game installable
// (Add to Home Screen -> real fullscreen, no address bar).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
const params = new URLSearchParams(location.search);
if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase();
