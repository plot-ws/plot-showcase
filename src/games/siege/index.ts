/**
 * "Siege" — a 2–8 player co-op horde-survival showcase for an authoritative
 * Plot server. Players move with WASD around a shared arena while the server
 * spawns escalating enemy waves, owns all enemy state and damage resolution,
 * and defends a shared base. The client only predicts its own movement and
 * interpolates everyone else's positions; the rest of the world is read
 * straight from the authoritative snapshot.
 */
import { Plot, type Room } from '@plot/client';
import type { GameModule, PlotConfig } from '../../plot-config';
import { ARENA, BASE_HIT_RADIUS, PLAYER_FIRE_RANGE, dist, type Vec2 } from './logic';
import handler from './handler';
import type { State } from './handler';

/** Visual half-extent the world is drawn into (logical arena maps to this). */
const VIEW = ARENA;

/** Read a vec2 from an interpolated frame map, falling back to a snapshot. */
function readVec2(
  interp: Record<string, unknown> | undefined,
  path: string,
  fallback: Vec2 | undefined,
): Vec2 | undefined {
  const v = interp?.[path];
  if (v !== undefined && v !== null && typeof v === 'object') {
    const o = v as { x?: unknown; y?: unknown };
    if (typeof o.x === 'number' && typeof o.y === 'number') return { x: o.x, y: o.y };
  }
  return fallback;
}

