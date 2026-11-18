#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Render the DSH HUD install/run guide as a 3-page A4 PDF using PIL only."""
import os
import re
from PIL import Image, ImageDraw, ImageFont

W, H = 1240, 1754  # A4 @ 150dpi
FONT = r"C:\Windows\Fonts\msyh.ttc"
FONT_BD = r"C:\Windows\Fonts\msyhbd.ttc"

INK = (27, 33, 64)
MUTED = (91, 100, 120)
ACCENT = (79, 124, 255)
ACCENT_SOFT = (232, 239, 255)
OK = (31, 157, 85)
OK_SOFT = (230, 247, 238)
WARN = (217, 119, 6)
WARN_SOFT = (255, 246, 229)
DANGER = (220, 38, 38)
DANGER_SOFT = (254, 236, 236)
PANEL = (243, 246, 251)
BORDER = (215, 222, 234)
WHITE = (255, 255, 255)

_fonts = {}


def font(size, bold=False):
    key = (size, bold)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(FONT_BD if bold else FONT, size)
    return _fonts[key]


def text(d, xy, s, size=24, color=INK, bold=False, anchor="la"):
    d.text(xy, s, font=font(size, bold), fill=color, anchor=anchor)


def wrap(d, s, size, maxw, bold=False):
    f = font(size, bold)
    tokens = re.findall(r"[A-Za-z0-9_\-\.%\\/:]+|.", s)
    lines, cur = [], ""
    for tok in tokens:
        if tok == "\n":
            lines.append(cur)
            cur = ""
            continue
        if d.textlength(cur + tok, font=f) <= maxw:
            cur += tok
            continue
        if cur:
            lines.append(cur)
        if d.textlength(tok, font=f) > maxw:
            piece = ""
            for ch in tok:
                if d.textlength(piece + ch, font=f) <= maxw:
                    piece += ch
                else:
                    lines.append(piece)
                    piece = ch
            cur = piece
        else:
            cur = tok
    if cur:
        lines.append(cur)
    return lines


def para(d, x, y, s, size=22, color=MUTED, maxw=800, bold=False, lh=None):
    lh = lh or int(size * 1.5)
    for i, line in enumerate(wrap(d, s, size, maxw, bold)):
        text(d, (x, y + i * lh), line, size, color, bold)
    return y + len(wrap(d, s, size, maxw, bold)) * lh


