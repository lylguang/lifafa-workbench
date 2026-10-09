# 打开李发发工作台（由同目录的「打开工作台.cmd」调用）。
#
# 工作台每次重启都会生成一次性的访问令牌——只存在进程内存、每次都变。裸地址
# http://127.0.0.1:4173/ 在新浏览器或新配置下会报 "dsh web authentication
# required"。「启动工作台.cmd」启动时会把带令牌的地址写到 workbench-url.txt，
# 这里读出来直接打开；文件还没生成时最多等 40 秒，再退回裸地址。
#
# 暂存目录必须和 dsh-launcher.mjs 的选盘规则一致，否则启动脚本把地址写到A 盘、
# 这里却去 B 盘找，表现为「等了 40 秒还是没打开」。两边都是：非系统盘中可用
# 空间最大且不低于 20G 者 > 系统盘的 LOCALAPPDATA；LWB_SCRATCH_ROOT 可覆盖。
#
# 本文件存 UTF-8 with BOM：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会把中文
# 当 GBK 解析，注释与提示全变乱码（2026-10-08 踩过）。
$ErrorActionPreference = "Continue"

function Get-ScratchRoot {
    if ($env:LWB_SCRATCH_ROOT) {
        return ($env:LWB_SCRATCH_ROOT -replace '[\\/]+$', '')
    }
    $systemDrive = $env:SystemDrive
    if (-not $systemDrive) { $systemDrive = $env:SystemDrive = 'C:' }
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

$file = Join-Path (Get-ScratchRoot) 'workbench-url.txt'
$url = $null
for ($i = 0; $i -lt 40 -and -not $url; $i++) {
    if (Test-Path -LiteralPath $file) { $url = (Get-Content -LiteralPath $file -TotalCount 1) }
    if (-not $url) { Start-Sleep -Milliseconds 1000 }
}
if ($url) {
    # 去掉可能残留的 BOM 与首尾空白——粘在 URL 前面会让打开直接失败。
    $url = $url.Trim([char]0xFEFF, [char]0x20)
    if ($url -match '^https?://') {
        Write-Host ('[INFO] 打开 ' + $url)
        Start-Process $url
        exit 0
    }
}
Write-Host "[INFO] 没有找到带令牌的地址，改用 http://127.0.0.1:4173/'
Write-Host '若提示需要认证，请用「启动工作台.cmd」启动。'
Start-Process "http://127.0.0.1:4173/"
