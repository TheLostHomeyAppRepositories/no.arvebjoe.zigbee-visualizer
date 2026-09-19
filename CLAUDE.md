# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: working scaffold, no features yet

The app builds and validates (`homey app build` passes at level `debug`), but `app.ts` is still the stock
template and there are no drivers. Treat feature work here as greenfield.

### `homey app create` is broken upstream — do not re-run it

The scaffold arrived half-created because **Homey CLI 4.5.0 cannot create an app with ESLint enabled**.
`App.create()` runs `npm install --save-dev eslint@^7.32.0 eslint-config-athom`, but `eslint-config-athom@4`
declares `peerDependencies: eslint >=8.57.1 <9.0.0`. npm fails with ERESOLVE and creation aborts partway,
leaving only `package.json` plus empty directories — every file after that step is silently missing
(`app.json`, `.homeycompose/app.json`, `app.ts`, `assets/icon.svg`, `locales/en.json`, `README.txt`,
`.homeychangelog.json`, LICENSE/CODE_OF_CONDUCT/CONTRIBUTING). Without `app.json` the CLI cannot read a
manifest, so `homey app build` and `homey app run` both fail.

Reproduced deterministically on 2026-09-19 with CLI 4.5.0. If you ever need to scaffold again (a fresh app,
or to recover a file), **answer `No` to "Use ESLint?"** — creation then completes — and wire up ESLint
afterwards as this repo does. The missing files here were recovered exactly that way.

## Commands

```bash
npm run build    # tsc -> .homeybuild/
npm run lint     # eslint, Athom's Homey-app ruleset, type-aware
```

The real workflow is the Homey CLI, which runs the TS build itself — prefer `homey app build` /
`homey app run` over `npm run build`. No test script or framework is configured.

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

`eslint` is held at `^8.57.1`: `eslint-config-athom@4` declares `peerDependencies: eslint >=8.57.1 <9.0.0`.
ESLint 8 is end-of-life, and Athom has shipped no flat-config version, so this stays until they do —
migrating to ESLint 9+ means dropping the Athom config, and would also require rewriting the lint script
(`--ext` and `--ignore-path` were both removed in ESLint 9).

`@typescript-eslint/eslint-plugin` and `/parser` are direct devDependencies even though the Athom config
already depends on them. That is deliberate: legacy eslintrc resolves plugins from the project root, and
npm nests the config's own copies (the `typescript` version conflict prevents hoisting), so without the
top-level entries ESLint fails with "couldn't find the plugin".

Known noise: the Homey TS templates use `import Homey from 'homey'` together with `module.exports = class`,
which trips `import/no-import-module-exports` as a warning on every file. It is inherent to the SDK's
CommonJS pattern, not a bug in the code.

### Homey CLI

The CLI is not a project dependency — install it globally (`npm i -g homey`) or run it via
`npx --yes homey@latest`. It drives the real workflow: `homey app run` (live on a Homey), `homey app build`,
`homey app validate`, `homey app install`. The TS build is invoked by the CLI, so run `homey app run`
rather than `npm run build` when testing on a device.

## What the scaffold is

This is an [Athom Homey](https://homey.app) app (`homey app create` layout). The app id is the directory /
package name, `no.arvebjoe.zigbee-visualizer` — Homey app ids are reverse-DNS and must stay in sync with
the `id` in the app manifest.

The (still mostly empty) directories are Homey's **compose** layout. `homey app build` merges them into the generated
`app.json`; you author the pieces, not `app.json` directly:

- `.homeycompose/` — app-level fragments: `capabilities/`, `flow/{triggers,conditions,actions}/`,
  `discovery/`, `locales/`, `signals/{433,868,ir}/`, `screensavers/`, and `drivers/{settings,templates}/`
  for fragments shared across drivers.
- `drivers/<id>/` — per-driver `driver.compose.json`, `driver.js`/`device.js`, `assets/`, `pair/`.
- `assets/` — `icon.svg` (present) and `images/` for store artwork (empty, see above).
- `locales/` — `en.json` and other translation files.

## The app manifest

`.homeycompose/app.json` is the **source** manifest; the root `app.json` is generated from it by
`homey app build` and carries a `_comment` saying so. Edit the compose one — root `app.json` edits get
overwritten. Both are committed, which is the Homey convention.

`author` was filled in automatically from the logged-in Athom profile during scaffolding.

**Publish is blocked until the store images exist.** `homey app validate --level publish` fails with
`Filepath does not exist: /assets/images/small.png`. The manifest references `small.png`, `large.png` and
`xlarge.png` under `assets/images/`, but `homey app create` never generates them — supplying artwork is a
manual step. `homey app run` and level `debug` validation work fine without them, so this only matters at
publish time.

## Related project

`../homey-zigbee-visualizer` is a separate repo (its own git, own remote) implementing the same idea as a
standalone local Express + d3 web app that renders exported Homey Zigbee network dumps. It's the natural
reference for the visualization logic when this Homey-app version gets built out — but it is *not* part of
this project; don't edit it as a side effect of work here.
