// Doodle Guys — game server.
// Express serves the static client; Socket.io drives real-time rooms.

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { RoomStore, POSES, clampToRoom, WHISTLE_EVERY } from './rooms.js';
import { spawnPoints } from '../shared/maps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const store = new RoomStore();

app.use(express.static(join(ROOT, 'public')));
app.use('/shared', express.static(join(ROOT, 'shared')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: store.rooms.size }));

const PORT = process.env.PORT || 3000;
const RELOAD_MS = 3000;   // paint-gun reload; shots themselves are free

// ---- Phase engine -------------------------------------------------------

function broadcast(room) {
  for (const id of room.players.keys()) {
    io.to(id).emit('state', room.snapshot(id));
  }
}

// Movement updates arrive ~14×/s per player; broadcasting a full snapshot for
// each one melted client frame rates. During the hunt they're coalesced into
// a 10 Hz pump instead (events like tags/shots still broadcast immediately).
function scheduleBroadcast(room) {
  if (room.phase === 'hunt' && room._pump) { room._dirty = true; return; }
  broadcast(room);
}
function startPump(room) {
  room._dirty = false;
  room._pump = setInterval(() => {
    if (room._dirty) { room._dirty = false; broadcast(room); }
  }, 100);
}
function stopPump(room) {
  if (room._pump) { clearInterval(room._pump); room._pump = null; }
}

function clearTimer(room) {
  if (room._timer) {
    clearTimeout(room._timer);
    room._timer = null;
  }
}

function startRound(room) {
  room.round += 1;
  room.assignRoles();
  enterPrep(room);
}

function enterPrep(room) {
  clearTimer(room);
  room.phase = 'prep';
  room.deadline = Date.now() + room.settings.prepTime * 1000;
  broadcast(room);
  startBotHiding(room);
  room._timer = setTimeout(() => enterHunt(room), room.settings.prepTime * 1000);
}

// Bot hiders walk to a random (known-walkable) spawn spot during prep and
// strike a pose there. Hiders are invisible to everyone during prep, so the
// walk needs no broadcasting — only the server state matters at hunt start.
const BOT_POSES = ['standing', 'head', 'cheer', 'zombie', 'kneel', 'flat', 'ball', 'star'];
function startBotHiding(room) {
  stopBots(room);
  const bots = room.activePlayers().filter((p) => p.isBot && p.role === 'hider');
  if (!bots.length) return;
  const pts = spawnPoints(room.map);
  for (const b of bots) {
    const t = pts[Math.floor(Math.random() * pts.length)];
    const [tx, tz] = clampToRoom(room.map, t[0] + (Math.random() * 3 - 1.5), t[2] + (Math.random() * 3 - 1.5));
    b.botTarget = { x: tx, z: tz };
    b.botPose = BOT_POSES[Math.floor(Math.random() * BOT_POSES.length)];
  }
  room._botTick = setInterval(() => {
    if (room.phase !== 'prep') { stopBots(room); return; }
    for (const b of room.activePlayers()) {
      if (!b.isBot || b.role !== 'hider' || !b.botTarget) continue;
      const dx = b.botTarget.x - b.body.x, dz = b.botTarget.z - b.body.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15) { b.body.pose = b.botPose; continue; }
      const step = Math.min(d, 2.2 * 0.15);           // ~2.2 m/s at 150ms ticks
      b.body.x += (dx / d) * step;
      b.body.z += (dz / d) * step;
      b.body.ry = Math.atan2(dx, dz);
    }
  }, 150);
}
function stopBots(room) {
  if (room._botTick) { clearInterval(room._botTick); room._botTick = null; }
  if (room._botHunt) { clearInterval(room._botHunt); room._botHunt = null; }
}

// Clamp a point to the map's playable bounds (falls back to the full size).
function clampPlay(map, x, z) {
  const b = map.bounds;
  if (!b) return clampToRoom(map, x, z);
  return [Math.max(b.minX, Math.min(b.maxX, x)), Math.max(b.minZ, Math.min(b.maxZ, z))];
}

