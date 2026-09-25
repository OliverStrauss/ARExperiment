# sticky-wall — Beat UI spec

Implementation spec for turning sticky-wall from "balls bouncing off notes" into a
structured, in-time beat instrument. Written for Claude Code working in this repo.
Visual reference: the "sticky-wall Beat UI" design canvas (artboards **The wall**,
**Laptop monitor**, **Keyboard shortcuts**).

## 1. Principles

1. **The wall is the instrument.** Everything musical is decided by where real
   sticky notes are. The laptop only watches, plus Keep / Clear / Undo.
2. **Colour = pitch.** Unchanged from `js/colors.js` (purple C4, blue D4, green E4,
   yellow G4, orange A4, red C5).
3. **Drop distance = rhythm.** The farther a note sits below its rail note, the
   longer between hits.
4. **Balls move in one direction only.** A ball goes straight up and down its lane,
   never sideways and never into another lane.
5. **The loop is a result, not an editor.** The echo shows what the wall played.
   It never schedules notes itself, except for layers the user chose to keep.
6. **Projected UI is minimal and white-on-black.** Nothing is projected onto the
   notes themselves except the hit halo.

## 2. Concepts

### 2.1 Rail
- A horizontal band across the top of the projection, from `y = 0` to
  `railBottom` (default `0.15`, projector-normalized).
- Any tracked note whose centre is inside the rail is a **rail note**. Rail notes
  never make sound and are drawn in neutral grey on the monitor, whatever their colour.
- Each rail note opens one **lane**.

### 2.2 Lane
- `x` = rail note centre x. `width` = rail note width (clamped to at least 2× ball diameter).
- **Target** = the first non-rail note, going down from `railBottom`, whose polygon
  crosses the lane's centre line. If there's no target, the lane is idle (no balls move).
- Lower notes in the same lane are shadowed and never hit. The monitor shows them as "blocked".
- There's no limit on the number of lanes or notes.

### 2.3 Rhythm from distance
- `d` = target top edge y − `railBottom` (normalized).
- `unit` = normalized distance per 1/16 note (setting, default `0.10`).
- Raw length in 16ths: `n = d / unit`.
- **Snap on (default):** `n = max(1, round(n))`. **Snap off:** `n` stays fractional,
  which gives free, un-gridded rhythm.
- Time between hits for one ball: `P = n × sixteenth`, where `sixteenth = 60 / bpm / 4` s.
- The ball goes rail → target → rail in time `P`. So its speed is `2d / P`, and it
  scales with tempo automatically. **[ ]** changes `bpm`, and every lane speeds up or
  slows down together.
- Ruler labels drawn on the wall: 1/16, 1/8, 3/16, 1/4, 5/16, 3/8 at
  `railBottom + k × unit` (k = 1…6). Even k is major (brighter); odd k is minor.

### 2.4 Balls
- Each lane holds 1…`maxBallsPerLane` (default 4) balls. A new lane starts with 1.
- A ball is defined by its **phase** `φ` (seconds, 0 ≤ φ < P): the time it was
  dropped, snapped to the 1/16 grid when Snap is on.
- The ball's position is **analytic** (no matter.js):
  `u = ((now − t0 − φ) mod P) / P`; `y = railBottom + d × (1 − |1 − 2u|)`.
  The ball hits the target at `u = 0.5`.
- **B** adds a ball to the highlighted lane with `φ` = the current time.
  **⇧B** removes the most recently added one.
- Two balls dropped at different moments make syncopation. Example: lane 2 in the
  design is 1/4 with 2 balls at phases 0 and 3/16.

### 2.5 Instruments
- Each note carries an instrument. The default is `bell`, which is the existing `playTone` sound.
- Set: `bell, pluck, marimba, pad, bass, kick, tom`. All are Web Audio synths in
  `js/sound.js`, and all are pitched by the note's colour:
  | id | sketch |
  |---|---|
  | bell | existing triangle + octave |
  | pluck | Karplus-Strong, or saw → lowpass with a fast env |
  | marimba | sine + 4× partial, 0.4 s exp decay |
  | pad | 2 detuned saws, 80 ms attack, 1.2 s release, lowpass |
  | bass | sine one octave down + a little saturation |
  | kick | sine with pitch sweep 4× → 1× freq over 60 ms, 0.35 s decay |
  | tom | as kick, sweep 2× → 1×, 0.25 s decay |
