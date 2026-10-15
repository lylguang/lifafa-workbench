---
name: motion-effects
description: Controlled use of the Wise Motion catalog (Apache-2.0) as a motion vocabulary for narration content-video scenes, with strength quotas, allow-lists, and the three overlay-safe effects that may be composited onto our own stages.
metadata:
  tags: motion, wise-motion, effects, overlay, pacing, restraint
---

# Motion Effects Vocabulary (Wise Motion)

Source catalog: `https://github.com/WiseWong6/wise-motion` (Apache-2.0). The catalog holds 429 entries: 295 single actions, 93 illustrations, 41 composed segments. It is a **vocabulary of ready-made motion**, not a template to follow end to end.

This rule governs how much of that vocabulary a narration video may use, and which entries may be composited onto our own stages without forking their drawing code.

## Catalog Retrieval Is Keyword Matching, Not Understanding

`match.mjs` ranks candidates by a **regular-expression table** over effect names, purposes, aliases, and behaviors. It does not read intent.

Verified behavior: querying `镜头缓慢推近，虚化衬底，图片轻微移动` returned `zoom-transition` and explicitly reported `虚化衬底；图片轻微移动` as **not covered**. A query with only `镜头缓慢推近` returns the same entry.

Therefore:

- Never treat a returned candidate as satisfying the full request. Always read the `未确认覆盖` / uncovered-requirements lines.
- Coverage claims come from the effect's own `retain` (需要保留) and `avoid` (明确排除) fields, not from the query.
- Retrieval cannot invent a missing behavior. When coverage is partial, either compose the remainder locally or design around the gap.

## The Catalog Is Not Designed For Narration

The catalog is authored for a viewer who is **already watching a dedicated piece**: single actions are short (most 1200–1800ms), each declares a `duration_ms` and a `tempo_note`, and several entries state their purpose as holding attention in a single moment.

Narration viewers are skimming, and attention is low and wavering. Applying the catalog at face value causes two failures:

1. **Overload.** Cycling a different effect per beat produces a video where nothing lands. Up to 15 high-intensity events in 30 seconds leaves the viewer with no rest point.
2. **Narrative collision.** Slam-word entries, particles, and flash transitions are authored to seize attention and will fight the voiceover. This is the inverse of the earlier bug where sound effects sat 12–21dB under narration and vanished — here the visuals overwrite the narration instead.

The catalog itself leaves the exit open: `method.md` states *no bouncing or rotation by default* and *when no suitable candidate exists, report the gap and let the caller create*. Treat it as optional material, never as a required recipe.

## Strength Quotas (MANDATORY)

Classify every candidate before use.

| Tier | Categories | Quota |
| --- | --- | --- |
| **Low** | `writing`, `data`, `attention`, `entrance`, `layout`, `connection`, `space`, `scanning`, `response` | Uncapped, still subject to the spacing rules |
| **High** | `particles`, `lighting`, `shape`, `environment`, `continuous` | **≤ 15% of total video duration**, and never inside the first 2 seconds |
| **Excluded** | `compositions` | Only for title/opening and end-card moments, never for an 8–12 second knowledge beat |

Additional hard limits:

- **Adjacent beats may not use the same category.** This is the single highest-value rule; category variety is what makes a sequence read as designed rather than assembled.
- **At most one emphasis event per beat.** A beat explains one idea; two competing effects cancel each other.
- **Subtitle track and emphasis track are separate.** Subtitles use only the lowest-intensity tier. Never animate the subtitle body while an emphasis effect runs on the stage above it.
- **Every effect must land on a narrated idea.** An effect that finishes between two spoken sentences is decoration and must be removed.

Prefer slow camera and continuity for the majority of the video. Our own `content-video` skill already requires *visual continuity over repeated full-screen fade-in resets* — the catalog supplies options, it does not override that.

## Composition Segments Are For Titles And End Cards

The 41 composed segments carry their own built-in music and sound effects. When using one:

- Only at the opening title or closing end card.
- Pass `includeAudio={false}` whenever our BGM or narration is present, to avoid double-stacking audio.
- Treat them as brand expression, never as the visual body of an explanatory beat.

## Overlay-Safe Effects: The Only Three That May Be Stacked

`registry.json` marks almost every entry without a `layer` value; exactly **three** entries carry `layer: "overlay-ok"`, and they are also the only ones with `content_slots`:

