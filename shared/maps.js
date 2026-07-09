// Shared 3D map definition for Doodle Guys.
//
// There is ONE big map ("The Grounds") built from the Kenney low-poly kits in
// /public/models. It is a walled compound divided into a 3x3 grid of themed
// rooms (connected by doorways) and packed with props so hiders have lots of
// places to blend in. Coordinate system: play area centred at the origin on
// the y=0 ground plane, +y up, units ~= metres (a doodler is ~1.8 tall).
//
// Authoring vocabulary (consumed by the client):
//   size      { x, z, h }                play bounds (h is nominal)
//   ground / sky                          colours
//   fog       { color, near, far }
//   kit                                   default Kenney kit folder
//   perimeter { model, kit?, s? }         wall tiled around the outer edge
//   walls     [ { from:[x,z], to:[x,z], model?, kit?, s?, doors:[[x,z]] } ]
//   models    [ piece ]                   hand-placed props / landmarks
//   scatter   [ group ]                   seeded random clusters of props
//
// piece   = { m, pos:[x,z], rot?, s?, y?, kit?, scale?, solid? }
// group   = { models:[name], kit?, count, seed, area:[minX,minZ,maxX,maxZ],
//             sMin?, sMax?, rotRandom?, solid? }
//
// A piece's footprint is dropped so its base rests on y=0 (plus optional `y`).
// `s` scales relative to the kit's calibrated base scale; `scale` overrides
// with an absolute value. `solid` adds it to the collision set.

// Mannequin poses (matching the Meccha Chameleon figure set): break the
// humanoid silhouette to imitate props. 'climb' is the wall-flatten
// ("picture frame trick").
export const POSES = ['standing', 'cheer', 'head', 'zombie', 'kneel', 'flat', 'ball', 'star', 'climb'];

const TOWN = 'kenney_fantasy-town-kit_2.0';
const PLAT = 'kenney_platformer-kit';
const GRAVE = 'kenney_graveyard-kit_5.0';
const PIRATE = 'kenney_pirate-kit';

// Each kit is modelled at a different native scale; calibrate them to ~human
// scale (the doodler is ~1.8 tall) so props from different kits sit together.
export const KIT_SCALE = {
  [TOWN]: 3.0,
  [PLAT]: 2.0,
  [GRAVE]: 2.6,
  [PIRATE]: 1.4,
};

// Internal wall lines sit at x = +/-9 and z = +/-9, splitting the 54x54
// compound into nine ~18x18 rooms whose centres are at -18 / 0 / 18.
const R = 27;   // half-size (perimeter)
const W = 9;    // internal wall offset