- Instruments are stored by tracker note id (`Map<noteId, instrumentId>`). If the id
  disappears, the entry is forgotten.

### 2.6 Instrument ring
- Opens when the user clicks a note: a mouse click on the projector window, mapped to
  normalized coordinates, then hit-tested against note polygons.
- Drawn around the note (see the design):
  - 7 labels evenly spaced on a circle of radius 135 px (at a 1600×900 reference size; scale with the window).
  - The current choice sits at 12 o'clock in a white pill.
  - The other labels fade by distance: opacity 1, .75, .5, .3.
  - An inner countdown ring at radius 96 px.
  - A hint: "← → spin · ↵ or click to keep".
- **← →** rotate the ring, **↵** or a second click commits, **Esc** cancels.
  After 4 s idle it commits the current choice.
- While the ring is open, arrows belong to the ring (see §4).
- Rail notes can't be clicked.

### 2.7 Echo and Keep
- **Echo buffer:** every hit is recorded as `{t, pitch, instrument, velocity}` over the
  last `echoBars` bars (default 4, in 4/4). Positions are shown on the 1/16 grid.
- **Keep (K, or the monitor button):** snapshots the echo buffer into a **layer**, as a
  64-step pattern of `{step, pitch, instrument, velocity}`. Layers replay through the
  scheduler forever, whether or not their notes are still on the wall.
- **Clear (X):** removes all layers. **Undo (Z):** removes the most recent layer.
- **Display:** one row per pitch, highest pitch at the top. Kept hits are solid; live
  hits are faint, and those ahead of the playhead fainter still.

## 3. Architecture

**Decision: the beat engine lives in the control window.** That window already owns
the notes (from the tracker) and the AudioContext (the only window with user
activation). Sound is scheduled on `AudioContext.currentTime` for sample-accurate
timing. The projector renders the same state analytically from a shared clock, so no
physics runs for lanes.

```
control.html                                      projector.html
 tracker notes ─► LaneBuilder ─► lanes[] ─┐        ┌─► render lanes, balls (analytic),
                                          │ 'beat' │    rings, ruler, echo, toast
 keys / clicks ─► BeatEngine (clock,      ├───────►│
                  balls, scheduler,       │        └─◄ 'click' {x,y} (mouse on wall)
                  echo, layers) ──► sound │
```

New files:
- `js/lanes.js`: pure. `buildLanes(notes, settings) → lanes[]`. It covers rail
  detection, target selection, `d`, `n`, and shadowed notes. No DOM.
- `js/beat.js`: pure logic plus an injected audio scheduler.
  - `BeatEngine`: `bpm`, `snap`, `t0`, lane → balls, `tick(nowAudio)` look-ahead scheduler.
  - Echo ring buffer, layers, keep/clear/undo.
  - Emits hits with exact audio times.
- `js/instruments.js` (or extend `sound.js`): `playNote(instrumentId, freq, when, velocity)`.

Existing code:
- `physics.js` / matter.js stays for the legacy Drop/Bounce modes. Those modes aren't
  shown in the new UI; remove them from the keymap but not from the code.
- `render.js` gains draw functions for the new projected layers (§5).
- `channel.js`: add the messages in §6.

**Clock sync:** control sends `t0Epoch` (ms, `performance.timeOrigin + performance.now()`
at beat start) and the `bpm`. The projector computes `now` the same way. Both windows
share the machine clock, which is good to about 1 ms.

**Scheduler:** standard look-ahead. Every 25 ms, schedule all lane-ball arrivals and
layer steps that fall within the next 100 ms. Each hit is scheduled once, keyed by
`(laneId, ballId, cycle)`.

