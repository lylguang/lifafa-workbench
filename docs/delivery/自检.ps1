# 李发发工作台 · 环境自检
#
# 输出的是「配置建议书」而不是「体检表」：客户要看到的是"你这台电脑建议这样配，
# 因为…要下载 4.4G 模型"，而不是"显存不足"——后者会被理解成软件坏了。
#
# 本文件存 UTF-8 with BOM：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会把中文
# 当 GBK 解析，注释与提示全变乱码。
$ErrorActionPreference = "Continue"
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Head($text) { Write-Host ''; Write-Host "== $text " ('=' * [math]::Max(0, 56 - $text.Length)) }
function Write-Ok($text)   { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [注意] $text" -ForegroundColor Yellow }
function Write-Bad($text)  { Write-Host "  [问题] $text" -ForegroundColor Red }

$script:blocking = @()

# 交付包根目录（判断随包运行时是否就位要用）
$root = $PSScriptRoot

# ---------------------------------------------------------------- 基础环境
Write-Head '基础环境'

try {
    $nodeVersion = (& node -v 2>$null) -replace '^v',''
    if ($LASTEXITCODE -eq 0 -and $nodeVersion) {
        $parts = $nodeVersion -split '\.'
        $major = [int]$parts[0]
        $minor = [int]$parts[1]
        # package.json 要求 ^22.19.0 || >=24.0.0
        if (($major -eq 22 -and $minor -ge 19) -or $major -ge 24) {
            Write-Ok "Node.js $nodeVersion"
        } else {
            Write-Bad "Node.js $nodeVersion 版本过低（需要 22.19 以上，或 24 以上）"
            $script:blocking += 'Node.js 版本过低'
        }
    } else {
        Write-Bad '未检测到 Node.js'
        $script:blocking += 'Node.js 未安装'
    }
} catch {
    Write-Bad '未检测到 Node.js'
    $script:blocking += 'Node.js 未安装'
}

try {
    $null = & ffmpeg -version 2>&1
    if ($LASTEXITCODE -eq 0) {
        $bundledFfmpeg = Test-Path -LiteralPath (Join-Path $root '运行环境\ffmpeg\ffmpeg.exe')
        if ($bundledFfmpeg) { Write-Ok 'FFmpeg 已就绪（随包携带）' }
        else { Write-Ok 'FFmpeg 已安装' }
    } else {
        Write-Warn '未检测到 FFmpeg（配音、字幕合成、视频渲染都依赖它）'
        $script:blocking += 'FFmpeg 未安装'
    }
} catch {
    Write-Warn '未检测到 FFmpeg'
    $script:blocking += 'FFmpeg 未安装'
}

# ---------------------------------------------------------------- 交付包完整性
Write-Head '交付包完整性'
$cliEntry = Join-Path $root 'vendor\deepseek-harness\apps\cli\lib\bin.js'
if (Test-Path -LiteralPath $cliEntry) {
    Write-Ok '工作台引擎已构建'
} else {
    Write-Bad '工作台引擎缺失——交付包不完整，请重新解压'
    $script:blocking += '交付包不完整'
}

if (Test-Path -LiteralPath (Join-Path $root 'node_modules')) {
    Write-Ok '依赖已安装'
} else {
    Write-Bad '依赖缺失，请重新解压'
    $script:blocking += '依赖缺失'
}

# zip 存不了符号链接，所以打包时全跳过了。没跑过「首次运行.cmd」时，vendor 的
# pnpm workspace 链接是缺的——工作台能启动，但能力包会加载失败。
#
# 判据只看「内容能不能解析」，不要求必须是链接形态：pnpm 重建出的是 symlink，
# 别的安装方式可能给 junction 或实体目录，三者都能用。真正要抓的是目录整个
# 不存在，那才是没跑首次运行。
$probe = Join-Path $root 'vendor\deepseek-harness\apps\cli\node_modules\@deepseek-ai\dsh-app-boot'
if (Test-Path -LiteralPath (Join-Path $probe 'package.json')) {
    Write-Ok '依赖链接已就绪'
} else {
    Write-Bad '依赖链接尚未重建——请先双击「首次运行.cmd」（只需做一次，约 30 秒）'
    $script:blocking += '依赖链接未重建'
}

$shell = Join-Path $root '浏览器\chrome-headless-shell-win64\chrome-headless-shell.exe'
if (Test-Path -LiteralPath $shell) {
    Write-Ok '渲染浏览器已就绪（高速版）'
} else {
    $chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    if (Test-Path -LiteralPath $chrome) {
        Write-Warn '未找到随包的渲染浏览器，将回退到系统 Chrome（渲染慢约 5 倍）'
    } else {
        Write-Bad '没有可用的渲染浏览器，视频渲染会失败'
        $script:blocking += '缺少渲染浏览器'
    }
}

# 第二个实例会以端口占用崩掉，看起来像启动失败
$portBusy = $false
try {
    $conn = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction Stop
    $portBusy = $null -ne $conn
} catch {
    $portBusy = $false
}
if ($portBusy) {
    Write-Warn '端口 4173 已被占用（工作台可能已在运行；若不是，请换个端口启动）'
} else {
    Write-Ok '端口 4173 空闲'
}

# ---------------------------------------------------------------- 镜像可达性
Write-Head '下载加速'
# HuggingFace 直连在国内多数网络下不通（2026-10-08 实测超时），模型下载必须走镜像。
$mirrors = @(
    @{ Name = '模型镜像 hf-mirror.com'; Url = 'https://hf-mirror.com'; Critical = $true },
    @{ Name = 'npm 镜像 npmmirror';   Url = 'https://registry.npmmirror.com'; Critical = $false }
)
foreach ($m in $mirrors) {
    try {
        $null = Invoke-WebRequest -Uri $m.Url -Method Head -TimeoutSec 6 -UseBasicParsing -ErrorAction Stop
        Write-Ok "$($m.Name) 可达"
    } catch {
        if ($m.Critical) {
            Write-Warn "$($m.Name) 不可达——本地模型下载会失败，云端功能不受影响"
        } else {
            Write-Warn "$($m.Name) 不可达——如需安装依赖请改用官方源"
        }
    }
}

# ---------------------------------------------------------------- 硬件与推荐配置
Write-Head '本机配置与建议'

$gpuTotalMiB = 0
$gpuName = ''
try {
    $smi = (Get-Command nvidia-smi -ErrorAction Stop).Source
    $raw = & $smi '--query-gpu=name,memory.total' '--format=csv,noheader,nounits' 2>$null
    if ($raw) {
        $first = ($raw -split "`n")[0] -split ','
        $gpuName = $first[0].Trim()
        $gpuTotalMiB = [int]$first[1].Trim()
    }
} catch { }

$os = Get-CimInstance Win32_OperatingSystem
$ramTotalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB)
$ramFreeGb = [math]::Round($os.FreePhysicalMemory / 1MB)

