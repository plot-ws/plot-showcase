/**
 * Plot showcase shell.
 *
 * Renders a menu of games and mounts the chosen one into a stage element.
 * Each game is a self-contained `GameModule` (see `plot-config.ts`); adding a
 * game is just an import + an entry in `GAMES`.
 */
import './shell.css';
import { getPlotConfig, type GameModule } from './plot-config';
import blobs from './games/blobs';
import party from './games/party';
import siege from './games/siege';

const GAMES: GameModule[] = [blobs, party, siege];

const app = document.getElementById('app') as HTMLElement;
const config = getPlotConfig();

/** Active game's teardown, or null when on the menu. */
let teardown: (() => void) | null = null;

function clearStage(): void {
  if (teardown !== null) {
    teardown();
    teardown = null;
  }
  app.replaceChildren();
}

function renderMenu(): void {
  clearStage();

  const wrap = document.createElement('div');
  wrap.className = 'menu';

  const header = document.createElement('header');
  header.className = 'menu-header';
  header.innerHTML = `
    <div class="brand">plot<span>.ws</span></div>
    <h1>Multiplayer, in three shapes.</h1>
    <p>Each demo below is a few hundred lines on top of <code>@plot/client</code>.
       Open one in two tabs — or send a friend the room code — and play.</p>
  `;
  wrap.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const game of GAMES) {
    const card = document.createElement('button');
    card.className = 'card';
    card.innerHTML = `
      <span class="tag">${game.meta.usecase}</span>
      <h2>${game.meta.name}</h2>
      <p>${game.meta.blurb}</p>
      <span class="play">Play →</span>
    `;
    card.addEventListener('click', () => renderGame(game));
    grid.appendChild(card);
  }
  wrap.appendChild(grid);

  const foot = document.createElement('footer');
  foot.className = 'menu-foot';
  foot.innerHTML = `
    <span>${config.appKey.startsWith('pl_pub_local')
      ? 'Using a local dev key — set <code>VITE_PLOT_APP_KEY</code> to point at your app.'
      : 'Connected with your Plot app key.'}</span>
    <a href="https://plot.ws/docs" target="_blank" rel="noreferrer">Docs ↗</a>
  `;
  wrap.appendChild(foot);

  app.appendChild(wrap);
}

function renderGame(game: GameModule): void {
  clearStage();

  const room = promptRoom(game.meta.defaultRoom);
  if (room === null) {
    renderMenu();
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'gamebar';
  const back = document.createElement('button');
  back.className = 'back';
  back.textContent = '← All demos';
  back.addEventListener('click', renderMenu);
  const title = document.createElement('span');
  title.className = 'gametitle';
  title.textContent = `${game.meta.name} · room ${room}`;
  bar.append(back, title);

  const stage = document.createElement('div');
  stage.className = 'stage';

  app.append(bar, stage);
  teardown = game.mount(stage, config, room);
}

/** Ask for a room code, pre-filled with the game's default. */
function promptRoom(fallback: string): string | null {
  const input = window.prompt(
    'Room code to join (share it so others land in the same room):',
    fallback,
  );
  if (input === null) return null;
  const code = input.trim().toUpperCase();
  return code.length > 0 ? code : fallback;
}

renderMenu();
