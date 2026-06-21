/**
 * Pure game logic for Blobs — an agar.io-style .io arena.
 *
 * This module has NO `@plot/*` imports: it is just deterministic maths over
 * plain data, so it can be unit-tested in isolation and reused verbatim by both
 * the authoritative handler (server tick) and the client (local prediction).
 *
 * The world is a square arena of side `2 * BOUND` centred on the origin. Each
 * blob has a position and a mass; mass drives both radius and speed (heavier
 * blobs are bigger but slower). Pellets are static food dots that blobs eat to
 * grow, and big blobs eat smaller blobs outright.
 */

/** Half-width of the square arena: every coordinate is clamped to ±BOUND. */
export const BOUND = 1200;

/** A 2D point. */
export type Vec2 = { x: number; y: number };

/** The starting (and respawn) mass for every blob. */
const START_MASS = 12;

/** How many pellets the arena tops up to each resolve. */
const PELLET_TARGET = 120;

/**
 * Visual/collision radius for a given mass. Grows with the square root of mass
 * so that area scales linearly with mass (doubling mass ≈ doubling area).
 */
export function radius(mass: number): number {
  return 4 + Math.sqrt(mass) * 3;
}

/** Euclidean distance between two points. */
export function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * A uniformly random point inside the arena. `rand` defaults to `Math.random`
 * but can be injected for deterministic tests.
 */
export function randomPoint(rand: () => number = Math.random): Vec2 {
  return {
    x: (rand() * 2 - 1) * BOUND,
    y: (rand() * 2 - 1) * BOUND,
  };
}

/** Clamp a value into the inclusive range [min, max]. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Integrate one movement step for a blob.
 *
 * `dx`/`dy` are a desired direction (clamped to [-1, 1] per axis); `dt` is the
 * elapsed time in seconds (clamped to [0, 0.1] to bound a single step). Speed
 * falls off with mass — a light blob is nimble, a heavy one is sluggish. The
 * result is clamped back inside the arena on both axes.
 */
export function stepMove(
  pos: Vec2,
  dx: number,
  dy: number,
  dt: number,
  mass: number,
): Vec2 {
  const cdx = clamp(dx, -1, 1);
  const cdy = clamp(dy, -1, 1);
  const cdt = clamp(dt, 0, 0.1);
  const speed = 240 * Math.pow(12 / mass, 0.4);
  return {
    x: clamp(pos.x + cdx * speed * cdt, -BOUND, BOUND),
    y: clamp(pos.y + cdy * speed * cdt, -BOUND, BOUND),
  };
}

/** The full mutable arena state shared between server and clients. */
export type BlobWorld = {
  positions: Record<string, Vec2>;
  mass: Record<string, number>;
  pellets: Vec2[];
};

/**
 * Advance the world by resolving all eating interactions, in place.
 *
 * 1. Top the pellet field up to {@link PELLET_TARGET}.
 * 2. Each blob eats any pellet it overlaps (mass += 1, pellet respawns).
 * 3. PvP: a blob 25% heavier than another that overlaps it absorbs it; the
 *    eaten blob respawns at a random point with the starting mass.
 * 4. After resolving, each player's rounded mass is reported via `submit`.
 *
 * `submit` and `rand` are injectable so the function stays pure and testable.
 */
export function resolveEat(
  w: BlobWorld,
  submit?: (id: string, score: number) => void,
  rand: () => number = Math.random,
): void {
  // 1. Refill pellets to the target count.
  while (w.pellets.length < PELLET_TARGET) {
    w.pellets.push(randomPoint(rand));
  }

  const ids = Object.keys(w.positions);

  // 2. Pellet eating.
  for (const id of ids) {
    const pos = w.positions[id];
    if (pos === undefined) continue;
    const m = w.mass[id] ?? START_MASS;
    const reach = radius(m) + 3;
    for (let i = 0; i < w.pellets.length; i++) {
      const pellet = w.pellets[i];
      if (pellet === undefined) continue;
      if (dist(pos, pellet) < reach) {
        w.mass[id] = (w.mass[id] ?? START_MASS) + 1;
        w.pellets[i] = randomPoint(rand);
      }
    }
  }

  // 3. PvP eating: a is the eater, b the prey.
  for (const a of ids) {
    const posA = w.positions[a];
    if (posA === undefined) continue;
    for (const b of ids) {
      if (a === b) continue;
      const posB = w.positions[b];
      if (posB === undefined) continue;
      const massA = w.mass[a] ?? START_MASS;
      const massB = w.mass[b] ?? START_MASS;
      if (massA > massB * 1.25 && dist(posA, posB) < radius(massA)) {
        w.mass[a] = massA + massB;
        w.mass[b] = START_MASS;
        w.positions[b] = randomPoint(rand);
      }
    }
  }

  // 4. Report scores.
  if (submit !== undefined) {
    for (const id of ids) {
      submit(id, Math.round(w.mass[id] ?? START_MASS));
    }
  }
}
