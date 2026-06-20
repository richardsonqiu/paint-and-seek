// Doodle Guys — client.
import { MAPS, sampleColorAt, WORLD } from '/shared/maps.js';

// Keep in sync with server/rooms.js POSE_BOX.
const POSE_BOX = {
  standing: { w: 64, h: 120 },
  crouching: { w: 84, h: 84 },
  flat: { w: 124, h: 52 },
};

const AVATARS = ['🦎', '🐙', '🐸', '🦊', '🐼', '🐯', '🐧', '🦄', '🐳', '👾', '🤖', '👻'];

const socket = io();
const $ = (id) => document.getElementById(id);

// ---- Local UI state -----------------------------------------------------
let myId = null;
let snap = null;            // latest server snapshot
let serverSkew = 0;        // serverNow - clientNow
let inRoom = false;
let chosenAvatar = AVATARS[0];

// Hider editing state (prep phase)
let myBody = null;         // local working copy
let curTool = 'eyedrop';   // 'move' | 'eyedrop'
let curSeg = 'head';
let lastPaintSent = 0;

// ---- Screen helpers -----------------------------------------------------
function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(`screen-${screen}`).classList.add('active');
}
function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---- Home ---------------------------------------------------------------
function buildAvatars() {
  const wrap = $('avatarPicker');
  wrap.innerHTML = '';
  AVATARS.forEach((a) => {
    const b = document.createElement('button');
    b.textContent = a;
    if (a === chosenAvatar) b.classList.add('sel');
    b.onclick = () => {
      chosenAvatar = a;
      buildAvatars();
    };
    wrap.appendChild(b);
  });
}
function myInfo() {
  const name = ($('nameInput').value || '').trim().slice(0, 12) || 'Doodler';
  return { name, avatar: chosenAvatar };
}

$('createBtn').onclick = () => {
  socket.emit('create', myInfo(), (res) => {
    if (res && res.ok) { inRoom = true; $('homeError').textContent = ''; }
  });
};
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
  const data = { title: 'Doodle Guys', text: `Join my game! Code: ${snap.code}`, url };
  try {
    if (navigator.share) await navigator.share(data);
    else { await navigator.clipboard.writeText(url); toast('Link copied!'); }
  } catch (_) { /* user cancelled */ }
};

function buildMapSelect() {
  const sel = $('mapSelect');
  if (sel.options.length) return;
  Object.values(MAPS).forEach((m) => {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.name; sel.appendChild(o);
  });
}
['mapSelect', 'modeSelect'].forEach((id) =>
  $(id).addEventListener('change', () => socket.emit('settings', { [id.replace('Select', '')]: $(id).value }))
);
$('prepInput').addEventListener('change', () => socket.emit('settings', { prepTime: +$('prepInput').value }));
$('huntInput').addEventListener('change', () => socket.emit('settings', { huntTime: +$('huntInput').value }));
$('roundsInput').addEventListener('change', () => socket.emit('settings', { rounds: +$('roundsInput').value }));

function renderLobby() {
  $('lobbyCode').textContent = snap.code;
  const isHost = snap.hostId === myId;
  $('playerCount').textContent = `(${snap.players.length}/12)`;
  $('playerList').innerHTML = snap.players.map((p) => `
    <li>
      <span class="pemoji">${p.avatar}</span>
      <span class="pname">${escapeHtml(p.name)}</span>
      ${p.isHost ? '<span class="tagbadge host">HOST</span>' : ''}
    </li>`).join('');

  $('hostSettings').classList.toggle('hidden', !isHost);
  $('guestWait').classList.toggle('hidden', isHost);
  const canStart = isHost && snap.players.length >= 2;
  $('startBtn').classList.toggle('hidden', !isHost);
  $('startBtn').disabled = !canStart;
  $('lobbyHint').textContent = snap.players.length < 2 ? 'Need at least 2 players to start.' : '';

  if (isHost) {
    buildMapSelect();
    $('mapSelect').value = snap.settings.map;
    $('modeSelect').value = snap.settings.mode;
    $('prepInput').value = snap.settings.prepTime;
    $('huntInput').value = snap.settings.huntTime;
    $('roundsInput').value = snap.settings.rounds;
  }
}

// ---- Canvas / rendering -------------------------------------------------
const canvas = $('stage');
const ctx = canvas.getContext('2d');
let CSS_SIZE = 320; // css px of square stage

