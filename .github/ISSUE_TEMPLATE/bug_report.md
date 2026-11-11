---
name: Bug 报告
about: 胶囊 / 面板 / 内嵌页异常、崩溃或显示错位
title: "[bug] "
labels: bug
---

## 1. 版本与环境

- DSH HUD 版本（`app/package.json`，或右键 exe → 属性 → 详细信息）：
- 安装方式：便携 zip / 源码运行（`app\scripts\run-hud.cmd`）
- Windows 版本（`winver`）与显示缩放（如 150%）：
- 显示器数量 / 是否混合 DPI：
- DSH 桌面版版本（若与内嵌页有关）：

## 2. 现象

（一句话说清楚：哪个界面、出现什么、期望是什么。有截图请贴。）

## 3. 复现步骤

1.
2.
3.

能否稳定复现：每次 / 偶发（大约几次一次）

## 4. 日志

- 应用日志：`%APPDATA%\DSH HUD\hud.log`（打包版；开发版在 `DSH_HUD_USER_DATA` 指向的目录）
- 插件日志：`%TEMP%\dsh-hud-plugin-diag.log`

粘贴出错时间点前后 20–50 行。**贴之前删掉 `token=` 后面的内容。**

```text

```

## 5. 已尝试

（例如：重启 HUD、重装插件、换 `DSH_HUD_OPAQUE=1`、换缩放 100%。没有就写「无」。）
