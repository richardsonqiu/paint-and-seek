// Room + game-state management for Doodle Guys (3D).
// Server is authoritative for: role assignment, phase transitions, tag
// validation, and scoring. Movement/painting during prep is client-driven
// and broadcast. Tagging is by target id — the seeker's client raycasts the
// 3D scene to find who they tapped; the server validates state.

import { MAPS, POSES, spawnPoints, clampToRoom, DEFAULT_MAP_ID } from '../shared/maps.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars

export { POSES };

export const DEFAULT_SETTINGS = {
  prepTime: 60,
  huntTime: 120,
  map: DEFAULT_MAP_ID,
  mode: 'classic', // 'classic' | 'infection'
  rounds: 3,
};

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
  }

  addPlayer(id, name, avatar) {
    if (this.players.size === 0) this.hostId = id;
    this.players.set(id, {
      id,
      name: name || 'Doodler',
      avatar: avatar || '🙂',
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
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
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

  assignRoles() {
    const players = this.activePlayers();
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    // ~1 seeker per 3 players, but always leave at least 1 hider so a solo
    // host can test (1 player -> 0 seekers, 1 hider).
    const seekerCount = Math.min(
      Math.max(1, Math.floor(players.length / 3)),
      Math.max(0, players.length - 1)
    );
    const spawns = spawnPoints(this.map);
    let hiderIdx = 0;
    shuffled.forEach((p, i) => {
      p.role = i < seekerCount ? 'seeker' : 'hider';
      p.found = false;
      if (p.role === 'hider') {
        p.body = blankBody(spawns[hiderIdx % spawns.length]);
        hiderIdx++;
      }
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
          found: h.found,
          mine: h.id === forId,
        });
      }
    }
    const map = this.map;
    return {
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      totalRounds: this.settings.rounds,
      deadline: this.deadline,
      now: Date.now(),
      settings: this.settings,
      mapId: this.settings.map,
      mapSize: map.size,
      myRole: me ? me.role : null,
      myId: forId,
      myBody: me && me.role === 'hider' ? me.body : null,
      bodies,
      remaining: this.remainingHiders().length,
      totalHiders: this.hiders().length,
      players: this.activePlayers().map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        role: this.phase === 'lobby' ? null : p.role,
        score: p.score,
        found: p.found,
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
    this.rooms.delete(code);
  }
}

export { clampToRoom };
