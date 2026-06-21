/**
 * Pure game logic for the "Caption Clash" party module.
 *
 * Everything here is a pure function of state (no I/O, no wall-clock, no Plot
 * APIs) so it can be unit-tested deterministically and reused verbatim on both
 * the server handler (authoritative) and — where useful — the client.
 *
 * One engine, two modes:
 *  - `party`     simultaneous "caption clash": prompt → everyone captions →
 *                everyone votes → most-voted wins the round's points.
 *  - `turnbased` sequential "word relay": players take turns appending one
 *                letter to a shared word; completing a valid-looking word
 *                (length >= 4) scores and resets the word.
 *
 * Timing is expressed in *ticks*, not milliseconds. The handler runs at
 * tickRate 5 (5 ticks/sec), increments `state.tick` each tick, and parks
 * deadlines in `state.deadlineTick`. `advance` is the single pure reducer that
 * decides what happens when a deadline expires.
 */

/** Server tick rate (ticks per second). 5 ticks ~= 1 second. */
export const TICKS_PER_SECOND = 5;

/** Seconds each captioning / voting / intermission window lasts. */
export const PLAY_SECONDS = 15;
export const VOTE_SECONDS = 12;
export const INTERMISSION_SECONDS = 5;

/** Total rounds in a match. */
export const MAX_ROUNDS = 3;

/** Points awarded to a round winner. */
export const ROUND_POINTS = 100;

/** Fixed prompt pool for party mode (deterministic, no randomness in logic). */
export const PROMPTS: string[] = [
  'Caption this: a cat who just realized it is Monday.',
  'The worst possible thing to say in an elevator.',
  'A motivational poster for procrastinators.',
  'What your wifi router is thinking at 3am.',
  'The real reason the dinosaurs went extinct.',
  'A new warning label for coffee.',
  "Your phone's autocorrect, but it's honest.",
  'The group chat at 2am, summarized in one line.',
  'A villain whose evil plan is mildly inconvenient.',
  'What the last cookie in the jar wants to say.',
];

/** Phases of the shared engine. */
export type Phase = 'lobby' | 'play' | 'vote' | 'intermission' | 'over';

/** The two playable modes. */
export type Mode = 'party' | 'turnbased';

/** Per-player record. Score persists across presence changes. */
export type PlayerRec = {
  name: string;
  score: number;
  present: boolean;
};

/** Full authoritative room state (snapshotted to clients each tick). */
export type State = {
  phase: Phase;
  mode: Mode;
  tick: number;
  round: number;
  maxRounds: number;
  players: Record<string, PlayerRec>;
  prompt?: string;
  /** party play: playerId -> caption text. */
  submissions?: Record<string, string>;
  /** party vote: voterId -> votedForId. */
  votes?: Record<string, string>;
  /** turnbased: ordered list of player ids whose turn rotates. */
  turnOrder?: string[];
  /** turnbased: index into turnOrder of the active player. */
  activeIdx?: number;
  /** turnbased: the shared word being built. */
  word?: string;
  /** Tick at which the current timed phase ends. */
  deadlineTick?: number;
};

/** A round is "valid" word in turnbased mode if it is at least 4 letters. */
export function isValidWord(w: string | undefined): boolean {
  if (typeof w !== 'string') return false;
  return /^[a-z]{4,}$/i.test(w);
}

/** Pick the prompt for a given (0-based) round deterministically. */
export function promptForRound(round: number): string {
  const idx = ((round % PROMPTS.length) + PROMPTS.length) % PROMPTS.length;
  // PROMPTS is a non-empty literal, but satisfy noUncheckedIndexedAccess.
  return PROMPTS[idx] ?? PROMPTS[0]!;
}

/**
 * Tally a votes map (voterId -> targetId) and return the most-voted target id,
 * or null when there are no votes. Ties are broken deterministically by the
 * smallest target id (string compare) so results are reproducible.
 */
