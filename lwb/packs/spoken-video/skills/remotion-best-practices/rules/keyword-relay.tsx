import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";

/**
 * KeywordRelay — 关键词接力强调
 *
 * 一句话里的 1–3 个关键词依次接管注意力：当前词变为强调色并展开下划线，
 * 随后把强调接力给下一个词，前一个词恢复原色、下划线淡出。
 *
 * 作用在**主画面**的关键词（标题、结论句、论点标签）上，不要用在受保护的字幕上。
 *
 * 时序来自 wise-motion 的 `word-focus`（Apache-2.0），去掉其固定三词与 16 字限制、
 * 自带背景与 640x360 画板，改为跟随当前场景的排版与配色。
 *
 * 已用 Remotion 4.0.522 实渲验证三轮接力：帧 30 / 55 / 105 依次点亮第 1 / 2 / 3 个词，
 * 每次恰好只有一个词被强调。
 */
export const KeywordRelay: React.FC<{
  /** 整句文本，关键词用 ||| 分隔，例如 "真正的瓶颈|||不是模型|||而是数据" */
  text: string;
  /** 强调色，默认取主题强调色 */
  color?: string;
  /** 未强调部分的颜色，默认继承外层 */
  baseColor?: string;
  /** 下划线颜色，默认与 color 相同 */
  underlineColor?: string;
  fontSize?: number;
  fontWeight?: number;
  /** 词间距（px） */
  gap?: number;
  style?: React.CSSProperties;
}> = ({
  text,
  color = "#2F5BD8",
  baseColor,
  underlineColor,
  fontSize = 48,
  fontWeight = 600,
  gap = 2,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const words = text.split("|||");
  const count = words.length;

  // 单词被强调的时长；词越多每词越短，但保持可读
  const hold = Math.max(0.9, 2.0 - count * 0.25);
  // 接力间隔：淡出与下一词的淡入重叠 0.12 秒，交接时不会出现「所有词都不强调」的空窗
  const step = (hold + 0.12) * fps;
  const now = frame / fps;

  return (
    <span style={{ fontSize, fontWeight, lineHeight: 1.35, ...style }}>
      {words.map((word, index) => {
        // start 必须先从帧换算成秒，才能与 now 相减。写成 index * step（帧）
        // 会让第一个词之后 strength 恒为 0，整句退回普通颜色——静态看不出，必须渲帧。
        const start = (index * step) / fps;
        const inProgress = Math.min(1, Math.max(0, (now - start) / 0.22));
        const outProgress = Math.min(1, Math.max(0, (now - start - hold) / 0.2));
        const strength = inProgress * (1 - outProgress);
        const active = strength > 0.01;

        return (
          <React.Fragment key={`${word}-${index}`}>
            {index > 0 ? <span style={{ marginRight: gap }} /> : null}
            <span
              style={{
                position: "relative",
                display: "inline-block",
                color: active ? color : baseColor,
              }}
            >
              {word}
              {active ? (
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: -6,
                    height: 4,
                    borderRadius: 2,
                    background: underlineColor ?? color,
                    // 下划线从左向右展开，与词的变色同步
                    transform: `scaleX(${strength})`,
                    transformOrigin: "left center",
                  }}
                />
              ) : null}
            </span>
          </React.Fragment>
        );
      })}
    </span>
  );
};