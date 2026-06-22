// Doodle Guys — game server.
// Express serves the static client; Socket.io drives real-time rooms.

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { RoomStore, POSES, clampToRoom } from './rooms.js';

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

// ---- Phase engine -------------------------------------------------------

function broadcast(room) {
  for (const id of room.players.keys()) {
    io.to(id).emit('state', room.snapshot(id));
  }
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
  room._timer = setTimeout(() => enterHunt(room), room.settings.prepTime * 1000);
}

function enterHunt(room) {
  clearTimer(room);
  room.phase = 'hunt';
  room.deadline = Date.now() + room.settings.huntTime * 1000;
  broadcast(room);
  room._timer = setTimeout(() => endRound(room, 'time'), room.settings.huntTime * 1000);
}

function endRound(room, reason) {
  clearTimer(room);
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

  room.deadline = Date.now() + 8000;
  broadcast(room);

  const isLastRound = room.round >= room.settings.rounds;
  room._timer = setTimeout(() => {
    if (isLastRound) {
      room.phase = 'lobby';
      room.round = 0;
      for (const p of room.players.values()) p.role = null;
      broadcast(room);
    } else {
      startRound(room);
    }
  }, 8000);
}

function maybeEndEarly(room) {
  if (room.phase === 'hunt' && room.remainingHiders().length === 0) {
    endRound(room, 'allfound');
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

  socket.on('create', ({ name, avatar }, cb) => {
    const r = store.create();
    roomCode = r.code;
    socket.join(r.code);
    r.addPlayer(socket.id, name, avatar);
    cb && cb({ ok: true, code: r.code });
    broadcast(r);
  });

  socket.on('join', ({ code, name, avatar }, cb) => {
    const r = store.get(code);
    if (!r) return cb && cb({ ok: false, error: 'Room not found' });
    if (r.phase !== 'lobby') return cb && cb({ ok: false, error: 'Game already started' });
    if (r.players.size >= 12) return cb && cb({ ok: false, error: 'Room is full' });
    roomCode = r.code;
    socket.join(r.code);
    r.addPlayer(socket.id, name, avatar);
    cb && cb({ ok: true, code: r.code });
    broadcast(r);
  });

  socket.on('settings', (patch) => {
    const r = room();
    if (!r || socket.id !== r.hostId || r.phase !== 'lobby') return;
    const s = r.settings;
    if (typeof patch.prepTime === 'number') s.prepTime = clamp(patch.prepTime, 20, 120);
    if (typeof patch.huntTime === 'number') s.huntTime = clamp(patch.huntTime, 30, 240);
    if (typeof patch.rounds === 'number') s.rounds = clamp(patch.rounds, 1, 10);
    if (patch.map) s.map = patch.map;
    if (patch.mode) s.mode = patch.mode;
    broadcast(r);
  });

  socket.on('start', () => {
    const r = room();
    if (!r || socket.id !== r.hostId || r.phase !== 'lobby') return;
    if (r.activePlayers().length < 1) return; // min 1 for easier testing
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
    // During the hunt, seekers must see hiders move, so broadcast to everyone.
    // During prep, only the actor needs the echo.
    if (r.phase === 'hunt') broadcast(r);
    else io.to(socket.id).emit('state', r.snapshot(socket.id));
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
      const msLeft = Math.max(0, r.deadline - Date.now());
      const timeBonus = Math.round((msLeft / (r.settings.huntTime * 1000)) * 40);
      p.score += 60 + timeBonus;
      // Caught hider gets partial survival credit.
      const elapsed = r.settings.huntTime * 1000 - msLeft;
      hit.score += Math.round((elapsed / (r.settings.huntTime * 1000)) * 50);
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
  // everyone), catches any hider within the blast radius, and reloads for 1s.
  socket.on('shoot', (data) => {
    const r = room();
    const p = me();
    if (!r || !p || p.role !== 'seeker' || r.phase !== 'hunt' || !data) return;
    if (typeof data.x !== 'number' || typeof data.z !== 'number') return;
    const now = Date.now();
    if (now - (p.lastShot || 0) < 1000) return; // 1s reload — no spam
    p.lastShot = now;
    const color = (typeof data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.color)) ? data.color : '#ff3bd0';
    const y = typeof data.y === 'number' ? data.y : 0.5;
    io.to(r.code).emit('blast', { x: data.x, y, z: data.z, color });

    let hit = null, best = 2.0; // blast radius (metres)
    for (const h of r.hiders()) {
      if (h.found) continue;
      const d = Math.hypot(h.body.x - data.x, h.body.z - data.z);
      if (d < best) { best = d; hit = h; }
    }
    if (hit) {
      hit.found = true;
      const msLeft = Math.max(0, r.deadline - now);
      p.score += 60 + Math.round((msLeft / (r.settings.huntTime * 1000)) * 40);
      const elapsed = r.settings.huntTime * 1000 - msLeft;
      hit.score += Math.round((elapsed / (r.settings.huntTime * 1000)) * 50);
      if (r.settings.mode === 'infection') { hit.role = 'seeker'; hit.found = false; }
      io.to(r.code).emit('tagged', { id: hit.id, name: hit.name, by: p.name });
      broadcast(r);
      maybeEndEarly(r);
    }
  });

  // Seeker reports its position (for spectators' minimaps). Privacy is handled
  // in snapshot() — only caught spectators get the seeker dot.
  socket.on('seekmove', ({ x, z, ry }) => {
    const r = room();
    const p = me();
    if (!r || !p || p.role !== 'seeker' || r.phase !== 'hunt') return;
    if (typeof x === 'number' && typeof z === 'number') {
      const [cx, cz] = clampToRoom(r.map, x, z);
      p.body.x = cx; p.body.z = cz;
    }
    if (typeof ry === 'number') p.body.ry = ry;
    broadcast(r);
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
    r.removePlayer(socket.id);
    if (r.players.size === 0) {
      store.delete(r.code);
    } else {
      // If a phase is mid-flight and nobody can advance it, re-check.
      maybeEndEarly(r);
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
