import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";

/**
 * StageTypeOn — 短语逐字显现
 *
 * 幕标题或结论句按字写出，末字落定后整句保持可读。
 * 适合场景开头的一句话或收束句，不要用在受保护的字幕上。
 *
 * 时序来自 wise-motion 的 `type-reveal`（Apache-2.0），去掉其光标闪烁、
 * 固定字体与 640×360 画板，改为跟随当前场景排版。
 */
export const StageTypeOn: React.FC<{
  /** 要写出的整句 */
  text: string;
  color?: string;
  fontSize?: number;
  fontWeight?: number;
  /** 每字间隔（秒），默认 0.055 */
  speed?: number;
  /** 是否显示写入光标，默认 false */
  caret?: boolean;
  style?: React.CSSProperties;
}> = ({
  text,
  color = "#141C2B",
  fontSize = 56,
  fontWeight = 700,
  speed = 0.055,
  caret = false,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const chars = Array.from(text);
  const stepFrames = Math.max(1, Math.round(speed * fps));

  // 已写出的字数；最后一个字在跨过它的起始帧后出现
  const written = Math.min(chars.length, Math.floor(frame / stepFrames) + 1);
  const visible = chars.slice(0, written).join("");

  // 全部写完后光标淡出
  const done = written >= chars.length;
  const caretOpacity = caret && !done ? 1 : 0;

  return (
    <span style={{ color, fontSize, fontWeight, lineHeight: 1.35, ...style }}>
      {visible}
      {caret ? (
        <span style={{ opacity: caretOpacity, marginLeft: 4, fontWeight: 400 }}>▍</span>
      ) : null}
    </span>
  );
};