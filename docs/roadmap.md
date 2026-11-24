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

- **状态**：部分完成。v0.5.7 已裁掉 52 个语言包（只留 `en-US` / `zh-CN` / `zh-TW`），zip 从 158.6 MB 降到 **148.9 MB**；剩下的体积几乎全是 Electron 运行时（`app/DSH HUD.exe` 246 MB 解压后），`asar` 只有 0.5 MB。
- **方向**：把 `dist/win-unpacked` 里用不到的 locale / 开发者工具 / `LICENSES.chromium.html` 等裁掉（Electron 官方 `--asar` + 手工裁剪常见能省 20–30 MB）；或用 NSIS 增量安装替代整包 zip。
- **注意**：裁剪必须跑 `scripts/check-hud.cmd` + 真机冒烟，`electron` 升级时裁剪清单要跟着更新。

## R-4 插件「补丁式自更新」（0.5.11 之后的中版候选）

- **状态**：未开始（0.5.11 已做到「检测 + 橙点 + 复制升级命令」，本条是下一步）。
- **背景**：插件是 npm 包 `dsh-hud-capsule`（**34,948 B**），更新成本根本不在体积，而在 **DSH 必须重启**才会重新加载插件；
  现在的体验是「面板亮橙点 → 复制 `pnpm add dsh-hud-capsule@x.y.z` → 手动执行 → 重启 DSH」。
- **目标**：面板里一键完成插件升级，把重载变成可预期的「重启条目 / 热重载」，不要求用户开终端。
- **可行路径**（Cordis 已提供）：`loader.update(id, options)` 可以重启插件条目；HMR 成功重载后能通过
  `loader.resolve(id).moduleNamespace` 拿到新的模块命名空间。因此「下载 tgz → 覆盖 profile 插件目录 → 重启条目」在技术上成立。
- **必须先解决的问题**：
  1. `link:` 开发形态：仓库目录被直接加载，覆盖会污染工作区 —— 只对 `node_modules` / profile 内复制形态生效，`link:` 要明确拒绝；
  2. pnpm store 完整性：绕过 pnpm 直接写 `node_modules` 会让 lockfile 与内容不一致，下次 `pnpm install` 会还原；
  3. 半更新态：下载中断 / 覆盖失败 / 重启条目失败都必须可回滚（保留 `.bak` 的插件目录 + 失败自动回退）；
  4. 供应链与杀软：自动下载并执行第三方代码是最容易被企业策略拦的行为，需要 sha512 校验 + 仅信任 npm registry 的 tarball；
  5. 版本契约：插件与应用的 `protocolVersion` 必须对齐，补丁升级后应用不认识新协议时要降级而不是崩溃。
- **建议实现顺序**：先做「一键复制命令 + 打开终端提示」（已完成）→ 再做「下载 + 校验 + 只替换 `node_modules/dsh-hud-capsule`」→
  最后才上 `loader.update` 热重载；每一步都要能在中途失败后恢复旧版本。
- **验收**：在干净机器上从 0.5.10 升到 0.5.11，面板点一次，30 s 内生效，日志里有 `plugin replaced` 和 `entry restarted`，
  失败时回滚并给出可读错误；`pnpm install` 之后仍能复现同一版本。
- **影响版本**：中版之后（0.6.x），需要与 R-1 签名一起评估（自动下载的代码被签名或至少校验 sha512）。