## 4. Keyboard (both windows)

| Key | Action |
|---|---|
| Space | Start / stop clock |
| [ / ] | Tempo −/+ 2 BPM (hold ⇧ for ±10) |
| S | Snap on / off |
| Tab / ⇧Tab | Highlight next / previous lane (white box around its rail note) |
| B / ⇧B | Add / remove a ball in the highlighted lane |
| A / D | Nudge the highlighted lane's x ±0.005 (fine-tune; offset stored per rail-note id) |
| ← → | Instrument ring open: spin. Otherwise unused. |
| ↵ / Esc | Ring: commit / cancel |
| E | Open the ring on the note targeted by the highlighted lane |
| K / X / Z | Keep last 4 bars / clear layers / undo keep |
| 1–6 | Mute pitch (purple…red). ⇧1–6 solos it. |
| R | Reset all balls (1 per lane, φ = 0) |
| F | Fullscreen (projector) |
| ? | Toggle the key overlay on the wall |

These replace the current bindings (arrow steer, Space = drop, M, G, B = add ball in
bounce mode, O).
- Outlines move to the control window checkbox only.
- Every key press shows a **toast** on the wall for 1 s, top right: a keycap plus a
  short text, e.g. `[B] Lane 2 → 2 balls`.

## 5. Projector rendering (reference size 1600×900; scale with `min(w/1600, h/900)`)

Black background. White is the only UI colour, apart from note-coloured hit halos.

- **Rail:** dashed rounded rect `24,16 → w−24, railBottom·h − 16`, white 22% opacity.
  Caption: "RAIL · A NOTE HERE OPENS A LANE BELOW IT" (mono 13 px, 45% opacity).
- **Rail note ring:** a circle of radius 46 around each rail note.
  - Track at 20% opacity.
  - A progress arc from 12 o'clock shows ball-1 phase `u`.
  - The rate label goes to the right of the ring, e.g. `1/4 ×2`, or `≈0.37` when Snap is off.
- **Highlighted lane:** a white rounded square (116 px, radius 18) around its rail note,
  and the lane band at 7% opacity instead of 3%.
- **Lane band:** a 140 px wide rect (or the lane width) from the rail to the target top.
  Add a dashed centre line (2/12 dash, 22% opacity).
- **Ruler:** full-width 1 px lines at each `k × unit` (major 9% opacity, minor 4%).
  Labels on the left edge: major labels mono 15 px at 60% opacity, minor ones 12 px at 35%.
- **Balls:** white, radius 15 px, glow `0 0 24px`, plus a 3-dot trail along the lane
  (radii 12/9/6, opacity .35/.18/.08) on the side the ball came from.
- **Hit halo:** on a hit, stroke the note polygon inflated by 14 px, 4 px wide, in the
  note colour with a 60 px glow. Fade it out over 250 ms.
- **Note tag:** under each target note, mono 15 px: `C4 · KICK`.
- **Instrument ring:** see §2.6.
- **Echo strip:** bottom centre, `x 190 → w−190`.
  - Header row: "ECHO · LAST 4 BARS" and "96 BPM · BAR 3/4".
  - One 6 px row per pitch that is present; each hit is a 10×6 rounded tick in the note colour.
  - White playhead, 3 px.
- **Toast:** top right, 2 px white border, black fill.
- **Nothing** is drawn on the rail notes or target notes except halos, rings and tags.
  Keep projected light off the paper as much as possible, so vision detection stays clean.

## 6. Messages (`channel.js` additions)

control → projector
- `beat { running, bpm, snap, t0Epoch, railBottom, unit, lanes:[{id, x, w, d, n, targetId, color, instrument, balls:[{id, phase}]}], highlight, mutes, solo }`
  - Send whenever anything changes, plus every 1 s as a keep-alive.
- `echo { bars, playheadStep, rows:[{pitch, color, hits:[{step, v, kept}]}] }`: ~4 Hz.
- `ring { open, noteId, choices, index, deadlineEpoch } | { open:false }`
- `toast { key, text }`
- `hitFx { noteId, color }`: fired at the scheduled audio time, via `setTimeout`, to draw halos.