export function tallyVotes(votes: Record<string, string> | undefined): string | null {
  if (!votes) return null;
  const counts = new Map<string, number>();
  for (const target of Object.values(votes)) {
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  let best: string | null = null;
  let bestCount = -1;
  for (const [target, count] of counts) {
    if (count > bestCount || (count === bestCount && (best === null || target < best))) {
      best = target;
      bestCount = count;
    }
  }
  return best;
}

/** Stable list of present player ids, sorted for deterministic turn order. */
export function presentPlayerIds(players: Record<string, PlayerRec>): string[] {
  return Object.keys(players)
    .filter((id) => players[id]?.present)
    .sort();
}

/**
 * Initialize the first round when leaving the lobby. Returns the fields to
 * merge onto state. `mode` chooses which mini-game to seed.
 */
export function startMatch(state: State, mode: Mode): Partial<State> {
  if (mode === 'turnbased') {
    const order = presentPlayerIds(state.players);
    return {
      phase: 'play',
      mode,
      round: 0,
      prompt: undefined,
      submissions: undefined,
      votes: undefined,
      turnOrder: order,
      activeIdx: 0,
      word: '',
      deadlineTick: state.tick + PLAY_SECONDS * TICKS_PER_SECOND,
    };
  }
  return {
    phase: 'play',
    mode,
    round: 0,
    prompt: promptForRound(0),
    submissions: {},
    votes: undefined,
    turnOrder: undefined,
    activeIdx: undefined,
    word: undefined,
    deadlineTick: state.tick + PLAY_SECONDS * TICKS_PER_SECOND,
  };
}

/** Award points to a player id (no-op if absent). */
function award(players: Record<string, PlayerRec>, id: string | null, points: number): void {
  if (id === null) return;
  const rec = players[id];
  if (rec) rec.score += points;
}

/**
 * The single pure transition reducer. Given a state whose current timed phase
 * has reached (or passed) its deadline, returns the next state.
 *
 * This function MUTATES a shallow copy it owns and returns it, so callers can
 * use it functionally:  `state = advance(state)`. It never reads the clock —
 * all timing is driven by `state.tick` vs `state.deadlineTick`.
 *
 * Transitions:
 *  - lobby                 -> (unchanged; start happens via startMatch)
 *  - play (party)          -> vote     (open voting window)
 *  - vote (party)          -> intermission (tally + award)
 *  - play (turnbased)      -> intermission (round time ran out)
 *  - intermission          -> next round's play, or 'over' after maxRounds
 *  - over                  -> (unchanged)
 */
export function advance(state: State): State {
  const next: State = {
    ...state,
    players: clonePlayers(state.players),
    submissions: state.submissions ? { ...state.submissions } : state.submissions,
    votes: state.votes ? { ...state.votes } : state.votes,
    turnOrder: state.turnOrder ? [...state.turnOrder] : state.turnOrder,
  };

  switch (next.phase) {
    case 'play': {
      if (next.mode === 'party') {
        next.phase = 'vote';
        next.votes = {};
        next.deadlineTick = next.tick + VOTE_SECONDS * TICKS_PER_SECOND;
        return next;
      }
      // turnbased: a round is one captioning window of relay; time's up.
      return toIntermission(next);
    }
    case 'vote': {
      const winner = tallyVotes(next.votes);
      award(next.players, winner, ROUND_POINTS);
      return toIntermission(next);
    }
    case 'intermission': {
      const nextRound = next.round + 1;
      if (nextRound >= next.maxRounds) {
        next.phase = 'over';
        next.deadlineTick = undefined;
        return next;
      }
      return beginRound(next, nextRound);
    }
    default:
      return next;
  }
}

/** Enter the intermission (scoreboard) phase. */
function toIntermission(next: State): State {
  next.phase = 'intermission';
  next.deadlineTick = next.tick + INTERMISSION_SECONDS * TICKS_PER_SECOND;
  return next;
}

/** Begin a fresh round (0-based index already advanced) for the active mode. */
function beginRound(next: State, round: number): State {
  next.round = round;
  next.phase = 'play';
  next.deadlineTick = next.tick + PLAY_SECONDS * TICKS_PER_SECOND;
  if (next.mode === 'turnbased') {
    next.turnOrder = presentPlayerIds(next.players);
    next.activeIdx = 0;
    next.word = '';
    next.prompt = undefined;
    next.submissions = undefined;
    next.votes = undefined;
  } else {
    next.prompt = promptForRound(round);
    next.submissions = {};
    next.votes = undefined;
    next.word = undefined;
    next.turnOrder = undefined;
    next.activeIdx = undefined;
  }
  return next;
}

/** Deep-copy the players map so `advance` stays pure. */
function clonePlayers(players: Record<string, PlayerRec>): Record<string, PlayerRec> {
  const out: Record<string, PlayerRec> = {};
  for (const [id, rec] of Object.entries(players)) {
    out[id] = { ...rec };
  }
  return out;
}

/**
 * Apply a single turnbased move: the active player appends `letter` to the
 * shared word. If the result is a valid word it scores and the word resets.
 * Returns the fields to merge. Returns null when the move is illegal (not the
 * active player's turn, or not a single letter).
 *
 * `byId` is the player attempting the move; the caller is responsible for
 * having verified presence. This function re-checks the turn to stay pure and
 * self-contained.
 */
export function applyLetter(state: State, byId: string, letter: string): Partial<State> | null {
  if (state.phase !== 'play' || state.mode !== 'turnbased') return null;
  const order = state.turnOrder ?? [];
  const idx = state.activeIdx ?? 0;
  if (order[idx] !== byId) return null;
  if (!/^[a-z]$/i.test(letter)) return null;

  const players = clonePlayers(state.players);
  const candidate = (state.word ?? '') + letter.toLowerCase();

  if (isValidWord(candidate)) {
    const rec = players[byId];
    if (rec) rec.score += ROUND_POINTS;
    return {
      players,
      word: '',
      activeIdx: order.length > 0 ? (idx + 1) % order.length : 0,
    };
  }

  return {
    word: candidate,
    activeIdx: order.length > 0 ? (idx + 1) % order.length : 0,
  };
}

/** Whether the current timed phase has hit its deadline at the given tick. */
export function deadlineReached(state: State): boolean {
  if (state.deadlineTick === undefined) return false;
  return state.tick >= state.deadlineTick;
}

/** Players sorted by score desc (name asc tiebreak) for the scoreboard. */
export function ranking(players: Record<string, PlayerRec>): Array<{ id: string } & PlayerRec> {
  return Object.entries(players)
    .map(([id, rec]) => ({ id, ...rec }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
