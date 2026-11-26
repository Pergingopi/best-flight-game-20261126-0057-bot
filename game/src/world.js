// The island of Meridian Courier: one 1024 x 1024 metre island in a sea,
// built from a seed — a mountain spine in the north-west, rolling green
// hills, a sandy shore, a harbour city in the east and a grass airfield
// with a strip in the south. The heightmap is sampled bilinearly; the
// colour of a point on the ground decides what the terrain renderer draws,
// so the runway, the city roofs and the beaches are all paint on the same
// ground, and the 3D buildings and the rings sit on top of it.

import { clamp, fbm, lerp, mulberry32, ridged, valueNoise } from './random.js';

export const WORLD_SIZE = 1024; // metres, x and z run 0..1024
export const SEA_LEVEL = 0;
export const MAP_SAMPLES = 256; // heightmap grid, 4 m per sample
export const STEP = WORLD_SIZE / (MAP_SAMPLES - 1);

// The airfield: a flat strip the mail run starts from and lands on.
export const RUNWAY = { x: 512, z: 800, length: 170, width: 15, heading: 0 };
// Runway heading 0 runs along +x (east). Thresholds at x = 512 +/- 85.
export const AIRFIELD = { x: 512, z: 800 };

// The harbour city, east of the airfield.
export const CITY = { x: 730, z: 640, radius: 95 };

const CITY_GROUND = 6; // the city sits on a flattened terrace
const AIRFIELD_GROUND = 3;

/**
 * Raw height before the airfield / city flattening: fbm hills plus a
 * ridged mountain spine, falling away to the sea at the island's edge.
 */
function baseHeight(x, z, seed) {
  // Island falloff: 1 in the middle, 0 at the shore, negative outside.
  const dx = (x - WORLD_SIZE / 2) / (WORLD_SIZE / 2);
  const dz = (z - WORLD_SIZE / 2) / (WORLD_SIZE / 2);
  const r = Math.sqrt(dx * dx + dz * dz);
  const falloff = clamp(1.15 - r * 1.15, -0.4, 1);
  const hills = fbm(x * 0.008, z * 0.008, seed, 4);
  // The spine runs diagonally across the north-west quarter.
  const spine = ridged(x * 0.006 + 3.1, z * 0.006 - 1.7, seed + 40, 4);
  const spineMask = clamp(1 - Math.hypot((x - 300) / 260, (z - 300) / 260), 0, 1);
  const h = -7 + falloff * (hills * 26 + spine * spineMask * 78);
  return h;
}

function flattenBlend(x, z, cx, cz, rx, rz, ground, h) {
  // Smooth-edged rectangle: 1 inside, 0 outside, soft rim in between.
  const ex = Math.abs(x - cx) / rx;
  const ez = Math.abs(z - cz) / rz;
  const e = Math.max(ex, ez);
  const t = clamp(1 - (e - 0.75) / 0.25, 0, 1);
  const s = t * t * (3 - 2 * t);
  return lerp(h, ground, s);
}

/** Build the world for a seed: heightmap, rings, buildings, clouds. */
export function buildWorld(seed) {
  const map = new Float32Array(MAP_SAMPLES * MAP_SAMPLES);
  for (let iz = 0; iz < MAP_SAMPLES; iz += 1) {
    for (let ix = 0; ix < MAP_SAMPLES; ix += 1) {
      const x = ix * STEP;
      const z = iz * STEP;
      let h = baseHeight(x, z, seed);
      // Flatten the strip and its apron, and the city terrace.
      h = flattenBlend(x, z, RUNWAY.x, RUNWAY.z, RUNWAY.length / 2 + 26, RUNWAY.width / 2 + 34, AIRFIELD_GROUND, h);
      const dc = Math.hypot(x - CITY.x, z - CITY.z);
      const cityT = clamp(1 - (dc - CITY.radius * 0.7) / (CITY.radius * 0.3), 0, 1);
      const cs = cityT * cityT * (3 - 2 * cityT);
      h = lerp(h, CITY_GROUND, cs);
      map[iz * MAP_SAMPLES + ix] = h;
    }
  }

  const world = {
    seed,
    map,
    rings: buildRings(seed),
    buildings: buildBuildings(seed),
    clouds: buildClouds(seed),
  };
  return world;
}

