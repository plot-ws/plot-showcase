/**
 * Pure, dependency-free game logic for the "Siege" co-op horde survival game.
 *
 * Nothing in this file imports from `@plot/*`; it is plain math over plain
 * objects so it can be unit-tested deterministically (inject `rand`) and reused
 * identically on the authoritative server (the handler) and, in principle, the
 * client. The server owns enemy spawning, movement and damage resolution — this
 * module is where that authority is implemented.
 */

/** Half-extent of the square arena. Valid coordinates are in `[-ARENA, ARENA]`. */
export const ARENA = 900;

/** Radius around the base ({0,0}) within which an enemy "reaches" it. */
const BASE_RADIUS = 70;

/** How close a player must be to an enemy to hit it with auto-fire. */
const PLAYER_RANGE = 140;

/** Player movement speed in units/second. */
const PLAYER_SPEED = 200;

/** Ticks to wait between wave batches once a wave is cleared. */
const WAVE_GAP_TICKS = 40;

/** A 2D position. */
export type Vec2 = { x: number; y: number };

/** One enemy: a position and remaining hit points. */
export type Enemy = { pos: Vec2; hp: number };

/** One player: a position and remaining hit points. */
export type Player = { pos: Vec2; hp: number };

/**
 * The mutable world the server simulates. This is the full authoritative state
 * minus the presentational `phase` field (the handler tracks phase alongside).
 */
export type SiegeWorld = {
  players: Record<string, Player>;
  enemies: Record<string, Enemy>;
  baseHp: number;
  wave: number;
  maxWaves: number;
  tick: number;
  score: number;
};

/** Tunables passed into {@link stepWorld}. */
export type StepOpts = {
  /** Damage one player deals per tick to the nearest in-range enemy. */
  playerDamage: number;
  /** Enemy movement speed in units/second. */
  enemySpeed: number;
  /** Damage an enemy deals to the base when it reaches it. */
  baseDamage: number;
};

/** Euclidean distance between two points. */
export function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Clamp a scalar into `[lo, hi]`. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Move `from` toward `to` by `speed * dt` units, never overshooting the target.
 * Returns a new vector; the input is not mutated.
 */
export function stepToward(from: Vec2, to: Vec2, speed: number, dt: number): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const step = speed * dt;
  if (d === 0 || step >= d) {
    return { x: to.x, y: to.y };
  }
  const t = step / d;
  return { x: from.x + dx * t, y: from.y + dy * t };
}

/**
 * Advance a player position by a normalized direction `(dx, dy)` over `dt`
 * seconds at the fixed player speed, clamped to the arena bounds. The direction
 * is normalized internally so diagonal movement is not faster.
 */
export function stepPlayer(pos: Vec2, dx: number, dy: number, dt: number): Vec2 {
  let nx = dx;
  let ny = dy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len > 0) {
    nx = dx / len;
    ny = dy / len;
  }
  const move = PLAYER_SPEED * dt;
  return {
    x: clamp(pos.x + nx * move, -ARENA, ARENA),
    y: clamp(pos.y + ny * move, -ARENA, ARENA),
  };
}

/**
 * Create one enemy for the given `wave`. Enemies spawn on a random point of the
 * arena's outer edge and have HP that scales with the wave number. `rand`
 * (defaulting to `Math.random`) makes spawning deterministic for tests.
 */
export function spawnEnemy(wave: number, rand: () => number = Math.random): {
  pos: Vec2;
  hp: number;
} {
  // Pick one of the four edges, then a random offset along it.
  const edge = Math.floor(rand() * 4) % 4;
  const along = (rand() * 2 - 1) * ARENA;
  let pos: Vec2;
  switch (edge) {
    case 0:
      pos = { x: -ARENA, y: along };
      break;
    case 1:
      pos = { x: ARENA, y: along };
      break;
    case 2:
      pos = { x: along, y: -ARENA };
      break;
    default:
      pos = { x: along, y: ARENA };
      break;
  }
  const hp = 30 + (wave - 1) * 12;
  return { pos, hp };
}

/** The center base position. */
const BASE_POS: Vec2 = { x: 0, y: 0 };

/** Number of enemies spawned for a given wave. */
function waveBatchSize(wave: number): number {
  return 3 + wave * 2;
}