// ---- Bot seeker AI -------------------------------------------------------
// Bots take seeker turns so humans get to HIDE even in tiny lobbies. The AI
// is deliberately simple and beatable: patrol the spawn spots, run toward
// whistles, and only "see" a hider within a short radius. Same reload rules
// as humans.
const BOT_SIGHT = 2.4;      // metres — must nearly stumble over you
const BOT_SHOOT = 1.25;     // fire when this close (blast radius is 1.4)
function startBotSeekers(room) {
  const botSeekers = room.activePlayers().filter((p) => p.isBot && p.role === 'seeker');
  if (!botSeekers.length) return;
  const pts = spawnPoints(room.map);
  for (const b of botSeekers) { b.botTarget = null; b.lastShot = Date.now(); }
  room._botHunt = setInterval(() => {
    if (room.phase !== 'hunt') { stopBots(room); return; }
    const now = Date.now();
    let moved = false;
    for (const b of room.activePlayers()) {
      if (!b.isBot || b.role !== 'seeker') continue;
      // Sense: the nearest still-hidden hider inside sight range.
      let prey = null, pd = BOT_SIGHT;
      for (const h of room.remainingHiders()) {
        const d = Math.hypot(h.body.x - b.body.x, h.body.z - b.body.z);
        if (d < pd) { pd = d; prey = h; }
      }
      if (prey && pd <= BOT_SHOOT && now - (b.lastShot || 0) >= RELOAD_MS) {
        b.lastShot = now;
        botShoot(room, b, prey);
        continue;
      }
      // Steer: chase prey, else head for the current patrol point (a heard
      // whistle overrides it — see alertBotSeekers).
      let tx, tz;
      if (prey) { tx = prey.body.x; tz = prey.body.z; }
      else {
        if (!b.botTarget ||
            Math.hypot(b.botTarget.x - b.body.x, b.botTarget.z - b.body.z) < 0.6) {
          const t = pts[Math.floor(Math.random() * pts.length)];
          const [px, pz] = clampPlay(room.map, t[0] + (Math.random() * 3 - 1.5), t[2] + (Math.random() * 3 - 1.5));
          b.botTarget = { x: px, z: pz };
        }
        tx = b.botTarget.x; tz = b.botTarget.z;
      }
      const dx = tx - b.body.x, dz = tz - b.body.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.05) {
        const step = Math.min(d, 2.4 * 0.25);      // ~2.4 m/s at 250ms ticks
        b.body.x += (dx / d) * step;
        b.body.z += (dz / d) * step;
        b.body.ry = Math.atan2(dx, dz);
        moved = true;
      }
    }
    if (moved) scheduleBroadcast(room);
  }, 250);
}

// A whistle rings out: every bot seeker beelines for the sound.
function alertBotSeekers(room, x, z) {
  for (const b of room.activePlayers()) {
    if (b.isBot && b.role === 'seeker') {
      const [px, pz] = clampPlay(room.map, x, z);
      b.botTarget = { x: px, z: pz };
    }
  }
}

// Bot pulls the trigger point-blank — same blast/score/broadcast as a
// human 'shoot' hit.
function botShoot(room, p, hit) {
  io.to(room.code).emit('blast', { x: hit.body.x, y: 0.5, z: hit.body.z, color: '#ff3bd0' });
  hit.found = true;
  const huntMs = room.huntMs || room.settings.huntTime * 1000;
  const msLeft = Math.max(0, room.deadline - Date.now());
  p.score += 60 + Math.round((msLeft / huntMs) * 40);
  hit.score += Math.round(((huntMs - msLeft) / huntMs) * 50);
  if (room.settings.mode === 'infection') { hit.role = 'seeker'; hit.found = false; }
  io.to(room.code).emit('tagged', { id: hit.id, name: hit.name, by: p.name });
  broadcast(room);
  maybeEndEarly(room);
}

function enterHunt(room) {
  clearTimer(room);
  stopBots(room);
  room.phase = 'hunt';
  // Seek time scales with the group: huntTime is PER HIDER (45s default),
  // so a seeker hunting 3 people gets 135s.
  room.huntMs = room.settings.huntTime * 1000 * Math.max(1, room.hiders().length);
  room.deadline = Date.now() + room.huntMs;
  // Arm the auto-whistle: every hider betrays their position every 45s unless
  // they whistle manually first (which resets the countdown).
  const now = Date.now();
  for (const h of room.hiders()) h.nextWhistle = now + WHISTLE_EVERY;
  if (room.settings.whistle) {
    room._whistler = setInterval(() => tickWhistles(room), 1000);
  }
  startPump(room);
  broadcast(room);
  startBotSeekers(room);
  room._timer = setTimeout(() => endRound(room, 'time'), room.huntMs);
}

