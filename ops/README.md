# 运维脚本

保活与告警。它们不属于工作台本身（不进交付包、不被浏览器加载），但缺了它们，
定时任务在无人值守时一样会停摆——所以同样受版本控制。

## 脚本

| 脚本 | 计划任务 | 作用 |
|---|---|---|
| `lwb-keepalive.ps1` | `LWBKeepAlive`（每 5 分钟） | 工作台(4173)、媒体桥接(8199)、字幕引擎(8188)掉线时拉起；有活任务时不重启工作台 |
| `lwb-alert.ps1` | `LWBAlert`（每 1 分钟） | 读 `alerts.json` 播报系统音。浏览器关着也能听见，是唯一不依赖浏览器的告警通道 |

## 运行位置

**仓库里的这份是唯一真源。** 运行副本在 `E:\lifa-scratch\`，由计划任务直接指向它——
改成指向仓库内也可以，但那样「编辑哪份就生效哪份」这件事会变得不确定，而运维脚本
恰恰是最需要确定的地方。

部署（换机器或改了脚本之后）：

```powershell
Copy-Item .\ops\lwb-*.ps1 E:\lifa-scratch\ -Force
# 写一次仓库根路径，之后脚本就能自己定位
[System.IO.File]::WriteAllText('E:\lifa-scratch\lwb-repo.txt', '<仓库绝对路径>', (New-Object System.Text.UTF8Encoding($false)))
```

## 路径解析

脚本不写死盘符。查找顺序：

1. 环境变量 `LWB_REPO_ROOT` / `LWB_STATE_DIR` / `LWB_BRIDGE_DIR` / `LWB_DESKTOP`
2. 同目录下的 `lwb-repo.txt`（部署时写一次，**UTF-8 无 BOM**）
3. 从脚本所在位置向上找含 `media-bridge/` 的目录
4. 逐个盘符的桌面下找，**且必须验证 `media-bridge/` 真的存在**

第 4 步的验证不是多余的：2026-10-10 实测，`$env:USERPROFILE` 是 `C:\Users\Administrator`
而真实桌面在 `F:`，前者的 `Desktop` 目录恰好也存在——不验证就会拼出一个看起来
很合理、实际不存在的路径，日志里留下一句「目录不存在」就结束了。

## 编码

两个 `.ps1` 必须 **UTF-8 with BOM**，否则 PowerShell 5.1 按 ANSI 读，中文乱码、
脚本整体报错。`lwb-repo.txt` 相反，必须 **UTF-8 无 BOM**（它是被 `Get-Content
-Encoding UTF8` 读的）。

改这两个文件时，改完先数一遍 BOM 个数——重复的 BOM 会让首行变成 `?#`，
脚本直接失效。

## 开关

- 建 `E:\lifa-scratch\lwb-keepalive.off` → 保活停用（排查时用）
- 建 `%TEMP%\lwb-alert.off` → 告警静音
- 设 `LWB_ALERT_POPUP=1` → 失败时除声音外还弹窗（默认只出声）

相关：[[lifafa-media-bridge-in-repo]]、[[lifafa-schedule-unattended-recovery]]、[[win-cmd-script-encoding-traps]]