/** Find the nearest player to `p`, or `null` if there are no players. */
function nearestPlayer(world: SiegeWorld, p: Vec2): Player | null {
  let best: Player | null = null;
  let bestD = Infinity;
  for (const id in world.players) {
    const pl = world.players[id];
    if (pl === undefined) continue;
    const d = dist(pl.pos, p);
    if (d < bestD) {
      bestD = d;
      best = pl;
    }
  }
  return best;
}

/** Find the id of the nearest enemy to `p` within `range`, or `null`. */
function nearestEnemyInRange(
  world: SiegeWorld,
  p: Vec2,
  range: number,
): string | null {
  let best: string | null = null;
  let bestD = range;
  for (const id in world.enemies) {
    const e = world.enemies[id];
    if (e === undefined) continue;
    const d = dist(e.pos, p);
    if (d <= bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/** Count remaining enemies. */
function enemyCount(world: SiegeWorld): number {
  return Object.keys(world.enemies).length;
}

/**
 * Spawn the batch for `wave` into `world`. Enemy ids are derived from the wave
 * and tick so they are stable and collision-free within a run.
 */
function spawnWave(world: SiegeWorld, wave: number, rand: () => number): void {
  const n = waveBatchSize(wave);
  for (let i = 0; i < n; i++) {
    const id = `w${wave}-${i}`;
    world.enemies[id] = spawnEnemy(wave, rand);
  }
}

/**
 * Advance the whole world by one server tick (`dt` seconds of sim time):
 *
 *  1. Wave director: spawn the current wave's batch when the arena is empty
 *     (after a short gap), and advance to the next wave once it is cleared.
 *  2. Move every enemy toward the nearest player, or the base if none.
 *  3. Enemies that reach the base damage it and are removed.
 *  4. Each player auto-fires at its nearest in-range enemy; dead enemies are
 *     removed and `score` increases.
 *
 * Mutates `world` in place. `rand` is injected for deterministic tests.
 */
export function stepWorld(
  world: SiegeWorld,
  dt: number,
  opts: StepOpts,
  rand: () => number = Math.random,
): void {
  // --- Wave director -------------------------------------------------------
  // Stash the tick at which the arena last became empty so we can gate spawns.
  const director = world as SiegeWorld & { _clearedAt?: number; _spawned?: number };
  if (director._spawned === undefined) director._spawned = 0;

  if (enemyCount(world) === 0) {
    if (director._spawned < world.wave) {
      // First time empty for this wave number: remember when, then spawn after
      // a short gap so cleared waves don't instantly chain.
      if (director._clearedAt === undefined) {
        director._clearedAt = world.tick;
      }
      if (world.tick - director._clearedAt >= WAVE_GAP_TICKS) {
        spawnWave(world, world.wave, rand);
        director._spawned = world.wave;
        director._clearedAt = undefined;
      }
    } else if (world.wave < world.maxWaves) {
      // Current wave fully cleared and already spawned → advance.
      world.wave += 1;
      director._clearedAt = undefined;
    }
  }

  // --- Enemy movement + base damage ---------------------------------------
  for (const id in world.enemies) {
    const e = world.enemies[id];
    if (e === undefined) continue;
    const target = nearestPlayer(world, e.pos);
    const goal = target !== null ? target.pos : BASE_POS;
    e.pos = stepToward(e.pos, goal, opts.enemySpeed, dt);
    if (dist(e.pos, BASE_POS) <= BASE_RADIUS) {
      world.baseHp = Math.max(0, world.baseHp - opts.baseDamage);
      delete world.enemies[id];
    }
  }

  // --- Player auto-fire ----------------------------------------------------
  for (const pid in world.players) {
    const pl = world.players[pid];
    if (pl === undefined) continue;
    const targetId = nearestEnemyInRange(world, pl.pos, PLAYER_RANGE);
    if (targetId === null) continue;
    const e = world.enemies[targetId];
    if (e === undefined) continue;
    e.hp -= opts.playerDamage;
    if (e.hp <= 0) {
      delete world.enemies[targetId];
      world.score += 10;
    }
  }
}

/** The damage range used by a player's auto-fire, exposed for the renderer. */
export const PLAYER_FIRE_RANGE = PLAYER_RANGE;

/** Base hit radius, exposed for the renderer. */
export const BASE_HIT_RADIUS = BASE_RADIUS;