function tickWhistles(room) {
  if (room.phase !== 'hunt') return;
  const now = Date.now();
  for (const h of room.remainingHiders()) {
    if (now >= h.nextWhistle) {
      h.nextWhistle = now + WHISTLE_EVERY;
      io.to(room.code).emit('whistle', { id: h.id, x: h.body.x, y: h.body.y || 0, z: h.body.z, auto: true });
      alertBotSeekers(room, h.body.x, h.body.z);
    }
  }
}

function endRound(room, reason) {
  clearTimer(room);
  if (room._whistler) { clearInterval(room._whistler); room._whistler = null; }
  stopBots(room);
  stopPump(room);
  room.phase = 'roundover';

  const survivors = room.remainingHiders();
  const found = room.hiders().filter((h) => h.found);
  const allFound = survivors.length === 0 && room.hiders().length > 0;

  // Hider scoring: survive = +100. Caught hiders earned partial credit
  // for how long they held out (handled at tag time).
  for (const h of survivors) {
    h.score += 100;
  }
  // Seeker scoring: split a clear bonus if every hider was found.
  if (allFound) {
    for (const s of room.seekers()) s.score += 100;
  }

  // No auto-advance: the reveal + scoreboard stay up until EVERY player has
  // pressed Next (readiness is re-checked when someone leaves, too). Bots
  // are always ready.
  room.deadline = 0;
  for (const p of room.players.values()) p.ready = !!p.isBot;
  broadcast(room);
}

// Advance past the scoreboard once every connected player has pressed Next.
function maybeAdvance(room) {
  if (room.phase !== 'roundover') return;
  const act = room.activePlayers();
  if (act.length === 0 || !act.every((p) => p.ready)) return;
  if (room.round >= room.totalRounds) {
    room.phase = 'lobby';
    room.round = 0;
    for (const p of room.players.values()) { p.role = null; p.ready = false; }
    broadcast(room);
  } else {
    startRound(room);
  }
}

function maybeEndEarly(room) {
  if (room.phase !== 'hunt') return;
  if (room.remainingHiders().length === 0) endRound(room, 'allfound');
  // No able seeker left (all shot dry — or the last one quit): hiders win.
  // Only checked on events, so solo practice rounds (started with zero
  // seekers) are unaffected.
  else if (room.activeSeekers().length === 0) {
    endRound(room, 'seekersout');
  }
}

// ---- Socket wiring ------------------------------------------------------

