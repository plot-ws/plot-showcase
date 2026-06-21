import { describe, expect, it } from 'vitest';
import {
  INTERMISSION_SECONDS,
  MAX_ROUNDS,
  PLAY_SECONDS,
  ROUND_POINTS,
  TICKS_PER_SECOND,
  VOTE_SECONDS,
  advance,
  applyLetter,
  isValidWord,
  promptForRound,
  ranking,
  startMatch,
  tallyVotes,
  type State,
} from './logic';

function baseState(over: Partial<State> = {}): State {
  return {
    phase: 'lobby',
    mode: 'party',
    tick: 0,
    round: 0,
    maxRounds: MAX_ROUNDS,
    players: {
      a: { name: 'Ann', score: 0, present: true },
      b: { name: 'Bob', score: 0, present: true },
      c: { name: 'Cleo', score: 0, present: true },
    },
    ...over,
  };
}

describe('tallyVotes', () => {
  it('returns null with no votes', () => {
    expect(tallyVotes(undefined)).toBeNull();
    expect(tallyVotes({})).toBeNull();
  });

  it('picks the most-voted target', () => {
    const votes = { a: 'b', c: 'b', d: 'a' };
    expect(tallyVotes(votes)).toBe('b');
  });

  it('breaks ties deterministically by smallest id', () => {
    // 'x' and 'z' both have 1 vote -> smallest id wins.
    expect(tallyVotes({ v1: 'z', v2: 'x' })).toBe('x');
    // Order of insertion must not matter.
    expect(tallyVotes({ v1: 'x', v2: 'z' })).toBe('x');
  });
});

describe('isValidWord', () => {
  it('requires length >= 4 alpha', () => {
    expect(isValidWord('cat')).toBe(false);
    expect(isValidWord('tree')).toBe(true);
    expect(isValidWord('TREES')).toBe(true);
    expect(isValidWord('ab3d')).toBe(false);
    expect(isValidWord(undefined)).toBe(false);
    expect(isValidWord('')).toBe(false);
  });
});

describe('startMatch', () => {
  it('seeds party mode with prompt and play deadline', () => {
    const s = baseState({ tick: 10 });
    const patch = startMatch(s, 'party');
    expect(patch.phase).toBe('play');
    expect(patch.mode).toBe('party');
    expect(patch.prompt).toBe(promptForRound(0));
    expect(patch.submissions).toEqual({});
    expect(patch.deadlineTick).toBe(10 + PLAY_SECONDS * TICKS_PER_SECOND);
  });

  it('seeds turnbased mode with a sorted turn order and empty word', () => {
    const s = baseState({ tick: 0 });
    const patch = startMatch(s, 'turnbased');
    expect(patch.phase).toBe('play');
    expect(patch.mode).toBe('turnbased');
    expect(patch.turnOrder).toEqual(['a', 'b', 'c']);
    expect(patch.activeIdx).toBe(0);
    expect(patch.word).toBe('');
  });
});

