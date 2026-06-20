// Room + game-state management for Doodle Guys.
// Server is authoritative for: role assignment, phase transitions,
// tag validation, and scoring. Movement/painting during prep is
// client-driven and broadcast.

import { MAPS } from '../shared/maps.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars

// Character footprint per pose, in world units (1000x1000 space).
export const POSE_BOX = {
  standing: { w: 64, h: 120 },
  crouching: { w: 84, h: 84 },
  flat: { w: 124, h: 52 },
};
export const POSES = Object.keys(POSE_BOX);

export const DEFAULT_SETTINGS = {
  prepTime: 60,
  huntTime: 120,
  map: 'living_room',
  mode: 'classic', // 'classic' | 'infection'
  rounds: 3,
};

export class Room {
  constructor(code) {
    this.code = code;
    this.hostId = null;
    this.players = new Map(); // id -> player
    this.settings = { ...DEFAULT_SETTINGS };
    this.phase = 'lobby'; // lobby | prep | hunt | roundover
    this.round = 0;
    this.deadline = 0; // epoch ms for current phase end
    this._timer = null;
  }

  addPlayer(id, name, avatar) {
    const isFirst = this.players.size === 0;
    if (isFirst) this.hostId = id;
    this.players.set(id, {
      id,
      name: name || 'Doodler',
      avatar: avatar || '🙂',
      role: null,
      connected: true,
      score: 0,
      found: false,
      // body lives in 1000x1000 world space
      body: {
        x: 500,
        y: 500,
        pose: 'standing',
        segments: { head: '#ffffff', torso: '#ffffff', legs: '#ffffff' },
      },
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
    return MAPS[this.settings.map] || MAPS.living_room;
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

  // Assign roles for a round. ~1 seeker per 3 players, min 1.
  assignRoles() {
    const players = this.activePlayers();
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const seekerCount = Math.max(1, Math.floor(players.length / 3));
    shuffled.forEach((p, i) => {
      p.role = i < seekerCount ? 'seeker' : 'hider';
      p.found = false;
      // reset hiders to blank white at the map's spawn-ish center
      if (p.role === 'hider') {
        p.body = {
          x: 200 + Math.random() * 600,
          y: 250 + Math.random() * 500,
          pose: 'standing',
          segments: { head: '#ffffff', torso: '#ffffff', legs: '#ffffff' },
        };
      }
    });
  }

  bodyBox(player) {
    const box = POSE_BOX[player.body.pose] || POSE_BOX.standing;
    return {
      x: player.body.x - box.w / 2,
      y: player.body.y - box.h / 2,
      w: box.w,
      h: box.h,
    };
  }

  // Returns the topmost un-found hider hit by a tap, or null.
  hiderAt(x, y) {
    const hits = this.hiders().filter((p) => {
      if (p.found) return false;
      const b = this.bodyBox(p);
      return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    });
    return hits.length ? hits[hits.length - 1] : null;
  }

  remainingHiders() {
    return this.hiders().filter((p) => !p.found);
  }

  // Public snapshot. `forId` controls visibility:
  // during prep, hiders only see themselves; seekers see nothing on-map.
  // during hunt, un-found hiders are sent to everyone (they're frozen and
  // the challenge is spotting them); found hiders are flagged revealed.
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
      myRole: me ? me.role : null,
      myId: forId,
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