def rrect(d, box, r=18, fill=None, outline=None, width=2):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def arrow(d, x1, y1, x2, y2, color=ACCENT, width=4, head=14):
    d.line([(x1, y1), (x2, y2)], fill=color, width=width)
    if x1 == x2:
        sgn = 1 if y2 > y1 else -1
        d.polygon([(x2, y2), (x2 - head // 2, y2 - sgn * head), (x2 + head // 2, y2 - sgn * head)], fill=color)


def diamond(d, cx, cy, w, h, fill, outline):
    d.polygon([(cx, cy - h // 2), (cx + w // 2, cy), (cx, cy + h // 2), (cx - w // 2, cy)], fill=fill, outline=outline, width=3)


def node(d, y, title, lines, fill=PANEL, border=BORDER, color=INK, x1=150, x2=880):
    h = 54 + 30 * len(lines)
    rrect(d, (x1, y, x2, y + h), 16, fill, border, 2)
    text(d, (x1 + 26, y + 24), title, 24, color, True)
    yy = y + 58
    for ln in lines:
        text(d, (x1 + 26, yy), ln, 19, MUTED)
        yy += 28
    return y + h


def table(d, x, y, widths, rows, size=20, pad=14, lh=30):
    cx = x
    for i, w in enumerate(widths):
        rrect(d, (cx, y, cx + w, y + 46), 8, INK, INK)
        text(d, (cx + pad, y + 23), rows[0][i], size, WHITE, True, "lm")
        cx += w
    y += 46
    for ri, row in enumerate(rows[1:]):
        cx = x
        cells = [wrap(d, c, size, widths[i] - pad * 2) for i, c in enumerate(row)]
        row_h = max(len(c) for c in cells) * lh + pad * 2 - 8
        bg = WHITE if ri % 2 == 0 else PANEL
        for i, w in enumerate(widths):
            d.rectangle((cx, y, cx + w, y + row_h), fill=bg, outline=BORDER, width=1)
            for li, line in enumerate(cells[i]):
                text(d, (cx + pad, y + pad - 2 + li * lh), line, size, INK)
            cx += w
        y += row_h
    return y


def page(title, kicker, page_no):
    img = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, W, 10), fill=ACCENT)
    text(d, (90, 78), kicker, 20, ACCENT, True)
    text(d, (90, 108), title, 46, INK, True)
    text(d, (W - 90, 120), f"{page_no} / 3", 18, MUTED, False, "ra")
    d.line([(90, 186), (W - 90, 186)], fill=BORDER, width=2)
    return img, d


here = os.path.dirname(os.path.abspath(__file__))
imgdir = os.path.join(here, "img")

# ---------------------------------------------------------------- page 1
img = Image.new("RGB", (W, H), WHITE)
d = ImageDraw.Draw(img)
d.rectangle((0, 0, W, 14), fill=ACCENT)
text(d, (90, 96), "DSH HUD", 26, ACCENT, True)
text(d, (90, 148), "安装与运行流程", 62, INK, True)
text(d, (90, 236), "Windows 常驻悬浮胶囊 · 把 DSH 变成桌面上的一个搜索框", 26, MUTED)
text(d, (90, 286), "版本 0.5.4 · 2026-11-18 · Windows 10 1809+ / Windows 11 x64", 20, MUTED)

cover = Image.open(os.path.join(imgdir, "install-cover-ai-a.jpg")).convert("RGB")
cw, ch = W - 180, int((W - 180) * cover.height / cover.width)
cover = cover.resize((cw, ch), Image.LANCZOS)
mask = Image.new("L", (cw, ch), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, cw, ch), radius=28, fill=255)
img.paste(cover, (90, 340), mask)
text(d, (90, 340 + ch + 22), "真实图标与截图，AI 精修后的封面示意：点胶囊 → 展开对话面板", 18, MUTED)

text(d, (90, 1140), "三步就能用起来", 34, INK, True)
steps = [
    ("1", "下载安装器", "Release 附件里下 install-dsh-hud.cmd"),
    ("2", "双击运行", "自动下载 151 MB 并解压到位"),
    ("3", "启动", "窗口告诉你装在哪，问你是否启动"),
]
x = 90
for num, head, body in steps:
    rrect(d, (x, 1200, x + 340, 1360), 22, PANEL, BORDER)
    d.ellipse((x + 26, 1226, x + 78, 1278), fill=ACCENT)
    text(d, (x + 52, 1252), num, 26, WHITE, True, "mm")
    text(d, (x + 100, 1230), head, 26, INK, True)
    para(d, x + 100, 1280, body, 16, MUTED, 232, lh=24)
    x += 370

text(d, (90, 1386), "安装器会自动建目录、下载、解压——你不需要知道 %LOCALAPPDATA% 是什么。", 18, MUTED)
text(d, (90, 1418), "装完窗口里会直接写出程序位置，并问「现在启动吗」，按 Y 即可。", 18, MUTED)
text(d, (90, 1450), "想装到别的盘：命令行加 -InstallDir \"D:\\Apps\\DSH HUD\" 即可。", 18, MUTED)

rrect(d, (90, 1508, W - 90, 1668), 20, ACCENT_SOFT, ACCENT_SOFT)
text(d, (120, 1536), "下载地址", 20, ACCENT, True)
text(d, (120, 1570), "https://github.com/suianest/dsh-hud/releases/latest", 24, INK, True)
text(d, (120, 1614), "只需要下载 install-dsh-hud.cmd 这一个文件（几百字节），其余由脚本自动完成", 19, MUTED)
text(d, (90, 1700), "进阶：也可以手动解压 zip，再双击目录里的 DSH HUD.lnk（不要双击 exe）。", 18, MUTED)

# ---------------------------------------------------------------- page 2
img2, d = page("从下载到用上：完整流程", "流程图", 2)
Y, GAP, AX = 250, 26, 515
y = Y

h1 = node(d, y, "① 打开 Release 页面", ["github.com/suianest/dsh-hud/releases/latest"])
arrow(d, AX, h1, AX, h1 + GAP)
y = h1 + GAP

h2 = node(d, y, "② 下载 install-dsh-hud.cmd", [
    "只有 1 个文件、几百字节，几秒下完",
    "（同目录的 install-dsh-hud.ps1 是脚本本体，可选）",
])
arrow(d, AX, h2, AX, h2 + GAP)
y = h2 + GAP

h3 = node(d, y, "③ 双击运行这个 cmd", [
    "弹出黑窗口，自动做三件事：建目录 → 下载约 151 MB → 解压",
    "全程不需要管理员权限，进度写在窗口里",
], ACCENT_SOFT, ACCENT)
arrow(d, AX, h3, AX, h3 + GAP)
y = h3 + GAP

h4 = node(d, y, "④ 看到「安装完成」", [
    "窗口写清装在了哪（形如 C:\\Users\\你\\AppData\\Local\\DSH HUD）",
    "最后一行问：现在启动吗？ 输入 Y 回车",
], OK_SOFT, OK)

rrect(d, (905, y - 6, 1150, y + 140), 14, DANGER_SOFT, DANGER)
text(d, (925, y + 10), "如果出错", 19, DANGER, True)
for i, ln in enumerate(["看窗口里的红字", "检查网络 / 代理", "离线：先下 zip 再加", "-ZipPath 参数"]):
    text(d, (925, y + 42 + i * 26), ln, 15, INK)

arrow(d, AX, h4, AX, h4 + GAP)
y = h4 + GAP

dy = y + 80
diamond(d, AX, dy, 360, 150, WARN_SOFT, WARN)
text(d, (AX, dy - 12), "第一次启动被 SmartScreen 拦？", 21, INK, True, "mm")
text(d, (AX, dy + 22), "「Windows 已保护你的电脑」", 16, MUTED, False, "mm")
d.line([(695, dy), (905, dy)], fill=ACCENT, width=4)
d.polygon([(905, dy), (891, dy - 7), (891, dy + 7)], fill=ACCENT)
text(d, (712, dy - 30), "是", 18, ACCENT, True)
rrect(d, (905, dy - 46, 1150, dy + 46), 14, WARN_SOFT, WARN)
text(d, (925, dy - 26), "更多信息", 19, INK, True)
text(d, (925, dy + 2), "→ 仍要运行", 19, INK)

n6y = dy + 75 + GAP
arrow(d, AX, dy + 75, AX, n6y)
h6 = node(d, n6y, "⑤ 胶囊出现在桌面", [
    "一颗深色小圆标（悬停会亮起鲸鱼轮廓）",
    "点它展开 520×720 的对话面板",
], OK_SOFT, OK)
text(d, (852, n6y + 30), "成功", 18, OK, True, "ra")

oy = h6 + GAP
arrow(d, AX, h6, AX, oy)
rrect(d, (150, oy, 880, oy + 62), 16, PANEL, BORDER, 2)
text(d, (176, oy + 20), "（可选）接入 DSH：让下方面板随 DSH 启动、并在 DSH 里开关胶囊", 20, INK, True)

ny = oy + 82
rrect(d, (150, ny, 880, ny + 200), 16, PANEL, BORDER, 2)
text(d, (176, ny + 20), "⑥ 在 DSH 里安装插件", 24, INK, True)
for i, ln in enumerate([
    "DSH → 设置 → 插件 → 添加插件",
    "输入仓库地址：suianest/dsh-hud",
    "安装后重启 DSH：胶囊会自动起来（计划任务）",
]):
    text(d, (176, ny + 62 + i * 40), f"{i+1}.  {ln}", 19, MUTED)

arrow(d, AX, ny + 200, AX, ny + 232)
rrect(d, (330, ny + 232, 700, ny + 288), 28, OK, OK)
text(d, (AX, ny + 260), "完成：胶囊 + DSH 已打通", 22, WHITE, True, "mm")

# ---------------------------------------------------------------- page 3
img3, d = page("目录说明与常见问题", "参考", 3)

text(d, (90, 216), "解压后目录里有什么", 30, INK, True)
y = table(d, 90, 266, [300, 760], [
    ["文件 / 目录", "作用"],
    ["DSH HUD.lnk", "日常入口，双击启动（已经带好参数）"],
    ["启动 DSH HUD.cmd", "同上，黑框版入口，排障时用（能看到输出）"],
    ["app\\", "应用本体：DSH HUD.exe、Electron 运行时、app.asar"],
    ["udd\\", "本机运行数据（窗口位置、主题缓存、更新暂存），可随时删"],
    ["README.txt", "离线版说明，内容和本文一致"],
])

text(d, (90, y + 46), "常见问题", 30, INK, True)
y = table(d, 90, y + 96, [320, 740], [
    ["现象", "原因与处理"],
    ["双击 cmd 一闪而过", "多半是网络问题：看窗口红字，或手动下 zip 用 -ZipPath"],
    ["SmartScreen 拦截", "exe 未签名：更多信息 → 仍要运行；公司电脑可能被组策略直接拦"],
    ["插件装好了找不到 HUD", "安装器默认装在 %LOCALAPPDATA%\\DSH HUD，插件会自动找到；改过路径就设 hudDir"],
    ["DSH 启动后胶囊没自动起", "计划任务 dsh-hud-launch 被禁：手动双击 lnk，或看插件日志 launch task ready"],
    ["检查更新报网络错误", "会依次尝试 raw / jsDelivr / Release 资产 / GitHub API，全失败才报错"],
    ["第一次没出现胶囊", "悟空 / 360 / 火绒 可能拦未签名 exe：双击 DSH HUD.lnk 一次并点允许，或把安装目录加白名单"],
])

text(d, (90, y + 46), "手动安装（离线 / 进阶）", 30, INK, True)
rrect(d, (90, y + 96, W - 90, y + 268), 16, (247, 249, 253), BORDER)
text(d, (116, y + 116), "1. 在 Release 里下载 DSH-HUD-0.5.4-win-x64.zip（约 151 MB）", 20, INK)
text(d, (116, y + 152), "2. 解压到任意有写权限的目录（推荐 %LOCALAPPDATA%\\DSH HUD）", 20, INK)
text(d, (116, y + 188), "3. 双击目录里的 DSH HUD.lnk —— 不要双击 app\\DSH HUD.exe", 20, INK)
text(d, (116, y + 230), "校验：certutil -hashfile \"DSH-HUD-0.5.4-win-x64.zip\" SHA256", 18, MUTED)

text(d, (90, 1680), "仓库：github.com/suianest/dsh-hud    ·    问题反馈：Issues    ·    许可证：MIT", 19, MUTED)

out = os.path.join(here, "dsh-hud-install-flow.pdf")
img.save(out, save_all=True, append_images=[img2, img3], resolution=150.0)
for idx, pg in enumerate((img, img2, img3), 1):
    pg.save(os.path.join(imgdir, f"preview-p{idx}.png"))
print("saved", out, os.path.getsize(out), "bytes")
