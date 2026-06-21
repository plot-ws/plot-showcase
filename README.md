# Plot showcase

Three small, playable multiplayer games built on [Plot](https://plot.ws) — the
cheap, fast, indie-friendly multiplayer backend on Cloudflare. Each is a few
hundred lines on top of [`@plot/client`](https://plot.ws/docs), and together they
cover the four shapes of multiplayer Plot is built for.

| Game | Use-case | What it shows |
|------|----------|---------------|
| **Blobs** | `.io` arena | Hundreds of moving entities in one room — client-side **prediction** + remote **interpolation** + an **authoritative handler** + a live **leaderboard**. |
| **Caption Clash** | Party **+** Turn-based | One lobby/rounds engine, two modes: a simultaneous caption battle (party) and a take-turns word relay (turn-based). Room codes, presence, shared scoreboard. |
| **Siege** | Co-op survival | 2–8 players vs the game. The **server** owns wave spawning, enemy pathing and damage — the textbook case for authoritative netcode. |

This is the repo linked from the Plot site. It's a plain Vite + TypeScript app —
no game framework — so it's easy to read and fork.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL, pick a game, and play. Open a second tab (or send a friend
the room code) to see it go multiplayer.

You need a Plot app to connect to. Two options:

- **Hosted:** create an app in the [Plot dashboard](https://plot.ws), grab its
  publishable key, and run with it:
  ```bash
  VITE_PLOT_APP_KEY=pl_pub_live_xxx npm run dev
  ```
- **Local:** run the Plot server locally and point the demo at it:
  ```bash
  VITE_PLOT_APP_KEY=pl_pub_local_dev VITE_PLOT_API_URL=http://localhost:8787 npm run dev
  ```

Each game also ships an authoritative handler (`src/games/<game>/handler.ts`).
Deploy a game's handler to your Plot app, then join its room code to play against
the real server. See the [Plot docs](https://plot.ws/docs) for handler deployment.

## How it's organized

```
src/
  main.ts            menu shell — lists games, mounts the chosen one
  plot-config.ts     the GameModule contract + env-driven Plot config
  games/
    blobs/           .io arena      (handler.ts · logic.ts · index.ts · logic.test.ts)
    party/           party + turn-based lobby
    siege/           co-op survival
vendor/
  plot-client/       self-contained @plot/client build (see note below)
  plot-handler/      self-contained @plot/handler build
```

Every game is a `GameModule`: a `meta` descriptor plus a `mount(host, config,
roomCode)` function that returns a teardown. Adding a game is an import in
`main.ts` and a folder under `games/`.

The pure game rules live in each game's `logic.ts` (no Plot imports), so they're
unit-tested deterministically:

```bash
npm test         # 34 tests across the three games
npm run typecheck
npm run build
```

## A note on the vendored client

`@plot/client` and `@plot/handler` are vendored under `vendor/` as
self-contained builds so this repo runs today. Once the `@plot/*` packages are
published to npm, replace the `file:` dependencies in `package.json` with the
published versions — the import paths (`@plot/client`, `@plot/handler`) don't
change.

## Deploy

`npm run build` produces a static `dist/`. Host it anywhere — it's designed for
Cloudflare Workers/Pages static assets, which are free and pair naturally with a
Plot backend on the same account.

## License

MIT — see [LICENSE](./LICENSE).
