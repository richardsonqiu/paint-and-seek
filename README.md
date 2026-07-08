# 🦎 Doodle Guys

**Blend in. Don't get caught.**

A browser-based, mobile-first **3D** multiplayer camouflage hide-and-seek party game — a faithful homage to *Meccha Chameleon*. Hiders are plain **white chameleon mannequins** who freehand-paint their own bodies to melt into the scenery, strike a pose, and freeze. The seeker prowls in **first-person** with a paint gun — but **every missed shot costs paint**, and an empty gun means the chameleons win.

No download, no install — just open a link or share a 4-letter room code. Plays great on a phone.

---

## Play

```bash
npm install
npm start
```

Open **http://localhost:3000** on your phone and computer (same network), create a room, and share the code. Need 2+ players (solo works for testing).

> Set `PORT` to change the port: `PORT=8080 npm start`

## How a round works

1. **Lobby** — players join by code, host picks map / mode / timers / whistle.
2. **Hide (prep)** — *hiders* roam the map in third person, **tap any surface to eyedrop its exact on-screen colour**, then drag on their own body to paint it. Pick a pose — stand 🧍, crouch, curl into a ball 🥚, lie flat 🛌, or **flatten against a wall** (the picture-frame trick) — and hold still. *Seekers* are locked out, watching a countdown.
3. **Seek (hunt)** — the *seeker* hunts in first-person and **shoots paintballs** to catch chameleons. A hit catches them; a **miss costs 1 of 5 paint charges** — run dry and you're eliminated. Hiders can still creep around… but movement is the #1 tell.
4. **Reveal** — when the round ends, golden beacons mark where every survivor was hiding (the laugh moment), then the scoreboard.

**The whistle:** every hider auto-whistles every **45 seconds**, betraying their position by sound. Whistling manually (button / key `1`) resets the countdown — whistle while the seeker is far away so you're silent when it's near.

**Scoring:** hiders earn points for surviving (partial credit by survival time if caught); seekers earn per catch plus an early-catch bonus, and a bonus for clearing everyone. Roles reshuffle each round.

### Controls

| | Hider | Seeker |
| --- | --- | --- |
| Move | WASD / joystick (camera-relative) | WASD / joystick |
| Look | drag / mouse | drag / mouse |
| Paint | drag on your body · tap world = eyedropper | — |
| Jump | Space / ⤴ | Space / ⤴ |
| Wall-flatten | E / 🧗 near a wall (climb up/down/sideways) | — |
| Whistle | `1` / 😗 (hunt phase) | — |
| Shoot | — | tap / click (1s reload) |

### Game modes
- **Classic** — the seeker must find every hider before time runs out.
- **Infection** — a caught hider switches sides and joins the hunt; last one hidden wins.

### Maps
The Flats · Mega City · The Grounds

## Tech

| Layer | Choice |
| --- | --- |
| Server | Node.js + Express + **Socket.io** (server-authoritative state machine) |
| Client | **Three.js / WebGL** + vanilla JS, no build step (Three loads from CDN via importmap) |
| Shared | `shared/maps.js` 3D map definitions imported by both client & server |

```
server/
  index.js   — Express + Socket.io wiring, phase engine, shoot/whistle/score logic
  rooms.js   — Room model, role assignment, seeker HP, state snapshots
shared/
  maps.js    — map definitions + poses + spawn logic (shared)
public/
  index.html · style.css · game.js  — the mobile-first client
```

Server is authoritative for role assignment, phase transitions, catch validation, seeker paint charges, the auto-whistle clock, and scoring. Painting and movement are client-driven and broadcast.

## Roadmap

See [`PRD.md`](./PRD.md) for the product spec. Not yet built: Double mode (everyone seeks at once), decoy clones, metallic/roughness paint sliders, randomized prop placement per round, Workshop-style custom maps.

## License

MIT
