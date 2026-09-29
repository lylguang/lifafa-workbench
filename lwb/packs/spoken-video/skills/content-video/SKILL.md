---
name: content-video
description: Use when producing or reviewing profile-configured content-video outputs, especially scripts, TTS subtitles, Remotion compositions, media QC, OSS preview links, and publish-approval gates. Always read platform, audience, content lane, and video defaults from the active Agent profile/task.
metadata:
  tags: agent-profile, content-video, remotion, tts, subtitles, qc, oss
---

# Profile-Configured Content Video

Use this skill together with `remotion-best-practices` whenever creating or changing the profile-configured content-video pipeline in the current repository workspace. The active Agent profile is the source of truth for platform, audience, topic lanes, voice, dimensions, and publish gates.

## Fixed Context

- Target format: narration content configured by the current Agent profile/task. Default production output is wide screen 1920x1080, 30fps unless the profile or task overrides it; vertical 1080x1920 is used only when explicitly requested.
- Target length: 3 to 10 minutes for production videos. Shorter renders are allowed only as MVP samples or technical tests.
- Review path: upload audio/video artifacts to OSS and send links through the configured operator channel. The current default channel is WeChat/WeCom. Do not rely on raw chat media file transfer.
- Publishing path: do not publish directly to the configured platform. Only enqueue to the publish manager after explicit final approval.

## Script And Scene Rules

- A video is not just text on screen. Convert scripts into timed visual beats: hook, core point, development, example or proof, boundary note, conclusion.
- Use the current narration segment to drive visual emphasis, but do not duplicate full narration text in the main visual area.
- Prefer simple supporting visuals, kinetic keywords, diagrams when useful, progress markers, and chapter cues over large paragraph blocks.
- Keep on-screen copy short. Main stage text should usually be a keyword or short phrase, not a full subtitle.

### Visual Richness Requirements (MANDATORY)

Choose visual forms that explain the manuscript. Diversity should follow changes in meaning, not a quota of visual types, charts, SVG animations, or scenes per beat.

- Give each beat a clear visual focus: an object, meaningful relationship, process, comparison, state change, or supported data view. Cards may group information but should not replace the explanation.
- Use coherent shapes, line weights, and colors. Prefer simple topic-specific illustrations or simulated operations to repeated card grids and Emoji-plus-text layouts; Emoji may be occasional supporting accents.
- Quantitative charts, radar axes, scores, percentages, trends, and value-bearing progress bars require explicit values and comparison context in the supplied manuscript or materials. Never invent measurements to decorate a qualitative claim. Use qualitative states, boundaries, or conditions when no data is supplied.
- Keep simulated interfaces and illustrative scenes recognizable as illustrations, not authentic screenshots, measured results, or new factual evidence.
- Introduce a concrete problem or contrast early. Carry recognizable objects through adjacent ideas and reuse a core visual to make the conclusion memorable.

**Beat-to-visual mapping examples:**
- "Mechanism explained" -> flowchart / cycle diagram / causal chain
- "Comparison / trade-off" -> side-by-side states / conditional paths / overlapping sets; use quantitative charts only with supplied data
- "Numbers changing" -> counter / chart using supplied values, units, and context
- "Process steps" -> timeline / numbered steps with icons
- "Capability surface / feature list" -> capability boundaries / supported-versus-conditional states
- "Hook / key question" -> text card only when brief, then move to a richer visual
- "Conclusion / takeaway" -> return to the core object or relationship with one concise takeaway

For abstract content, show a meaningful relationship or state change rather than adding unrelated decorative motion.

### Composition, Typography, And Semantic Motion

- Enlarge the main objects and essential labels enough to read at the target viewing size. Use whitespace to clarify hierarchy; do not leave tiny diagrams and labels stranded in a mostly empty frame. Reveal complex information progressively instead of shrinking text.
- Explicitly set a consistent Chinese sans-serif font family using locally available fonts. At a 1080px short edge, typical starting sizes are 56–80px for titles, 36–48px for key labels and takeaways, and at least about 28px for necessary supporting text. Adapt to aspect ratio, available width, and final displayed scale; these are design guides, not mechanical gates. Preserve orchestrator-owned captions.
- Time meaningful changes to the supplied narration/SRT: move the relevant object, advance a process, change a state, or shift emphasis when the corresponding idea is spoken. Avoid completing all visual development at the start of a long passage. Reuse objects across the passage rather than adding scenes solely to increase activity.
- Allow reading pauses and dwell on important numbers and conclusions. Persistent floating, spinning, flashing, and fixed-interval cuts do not substitute for explanation. Prefer visual continuity over repeated full-screen fade-in resets.