projector → control
- `click { x, y }`: a mouse click on the projector, normalized.
- `key { key, shift }`: forwarded keys, so both windows behave the same (the existing pattern).

Old `balls` / `hit` messages stay for the legacy modes.

## 7. Control window changes (`control.html`)

Leave the existing camera, calibration, threshold and settings UI as it is. The
design's big mirror is only a placeholder for it. Add:

- **Header strip:** BPM, Snap state, running state.
- **Lanes panel:** one row per lane.
  - Row contents: colour swatch, instrument, pitch, rate (`1/4 ×2`), and a "blocked"
    count for shadowed notes.
  - Clicking a row highlights that lane.
- **Echo panel:**
  - The same pitch rows as the wall, at a larger size (22 px rows, 12 px dots; kept
    dots solid, live dots as outlines).
  - Buttons: **Keep last 4 bars (K)**, **Clear kept (X)**, **Undo keep (Z)**.
- **Settings:** `railBottom`, `unit`, `bpm`, `echoBars`, `maxBallsPerLane`. Add them
  to the `settings.js` schema so they persist in localStorage.

## 8. Edge cases

- **Target note moves:** recompute `d` and `n` and keep the phases. If `n` changed, the
  ball keeps its `φ mod P_new`.
- **Target removed:** the lane goes idle and its balls freeze at the rail. When a new
  target appears, the balls resume with their existing phases.
- **Rail note removed:** the lane and its balls are deleted.
- **Hands and people in front of the wall:** already handled by tracker hysteresis. Lanes
  only rebuild from tracked notes, never from raw detections.
- **Ball mask for vision:** ball positions are analytic now, so the control window can
  compute the mask capsules directly without waiting for `balls` messages. Use the same
  formula in §2.4 and add camera lag.
- **Very small `d` (n < 1 with Snap on):** clamp to n = 1 and show the label in the rate spot.
- **Two lanes overlapping in x:** allowed; each is independent.

## 9. Tests

Unit (`tests/unit.mjs`, Node):
- `buildLanes`:
  - rail detection
  - first-note-below target selection
  - shadowing
  - `n` rounding with Snap on and off
  - lane width clamp
- `BeatEngine`:
  - at 96 BPM, a lane with n = 4 schedules hits exactly `0.625 s` apart
  - two balls give the union of both phase grids
  - tempo change keeps phase continuity
  - mute and solo filter hits
- **Echo:** hits land on the correct 1/16 step; Keep snapshots; Undo pops; Clear empties;
  layers replay on the next loop.
- **Ring:** spin wraps around; commit stores the instrument by note id; Esc leaves it unchanged.

E2E (`tests/e2e.mjs`, simulated wall):
- Place one rail note and a target at 4 × unit below.
- Start the clock and collect `hitFx` timestamps. Intervals must match within ±8 ms.
- Add a ball with B and check that the hit count doubles.
- Click the target on the projector, spin to `kick`, press Enter, and check the lane's
  instrument.
- Press K, remove the target note from the sim, and check that the layer still triggers.

## 10. Build order

1. `lanes.js` + unit tests.
2. `beat.js` clock, scheduler and balls + unit tests. Sound via the existing `playTone`.
3. Projector rendering of rail, lanes, ruler, balls and halos from the `beat` message.
4. Keymap + toast. Remove the legacy keys from the UI.
5. Instruments + the ring (projector click → control → `ring`).
6. Echo buffer, layers, Keep/Clear/Undo, echo strip + control panel.
7. Control Lanes panel, settings, README update (new "How to play" section), e2e test.

Each step should leave the app runnable, and `node tests/unit.mjs` should pass after each one.

## 11. Out of scope

- Phone remote, hand-covered projected buttons, and scenes.
- Changing the pitch set or scale (colour → pitch stays fixed).
- MIDI or audio export (a possible follow-up: export kept layers as MIDI).
