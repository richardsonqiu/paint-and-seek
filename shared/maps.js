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

// Postures a hider can strike to match nearby objects: tall, low/compact,
// folded over, curled in a ball, spread wide, or lying flat.
export const POSES = ['standing', 'crouching', 'fold', 'ball', 'wide', 'flat'];

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
  // ---- The Flats: a compact, mobile-friendly multi-room map -------------
  // Built from a couple of light interior floor-plan GLBs placed next to each
  // other so you can walk room-to-room. Every mesh is a collider, so hiders
  // stick against walls/furniture to hide.
  rooms: {
    id: 'rooms',
    name: 'The Flats',
    size: { x: 84, z: 84, h: 12 },
    ground: '#8c9498',
    sky: '#cfe2f1',
    fog: { color: '#dcebf4', near: 45, far: 130 },
    scenes: [
      { file: 'apartment-floor-plan (1)/source/floorplan.glb', pos: [0, 0], fit: 42, collide: true },
      { file: 'apartment-floor-plan/source/apartment.glb', pos: [40, 0], fit: 26, collide: true },
    ],
    // A covered walkway bridging the gap between the two flats.
    connectors: [
      { from: [20, 0], to: [28, 0], width: 7 },
    ],
    spawns: [
      [0, 0], [-12, 0], [12, 0], [0, -3], [0, 3], [-6, 0], [6, 0],
      [24, 0], [40, 0], [40, 6], [40, -6], [34, 0],
    ],
  },

  // ---- Mega City: an open world built from full standalone scene models ----
  // Each downloaded building/scene is auto-fit, centred and dropped onto a big
  // ground plane in its own district. (`scenes` entries are large GLBs loaded
  // by file path, not Kenney kit pieces.)
  city: {
    id: 'city',
    name: 'Mega City',
    size: { x: 160, z: 160, h: 40 },
    ground: '#9fb08a',
    sky: '#bcd6ea',
    fog: { color: '#cfe0ec', near: 70, far: 230 },
    scenes: [
      { file: 'praca_esporte_morro_da_garca.glb', pos: [0, 0], fit: 52 },        // sports plaza (centre)
      { file: 'apartamento.glb', pos: [-50, -50], fit: 36 },                      // apartment block
      { file: 'ice_scream_3_shopping_center_map.glb', pos: [0, -54], fit: 44 },   // shopping centre
      { file: 'sanzio_predio_humanizada.glb', pos: [52, -50], fit: 36 },          // tower building
      { file: 'unimed_loja_de_vendas.glb', pos: [-54, 4], fit: 36 },             // store
      { file: 'the-picture-gallery-low-poly-vr/source/Untitled.glb', pos: [54, 6], fit: 26 }, // gallery
      { file: 'apartment-floor-plan/source/apartment.glb', pos: [-50, 52], fit: 30 },         // apartment (rooms)
      { file: 'apartment-floor-plan (1)/source/floorplan.glb', pos: [0, 54], fit: 34 },       // floor plan (rooms)
      { file: 'appartement/source/appartement.glb', pos: [52, 52], fit: 26 },                 // apartment (rooms)
    ],
    spawns: [
      [-28, -28], [0, -30], [28, -28],
      [-32, 4], [32, 6], [-28, 28], [0, 30], [28, 28],
      [-14, -14], [14, 14], [16, -16], [-16, 16],
    ],
  },

  grounds: {
    id: 'grounds',
    name: 'The Grounds',
    size: { x: 54, z: 54, h: 10 },
    ground: '#6fa84e',
    sky: '#aed8f0',
    fog: { color: '#cfe7f5', near: 34, far: 88 },
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

// Spawn points spread across the rooms, inset from walls.
export function spawnPoints(map) {
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
