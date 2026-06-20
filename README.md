# 🎨 Doodle Guys

**Draw yourself invisible.**

A browser-based, mobile-first **3D** multiplayer *paint-and-seek* party game — inspired by Meccha Chameleon. Hiders start as blank white doodlers and **paint themselves to blend into the room**, pick a pose, and freeze. Seekers walk the room in **first-person** and tap whoever looks out of place before the timer runs out.

No download, no install — just open a link or share a 4-letter room code. Plays great on a phone.

---

## Play

```bash
npm install
npm start
```

Open **http://localhost:3000** on your phone and computer (same network), create a room, and share the code. Need 2+ players.

> Set `PORT` to change the port: `PORT=8080 npm start`

## How it works

A round flows through three phases:

1. **Lobby** — players join, host picks the map/mode/timers.
2. **Prep** — *hiders* roam the 3D room (joystick to move, drag to look), **tap a surface to eyedrop its real color** onto a body segment (head / body / legs), pick a **pose** (standing 🧍 / crouching 🧎 / flat 🛌), and freeze. *Seekers* wait and memorise the room.
3. **Hunt** — *seekers* walk in first-person (joystick + drag to look) and tap any doodler they think is hiding to **tag** them. *Hiders* hold still and pray.

**Scoring:** hiders earn points for surviving the round; seekers earn points per tag (plus a time bonus for early finds) and a bonus for clearing everyone. Roles reshuffle each round.

### Game modes
- **Classic** — seekers must find every hider before time runs out.
- **Infection** — a caught hider switches sides and joins the hunt; last one hidden wins.

### Maps
Living Room · Aquarium · Art Gallery

## Tech

| Layer | Choice |
| --- | --- |
| Server | Node.js + Express + **Socket.io** (server-authoritative state machine) |
| Client | **Three.js / WebGL** + vanilla JS, no build step (Three loads from CDN via importmap) |
| Shared | `shared/maps.js` 3D map definitions imported by both client & server |

```
server/
  index.js   — Express + Socket.io wiring, phase engine, tag/score logic
  rooms.js   — Room model, role assignment, state snapshots
shared/
  maps.js    — map/surface definitions + color sampling (shared)
public/
  index.html · style.css · game.js  — the mobile-first client
```

Server is authoritative for role assignment, phase transitions, tag validation, and scoring. Painting and movement during prep are client-driven and broadcast.

## Roadmap

See [`PRD.md`](./PRD.md) for the full product spec. Not yet built: more maps, gradient/pattern paint tools, additional poses, ranked mode, progression/cosmetics, PWA install, spectator mode.

## License

MIT
