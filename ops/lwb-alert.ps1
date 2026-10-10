# 李发发工作台 · 无人值守告警播报
#
# 为什么需要这个：工作台的 WebAudio 提示音只在浏览器开着时有效。定时任务是
# 无人值守的——人可能在睡觉，浏览器可能压根没开，标签页也会被后台节流到静音。
# 这份脚本由独立的计划任务每 15 秒跑一次，与工作台进程完全无关，所以
# 「工作台崩了」这件事本身也能被播报出来（保活脚本会往同一个文件写告警）。
#
# 编码：必须是 UTF-8 with BOM。Windows PowerShell 5.1 按 ANSI 读取无 BOM 的
# 脚本，中文字符串会变成乱码甚至解析失败。
#
# 数据文件：<工作台数据目录>\alerts.json，{ entries: [{ level, title, detail, at, read }] }
# 播放后把读过的条目标记为 read=true 并回写，避免每 15 秒重复播报同一条。

$ErrorActionPreference = 'Stop'

# 数据目录随工作台实例走。
# 兜底写死这台机器的实际路径，而不是 Join-Path $env:LOCALAPPDATA 'lwb-default'：
# 计划任务启动时的环境是继承来的，机器级变量偶尔读不到，那样会静默地永远不播报。
$Workspace = $env:LWB_SPOKEN_VIDEO_WORKSPACE
if (-not $Workspace) {
  # 兜底：从本脚本位置推出仓库根。计划任务启动时继承的是系统环境，机器级变量
  # 偶尔读不到，写死路径则换机器就失效——推算出来的路径两处都对。
  # ---------------------------------------------------------------------------
# 路径解析
#
# 顺序：环境变量 → 同目录的 lwb-repo.txt（部署时写一次）→ 脚本位置向上找 → 桌面推测。
# 推测只当兜底，且必须验证 lwb 真的存在；否则宁可报「找不到」也不要
# 拼出一个错路径假装成功——2026-10-10 就在这栽过：脚本在 E:\ 盘，向上遍历永远到不了
# 仓库所在的 F:\ 盘，而 $env:USERPROFILE 的 Desktop 恰好也存在，兜底分支误判成桌面。
# ---------------------------------------------------------------------------
$repoRoot = $env:LWB_REPO_ROOT
if (-not $repoRoot -and (Test-Path (Join-Path $PSScriptRoot 'lwb-repo.txt'))) {
  # 必须显式指定 UTF8：lwb-repo.txt 里的路径含中文，而 Windows PowerShell 5.1
  # 默认按 ANSI（GBK）读文件，会把「李发发工作台」读成乱码，路径随即失效——
  # 2026-10-10 实测踩过，日志里显示的正是乱码路径。
  $repoRoot = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'lwb-repo.txt')).Trim()
}
if (-not $repoRoot) {
  $probe = $PSScriptRoot
  for ($i = 0; $i -lt 4 -and $probe; $i++) {
    if (Test-Path (Join-Path $probe 'lwb')) { $repoRoot = $probe; break }
    $probe = Split-Path -Parent $probe
  }
}
if (-not $repoRoot) {
  # 最后兜底：在所有已存在的盘符的 Desktop 下找。逐个验证 lwb 存在，
  # 而不是只拼路径——USERPROFILE 的桌面与真实桌面未必是同一个。
  foreach ($drive in @('C:', 'D:', 'E:', 'F:')) {
    $candidate = Join-Path (Join-Path $drive ('Users\' + $env:USERNAME + '\Desktop')) 'lifafa-workbench-main'
    if (Test-Path (Join-Path $candidate 'lwb')) { $repoRoot = $candidate; break }
  }
}
if (-not $repoRoot) { throw '告警脚本 无法定位仓库根：请设置 LWB_REPO_ROOT 或在脚本同目录写 lwb-repo.txt' }  $profileHome = Join-Path (Join-Path (Join-Path $repoRoot 'lwb') 'local') 'dsh-home'
  $Workspace = Join-Path (Join-Path (Join-Path (Join-Path $profileHome 'profiles') 'lwb') 'pack-state') 'workspaces\spoken-video'
}
$DataDir = Join-Path $Workspace 'data'
$AlertsFile = Join-Path $DataDir 'alerts.json'

# 暂停开关：建了 lwb-alert.off 就静音（排查时用）
$OffSwitch = Join-Path $env:TEMP 'lwb-alert.off'
if (Test-Path $OffSwitch) { exit 0 }

if (-not (Test-Path $AlertsFile)) { exit 0 }

try {
  $raw = Get-Content -Raw -Encoding UTF8 -LiteralPath $AlertsFile
  $doc = ConvertFrom-Json $raw
} catch {
  # 读到半写的文件是正常的（工作台用「临时文件 + 原子 rename」写盘，落地前会撞上）。
  # 下一轮再读即可，不该在这里刷错误。
  exit 0
}

$entries = @($doc.entries)
if ($entries.Count -eq 0) { exit 0 }

$pending = $entries | Where-Object { $_.read -ne $true }
if (-not $pending) { exit 0 }

$changed = $false
foreach ($alert in $pending) {
  $title = [string]$alert.title
  $detail = [string]$alert.detail
  $isError = ([string]$alert.level) -eq 'error'

  Write-Host ("[{0}] {1} - {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $title, $detail)

  if ($isError) {
    # 失败：Handshake 是系统自带的双声，特征明显；再补一声低频提示。
    try {
      Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
      [System.Media.SystemSounds]::Handshake.Play()
      Start-Sleep -Milliseconds 350
      [System.Media.SystemSounds]::Exclamation.Play()
    } catch {
      # 系统音不可用（极少见），退回控制台蜂鸣，至少还能听见。
      try { [Console]::Beep(220, 400) } catch { }
    }
  } else {
    # 完成：Asterisk 是单声上扬，语义上比连续两声更接近「收到了」。
    try {
      Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
      [System.Media.SystemSounds]::Asterisk.Play()
    } catch {
      try { [Console]::Beep(880, 220) } catch { }
    }
  }

  # 可选桌面弹窗：默认关闭，避免半夜弹窗。设 LWB_ALERT_POPUP=1 打开。
  if ($env:LWB_ALERT_POPUP -eq '1') {
    try {
      $payload = @{ title = $title; text = $detail } | ConvertTo-Json -Compress
      $payload | Out-File -FilePath (Join-Path $env:TEMP 'lwb-alert-toast.txt') -Encoding utf8 -Force
      & msg.exe $env:USERNAME "李发发工作台：$title" "$detail" | Out-Null
    } catch { }
  }

  $alert.read = $true
  $changed = $true
}

if ($changed) {
  # 回写已读标记。同样用「临时文件 + 原子 rename」，避免和工作台的写入互相
  # 把对方的 rename 打成 EPERM（Windows 上 rename 目标被任意句柄打开就会失败）。
  #
  # 编码必须是「无 BOM 的 UTF-8」：PowerShell 5.1 的 -Encoding utf8 会写 BOM，
  # 而工作台读 JSON 用的是 JSON.parse，遇到 BOM 直接 SyntaxError——于是这个
  # 脚本每成功播报一次，就把工作台的告警文件弄坏一次。这里用 .NET 的
  # UTF8Encoding($false) 显式关掉 BOM。
  $temp = "$AlertsFile.$PID.tmp"
  try {
    $json = $doc | ConvertTo-Json -Depth 6
    $noBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temp, $json, $noBom)
    Move-Item -LiteralPath $temp -Destination $AlertsFile -Force
  } catch {
    # 写不回去就下次重播，总比丢一条强。
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
}

exit 0