---
name: sfx
description: Including sound effects
metadata:
  tags: sfx, sound, effect, audio
---

To include a sound effect, use the `<Audio>` tag with `staticFile()`:

```tsx
import { Audio, staticFile } from "remotion";
import { Sequence } from "remotion";

<Sequence from={frame} durationInFrames={24} layout="none" premountFor={30}>
  <Audio src={staticFile("sfx/whoosh.wav")} volume={0.35} />
</Sequence>
```

The following sound effects are pre-staged in `public/sfx/` (check `task.json.sfx.files` for the actual list):

| File | Category | Use case |
|---|---|---|
| whoosh.wav | transition | Scene transitions |
| swoosh-soft.wav | transition | Soft scene transitions |
| page-turn.wav | transition | Page/section turns |
| whip.wav | entrance | Fast element entry |
| pop.wav | entrance | Text/card pop-in |
| ding.wav | emphasis | Key point highlight |
| bell.wav | emphasis | Notification/chime |
| riser.wav | emphasis | Rising tension before reveal |
| impact.wav | emphasis | Heavy landing/impact |
| switch.wav | ui | Toggle/interface switch |
| click.wav | ui | Click confirmation |
| typing.wav | text | Typing animation |

Rules:
- Every sound effect must correspond to a visible motion event.
- 1–2 effects per scene; scene transitions always get a transition sound.
- Adjacent scenes should not repeat the same effect for the same category.
- Volume 0.3–0.4; never stack multiple effects on the same frame.
- If `task.json.sfx.availableCount` is 0, do not invent sound effects and do not import external audio.
