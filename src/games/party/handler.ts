/**
 * Authoritative room handler for "Caption Clash".
 *
 * Runs at tickRate 5. The handler owns the truth: clients send intents on the
 * `event` channel, the handler mutates `ctx.state`, and Plot snapshots the
 * state each tick to every client (read via `room.currentState`).
 *
 * All phase/timing decisions are delegated to the pure reducers in `logic.ts`
 * so the rules are testable and identical regardless of where they run. Timing
 * is purely tick-based (no wall-clock) for deterministic reliability.
 */
import { defineRoom } from '@plot/handler';
import type { HandlerContext } from '@plot/handler';
import {
  MAX_ROUNDS,
  type Mode,
  type State,
  advance,
  applyLetter,
  deadlineReached,
  ranking,
  startMatch,
} from './logic';

/** Client → server messages on the `event` channel. */
export type Msg =
  | { kind: 'setName'; name: string }
  | { kind: 'start'; mode: Mode }
  | { kind: 'submit'; text: string }
  | { kind: 'vote'; target: string }
  | { kind: 'play'; letter: string };

const initialState: State = {
  phase: 'lobby',
  mode: 'party',
  tick: 0,
  round: 0,
  maxRounds: MAX_ROUNDS,
  players: {},
};

/** Whether a player id is the room VIP (first player still present). */
function isVip(id: string, ctx: HandlerContext<State>): boolean {
  return ctx.firstPlayer?.id === id;
}

/** Submit every player's final score to the shared 'party' leaderboard. */
function publishScores(ctx: HandlerContext<State>): void {
  const board = ctx.leaderboard('party');
  for (const [id, rec] of Object.entries(ctx.state.players)) {
    // Fire-and-forget; failures are non-fatal to the room.
    void board.submit(id, rec.score).catch((e) => ctx.warn('leaderboard submit failed', e));
  }
}

export default defineRoom<State, Msg>({
  initialState,
  channels: {
    state: { reliable: true, ordered: true },
    event: { reliable: true, ordered: true },
  },
  tickRate: 5,

  onJoin(player, ctx) {
    const existing = ctx.state.players[player.id];
    if (existing) {
      // Rejoin: keep their score, mark present again.
      existing.present = true;
    } else {
      ctx.state.players[player.id] = { name: 'Player', score: 0, present: true };
    }
  },

  onLeave(player, ctx) {
    const rec = ctx.state.players[player.id];
    if (rec) rec.present = false;
  },

  onMessage(player, msg, ctx) {
    const s = ctx.state;
    switch (msg.kind) {
      case 'setName': {
        const rec = s.players[player.id];
        if (rec && typeof msg.name === 'string') {
          rec.name = msg.name.slice(0, 24).trim() || 'Player';
        }
        return;
      }

      case 'start': {
        if (!isVip(player.id, ctx)) return;
        if (s.phase !== 'lobby') return;
        if (msg.mode !== 'party' && msg.mode !== 'turnbased') return;
        Object.assign(s, startMatch(s, msg.mode));
        return;
      }

      case 'submit': {
        if (s.phase !== 'play' || s.mode !== 'party') return;
        if (typeof msg.text !== 'string') return;
        if (!s.submissions) s.submissions = {};
        s.submissions[player.id] = msg.text.slice(0, 140);
        return;
      }

      case 'vote': {
        if (s.phase !== 'vote' || s.mode !== 'party') return;
        if (typeof msg.target !== 'string') return;
        // Can't vote for yourself; target must have submitted.
        if (msg.target === player.id) return;
        if (!s.submissions || !(msg.target in s.submissions)) return;
        if (!s.votes) s.votes = {};
        s.votes[player.id] = msg.target;
        return;
      }

      case 'play': {
        if (s.phase !== 'play' || s.mode !== 'turnbased') return;
        if (typeof msg.letter !== 'string') return;
        const patch = applyLetter(s, player.id, msg.letter);
        if (patch) Object.assign(s, patch);
        return;
      }

      default:
        return;
    }
  },

  onTick(ctx) {
    const s = ctx.state;
    s.tick += 1;

    if (s.phase === 'lobby' || s.phase === 'over') return;

    if (deadlineReached(s)) {
      const next = advance(s);
      Object.assign(s, next);
      if (next.phase === 'over') {
        publishScores(ctx);
      }
    }
  },
});

/** Re-exported for client convenience (winner highlight, etc.). */
export { ranking };