export const MAPS = {
  // ---- The Flat: a single connected apartment (à la the real game's ------
  // single-interior maps). One bright floor-plan GLB; every room reachable
  // through open doorways, every mesh a collider so hiders can tuck against
  // walls/furniture (but not under them).
  rooms: {
    id: 'rooms',
    name: 'The Flat',
    size: { x: 30, z: 20, h: 12 },
    charScale: 1,      // reference map — hider/seeker sizes are tuned here
    ground: '#8c9498',
    sky: '#cfe2f1',
    fog: { color: '#dcebf4', near: 30, far: 95 },
    // Vertical ceiling: interior walls are ~2.6m, so cap climbing at 2.2m —
    // high enough for the picture-frame wall-hide, low enough that you can
    // never crest a wall-top and drop into the next room.
    roof: 2.2,
    scenes: [
      // The cut lines sit ON the floorplan's real interior walls (measured
      // top-down: x = -5.5 and +7.8), so every room in play is COMPLETE —
      // living/dining, kitchen, and the whole east suite. The half-sliced
      // west bathroom/bedrooms are excluded entirely. Trim planes sit
      // INSIDE the cap wall slabs so sliced cross-sections never peek out.
      { file: 'apartment-floor-plan (1)/source/floorplan.glb', pos: [0, 0], fit: 34, collide: true,
        trim: { minX: -6.4, maxX: 7.9 } },
    ],
    // Solid walls on the cut lines — the flat honestly ENDS here. The west
    // cut sits behind the living-room sofa (sofa west end ~-5.9) so the
    // whole couch is inside the room, backed naturally against the wall.
    // h matches the flat's own walls (~2.5m) so they don't stick up, and the
    // 2.2m roof stops a climber below the top (no scaling the boundary).
    capWalls: [{ x: -6.3, len: 14, h: 2.6 }, { x: 7.8, len: 14, h: 2.6 }],
    // Play area stops at the cap walls' inner faces so nobody can stand
    // inside a wall slab and poke the camera through it.
    bounds: { minX: -6.0, maxX: 7.4, minZ: -6.5, maxZ: 6.5 },
    // Spawn points grouped by area. Each round the seeker and the hiders are
    // placed in DIFFERENT areas so a hider never starts next to the seeker.
    // Spots are in open floor — never boxed into the narrow-doored rooms.
    spawnRooms: [
      [[-3, 0.8], [-4.4, 0], [-1.5, -3.5], [-2, 2.5]],          // lounge & dining
      [[0.6, -2.2], [1.7, 0.8], [2.5, -3], [1.2, 3]],           // kitchen & hall
      [[5.6, 1.6], [4.5, -0.7], [4.5, -4.4], [6.5, -2]],        // east suite
    ],
  },

  // ---- The Plaza: an outdoor sports square — courts, stands, trees and
  // street furniture. Open air and bright: a totally different hunt from
  // the indoor flat.
  plaza: {
    id: 'plaza',
    name: 'The Plaza',
    // Shrunk ~17% (fit 46 -> 38): tighter sweep for the seeker outdoors.
    size: { x: 44, z: 44, h: 14 },
    charScale: 1.4,    // open-air square: bigger bodies so they read outdoors
    ground: '#8fae74',
    sky: '#aed8f0',
    fog: { color: '#cfe7f5', near: 38, far: 118 },
    scenes: [
      { file: 'praca_esporte_morro_da_garca.glb', pos: [0, 0], fit: 38, collide: true },
    ],
    roof: 10,          // the plaza sits on a hill — allow real altitude
    bounds: { minX: -17, maxX: 17, minZ: -17, maxZ: 17 },
    // Spawns probed in-game (scaled 38/46 with the scene): each settles on
    // walkable ground with room to move.
    spawnRooms: [
      [[-6.6, 0], [-8.3, -3.3], [-3.3, -5]],    // west terrace & lawn
      [[0, -6.6], [0, 2.5], [5, -5]],           // central paths
      [[6.6, 0], [3.3, 5], [9.9, 6.6]],         // east court side
    ],
  },

  // ---- Mega City: an open world built from full standalone scene models ----
  // Each downloaded building/scene is auto-fit, centred and dropped onto a big
  // ground plane in its own district. (`scenes` entries are large GLBs loaded
  // by file path, not Kenney kit pieces.)
  city: {
    id: 'city',
    name: 'Mega City',
    // Shrunk 25% (everything ×0.75): the old 160m sprawl took too long to
    // cross — districts keep their layout, just packed tighter.
    size: { x: 120, z: 120, h: 40 },
    charScale: 2,      // huge districts: characters scale up to match streets
    ground: '#9fb08a',
    sky: '#bcd6ea',
    fog: { color: '#cfe0ec', near: 55, far: 175 },
    groundWalk: true,  // streets between buildings are the play surface
    roof: 12,          // buildings are tall — allow climbing their lower tiers
    bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
    scenes: [
      { file: 'praca_esporte_morro_da_garca.glb', pos: [0, 0], fit: 39 },          // sports plaza (centre)
      { file: 'apartamento.glb', pos: [-37.5, -37.5], fit: 27 },                    // apartment block
      { file: 'ice_scream_3_shopping_center_map.glb', pos: [0, -40.5], fit: 33 },   // shopping centre
      { file: 'sanzio_predio_humanizada.glb', pos: [39, -37.5], fit: 27 },          // tower building
      { file: 'unimed_loja_de_vendas.glb', pos: [-40.5, 3], fit: 27 },             // store
      { file: 'the-picture-gallery-low-poly-vr/source/Untitled.glb', pos: [40.5, 4.5], fit: 20 }, // gallery
      { file: 'apartment-floor-plan/source/apartment.glb', pos: [-37.5, 39], fit: 22 },           // apartment (rooms)
      { file: 'apartment-floor-plan (1)/source/floorplan.glb', pos: [0, 40.5], fit: 26 },         // floor plan (rooms)
      { file: 'appartement/source/appartement.glb', pos: [39, 39], fit: 20 },                     // apartment (rooms)
    ],
    spawns: [
      [-21, -21], [0, -22], [21, -21],
      [-24, 3], [24, 4], [-21, 21], [0, 22], [21, 21],
      [-10, -10], [10, 10], [12, -12], [-12, 12],
    ],
  },

  grounds: {
    id: 'grounds',
    name: 'The Grounds',
    size: { x: 54, z: 54, h: 10 },
    charScale: 1.3,    // Kenney props are people-sized; lift the doodlers a bit
    ground: '#6fa84e',
    sky: '#aed8f0',
    fog: { color: '#cfe7f5', near: 34, far: 88 },
    groundWalk: true,  // grassy compound — the ground plane is the floor
    kit: TOWN,
    perimeter: { model: 'wall' },
    walls: [
      // vertical dividers (run along z), doorways at the three room centres
      { from: [-W, -R], to: [-W, R], doors: [[-W, -18], [-W, 0], [-W, 18]] },
      { from: [W, -R], to: [W, R], doors: [[W, -18], [W, 0], [W, 18]] },
      // horizontal dividers (run along x)
      { from: [-R, -W], to: [R, -W], doors: [[-18, -W], [0, -W], [18, -W]] },
      { from: [-R, W], to: [R, W], doors: [[-18, W], [0, W], [18, W]] },
    ],
    models: [
      // ---- Room B (0,-18): Market square --------------------------------
      { m: 'fountain-round', pos: [0, -18], s: 1.4, solid: true },
      { m: 'fountain-center', pos: [0, -18], y: 0.1, s: 1.4 },
      { m: 'stall-green', pos: [-5, -22], rot: 0.2 },
      { m: 'stall-red', pos: [5, -22], rot: -0.2 },
      { m: 'stall', pos: [-5, -14], rot: 3.0 },
      { m: 'cart', pos: [5, -14], rot: 2.4 },
      { m: 'lantern', pos: [-6, -18], s: 1.1 },
      { m: 'lantern', pos: [6, -18], s: 1.1 },
      { m: 'banner-red', pos: [-5, -22], y: 1.6, s: 1.3 },
      { m: 'banner-green', pos: [5, -22], y: 1.6, s: 1.3 },

      // ---- Room E (0,0): Central courtyard + windmill landmark ----------
      { m: 'windmill', pos: [0, 0], s: 1.2, solid: true },
      { m: 'pillar-stone', pos: [-6, -6], s: 1.2, solid: true },
      { m: 'pillar-stone', pos: [6, -6], s: 1.2, solid: true },
      { m: 'pillar-stone', pos: [-6, 6], s: 1.2, solid: true },
      { m: 'pillar-stone', pos: [6, 6], s: 1.2, solid: true },
      { kit: GRAVE, m: 'bench', pos: [-6, 0], rot: Math.PI / 2 },
      { kit: GRAVE, m: 'bench', pos: [6, 0], rot: -Math.PI / 2 },

      // ---- Room C (18,-18): Graveyard ----------------------------------
      { kit: GRAVE, m: 'crypt-large', pos: [18, -22], rot: 0, solid: true },
      { kit: GRAVE, m: 'altar-stone', pos: [18, -16], s: 1.1 },
      { kit: GRAVE, m: 'lightpost-single', pos: [13, -18] },
      { kit: GRAVE, m: 'lightpost-single', pos: [23, -18] },

      // ---- Room D (-18,0): Pirate dock ---------------------------------
      { kit: PIRATE, m: 'boat-row-large', pos: [-18, 3], rot: 0.4 },
      { kit: PIRATE, m: 'tower-complete-small', pos: [-23, -5], s: 0.9, solid: true },
      { kit: PIRATE, m: 'cannon', pos: [-14, -4], rot: -0.6 },
      { kit: PIRATE, m: 'flag-pirate', pos: [-18, -6] },
      { kit: PIRATE, m: 'palm-straight', pos: [-23, 5] },
      { kit: PIRATE, m: 'palm-bend', pos: [-13, 6] },

      // ---- Room F (18,0): Candy blocks ---------------------------------
      { kit: PLAT, m: 'block-grass-large', pos: [16, -3] },
      { kit: PLAT, m: 'block-grass-large-tall', pos: [16, -3], y: 2 },
      { kit: PLAT, m: 'block-grass', pos: [21, 3] },
      { kit: PLAT, m: 'block-grass-low-long', pos: [13, 4], rot: Math.PI / 2 },
      { kit: PLAT, m: 'chest', pos: [20, -4], rot: -0.3 },
      { kit: PLAT, m: 'ladder', pos: [15.2, -3], rot: 0 },

      // ---- Room I (18,18): Watermill ----------------------------------
      { m: 'watermill', pos: [18, 18], s: 1.2, solid: true },
      { m: 'wheel', pos: [18, 14.5], s: 1.2 },

      // ---- Room A (-18,-18): Forest clearing focal trees ----------------
      { m: 'tree-high', pos: [-23, -14], s: 1.1 },
      { m: 'rock-large', pos: [-22, -22], rot: 0.5, solid: true },
    ],
    scatter: [
      // Room A — dense forest
      { kit: TOWN, models: ['tree', 'tree-high', 'tree-crooked', 'tree-high-round'],
        count: 11, seed: 101, area: [-26, -26, -10, -10], sMin: 0.8, sMax: 1.2, rotRandom: true },
      { kit: PLAT, models: ['mushrooms', 'flowers', 'rocks', 'plant'],
        count: 10, seed: 102, area: [-26, -26, -10, -10], sMin: 0.8, sMax: 1.3, rotRandom: true },

      // Room C — graveyard headstones
      { kit: GRAVE, models: ['gravestone-cross', 'gravestone-bevel', 'gravestone-round',
        'gravestone-broken', 'gravestone-wide', 'gravestone-decorative', 'cross-wood'],
        count: 14, seed: 301, area: [11, -25, 25, -11], sMin: 0.9, sMax: 1.2, rotRandom: true },
      { kit: GRAVE, models: ['pine', 'pine-crooked', 'pumpkin', 'coffin'],
        count: 6, seed: 302, area: [11, -25, 25, -11], sMin: 0.9, sMax: 1.2, rotRandom: true },

      // Room D — crates & barrels on the dock
      { kit: PIRATE, models: ['barrel', 'crate', 'crate-bottles'],
        count: 9, seed: 401, area: [-25, -7, -11, 7], sMin: 0.9, sMax: 1.2, rotRandom: true },

      // Room F — colourful crates & coins
      { kit: PLAT, models: ['crate', 'crate-strong', 'coin-gold', 'mushrooms', 'flowers-tall'],
        count: 12, seed: 601, area: [11, -7, 25, 7], sMin: 0.85, sMax: 1.25, rotRandom: true },

      // Room G — flower garden with hedges & trees
      { kit: TOWN, models: ['hedge-large', 'hedge', 'tree', 'tree-crooked'],
        count: 9, seed: 701, area: [-25, 11, -11, 25], sMin: 0.9, sMax: 1.2, rotRandom: true },
      { kit: PLAT, models: ['flowers', 'flowers-tall', 'plant', 'mushrooms'],
        count: 11, seed: 702, area: [-25, 11, -11, 25], sMin: 0.9, sMax: 1.3, rotRandom: true },

      // Room H — packed warehouse of crates & barrels
      { kit: PIRATE, models: ['crate', 'barrel', 'crate-bottles'],
        count: 14, seed: 801, area: [-7, 11, 7, 25], sMin: 0.9, sMax: 1.3, rotRandom: true },

      // Room I — rocks & plants around the watermill
      { kit: PLAT, models: ['rocks', 'plant', 'mushrooms'],
        count: 8, seed: 901, area: [11, 11, 25, 25], sMin: 0.9, sMax: 1.3, rotRandom: true },
      { kit: GRAVE, models: ['pine', 'pine-crooked'],
        count: 4, seed: 902, area: [11, 11, 25, 25], sMin: 0.9, sMax: 1.1, rotRandom: true },

      // Room B — extra market clutter
      { kit: TOWN, models: ['stall-bench', 'rock-small', 'lantern'],
        count: 5, seed: 201, area: [-7, -25, 7, -11], sMin: 0.9, sMax: 1.1, rotRandom: true },
    ],
  },
};

