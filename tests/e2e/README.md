# DSH HUD — tests/e2e

Three layers, from cheapest/most portable to real GUI:

| Layer | Location | Runs where | What it proves |
|---|---|---|---|
| Capability probe | `probe-render/`, `probe-http.mjs` | probe-http anywhere; probe-render needs a normal desktop token | Whether Electron rendering is possible at all; current DSH Web auth matrix |
| Headless integration | `unit/` (mock `electron`) | DSH agent sandbox (in-process) | Window state machine, geometry/clamping, persistence, hotkeys, web-embed error/token flow, real `main.js` boot, plugin discovery/spawn/control contract |
| Live E2E | `live/main.cjs`, `run-live.cmd` | Normal terminal, outside the sandbox | Real 280×64 / 520×720 windows, capturePage PNGs, DSH Web UI interaction, memory/CPU, restart restore |

## Commands

```bat
:: headless suite (sandbox-safe; no child spawn, hence --test-isolation=none)
:: 30 tests total: 20 core/window/boot + 10 plugin contract
node --test --test-isolation=none tests\e2e\unit\core.test.cjs ^
  tests\e2e\unit\hud-window.test.cjs tests\e2e\unit\main-boot.test.cjs ^
  tests\e2e\unit\plugin.test.mjs

:: t12 review probes (not product tests; both print JSON)
node tests\e2e\probe-contract.mjs
node tests\e2e\probe-asar-layout.cjs

:: t16 P2 review probes (not product tests)
node tests\e2e\probe-t16-p2.cjs
node tests\e2e\probe-t16-b1.cjs
node tests\e2e\probe-t16-diag.cjs
node tests\e2e\probe-t16-discovery-race.cjs
node tests\e2e\probe-t16-discovery-race.cjs --prefill

:: real GUI (normal terminal, recommended: stop DSH first for the offline case)
tests\e2e\run-live.cmd
```

`--test-isolation=none` is mandatory in the DSH agent sandbox: the default
runner spawns one child process per test file with piped stdio, and the
restricted token makes `spawn` fail with `EPERM` (errno -4048).

## Live harness inputs and outputs

Inputs (env): `DSH_HUD_E2E_DISCOVERY` — a live `discovery.json` written by the
Cordis plugin; default `%LOCALAPPDATA%\dsh-hud\discovery.json`.
`DSH_HUD_E2E_SEND_TEXT` overrides the chat message. `DSH_HUD_E2E_NO_WEB=1`
skips web-UI steps.

Outputs under `artifacts/e2e/live/`:

- `live-report.json` — per-step status, bounds, metrics, cold-start timings,
  console errors, budget verdict (`<150 MB`).
- `shots/e2e-01-capsule.png` … `e2e-11-restart-restored.png` — real
  `webContents.capturePage()` PNGs (shell window and embedded WebContentsView
  are captured separately; a WebContentsView is an overlay, so the shell PNG
  shows the empty `#web-host` hole by design).
- `profile/` — Electron userData used for the run (window-state.json etc.).

The hotkey itself is OS-level: the harness reports `hotkey.isRegistered()` and
the accelerator, but a human must press it once for the focus/policy check.
The plugin→HUD pull-up path is covered by `unit/plugin.test.mjs` + manual run;
the harness creates the window directly.
