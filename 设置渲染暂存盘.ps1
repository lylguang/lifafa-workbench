# 选定渲染暂存盘并设置相关环境变量（由同目录的「启动工作台.cmd」调用）。
#
# 为什么单独成文件：cmd 里内嵌 PowerShell 必翻车（引号与变量展开会把命令行拆坏，
# 2026-10-08 实测）。逻辑放这里，cmd 只负责调用。
#
# 选盘规则必须与 lwb/dsh-launcher.mjs 的 resolveScratchRoot 一致，否则启动脚本把
# 带令牌的地址写到 A 盘、「打开工作台.ps1」却去 B 盘找，表现为「等了 40 秒还是
# 没打开」。规则：非系统盘中可用空间最大且不低于 20G 者 > 系统盘的 LOCALAPPDATA；
# LWB_SCRATCH_ROOT 可显式指定（客户机可用它钉在某块数据盘上）。
#
# 结果写到一个纯 ASCII 的中转文件里给 cmd 读：scratch 根可能含中文，而 cmd 按
# GBK 读命令行，路径直接在命令行里传递会被拆坏（2026-10-08 踩过）。
#
# 本文件存 UTF-8 with BOM：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会把中文
# 当 GBK 解析，注释与提示全变乱码。
$ErrorActionPreference = "Continue"

# 随包运行时优先：客户机可能既没 Node 也没 FFmpeg（2026-10-09 实测新机器双击
# 任何脚本都报 "'node' 不是内部或外部命令"）。这里放在最前面，是因为启动脚本
# 后续 spawn 的所有子进程都从 PATH 找工具——渲染、混音、转码全都依赖 ffmpeg。
$bundled = Join-Path $PSScriptRoot '运行环境'
if (Test-Path -LiteralPath (Join-Path $bundled 'node')) {
    $env:PATH = (Join-Path $bundled 'node') + ';' + $env:PATH
}
if (Test-Path -LiteralPath (Join-Path $bundled 'ffmpeg')) {
    $env:PATH = (Join-Path $bundled 'ffmpeg') + ';' + $env:PATH
}

function Get-ScratchRoot {
    if ($env:LWB_SCRATCH_ROOT) {
        return ($env:LWB_SCRATCH_ROOT -replace '[\\/]+$', '')
    }
    $systemDrive = $env:SystemDrive
    if (-not $systemDrive) { $systemDrive = 'C:' }
    $systemRoot = $systemDrive.TrimEnd('\') + '\'
    $minFreeGb = 20
    $best = $null
    $bestFree = -1
    foreach ($letter in 'D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z') {
        $root = "${letter}:\"
        if ($root -eq $systemRoot) { continue }
        if (-not (Test-Path -LiteralPath $root)) { continue }
        try {
            $drive = Get-PSDrive -Name $letter -ErrorAction Stop
            $freeGb = [math]::Floor($drive.Free / 1GB)
        } catch { continue }
        if ($freeGb -lt $minFreeGb) { continue }
        if ($freeGb -gt $bestFree) { $bestFree = $freeGb; $best = $root }
    }
    if ($best) { return ($best + 'lifa-scratch') }
    $fallback = $env:LOCALAPPDATA
    if (-not $fallback -and $env:USERPROFILE) { $fallback = Join-Path $env:USERPROFILE 'AppData\Local' }
    if ($fallback) { return (Join-Path $fallback 'lifa-scratch') }
    return (Join-Path $PSScriptRoot 'lifa-scratch')
}

$root = Get-ScratchRoot
foreach ($sub in @('temp', 'hf-home', 'torch-home', 'npm-cache')) {
    $dir = Join-Path $root $sub
    if (-not (Test-Path -LiteralPath $dir)) {
        try { New-Item -ItemType Directory -Path $dir -Force | Out-Null } catch { }
    }
}
$temp = Join-Path $root 'temp'
$env:LWB_TEMP_DIR = $temp
$env:TEMP = $temp
$env:TMP = $temp
$env:HF_HOME = Join-Path $root 'hf-home'
$env:TORCH_HOME = Join-Path $root 'torch-home'
$env:npm_config_cache = Join-Path $root 'npm-cache'
# huggingface.co 在国内多数网络下超时（2026-10-08 实测连接不通），模型下载必须
# 走镜像。ComfyUI 子进程只认 HF_ENDPOINT，所以这个变量要一路传下去。
if (-not $env:LWB_BRIDGE_HF_ENDPOINT) { $env:LWB_BRIDGE_HF_ENDPOINT = 'https://hf-mirror.com' }
if (-not $env:HF_ENDPOINT) { $env:HF_ENDPOINT = $env:LWB_BRIDGE_HF_ENDPOINT }

# 中转文件供 cmd 读取。用 UTF8Encoding($false) 写无 BOM：BOM 会被 cmd 当成一个
# 粘在路径前面的字符，拼出的路径直接找不到目录（2026-10-08 打开工作台.cmd 踩过）。
#
# 放在脚本同目录而不是 TEMP：PowerShell 的 $env:TEMP 与 cmd 的 %TEMP% 在同一台
# 机器上可能不是同一个字符串（短路径 8.3 与长路径），2026-10-09 实测因此读不到。
$relay = Join-Path $PSScriptRoot '.lwb-scratch-root.txt'
[System.IO.File]::WriteAllText($relay, $root, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('[INFO] 渲染暂存目录: ' + $root)
