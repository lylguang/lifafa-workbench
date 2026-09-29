---
name: text-animations
description: Typography and text animation patterns for Remotion.
metadata:
  tags: typography, text, typewriter, highlighter ken
---

## Text animations

Based on `useCurrentFrame()`, reduce the string character by character to create a typewriter effect.

## Typewriter Effect

Derive the visible character count from the current frame and use `text.slice(0, visibleCharacters)`. A blinking cursor and pauses should also be derived from frame values.

Always use string slicing for typewriter effects. Never use per-character opacity.

## Word Highlighting

Animate a background highlight behind the selected word using `useCurrentFrame()` and `interpolate()`, keeping the text visible throughout.
