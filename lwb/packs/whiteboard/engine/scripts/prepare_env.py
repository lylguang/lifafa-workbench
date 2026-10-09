#!/usr/bin/env python3
"""
流式笔迹动画 - 环境引导脚本

职责：
  1. 在 skill 目录下建立隔离的 Python 虚拟环境（已存在则复用）
  2. 核对运行所需的第三方库是否可导入
  3. 自动补齐缺失的库
  4. 末行打印 ENV_PY=<解释器路径>，供上层调用方捕获

用法：
  python prepare_env.py          # 建环境 + 补依赖，输出 ENV_PY
  python prepare_env.py --check  # 仅探测，缺东西就以非零码退出
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

# skill 根目录 = 本脚本向上两级
SKILL_ROOT = Path(__file__).resolve().parent.parent
VENV_ROOT = SKILL_ROOT / ".venv"

# 解释器导入名 -> pip 安装名。
# 必需依赖：渲染与检查图都要用到。
REQUIRED_DEPS: dict[str, str] = {
    "cv2": "opencv-python",
    "numpy": "numpy",
    "PIL": "Pillow",  # render_annotation_preview.py 画区域编号预览图（含中文标签）
}
# 可选依赖：PyAV 只在系统没有 ffmpeg 时用于 H.264 转码。
# 系统已装 ffmpeg 时不需要它，所以不参与「解释器是否可用」的判断。
OPTIONAL_DEPS: dict[str, str] = {
    "av": "av",
}
DEPS: dict[str, str] = {**REQUIRED_DEPS, **OPTIONAL_DEPS}


def interpreter_path() -> Path:
    """虚拟环境里的 python 可执行文件位置（跨平台）。"""
    if sys.platform.startswith("win"):
        return VENV_ROOT / "Scripts" / "python.exe"
    return VENV_ROOT / "bin" / "python"


def ensure_venv(check_only: bool) -> Path:
    py = interpreter_path()
    if VENV_ROOT.exists() and py.exists():
        print(f"[ok] 复用现有虚拟环境: {VENV_ROOT}")
        return py

    if check_only:
        print(f"[err] 虚拟环境尚未建立: {VENV_ROOT}")
        sys.exit(1)

    print(f"[..] 建立虚拟环境: {VENV_ROOT}")
    venv.create(str(VENV_ROOT), with_pip=True)
    print("[ok] 虚拟环境就绪")
    return py


def can_import(py: Path, import_name: str) -> bool:
    probe = subprocess.run(
        [str(py), "-c", f"import {import_name}"],
        capture_output=True,
    )
    return probe.returncode == 0


# pip 镜像源。opencv-python 有 60M+ wheels，走官方源在国内能跑几十分钟
# （2026-09 实测 35 分钟仍未完成），装不上用户只会看到"白板功能坏了"。
# LWB_PIP_INDEX_URL 可覆盖；镜像探测失败时退回官方源，不把海外用户挡在门外。
DEFAULT_PIP_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple"
PIP_FALLBACK_INDEX = "https://pypi.org/simple"
PIP_INSTALL_TIMEOUT = 1800


def _index_unreachable(url: str, timeout: float = 6.0) -> bool:
    """探测 index 源是否可达。只发请求，不下载任何内容。"""
    import urllib.request

    try:
        with urllib.request.urlopen(url, timeout=timeout):
            return False
    except Exception:
        return True


def resolve_index_url() -> str:
    override = os.environ.get("LWB_PIP_INDEX_URL")
    if override:
        return override
    if _index_unreachable(DEFAULT_PIP_INDEX):
        print(f"[warn] 镜像源不可达，改用官方源 {PIP_FALLBACK_INDEX}")
        return PIP_FALLBACK_INDEX
    return DEFAULT_PIP_INDEX


def install(py: Path, packages: list[str]) -> bool:
    """装依赖。镜像源失败时换官方源重试一次——半死的镜像比全死的更难查。"""
    if not packages:
        return True
    candidates: list[str] = []
    primary = resolve_index_url()
    candidates.append(primary)
    if primary and primary != PIP_FALLBACK_INDEX:
        candidates.append(PIP_FALLBACK_INDEX)

    last_error = ""
    for index in candidates:
        print(f"[..] 安装依赖: {', '.join(packages)}（源: {index}）")
        args = [str(py), "-m", "pip", "install", "--quiet"]
        if index:
            args += ["--index-url", index]
        try:
            res = subprocess.run(
                [*args, *packages],
                capture_output=True,
                text=True,
                timeout=PIP_INSTALL_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            last_error = f"安装超时（超过 {PIP_INSTALL_TIMEOUT // 60} 分钟）"
            print(f"[warn] {last_error}")
            continue
        if res.returncode == 0:
            print("[ok] 依赖安装完成")
            return True
        last_error = res.stderr.strip()

    print(f"[err] 安装失败: {last_error}")
    return False


def current_interpreter_ready() -> bool:
    """
    当前解释器是否已具备必需依赖（用于优先复用系统 Python）。

    只检查必需依赖：ffmpeg 存在时 PyAV 用不到，不该因为它缺失就判定不可用。
    """
    for import_name in REQUIRED_DEPS:
        try:
            __import__(import_name)
        except ImportError:
            return False
    return True


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def main() -> None:
    check_only = "--check" in sys.argv

    # 当前解释器已满足必需依赖时直接复用它：新建 venv 并安装 opencv-python 在
    # 缺少镜像的机器上可能耗时很久，而系统 Python 往往已经装好这些库。
    if current_interpreter_ready():
        print(f"[ok] 当前解释器已具备必需依赖，直接复用: {sys.executable}")
        if not can_import(Path(sys.executable), "av") and not ffmpeg_available():
            print("[warn] 既没有 ffmpeg 也没有 PyAV，H.264 转码将退化为 mp4v（兼容性较差）")
        print(f"\nENV_PY={sys.executable}")
        return

    py = ensure_venv(check_only)

    missing: list[str] = []
    for import_name, pip_name in DEPS.items():
        if can_import(py, import_name):
            print(f"[ok] {pip_name}")
        else:
            print(f"[miss] {pip_name}")
            missing.append(pip_name)

    if missing:
        if check_only:
            print(f"\n缺 {len(missing)} 个依赖: {', '.join(missing)}")
            sys.exit(1)
        if not install(py, missing):
            sys.exit(1)

    # 末行：供调用方捕获的约定输出
    print(f"\nENV_PY={py}")


if __name__ == "__main__":
    main()
