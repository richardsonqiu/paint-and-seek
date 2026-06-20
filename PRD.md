# Product Requirements Document — **Doodle Guys**

> *Draw yourself invisible.*
>
> A browser-based, mobile-first multiplayer paint-and-seek party game, inspired by Meccha Chameleon.

## 1. Overview

Doodle Guys splits players into **Hiders** and **Seekers**. Hiders start as plain white "doodlers" and must paint themselves to blend into the environment, pick a hiding spot and pose, then freeze before Seekers come hunting. Runs entirely in the browser — no download — with mobile-first touch controls and room-code joining.

## 2. Name & branding

- **Name:** Doodle Guys
- **Tagline:** *Draw yourself invisible.*
- Characters are called **Doodlers**; room codes look like `QTDZ`.

## 3. Target platform

- Primary: mobile browser (iOS Safari, Android Chrome), portrait & landscape.
- Secondary: desktop browser.
- No download, no account. Join by 4-letter code or shared link. Low-bandwidth, 2D rendering.

## 4. Core loop

```
Host creates room → players join by code/link
  → roles assigned (Hiders / Seekers)
  → PREP: hiders explore, paint, pose, freeze
  → HUNT: seekers scan & tag; hiders hold still
  → round ends → scores → next round (roles reshuffle)
```

## 5. Features

### Lobby & rooms
Create/join by 4-char code, share link (`/?room=CODE`), player list, host controls, 2–12 players, guest play with emoji avatar.

### Roles
Auto ratio (~1 seeker per 3 players, min 1), reshuffled each round, animated role reveal.

### Phases
- **Prep** (default 60s, 20–120s): hiders move/paint/pose; seekers see a waiting screen.
- **Hunt** (default 120s, 30–240s): seekers tap-to-tag; hiders frozen. Ends early when all found.

### Painting (core mechanic)
- **Eyedropper** — tap the map to sample an exact surface color.
- **Color wheel** — native color input per segment.
- **Per-segment** painting (head / body / legs) + **Fill All**.
- *(Roadmap: gradients, pattern stamps, opacity.)*

### Poses
Standing, crouching, flat *(roadmap: curled, hanging)* — pick a silhouette that matches nearby objects.

### Seeker
Tap a doodler to tag. Hunt shapes, not just colors. *(Roadmap: optional suspicion hints.)*

### Game modes
- **Classic** — find all hiders before time runs out.
- **Infection** — caught hiders join the seekers; last hider standing wins.
- *(Roadmap: Blitz, Solo, Ranked.)*

### Scoring & progression
- Hider: +100 per round survived; partial credit by survival time if caught.
- Seeker: +60 per tag + up to +40 early-tag time bonus; +100 for clearing everyone.
- *(Roadmap: XP, levels, cosmetics — no pay-to-win.)*

### Social
Quick emoji reactions during hunt; toast notifications on tags. *(Roadmap: replays, spectator mode.)*

### Host settings
Map · Mode · Prep time · Hunt time · Rounds per session.

## 6. Mobile UX
Portrait-first, 44px+ tap targets, drag-to-move, tap-to-eyedrop, tap-to-tag, no keyboard required, `touch-action: none` on stage, works on weak networks.

## 7. Technical
- Frontend: HTML5 Canvas + vanilla JS, no build step.
- Multiplayer: Socket.io over WebSockets, server-authoritative state.
- Shared map definitions imported by client and server.
- *(Roadmap: PWA install, reconnection, persistence.)*

## 8. Out of scope (v1)
Voice chat, custom map editor, monetization, native apps, 3D, accounts.

## 9. MVP (built)
Room create/join · 3 maps · Classic + Infection · eyedropper + color wheel + per-segment + Fill All · 3 poses · tap-to-tag · scoring · round flow · mobile-responsive layout.

## 10. Maps (v1)
Living Room · Aquarium · Art Gallery.

---

*Sources researched: Meccha Chameleon (Steam), official how-to-play guides, and community wikis.*
