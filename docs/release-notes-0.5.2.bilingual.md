# DSH HUD v0.5.2

> 2026-11-17 · 下载链路修复

## 中文

### 为什么发这一版

2026-11-17 把三条安装路线（便携版 zip / `github:` / npm）实际跑了一遍，**安装本身都能复现，但下载这一步在受限网络下很脆**：

| 通道 | 实测 |
| --- | --- |
| `github.com` 直连 | 151 MB 包 1020 s 只下到 15 MB（≈14.8 KB/s）后 `Connection was reset` |
| `ghfast.top` 镜像 | 不可达（HEAD 000） |
| `ghproxy.net` / `gh-proxy.com` | 可用，≈110 KB/s（range 206） |
| `raw.githubusercontent.com` / `cdn.jsdelivr.net` | TCP 层直接失败 |
| `releases/latest/download/manifest.json` | **404**（Release 里没有这个附件） |

这一版把这几处补齐。

### 变更

- **安装器**：镜像从单一 `ghfast.top` 改为 `ghproxy.net → gh-proxy.com → ghfast.top → 直连` 依次尝试；优先用 `curl.exe -C -` 断点续传（Windows 10 1809+ 自带），超时 600 s → 1800 s
- **插件自动安装**：`downloadTo()` 按同样 4 个源轮换，单源超时 180 s → 600 s，失败清理半包再换源
- **应用内更新**：清单源顺序改为 **raw → Release 附件 → jsDelivr → REST API**；并且 **`manifest.json` 现在作为 Release 附件一起发布**，`releases/latest/download/manifest.json` 这条兜底不再 404
- **构建**：`make-portable.js` 检测到 `udd/` 被运行中的 HUD 重建时直接报错，避免把 Chromium 缓存（约 13 MB、含本机数据）打进 zip

### 校验

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `DSH-HUD-0.5.2-win-x64.zip` | 158,638,594 B | `af6b5530232f3eaf151d1660dccffb578eed3070d4671a36faa1990361acb960` |
| `app.asar` | 509,308 B | `b791cb7867c1e5fca3d32947570a990624977d91866c8331a66c4892a8a335ca` |

zip 共 80 条目：`DSH HUD.lnk`、`启动 DSH HUD.cmd`、`README.txt`、`manifest.json`、`app/`，**不含 `udd/`**。

### 安装

1. 下载 zip，解压到有写权限的目录（推荐 `%LOCALAPPDATA%\DSH HUD`）
2. 双击 `DSH HUD.lnk`（或 `启动 DSH HUD.cmd`）——不要双击 `app\DSH HUD.exe`
3. 已装旧版：直接覆盖解压，`udd\` 可删（会丢窗口位置/主题缓存）

## English

### Why this release

On 2026-11-17 all three install routes were exercised for real. Installing reproduces fine, but **downloading is fragile on a restricted network**:

| Channel | Measured |
| --- | --- |
| `github.com` direct | 15 MB of 151 MB in 1020 s (~14.8 KB/s), then `Connection was reset` |
| `ghfast.top` mirror | unreachable (HEAD 000) |
| `ghproxy.net` / `gh-proxy.com` | working, ~110 KB/s (range 206) |
| `raw.githubusercontent.com` / `cdn.jsdelivr.net` | TCP-level failure |
| `releases/latest/download/manifest.json` | **404** — the asset was never uploaded |

This release closes those gaps.

### Changes

- **Installer**: mirror list `ghproxy.net → gh-proxy.com → ghfast.top → direct`, resumable downloads via `curl.exe -C -`, timeout 600 s → 1800 s
- **Plugin auto-install**: `downloadTo()` walks the same four sources, per-source timeout 180 s → 600 s, partial file removed between attempts
- **In-app update**: manifest order is now **raw → release asset → jsDelivr → REST API**, and `manifest.json` ships as a release asset so `releases/latest/download/manifest.json` works
- **Build**: `make-portable.js` refuses to zip when `udd/` reappears (a running HUD recreates the ~13 MB Chromium cache)

### Checksums

| File | Size | SHA-256 |
| --- | --- | --- |
| `DSH-HUD-0.5.2-win-x64.zip` | 158,638,594 B | `af6b5530232f3eaf151d1660dccffb578eed3070d4671a36faa1990361acb960` |
| `app.asar` | 509,308 B | `b791cb7867c1e5fca3d32947570a990624977d91866c8331a66c4892a8a335ca` |

The zip has 80 entries (`DSH HUD.lnk`, `启动 DSH HUD.cmd`, `README.txt`, `manifest.json`, `app/`) and no `udd/`.

### Install

1. Download the zip and extract it somewhere writable (e.g. `%LOCALAPPDATA%\DSH HUD`)
2. Run `DSH HUD.lnk` (or `启动 DSH HUD.cmd`) — do **not** double-click `app\DSH HUD.exe`
3. Upgrading: extract over the old folder; `udd\` may be deleted (loses window position / theme cache)