### Autonomous Asset-Free Direction (MANDATORY)

- Do not depend on a human to provide footage, screenshots, product images, or a manually authored visual brief. The creator Agent must choose the episode's visual direction from the manuscript and the supplied recent-direction context.
- The direction record is an internal, per-run creative decision, not a fixed storyboard or reusable scene template. It may describe a style family, palette approach, metaphor, contrast strategy, and semantic beat intents, but the Agent retains scene-level implementation freedom.
- Use asset-free visual substitutes when external media is unavailable: procedural diagrams, simulated UI, illustrative object scenes, state comparisons, animated data, SVG systems, and locally available generated imagery. Never scrape unlicensed web media or copyrighted MV footage just to fill the frame.
- Treat recent successful directions as anti-repetition context. Avoid reusing the same combination of dark dashboard treatment, palette, layout, and metaphor unless the current topic genuinely requires it.
- Make readability a production constraint, not an afterthought. Keep text/foreground contrast clear at target viewing size; do not default to dim backgrounds that make captions, labels, or diagrams blend into the frame.
- For a major statistic, conclusion, risk boundary, or user action, reserve a distinct visual emphasis or recall device. For a mechanism, show a process/state/causal visual rather than relying on explanatory text alone.

## Chinese Subtitle Rules

- Treat Chinese SRT entries as segment-level captions unless the source is explicitly word-level.
- Do not pass normal Chinese SRT segments into `createTikTokStyleCaptions()` with a large `combineTokensWithinMilliseconds` value; it can merge the whole script into one page.
- Render subtitles directly from parsed SRT timing, one active segment at a time.
- Keep subtitle text to at most two lines. The 28-Chinese-character single-line guideline applies to default wide-screen renders; for vertical renders, use the available subtitle-band width and preserve the complete segment across up to two lines.
- Keep subtitle font readable on mobile, but never let it fill the screen.
- For default 1920x1080 production renders, subtitle text should target 46px, with 44-48px acceptable. Avoid 37-42px subtitles because they read too small in review previews; use compact padding and balanced two-line wrapping before reducing the font size.
- For vertical 1080x1920 renders, size deterministic subtitles from the short edge and the usable subtitle-band width, not the 1920px height. Do not place visible subtitles at the physical bottom. Use the platform safe-area contract from `task.json.requirements.platform_safe_area` when present; the complete subtitle box must remain inside its `y_min..y_max` band while reserving the bottom ~420px for mobile app title/description/music controls.
- For vertical renders, keep essential labels, faces, buttons, and chart values out of the right-side interaction rail. Decorative background may extend there, but critical information should not.
- Subtitle rendering must be time-bounded by each SRT entry's `startMs` and `endMs`.
- Render restrained keyword emphasis inside active subtitles: highlight 1-3 existing keywords with stronger but crisp font treatment, without rewriting subtitle text, adding extra rows, leaving the subtitle safe area, or using glow/blur/halo effects.

## Remotion Implementation Rules

- Use `staticFile()` for staged audio, subtitle, and metadata assets.
- Use `<Audio>` from `@remotion/media` for narration.
- Use `parseSrt()` from `@remotion/captions` for SRT parsing.
- Use `Sequence` for scene timing and bounded display.
- Use frame-based animation with `useCurrentFrame()`, `interpolate()`, and `spring()`. Do not use CSS animations or transitions.
- The composition duration must match the probed audio duration plus only a small tail buffer.

## QC Requirements

Every generated video should have a machine-readable QC report before OSS preview:

- `ffprobe` video width, height, fps, duration, frame count.
- Audio/video duration comparison.
- Subtitle segment count.
- Maximum subtitle text length.
- Contact sheet or sampled frames for visual inspection.
- Explicit `passed` flag. Fail if the video is missing, duration is invalid, dimensions do not match the task's expected width/height, subtitle count is zero, or any single subtitle segment is too long for display.

If QC fails, do not send the preview as a candidate for approval.
