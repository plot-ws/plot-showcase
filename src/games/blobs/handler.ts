/**
 * Authoritative room handler for Blobs.
 *
 * Runs server-side (and locally, via `room.attachHandler`, for client-side
 * prediction). It owns the world: players spawn on join, movement is applied
 * from `move` messages, eating is resolved every tick, and players are removed
 * on leave. All game maths lives in the pure `./logic` module.
 */
import { defineRoom } from '@plot/handler';
import {
  type BlobWorld,
  randomPoint,
  resolveEat,
  stepMove,
} from './logic';

/** The single client→server message: a desired movement vector over `dt`. */
type BlobMsg = { kind: 'move'; dx: number; dy: number; dt: number };

/** Starting mass for a freshly-spawned blob. */
const START_MASS = 12;

export const handler = defineRoom<BlobWorld, BlobMsg>({
  initialState: { positions: {}, mass: {}, pellets: [] },
  channels: {
    state: { reliable: true, ordered: true },
    event: { reliable: true, ordered: true },
  },
  tickRate: 20,
  onJoin(player, ctx) {
    ctx.state.positions[player.id] = randomPoint();
    ctx.state.mass[player.id] = START_MASS;
  },
  onMessage(player, msg, ctx) {
    if (msg.kind !== 'move') return;
    const pos = ctx.state.positions[player.id];
    if (pos === undefined) return;
    const mass = ctx.state.mass[player.id] ?? START_MASS;
    ctx.state.positions[player.id] = stepMove(
      pos,
      msg.dx,
      msg.dy,
      msg.dt,
      mass,
    );
  },
  onTick(ctx) {
    resolveEat(ctx.state, (id, score) => {
      void ctx.leaderboard('blobs').submit(id, score);
    });
  },
  onLeave(player, ctx) {
    delete ctx.state.positions[player.id];
    delete ctx.state.mass[player.id];
  },
});

export default handler;
