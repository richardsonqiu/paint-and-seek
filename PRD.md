# Product Requirements Document — **Doodler Guys**

> *Blend in. Don't get caught.*
>
> A browser-based, mobile-first 3D multiplayer camouflage hide-and-seek party game — a faithful homage to **Meccha Chameleon** (lemorion_1224 / Haganeiro, Steam 2026).

## 1. Overview

Doodler Guys splits players into **Hiders** (white chameleon mannequins) and a minority of **Seekers**. Hiders freehand-paint their own bodies with colours eyedropped from the environment, pick a silhouette-breaking pose, and freeze. Seekers hunt in first-person with a paint gun — but **every missed shot costs paint**, and running dry eliminates the seeker. Runs entirely in the browser — no download — with mobile-first touch controls and room-code joining.

## 2. Fidelity pillars (what makes it feel like Meccha Chameleon)

1. **Freehand body-painting** with a world-colour eyedropper and a deliberately tight hide timer. No auto-camouflage — invisibility is pure paint skill.
2. **Pose system**: stand · crouch · ball · lie flat · **wall-flatten** (the "picture frame trick", climbable up/down/sideways).
3. **Miss-costs-paint seeker gun** (5 charges) — forces close inspection instead of spam-shooting.
4. **Whistle system**: hiders auto-whistle every 45 s (positional audio); a manual whistle resets the countdown.
5. **White→red hider icon HUD** and a **round-end reveal** of every survivor's hiding spot (golden beacons) before the scoreboard.
6. **Locked seeker spawn** during the hide phase.

## 3. Core loop

```
Host creates room → players join by code/link
  → roles assigned (~1 seeker per 3 players, reshuffled per round)
  → HIDE: hiders roam/paint/pose; seekers see a locked countdown screen
  → SEEK: seeker hunts first-person, shoots to catch; misses cost paint
  → REVEAL: beacons mark survivors' spots → scores → next round
```

Wins: seeker clears everyone → seekers win; ≥1 hider survives (or all seekers run dry) → hiders win.

## 4. Painting (core mechanic)

- **Eyedropper** — tap the world to sample the exact on-screen colour (with lighting/fog baked in).
- **Brush** — drag directly on your own 3D body; 3 brush sizes; palette + full colour picker; fill-all bucket.
- Painting allowed during hide **and** seek phases (repainting mid-hunt is legal but movement is the #1 tell).
- *(Roadmap: metallic/roughness sliders, undo, saved swatches.)*

## 5. Roles & controls

- **Hider** (third-person): camera-relative move (WASD/joystick), jump, wall-flatten (E), whistle (1), paint by touch.
- **Seeker** (first-person): move, jump, tap to shoot (1 s reload), 5 paint charges, out-of-paint = eliminated.
- Caught hiders free-roam as spectators with a minimap of all players.

## 6. Modes

- **Classic** — find all hiders before time runs out.
- **Infection** — caught hiders join the seekers; last hider standing wins.
- *(Roadmap: Double — everyone hides, then everyone seeks.)*

## 7. Scoring

- Hider: +100 per round survived; partial credit by survival time if caught.
- Seeker: +60 per catch + up to +40 early-catch bonus; +100 split for clearing everyone.

## 8. UX / presentation

Bright chunky party-game UI (rounded type, thick outlines, banners, confetti), role-reveal banners, tick-down timer, emotes, WebAudio SFX (whistle, shots, splats, fanfares). Portrait & landscape, 44 px+ tap targets, `touch-action: none` stage.

## 9. Technical

- Frontend: Three.js (CDN importmap) + vanilla JS, no build step; BVH-accelerated collision raycasts.
- Multiplayer: Socket.io, server-authoritative (roles, phases, catch validation, seeker HP, whistle clock, scoring).
- Shared map definitions imported by client and server.

## 10. Out of scope (v1)

Voice chat, decoy clones, randomized prop placement, map editor/Workshop, accounts, monetization, native apps.

---

*Design reference researched from the Steam page, Wikipedia, EN/JP wikis and guides for Meccha Chameleon.*
