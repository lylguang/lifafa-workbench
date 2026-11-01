// 入场分层与场景过渡的基元。复制进 src/CreativeVideo.tsx 使用（依赖已在 remotion 里，
// 不需要装新包）。
//
// 为什么需要这两个组件（2026-11-01 实测）：
//   一条 233 秒 / 25 幕的成片里，spring 只出现 2 种配置，场景之间 0 处转场——
//   每幕都是「整块内容从 0 不透明度淡入」，抽帧在 15.15 秒拍到三张卡片同时只有
//   30% 不透明度。观众感知就是「一页一页翻」，这正是审片反复说的 PPT 感。
//   问题不在动效数量（interpolate 78 处、Easing 84 处），而在动效的**层次**和
//   场景之间的**衔接**。

import React from "react";
import { AbsoluteFill, Audio, Easing, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

/* ─────────────────────────────────────────────────────────────────────────
   1. Stagger —— 入场分层
   ───────────────────────────────────────────────────────────────────────── */

// 三档弹簧手感。同一屏最多用两档：全部元素共用一个 delay、一种手感，画面会
// 像一次性贴上去；反过来每元素一种手感，又会显得松散、没有主次。
export const SPRING = {
  // 主体落位：无过冲，稳。用于容器、大标题、图表主体。
  enter: { damping: 200, stiffness: 120, mass: 0.55 },
  // 强调回弹：轻过冲，有精神。用于结论、关键词、被强调的数字。
  pop: { damping: 18, stiffness: 170, mass: 0.6 },
  // 次级微回弹：几乎看不出弹，但有生命感。用于标注、脚注、辅助线。
  settle: { damping: 30, stiffness: 140, mass: 0.7 },
} as const;

export const Stagger: React.FC<{
  index: number;                                  // 第几个入场（从 0 开始）
  base?: number;                                  // 这一档的起始帧偏移，默认 0
  step?: number;                                  // 每个元素错开多少帧，默认 3
  variant?: keyof typeof SPRING;                  // 弹簧手感，默认 enter
  distance?: number;                              // 位移距离 px，默认 16
  axis?: "y" | "x";                               // 从下往上 / 从左往右，默认 y
  children: React.ReactNode;
}> = ({ index, base = 0, step = 3, variant = "enter", distance = 16, axis = "y", children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const delay = base + index * step;
  const s = spring({ frame: frame - delay, fps, config: SPRING[variant] });
  const q = Math.max(0, Math.min(1, s));
  const shift = (1 - q) * distance;
  return (
    <div
      style={{
        opacity: q,
        transform: axis === "y" ? `translateY(${shift}px)` : `translateX(${shift}px)`,
      }}
    >
      {children}
    </div>
  );
};

/* ─────────────────────────────────────────────────────────────────────────
   2. SceneBridge —— 场景过渡
   ───────────────────────────────────────────────────────────────────────── */

// 用法（关键）：相邻两幕的 <Sequence> 起始帧要**重叠 overlap 帧**，这样才是真正的
// 交叉过渡，而不是「先淡出到背景、再淡入」的闪白。
//
//   const OVERLAP = 10;
//   <Sequence from={F(SCENES[0].start)} durationInFrames={F(SCENES[0].end - SCENES[0].start) + OVERLAP}>
//     <SceneBridge from={F(SCENES[0].start)} durationInFrames={F(SCENES[0].end - SCENES[0].start) + OVERLAP}>
//       <Scene0 />
//     </SceneBridge>
//   </Sequence>
//   <Sequence from={F(SCENES[1].start) - OVERLAP} durationInFrames={F(SCENES[1].end - SCENES[1].start) + OVERLAP}>
//     <SceneBridge from={F(SCENES[1].start) - OVERLAP} durationInFrames={F(SCENES[1].end - SCENES[1].start) + OVERLAP} direction={1}>
//       <Scene1 />
//     </SceneBridge>
//   </Sequence>
//
// SCENES 表本身照旧写真实起止秒数（预检靠它对齐字幕），重叠只发生在渲染层。
//
// direction：+1 新幕从右侧推入，-1 从左侧，0 纯溶解。相邻两幕交替使用，
// 连续同向推入会像幻灯片翻页。
export const SceneBridge: React.FC<{
  from: number;                                   // 本幕在整片时间轴上的起始帧（含重叠提前量）
  durationInFrames: number;
  overlap?: number;                               // 重叠帧数，默认 10（24fps 下约 0.4 秒）
  direction?: -1 | 0 | 1;
  travel?: number;                                // 推入位移 px，默认 48
  children: React.ReactNode;
}> = ({ from, durationInFrames, overlap = 10, direction = 0, travel = 48, children }) => {
  const frame = useCurrentFrame();
  const local = frame - from;
  // 进场：柔和收尾（快起慢停），避免机械的线性淡入。
  const enter = interpolate(local, [0, overlap], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.33, 1, 0.68, 1),
  });
  // 出场：让位给下一幕，略快于进场，衔接才不拖。
  const exit = interpolate(local, [durationInFrames - overlap, durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.32, 0, 0.67, 0),
  });
  const opacity = Math.min(enter, exit);
  const push = (1 - enter) * travel * direction - (1 - exit) * travel * 0.35 * direction;
  // 极轻的纵向落位，让「换页」有重力感而不是平移贴图。
  const lift = (1 - enter) * 12;
  return (
    <AbsoluteFill style={{ opacity, transform: `translate(${push}px, ${lift}px)` }}>
      {children}
    </AbsoluteFill>
  );
};

/* ─────────────────────────────────────────────────────────────────────────
   3. 音效触发（与画面同帧）
   ───────────────────────────────────────────────────────────────────────── */

// public/sfx/ 里有 10 枚本地合成音效（whoosh/pop/ding/riser/impact/tick/
// swoosh-up/paper/blip/swell）。必须用 <Sequence layout="none"> 包住 <Audio>，
// 直接把 <Audio> 塞进被 <Sequence> 包裹的组件里会丢时序。

export const Sfx: React.FC<{
  at: number;                                     // 触发帧
  kind: "whoosh" | "pop" | "ding" | "riser" | "impact" | "tick" | "swoosh-up" | "paper" | "blip" | "swell";
  volume?: number;                                // 默认 0.34；tick/blip 建议 0.06–0.15
}> = ({ at, kind, volume = 0.34 }) => (
  <Sequence from={Math.max(0, Math.round(at))} durationInFrames={24} layout="none" premountFor={30}>
    <Audio src={staticFile(`sfx/${kind}.wav`)} volume={volume} />
  </Sequence>
);
