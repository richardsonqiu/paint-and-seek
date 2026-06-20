// Shared 3D map definitions for Doodle Guys.
// Coordinate system: a room centered at the origin. Floor is the y=0 plane,
// +y is up. Units are roughly metres (a character is ~1.7 tall).
// Boxes are axis-aligned; `pos` is the box CENTRE, `size` is [w, h, d].
// The client builds Three.js meshes from these; the eyedropper samples the
// `color` of whatever surface the player taps (done client-side via raycast).

export const POSES = ['standing', 'crouching', 'flat'];

export const MAPS = {
  living_room: {
    id: 'living_room',
    name: 'Living Room',
    size: { x: 24, z: 24, h: 8 },
    floorColor: '#caa472',
    ceilColor: '#efe7d6',
    wallColor: '#c9b48f',
    boxes: [
      // Sofa (seat + back + two armrests + two cushions)
      { label: 'couch-seat',  pos: [-7,   0.85, -7.0], size: [7.0, 1.7,  3.0], color: '#7a5b46' },
      { label: 'couch-back',  pos: [-7,   2.30, -8.3], size: [7.0, 1.5,  0.55],color: '#6b4f3c' },
      { label: 'couch-arm-l', pos: [-10.8,1.80, -7.0], size: [0.6, 1.6,  3.0], color: '#6b4f3c' },
      { label: 'couch-arm-r', pos: [-3.2, 1.80, -7.0], size: [0.6, 1.6,  3.0], color: '#6b4f3c' },
      { label: 'cushion-l',   pos: [-8.5, 2.20, -6.6], size: [2.2, 0.45, 2.2], color: '#c0563b' },
      { label: 'cushion-r',   pos: [-5.5, 2.20, -6.6], size: [2.2, 0.45, 2.2], color: '#c87a5a' },
      // Rug
      { label: 'rug',         pos: [0,    0.05, 0],    size: [9.0, 0.10, 7.0], color: '#b23b3b', roughness: 0.98 },
      // Coffee table: tabletop + 4 legs
      { label: 'table-top',   pos: [0,    1.12, 0],    size: [3.0, 0.10, 2.0], color: '#caa84a', roughness: 0.55, metalness: 0.05 },
      { label: 'table-leg',   pos: [-1.3, 0.55,-0.8],  size: [0.12,1.10,0.12], color: '#b89840', roughness: 0.55 },
      { label: 'table-leg',   pos: [ 1.3, 0.55,-0.8],  size: [0.12,1.10,0.12], color: '#b89840', roughness: 0.55 },
      { label: 'table-leg',   pos: [-1.3, 0.55, 0.8],  size: [0.12,1.10,0.12], color: '#b89840', roughness: 0.55 },
      { label: 'table-leg',   pos: [ 1.3, 0.55, 0.8],  size: [0.12,1.10,0.12], color: '#b89840', roughness: 0.55 },
      // Bookshelf with interior shelves
      { label: 'bookshelf',   pos: [9.6,  2.50, -3],   size: [1.4, 5.0,  7.0], color: '#5b6e54' },
      { label: 'shelf',       pos: [9.2,  1.20, -3],   size: [0.7, 0.08, 6.6], color: '#4a5c44' },
      { label: 'shelf',       pos: [9.2,  2.70, -3],   size: [0.7, 0.08, 6.6], color: '#4a5c44' },
      { label: 'shelf',       pos: [9.2,  4.10, -3],   size: [0.7, 0.08, 6.6], color: '#4a5c44' },
      // Plant: pot + foliage
      { label: 'plant-pot',   pos: [7,    0.55,  7],   size: [1.5, 1.1,  1.5], color: '#4a5868' },
      { label: 'plant-top',   pos: [7,    1.90,  7],   size: [2.1, 1.5,  2.1], color: '#3a7c44' },
      // TV stand + screen + bezel
      { label: 'tv-stand',    pos: [-2,   0.82, 10.5], size: [8.0, 1.65, 1.5], color: '#3a3a44' },
      { label: 'tv-bezel',    pos: [-2,   2.55, 10.35],size: [5.8, 3.5,  0.16],color: '#222228' },
      { label: 'tv-screen',   pos: [-2,   2.55, 10.28],size: [5.3, 3.0,  0.08],color: '#1a1a2e', emissive: '#1a3a6a', emissiveIntensity: 0.4 },
      // Floor lamp: base + pole + shade
      { label: 'lamp-base',   pos: [-9.5, 0.18,  8],   size: [0.65,0.36, 0.65],color: '#8a7248', roughness: 0.5, metalness: 0.45 },
      { label: 'lamp-pole',   pos: [-9.5, 2.60,  8],   size: [0.10,5.20, 0.10],color: '#9a8258', roughness: 0.45, metalness: 0.5 },
      { label: 'lamp-shade',  pos: [-9.5, 5.50,  8],   size: [1.25,0.90, 1.25],color: '#f0e5a8', emissive: '#d4c060', emissiveIntensity: 0.5 },
      // Crate
      { label: 'crate',       pos: [6,    0.75, -8],   size: [1.6, 1.5,  1.6], color: '#9c7b5e', roughness: 0.95 },
      { label: 'crate-band',  pos: [6,    0.75, -8],   size: [1.62,0.12, 1.62],color: '#7a5f48', roughness: 0.95 },
      // Window frame on north wall
      { label: 'win-top',     pos: [-4,   6.10,-11.9], size: [3.6, 0.20, 0.18],color: '#d4c8b0' },
      { label: 'win-bot',     pos: [-4,   3.90,-11.9], size: [3.6, 0.20, 0.18],color: '#d4c8b0' },
      { label: 'win-left',    pos: [-5.8, 5.00,-11.9], size: [0.18,2.40, 0.18],color: '#d4c8b0' },
      { label: 'win-right',   pos: [-2.2, 5.00,-11.9], size: [0.18,2.40, 0.18],color: '#d4c8b0' },
      { label: 'win-glass',   pos: [-4,   5.00,-11.87],size: [3.2, 2.05, 0.06],color: '#a8d4e8', roughness: 0.08, metalness: 0.15 },
      // Picture on east wall
      { label: 'pic-frame',   pos: [11.85,4.50,  2],   size: [0.18,2.5,  3.5], color: '#6a4a2a', roughness: 0.7 },
      { label: 'pic-canvas',  pos: [11.78,4.50,  2],   size: [0.08,2.1,  3.1], color: '#e8803a' },
    ],
  },
  gallery: {
    id: 'gallery',
    name: 'Art Gallery',
    size: { x: 28, z: 28, h: 9 },
    floorColor: '#d8d2c6',
    ceilColor: '#f3efe8',
    wallColor: '#e6e0d5',
    boxes: [
      // Pillars (4 classical columns)
      { label: 'pillar', pos: [-6, 2.5, -6], size: [2, 5, 2], color: '#b8b0a2', roughness: 0.75 },
      { label: 'pillar', pos: [ 6, 2.5, -6], size: [2, 5, 2], color: '#b8b0a2', roughness: 0.75 },
      { label: 'pillar', pos: [-6, 2.5,  6], size: [2, 5, 2], color: '#b8b0a2', roughness: 0.75 },
      { label: 'pillar', pos: [ 6, 2.5,  6], size: [2, 5, 2], color: '#b8b0a2', roughness: 0.75 },
      // Pillar caps
      { label: 'cap', pos: [-6, 5.3, -6], size: [2.4, 0.4, 2.4], color: '#ccc4b4', roughness: 0.7 },
      { label: 'cap', pos: [ 6, 5.3, -6], size: [2.4, 0.4, 2.4], color: '#ccc4b4', roughness: 0.7 },
      { label: 'cap', pos: [-6, 5.3,  6], size: [2.4, 0.4, 2.4], color: '#ccc4b4', roughness: 0.7 },
      { label: 'cap', pos: [ 6, 5.3,  6], size: [2.4, 0.4, 2.4], color: '#ccc4b4', roughness: 0.7 },
      // North wall painting: frame + canvas
      { label: 'frame-n',   pos: [ 0,  4.0, -13.85], size: [4.6, 3.6, 0.20], color: '#8a6a30', roughness: 0.6 },
      { label: 'painting-n',pos: [ 0,  4.0, -13.72], size: [4.0, 3.0, 0.10], color: '#c0563b' },
      // West wall painting: frame + canvas
      { label: 'frame-w',   pos: [-13.85, 4.0, 0],   size: [0.20, 3.6, 4.6], color: '#8a6a30', roughness: 0.6 },
      { label: 'painting-w',pos: [-13.72, 4.0, 0],   size: [0.10, 3.0, 4.0], color: '#3b5ec0' },
      // East wall painting: frame + canvas
      { label: 'frame-e',   pos: [13.85, 4.0, 0],    size: [0.20, 3.6, 4.6], color: '#8a6a30', roughness: 0.6 },
      { label: 'painting-e',pos: [13.72, 4.0, 0],    size: [0.10, 3.0, 4.0], color: '#3b8a4f' },
      // Central bench + cushion
      { label: 'bench',     pos: [0, 0.42, 0],        size: [4.0, 0.85, 1.4], color: '#8a8276', roughness: 0.8 },
      { label: 'bench-cush',pos: [0, 0.88, 0],        size: [3.6, 0.18, 1.2], color: '#c0a880', roughness: 0.9 },
      // Sculpture + plinth
      { label: 'plinth',    pos: [-9, 1.00, -9],      size: [1.8, 2.0, 1.8], color: '#9b9486', roughness: 0.78 },
      { label: 'plinth-top',pos: [-9, 2.08, -9],      size: [2.0, 0.16,2.0], color: '#aeaaa0', roughness: 0.72 },
      { label: 'sculpture', pos: [-9, 3.40, -9],      size: [1.4, 2.8, 1.4], color: '#d8b24a', roughness: 0.55, metalness: 0.2 },
      // Second sculpture on pedestal
      { label: 'pedestal',  pos: [ 9, 0.85,  9],      size: [1.6, 1.7, 1.6], color: '#ccc4b4', roughness: 0.75 },
      { label: 'sculpt2',   pos: [ 9, 2.55,  9],      size: [1.0, 1.8, 1.0], color: '#e8e0d4', roughness: 0.65, metalness: 0.1 },
      // Spotlight cones above north painting
      { label: 'spot-l',    pos: [-1.2, 8.6, -11],    size: [0.3, 0.5, 0.3], color: '#888880', roughness: 0.4, metalness: 0.5 },
      { label: 'spot-r',    pos: [ 1.2, 8.6, -11],    size: [0.3, 0.5, 0.3], color: '#888880', roughness: 0.4, metalness: 0.5 },
    ],
  },
};

export const MAP_LIST = Object.values(MAPS).map((m) => ({ id: m.id, name: m.name }));

// A few floor spawn points away from the centre, inset from the walls.
export function spawnPoints(map) {
  const mx = map.size.x / 2 - 2;
  const mz = map.size.z / 2 - 2;
  return [
    [-mx + 1, 0, -mz + 1], [mx - 1, 0, -mz + 1],
    [-mx + 1, 0, mz - 1], [mx - 1, 0, mz - 1],
    [0, 0, mz - 1], [0, 0, -mz + 1],
    [mx - 1, 0, 0], [-mx + 1, 0, 0],
  ];
}

export function clampToRoom(map, x, z) {
  const mx = map.size.x / 2 - 1;
  const mz = map.size.z / 2 - 1;
  return [Math.max(-mx, Math.min(mx, x)), Math.max(-mz, Math.min(mz, z))];
}