| effectId | Purpose | Category | Duration | Content slots |
| --- | --- | --- | --- | --- |
| `count-up` | Readout incrementing to a real figure | `data` | 1800ms | `value`, `from`, `decimals`, `prefix`, `suffix`, `caption`, `format` |
| `type-reveal` | Text revealed character by character | `writing` | 1200ms | `text` |
| `word-focus` | Words highlighted in sequence with an underline | `attention` | 2400ms | `words` (exactly 3 items, ≤16 chars each) |

These three may be composited over our own stage without forking their drawing code, and they are the **preferred** way to borrow from the catalog.

### Constraints on the three

- `transparent={true}` is supported for exactly these three. Passing it disables the page shell's background, vignette, and grain. Passing it does **not** bypass the transparency audit — stale audit records are rejected. If a transparent render fails the audit, render it on its own 640×360 canvas and crop, rather than dropping the effect.
- Logical canvas is **640×360**. Changing `width`/`height` scales proportionally only. Do not stretch to fill 1920×1080 — design a 640×360 overlay and scale it.
- The catalog targets **Remotion 4.0.532 / React 19.3.0**; this repo pins **4.0.522 / React 19.2.3**. The adapter converts frame numbers to the catalog's millisecond clock using `fps`. Before adopting, confirm the component renders on our pinned versions; if it does not, port the effect's timing formulas into `useCurrentFrame()` instead of upgrading the repo's Remotion version for one effect.
- `word-focus` requires **exactly three** words, 3–16 characters each. For one or two keywords, implement the emphasis directly instead of forcing this entry.

## Data Honesty (NON-NEGOTIABLE)

Our `content-video` skill forbids inventing measurements. The catalog's `data` category is the most tempting place to break that rule, because entries like `benchmark-columns`, `ruler-ticks`, and `count-down dial` look technical while carrying demo numbers.

- Use any `data` entry **only** when the manuscript supplies the actual value, unit, and comparison context.
- Never take a number from a catalog demo and present it as a finding.
- With no supplied data, use a qualitative state, boundary, or condition instead — exactly as `content-video` requires.
- Re-substitute the real value through `content_slots`; never leave a demo default visible.

## Beat-To-Effect Mapping

Map a beat to a motion by its meaning, then pick from the allow-list. Never pick an effect first and find a reason for the beat afterwards.

| Beat | Effect | Notes |
| --- | --- | --- |
| Hook / key question | `word-focus` or `type-reveal` | Keep it brief, then move to a richer stage visual |
| Mechanism explained | `count-up` or a local flowchart | Prefer a process or causal visual over text |
| Numbers changing | `count-up` with supplied values | Real value only; check the honesty rule above |
| Comparison / trade-off | `motion-compare`, `reduction-dimension` | Quantitative only with supplied data |
| Process steps | `bar-growth`, `timeline-progress` | Reveal progressively with the narration |
| Capability surface | `sector-appear`, `mindmap-grow` | Supported vs conditional states |
| Conclusion / takeaway | `dim-focus`, `color-evolve` | Return to the core object; one concise takeaway |
| Scene boundary | `wipe`, `shared-object`, `zoom-transition` | Prefer `shared-object`; it keeps object identity |

`shared-object` is the preferred transition because it carries one object across the cut, which keeps a narration video feeling continuous instead of episodic.

## What Not To Lift

These are strong entries, and they are still wrong for narration:

- `word-slam`, `particle-word`, `text-decode`, `type-burst-settle` — high-impact openers; at most one per video, never under narration.
- `rapid-cut`, `glitch-band-transition`, `radial-flash-transition` — flash-cut transitions fight the reading rhythm of a subtitle video.
- `seamless-scroll`, `dual-scroll`, `landscape-boundary-carry` — looping or very long (37s) entries produce the persistent motion our own skill already rules out.
- The 30 `compositions` entries — authored as complete artworks; they are title and end-card material.

## Verification

Before accepting a motion choice:

1. Confirm coverage against the effect's `retain` / `avoid`, not the query.
2. Confirm the effect lands on a narrated idea, with its `duration_ms` inside the beat's speech window.
3. Confirm it does not overlap the subtitle safe area or the vertical interaction rail.
4. Confirm `transparent` audit passes if transparency is requested.
5. Render one still at the effect's midpoint and check the text remains readable at target viewing size.

Do not adopt the catalog wholesale. `remotion-best-practices` and the repo's own composition rules remain authoritative; this catalog extends them with concrete options, not replacements.