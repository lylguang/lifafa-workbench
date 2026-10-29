# Repository Guidelines

## Project Structure & Module Organization

- `lwb/dsh-launcher.mjs` — entry point; starts the workbench locally.
- `lwb/profile/` — base runtime composition.
- `lwb/dsh-bundle/` — workbench shell, pack lifecycle, workspaces, gateways, client UI.
- `lwb/pack-sdk/` — pack manifest validation, registration, and scoping.
- `lwb/packs/<name>/` — packs: `spoken-video`, `publisher`, `whiteboard`, `benchmark`; each has `index.mjs`, `gateway.mjs`, `client.js`, `lwb-pack.json`, `test/`.
- `scripts/` — setup, delivery, and publisher dependency tooling.
- `docs/` — guides plus numbered design history (`docs/36-local-enhancements.md`).
- `vendor/deepseek-harness/` — pinned upstream checkout; do not patch directly.

Keep the core generic; scenes, business data, and task flows belong in a pack.

## Build, Test, and Development Commands

```bash
npm ci                       # install root dependencies
npm run setup                # fetch and build pinned DSH into vendor/
npm run dev -- --port 4173   # start locally and open the browser
npm run check                # syntax-check launcher, bundle, and pack files
npm run unit:test            # run node:test suites
npm test                     # link packs + check + profile smoke + unit tests
npm run dsh:dump             # print expanded runtime config
npm run publisher:install    # install playwright-core (no browser download)
```

Requires Node `^22.19.0 || >=24.0.0`; video work also needs `ffmpeg`, `ffprobe`, and Chrome/Edge.

## Coding Style & Naming Conventions

- ES modules only (`.mjs` for Node, `.js` for browser clients).
- 2-space indentation, single quotes, no semicolons.
- `camelCase` for functions and variables, `PascalCase` for classes, `kebab-case` for filenames (`spoken-video-store.mjs`).
- Domain errors use a `CODE` string plus Chinese user-facing text, e.g. `WHITEBOARD_INVALID_INPUT`.
- No linter or formatter is configured; match surrounding code and run `npm run check`.

## Testing Guidelines

- Framework: built-in `node:test` with `node:assert/strict`.
- Location: `lwb/packs/<name>/test/*.test.mjs`, `lwb/dsh-bundle/test/*.test.mjs`.
- Name tests as behavior statements, e.g. `test('parseProjectInput requires a name', ...)`.
- Use `mkdtemp` for fixtures and clean up in `finally`. No coverage threshold is enforced.
- UI changes need manual page checks; pack changes must verify load, unload, and reload.

## Commit & Pull Request Guidelines

- Commit subjects are short Chinese summaries, often area-prefixed: `发布器：视频号适配器 + 抖音探针校准 + 文档更新`.
- Target `main`; one topic per PR. Describe the problem, user-visible behavior, test results, and data/config migration.
- State which paths ran for real and which used stubs.
- Never include `lwb/local/`, `.env`, `vendor/`, `node_modules/`, generated media, or personal paths. Do not rewrite lockfiles for unrelated changes.
- Update `THIRD_PARTY_NOTICES.md` for added third-party code, fonts, audio, or images.

## Security & Configuration

Copy `.env.example` for local settings; never commit credentials or access tokens. Use an isolated instance for manual testing:

```bash
export LWB_DSH_HOME="$PWD/lwb/local/verification/dev/dsh-home"
export LWB_PACK_REGISTRY="$PWD/lwb/local/verification/dev/packs.json"
npm run dev -- --port 4174
```

