/**
 * Authoritative server handler for "Siege".
 *
 * This is the star of the showcase: the server owns the whole simulation —
 * enemy spawning, movement, HP and damage resolution, the base, and the
 * win/loss condition. Clients only send movement intents; everything else is
 * derived here and snapshotted each tick. The handler is intentionally thin and
 * delegates all game math to the pure {@link stepWorld} in `./logic`.
 */
import { defineRoom } from '@plot/handler';
import type { HandlerContext } from '@plot/handler';
import { stepPlayer, stepWorld, type SiegeWorld } from './logic';

/** The full authoritative state: the simulated world plus a presentation phase. */
export type State = SiegeWorld & {
  phase: 'playing' | 'won' | 'lost';
};

/** Messages clients may send. Only movement intents are accepted. */
export type Msg = { kind: 'move'; dx: number; dy: number; dt: number };

/** Simulation tunables (per-tick at 20Hz). */
const STEP_OPTS = { playerDamage: 6, enemySpeed: 90, baseDamage: 8 } as const;

/** Server tick length in seconds (tickRate 20 → 50ms). */
const DT = 1 / 20;

/**
 * Deterministic-ish per-room RNG seeded from the tick so spawns vary between
 * runs but never use wall-clock time (waves are tick-driven, per the contract).
 */
function makeRand(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

/** Place a new player near the base but offset so they don't all stack. */
function spawnPlayerPos(index: number): { x: number; y: number } {
  const angle = (index * Math.PI) / 4;
  const r = 160;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

export default defineRoom<State, Msg>({
  initialState: {
    players: {},
    enemies: {},
    baseHp: 100,
    wave: 1,
    maxWaves: 8,
    tick: 0,
    phase: 'playing',
    score: 0,
  },
  channels: {
    state: { reliable: true, ordered: true },
    event: { reliable: true, ordered: true },
  },
  tickRate: 20,

  onJoin(player, ctx: HandlerContext<State>) {
    const index = Object.keys(ctx.state.players).length;
    ctx.state.players[player.id] = { pos: spawnPlayerPos(index), hp: 100 };
  },

  onMessage(player, msg, ctx: HandlerContext<State>) {
    if (msg.kind !== 'move') return;
    const p = ctx.state.players[player.id];
    if (p === undefined) return;
    const dt = Number.isFinite(msg.dt) ? Math.max(0, Math.min(msg.dt, 0.1)) : 0;
    p.pos = stepPlayer(p.pos, msg.dx, msg.dy, dt);
  },

  onTick(ctx: HandlerContext<State>) {
    const s = ctx.state;
    s.tick += 1;
    if (s.phase !== 'playing') return;

    stepWorld(s, DT, STEP_OPTS, makeRand(s.tick));

    // Win/loss evaluation after the step.
    const prevPhase = s.phase;
    if (s.baseHp <= 0) {
      s.baseHp = 0;
      s.phase = 'lost';
    } else if (
      s.wave >= s.maxWaves &&
      Object.keys(s.enemies).length === 0 &&
      // Only win once the final wave has actually spawned and been cleared.
      (s as SiegeWorld & { _spawned?: number })._spawned === s.maxWaves
    ) {
      s.phase = 'won';
    }

    if (s.phase !== prevPhase && (s.phase === 'won' || s.phase === 'lost')) {
      for (const id in s.players) {
        void ctx.leaderboard('siege').submit(id, s.score);
      }
      ctx.broadcast('event', { kind: 'gameover', phase: s.phase, score: s.score });
    }
  },

  onLeave(player, ctx: HandlerContext<State>) {
    delete ctx.state.players[player.id];
  },
});
