import { describe, expect, it } from 'vitest';
import {
  BOUND,
  type BlobWorld,
  radius,
  resolveEat,
  stepMove,
} from './logic';

/** A deterministic `rand` that cycles through a fixed list of values. */
function stubRand(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length] ?? 0;
    i++;
    return v;
  };
}

describe('stepMove', () => {
  it('clamps position to the positive arena boundary', () => {
    const next = stepMove({ x: BOUND, y: BOUND }, 1, 1, 0.1, 12);
    expect(next.x).toBe(BOUND);
    expect(next.y).toBe(BOUND);
  });

  it('clamps position to the negative arena boundary', () => {
    const next = stepMove({ x: -BOUND, y: -BOUND }, -1, -1, 0.1, 12);
    expect(next.x).toBe(-BOUND);
    expect(next.y).toBe(-BOUND);
  });

  it('clamps an oversized direction so a step never leaves the arena', () => {
    const next = stepMove({ x: 0, y: 0 }, 999, 999, 999, 12);
    expect(next.x).toBeLessThanOrEqual(BOUND);
    expect(next.y).toBeLessThanOrEqual(BOUND);
    expect(next.x).toBeGreaterThanOrEqual(-BOUND);
    expect(next.y).toBeGreaterThanOrEqual(-BOUND);
  });

  it('moves a lighter blob farther than a heavier one in the same step', () => {
    const light = stepMove({ x: 0, y: 0 }, 1, 0, 0.1, 12);
    const heavy = stepMove({ x: 0, y: 0 }, 1, 0, 0.1, 200);
    expect(light.x).toBeGreaterThan(heavy.x);
  });
});

describe('resolveEat', () => {
  it('grows a blob sitting on a pellet by one mass', () => {
    const world: BlobWorld = {
      positions: { a: { x: 0, y: 0 } },
      mass: { a: 12 },
      pellets: [{ x: 0, y: 0 }],
    };
    // rand=1 → randomPoint = far corner, so refilled/respawned pellets land
    // away from the blob at the origin; only the seeded pellet is eaten.
    resolveEat(world, undefined, stubRand([1]));
    expect(world.mass.a).toBe(13);
  });

  it('lets a big blob absorb a small one, respawning it at start mass', () => {
    const world: BlobWorld = {
      positions: { big: { x: 0, y: 0 }, small: { x: 0, y: 0 } },
      mass: { big: 100, small: 12 },
      pellets: [],
    };
    // Big blob should not also be eating the seeded pellets at the origin in a
    // way that obscures the PvP result, so push pellets far away via stub.
    resolveEat(world, undefined, stubRand([1, 1]));
    expect(world.mass.big).toBeGreaterThanOrEqual(112);
    expect(world.mass.small).toBe(12);
  });

  it('refills the pellet field to 120', () => {
    const world: BlobWorld = { positions: {}, mass: {}, pellets: [] };
    resolveEat(world, undefined, stubRand([0.25, 0.75]));
    expect(world.pellets).toHaveLength(120);
  });

  it('keeps radius growing with mass (sanity for collisions)', () => {
    expect(radius(48)).toBeGreaterThan(radius(12));
  });

  it('submits each player\'s rounded mass', () => {
    const world: BlobWorld = {
      positions: { a: { x: 0, y: 0 } },
      mass: { a: 12.4 },
      pellets: [],
    };
    const scores: Record<string, number> = {};
    // rand=1 → all refilled pellets spawn in the far corner, away from `a`,
    // so its mass stays 12.4 and rounds to 12.
    resolveEat(world, (id, s) => {
      scores[id] = s;
    }, stubRand([1]));
    expect(scores.a).toBe(12);
  });
});
