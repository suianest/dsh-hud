# 未完成计划（Roadmap）

按「用户能感知的收益 / 成本」排序。完成一项就把这一节移到 `CHANGELOG.md` 对应版本，并从本文件删除。

## R-1 代码签名（P-13 长期方案）

- **状态**：未开始（2026-11-18 记录）。
- **为什么**：`DSH HUD.exe` 是未签名的 Electron 打包产物。国产安全软件（悟空 / 360 / 火绒）和 Windows SmartScreen 都会把它当成可疑程序，典型表现是「第一次由后台拉起时被拦，用户必须手动运行并放行」。0.5.5 已经把「计划任务自动拉起」这条特征去掉（改成插件直接 spawn），但**未签名本身**仍然会触发拦截和 SmartScreen 提示。
- **方案（按成本从低到高）**：
  1. **Azure Trusted Signing**（原 Azure Code Signing）：按签名次数计费，个人/小团队可申请，走微软的托管 HSM，CI 里用 `signtool` + `AzureSignTool` 均可。这是目前性价比最高的路线。
  2. **OV 代码签名证书**（DigiCert / Sectigo 等，约 $200–400/年）：需要企业资质或较严格的个人身份核验，能过 SmartScreen 的「未知发布者」，但信誉需要累积。
  3. **EV 代码签名证书**（约 $300–600/年 + 硬件 token）：SmartScreen 立即放行，但对个人开发者门槛最高。
- **落地要点**（无论选哪条）：
  1. 签名对象：`app/DSH HUD.exe`、`app/resources/*.dll`（Electron 带的），打包后、压缩前签名，`make-portable.js` 的 `--no-zip` 之后加一步 `signtool sign`；
  2. 校验：`Get-AuthenticodeSignature` 断言 `Status = Valid`，并把它加进 `scripts/check-hud.cmd` 的检查项（未签名时降级为 warning，不阻塞构建）；
  3. 密钥管理：证书/托管身份只在 CI 或本机的受保护环境里出现，仓库里只留脚本和文档，`.gitignore` 保证私钥/口令不入库；
  4. 发布说明：签名后，README / 安装 PDF 的「安全软件拦截」章节从「解释拦截」改成「已签名，仍被拦时怎么办」。
- **验收**：在**干净的第二台机器**上，双击安装器 / 插件自动拉起时不再出现 SmartScreen「未知发布者」，悟空在默认设置下不拦截；`Get-AuthenticodeSignature` 返回 `Valid`。
- **影响版本**：0.6.x（需要新证书 + 构建链路改造，单独发版）。

## R-2 GitHub 路线在第二台机器跑通（P-02 收尾）

- **状态**：部分完成。npm 路线已在第二台机器验证通过；GitHub 路线因为该机没装 git，报 `ERR_PNPM_GIT_RESOLVE_FAILED`，还没跑通。
- **待做**：在第二台机器装 PortableGit 并把 `PortableGit\cmd` 加进 PATH，重启 DSH 后填 `github:suianest/dsh-hud` 重试；成功后在 `操作日志/待解决问题.md` 里把 P-02 标成已验证。

## R-3 安装包瘦身

- **状态**：未开始。当前 zip **158.6 MB**，其中 Electron 运行时占大头（`app/` 下约 150 MB），`asar` 只有 0.5 MB。
- **方向**：把 `dist/win-unpacked` 里用不到的 locale / 开发者工具 / `LICENSES.chromium.html` 等裁掉（Electron 官方 `--asar` + 手工裁剪常见能省 20–30 MB）；或用 NSIS 增量安装替代整包 zip。
- **注意**：裁剪必须跑 `scripts/check-hud.cmd` + 真机冒烟，`electron` 升级时裁剪清单要跟着更新。
