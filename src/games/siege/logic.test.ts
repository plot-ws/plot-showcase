import { describe, expect, it } from 'vitest';
import {
  ARENA,
  dist,
  spawnEnemy,
  stepPlayer,
  stepToward,
  stepWorld,
  type SiegeWorld,
} from './logic';

/** A rand stub that always returns the same value (deterministic spawns). */
const constRand = (v: number) => () => v;

/** Build a minimal world for stepWorld tests. `_spawned` gates the director. */
function makeWorld(over: Partial<SiegeWorld> = {}): SiegeWorld {
  return {
    players: {},
    enemies: {},
    baseHp: 100,
    wave: 1,
    maxWaves: 8,
    tick: 0,
    score: 0,
    ...over,
  };
}

const OPTS = { playerDamage: 6, enemySpeed: 90, baseDamage: 8 };

describe('stepPlayer', () => {
  it('clamps movement to ±ARENA', () => {
    const far = stepPlayer({ x: ARENA - 1, y: 0 }, 1, 0, 100);
    expect(far.x).toBe(ARENA);
    const farNeg = stepPlayer({ x: -ARENA + 1, y: -ARENA + 1 }, -1, -1, 100);
    expect(farNeg.x).toBe(-ARENA);
    expect(farNeg.y).toBe(-ARENA);
  });

  it('moves in the requested direction within bounds', () => {
    const p = stepPlayer({ x: 0, y: 0 }, 1, 0, 0.1); // speed 200 → 20 units
    expect(p.x).toBeCloseTo(20, 5);
    expect(p.y).toBeCloseTo(0, 5);
  });
});

describe('stepToward', () => {
  it('moves from toward to and never overshoots', () => {
    const a = stepToward({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 0.1); // 5 units
    expect(a.x).toBeCloseTo(5, 5);
    expect(dist(a, { x: 100, y: 0 })).toBeLessThan(100);

    const snap = stepToward({ x: 0, y: 0 }, { x: 3, y: 4 }, 1000, 1); // step >> dist
    expect(snap).toEqual({ x: 3, y: 4 });
  });
});

describe('spawnEnemy', () => {
  it('spawns on the arena edge with wave-scaled hp', () => {
    const e1 = spawnEnemy(1, constRand(0));
    expect(Math.max(Math.abs(e1.pos.x), Math.abs(e1.pos.y))).toBe(ARENA);
    const e3 = spawnEnemy(3, constRand(0));
    expect(e3.hp).toBeGreaterThan(e1.hp);
  });
});

describe('stepWorld', () => {
  it('a player adjacent to an enemy damages and eventually kills it, raising score', () => {
    const w = makeWorld({
      // Far from the base so base logic doesn't remove the enemy first.
      players: { p1: { pos: { x: 500, y: 0 }, hp: 100 } },
      enemies: { e1: { pos: { x: 505, y: 0 }, hp: 10 } },
      // Pretend wave 1 already spawned so the director doesn't add enemies.
    });
    (w as SiegeWorld & { _spawned?: number })._spawned = 1;

    // First tick: 6 damage, enemy survives (10 → 4).
    stepWorld(w, 0.05, OPTS, constRand(0.5));
    expect(w.enemies.e1?.hp).toBe(4);
    expect(w.score).toBe(0);

    // Second tick: 6 more damage → dead, removed, score += 10.
    stepWorld(w, 0.05, OPTS, constRand(0.5));
    expect(w.enemies.e1).toBeUndefined();
    expect(w.score).toBe(10);
  });

  it('an enemy reaching the base reduces baseHp and is removed', () => {
    const w = makeWorld({
      enemies: { e1: { pos: { x: 0, y: 0 }, hp: 50 } },
    });
    (w as SiegeWorld & { _spawned?: number })._spawned = 1;

    stepWorld(w, 0.05, OPTS, constRand(0.5));
    expect(w.baseHp).toBe(100 - OPTS.baseDamage);
    expect(w.enemies.e1).toBeUndefined();
  });

  it('advances the wave once all enemies are cleared', () => {
    const w = makeWorld({ wave: 1, enemies: {} });
    // Mark wave 1 as already spawned and arena empty → next step advances.
    (w as SiegeWorld & { _spawned?: number })._spawned = 1;

    stepWorld(w, 0.05, OPTS, constRand(0.5));
    expect(w.wave).toBe(2);
  });
});
