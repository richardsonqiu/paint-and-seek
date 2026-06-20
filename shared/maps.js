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
      // label, centre [x,y,z], size [w,h,d], color
      { label: 'couch', pos: [-7, 1, -7], size: [7, 2, 3], color: '#7a5b46' },
      { label: 'couch-back', pos: [-7, 2.2, -8.2], size: [7, 1.4, 0.6], color: '#6b4f3c' },
      { label: 'rug', pos: [0, 0.05, 0], size: [9, 0.1, 7], color: '#b23b3b' },
      { label: 'table', pos: [0, 0.6, 0], size: [3, 1.2, 2], color: '#caa84a' },
      { label: 'bookshelf', pos: [9, 2.5, -3], size: [1.5, 5, 7], color: '#5b6e54' },
      { label: 'plant', pos: [7, 1, 7], size: [1.6, 2, 1.6], color: '#4f7a8a' },
      { label: 'tv-stand', pos: [-2, 1, 10.5], size: [8, 2, 1.5], color: '#3a3a44' },
      { label: 'lamp', pos: [-9.5, 2.5, 8], size: [1, 5, 1], color: '#d9c27a' },
      { label: 'crate', pos: [6, 0.75, -8], size: [1.6, 1.5, 1.6], color: '#9c7b5e' },
      { label: 'cushion', pos: [-7, 2.3, -6.5], size: [1.4, 0.5, 1.4], color: '#c0563b' },
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
      { label: 'pillar', pos: [-6, 2.5, -6], size: [2, 5, 2], color: '#b8b0a2' },
      { label: 'pillar', pos: [6, 2.5, -6], size: [2, 5, 2], color: '#b8b0a2' },
      { label: 'pillar', pos: [-6, 2.5, 6], size: [2, 5, 2], color: '#b8b0a2' },
      { label: 'pillar', pos: [6, 2.5, 6], size: [2, 5, 2], color: '#b8b0a2' },
      { label: 'painting-red', pos: [0, 4, -13.6], size: [4, 3, 0.3], color: '#c0563b' },
      { label: 'painting-blue', pos: [-13.6, 4, 0], size: [0.3, 3, 4], color: '#3b5ec0' },
      { label: 'painting-green', pos: [13.6, 4, 0], size: [0.3, 3, 4], color: '#3b8a4f' },
      { label: 'bench', pos: [0, 0.5, 0], size: [4, 1, 1.4], color: '#8a8276' },
      { label: 'sculpture', pos: [9, 1.2, 9], size: [2, 2.4, 2], color: '#d8b24a' },
      { label: 'plinth', pos: [-9, 1, -9], size: [1.6, 2, 1.6], color: '#9b9486' },
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