const mod: GameModule = {
  meta: {
    id: 'siege',
    name: 'Siege',
    usecase: 'Co-op survival',
    blurb: 'Hold the base together against escalating server-driven hordes.',
    defaultRoom: 'SIEGE1',
  },

  mount(host: HTMLElement, config: PlotConfig, roomCode: string): () => void {
    // --- DOM + canvas --------------------------------------------------------
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let cssW = 0;
    let cssH = 0;
    const resize = (): void => {
      const rect = host.getBoundingClientRect();
      cssW = Math.max(1, Math.floor(rect.width));
      cssH = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      if (ctx !== null) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // --- Input ---------------------------------------------------------------
    const keys = new Set<string>();
    const onKeyDown = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
        keys.add(k);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      keys.delete(e.key.toLowerCase());
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // --- Async connection ----------------------------------------------------
    let room: Room | null = null;
    let rafId = 0;
    let disposed = false;
    let lastMove = 0;
    let gameover: { phase: 'won' | 'lost'; score: number } | null = null;
    /** Latest interpolated leaf-path → value map from the frame loop. */
    let frame: Record<string, unknown> = {};

    const playerId = config.playerId;

    const start = async (): Promise<void> => {
      const plot = new Plot({
        appKey: config.appKey,
        playerId,
        apiUrl: config.apiUrl,
      });
      const r = await plot.join({ mode: 'code', roomCode });
      if (disposed) {
        r.leave();
        return;
      }
      room = r;

      r.attachHandler(handler);
      r.predict({ path: `players.${playerId}.pos`, type: 'vec2', correctionMs: 120 });
      r.interpolate({ path: 'players.*.pos', type: 'vec2', renderDelay: 100 });
      r.interpolate({ path: 'enemies.*.pos', type: 'vec2', renderDelay: 100 });

      r.on('frame', ({ interpolated }) => {
        frame = interpolated;
      });

      r.on('message', ({ data }) => {
        const d = data as { kind?: unknown; phase?: unknown; score?: unknown };
        if (
          d.kind === 'gameover' &&
          (d.phase === 'won' || d.phase === 'lost') &&
          typeof d.score === 'number'
        ) {
          gameover = { phase: d.phase, score: d.score };
        }
      });

      r.startFrameLoop(16);
      lastMove = performance.now();
      loop();
    };

    // --- Render loop ---------------------------------------------------------
    const loop = (): void => {
      rafId = requestAnimationFrame(loop);
      const r = room;
      if (r === null || ctx === null) return;

      const now = performance.now();

      // Sample WASD → movement intent, send predicted to the server.
      let dx = 0;
      let dy = 0;
      if (keys.has('a')) dx -= 1;
      if (keys.has('d')) dx += 1;
      if (keys.has('w')) dy -= 1;
      if (keys.has('s')) dy += 1;
      const dt = Math.min(0.05, (now - lastMove) / 1000);
      lastMove = now;
      const state = r.currentState as State | undefined;
      if ((dx !== 0 || dy !== 0) && state !== undefined && state.phase === 'playing') {
        r.predict({ path: `players.${playerId}.pos`, type: 'vec2', correctionMs: 120 });
        r.sendPredicted({ kind: 'move', dx, dy, dt });
      }

      draw(ctx, r, now);
    };

    const draw = (g: CanvasRenderingContext2D, r: Room, now: number): void => {
      const state = r.currentState as State | undefined;
      g.clearRect(0, 0, cssW, cssH);
      g.fillStyle = '#0b0f17';
      g.fillRect(0, 0, cssW, cssH);
      if (state === undefined) {
        drawCenteredText(g, 'Connecting…', '#9aa7b8', 20);
        return;
      }

      // World → screen: fit the [-VIEW, VIEW] square into the smaller axis.
      const margin = 16;
      const size = Math.max(1, Math.min(cssW, cssH) - margin * 2);
      const scale = size / (VIEW * 2);
      const ox = cssW / 2;
      const oy = cssH / 2;
      const sx = (x: number): number => ox + x * scale;
      const sy = (y: number): number => oy + y * scale;

      // Arena border.
      g.strokeStyle = '#1d2738';
      g.lineWidth = 2;
      g.strokeRect(sx(-VIEW), sy(-VIEW), VIEW * 2 * scale, VIEW * 2 * scale);

      // Interpolated maps are keyed by resolved leaf path (from the frame event).
      const interpAll: Record<string, unknown> = frame;

      // --- Base ---------------------------------------------------------------
      const baseR = (BASE_HIT_RADIUS * 0.55 + (state.baseHp / 100) * baseHpRadius()) * scale;
      g.beginPath();
      g.arc(sx(0), sy(0), Math.max(6, baseR), 0, Math.PI * 2);
      g.fillStyle = state.baseHp > 0 ? '#3b82f6' : '#374151';
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = '#93c5fd';
      g.stroke();

      // --- Enemies ------------------------------------------------------------
      g.lineWidth = 2;
      for (const id in state.enemies) {
        const e = state.enemies[id];
        if (e === undefined) continue;
        const pos = readVec2(interpAll, `enemies.${id}.pos`, e.pos);
        if (pos === undefined) continue;
        const rad = Math.max(4, (6 + e.hp * 0.18) * scale);
        g.beginPath();
        g.arc(sx(pos.x), sy(pos.y), rad, 0, Math.PI * 2);
        g.fillStyle = '#ef4444';
        g.fill();
        g.strokeStyle = '#fca5a5';
        g.stroke();
      }

      // --- Players + fire lines ----------------------------------------------
      for (const pid in state.players) {
        const pl = state.players[pid];
        if (pl === undefined) continue;
        let pos: Vec2 | undefined;
        if (pid === playerId) {
          const corrected = r.correctedState[`players.${pid}.pos`] as Vec2 | undefined;
          pos = readVec2(undefined, '', corrected ?? pl.pos);
        } else {
          pos = readVec2(interpAll, `players.${pid}.pos`, pl.pos);
        }
        if (pos === undefined) continue;

        // Fire line toward the nearest in-range enemy (visual only).
        const targetId = nearestEnemyId(state, pos);
        if (targetId !== null) {
          const e = state.enemies[targetId];
          if (e !== undefined) {
            const epos = readVec2(interpAll, `enemies.${targetId}.pos`, e.pos);
            if (epos !== undefined) {
              g.beginPath();
              g.moveTo(sx(pos.x), sy(pos.y));
              g.lineTo(sx(epos.x), sy(epos.y));
              g.strokeStyle = 'rgba(250, 204, 21, 0.55)';
              g.lineWidth = 1.5;
              g.stroke();
            }
          }
        }

        g.beginPath();
        g.arc(sx(pos.x), sy(pos.y), Math.max(5, 12 * scale), 0, Math.PI * 2);
        g.fillStyle = pid === playerId ? '#22c55e' : '#86efac';
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = '#bbf7d0';
        g.stroke();
      }

      drawHud(g, state);
      drawOverlay(g, state, now);
    };

    const drawHud = (g: CanvasRenderingContext2D, state: State): void => {
      const alive = Object.keys(state.players).length;
      g.font = '14px system-ui, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillStyle = '#e5e7eb';
      g.fillText(`Wave ${state.wave}/${state.maxWaves}`, 14, 12);
      g.fillText(`Score ${state.score}`, 14, 32);
      g.fillText(`Players ${alive}`, 14, 52);

      // Base HP bar.
      const barW = 180;
      const barH = 12;
      const bx = 14;
      const by = 76;
      g.fillStyle = '#1f2937';
      g.fillRect(bx, by, barW, barH);
      g.fillStyle = state.baseHp > 30 ? '#22c55e' : '#ef4444';
      g.fillRect(bx, by, (Math.max(0, state.baseHp) / 100) * barW, barH);
      g.strokeStyle = '#374151';
      g.lineWidth = 1;
      g.strokeRect(bx, by, barW, barH);
      g.fillStyle = '#e5e7eb';
      g.fillText(`Base ${Math.max(0, Math.round(state.baseHp))}`, bx + barW + 8, by - 1);
    };

    const drawOverlay = (
      g: CanvasRenderingContext2D,
      state: State,
      now: number,
    ): void => {
      const phase = gameover?.phase ?? (state.phase !== 'playing' ? state.phase : null);
      if (phase === null) return;
      g.fillStyle = 'rgba(2, 6, 12, 0.72)';
      g.fillRect(0, 0, cssW, cssH);
      const pulse = 0.6 + 0.4 * Math.sin(now / 300);
      if (phase === 'won') {
        g.fillStyle = `rgba(34, 197, 94, ${pulse})`;
        drawCenteredText(g, 'VICTORY — base held', '#bbf7d0', 28, -14);
      } else {
        g.fillStyle = `rgba(239, 68, 68, ${pulse})`;
        drawCenteredText(g, 'DEFEAT — base destroyed', '#fecaca', 28, -14);
      }
      drawCenteredText(g, `Final score ${gameover?.score ?? state.score}`, '#e5e7eb', 18, 22);
    };

    const drawCenteredText = (
      g: CanvasRenderingContext2D,
      text: string,
      color: string,
      px: number,
      dy = 0,
    ): void => {
      g.font = `${px}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = color;
      g.fillText(text, cssW / 2, cssH / 2 + dy);
    };

    void start();

    // --- Teardown ------------------------------------------------------------
    return () => {
      disposed = true;
      if (rafId !== 0) cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      ro.disconnect();
      if (room !== null) {
        room.stopFrameLoop();
        room.leave();
        room = null;
      }
      if (canvas.parentNode === host) host.removeChild(canvas);
    };
  },
};

/** Logical radius the base grows by at full HP (purely cosmetic). */
function baseHpRadius(): number {
  return BASE_HIT_RADIUS * 0.9;
}

/** Find the id of the nearest enemy within auto-fire range of `p`. */
function nearestEnemyId(state: State, p: Vec2): string | null {
  let best: string | null = null;
  let bestD = PLAYER_FIRE_RANGE;
  for (const id in state.enemies) {
    const e = state.enemies[id];
    if (e === undefined) continue;
    const d = dist(e.pos, p);
    if (d <= bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

export default mod;
