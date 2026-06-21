/**
 * "Caption Clash" — the party + turn-based showcase module.
 *
 * One lobby/rounds engine, two modes (see `logic.ts`):
 *  - party     simultaneous caption → vote → score
 *  - turnbased sequential word relay
 *
 * The client is pure presentation: it reads the authoritative snapshot from
 * `room.currentState` and sends intents on the `event` channel. To keep typing
 * smooth, the phase-specific DOM is only rebuilt when a structural signature
 * changes; the countdown text is updated on every poll without a rebuild.
 */
import './party.css';
import { Plot, type Room } from '@plot/client';
import type { GameModule, PlotConfig } from '../../plot-config';
import {
  TICKS_PER_SECOND,
  type Mode,
  type State,
  ranking,
} from './logic';

const game: GameModule = {
  meta: {
    id: 'party',
    name: 'Caption Clash',
    usecase: 'Party + Turn-based',
    blurb: 'A join-by-code lobby with two round modes: simultaneous caption battles and a take-turns word relay.',
    defaultRoom: 'PARTY1',
  },
  mount(host, config, roomCode) {
    return mountParty(host, config, roomCode);
  },
};

export default game;

function mountParty(host: HTMLElement, config: PlotConfig, roomCode: string): () => void {
  const me = config.playerId;

  // Root + persistent regions.
  const root = document.createElement('div');
  root.className = 'party';
  const header = document.createElement('div');
  header.className = 'party-header';
  const title = document.createElement('div');
  title.className = 'party-title';
  title.textContent = 'Caption Clash';
  const sub = document.createElement('div');
  sub.className = 'party-sub';
  sub.textContent = 'connecting…';
  header.append(title, sub);
  const stage = document.createElement('div');
  root.append(header, stage);
  host.appendChild(root);

  // Local UI drafts (preserved across re-renders).
  let nameDraft = '';
  let captionDraft = '';
  let pickedMode: Mode = 'party';
  let sentName = false;

  let room: Room | null = null;
  let disposed = false;
  let lastSig = '';
  let timerEl: HTMLElement | null = null;

  const send = (msg: unknown): void => {
    room?.send(msg, { channel: 'event' });
  };

  // ---- Render helpers -------------------------------------------------

  const secondsLeft = (s: State): number => {
    if (s.deadlineTick === undefined) return 0;
    return Math.max(0, Math.ceil((s.deadlineTick - s.tick) / TICKS_PER_SECOND));
  };

  const isVip = (s: State): boolean => {
    // VIP = first present player by stable id order (mirrors firstPlayer well
    // enough for UI gating; the server is authoritative on 'start').
    const present = Object.keys(s.players)
      .filter((id) => s.players[id]?.present)
      .sort();
    return present[0] === me;
  };

  const card = (): HTMLElement => {
    const c = document.createElement('div');
    c.className = 'party-card';
    return c;
  };

  const button = (label: string, cls = ''): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = `party-btn ${cls}`.trim();
    b.textContent = label;
    return b;
  };

  function renderLobby(s: State): HTMLElement {
    const c = card();

    const code = document.createElement('div');
    code.className = 'party-code';
    code.textContent = roomCode;
    code.title = 'Click to copy';
    code.addEventListener('click', () => void navigator.clipboard?.writeText(roomCode));
    const hint = document.createElement('div');
    hint.className = 'party-code-hint';
    hint.textContent = 'Share this code — anyone who joins it lands in this room.';
    c.append(code, hint);

    // Nickname row.
    const row = document.createElement('div');
    row.className = 'party-row';
    const input = document.createElement('input');
    input.className = 'party-input';
    input.placeholder = 'Your nickname';
    input.value = nameDraft;
    input.maxLength = 24;
    input.dataset.keep = 'name';
    input.addEventListener('input', () => { nameDraft = input.value; });
    const setBtn = button(sentName ? 'Update name' : 'Set name', 'ghost');
    setBtn.addEventListener('click', () => {
      const name = nameDraft.trim();
      if (name.length === 0) return;
      send({ kind: 'setName', name });
      sentName = true;
      setBtn.textContent = 'Update name';
    });
    row.append(input, setBtn);
    c.append(row);

    c.append(renderPlayers(s));

    if (isVip(s)) {
      const modeRow = document.createElement('div');
      modeRow.className = 'party-row';
      (['party', 'turnbased'] as Mode[]).forEach((m) => {
        const t = button(m === 'party' ? 'Party: captions' : 'Turn-based: word relay', 'toggle ghost');
        if (m === pickedMode) t.classList.add('active');
        t.addEventListener('click', () => {
          pickedMode = m;
          scheduleRender(true);
        });
        modeRow.append(t);
      });
      const start = button('Start match');
      start.addEventListener('click', () => send({ kind: 'start', mode: pickedMode }));
      c.append(modeRow, start);
    } else {
      const waiting = document.createElement('div');
      waiting.className = 'party-muted';
      waiting.textContent = 'Waiting for the host to start…';
      c.append(waiting);
    }
    return c;
  }

  function renderPlayers(s: State): HTMLElement {
    const list = document.createElement('div');
    list.className = 'party-list';
    const vipId = Object.keys(s.players).filter((id) => s.players[id]?.present).sort()[0];
    for (const { id, name, score, present } of ranking(s.players)) {
      const row = document.createElement('div');
      row.className = 'party-player';
      if (id === me) row.classList.add('me');
      if (!present) row.classList.add('absent');
      const dot = document.createElement('span');
      dot.className = 'party-dot';
      const nameEl = document.createElement('span');
      nameEl.className = 'party-name';
      nameEl.textContent = name + (id === me ? ' (you)' : '');
      const left = document.createElement('div');
      left.className = 'party-row';
      left.append(dot, nameEl);
      if (id === vipId) {
        const vip = document.createElement('span');
        vip.className = 'party-vip';
        vip.textContent = 'HOST';
        left.append(vip);
      }
      const sc = document.createElement('span');
      sc.className = 'party-score';
      sc.textContent = String(score);
      row.append(left, sc);
      list.append(row);
    }
    return list;
  }

  function addTimer(c: HTMLElement, s: State): void {
    const t = document.createElement('div');
    t.className = 'party-timer';
    t.textContent = `${secondsLeft(s)}s`;
    timerEl = t;
    c.append(t);
  }

  function renderPlayParty(s: State): HTMLElement {
    const c = card();
    const prompt = document.createElement('div');
    prompt.className = 'party-prompt';
    prompt.textContent = s.prompt ?? '…';
    c.append(prompt);
    addTimer(c, s);

    const submitted = s.submissions ?? {};
    if (me in submitted) {
      const done = document.createElement('div');
      done.className = 'party-muted';
      done.textContent = `Caption locked in. ${Object.keys(submitted).length} submitted so far…`;
      c.append(done);
    } else {
      const ta = document.createElement('textarea');
      ta.className = 'party-textarea';
      ta.placeholder = 'Type your funniest caption…';
      ta.value = captionDraft;
      ta.maxLength = 140;
      ta.dataset.keep = 'caption';
      ta.addEventListener('input', () => { captionDraft = ta.value; });
      const submit = button('Submit caption');
      submit.addEventListener('click', () => {
        const text = captionDraft.trim();
        if (text.length === 0) return;
        send({ kind: 'submit', text });
        captionDraft = '';
        scheduleRender(true);
      });
      c.append(ta, submit);
    }
    return c;
  }

  function renderVote(s: State): HTMLElement {
    const c = card();
    const h = document.createElement('div');
    h.className = 'party-prompt';
    h.textContent = 'Vote for your favourite';
    c.append(h);
    addTimer(c, s);

    const subs = s.submissions ?? {};
    const votes = s.votes ?? {};
    const myVote = votes[me];
    const wrap = document.createElement('div');
    wrap.className = 'party-submissions';
    for (const [id, text] of Object.entries(subs)) {
      const b = document.createElement('button');
      b.className = 'party-vote-card';
      if (myVote === id) b.classList.add('voted');
      b.textContent = id === me ? `${text}  (your caption)` : text;
      b.disabled = id === me || myVote !== undefined;
      b.addEventListener('click', () => {
        send({ kind: 'vote', target: id });
        scheduleRender(true);
      });
      wrap.append(b);
    }
    if (Object.keys(subs).length === 0) {
      const none = document.createElement('div');
      none.className = 'party-muted';
      none.textContent = 'Nobody submitted a caption this round.';
      wrap.append(none);
    }
    c.append(wrap);
    return c;
  }

  function renderTurnbased(s: State): HTMLElement {
    const c = card();
    const order = s.turnOrder ?? [];
    const activeIdx = s.activeIdx ?? 0;
    const activeId = order[activeIdx];
    const myTurn = activeId === me;

    const word = document.createElement('div');
    word.className = 'party-word';
    if ((s.word ?? '').length === 0) {
      const empty = document.createElement('span');
      empty.className = 'empty';
      empty.textContent = 'start a word…';
      word.append(empty);
    } else {
      word.textContent = s.word ?? '';
    }
    c.append(word);
    addTimer(c, s);

    const turn = document.createElement('div');
    turn.className = 'party-turn';
    const who = activeId ? (s.players[activeId]?.name ?? 'someone') : 'someone';
    if (myTurn) {
      turn.textContent = 'Your turn — add a letter (4+ letters scores).';
    } else {
      const strong = document.createElement('strong');
      strong.textContent = who;
      turn.append('Waiting on ', strong, ' …');
    }
    c.append(turn);

    if (myTurn) {
      const row = document.createElement('div');
      row.className = 'party-row';
      const input = document.createElement('input');
      input.className = 'party-input';
      input.placeholder = 'a';
      input.maxLength = 1;
      input.dataset.keep = 'letter';
      const play = button('Play letter');
      const submitLetter = (): void => {
        const letter = input.value.trim();
        if (!/^[a-z]$/i.test(letter)) return;
        send({ kind: 'play', letter });
        input.value = '';
      };
      play.addEventListener('click', submitLetter);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLetter(); });
      row.append(input, play);
      c.append(row);
    }
    return c;
  }

  function renderScoreboard(s: State, over: boolean): HTMLElement {
    const c = card();
    const board = ranking(s.players);

    if (over) {
      const banner = document.createElement('div');
      banner.className = 'party-banner';
      const winner = board[0];
      const crown = document.createElement('span');
      crown.className = 'crown';
      crown.textContent = '👑 ';
      banner.append(crown, document.createTextNode(`${winner?.name ?? 'Nobody'} wins!`));
      c.append(banner);
    } else {
      const h = document.createElement('div');
      h.className = 'party-prompt';
      h.textContent = `Round ${s.round + 1} of ${s.maxRounds} — scores`;
      c.append(h);
      addTimer(c, s);
    }

    const list = document.createElement('div');
    list.className = 'party-board';
    board.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'party-board-row';
      if (over && i === 0) row.classList.add('winner');
      const rank = document.createElement('span');
      rank.className = 'party-rank';
      rank.textContent = `#${i + 1}`;
      const name = document.createElement('span');
      name.className = 'party-name';
      name.textContent = p.name + (p.id === me ? ' (you)' : '');
      const sc = document.createElement('span');
      sc.className = 'party-score';
      sc.textContent = String(p.score);
      row.append(rank, name, sc);
      list.append(row);
    });
    c.append(list);
    return c;
  }

  function renderConnecting(): HTMLElement {
    const c = card();
    const m = document.createElement('div');
    m.className = 'party-muted';
    m.textContent = 'Joining room…';
    c.append(m);
    return c;
  }

  // ---- Render loop ----------------------------------------------------

  function build(s: State | undefined): { sig: string; el: HTMLElement } {
    if (!s) return { sig: 'connecting', el: renderConnecting() };
    switch (s.phase) {
      case 'lobby':
        return { sig: `lobby|${Object.keys(s.players).length}|${isVip(s)}|${pickedMode}|${sentName}`, el: renderLobby(s) };
      case 'play':
        if (s.mode === 'turnbased') {
          return { sig: `tb|${s.round}|${s.activeIdx}|${(s.word ?? '').length}`, el: renderTurnbased(s) };
        }
        return { sig: `play|${s.round}|${me in (s.submissions ?? {})}`, el: renderPlayParty(s) };
      case 'vote':
        return { sig: `vote|${s.round}|${(s.votes ?? {})[me] ?? ''}|${Object.keys(s.submissions ?? {}).length}`, el: renderVote(s) };
      case 'intermission':
        return { sig: `inter|${s.round}`, el: renderScoreboard(s, false) };
      case 'over':
        return { sig: 'over', el: renderScoreboard(s, true) };
      default:
        return { sig: 'connecting', el: renderConnecting() };
    }
  }

  let pending = false;
  function scheduleRender(force = false): void {
    if (force) lastSig = '';
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; doRender(); });
  }

  function doRender(): void {
    if (disposed) return;
    const s = room?.currentState as State | undefined;
    const { sig, el } = build(s);
    sub.textContent = s ? phaseLabel(s) : 'connecting…';
    if (sig !== lastSig) {
      lastSig = sig;
      timerEl = null;
      stage.replaceChildren(el);
      // Restore focus + caret to a kept input if one is present.
      const keep = stage.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-keep]');
      if (keep && keep.dataset.keep !== 'name') keep.focus();
    } else if (timerEl && s) {
      timerEl.textContent = `${secondsLeft(s)}s`;
    }
  }

  function phaseLabel(s: State): string {
    switch (s.phase) {
      case 'lobby': return `Lobby · ${Object.values(s.players).filter((p) => p.present).length} here`;
      case 'play': return s.mode === 'turnbased' ? 'Word relay' : 'Captioning';
      case 'vote': return 'Voting';
      case 'intermission': return 'Scores';
      case 'over': return 'Game over';
      default: return '';
    }
  }

  // Poll the snapshot a few times a second; events trigger an immediate pass.
  const poll = window.setInterval(doRender, 200);

  // ---- Connect --------------------------------------------------------

  void (async () => {
    const plot = new Plot({ appKey: config.appKey, playerId: config.playerId, apiUrl: config.apiUrl });
    const joined = await plot.join({ mode: 'code', roomCode });
    if (disposed) {
      joined.leave();
      return;
    }
    room = joined;
    room.on('join', () => scheduleRender());
    room.on('leave', () => scheduleRender());
    room.on('message', () => scheduleRender());
    scheduleRender(true);
  })().catch((err) => {
    sub.textContent = 'Failed to join room';
    console.error('[party] join failed', err);
  });

  // ---- Teardown -------------------------------------------------------

  return () => {
    disposed = true;
    window.clearInterval(poll);
    room?.leave();
    root.remove();
  };
}
