// Room + game-state management for Doodle Guys (3D).
// Server is authoritative for: role assignment, phase transitions, tag
// validation, and scoring. Movement/painting during prep is client-driven
// and broadcast. Tagging is by target id — the seeker's client raycasts the
// 3D scene to find who they tapped; the server validates state.

import { MAPS, POSES, spawnPoints, roomSpawns, clampToRoom, DEFAULT_MAP_ID } from '../shared/maps.js';

function shuffle(a) { return [...a].sort(() => Math.random() - 0.5); }

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars

// Body shapes the client can render (see game.js SHAPE definitions).
const BODY_SHAPES = ['egg', 'buddy', 'bean', 'bobo'];

// Bot hiders for small lobbies: they wander to a hiding spot during prep,
// strike a pose, and freeze. They never seek and are always "ready".
const BOT_NAMES = ['Botty', 'Eggbert', 'Blobby', 'Scribbles', 'Splat', 'Crayon', 'Smudge', 'Doodle'];

export { POSES };

export const DEFAULT_SETTINGS = {
  prepTime: 30,     // hide phase
  huntTime: 45,     // seek time PER HIDER — 3 hiders = 135s of hunting
  map: DEFAULT_MAP_ID,
  mode: 'classic', // 'classic' | 'infection'
  rounds: 3,       // bumped up at start so every player seeks at least once
  seekers: 1,      // seekers per round; everyone else hides
  bots: 0,         // bot hiders (great for solo play)
  whistle: true,   // hiders auto-whistle every 30s (manual whistle resets it)
};

export const SEEKER_HP = 5;       // missed shots cost health — no spam-shooting
export const WHISTLE_EVERY = 30000;

function blankBody(spawn) {
  return {
    x: spawn ? spawn[0] : 0,
    y: 0,
    z: spawn ? spawn[2] : 0,
    ry: 0, // yaw, radians
    pose: 'standing',
    paint: null, // data-URL of the painted skin texture (null = blank white)
  };
}

export class Room {
  constructor(code) {
    this.code = code;
    this.hostId = null;
    this.players = new Map();
    this.settings = { ...DEFAULT_SETTINGS };
    this.phase = 'lobby';
    this.round = 0;
    this.deadline = 0;
    this._timer = null;
    this.totalRounds = this.settings.rounds;
    this.seekerQueue = [];  // ids yet to take a seeker turn this cycle
  }

  addPlayer(id, name, avatar, shape) {
    if (this.players.size === 0) this.hostId = id;
    this.players.set(id, {
      id,
      name: name || 'Doodler',
      avatar: avatar || '🙂',
      shape: BODY_SHAPES.includes(shape) ? shape : 'egg',
      role: null,
      connected: true,
      score: 0,
      found: false,
      body: blankBody(),
    });
    return this.players.get(id);
  }

  removePlayer(id) {
    this.players.delete(id);
    if (id === this.hostId) {
      const next = [...this.players.values()].find((p) => !p.isBot);  // never a bot host
      this.hostId = next ? next.id : null;
    }
  }

  humans() {
    return this.activePlayers().filter((p) => !p.isBot);
  }

  // Keep exactly `n` bots in the room (host adjusts this in the lobby).
  syncBots(n) {
    const bots = [...this.players.values()].filter((p) => p.isBot);
    for (let i = bots.length; i < n; i++) {
      this._botSeq = (this._botSeq || 0) + 1;
      const id = `bot-${this.code}-${this._botSeq}`;
      this.players.set(id, {
        id,
        name: BOT_NAMES[(this._botSeq - 1) % BOT_NAMES.length],
        avatar: '🤖',
        shape: BODY_SHAPES[Math.floor(Math.random() * BODY_SHAPES.length)],
        role: null,
        connected: true,
        isBot: true,
        score: 0,
        found: false,
        body: blankBody(),
      });
    }
    for (let i = bots.length - 1; i >= n; i--) this.players.delete(bots[i].id);
  }

  get map() {
    return MAPS[this.settings.map] || MAPS[DEFAULT_MAP_ID];
  }

  activePlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }
  hiders() {
    return this.activePlayers().filter((p) => p.role === 'hider');
  }
  seekers() {
    return this.activePlayers().filter((p) => p.role === 'seeker');
  }
  activeSeekers() {
    return this.seekers().filter((p) => !p.out);
  }

  // Seekers per round: the host's setting, clamped so at least 1 hider is
  // always left over (a solo host with no bots gets a 0-seeker practice
  // round). Bots take seeker turns too — a simple hunt AI drives them — so
  // playing with bots still rotates YOU through hiding rounds.
  seekerCount() {
    const n = this.activePlayers().length;
    return Math.min(Math.max(1, this.settings.seekers || 1), Math.max(0, n - 1));
  }

  // Round-robin rotation with two guarantees:
  //  1. Everyone takes a seeker turn before anyone repeats (a queue of ids
  //     persists across rounds; each round pops the next N and it only
  //     refills once empty — 4 players with 1 seeker is a clean 4-round
  //     cycle, no doubles).
  //  2. Nobody is seeker twice IN A ROW: when a new cycle starts, last
  //     round's seekers are placed at the BACK of the queue, so a repeat can
  //     only happen when it's mathematically unavoidable (e.g. 1 human, or
  //     seekers-per-round > other players).
  drawSeekers(players, count) {
    const ids = new Set(players.map((p) => p.id));
    this.seekerQueue = this.seekerQueue.filter((id) => ids.has(id)); // drop leavers
    const last = this.lastSeekerIds || new Set();
    const picked = new Set();
    while (picked.size < count) {
      if (this.seekerQueue.length === 0) {
        const remaining = players.map((p) => p.id).filter((id) => !picked.has(id));
        if (!remaining.length) break;   // safety: fewer players than seats
        const fresh = shuffle(remaining.filter((id) => !last.has(id)));
        const justSeeked = shuffle(remaining.filter((id) => last.has(id)));
        this.seekerQueue = [...fresh, ...justSeeked];
      }
      picked.add(this.seekerQueue.shift());
    }
    this.lastSeekerIds = new Set(picked);
    return picked;
  }

  assignRoles() {
    const players = this.activePlayers();
    const seekerIds = this.drawSeekers(players, this.seekerCount());
    // Put seekers in one room and hiders in the other rooms, at random spots,
    // so a hider never spawns right next to a seeker.
    const rooms = roomSpawns(this.map);
    const seekerRoom = Math.floor(Math.random() * rooms.length);
    const hiderRoomIdx = rooms.length > 1
      ? [...rooms.keys()].filter((i) => i !== seekerRoom) : [...rooms.keys()];
    const seekerSpawns = shuffle(rooms[seekerRoom]);
    const hiderSpawns = shuffle(hiderRoomIdx.flatMap((i) => rooms[i]));
    let si = 0, hi = 0;
    players.forEach((p) => {
      p.role = seekerIds.has(p.id) ? 'seeker' : 'hider';
      p.found = false;
      p.hp = SEEKER_HP;            // seekers lose 1 per missed shot
      p.out = false;               // seeker eliminated by too many misses
      p.nextWhistle = 0;           // hider auto-whistle deadline (set at hunt start)
      const spawn = p.role === 'seeker'
        ? seekerSpawns[si++ % seekerSpawns.length]
        : hiderSpawns[hi++ % hiderSpawns.length];
      p.body = blankBody(spawn);
    });
  }

  remainingHiders() {
    return this.hiders().filter((p) => !p.found);
  }

  // Validate and apply a tag by target id.
  tagById(targetId) {
    const t = this.players.get(targetId);
    if (!t || !t.connected || t.role !== 'hider' || t.found) return null;
    return t;
  }

  snapshot(forId) {
    const me = this.players.get(forId);
    const bodies = [];
    if (this.phase === 'prep') {
      if (me && me.role === 'hider') {
        bodies.push({ ...me.body, id: me.id, found: false, mine: true });
      }
    } else if (this.phase === 'hunt' || this.phase === 'roundover') {
      for (const h of this.hiders()) {
        bodies.push({
          ...h.body,
          id: h.id,
          name: h.name,
          shape: h.shape,
          found: h.found,
          mine: h.id === forId,
        });
      }
      // Seekers are visible in-world to everyone (the tiny hiders watch the
      // big hunter prowl past) — third-person for the seeker themself too.
      for (const s of this.seekers()) {
        bodies.push({
          x: s.body.x, y: s.body.y || 0, z: s.body.z, ry: s.body.ry || 0,
          pose: s.body.pose || 'standing', paint: null,
          id: s.id, name: s.name, shape: s.shape, found: false, seeker: true,
          bot: !!s.isBot,   // the host's client drives bot seekers
          mine: s.id === forId,
        });
      }
    }
    const map = this.map;
    // Minimap dots: only revealed to a CAUGHT spectator (or at round end), so
    // active hiders can't peek at where the seeker is.
    const spectating = !!(me && me.role === 'hider' && me.found) || this.phase === 'roundover';
    let dots = [];
    if (spectating && this.phase !== 'lobby') {
      dots = this.activePlayers().map((p) => ({
        x: p.body.x, z: p.body.z, role: p.role, found: !!p.found,
        name: p.name, mine: p.id === forId,
      }));
    }
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      totalRounds: this.phase === 'lobby' ? this.settings.rounds : this.totalRounds,
      deadline: this.deadline,
      now: Date.now(),
      settings: this.settings,
      mapId: this.settings.map,
      mapSize: map.size,
      myRole: me ? me.role : null,
      myId: forId,
      myBody: me ? me.body : null, // both roles get a server-assigned spawn
      bodies,
      spectating,
      dots,
      remaining: this.remainingHiders().length,
      totalHiders: this.hiders().length,
      players: this.activePlayers().map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        role: this.phase === 'lobby' ? null : p.role,
        score: p.score,
        found: p.found,
        hp: p.hp,
        out: p.out,
        ready: !!p.ready,
        isBot: !!p.isBot,
        isHost: p.id === this.hostId,
      })),
    };
  }
}

export class RoomStore {
  constructor() {
    this.rooms = new Map();
  }
  newCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () =>
        CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
      ).join('');
    } while (this.rooms.has(code));
    return code;
  }
  create() {
    const code = this.newCode();
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }
  get(code) {
    return this.rooms.get((code || '').toUpperCase());
  }
  delete(code) {
    const room = this.rooms.get(code);
    if (room && room._timer) clearTimeout(room._timer);
    if (room && room._whistler) clearInterval(room._whistler);
    if (room && room._pump) clearInterval(room._pump);
    if (room && room._botTick) clearInterval(room._botTick);
    this.rooms.delete(code);
  }
}

export { clampToRoom };
