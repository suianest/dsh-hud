# DSH HUD v0.3.0

A small floating window for DeepSeek Harness on Windows. A whale capsule sits on your desktop. Click it and you get a 520×720 chat panel. The panel is the real DSH web UI — same server, same plugins, same themes.

## What you get

- **The capsule is the door** — a 64×64 whale icon stays on your desktop. Hover it and a blue light runs around the whale outline. Click to open the panel, click again to close it.
- **Real DSH web UI inside** — not a copy of the interface. It is the same web UI. Themes and plugins you installed in DSH work here too.
- **Follows the theme** — when the page goes dark or light, the window colors follow.
- **Command palette** — press `Ctrl+K` (or the ⌘ button in the title bar). The list comes from the right-click menu plus the extension points, so you can add your own entries.
- **Drag the edges to resize** — grab the left, right, top or bottom edge. The smallest size is 520×420.
- **Right-click menu** — open the DSH desktop window / open the floating panel / top up token / quit / start at login.
- **Plugin form** — the Cordis plugin finds the HUD by itself, writes a discovery file, and gives you `/dsh-hud show|hide|toggle|reload`. It also has an IPC bridge, so the DSH host process can bring the DSH desktop window to the front.

## Install

### Step 1: get the app

Download `DSH-HUD-0.3.0-win-x64.zip` from this release (about 151 MB). Unzip it anywhere, for example `D:\Apps\DSH HUD\`.

> **Do not double-click `DSH HUD.exe`.** The portable build needs `--no-sandbox` and its own user-data folder to start. On some machines a plain double-click quits right away with no window and no error (Chromium exits before any app code runs; the event log shows `0x80000003`).
> Use **`DSH HUD.lnk`** in the unzipped folder instead (or `启动 DSH HUD.cmd` — the file name is Chinese, it just starts the app).

### Step 2: start it

Double-click `DSH HUD.lnk`. The whale capsule shows up at the bottom right of your screen.
Right-click the capsule and tick **start at login** if you want it every time.

### Step 3: install the DSH plugin (optional, but recommended)

The plugin connects the HUD to DSH: it writes `discovery.json` (the web UI URL with a token), adds the `/dsh-hud` command, and brings the DSH desktop window to the front.

In DSH, open **Add plugin** and enter one of these:

```text
github:suianest/dsh-hud
```

Or point it at the local repo folder (`plugin/`, or the repo root).

After that, `/dsh-hud toggle` opens and closes the panel. When DSH restarts, the plugin refreshes discovery and the HUD reconnects by itself.

## Check the download

```powershell
certutil -hashfile DSH-HUD-0.3.0-win-x64.zip SHA256
```

It should print:

```text
9b6506fee02cc496bc31dc06250e2e8f29092d47af55e66d18a5854b6a61e059
```

## Known limits

- **Windows 10/11 x64 only.** The WebView2 runtime is needed. Windows 11 has it. Windows 10 usually got it from Edge.
- The build is not code-signed. Windows SmartScreen may warn you the first time — pick "More info → Run anyway".
- Two monitors and mixed DPI scaling are not tested yet. Known limit, issue reports welcome.
- This is a portable zip, not a full installer. If you want an NSIS installer, open an issue.

## Feedback

- Bug: <https://github.com/suianest/dsh-hud/issues/new?template=bug_report.md>
- Feature idea: <https://github.com/suianest/dsh-hud/issues/new?template=feature_request.md>

---

**Full change list**: see [CHANGELOG.md](https://github.com/suianest/dsh-hud/blob/main/CHANGELOG.md)
