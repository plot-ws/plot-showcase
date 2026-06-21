/**
 * Blobs — an agar.io-style .io arena, end to end on Plot.
 *
 * `mount` opens a canvas filling the host, joins the room by code, attaches the
 * authoritative handler for client-side prediction, and runs a render loop that
 * draws the camera-centred world (grid, pellets, blobs) plus an HTML HUD. Local
 * movement is predicted from the mouse vector and reconciled by the server.
 */
import { Plot, type Room } from '@plot/client';
import type { GameModule, PlotConfig } from '../../plot-config';
import {
  type BlobWorld,
  type Vec2,
  radius,
} from './logic';
import { handler } from './handler';

const meta = {
  id: 'blobs',
  name: 'Blobs',
  usecase: '.io arena',
  blurb: 'Eat pellets, dodge bigger blobs, top the leaderboard.',
  defaultRoom: 'BLOBS1',
} as const;

/** Deterministic, pleasant HSL colour derived from a player id. */
function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue} 70% 55%)`;
}

/** First 4 characters of an id, for an on-blob label. */
function shortId(id: string): string {
  return id.slice(0, 4);
}

/** The "Leaderboard" heading row for the HUD board. */
function boardHeading(): HTMLElement {
  const el = document.createElement('div');
  el.style.fontWeight = '700';
  el.style.marginBottom = '4px';
  el.style.opacity = '0.7';
  el.textContent = 'Leaderboard';
  return el;
}

/** A single ranked leaderboard row, built with safe DOM (no innerHTML). */
function boardRow(rank: number, id: string, mass: number, isYou: boolean): HTMLElement {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.justifyContent = 'space-between';
  row.style.gap = '12px';

  const name = document.createElement('span');
  name.style.color = colorFor(id);
  name.textContent = `${rank}. ${shortId(id)}${isYou ? ' (you)' : ''}`;

  const score = document.createElement('span');
  score.style.opacity = '0.8';
  score.textContent = String(Math.round(mass));

  row.append(name, score);
  return row;
}

/** Placeholder row shown when no players are present. */
function emptyRow(): HTMLElement {
  const el = document.createElement('div');
  el.style.opacity = '0.6';
  el.textContent = 'no players';
  return el;
}

/** Coerce an unknown leaf to a Vec2, or null if it isn't shaped like one. */
function asVec2(value: unknown): Vec2 | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.x === 'number' && typeof v.y === 'number') {
    return { x: v.x, y: v.y };
  }
  return null;
}

function mount(host: HTMLElement, config: PlotConfig, roomCode: string): () => void {
  // --- DOM scaffold ------------------------------------------------------
  host.style.position = 'relative';

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.background = '#0b0e14';
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // HUD: absolutely-positioned divs over the canvas.
  const hud = document.createElement('div');
  hud.style.position = 'absolute';
  hud.style.inset = '0';
  hud.style.pointerEvents = 'none';
  hud.style.fontFamily = 'system-ui, sans-serif';
  hud.style.color = '#e6e9ef';

  const roomTag = document.createElement('div');
  roomTag.style.position = 'absolute';
  roomTag.style.top = '12px';
  roomTag.style.left = '50%';
  roomTag.style.transform = 'translateX(-50%)';
  roomTag.style.fontSize = '32px';
  roomTag.style.fontWeight = '800';
  roomTag.style.letterSpacing = '2px';
  roomTag.style.opacity = '0.85';
  roomTag.textContent = roomCode;

  const massTag = document.createElement('div');
  massTag.style.position = 'absolute';
  massTag.style.bottom = '14px';
  massTag.style.left = '16px';
  massTag.style.fontSize = '15px';
  massTag.style.fontWeight = '600';
  massTag.textContent = 'mass —';

  const board = document.createElement('div');
  board.style.position = 'absolute';
  board.style.top = '14px';
  board.style.right = '16px';
  board.style.minWidth = '160px';
  board.style.padding = '10px 12px';
  board.style.borderRadius = '10px';
  board.style.background = 'rgba(17,21,30,0.72)';
  board.style.fontSize = '13px';
  board.style.lineHeight = '1.5';

  hud.append(roomTag, massTag, board);
  host.appendChild(hud);

  // --- Resize ------------------------------------------------------------
  let dpr = window.devicePixelRatio || 1;
  function resize(): void {
    dpr = window.devicePixelRatio || 1;
    const w = host.clientWidth;
    const h = host.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
  }
  resize();
  window.addEventListener('resize', resize);

  // --- Pointer -----------------------------------------------------------
  // Mouse position relative to canvas centre, and whether it's inside.
  let pointer: { x: number; y: number } | null = null;
  function onPointerMove(e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    if (cx < 0 || cy < 0 || cx > rect.width || cy > rect.height) {
      pointer = null;
      return;
    }
    pointer = { x: cx - rect.width / 2, y: cy - rect.height / 2 };
  }
  function onPointerLeave(): void {
    pointer = null;
  }
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);

  // --- Plot wiring -------------------------------------------------------
  const plot = new Plot({
    appKey: config.appKey,
    playerId: config.playerId,
    apiUrl: config.apiUrl,
  });

  const localId = config.playerId;
  const localPath = `positions.${localId}`;

  let room: Room | null = null;
  let tornDown = false;
  let rafId = 0;
  let lastFrameTs = 0;
  // Latest interpolated map from frame events: resolved leaf path -> value.
  let interpolated: Record<string, unknown> = {};

  function draw(): void {
    rafId = requestAnimationFrame(draw);
    if (room === null || ctx === null) return;

    const now = performance.now();
    const dtRaw = lastFrameTs === 0 ? 0 : (now - lastFrameTs) / 1000;
    lastFrameTs = now;
    const dt = Math.min(0.1, dtRaw);

    const state = room.currentState as BlobWorld | undefined;
    const masses: Record<string, number> = state?.mass ?? {};
    const pellets: Vec2[] = state?.pellets ?? [];

    // Local blob: prefer the predicted/corrected position, fall back to state.
    const localPos =
      asVec2(room.correctedState[localPath]) ??
      asVec2(state?.positions?.[localId]) ??
      { x: 0, y: 0 };

    // Send predicted movement from the mouse vector while pointer is inside.
    if (pointer !== null && dt > 0) {
      const len = Math.hypot(pointer.x, pointer.y);
      if (len > 0.0001) {
        const dx = pointer.x / Math.max(len, 1);
        const dy = pointer.y / Math.max(len, 1);
        room.sendPredicted({ kind: 'move', dx, dy, dt });
      }
    }

    // --- Render ----------------------------------------------------------
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, w, h);

    // World->screen: scale to DPR, translate so the local blob is centred.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const viewW = w / dpr;
    const viewH = h / dpr;
    const camX = localPos.x;
    const camY = localPos.y;
    const ox = viewW / 2 - camX;
    const oy = viewH / 2 - camY;

    // Faint grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    const grid = 100;
    const startX = Math.floor((camX - viewW / 2) / grid) * grid;
    const endX = camX + viewW / 2;
    for (let gx = startX; gx <= endX; gx += grid) {
      ctx.beginPath();
      ctx.moveTo(gx + ox, oy - 10000);
      ctx.lineTo(gx + ox, oy + 10000);
      ctx.stroke();
    }
    const startY = Math.floor((camY - viewH / 2) / grid) * grid;
    const endY = camY + viewH / 2;
    for (let gy = startY; gy <= endY; gy += grid) {
      ctx.beginPath();
      ctx.moveTo(ox - 10000, gy + oy);
      ctx.lineTo(ox + 10000, gy + oy);
      ctx.stroke();
    }

    // Pellets.
    ctx.fillStyle = '#5eead4';
    for (const p of pellets) {
      ctx.beginPath();
      ctx.arc(p.x + ox, p.y + oy, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Blobs. Remotes come from interpolation; the local one from prediction.
    const drawn = new Set<string>();
    const drawBlob = (id: string, pos: Vec2): void => {
      if (drawn.has(id)) return;
      drawn.add(id);
      const m = masses[id] ?? 12;
      const r = radius(m);
      ctx.fillStyle = colorFor(id);
      ctx.beginPath();
      ctx.arc(pos.x + ox, pos.y + oy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(shortId(id), pos.x + ox, pos.y + oy);
    };

    // Remote blobs from the interpolated frame.
    for (const [path, value] of Object.entries(interpolated)) {
      const id = path.startsWith('positions.') ? path.slice('positions.'.length) : path;
      if (id === localId) continue;
      const v = asVec2(value);
      if (v !== null) drawBlob(id, v);
    }

    // Any blobs present in state but not yet interpolated (e.g. just joined).
    const positions = state?.positions ?? {};
    for (const id of Object.keys(positions)) {
      if (id === localId) continue;
      if (drawn.has(id)) continue;
      const v = asVec2(positions[id]);
      if (v !== null) drawBlob(id, v);
    }

    // Local blob drawn last so it's on top.
    drawBlob(localId, localPos);

    // --- HUD -------------------------------------------------------------
    const localMass = masses[localId];
    massTag.textContent = `mass ${localMass !== undefined ? Math.round(localMass) : '—'}`;

    const ranked = Object.entries(masses)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    board.replaceChildren(boardHeading());
    if (ranked.length === 0) {
      board.appendChild(emptyRow());
    } else {
      ranked.forEach(([id, m], i) => {
        board.appendChild(boardRow(i + 1, id, m, id === localId));
      });
    }
  }

  // --- Async init --------------------------------------------------------
  void (async () => {
    try {
      const joined = await plot.join({ mode: 'code', roomCode });
      if (tornDown) {
        // Torn down before join resolved: leave immediately and bail.
        joined.leave();
        return;
      }
      room = joined;
      room.attachHandler(handler);
      room.predict({ path: localPath, type: 'vec2', correctionMs: 120 });
      room.interpolate({ path: 'positions.*', type: 'vec2', renderDelay: 100 });
      room.on('frame', ({ interpolated: frame }) => {
        interpolated = frame;
      });
      room.startFrameLoop(16);
      rafId = requestAnimationFrame(draw);
    } catch {
      // Connection failed; leave the canvas in place but stop animating.
      // (Nothing to tear down beyond the listeners handled below.)
    }
  })();

  // --- Teardown ----------------------------------------------------------
  return () => {
    tornDown = true;
    if (rafId !== 0) cancelAnimationFrame(rafId);
    rafId = 0;
    window.removeEventListener('resize', resize);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    if (room !== null) {
      room.stopFrameLoop();
      room.leave();
      room = null;
    }
  };
}

const module: GameModule = { meta, mount };
export default module;
