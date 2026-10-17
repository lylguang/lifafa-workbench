# LWB 保活看门狗：定时任务无人值守时，工作台(4173)、媒体桥接(8199) 与字幕引擎(8188)
# 必须在线，否则到点的任务只会得到 "fetch failed"。
#
# 2026-10-02 实测：凌晨重启后没人登录，桥接与工作台都没起来，09:00 的自动轮
# 直接失败；09:54 用户手动拉起后，09:58 那轮又因 8188 引擎没开而失败。
# 引擎侧已改为「任务到达时自动拉起」（见 bridge.mjs 的 ensureEngine），
# 这里负责把两个常驻服务拉回来，并在引擎卡死时兜底重启。
#
# 2026-10-08 实测：字幕引擎(8188)出现「僵尸态」——进程占着端口但 HTTP 完全不响应
# （工作集仅 124MB，正常 1-2GB 以上），工作台字幕任务直接报「引擎未连接」。
# 本脚本原先只看 8199/4173，引擎卡死无人恢复，故加入下面的引擎健康检查。
#
# 引擎不是随时都该在线（云端配音模式下它平时就是关的），所以设了两道防误伤条件：
#   ① 连续 2 轮（约 10 分钟）不健康才动手，单轮抖动不算；
#   ② 桥接里没有 processing 状态的任务才动手。
# 第②条最关键：ComfyUI 跑长音频 ASR 时 /system_stats 也会变慢，只看 HTTP 响应
# 会误杀正在干活的引擎，把定时字幕任务打断在半路。
#
# 想临时停用：新建空文件 E:\lifa-scratch\lwb-keepalive.off 即可。

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------------------
# 路径解析：全部可被环境变量覆盖，这样同一份脚本能跑在不同机器/不同盘符上，
# 而不必改脚本本身。默认值是这台机器的实际情况。
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 路径解析
#
# 顺序：环境变量 → 同目录的 lwb-repo.txt（部署时写一次）→ 脚本位置向上找 → 桌面推测。
# 推测只当兜底，且必须验证 media-bridge 真的存在；否则宁可报「找不到」也不要
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
    if (Test-Path (Join-Path $probe 'media-bridge')) { $repoRoot = $probe; break }
    $probe = Split-Path -Parent $probe
  }
}
if (-not $repoRoot) {
  # 最后兜底：在所有已存在的盘符的 Desktop 下找。逐个验证 media-bridge 存在，
  # 而不是只拼路径——USERPROFILE 的桌面与真实桌面未必是同一个。
  foreach ($drive in @('C:', 'D:', 'E:', 'F:')) {
    $candidate = Join-Path (Join-Path $drive ('Users\' + $env:USERNAME + '\Desktop')) 'lifafa-workbench-main'
    if (Test-Path (Join-Path $candidate 'media-bridge')) { $repoRoot = $candidate; break }
  }
}
if (-not $repoRoot) { throw '保活脚本 无法定位仓库根：请设置 LWB_REPO_ROOT 或在脚本同目录写 lwb-repo.txt' }
$stateDir = if ($env:LWB_STATE_DIR) { $env:LWB_STATE_DIR } else { 'E:\lifa-scratch' }
$offSwitch = Join-Path $stateDir 'lwb-keepalive.off'

# 工作台目录必须从 $repoRoot 推导——它有四层带验证的解析（env → lwb-repo.txt →
# 向上探测 → 逐盘验证）。2026-10-16 实测教训：早先版本用「桌面 + lifafa-workbench-main」
# 硬拼，而这台机器的仓库在 桌面\李发发工作台\ 子目录下，拼出来的 C 盘路径不存在，
# 拉起分支从 10-09 起 15 次全部「启动脚本不存在」静默失败，还留下十几个僵死 cmd。
$workbenchDir = Join-Path $repoRoot 'lifafa-workbench-main'
if (-not (Test-Path (Join-Path $workbenchDir '启动工作台.cmd'))) {
  # repoRoot 直接就是工作台目录的部署形态（repoRoot 下即脚本）也算数。
  if (Test-Path (Join-Path $repoRoot '启动工作台.cmd')) { $workbenchDir = $repoRoot }
  else { $workbenchDir = $null }
}
# 桥接源码在仓库内（media-bridge/）。运行副本就是仓库那份——两份拷贝迟早不一致，
# 而不一致的那份不会出现在 git 历史里，出问题时无从追溯。
# config.json / data / voices 也在那儿，由 media-bridge/.gitignore 挡住密钥与产物。
$bridgeDir = if ($env:LWB_BRIDGE_DIR) { $env:LWB_BRIDGE_DIR } else { Join-Path $repoRoot 'media-bridge' }
# $workbenchDir 为 null（两种部署形态都没找到脚本）时保持 null，拉起分支的
# Test-Path 会自然走「启动脚本不存在」告警，绝不能拼出一个假路径假装能拉。
$startWorkbench = if ($workbenchDir) { Join-Path $workbenchDir '启动工作台.cmd' } else { $null }

$logFile = $stateDir + '\lwb-keepalive.log'

# 开关放在路径解析之后：$offSwitch 由上面的 $stateDir 推导。
if (Test-Path $offSwitch) { exit 0 }
function Write-Log([string]$message) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Test-Alive([string]$url) {
  # 关键：工作台对匿名请求返回 401，而 PowerShell 在 4xx/5xx 时抛异常。
  # 判定标准与 启动工作台.cmd 的端口预检一致——「有 HTTP 响应」即视为在线
  # （能回 401 说明进程正在监听）。否则会把健康的工作台误判为掉线，
  # 每 5 分钟拉起一个重复实例。
  try {
    Invoke-WebRequest -Uri $url -TimeoutSec 6 -UseBasicParsing -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return [bool]$_.Exception.Response
  }
}

function Invoke-BridgeApi([string]$method, [string]$url) {
  try {
    return Invoke-RestMethod -Uri $url -Method $method -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
  } catch {
    return $null
  }
}

# 桥接里是否有正在跑的任务。有的话绝不能动引擎——那会把字幕/配音打断在半路。
# /admin/tasks 的任务数组字段实测叫 `tasks`（不是 `recent`），两个都兼容一下，
# 免得以后改字段名就静默失效——静默失效的后果是「永远判定不忙」，等于没有防误伤。
function Test-BridgeBusy {
  $r = Invoke-BridgeApi 'GET' 'http://127.0.0.1:8199/admin/tasks'
  if ($null -eq $r) { return $false }  # 桥接查询失败时不阻塞修复，交给引擎健康判定
  $list = $r.tasks
  if ($null -eq $list) { $list = $r.recent }
  if ($null -eq $list) { return $false }
  $busy = @($list | Where-Object { $_.status -eq 'processing' })
  if ($busy.Count -gt 0) { return $true }
  # 桥接任务都空闲、但 ComfyUI 队列里还排着活（提交了还没进 tasks 视图），也算忙。
  $eng = Invoke-BridgeApi 'GET' 'http://127.0.0.1:8199/admin/engines'
  if ($null -eq $eng) { return $false }
  $tts = @($eng.engines | Where-Object { $_.kind -eq 'tts' })[0]
  if ($null -eq $tts) { return $false }
  return ($tts.starting -eq $true)
}

# 引擎连续不健康的轮次计数（跨脚本调用持久化到文件）。
$strikeFile = Join-Path $stateDir 'lwb-engine-strikes.txt'
function Get-Strikes {
  if (Test-Path $strikeFile) {
    try { return [int]((Get-Content $strikeFile -Raw).Trim()) } catch { return 0 }
  }
  return 0
}
function Set-Strikes([int]$n) {
  Set-Content -LiteralPath $strikeFile -Value ([string]$n) -Encoding ASCII
}

# 字幕引擎(8188)：僵尸态（端口在、HTTP 不响应）不会被 Test-Alive 区分出来，
# 这里直接打引擎状态接口，它内部用 /system_stats 判定「真的连着」。
$engineDown = $false
$bridgeUp = Test-Alive 'http://127.0.0.1:8199/health'
if ($bridgeUp) {
  $status = Invoke-BridgeApi 'GET' 'http://127.0.0.1:8199/admin/engines'
  if ($null -eq $status) {
    $engineDown = $false  # 拿不到状态就别乱动，下次再看
  } else {
    $tts = @($status.engines | Where-Object { $_.kind -eq 'tts' })[0]
    if ($null -eq $tts) {
      $engineDown = $false
    } elseif (-not $tts.starting) {
      # starting 为真说明桥接正在拉起它，别插手；reachable 为假才算不健康。
      $engineDown = (-not $tts.reachable)
    }
  }
}

if ($engineDown) {
  $strikes = (Get-Strikes) + 1
  Set-Strikes $strikes
  Write-Log ("字幕引擎(8188)不健康，第 " + $strikes + " 轮")
  if ($strikes -ge 2) {
    if (Test-BridgeBusy) {
      # 正在跑任务：ComfyUI 忙时响应会变慢，这多半不是僵尸态，下轮再判。
      Write-Log '桥接有进行中的任务，本轮不重启引擎（避免打断字幕/配音）'
      Set-Strikes 0
    } else {
      Write-Log '连续 2 轮不健康且无进行中任务，重启字幕引擎'
      $stop = Invoke-BridgeApi 'POST' 'http://127.0.0.1:8199/admin/engines/tts/stop'
      if ($null -eq $stop -or -not $stop.ok) {
        Write-Log ('关闭字幕引擎失败：' + $(if ($stop) { $stop.message } else { '桥接无响应' }))
      } else {
        Write-Log ('已关闭字幕引擎（结束 ' + $stop.stopped + ' 个进程），正在重新拉起')
      }
      $launch = Invoke-BridgeApi 'POST' 'http://127.0.0.1:8199/admin/engines/tts/launch'
      if ($null -eq $launch) {
        Write-Log '拉起字幕引擎失败：桥接无响应'
      } else {
        Write-Log '已请求拉起字幕引擎（模型加载需 30-60 秒，期间字幕任务会自动等待）'
      }
      Set-Strikes 0
    }
  }
} else {
  if ((Get-Strikes) -ne 0) { Set-Strikes 0 }
}

# 桥接：工作台启动脚本也会拉起它，但反过来不成立，所以两个都要单独看。
if (-not (Test-Alive 'http://127.0.0.1:8199/health')) {
  if (Test-Path -LiteralPath (Join-Path $bridgeDir 'bridge.mjs')) {
    Write-Log '媒体桥接(8199)不在线，正在拉起'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'start', '"local-media-bridge"', '/min', '/D', $bridgeDir, 'cmd', '/c', 'node bridge.mjs' -WindowStyle Hidden
    Start-Sleep -Seconds 5
  } else {
    Write-Log ('媒体桥接目录不存在：' + $bridgeDir)
  }
}

# 调度器有活任务时不要重启工作台。
#
# 2026-10-09 加固。此前这一段是「掉线就无条件拉起」：一次已经跑到配音阶段的
# 20 分钟流水线，会被保活脚本一巴掌打断，run 记成 failed，全部产物作废。
# 现在读到 running / interrupted 的 run 就推迟重启——工作台重启本来就会杀掉
# 执行身份和子进程，而这些轮次在重启后已经能从断点自动续跑（interrupted），
# 所以这个窗口内让任务自己接上比强杀更划算。
#
# 2026-10-16 实测教训：interrupted（主机重启后待续跑）也被算进「忙」，结果工作台
# 僵死后它的调度器再也无法上线去续跑这些轮次，保活看到 interrupted 就永远不拉起
# 工作台——自愈通道被自己锁死，整整一上午无人恢复。interrupted 的恢复前提恰恰是
# 工作台在线，所以它不算忙。唯一要防的是「真主机刚重启完、工作台还在启动途中」
# 这几分钟：给 interruptedAt 落地后 10 分钟的宽限期，期内仍按忙处理。
function Test-ScheduleBusy {
  $root = $env:LWB_SPOKEN_VIDEO_WORKSPACE
  if (-not $root) { return $false }
  $file = Join-Path (Join-Path $root 'data') 'schedules.json'
  if (-not (Test-Path -LiteralPath $file)) { return $false }
  try {
    $doc = Get-Content -Raw -Encoding UTF8 -LiteralPath $file | ConvertFrom-Json
  } catch {
    # 读不到多半是写盘窗口（原子 rename 落地前），下一轮再看。
    return $false
  }
  $running = @($doc.runs | Where-Object { $_.status -eq 'running' })
  if ($running.Count -gt 0) {
    Write-Log ('检测到 {0} 轮自动化在执行，推迟工作台重启' -f $running.Count)
    return $true
  }
  # interrupted：只认 10 分钟内新中断的；更早的说明等续跑已等了一段时间，
  # 工作台必须先回来它们才有机会续跑，不能反过来阻塞拉起。
  $recent = @($doc.runs | Where-Object {
    $_.status -eq 'interrupted' -and $_.interruptedAt -and
    ((Get-Date) - [datetime]$_.interruptedAt).TotalMinutes -lt 10
  })
  if ($recent.Count -gt 0) {
    Write-Log ('检测到 {0} 轮自动化在 10 分钟内被中断，推迟工作台重启' -f $recent.Count)
    return $true
  }
  return $false
}

# 工作台：定时任务的调度器跑在它里面，它不在线就没人触发任务。
if (-not (Test-Alive 'http://127.0.0.1:4173/')) {
  if (Test-ScheduleBusy) {
    Write-Log '工作台(4173)不在线但有活任务，本轮不重启，留给续跑机制处理'
  }
  elseif (Test-Path -LiteralPath $startWorkbench) {
    Write-Log '工作台(4173)不在线，正在拉起'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'start', '/min', 'cmd', '/c', $startWorkbench -WindowStyle Hidden
    # 拉起后确认一次，失败就写一条告警让 lwb-alert 播报出来。
    # 此前工作台分支是「拉完就走」，工作台起不来时完全静默（桥接分支至少有 5 秒等待）。
    Start-Sleep -Seconds 15
    if (-not (Test-Alive 'http://127.0.0.1:4173/')) {
      Write-Log '工作台拉起后 15 秒仍不在线，已写入告警'
      $alertDir = $env:LWB_SPOKEN_VIDEO_WORKSPACE
      if ($alertDir) {
        $alertFile = Join-Path (Join-Path $alertDir 'data') 'alerts.json'
        try {
          $entries = @()
          if (Test-Path -LiteralPath $alertFile) {
            $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $alertFile | ConvertFrom-Json
            $entries = @($existing.entries)
          }
          $alert = [pscustomobject]@{
            id = [guid]::NewGuid().ToString()
            level = 'error'
            title = '工作台未能启动'
            detail = '保活脚本已连续拉起失败，定时任务调度器当前不可用，请手动打开「启动工作台.cmd」。'
            at = (Get-Date).ToUniversalTime().ToString('o')
            read = $false
          }
          $entries = @($alert) + $entries
          $payload = [pscustomobject]@{ schemaVersion = 1; entries = $entries }
          $tmp = "$alertFile.$PID.tmp"
          # 无 BOM 的 UTF-8：工作台用 JSON.parse 读，BOM 会让它直接 SyntaxError。
          $noBom = New-Object System.Text.UTF8Encoding($false)
          [System.IO.File]::WriteAllText($tmp, ($payload | ConvertTo-Json -Depth 6), $noBom)
          Move-Item -LiteralPath $tmp -Destination $alertFile -Force
        } catch {
          Write-Log ('告警写入失败：' + $_.Exception.Message)
        }
      }
    }
  }
  else {
    Write-Log ('工作台启动脚本不存在：' + $startWorkbench)
  }
}