/** Bilinear height at world (x, z); outside the island is deep sea. */
export function heightAt(world, x, z) {
  if (x < 0 || z < 0 || x > WORLD_SIZE || z > WORLD_SIZE) return -9;
  const gx = x / STEP;
  const gz = z / STEP;
  const ix = Math.min(MAP_SAMPLES - 2, Math.floor(gx));
  const iz = Math.min(MAP_SAMPLES - 2, Math.floor(gz));
  const fx = gx - ix;
  const fz = gz - iz;
  const m = world.map;
  const a = m[iz * MAP_SAMPLES + ix];
  const b = m[iz * MAP_SAMPLES + ix + 1];
  const c = m[(iz + 1) * MAP_SAMPLES + ix];
  const d = m[(iz + 1) * MAP_SAMPLES + ix + 1];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

// ---- terrain palette -------------------------------------------------
// The renderer indexes these by palette id; fog is a table over the ids.
export const PALETTE = [
  [16, 68, 110], // 0 deep sea
  [24, 96, 142], // 1 shallow sea
  [214, 196, 138], // 2 sand
  [96, 154, 74], // 3 meadow
  [74, 128, 62], // 4 meadow dark
  [122, 158, 82], // 5 dry grass
  [112, 102, 88], // 6 rock
  [88, 80, 72], // 7 rock dark
  [238, 240, 244], // 8 snow
  [58, 58, 64], // 9 runway asphalt
  [232, 232, 226], // 10 runway paint
  [150, 148, 140], // 11 city ground
  [176, 92, 72], // 12 roof red
  [92, 110, 128], // 13 roof blue-grey
  [198, 164, 96], // 14 roof sand
  [120, 118, 110], // 15 roof grey
];

function onRunway(x, z) {
  return Math.abs(x - RUNWAY.x) <= RUNWAY.length / 2 && Math.abs(z - RUNWAY.z) <= RUNWAY.width / 2;
}

function cityCell(x, z, seed) {
  // One roof colour per 14 m block, stable per seed.
  const cx = Math.floor(x / 14);
  const cz = Math.floor(z / 14);
  const n = valueNoise(cx * 0.73 + 11, cz * 0.73 + 5, seed + 900);
  return n;
}

/**
 * Palette id of the ground at (x, z, h). Water is drawn as a flat surface
 * at sea level; everything else is the ground's own colour.
 */
export function groundPalette(world, x, z, h) {
  if (h < SEA_LEVEL - 0.4) {
    return h < -4 ? 0 : 1;
  }
  if (onRunway(x, z)) {
    // Centreline dashes and the two thresholds, painted on the asphalt.
    const along = x - (RUNWAY.x - RUNWAY.length / 2);
    const dash = Math.floor(along / 10) % 2 === 0;
    const centre = Math.abs(z - RUNWAY.z) < 0.9;
    const threshold = along < 7 || along > RUNWAY.length - 7;
    if ((dash && centre) || threshold) return 10;
    return 9;
  }
  const dc = Math.hypot(x - CITY.x, z - CITY.z);
  if (dc < CITY.radius) {
    // Streets every 28 m read as the city grid; the rest is roof colour.
    const street = (Math.floor(x / 28) + Math.floor(z / 28)) % 2 === 0
      && (x % 28 < 4 || z % 28 < 4);
    if (street) return 11;
    const n = cityCell(x, z, world.seed);
    if (n < 0.3) return 12;
    if (n < 0.55) return 13;
    if (n < 0.8) return 14;
    return 15;
  }
  if (h < 1.2) return 2; // beach
  if (h > 62) return 8; // snow caps
  if (h > 34) return valueNoise(x * 0.05, z * 0.05, world.seed + 7) < 0.5 ? 6 : 7;
  const n = valueNoise(x * 0.03, z * 0.03, world.seed + 3);
  if (n < 0.35) return 3;
  if (n < 0.7) return 4;
  return 5;
}

// ---- the mail run -----------------------------------------------------

/** Eight glowing rings: sea gate, valley thread, city slalom, home final. */
function buildRings(seed) {
  const rng = mulberry32(seed + 500);
  const stops = [
    { x: 512, z: 700, y: 34 }, // climb-out over the fields
    { x: 420, z: 560, y: 46 }, // out over the bay
    { x: 300, z: 430, y: 58 }, // sea gate
    { x: 330, z: 300, y: 66 }, // into the valley
    { x: 470, z: 330, y: 60 }, // valley thread
    { x: 620, z: 470, y: 52 }, // ridge crossing
    { x: 700, z: 600, y: 44 }, // city slalom, low over the roofs
    { x: 600, z: 730, y: 26 }, // home final, lined up on the strip
  ];
  return stops.map((s, i) => ({
    index: i,
    x: s.x + (rng() - 0.5) * 6,
    z: s.z + (rng() - 0.5) * 6,
    y: s.y,
    r: 13,
    passed: false,
  }));
}

// ---- buildings ---------------------------------------------------------

function buildBuildings(seed) {
  const rng = mulberry32(seed + 700);
  const list = [];
  for (let i = 0; i < 46; i += 1) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * (CITY.radius - 14);
    const x = CITY.x + Math.cos(a) * r;
    const z = CITY.z + Math.sin(a) * r;
    // Keep the streets clear-ish: skip the very centre plaza.
    if (Math.hypot(x - CITY.x, z - CITY.z) < 12) continue;
    const w = 9 + rng() * 7;
    const d = 9 + rng() * 7;
    const h = 9 + rng() * rng() * 26;
    const shade = 12 + Math.floor(rng() * 4); // roof palette family
    list.push({ x, z, w, d, h, shade });
  }
  // The harbour lighthouse and the control tower, landmarks by the field.
  list.push({ x: 842, z: 560, w: 8, d: 8, h: 34, shade: 10, tower: true });
  list.push({ x: 512, z: 762, w: 12, d: 10, h: 16, shade: 13, tower: true });
  return list;
}

// ---- clouds ------------------------------------------------------------

function buildClouds(seed) {
  const rng = mulberry32(seed + 300);
  const list = [];
  for (let i = 0; i < 26; i += 1) {
    list.push({
      x: rng() * WORLD_SIZE,
      z: rng() * WORLD_SIZE,
      y: 95 + rng() * 55,
      rx: 26 + rng() * 42,
      ry: 7 + rng() * 8,
      drift: 0.6 + rng() * 0.9,
    });
  }
  return list;
}
