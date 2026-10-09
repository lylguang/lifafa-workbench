import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 中文字体候选，按平台顺序探测。原先写死 C:/Windows/Fonts/msyh.ttc，
# 在 macOS / Linux 上必然抛 OSError，导致工作流第 4 步（区域编号检查图）
# 在非 Windows 机器上完全走不通。
_FONT_CANDIDATES = [
    # Windows
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    # macOS
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    # Linux
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
]


def _load_font(size: int):
    """按候选列表找第一个可用的中文字体；都没有则退回 Pillow 内置字体。"""
    for path in _FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def main(image_path: str, annotation_path: str, output_path: str) -> None:
    image = Image.open(image_path).convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    small_font = _load_font(18)
    colors = [(38, 103, 255, 225), (255, 105, 92, 225), (41, 167, 102, 225), (181, 100, 255, 225)]

    data = json.loads(Path(annotation_path).read_text(encoding="utf-8"))
    for index, element in enumerate(data["elements"], start=1):
        region = element["region"]
        x, y = region["x"], region["y"]
        right, bottom = x + region["width"], y + region["height"]
        color = colors[(index - 1) % len(colors)]
        fill = (*color[:3], 24)
        draw.rounded_rectangle((x, y, right, bottom), radius=12, outline=color, width=4, fill=fill)
        draw.ellipse((x + 8, y + 8, x + 44, y + 44), fill=color)
        draw.text((x + 19, y + 8), str(index), anchor="ma", font=small_font, fill="white")

        # 标签胶囊按实际渲染宽度取尺寸：中英文字宽不同，原先的 len(label)*19
        # 估算会让较长的标签冲出白底（如 top_to_bottom）。
        label = f"{index}. {element['label']}  {element['reveal']['direction']}"
        text_w = draw.textlength(label, font=small_font)
        cap_right = min(right - 8, x + 60 + text_w + 8)
        draw.rounded_rectangle((x + 52, y + 8, cap_right, y + 46), radius=6, fill=(255, 255, 255, 225))
        draw.text((x + 60, y + 12), label, font=small_font, fill=color)

        start = tuple(element["handPath"]["start"])
        end = tuple(element["handPath"]["end"])
        draw.line((start, end), fill=color, width=4)
        draw.polygon((end, (end[0] - 13, end[1] - 7), (end[0] - 13, end[1] + 7)), fill=color)

    result = Image.alpha_composite(image, overlay).convert("RGB")
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path, quality=95)


if __name__ == "__main__":
    main(*sys.argv[1:4])
