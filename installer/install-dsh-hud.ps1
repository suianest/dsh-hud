# DSH HUD 一键安装脚本（PowerShell 5.1+，无需管理员权限）
#
# 用法：
#   双击同目录的「安装 DSH HUD.cmd」即可（会用本脚本）
#   或手动：powershell -NoProfile -ExecutionPolicy Bypass -File install-dsh-hud.ps1
#
# 可选参数：
#   -InstallDir "D:\Apps\DSH HUD"            自定义安装位置
#   -ZipPath ".\DSH-HUD-0.4.1-win-x64.zip"   用本地 zip，跳过下载
#   -NoLaunch                                安装完不自动启动
#   -CheckOnly                               只查最新版本
#   -Force                                   已安装时直接覆盖

[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'DSH HUD'),
    [string]$ZipPath = '',
    [switch]$NoLaunch,
    [switch]$CheckOnly,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Repo = 'suianest/dsh-hud'
$UserAgent = 'dsh-hud-installer'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Ok($msg)   { Write-Host "  [OK]   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!]    $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [X]    $msg" -ForegroundColor Red }

function Save-WithFallback($Url, $OutFile, $Label) {
    $mirrors = @($Url)
    if ($Url -match '^https://github\.com/(.+)$') { $mirrors += "https://ghfast.top/$Url" }
    $i = 0
    foreach ($u in $mirrors) {
        $i++
        try {
            Say "  正在下载 $Label（源 $i/$($mirrors.Count)）..." DarkGray
            Invoke-WebRequest -Uri $u -OutFile $OutFile -UseBasicParsing -UserAgent $UserAgent -TimeoutSec 600
            return
        } catch {
            if ($i -eq $mirrors.Count) { throw }
            Warn "该源失败，换备用源重试：$($_.Exception.Message)"
        }
    }
}

Say ''
Say '  DSH HUD 一键安装' Cyan
Say '  ----------------------------------------' DarkGray
Say "  安装位置：$InstallDir" Gray

$release = $null
$asset = $null

if (-not $ZipPath) {
    Say '  正在查询最新版本...' DarkGray
    $uri = "https://api.github.com/repos/$Repo/releases/latest"
    $hdr = @{ 'User-Agent' = $UserAgent; 'Accept' = 'application/vnd.github+json' }
    try {
        $release = Invoke-RestMethod -Uri $uri -Headers $hdr -TimeoutSec 40
    } catch {
        Fail ("查询 GitHub 失败：" + $_.Exception.Message)
        Say '  可以手动下载 zip 后运行： install-dsh-hud.ps1 -ZipPath "zip 的路径"' DarkGray
        exit 1
    }
    $asset = $release.assets | Where-Object { $_.name -like 'DSH-HUD-*-win-x64.zip' } | Select-Object -First 1
    if (-not $asset) {
        Fail "这个 Release（$($release.tag_name)）里没有 DSH-HUD-*-win-x64.zip。"
        exit 1
    }
    Say "  最新版本：$($release.tag_name)  （$([math]::Round($asset.size / 1MB, 1)) MB）" Green
    if ($CheckOnly) {
        Say "  下载地址：$($asset.browser_download_url)" Gray
        Say "  发布说明：$($release.html_url)" Gray
        exit 0
    }
} else {
    if (-not (Test-Path -LiteralPath $ZipPath)) { Fail "找不到 zip：$ZipPath"; exit 1 }
    Say "  使用本地 zip：$ZipPath" Green
}

$exe = Join-Path $InstallDir 'app\DSH HUD.exe'
$lnk = Join-Path $InstallDir 'DSH HUD.lnk'

if ((Test-Path -LiteralPath $exe) -and -not $Force) {
    Warn '这个位置已经装过 DSH HUD：'
    Say "         $InstallDir" DarkGray
    Say '  继续会更新程序文件，但保留 udd（窗口位置、缓存）。' DarkGray
    $ans = Read-Host '  继续吗？(y/N)'
    if ($ans -notmatch '^(y|Y|yes|YES)$') { Say '  已取消。' Yellow; exit 0 }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("dsh-hud-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.zip')

try {
    if ($ZipPath) {
        Copy-Item -LiteralPath $ZipPath -Destination $tmp -Force
    } else {
        Save-WithFallback $asset.browser_download_url $tmp '安装包'
    }

    if ($asset) {
        $got = (Get-Item -LiteralPath $tmp).Length
        if ($asset.size -and $got -ne $asset.size) {
            throw "下载不完整：期望 $($asset.size) 字节，实际 $got 字节"
        }
        if ($asset.digest -and $asset.digest -match '^sha256:(.+)$') {
            $h = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLower()
            if ($h -ne $Matches[1].ToLower()) { throw '校验失败：下载文件可能被篡改或损坏' }
            Ok '下载完成，SHA-256 校验通过'
        } else {
            Ok '下载完成'
        }
    } else {
        Ok '本地包已就绪'
    }

    # A running HUD locks DSH HUD.exe / *.dll, and Expand-Archive -Force then
    # dies halfway, leaving a mixed old/new install (t41 M1).
    $running = @(Get-Process -Name 'DSH HUD' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        Say "  检测到 $($running.Count) 个 DSH HUD 进程正在运行（占用安装目录里的文件）" Yellow
        $answer = Read-Host '  需要先结束它们才能覆盖安装，继续吗？(Y/n)'
        if ($answer -and $answer.Trim() -notmatch '^(y|yes|是)$') {
            Say '  已取消：请先退出 DSH HUD（右键胶囊 → 退出），再重新运行安装器' Red
            exit 1
        }
        $running | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
        Ok '已结束运行中的 DSH HUD'
    }

    Say '  正在解压...' DarkGray
    if (-not (Test-Path -LiteralPath $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        Ok "已创建目录 $InstallDir"
    }
    Expand-Archive -LiteralPath $tmp -DestinationPath $InstallDir -Force

    if (-not (Test-Path -LiteralPath $exe)) { throw '解压后没找到 app\DSH HUD.exe，安装包可能不完整' }
    Ok '解压完成'
} catch {
    Fail $_.Exception.Message
    Say '  如果反复失败：浏览器里手动下载 zip，再执行' DarkGray
    Say '    powershell -ExecutionPolicy Bypass -File install-dsh-hud.ps1 -ZipPath "下载的zip"' DarkGray
    exit 1
} finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

Say ''
Say '  ----------------------------------------' DarkGray
Say '  安装完成！' Green
Say ''
Say "  程序位置：$InstallDir" Gray
Say "  启动方式：双击 $lnk" Gray
Say '            （开始菜单里搜索 DSH HUD 也能找到）' DarkGray
Say '  卸载方式：右键胶囊 → 退出，然后删掉上面这个文件夹即可' DarkGray
Say ''

if (-not $NoLaunch -and (Test-Path -LiteralPath $lnk)) {
    $ans = Read-Host '  现在启动 DSH HUD 吗？(Y/n)'
    if ($ans -notmatch '^(n|N|no|NO)$') {
        Start-Process -FilePath $lnk
        Say '  已启动。看看桌面右下角有没有一颗深色小圆标。' Green
    }
}
Say ''