if ($gpuTotalMiB -gt 0) {
    Write-Host ("  显卡：{0}（{1} GB 显存）" -f $gpuName, [math]::Round($gpuTotalMiB / 1024, 1))
} else {
    Write-Host '  显卡：未检测到 NVIDIA 独立显卡'
}
Write-Host ("  内存：共 {0} GB，当前可用 {1} GB" -f $ramTotalGb, $ramFreeGb)

# 渲染需要临时空间，磁盘在渲染中途写满比慢更糟
$best = Get-PSDrive -PSProvider FileSystem |
    Where-Object { $_.Free -gt 0 } |
    Sort-Object { $_.Free } -Descending |
    Select-Object -First 1
if ($best) {
    Write-Host ("  最空闲磁盘：{0}:\ （{1} GB）" -f $best.Name, [math]::Floor($best.Free / 1GB))
}

# 推荐配置。门槛来自实测（bridge.mjs 的 ENGINE_VRAM_NEED_MIB / ENGINE_RAM_NEED_MIB）：
#   字幕识别 4.5G 显存 /8G 内存 / 4.4G 模型
#   本地配音 7.5G 显存 / 23G 内存 / 7.2G 模型  ← 真正的门槛是内存
#   封面生图 8.5G 显存 / 10G 内存 / 18G 模型  ← 8G 卡不够，int8 已是量化下限
$vramGb = [math]::Round($gpuTotalMiB / 1024, 1)
Write-Host ''
Write-Host '  建议配置：' -ForegroundColor Cyan

if ($vramGb -lt 8) {
    Write-Host '    · 配音：云端（不占本机资源，官方标注限时免费）' -ForegroundColor Cyan
    Write-Host '    · 字幕：云端识别' -ForegroundColor Cyan
    Write-Host '    · 封面：云端生图' -ForegroundColor Cyan
    Write-Host '    · 说明：本地配音需要 8GB 以上显存加 23GB 空闲内存；本地封面生图需要 12GB 以上显存。' -ForegroundColor DarkGray
    Write-Host '              你的显卡达不到，走云端即可。视频渲染用的是 CPU，不受显卡影响。' -ForegroundColor DarkGray
} elseif ($vramGb -lt 12) {
    Write-Host '    · 配音：云端（不占显存，把显存留给字幕）' -ForegroundColor Cyan
    Write-Host '    · 字幕：本机识别（需 4.5GB 显存 / 4.4GB 模型）' -ForegroundColor Cyan
    Write-Host '    · 封面：云端生图（本地封面需 12GB 以上显存）' -ForegroundColor Cyan
} elseif ($ramFreeGb -lt 23) {
    Write-Host ("    · 配音：云端（本地配音需 23GB 空闲内存，当前只有 {0}GB）" -f $ramFreeGb) -ForegroundColor Cyan
    Write-Host '    · 字幕：本机识别' -ForegroundColor Cyan
    Write-Host '    · 封面：本机生图（需 8.5GB 显存 / 10GB 内存）' -ForegroundColor Cyan
} else {
    Write-Host '    · 配音：本机合成（需 7.5GB 显存 / 23GB 内存 / 7.2GB 模型）' -ForegroundColor Cyan
    Write-Host '    · 字幕：本机识别' -ForegroundColor Cyan
    Write-Host '    · 封面：本机生图（需 8.5GB 显存 / 18GB 模型）' -ForegroundColor Cyan
    Write-Host '    · 全部本地运行，零云端费用。' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 结论
Write-Head '结论'
if ($script:blocking.Count -eq 0) {
    Write-Host '  环境检查通过，可以双击「启动工作台.cmd」开始使用。' -ForegroundColor Green
    exit 0
} else {
    Write-Host '  以下问题需要处理：' -ForegroundColor Red
    foreach ($item in ($script:blocking | Select-Object -Unique)) { Write-Host "    - $item" }
    Write-Host ''
    Write-Host '  处理后重新运行本脚本确认。详细说明见「安装说明.md」。' -ForegroundColor Yellow
    exit 1
}
