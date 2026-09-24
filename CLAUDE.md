# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What the app is

An [Athom Homey](https://homey.app) app (SDK 3, TypeScript) that maps the Homey's Zigbee mesh: every
device, the route each takes back to Homey, and a quality grade per hop. It has no drivers, no flows
and no devices of its own; it reads the Zigbee state through the Web API and draws it. The app id
`no.arvebjoe.zigbee-visualizer` is the directory / package name and must stay in sync with the manifest.

There are two front ends over the same data:

- **Settings page** (`settings/index.html`): the map inside the Homey app. It calls the app's API routes
  (`api.ts`, declared under `api` in the manifest: `/network`, `/state`, `/visualizer`) through
  `Homey.api`, and holds the **Browser view** switch (`Homey.get/set('webServer')`).
- **Browser view** (`web/`): the full visualizer, served by the app itself on port 8154
  (`lib/web-server.ts`), with snapshot history, a Changes tab, route history, export and dump import.
  **Off until the user switches it on**, because it has no login; `app.ts` starts and stops the server
  as the `webServer` setting changes.

### Where things live

- `app.ts` — the app: fetches the state with `HomeyAPI.createAppAPI` (needs the `homey:manager:api`
  permission, which makes store review slower), wires the web server and the snapshots together.
- `lib/zigbee-graph.ts` — `buildGraph()`, **the only graph builder**. The settings page and the browser
  view both get graphs from it; the browser never parses raw state. Keep it that way: a second copy in
  `web/` existed once and drifted.
- `lib/snapshots.ts` — the history, in `/userdata/snapshots/` (the one writable folder; it survives
  updates). A snapshot is `<UTC time>.json`, e.g. `2026-09-24T12-00-00Z.json`, so sorting by name is
  sorting by time. Dumps imported in the browser live in the same folder as `import-<UTC time>.json`,
  and the prefix keeps them out of `list()`: they are not part of the timeline, the route history or the
  export. Settings are stored under the app setting `snapshots`; changing the interval deletes the
  history. `HOUR_MS` can be set to a minute to test the schedule quickly.
- `lib/export.ts` — the downloadable history, summarised for analysis by an AI.
- `lib/safe-json.ts` — `toSafeJson()` / `stripSecrets()`. **The network key must never be sent or
  stored**: everything written to disk goes through `toSafeJson`, and an imported dump through
  `stripSecrets` before anything else.
- `lib/web-server.ts` — a plain Node `http` server; no framework.

### Web server rules that are there on purpose

- **`isLocalHost` checks the `Host` header on every request.** It is what stops DNS rebinding (a public
  site pointing its own domain at the Homey and then reading the API as same-origin). Only IP addresses,
  `localhost`, single-label names and private suffixes (`.local`, `.lan`, `.home`, `.home.arpa`,
  `.internal`) pass. Don't remove it or widen it to public domains.
- POSTs must be `Content-Type: application/json`, which a cross-site page can't send without a CORS
  preflight the server never approves.
- HEAD is answered for the page's static files only; on `/api/*` it would do a GET's whole work.
- Imported dumps are limited to 5 MB (`DUMP_LIMIT`, repeated in `web/app.js`); an announced oversize
  upload gets a 413 and its body is drained unread, so the client can read the answer.

### `web/` has no build step

Plain browser JavaScript, loaded as classic scripts; d3 is vendored at `web/vendor/d3.min.js`. The
page's Content-Security-Policy (`web/index.html`) allows connections to its own origin only — no CDNs.
`tsconfig.json` excludes `web/`; the Homey CLI copies it into `.homeybuild/web/`, where
`lib/web-server.ts` finds it next to `lib/`.

## Commands

```bash
npm run build    # tsc -> .homeybuild/
npm run lint     # eslint over the TS and web/, Athom's Homey-app ruleset
```

The real workflow is the Homey CLI, which runs the TS build itself — prefer `homey app build` /
`homey app run` over `npm run build`. `homey app validate --level publish` passes; its one warning is
about the `homey:manager:api` review.

No test script or framework is configured. The `lib/` modules have no Homey dependency, so they can be
exercised outside a Homey: compile them to a scratch folder with
`npx tsc --ignoreConfig lib/web-server.ts ... --outDir <dir> --module commonjs --types node`, then drive
`startWebServer()` or `Snapshots` from a small Node script with fake callbacks and a fake `homey`
(`setTimeout`, `clearTimeout`, `clock.getTimezone`).

### Line endings

`.gitattributes` (`* text=auto eol=lf`) keeps every text file LF in the working tree, on Windows too,
overriding `core.autocrlf` (Git for Windows sets it to `true` system-wide). Don't drop it: the Homey CLI
rewrites `app.json` with LF on every build, which a CRLF checkout shows as modified forever, and ESLint's
`linebreak-style` reports every line of a CRLF file. A clone made before the file existed needs one
re-checkout (`git rm --cached -r . && git reset --hard`, on a clean tree).

### `homey app create` is broken upstream — do not re-run it

**Homey CLI 4.5.0 cannot create an app with ESLint enabled.** `App.create()` runs
`npm install --save-dev eslint@^7.32.0 eslint-config-athom`, but `eslint-config-athom@4` declares
`peerDependencies: eslint >=8.57.1 <9.0.0`. npm fails with ERESOLVE and creation aborts partway,
leaving only `package.json` plus empty directories — every file after that step is silently missing.
If you ever need to scaffold again (a fresh app, or to recover a file), **answer `No` to "Use ESLint?"**
— creation then completes — and wire up ESLint afterwards as this repo does. Reproduced on 2026-09-19.

### TypeScript setup

`tsconfig.json` extends `@tsconfig/node16` with `allowJs` and `outDir: .homeybuild/`. **The `outDir`
value is load-bearing, not a preference**: on a TS app the Homey CLI runs `npx tsc --showConfig`, hard-fails
unless the resolved `outDir` is exactly `./.homeybuild`, and only then runs `npm run build`. Don't change it.

Types come from `@types/homey`, which is an alias for `homey-apps-sdk-v3-types` — so `import Homey from
'homey'` type-checks even though the `homey` module itself is supplied by the Homey runtime at execution
time and is never a dependency of this app. Keep the alias when touching `package.json`.

### The TypeScript version is pinned to 6.x by the linter

`typescript` is held at `^6.0.3` **on purpose — do not bump it to 7.** The type-aware lint stack cannot run
on TS 7: `@typescript-eslint@8` peer-requires `typescript >=4.8.4 <6.1.0`, and forcing it past that fails at
runtime (`ts-api-utils` throws `Cannot read properties of undefined (reading 'Intrinsic')` against the TS 7
compiler API). `eslint-config-athom` itself depends on `typescript@^6.0.3`. TS 7 becomes viable only once
`@typescript-eslint` widens that peer range.

### Linting

`.eslintrc.json` extends `athom/homey-app` (Athom's own config — legacy eslintrc format, not flat config).
It layers airbnb-base, `plugin:homey-app/recommended` for Homey SDK misuse, and type-aware rules
(`no-floating-promises`, `no-misused-promises`) that read `tsconfig.json` — these are what catch a missing
`await` on an SDK call, so keep `tsconfig.json` in the repo root where the config expects it.

`web/**/*.js` has an override: browser globals plus `d3`, parsed as a script, and off are the two
type-aware rules (plain JS has no type information, and they crash without it), `homey-app/global-timers`
(an app rule, meaningless in a browser) and `no-use-before-define` for functions (the file calls functions
before defining them on purpose). Only `web/vendor/` is ignored.

`eslint` is held at `^8.57.1`: `eslint-config-athom@4` declares `peerDependencies: eslint >=8.57.1 <9.0.0`.
ESLint 8 is end-of-life, and Athom has shipped no flat-config version, so this stays until they do —
migrating to ESLint 9+ means dropping the Athom config, and would also require rewriting the lint script
(`--ext` and `--ignore-path` were both removed in ESLint 9).

`@typescript-eslint/eslint-plugin` and `/parser` are direct devDependencies even though the Athom config
already depends on them. That is deliberate: legacy eslintrc resolves plugins from the project root, and
npm nests the config's own copies (the `typescript` version conflict prevents hoisting), so without the
top-level entries ESLint fails with "couldn't find the plugin".

Known noise: the Homey TS templates use `import Homey from 'homey'` together with `module.exports = class`,
which trips `import/no-import-module-exports` as a warning on every import in `app.ts` and `api.ts`. It is
inherent to the SDK's CommonJS pattern, not a bug in the code.

### Homey CLI

The CLI is not a project dependency — install it globally (`npm i -g homey`) or run it via
`npx --yes homey@latest`. It drives the real workflow: `homey app run` (live on a Homey), `homey app build`,
`homey app validate`, `homey app install`. The TS build is invoked by the CLI, so run `homey app run`
rather than `npm run build` when testing on a device.

## The app manifest

`.homeycompose/app.json` is the **source** manifest; the root `app.json` is generated from it by
`homey app build` and carries a `_comment` saying so. Edit the compose one — root `app.json` edits get
overwritten. Both are committed, which is the Homey convention. The only other compose piece in use is
the manifest itself: there are no drivers, flows or capabilities.

Store artwork is in `assets/images/` (`small.png`, `large.png`, `xlarge.png`), next to `assets/icon.svg`.

A release bumps `version` in `.homeycompose/app.json`, `app.json` and `package.json` together, with an
entry in `.homeychangelog.json` (shown in the App Store, so user-facing wording only).

## Related project

`../homey-zigbee-visualizer` is a separate repo (its own git, own remote) implementing the same idea as a
standalone local Express + d3 web app that renders exported Homey Zigbee network dumps. `web/` started as
a copy of its front end and has since diverged: graphs now come from the Homey. It is *not* part of this
project; don't edit it as a side effect of work here.
