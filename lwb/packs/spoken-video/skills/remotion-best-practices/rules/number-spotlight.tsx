import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";

/**
 * NumberSpotlight — 真实数字缓动递增
 *
 * 稿件里的真实数值从 0（或 from）缓动到目标值，配单位与可选说明，
 * 让「数据驱动」这一幕有一个明确的视觉焦点。
 *
 * ⚠️ 只能用于稿件或素材中确实存在的数值。没有真实数据时不要用本组件，
 * 改用定性状态、边界或条件表达——content-video 规则禁止为画面编造测量值。
 *
 * 时序来自 wise-motion 的 `count-up`（Apache-2.0），去掉其 640×360 画板、
 * 自带背景与固定演示文案，改为跟随当前场景排版。
 */
export const NumberSpotlight: React.FC<{
  /** 目标值。必须是稿件里的真实数字。 */
  value: number;
  /** 起始值，默认 0 */
  from?: number;
  /** 小数位，默认 0 */
  decimals?: number;
  /** 前缀，例如 "¥" */
  prefix?: string;
  /** 后缀，例如 "%" 或 " 万" */
  suffix?: string;
  /** 千分位分隔，默认 false */
  thousands?: boolean;
  /** 紧凑格式（1.2万 / 3.4M），默认 false */
  compact?: boolean;
  /** 数字颜色，默认取主题强调色 */
  color?: string;
  /** 说明文字（必须来自稿件，不得自造结论） */
  caption?: string;
  captionColor?: string;
  fontSize?: number;
  captionSize?: number;
  style?: React.CSSProperties;
}> = ({
  value,
  from = 0,
  decimals = 0,
  prefix = "",
  suffix = "",
  thousands = false,
  compact = false,
  color = "#2F5BD8",
  caption,
  captionColor = "#6B7789",
  fontSize = 120,
  captionSize = 34,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const format = (n: number) => {
    if (compact) {
      const units: Array<[number, string]> = [
        [1e8, "亿"],
        [1e4, "万"],
      ];
      for (const [scale, unit] of units) {
        if (Math.abs(n) >= scale) return (n / scale).toFixed(decimals) + unit;
      }
      return n.toFixed(decimals);
    }
    if (thousands) {
      return n.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    }
    return decimals > 0 ? n.toFixed(decimals) : String(Math.round(n));
  };

  // 1.4 秒缓动到位，outCubic 收尾——末段慢下来让数字停稳可读
  const progress = Math.min(1, Math.max(0, frame / (1.4 * fps)));
  const eased = 1 - Math.pow(1 - progress, 3);
  const shown = from + (value - from) * eased;

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 12, ...style }}>
      <span style={{ fontSize, fontWeight: 700, color, lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }}>
        {prefix}
        {format(shown)}
        {suffix}
      </span>
      {caption ? (
        <span style={{ fontSize: captionSize, color: captionColor, textAlign: "center", lineHeight: 1.5 }}>
          {caption}
        </span>
      ) : null}
    </span>
  );
};