export const DEFAULT_MAP_ID = 'rooms';

export const MAP_LIST = Object.values(MAPS).map((m) => ({ id: m.id, name: m.name }));

// Spawn points grouped by room: returns an array of rooms, each an array of
// [x,y,z] points. Used to keep seekers and hiders in separate rooms.
export function roomSpawns(map) {
  if (map.spawnRooms) return map.spawnRooms.map((r) => r.map(([x, z]) => [x, 0, z]));
  return [spawnPoints(map)];
}

// Spawn points spread across the rooms, inset from walls.
export function spawnPoints(map) {
  if (map.spawnRooms) return map.spawnRooms.flat().map(([x, z]) => [x, 0, z]);
  if (map.spawns) return map.spawns.map(([x, z]) => [x, 0, z]);
  return [
    [-18, 0, -18], [0, 0, -18], [18, 0, -18],
    [-18, 0, 0], [18, 0, 0], [0, 0, 0],
    [-18, 0, 18], [0, 0, 18], [18, 0, 18],
    [-12, 0, -12], [12, 0, 12], [12, 0, -12],
  ];
}

export function clampToRoom(map, x, z) {
  const mx = map.size.x / 2 - 1;
  const mz = map.size.z / 2 - 1;
  return [Math.max(-mx, Math.min(mx, x)), Math.max(-mz, Math.min(mz, z))];
}
