// Shared map definitions for Doodle Guys.
// A map is a logical 1000x1000 space. Surfaces are colored shapes that
// hiders can eyedrop colors from and hide against. The client scales the
// 1000x1000 space to fit the device screen.

export const WORLD = { w: 1000, h: 1000 };

// Each surface: { x, y, w, h, color, label }
// "props" are smaller objects good for posing against / hiding behind.
export const MAPS = {
  living_room: {
    id: 'living_room',
    name: 'Living Room',
    bg: '#e9dcc3',
    surfaces: [
      { x: 0, y: 0, w: 1000, h: 1000, color: '#e9dcc3', label: 'floor' },
      { x: 0, y: 0, w: 1000, h: 180, color: '#c9a36b', label: 'wall' },
      { x: 60, y: 620, w: 360, h: 200, color: '#7a5b46', label: 'couch' },
      { x: 80, y: 640, w: 320, h: 90, color: '#9c7b5e', label: 'cushion' },
      { x: 560, y: 240, w: 380, h: 150, color: '#5b6e54', label: 'bookshelf' },
      { x: 600, y: 640, w: 220, h: 220, color: '#b23b3b', label: 'rug' },
      { x: 430, y: 430, w: 140, h: 140, color: '#caa84a', label: 'table' },
      { x: 250, y: 250, w: 110, h: 110, color: '#4f7a8a', label: 'plant' },
      { x: 820, y: 60, w: 120, h: 100, color: '#d9d2c0', label: 'window' },
    ],
  },
  aquarium: {
    id: 'aquarium',
    name: 'Aquarium',
    bg: '#13496b',
    surfaces: [
      { x: 0, y: 0, w: 1000, h: 1000, color: '#13496b', label: 'water' },
      { x: 0, y: 760, w: 1000, h: 240, color: '#1f6f7a', label: 'sandfloor' },
      { x: 120, y: 320, w: 200, h: 360, color: '#2e8b7a', label: 'kelp' },
      { x: 640, y: 360, w: 240, h: 300, color: '#3aa0a8', label: 'coral' },
      { x: 420, y: 140, w: 180, h: 180, color: '#5fc1d4', label: 'bubble' },
      { x: 740, y: 120, w: 150, h: 130, color: '#e0a85f', label: 'rock' },
      { x: 300, y: 700, w: 160, h: 120, color: '#c96b8a', label: 'anemone' },
    ],
  },
  gallery: {
    id: 'gallery',
    name: 'Art Gallery',
    bg: '#f1ede6',
    surfaces: [
      { x: 0, y: 0, w: 1000, h: 1000, color: '#f1ede6', label: 'floor' },
      { x: 0, y: 0, w: 1000, h: 220, color: '#dcd6cb', label: 'wall' },
      { x: 90, y: 40, w: 180, h: 140, color: '#c0563b', label: 'painting' },
      { x: 410, y: 40, w: 180, h: 140, color: '#3b5ec0', label: 'painting' },
      { x: 730, y: 40, w: 180, h: 140, color: '#3bc07a', label: 'painting' },
      { x: 430, y: 420, w: 160, h: 320, color: '#b8b0a2', label: 'pillar' },
      { x: 150, y: 600, w: 200, h: 200, color: '#8a8276', label: 'sculpture' },
      { x: 700, y: 620, w: 180, h: 180, color: '#d8b24a', label: 'bench' },
    ],
  },
};

export const MAP_LIST = Object.values(MAPS).map((m) => ({ id: m.id, name: m.name }));

// Sample the surface color at a world coordinate (topmost match wins).
export function sampleColorAt(map, x, y) {
  let color = map.bg;
  for (const s of map.surfaces) {
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
      color = s.color;
    }
  }
  return color;
}