describe('advance — party flow', () => {
  it('play -> vote opens a voting window', () => {
    let s = baseState({ phase: 'play', mode: 'party', tick: 75, deadlineTick: 75, submissions: { a: 'hi', b: 'yo' } });
    s = advance(s);
    expect(s.phase).toBe('vote');
    expect(s.votes).toEqual({});
    expect(s.deadlineTick).toBe(75 + VOTE_SECONDS * TICKS_PER_SECOND);
  });

  it('vote -> intermission tallies and awards points', () => {
    let s = baseState({
      phase: 'vote',
      mode: 'party',
      tick: 100,
      deadlineTick: 100,
      votes: { a: 'b', c: 'b' },
    });
    s = advance(s);
    expect(s.phase).toBe('intermission');
    expect(s.players.b?.score).toBe(ROUND_POINTS);
    expect(s.players.a?.score).toBe(0);
    expect(s.deadlineTick).toBe(100 + INTERMISSION_SECONDS * TICKS_PER_SECOND);
  });

  it('intermission -> next round play, then over after maxRounds', () => {
    // Round 0 intermission -> round 1 play.
    let s = baseState({ phase: 'intermission', mode: 'party', round: 0, tick: 200, deadlineTick: 200 });
    s = advance(s);
    expect(s.phase).toBe('play');
    expect(s.round).toBe(1);
    expect(s.prompt).toBe(promptForRound(1));

    // Round 1 intermission -> round 2 play.
    s = { ...s, phase: 'intermission', deadlineTick: s.tick };
    s = advance(s);
    expect(s.phase).toBe('play');
    expect(s.round).toBe(2);

    // Round 2 (last, index maxRounds-1) intermission -> over.
    s = { ...s, phase: 'intermission', deadlineTick: s.tick };
    s = advance(s);
    expect(s.phase).toBe('over');
    expect(s.deadlineTick).toBeUndefined();
  });

  it('does not mutate the input state (pure)', () => {
    const s = baseState({ phase: 'vote', mode: 'party', tick: 5, deadlineTick: 5, votes: { a: 'b' } });
    const snapshot = JSON.stringify(s);
    advance(s);
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe('advance — full match reaches over', () => {
  it('drives party play->vote->intermission across all rounds to over', () => {
    let s: State = baseState({ tick: 0 });
    s = { ...s, ...startMatch(s, 'party') };
    let guard = 0;
    while (s.phase !== 'over' && guard < 50) {
      // jump time to the deadline, then advance.
      s = { ...s, tick: s.deadlineTick ?? s.tick };
      s = advance(s);
      guard++;
    }
    expect(s.phase).toBe('over');
    expect(s.round).toBe(MAX_ROUNDS - 1);
  });
});

describe('advance — turnbased round timeout', () => {
  it('play -> intermission when the relay window expires', () => {
    let s = baseState({
      phase: 'play',
      mode: 'turnbased',
      tick: 50,
      deadlineTick: 50,
      turnOrder: ['a', 'b', 'c'],
      activeIdx: 1,
      word: 'tre',
    });
    s = advance(s);
    expect(s.phase).toBe('intermission');
  });
});

describe('applyLetter — turnbased scoring', () => {
  const turn = (over: Partial<State> = {}): State =>
    baseState({
      phase: 'play',
      mode: 'turnbased',
      turnOrder: ['a', 'b', 'c'],
      activeIdx: 0,
      word: '',
      ...over,
    });

  it('rejects a move out of turn', () => {
    expect(applyLetter(turn(), 'b', 't')).toBeNull();
  });

  it('rejects a non-letter', () => {
    expect(applyLetter(turn(), 'a', '3')).toBeNull();
    expect(applyLetter(turn(), 'a', 'ab')).toBeNull();
  });

  it('appends a letter and advances the turn', () => {
    const patch = applyLetter(turn({ word: 'tre' }), 'a', 'e');
    // 'tree' is a valid word -> scores and resets.
    expect(patch).not.toBeNull();
    expect(patch!.word).toBe('');
    expect(patch!.players?.a?.score).toBe(ROUND_POINTS);
    expect(patch!.activeIdx).toBe(1);
  });

  it('builds toward a word without scoring until length >= 4', () => {
    const patch = applyLetter(turn({ word: 'ca' }), 'a', 't');
    // 'cat' is length 3 -> no score, keep building. A non-scoring move does
    // not touch scores, so the patch omits `players` entirely.
    expect(patch!.word).toBe('cat');
    expect(patch!.players).toBeUndefined();
    expect(patch!.activeIdx).toBe(1);
  });

  it('wraps activeIdx around the turn order', () => {
    const patch = applyLetter(turn({ activeIdx: 2 }), 'c', 'q');
    expect(patch!.activeIdx).toBe(0);
  });
});

describe('ranking', () => {
  it('sorts by score desc then name asc', () => {
    const players = {
      a: { name: 'Ann', score: 50, present: true },
      b: { name: 'Bob', score: 100, present: true },
      c: { name: 'Cleo', score: 100, present: false },
    };
    const r = ranking(players);
    expect(r.map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });
});
