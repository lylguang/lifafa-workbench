#!/usr/bin/env python3
"""
字幕时间轴 → 标注骨架

把一幕的字幕条按顺序分配给若干元素，直接产出可用的 annotation.json 骨架：
每个元素拿到对齐到字幕起止的 startMs / durationMs，以及它对应的字幕文本。

为什么需要它：Agent 拿不到语音时间轴时只能猜"第几秒画哪个元素"，画面容易超前
或滞后。这里把分配变成查表——时间来自 SRT 的实际 cue 边界，而不是估计值。

用法：
  python plan_timeline.py <字幕.srt> --scene 1 \
      --elements "假山与小猴" "大猴抢香蕉" "小朋友围观" \
      --width 1672 --height 941 \
      --output scene-01.annotation.json

元素数量与 cue 数量的对应：
  - 元素数 == cue 数：一一对应
  - 元素数 <  cue 数：按 cue 时长比例合并相邻 cue
  - 元素数 >  cue 数：把最长的 cue 均分给多出来的元素

分配完成后，区域坐标仍是占位值，需要在预览台里拖到实际主体上——时间轴是查表得来
的，坐标必须看图确定。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse_srt import group_scenes, parse_srt  # noqa: E402

# 相邻元素之间的呼吸间隔，避免上一个刚画完下一个立刻起笔
BREATH_MS = 150


def allocate(cues: list[dict], count: int) -> list[list[dict]]:
    """把 cues 按时间顺序分成 count 组，尽量保持组内时长均衡。"""
    if count <= 0 or not cues:
        return []
    if count >= len(cues):
        # 元素比 cue 多：把最长的 cue 均分成多段，每段带同一句字幕。
        # 拆出来的段共用该 cue 的文本——一个 cue 里往往讲了多个元素，
        # 所以它们对应同一句字幕是对的，不要串到别的 cue 上。
        groups: list[list[dict]] = [[cue] for cue in cues]
        while len(groups) < count:
            longest = max(range(len(groups)), key=lambda i: _group_span(groups[i]))
            target = groups[longest]
            if len(target) > 1:
                # 已经合并过的组：从中间切开
                mid = len(target) // 2
                groups[longest:longest + 1] = [target[:mid], target[mid:]]
                continue
            cue = target[0]
            mid = cue["startMs"] + cue["durMs"] // 2
            head = {**cue, "endMs": mid, "durMs": mid - cue["startMs"]}
            tail = {**cue, "startMs": mid, "durMs": cue["endMs"] - mid}
            groups[longest:longest + 1] = [[head], [tail]]
        return groups

    # 元素比 cue 少：按累计时长切分，使每组时长尽量接近
    total = sum(cue["durMs"] for cue in cues)
    per_group = total / count
    groups = []
    current: list[dict] = []
    accumulated = 0
    for cue in cues:
        current.append(cue)
        accumulated += cue["durMs"]
        if len(groups) < count - 1 and accumulated >= per_group * (len(groups) + 1):
            groups.append(current)
            current = []
    if current:
        groups.append(current)
    # 兜底：数量对不上时补齐或合并
    while len(groups) < count:
        groups.append(groups.pop())
    while len(groups) > count:
        groups[-2].extend(groups.pop())
    return groups


def _group_span(group: list[dict]) -> int:
    return max(0, group[-1]["endMs"] - group[0]["startMs"])


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="把一幕的字幕时间轴分配给元素，产出标注骨架")
    p.add_argument("srt", help="字幕文件路径 (.srt)")
    p.add_argument("--scene", type=int, default=1, help="第几幕（从 1 起，默认 1）")
    p.add_argument("--elements", nargs="+", required=True, help="按叙事顺序的元素名称")
    p.add_argument("--width", type=int, required=True, help="原图像素宽")
    p.add_argument("--height", type=int, required=True, help="原图像素高")
    p.add_argument("--target-sec", type=float, default=30.0)
    p.add_argument("--min-sec", type=float, default=25.0)
    p.add_argument("--max-sec", type=float, default=35.0)
    p.add_argument("--output", default=None, help="输出 JSON 路径；缺省打印到 stdout")
    args = p.parse_args(argv)

    try:
        raw = Path(args.srt).read_text(encoding="utf-8-sig")
    except OSError as e:
        print(f"[err] 无法读取字幕: {e}", file=sys.stderr)
        return 1

    cues = parse_srt(raw)
    if not cues:
        print("[err] 未解析到任何字幕条", file=sys.stderr)
        return 1

    scenes = group_scenes(cues, args.target_sec, args.min_sec, args.max_sec)
    if not (1 <= args.scene <= len(scenes)):
        print(f"[err] 幕号超出范围：共 {len(scenes)} 幕", file=sys.stderr)
        return 1
    scene = scenes[args.scene - 1]
    scene_cues = [c for c in cues if scene["cueRange"][0] <= c["index"] <= scene["cueRange"][1]]

    groups = allocate(scene_cues, len(args.elements))
    if not groups:
        print("[err] 无法分配时间轴", file=sys.stderr)
        return 1

    origin = scene["startMs"]
    elements = []
    for index, (label, group) in enumerate(zip(args.elements, groups)):
        start = group[0]["startMs"] - origin
        end = group[-1]["endMs"] - origin
        # 预留呼吸间隔，避免与下一元素首尾相接
        duration = max(200, end - start - (BREATH_MS if index < len(groups) - 1 else 0))
        elements.append({
            "id": f"element_{index + 1}",
            "label": label,
            "sequence": index + 1,
            "narrativeRole": "待填写：该元素在字幕中的叙事作用",
            "subtitle": " ".join(c["text"] for c in group).strip(),
            "type": "object",
            # 占位区域：等分画布，必须在预览台里拖到实际主体上
            "region": {
                "x": int(args.width * index / len(groups)),
                "y": int(args.height * 0.15),
                "width": int(args.width / len(groups)),
                "height": int(args.height * 0.7),
            },
            "reveal": {
                "direction": "top_to_bottom",
                "startMs": start,
                "durationMs": duration,
                "maskPaddingPx": 22,
                "protectedRegions": [],
            },
            "handPath": {},
        })

    annotation = {
        "sceneId": f"scene-{args.scene:02d}",
        "canvas": {"width": args.width, "height": args.height},
        "storyBasis": scene["text"][:200],
        "sceneDurationMs": scene["sceneDurationMs"],
        "elements": elements,
    }

    print(
        f"幕{args.scene}: {scene['sceneDurationMs']/1000:.1f}s, {len(scene_cues)} 条字幕 "
        f"-> {len(elements)} 个元素",
        file=sys.stderr,
    )
    for element in elements:
        print(
            f"  {element['sequence']}. {element['label']}  "
            f"{element['reveal']['startMs']/1000:6.1f}-"
            f"{(element['reveal']['startMs'] + element['reveal']['durationMs'])/1000:6.1f}s  "
            f"{element['subtitle'][:36]}",
            file=sys.stderr,
        )
    print(
        "  [注意] region 是等分占位值，必须在预览台里拖到实际主体上；"
        "时间轴来自字幕 cue，可直接使用。",
        file=sys.stderr,
    )

    text = json.dumps(annotation, ensure_ascii=False, indent=2)
    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n", encoding="utf-8")
        print(f"\nOUTPUT={out.resolve()}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
