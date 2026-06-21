/**
 * Shared config + the game-module contract for the Plot showcase.
 *
 * Every game under `src/games/<id>/` is a self-contained module that exports a
 * `GameModule` (a `meta` descriptor + a `mount` function). The shell in
 * `main.ts` renders a menu from the metas and mounts the chosen game into a
 * host element, calling the returned teardown when the user navigates away.
 */

/** Connection settings every game needs to reach a Plot backend. */
export type PlotConfig = {
  /** Publishable app key, e.g. `pl_pub_live_xxx`, from your Plot dashboard. */
  appKey: string;
  /** Override the API origin for local/self-hosted stacks (optional). */
  apiUrl?: string;
  /** A stable per-tab player id. */
  playerId: string;
};

/** Static description of a game, used to render the menu. */
export type GameMeta = {
  /** URL-safe id; also the folder name under `src/games/`. */
  id: string;
  /** Display name. */
  name: string;
  /** Which documented Plot use-case(s) this game showcases. */
  usecase: string;
  /** One-line pitch shown on the menu card. */
  blurb: string;
  /** Default room code to join (games are joined by a short shared code). */
  defaultRoom: string;
};

/**
 * A playable game. `mount` takes the host element, the Plot connection config,
 * and the room code to join, and returns a teardown function that must close
 * the room and remove any listeners/animation loops.
 */
export type GameModule = {
  meta: GameMeta;
  mount: (host: HTMLElement, config: PlotConfig, roomCode: string) => () => void;
};

/** Read Plot connection settings from Vite env, with sensible local defaults. */
export function getPlotConfig(): PlotConfig {
  const env = import.meta.env;
  return {
    appKey: (env.VITE_PLOT_APP_KEY as string | undefined) ?? 'pl_pub_local_dev',
    apiUrl: env.VITE_PLOT_API_URL as string | undefined,
    playerId: getPlayerId(),
  };
}

/** A stable random player id, persisted for the browser session. */
function getPlayerId(): string {
  const key = 'plot.playerId';
  let id = sessionStorage.getItem(key);
  if (id === null) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}
