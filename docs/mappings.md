# Sound and haptic mappings

Every mapping the tools use, with its numbers and the reason for it. Values marked *provisional*
change after eyes-closed testing. This file becomes a table in the paper.

## Controller basics (phase 0)

The tap numbers come from the handoff (section 5). The reasons below are design intent, still to be
confirmed in eyes-closed testing.

| Item | Value | Reason |
|---|---|---|
| Tap: heavy (left) motor | 200 of 255 (range 180–220) | Strong enough to count through a grip; below the level that blurs into the next tap |
| Tap: light (right) motor | 90 of 255 | Adds a sharper edge to each tap |
| Tap length | 70 ms (range 60–80 ms) | Shortest pulse the motors reliably spin up for |
| Gap between taps | 120 ms default (range 80–250 ms) | Below about 80 ms, taps fuse into one buzz; the upper end leaves room to encode J (phase 2) |
| Complex pattern (flutter) | 30–55 ms pulses with 30–55 ms gaps, irregular, 400 ms in total | Too fast and uneven to count, so it reads as "complex", not as a number |
| Connected signal | 2 taps, 60 ms on, 90 ms off, 180 of 255 | Confirms connection without sound |
| Edge signal | 150 ms buzz, 120 of 255 heavy, 200 of 255 light | End of an axis; lighter and buzzier than a tap so it is not counted |
| Error signal | 300 ms buzz, 230 of 255 on both motors | Clearly different from any count |
| Continuous rumble updates | at most 25 per second (every 40 ms) | Faster updates queue up and add lag |
| Trigger resistance | 10 zones across the pull, each level 0 (loose) to 8 (stiffest) | The controller's own zone effect (effect 0x21) |
| Trigger keep-alive | effect re-sent every 2 s | The controller drops the effect after some events; re-sending keeps it steady |
| Reduced haptics | all rumble values × 0.5; trigger levels halved, rounded up | For users who find full strength uncomfortable |

## Controller test page

| Control | Action |
|---|---|
| Square / Triangle / Circle / Cross | 1 / 2 / 3 / 4 taps |
| Options | Complex pattern |
| L1 / R1 | Previous / next resistance pattern |
| Keys 1–4, F, R, Escape | 1–4 taps, complex pattern, read state, stop vibration |

Resistance patterns (level per zone, start of pull → end):

| Pattern | Zones |
|---|---|
| Even | 4 4 4 4 4 4 4 4 4 4 |
| Ramp | 0 1 2 3 4 5 6 7 8 8 |
| Wall | 0 0 0 0 0 0 0 8 8 8 |
| Bumps | 0 6 0 6 0 6 0 6 0 6 |

## Planned (¹H NMR, next), *provisional*

| Item | Value |
|---|---|
| Pitch | 0 ppm → 220 Hz, 10 ppm → 880 Hz, exponential (two octaves) |
| Integration | carried by speech ("3 hydrogens"), the reliable channel |
| Loudness | integrated area of the signal under the cursor, not peak height; a rough cue only |
| Multiplicity | 1–4 taps for a singlet to a quartet; the complex pattern for anything else (dd, m …), with the spoken description |
| Spectrum summary | spoken: number of signals, then each signal from high to low shift |
| Tap gap vs. J | larger J → wider gap, within 80–250 ms |
| R2 resistance | stiffens in proportion to the area of the signal under the cursor |
