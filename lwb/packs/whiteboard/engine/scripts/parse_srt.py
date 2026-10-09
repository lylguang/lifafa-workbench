#!/usr/bin/env python3
"""
SRT 解析 + 分镜建议

把 .srt 字幕解析成结构化字幕条，并按「每幕 25-35 秒口播」的建议把字幕
分组成场景，给出每个场景的起止时间、总时长（→ sceneDurationMs）和文本。

用途：作为 srt-whiteboard-animation 工作流第 1 步的输入依据——
读出叙事事件、规划配图策略、并为每张图片的标注确定 sceneDurationMs。

用法：
  python parse_srt.py <字幕.srt> [--target-sec 30] [--min-sec 25] [--max-sec 35]

输出：JSON（stdout），字段：
  cues    每条字幕: {index, startMs, endMs, durMs, text}
  scenes  建议场景: {sceneIndex, startMs, endMs, sceneDurationMs, cueRange, text}
标准 stderr 打印人类可读摘要，便于直接阅读。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_TIME = re.compile(r"(\d+):(\d{2}):(\d{2})[,.](\d{1,3})")


def _to_ms(h: str, m: str, s: str, ms: str) -> int:
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(ms.ljust(3, "0"))


def parse_srt(text: str) -> list[dict]:
    """把 SRT 文本解析成字幕条列表。容忍多余空行、BOM、逗号/点毫秒分隔。"""
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n", text.strip())
    cues: list[dict] = []
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip() != ""]
        if not lines:
            continue
        # 找到含时间轴的行
        time_line_idx = next((i for i, ln in enumerate(lines) if "-->" in ln), None)
        if time_line_idx is None:
            continue
        times = _TIME.findall(lines[time_line_idx])
        if len(times) < 2:
            continue
        start = _to_ms(*times[0])
        end = _to_ms(*times[1])
        body = " ".join(lines[time_line_idx + 1:]).strip()
        cues.append({
            "index": len(cues) + 1,
            "startMs": start,
            "endMs": end,
            "durMs": max(0, end - start),
            "text": body,
        })
    return cues


def _span(cues: list[dict]) -> int:
    return max(0, cues[-1]["endMs"] - cues[0]["startMs"])


def _make_scene(index: int, cues: list[dict]) -> dict:
    return {
        "sceneIndex": index,
        "startMs": cues[0]["startMs"],
        "endMs": cues[-1]["endMs"],
        "sceneDurationMs": _span(cues),
        "cueRange": [cues[0]["index"], cues[-1]["index"]],
        "text": " ".join(c["text"] for c in cues).strip(),
    }


def _plan_scenes(cues: list[dict], target_ms: float, min_ms: float, max_ms: float) -> tuple[list[list[dict]], str | None]:
    """
    用动态规划把字幕条切成幕，返回 (分幕结果, 提示信息)。

    原实现是贪心：累积到 target 就断幕、超 max 强制断幕。贪心有两个后果——末幕可能
    只剩几秒（总长 40s 会切出 32s + 8s），中间也可能被 max 挤出一段短幕。短幕渲染
    出来是一张来不及看就结束的图，观感比略微超长差得多。

    这里改为全局最优切分：状态 dp[i] = 前 i 条字幕的最小代价，枚举上一幕的起点 j，
    代价同时惩罚「偏离 target」和「越界」。因此短幕在规划阶段就不会产生，不需要事后
    修补。max 是建议上限：当字幕总长本就超出 max 的整数倍时，允许适度超出比切出
    短幕更好，所以超限只记惩罚而不禁止。
    """
    n = len(cues)
    if n == 0:
        return [], None
    if n == 1:
        return [list(cues)], None

    starts = [c["startMs"] for c in cues]
    ends = [c["endMs"] for c in cues]

    def span(j: int, i: int) -> int:
        """第 j..i-1 条字幕组成的幕时长。"""
        return max(0, ends[i - 1] - starts[j])

    INF = float("inf")
    dp = [INF] * (n + 1)
    prev = [0] * (n + 1)
    dp[0] = 0.0

    for i in range(1, n + 1):
        # 只回溯有限的窗口，避免 O(n^2) 在长字幕上变慢
        for j in range(i - 1, max(-1, i - 400) - 1, -1):
            s = span(j, i)
            if s > max_ms * 2.5:  # 再往前只会更长，剪枝
                break
            if s < min_ms and i != n:
                # 非末幕不允许短于 min；末幕也尽量不短，交给代价函数罚
                continue
            cost = dp[j]
            if cost == INF:
                continue
            # 偏离 target 的代价（归一化，避免与越界惩罚量级失衡）
            cost += abs(s - target_ms) / target_ms
            if s < min_ms:
                # 末幕短于 min：重罚，但不禁止（总长不足时只能接受）
                cost += 1.5 + (min_ms - s) / min_ms
            if s > max_ms:
                # 超出上限：按超出比例惩罚
                cost += 0.8 * (s - max_ms) / max_ms
            if cost < dp[i]:
                dp[i] = cost
                prev[i] = j

    if dp[n] == INF:
        # 兜底：窗口内找不到可行切分（例如单条字幕就超过 2.5×max），退化为整段一幕
        return [list(cues)], "字幕条过长，无法按目标时长分幕，已作为单幕处理"

    # 回溯切点
    cuts: list[int] = []
    cursor = n
    while cursor > 0:
        cuts.append(cursor)
        cursor = prev[cursor]
    cuts.reverse()

    buckets: list[list[dict]] = []
    start = 0
    for cut in cuts:
        buckets.append(cues[start:cut])
        start = cut

    # 生成提示：说明与建议值的偏差
    notes: list[str] = []
    for index, bucket in enumerate(buckets):
        s = span(0, 0)  # placeholder, 下面按 bucket 重算
        s = max(0, bucket[-1]["endMs"] - bucket[0]["startMs"])
        if s < min_ms:
            notes.append(f"幕{index + 1} 仅 {s/1000:.1f}s（总长不足，短于建议下限）")
        elif s > max_ms:
            notes.append(f"幕{index + 1} 为 {s/1000:.1f}s（超出建议上限）")
    return buckets, ("；".join(notes) if notes else None)


def group_scenes(cues: list[dict], target_sec: float, min_sec: float, max_sec: float) -> list[dict]:
    """
    按目标时长把连续字幕聚成场景。切分由 _plan_scenes 全局规划，
    保证不产生短幕（除非字幕总长本身不足）。
    """
    target_ms, min_ms, max_ms = target_sec * 1000, min_sec * 1000, max_sec * 1000
    buckets, note = _plan_scenes(cues, target_ms, min_ms, max_ms)
    scenes = [_make_scene(i + 1, b) for i, b in enumerate(buckets)]
    if note and scenes:
        scenes[0]["_note"] = note
    return scenes


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="SRT 解析 + 分镜建议")
    p.add_argument("srt", help="字幕文件路径 (.srt)")
    p.add_argument("--target-sec", type=float, default=30.0, help="每幕目标口播秒数（默认 30）")
    p.add_argument("--min-sec", type=float, default=25.0, help="每幕最短秒数（默认 25）")
    p.add_argument("--max-sec", type=float, default=35.0, help="每幕最长秒数（默认 35）")
    args = p.parse_args(argv)

    try:
        raw = Path(args.srt).read_text(encoding="utf-8-sig")
    except OSError as e:
        print(f"[err] 无法读取字幕: {e}", file=sys.stderr)
        return 1

    cues = parse_srt(raw)
    if not cues:
        print("[err] 未解析到任何字幕条，请检查 SRT 格式", file=sys.stderr)
        return 1
    scenes = group_scenes(cues, args.target_sec, args.min_sec, args.max_sec)
    note = scenes[0].pop("_note", None) if scenes else None

    total_ms = cues[-1]["endMs"] - cues[0]["startMs"]
    print(f"字幕条: {len(cues)}  总时长: {total_ms/1000:.1f}s  建议场景: {len(scenes)}", file=sys.stderr)
    for s in scenes:
        print(f"  幕{s['sceneIndex']:>2}  {s['startMs']/1000:6.1f}-{s['endMs']/1000:6.1f}s "
              f"({s['sceneDurationMs']/1000:4.1f}s, 字幕{s['cueRange'][0]}-{s['cueRange'][1]}): "
              f"{s['text'][:40]}", file=sys.stderr)
    if note:
        print(f"  [注意] {note}", file=sys.stderr)

    json.dump({"cues": cues, "scenes": scenes}, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