io.on('connection', (socket) => {
  let roomCode = null;

  const room = () => store.get(roomCode);
  const me = () => {
    const r = room();
    return r ? r.players.get(socket.id) : null;
  };

  socket.on('create', ({ name, avatar, shape }, cb) => {
    cleanup();                       // leave any room we were already in
    const r = store.create();
    roomCode = r.code;
    socket.join(r.code);
    r.addPlayer(socket.id, name, avatar, shape);
    cb && cb({ ok: true, code: r.code });
    broadcast(r);
  });

  socket.on('join', ({ code, name, avatar, shape }, cb) => {
    const r = store.get(code);
    if (!r) return cb && cb({ ok: false, error: 'Room not found' });
    if (roomCode && roomCode !== r.code) cleanup(); // leave any previous room
    if (r.phase !== 'lobby') return cb && cb({ ok: false, error: 'Game already started' });
    if (r.players.size >= 12) return cb && cb({ ok: false, error: 'Room is full' });
    roomCode = r.code;
    socket.join(r.code);
    r.addPlayer(socket.id, name, avatar, shape);
    cb && cb({ ok: true, code: r.code });
    broadcast(r);
  });

  socket.on('settings', (patch) => {
    const r = room();
    if (!r || socket.id !== r.hostId || r.phase !== 'lobby') return;
    const s = r.settings;
    if (typeof patch.prepTime === 'number') s.prepTime = clamp(patch.prepTime, 10, 120);
    if (typeof patch.huntTime === 'number') s.huntTime = clamp(patch.huntTime, 10, 120); // per hider
    if (typeof patch.rounds === 'number') s.rounds = clamp(patch.rounds, 1, 20);
    if (typeof patch.seekers === 'number') s.seekers = clamp(Math.round(patch.seekers), 1, 11);
    if (typeof patch.bots === 'number') {
      s.bots = clamp(Math.round(patch.bots), 0, 8);
      r.syncBots(s.bots);           // bots appear/disappear in the lobby list
    }
    if (patch.map) s.map = patch.map;
    if (patch.mode) s.mode = patch.mode;
    if (typeof patch.whistle === 'boolean') s.whistle = patch.whistle;
    broadcast(r);
  });

  socket.on('start', () => {
    const r = room();
    if (!r || socket.id !== r.hostId || r.phase !== 'lobby') return;
    const n = r.activePlayers().length;
    if (n < 1) return; // min 1 for easier testing
    // Everyone (bots included) gets a seeker turn: with N players and K
    // seekers per round a full cycle is ceil(N/K) rounds, so the game runs
    // at least that long (4 players, 1 seeker -> minimum 4 rounds).
    const cycle = Math.ceil(n / Math.max(1, r.seekerCount()));
    r.totalRounds = Math.max(r.settings.rounds, cycle);
    r.seekerQueue = [];          // fresh rotation each game
    r.lastSeekerIds = new Set(); // no carry-over "no repeat" debt from last game
    startRound(r);
  });

  // Hiders move/pose during BOTH prep and the hunt (cat-and-mouse). The painted
  // skin texture is only editable during prep. Movement/pose are small frequent
  // messages; the texture arrives as a (throttled) data URL.
  const MAX_PAINT_BYTES = 400000;
  socket.on('paint', (body) => {
    const r = room();
    const p = me();
    if (!r || !p || p.role !== 'hider' || p.found || !body) return;
    if (r.phase !== 'prep' && r.phase !== 'hunt') return;
    if (typeof body.x === 'number' && typeof body.z === 'number') {
      const [cx, cz] = clampToRoom(r.map, body.x, body.z);
      p.body.x = cx; p.body.z = cz;
    }
    if (typeof body.y === 'number') p.body.y = Math.max(-2, Math.min(20, body.y));
    if (typeof body.ry === 'number') p.body.ry = body.ry;
    if (POSES.includes(body.pose)) p.body.pose = body.pose;
    if (typeof body.paint === 'string' &&          // paint during prep AND the hunt
        body.paint.startsWith('data:image/') &&
        body.paint.length <= MAX_PAINT_BYTES) {
      p.body.paint = body.paint;
    }
    // During the hunt, seekers must see hiders move — coalesced via the pump.
    // During prep no echo is needed: the mover's own client renders its body
    // locally, and nobody else can see hiders yet.
    if (r.phase === 'hunt') scheduleBroadcast(r);
  });

  // Seeker tags a hider. The client raycasts the 3D scene and sends the
  // target's id; the server validates phase/role/target.
  socket.on('tag', ({ targetId }) => {
    const r = room();
    const p = me();
    if (!r || !p || r.phase !== 'hunt' || p.role !== 'seeker') return;
    const hit = r.tagById(targetId);
    if (hit && !hit.found) {
      hit.found = true;
      // Seeker reward + time bonus for tagging earlier in the hunt.
      const huntMs = r.huntMs || r.settings.huntTime * 1000;
      const msLeft = Math.max(0, r.deadline - Date.now());
      const timeBonus = Math.round((msLeft / huntMs) * 40);
      p.score += 60 + timeBonus;
      // Caught hider gets partial survival credit.
      hit.score += Math.round(((huntMs - msLeft) / huntMs) * 50);
      // Infection mode: a caught hider switches sides and joins the hunt.
      if (r.settings.mode === 'infection') {
        hit.role = 'seeker';
        hit.found = false; // back in play, now as a seeker
      }
      io.to(r.code).emit('tagged', { id: hit.id, name: hit.name, by: p.name });
      broadcast(r);
      maybeEndEarly(r);
    } else {
      io.to(socket.id).emit('miss', {});
    }
  });

  // Seeker fires a paint blast at a world point. Splatters paint (visible to
  // everyone), catches any hider within the blast radius. Shots are FREE —
  // the balance lever is the reload: every shot (hit or miss) locks the gun
  // for RELOAD_MS, so spraying every blob wastes precious hunt time.
  socket.on('shoot', (data) => {
    const r = room();
    const p = me();
    if (!r || !p || p.role !== 'seeker' || r.phase !== 'hunt' || !data) return;
    if (typeof data.x !== 'number' || typeof data.z !== 'number') return;
    const now = Date.now();
    if (now - (p.lastShot || 0) < RELOAD_MS - 150) return; // small grace for latency
    p.lastShot = now;
    const color = (typeof data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.color)) ? data.color : '#ff3bd0';
    const y = typeof data.y === 'number' ? data.y : 0.5;
    io.to(r.code).emit('blast', { x: data.x, y, z: data.z, color });

    let hit = null, best = 1.4; // blast radius (metres)
    for (const h of r.hiders()) {
      if (h.found) continue;
      const d = Math.hypot(h.body.x - data.x, h.body.z - data.z);
      if (d < best) { best = d; hit = h; }
    }
    if (hit) {
      hit.found = true;
      const huntMs = r.huntMs || r.settings.huntTime * 1000;
      const msLeft = Math.max(0, r.deadline - now);
      p.score += 60 + Math.round((msLeft / huntMs) * 40);
      hit.score += Math.round(((huntMs - msLeft) / huntMs) * 50);
      if (r.settings.mode === 'infection') { hit.role = 'seeker'; hit.found = false; }
      io.to(r.code).emit('tagged', { id: hit.id, name: hit.name, by: p.name });
      broadcast(r);
      maybeEndEarly(r);
    } else {
      io.to(socket.id).emit('miss', {});
    }
  });

  // Hider whistles on purpose (taunt) — betrays them now, but resets the 45s
  // auto-whistle countdown AND earns bonus points (bravery pays). The bonus
  // is rate-limited so it can't be farmed by spamming.
  socket.on('whistle', () => {
    const r = room();
    const p = me();
    if (!r || !p || p.role !== 'hider' || p.found || r.phase !== 'hunt') return;
    const now = Date.now();
    if (now - (p.lastWhistle || 0) < 2000) return;
    p.lastWhistle = now;
    p.nextWhistle = now + WHISTLE_EVERY;
    let bonus = 0;
    if (now - (p.lastWhistleBonus || 0) >= 15000) {
      p.lastWhistleBonus = now;
      bonus = 10;
      p.score += bonus;
      scheduleBroadcast(r);
    }
    io.to(r.code).emit('whistle', { id: p.id, x: p.body.x, y: p.body.y || 0, z: p.body.z, auto: false, bonus });
    alertBotSeekers(r, p.body.x, p.body.z);
  });

  // Seeker reports its position (for spectators' minimaps). Privacy is handled
  // in snapshot() — only caught spectators get the seeker dot.
  socket.on('seekmove', ({ x, y, z, ry, pose }) => {
    const r = room();
    const p = me();
    if (!r || !p || p.role !== 'seeker' || r.phase !== 'hunt') return;
    if (typeof x === 'number' && typeof z === 'number') {
      const [cx, cz] = clampToRoom(r.map, x, z);
      p.body.x = cx; p.body.z = cz;
    }
    if (typeof y === 'number') p.body.y = Math.max(-2, Math.min(20, y));
    if (typeof ry === 'number') p.body.ry = ry;
    if (POSES.includes(pose)) p.body.pose = pose;   // peeking kneel is visible
    scheduleBroadcast(r);
  });

  // Player presses Next on the scoreboard; the round advances once all have.
  socket.on('next', () => {
    const r = room();
    const p = me();
    if (!r || !p || r.phase !== 'roundover') return;
    p.ready = true;
    broadcast(r);
    maybeAdvance(r);
  });

  socket.on('emote', ({ emoji }) => {
    const r = room();
    const p = me();
    if (!r || !p) return;
    io.to(r.code).emit('emote', { id: socket.id, name: p.name, emoji });
  });

  socket.on('leave', () => cleanup());
  socket.on('disconnect', () => cleanup());

  function cleanup() {
    const r = room();
    if (!r) return;
    const leaver = r.players.get(socket.id);
    r.removePlayer(socket.id);
    if (r.humans().length === 0) {   // only bots (or nobody) left — close it
      stopBots(r);
      store.delete(r.code);
    } else {
      // Tell everyone who left, then re-check whether the round can even
      // continue (e.g. the only seeker or last hider just walked out).
      if (leaver) {
        io.to(r.code).emit('playerleft', { name: leaver.name, role: leaver.role });
      }
      maybeEndEarly(r);
      maybeAdvance(r);   // the leaver may have been the last un-ready player
      broadcast(r);
    }
    roomCode = null;
  }
});

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

httpServer.listen(PORT, () => {
  console.log(`Doodle Guys running at http://localhost:${PORT}`);
});
