// Doodle Guys — game server.
// Express serves the static client; Socket.io drives real-time rooms.

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { RoomStore, POSES, clampToRoom, WHISTLE_EVERY, HUNT_PER_HIDER, MAX_PLAYERS } from './rooms.js';
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

// Dev-only: authoring endpoint for the lobby map thumbnails. The client's
// __snapimg debug helper POSTs a canvas JPEG here; only accepts local
// connections and simple map-id filenames.
app.post('/dev/snapshot', express.json({ limit: '4mb' }), async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!/^(::1|::ffff:127\.|127\.)/.test(ip)) return res.status(403).json({ ok: false });
  const { id, dataUrl } = req.body || {};
  if (!/^[a-z0-9-]{1,24}$/.test(id || '') || !/^data:image\/jpeg;base64,/.test(dataUrl || '')) {
    return res.status(400).json({ ok: false });
  }
  const { writeFile, mkdir } = await import('fs/promises');
  const dir = join(ROOT, 'public', 'img', 'maps');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.jpg`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
const RELOAD_MS = 3000;   // paint-gun reload; shots themselves are free
// The 'quickdraw' twist swaps the reload for a snappy one — room-dependent.
const reloadFor = (room) => (room.settings.modifier === 'quickdraw' ? 1200 : RELOAD_MS);
const MODIFIERS = ['none', 'tiny', 'disco', 'quickdraw'];

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
// Each bot has a hiding STYLE (hashed from its id, a stable personality):
// sneaky bots favour silhouette-breaking ground poses and stray further off
// the spawn spot; bolder ones stand about closer to the open areas.
const BOT_POSES_SNEAKY = ['flat', 'ball', 'star', 'kneel', 'curl'];
const BOT_POSES_BOLD = ['standing', 'head', 'cheer', 'zombie'];
function botHash(id, salt) {
  let h = 2166136261;
  const str = id + ':' + salt;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 8) % 1000) / 1000;
}
function startBotHiding(room) {
  stopBots(room);
  const bots = room.activePlayers().filter((p) => p.isBot && p.role === 'hider');
  if (!bots.length) return;
  const pts = spawnPoints(room.map);
  for (const b of bots) {
    const sneaky = botHash(b.id, 'sneak');            // 0 = showoff, 1 = ninja
    const wander = 1 + sneaky * 2.5;                  // sneaks stray further off-spot
    const t = pts[Math.floor(Math.random() * pts.length)];
    const [tx, tz] = clampToRoom(room.map,
      t[0] + (Math.random() * 2 - 1) * wander,
      t[2] + (Math.random() * 2 - 1) * wander);
    b.botTarget = { x: tx, z: tz };
    const pool = Math.random() < sneaky ? BOT_POSES_SNEAKY : BOT_POSES_BOLD;
    b.botPose = pool[Math.floor(Math.random() * pool.length)];
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

// ---- Bot seeker plumbing --------------------------------------------------
// Bot seekers are DRIVEN BY THE HOST'S CLIENT, not the server: only clients
// have the level geometry, so only they can walk bots through doorways
// (instead of through walls) and check true line-of-sight before a bot
// "spots" a hider. The server just validates and applies:
//   'botmove'  — host reports a bot seeker's position (clamped here)
//   'botshoot' — host asks a bot to fire; same reload + blast rules as a
//                human 'shoot', resolved server-side so scoring stays fair.
// If the host quits, host migration hands the AI to the next client.

// Resolve a paint blast at (x,z) from `shooter` — shared by human and bot
// shots: emits the blast, catches the nearest hider in radius, scores.
function resolveShot(room, shooter, x, y, z, color) {
  io.to(room.code).emit('blast', { x, y, z, color });
  let hit = null, best = 1.4; // blast radius (metres)
  for (const h of room.hiders()) {
    if (h.found) continue;
    const d = Math.hypot(h.body.x - x, h.body.z - z);
    if (d < best) { best = d; hit = h; }
  }
  if (!hit) {
    // No real hider in the blast — did they fall for a decoy? Popping one
    // jams the gun (+2s on top of the reload) and pays the decoy's owner.
    let dec = null, db = 1.4;
    for (const d of room.decoys || []) {
      const dd = Math.hypot(d.x - x, d.z - z);
      if (dd < db) { db = dd; dec = d; }
    }
    if (dec) {
      room.decoys = room.decoys.filter((d) => d !== dec);
      const owner = room.players.get(dec.owner);
      if (owner) owner.score += 15;
      shooter.lastShot = Date.now() + 2000;
      io.to(room.code).emit('decoypop', {
        x: dec.x, y: dec.y, z: dec.z,
        byId: shooter.id, by: shooter.name, ownerId: dec.owner, owner: dec.ownerName,
      });
      scheduleBroadcast(room);
      return { decoy: true };
    }
    return null;
  }
  hit.found = true;
  const huntMs = room.huntMs || room.settings.huntTime * 1000;
  const msLeft = Math.max(0, room.deadline - Date.now());
  shooter.score += 60 + Math.round((msLeft / huntMs) * 40);
  hit.score += Math.round(((huntMs - msLeft) / huntMs) * 50);
  (room._catches ||= []).push({ by: shooter.name, dt: (Date.now() - (room.huntStartAt || Date.now())) / 1000 });
  if (room.settings.mode === 'infection') { hit.role = 'seeker'; hit.found = false; }
  io.to(room.code).emit('tagged', { id: hit.id, name: hit.name, by: shooter.name });
  broadcast(room);
  maybeEndEarly(room);
  return hit;
}

function enterHunt(room) {
  clearTimer(room);
  stopBots(room);
  room.phase = 'hunt';
  // Base seek time + extra per additional hider (100s + 30s each by default).
  room.huntMs = (room.settings.huntTime + HUNT_PER_HIDER * Math.max(0, room.hiders().length - 1)) * 1000;
  room.deadline = Date.now() + room.huntMs;
  // Arm the auto-whistle: every hider betrays their position every 45s unless
  // they whistle manually first (which resets the countdown).
  const now = Date.now();
  for (const h of room.hiders()) h.nextWhistle = now + WHISTLE_EVERY;
  if (room.settings.whistle === 'auto') {   // manual/off: no auto-whistle ticker
    room._whistler = setInterval(() => tickWhistles(room), 1000);
  }
  startPump(room);
  broadcast(room);
  // Bot seekers: arm their reload; the host's client drives their movement.
  for (const p of room.activePlayers()) if (p.isBot && p.role === 'seeker') p.lastShot = now;
  room.huntStartAt = now;                 // catch times for the round awards
  room._danger = setInterval(() => tickDanger(room), 1000);
  room._timer = setTimeout(() => endRound(room, 'time'), room.huntMs);
}

// Danger pay: hiding is braver the closer the hunter prowls. Every second a
// hider spends within DANGER_RADIUS of an active seeker earns +2 — rewarding
// bold spots over corner-camping. The affected ids ride the snapshot so the
// client can show a "danger pay" chip.
const DANGER_RADIUS = 5;   // metres, scaled by the map's character scale
function tickDanger(room) {
  if (room.phase !== 'hunt') return;
  const rad = DANGER_RADIUS * (room.map.charScale || 1);
  const seekers = room.activeSeekers();
  const ids = new Set();
  for (const h of room.remainingHiders()) {
    if (seekers.some((s) => Math.hypot(s.body.x - h.body.x, s.body.z - h.body.z) < rad)) {
      h.score += 2;
      h.dangerSecs = (h.dangerSecs || 0) + 1;
      ids.add(h.id);
    }
  }
  const changed = ids.size || (room._dangerIds && room._dangerIds.size);
  room._dangerIds = ids;
  if (changed) scheduleBroadcast(room);
}

function tickWhistles(room) {
  if (room.phase !== 'hunt') return;
  const now = Date.now();
  for (const h of room.remainingHiders()) {
    if (now >= h.nextWhistle) {
      h.nextWhistle = now + WHISTLE_EVERY;
      io.to(room.code).emit('whistle', { id: h.id, x: h.body.x, y: h.body.y || 0, z: h.body.z, auto: true });
    }
  }
}

function endRound(room, reason) {
  clearTimer(room);
  if (room._whistler) { clearInterval(room._whistler); room._whistler = null; }
  if (room._danger) { clearInterval(room._danger); room._danger = null; }
  room._dangerIds = new Set();
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

  // Round awards for the scoreboard: the survivor who toughed out the most
  // danger-pay seconds, and the quickest catch of the round.
  const daring = [...survivors].sort((a, b) => (b.dangerSecs || 0) - (a.dangerSecs || 0))[0];
  const fastest = [...(room._catches || [])].sort((a, b) => a.dt - b.dt)[0];
  room.lastAwards = {
    sneakiest: daring ? { name: daring.name, secs: daring.dangerSecs || 0 } : null,
    fastestCatch: fastest ? { name: fastest.by, secs: Math.max(1, Math.round(fastest.dt)) } : null,
  };

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
    if (r.players.size >= MAX_PLAYERS) {
      // Humans outrank bots: evict one bot to make room, else reject.
      const bot = [...r.players.values()].find((p) => p.isBot);
      if (bot) { r.removePlayer(bot.id); r.settings.bots = Math.max(0, (r.settings.bots || 0) - 1); }
      else return cb && cb({ ok: false, error: 'Room is full' });
    }
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
    if (typeof patch.huntTime === 'number') s.huntTime = clamp(patch.huntTime, 30, 240); // base seconds
    if (typeof patch.rounds === 'number') s.rounds = clamp(patch.rounds, 1, 20);
    if (typeof patch.seekers === 'number') s.seekers = clamp(Math.round(patch.seekers), 1, 11);
    if (typeof patch.bots === 'number') {
      s.bots = clamp(Math.round(patch.bots), 0, 8);
      r.syncBots(s.bots);           // bots appear/disappear in the lobby list
    }
    if (patch.map) s.map = patch.map;
    if (patch.mode) s.mode = patch.mode;
    if (['auto', 'manual', 'off'].includes(patch.whistle)) s.whistle = patch.whistle;
    if (MODIFIERS.includes(patch.modifier)) s.modifier = patch.modifier;
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
    if (now - (p.lastShot || 0) < reloadFor(r) - 150) return; // small grace for latency
    p.lastShot = now;
    const color = (typeof data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.color)) ? data.color : '#ff3bd0';
    const y = typeof data.y === 'number' ? data.y : 0.5;
    const hit = resolveShot(r, p, data.x, y, data.z, color);
    if (!hit) io.to(socket.id).emit('miss', {});
  });

  // Hider whistles on purpose (taunt) — betrays them now, and earns bonus
  // points (bravery pays). In MANUAL mode there is no auto-whistle at all,
  // so the voluntary betrayal is worth a lot more. Rate-limited so the
  // bonus can't be farmed by spamming.
  socket.on('whistle', () => {
    const r = room();
    const p = me();
    if (!r || !p || p.role !== 'hider' || p.found || r.phase !== 'hunt') return;
    if (r.settings.whistle === 'off') return;   // silent-hiding mode
    const now = Date.now();
    if (now - (p.lastWhistle || 0) < 2000) return;
    p.lastWhistle = now;
    p.nextWhistle = now + WHISTLE_EVERY;
    let bonus = 0;
    if (now - (p.lastWhistleBonus || 0) >= 15000) {
      p.lastWhistleBonus = now;
      bonus = r.settings.whistle === 'manual' ? 30 : 10;
      p.score += bonus;
      scheduleBroadcast(r);
    }
    io.to(r.code).emit('whistle', { id: p.id, x: p.body.x, y: p.body.y || 0, z: p.body.z, auto: false, bonus });
  });

  // ---- Host-driven bot seekers (see resolveShot notes above) ----
  socket.on('botmove', ({ id, x, y, z, ry }) => {
    const r = room();
    if (!r || socket.id !== r.hostId || r.phase !== 'hunt') return;
    const b = r.players.get(id);
    if (!b || !b.isBot || b.role !== 'seeker') return;
    if (typeof x === 'number' && typeof z === 'number') {
      const [cx, cz] = clampPlay(r.map, x, z);
      b.body.x = cx; b.body.z = cz;
    }
    if (typeof y === 'number') b.body.y = Math.max(-2, Math.min(20, y));
    if (typeof ry === 'number') b.body.ry = ry;
    scheduleBroadcast(r);
  });

  // Host relocates a bot HIDER that the blind server placement wedged into
  // furniture (the host's client has the real geometry).
  socket.on('bothide', ({ id, x, y, z }) => {
    const r = room();
    if (!r || socket.id !== r.hostId || r.phase !== 'hunt') return;
    const b = r.players.get(id);
    if (!b || !b.isBot || b.role !== 'hider' || b.found) return;
    if (typeof x !== 'number' || typeof z !== 'number') return;
    const [cx, cz] = clampPlay(r.map, x, z);
    b.body.x = cx; b.body.z = cz;
    if (typeof y === 'number') b.body.y = Math.max(-2, Math.min(20, y));
    scheduleBroadcast(r);
  });

  socket.on('botshoot', ({ id, x, z }) => {
    const r = room();
    if (!r || socket.id !== r.hostId || r.phase !== 'hunt') return;
    const b = r.players.get(id);
    if (!b || !b.isBot || b.role !== 'seeker') return;
    if (typeof x !== 'number' || typeof z !== 'number') return;
    const now = Date.now();
    if (now - (b.lastShot || 0) < reloadFor(r) - 150) return; // same reload as humans
    b.lastShot = now;
    resolveShot(r, b, x, 0.5, z, '#ff3bd0');
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

  // Hider plants their one decoy of the round: a frozen copy of their body
  // (paint, pose, shape) at their CURRENT spot — then they sneak elsewhere.
  // Seekers (and bot seekers) see it exactly like a real hider.
  socket.on('decoy', () => {
    const r = room();
    const p = me();
    if (!r || !p || p.role !== 'hider' || p.found || p.decoyUsed) return;
    if (r.phase !== 'prep' && r.phase !== 'hunt') return;
    p.decoyUsed = true;
    r.decoys.push({
      id: 'decoy-' + p.id,
      x: p.body.x, y: p.body.y || 0, z: p.body.z, ry: p.body.ry || 0,
      pose: p.body.pose || 'standing', paint: p.body.paint, shape: p.shape,
      owner: p.id, ownerName: p.name,
    });
    broadcast(r);
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