function fitCanvas() {
  const wrap = canvas.parentElement;
  const size = Math.min(wrap.clientWidth, wrap.clientHeight);
  CSS_SIZE = Math.max(200, size);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = canvas.style.height = CSS_SIZE + 'px';
  canvas.width = canvas.height = Math.round(CSS_SIZE * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', fitCanvas);

function worldToScreen(wx, wy) {
  const s = CSS_SIZE / WORLD.w;
  return [wx * s, wy * s];
}
function screenToWorld(sx, sy) {
  const s = CSS_SIZE / WORLD.w;
  return [sx / s, sy / s];
}

function roundRect(cx, cy, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(cx - w / 2, cy - h / 2, w, h, r);
}

function drawFigure(cx, cy, pose, seg, opts = {}) {
  const box = POSE_BOX[pose] || POSE_BOX.standing;
  const s = CSS_SIZE / WORLD.w;
  const w = box.w * s, h = box.h * s;
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  if (opts.outline) {
    ctx.shadowColor = opts.outline; ctx.shadowBlur = 10;
  }
  if (pose === 'flat') {
    // lying horizontally: head left, torso mid, legs right
    const partW = w / 3;
    roundRect(cx - w / 2 + partW / 2, cy, partW * 0.9, h * 0.9, h * 0.4); ctx.fillStyle = seg.head; ctx.fill();
    roundRect(cx, cy, partW * 1.0, h * 0.95, h * 0.25); ctx.fillStyle = seg.torso; ctx.fill();
    roundRect(cx + w / 2 - partW / 2, cy, partW * 0.9, h * 0.75, h * 0.25); ctx.fillStyle = seg.legs; ctx.fill();
  } else {
    const headH = h * 0.30, torsoH = h * 0.42, legsH = h * 0.28;
    const topY = cy - h / 2;
    // head
    ctx.beginPath();
    ctx.arc(cx, topY + headH * 0.5, Math.min(w * 0.42, headH * 0.55), 0, Math.PI * 2);
    ctx.fillStyle = seg.head; ctx.fill();
    // torso
    roundRect(cx, topY + headH + torsoH / 2, w, torsoH, w * 0.22); ctx.fillStyle = seg.torso; ctx.fill();
    // legs
    roundRect(cx, topY + headH + torsoH + legsH / 2, w * 0.82, legsH, w * 0.18); ctx.fillStyle = seg.legs; ctx.fill();
  }
  ctx.restore();

  if (opts.label) {
    ctx.save();
    ctx.fillStyle = '#fff'; ctx.font = '600 11px system-ui'; ctx.textAlign = 'center';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillText(opts.label, cx, cy - h / 2 - 6);
    ctx.restore();
  }
}

function drawMap(map) {
  ctx.fillStyle = map.bg;
  ctx.fillRect(0, 0, CSS_SIZE, CSS_SIZE);
  const s = CSS_SIZE / WORLD.w;
  for (const sf of map.surfaces) {
    ctx.fillStyle = sf.color;
    ctx.fillRect(sf.x * s, sf.y * s, sf.w * s, sf.h * s);
  }
}

function render() {
  requestAnimationFrame(render);
  if (!snap || snap.phase === 'lobby') return;
  const map = MAPS[snap.mapId] || MAPS.living_room;
  drawMap(map);

  // Eyedrop reticle for hiders in prep
  if (snap.phase === 'prep' && snap.myRole === 'hider' && myBody) {
    const [sx, sy] = worldToScreen(myBody.x, myBody.y);
    const highlight = (curTool === 'move')
      ? '#5fd0ff' : null;
    drawFigure(sx, sy, myBody.pose, myBody.segments, { outline: highlight, label: 'YOU' });
  }

  if (snap.phase === 'hunt' || snap.phase === 'roundover') {
    for (const b of snap.bodies) {
      const [sx, sy] = worldToScreen(b.x, b.y);
      const seg = b.segments;
      if (b.found) {
        drawFigure(sx, sy, b.pose, seg, { outline: '#ff5fa2', alpha: 1, label: '✖ ' + (b.name || '') });
      } else if (b.mine) {
        drawFigure(sx, sy, b.pose, seg, { outline: '#57e389', label: 'YOU' });
      } else {
        // un-found hiders: render plainly — spotting them is the game
        drawFigure(sx, sy, b.pose, seg, {});
      }
    }
  }
}

// ---- Pointer input ------------------------------------------------------
let dragging = false;
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  const p = e.touches ? e.touches[0] : e;
  return [p.clientX - r.left, p.clientY - r.top];
}

canvas.addEventListener('pointerdown', (e) => {
  if (!snap) return;
  const [sx, sy] = canvasPoint(e);
  const [wx, wy] = screenToWorld(sx, sy);

  if (snap.phase === 'prep' && snap.myRole === 'hider' && myBody) {
    if (curTool === 'move') {
      dragging = true;
      myBody.x = clamp(wx, 0, 1000); myBody.y = clamp(wy, 0, 1000);
      sendPaint(true);
    } else {
      const map = MAPS[snap.mapId];
      const color = sampleColorAt(map, wx, wy);
      applyColor(color);
    }
  } else if (snap.phase === 'hunt' && snap.myRole === 'seeker') {
    socket.emit('tag', { x: wx, y: wy });
    flashAt(sx, sy);
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || !myBody) return;
  const [sx, sy] = canvasPoint(e);
  const [wx, wy] = screenToWorld(sx, sy);
  myBody.x = clamp(wx, 0, 1000); myBody.y = clamp(wy, 0, 1000);
  sendPaint(false);
});
window.addEventListener('pointerup', () => { if (dragging) { dragging = false; sendPaint(true); } });

function flashAt(sx, sy) {
  const f = document.createElement('div');
  f.className = 'fly'; f.textContent = '🔍';
  f.style.left = sx - 10 + 'px'; f.style.top = sy - 10 + 'px';
  $('emoteFloat').appendChild(f);
  setTimeout(() => f.remove(), 1200);
}

function applyColor(color) {
  if (!myBody) return;
  myBody.segments[curSeg] = color;
  $('colorInput').value = color;
  sendPaint(true);
}
function sendPaint(force) {
  if (!myBody) return;
  const now = Date.now();
  if (!force && now - lastPaintSent < 60) return;
  lastPaintSent = now;
  socket.emit('paint', myBody);
}

// ---- Hider toolbar wiring ----------------------------------------------
document.querySelectorAll('#hiderTools .tool[data-tool]').forEach((b) =>
  b.addEventListener('click', () => {
    curTool = b.dataset.tool;
    document.querySelectorAll('#hiderTools .tool[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
  })
);
document.querySelectorAll('#hiderTools .seg').forEach((b) =>
  b.addEventListener('click', () => {
    curSeg = b.dataset.seg;
    document.querySelectorAll('#hiderTools .seg').forEach((x) => x.classList.toggle('active', x === b));
    if (myBody) $('colorInput').value = myBody.segments[curSeg];
  })
);
document.querySelectorAll('#hiderTools .pose').forEach((b) =>
  b.addEventListener('click', () => {
    if (!myBody) return;
    myBody.pose = b.dataset.pose;
    document.querySelectorAll('#hiderTools .pose').forEach((x) => x.classList.toggle('active', x === b));
    sendPaint(true);
  })
);
$('colorInput').addEventListener('input', (e) => applyColor(e.target.value));
$('fillAllBtn').addEventListener('click', () => {
  if (!myBody) return;
  const c = $('colorInput').value;
  myBody.segments = { head: c, torso: c, legs: c };
  sendPaint(true);
});

// ---- Emotes -------------------------------------------------------------
document.querySelectorAll('.emote').forEach((b) =>
  b.addEventListener('click', () => socket.emit('emote', { emoji: b.dataset.emoji }))
);
function flyEmote(emoji) {
  const f = document.createElement('div');
  f.className = 'fly'; f.textContent = emoji;
  f.style.left = 20 + Math.random() * 60 + '%';
  f.style.top = 60 + Math.random() * 20 + '%';
  $('emoteFloat').appendChild(f);
  setTimeout(() => f.remove(), 1700);
}

// ---- Game UI update -----------------------------------------------------
function renderGame() {
  const phase = snap.phase;
  $('phaseLabel').textContent = phase.toUpperCase();
  const role = snap.myRole || '';
  const rl = $('roleLabel');
  rl.textContent = role ? role.toUpperCase() : '';
  rl.className = 'pill role ' + role;

  $('remainLabel').textContent = (phase === 'hunt' || phase === 'roundover')
    ? `${snap.remaining}/${snap.totalHiders} hidden` : `R${snap.round}/${snap.totalRounds}`;

  // Init local body when entering prep as hider
  if (phase === 'prep' && role === 'hider') {
    const mine = snap.bodies.find((b) => b.mine);
    if (mine && (!myBody || snap.round !== myBody._round)) {
      myBody = { x: mine.x, y: mine.y, pose: mine.pose, segments: { ...mine.segments }, _round: snap.round };
      $('colorInput').value = myBody.segments[curSeg];
    }
  }
  if (phase !== 'prep') { /* keep myBody for render during hunt via snapshot */ }

  // Toolbars + overlays
  const isHiderPrep = phase === 'prep' && role === 'hider';
  const isSeekerHunt = phase === 'hunt' && role === 'seeker';
  $('hiderTools').classList.toggle('hidden', !isHiderPrep);
  $('seekerTools').classList.toggle('hidden', !isSeekerHunt);
  $('emoteBar').classList.toggle('hidden', phase !== 'hunt');

  const wait = $('waitOverlay');
  if (phase === 'prep' && role === 'seeker') {
    wait.classList.remove('hidden');
    $('waitTitle').textContent = 'Hiders are painting…';
    $('waitText').textContent = 'Memorise the room. The hunt is coming.';
    $('waitOverlay').querySelector('.big-emoji').textContent = '🎨';
  } else if (phase === 'hunt' && role === 'hider') {
    wait.classList.add('hidden'); // hider sees the stage but can't move
    toastFrozenOnce();
  } else {
    wait.classList.add('hidden');
  }

  // Round-over scoreboard
  $('scoreOverlay').classList.toggle('hidden', phase !== 'roundover');
  if (phase === 'roundover') renderScores();
}

let _frozenToast = -1;
function toastFrozenOnce() {
  if (_frozenToast === snap.round) return;
  _frozenToast = snap.round;
  toast('❄️ Frozen! Hold still and hope.', 2400);
}

function renderScores() {
  const sorted = [...snap.players].sort((a, b) => b.score - a.score);
  const isFinal = snap.round >= snap.totalRounds;
  $('scoreTitle').textContent = isFinal ? '🏆 Final Scores' : `Round ${snap.round} done`;
  $('scoreList').innerHTML = sorted.map((p, i) => `
    <li>
      <span class="pemoji">${i === 0 ? '👑' : p.avatar}</span>
      <span class="pname">${escapeHtml(p.name)}</span>
      <span class="tagbadge ${p.role || ''}">${(p.role || '').toUpperCase()}</span>
      <span class="pscore">${p.score}</span>
    </li>`).join('');
  $('nextHint').textContent = isFinal ? 'Returning to lobby…' : 'Next round starting soon…';
}

// ---- Timer --------------------------------------------------------------
setInterval(() => {
  if (!snap || snap.phase === 'lobby') return;
  const remaining = Math.max(0, snap.deadline - (Date.now() + serverSkew));
  const secs = Math.ceil(remaining / 1000);
  const el = $('timer');
  el.textContent = secs >= 0 ? String(secs) : '0';
  el.classList.toggle('low', secs <= 10 && (snap.phase === 'prep' || snap.phase === 'hunt'));
}, 200);

// ---- Socket events ------------------------------------------------------
socket.on('connect', () => { myId = socket.id; });
socket.on('state', (s) => {
  snap = s;
  myId = s.myId || myId;
  serverSkew = s.now - Date.now();
  if (!inRoom) return;
  if (s.phase === 'lobby') { show('lobby'); renderLobby(); }
  else { show('game'); fitCanvasIfNeeded(); renderGame(); }
});
socket.on('tagged', ({ name, by }) => toast(`🎯 ${by} found ${name}!`));
socket.on('miss', () => { /* silent miss; reticle already shown */ });
socket.on('emote', ({ emoji }) => flyEmote(emoji));
socket.on('disconnect', () => toast('Disconnected. Reconnecting…'));

let _canvasReady = false;
function fitCanvasIfNeeded() {
  if (!_canvasReady) { fitCanvas(); _canvasReady = true; }
  else fitCanvas();
}

// ---- Utils --------------------------------------------------------------
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- Boot ---------------------------------------------------------------
buildAvatars();
show('home');
render();
const params = new URLSearchParams(location.search);
if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase();
