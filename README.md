# sticky-wall

A projector and a USB webcam both point at a wall. You stick sticky notes on the
wall and the wall becomes a beat instrument: balls fall from notes in the top
band onto the notes below them, in time, and every hit plays the note's pitch.

Plain HTML/JS, no framework, no build step. OpenCV.js (vision), Web Audio
(sound), `<canvas>` (rendering), `BroadcastChannel` (sync between the two
windows). OpenCV is vendored in `vendor/`, so it runs offline.

## Quick start (macOS)

```sh
cd ARExperiment              # this folder
python3 -m http.server 8000  # python3 ships with macOS
```

1. In **Chrome**, open **http://localhost:8000/control.html** (laptop screen).
2. Click **Open projector window**, drag that window onto the projector and
   press **Fullscreen** (or `F`).
3. Pick your USB webcam in the **Camera** dropdown.
4. **Calibrate**: click the 4 numbered dots in the camera view, then **Done**.
5. Stick a note in the **rail** (the dashed band at the top of the wall) and
   another note below it. Press **Space** to start the clock: a ball bounces
   between the two in time, and the lower note plays. See *How to play*.

`getUserMedia` needs `localhost` (or https); opening the files with `file://`
will not work. Both windows must come from the same address so they can talk.

**No hardware handy?** Choose **Simulated wall (test, no hardware)** in the
camera dropdown. It fakes a wall with sticky notes seen at an angle and mirrors
the projector's picture onto it, so calibration, detection and the beat all work
exactly as with the real thing. Drag notes around in the camera view.

## One-time Mac setup

| What | How |
|---|---|
| Projector as a second screen | System Settings → Displays → set the projector to **Extend** (not Mirror), native resolution. Leave "Displays have separate Spaces" on (default) so fullscreen on the projector doesn't hide the laptop screen. |
| Browser | Chrome recommended (camera labels, OpenCV WebAssembly speed). |
| Camera permission | System Settings → Privacy & Security → Camera → enable Chrome. Without it the feed stays black with no error. |
| Keep the screen awake | Run `caffeinate -d` in a terminal while playing. |
| iPhone camera | Continuity Camera can show up in the camera list; pick the USB webcam. |

Keep `control.html` visible on the laptop screen (not minimised or fully
covered): Chrome throttles hidden windows and detection would slow to ~1 Hz.

## Testing with the real hardware (checklist)

Everything below was verified against the simulated wall, but real cameras,
projectors and rooms differ. Go through it stage by stage.

**1. Camera + threshold**
- [ ] The dropdown shows the USB webcam by name (not "Camera 1").
- [ ] Status shows the camera resolution and ~30 fps.
- [ ] Notes are white in the *Threshold mask*, the wall is black. Tune
      **Sat min** first (raise it until the wall disappears), then **Val min**.
      Check again with the projector on, since its light changes colours.
- [ ] Red/pink notes: if they vanish, try *Hue min* > *Hue max* (e.g. 160 → 20):
      that wraps the hue range around red.

**2. Calibration**
- [ ] Calibrate: the projector shows a white border + dots 1-4; click them
      in order (top-left, top-right, bottom-right, bottom-left). Clicks snap to
      the dot centre; drag a marker to adjust.
- [ ] The blue dashed outline in the feed matches the projected area.
- [ ] Tick **Crosshair test** and move the mouse over the feed: the crosshair
      on the wall should sit under the mouse position everywhere, including the
      corners.
- [ ] Re-calibrate whenever the camera or projector is bumped, or the camera
      resolution changes (the status line warns about that).

**3. Detection**
- [ ] Notes get a green outline with an id in the feed; toggle **Outlines**
      to see faint outlines projected onto the real notes. They should line up.
- [ ] Waving a hand in front of the wall doesn't add or remove notes.
- [ ] Adding a note takes ~1 s to register; removing one ~2 s (see *Tracking*).

**4. Beat**
- [ ] A note in the rail opens a lane (a faint band) straight down from it.
- [ ] The first note below it in the lane gets a tag (`E4 · BELL`); the ball
      bounces between the two and every hit flashes a halo and plays.
- [ ] Moving the target note further down makes the lane slower (the rate
      label next to the rail note changes: 1/8 → 1/4 → 3/8 …).
- [ ] While playing, balls and halos never become notes (watch "Notes: N in
      play"). If they do, raise **Ball mask → Radius multiplier** or
      **Camera lag**.
- [ ] Sound and halos line up. If the sound is late on a Bluetooth speaker,
      use a wired one (Bluetooth adds ~200 ms).

## How to play

The wall is the instrument; the laptop only watches (and keeps loops).

- **Rail = where balls come from.** The dashed band at the top of the wall is
  the rail. A note whose centre is in the rail opens a **lane** straight down
  from it. Rail notes never make a sound. Any number of lanes.
- **Target = what plays.** The first note below the rail note that crosses the
  lane's centre line is its target. Notes further down the same lane are
  blocked (the Lanes panel counts them).
- **Colour = pitch.** purple C4 · blue D4 · green E4 · yellow G4 · orange A4 ·
  red C5 (pentatonic, so any mix sounds fine).
- **Drop distance = rhythm.** Each ruler line below the rail is one more 16th
  note between hits: a target 4 lines down hits every 1/4 note. With **Snap**
  on (default) lengths round to whole 16ths; off gives free rhythms.
- **More balls = more hits.** **B** drops another ball into the highlighted
  lane *now*; balls dropped at different moments make syncopation.
- **Instruments.** Click a note on the wall (mouse on the projector window) or
  press **E** for the highlighted lane's target: a ring of instruments appears
  around it. **← →** spin, **↵** or a second click keeps, **Esc** cancels; it
  keeps the choice by itself after 4 s. Or pick it in the Lanes panel.
  bell · pluck · marimba · pad · bass · kick · tom, all at the note's pitch.
- **Echo + Keep.** The strip at the bottom shows what the wall played in the
  last 4 bars. **K** keeps it as a loop that plays forever, even after you take
  the notes down, so you can build a beat in layers. **Z** undoes the last
  keep, **X** clears them all.

### Keys (either window)

| Key | Action |
|---|---|
| Space | Start / stop the clock |
| [ / ] | Tempo −/+ 2 BPM (hold ⇧ for ±10) |
| S | Snap on / off |
| Tab / ⇧Tab | Highlight next / previous lane (white box around its rail note) |
| B / ⇧B | Add / remove a ball in the highlighted lane |
| A / D | Nudge the highlighted lane left / right |
| E | Instrument ring on the highlighted lane's target |
| ← → ↵ Esc | Ring open: spin / keep / cancel |
| K / X / Z | Keep last 4 bars / clear kept / undo keep |
| 1–6 | Mute a colour (purple … red); ⇧1–6 solos it |
| R | Reset balls (1 per lane, on the downbeat) |
| F | Fullscreen (projector) |
| ? | Show the keys on the wall |

Every key shows a short toast in the top-right corner of the wall.

### control.html

Everything can also be set from the laptop:

| | |
|---|---|
| Top bar | Start/Stop, tempo −/+, Snap, Outlines (faint note outlines on the wall, for debugging) |
| Lanes | One row per lane: target pitch, instrument, rate, balls (−/+), blocked notes. Click a row to highlight the lane. Mute / solo buttons per pitch, Reset balls, Keys on wall. |
| Echo | The last bars, one row per pitch (kept hits solid, live hits outlined). Keep / Clear kept / Undo keep. |
| Settings → Beat | Tempo, rail height, distance per 1/16, echo bars, max balls per lane. |
| Calibrate, Crosshair test, Freeze notes, Only detect inside the projected area | Setup, as before. |

Sound plays from the **control window** (browsers only allow audio after a
click on the page, so click anywhere there once; the status line shows
`Sound: on`).

**Teach the colours** (recommended with a real camera, since the projector and
webcam shift colours): in *Note colours*, click a colour button, then click
that note in the camera view (inside its yellow outline). Repeat for all six.
The feed labels each note with its colour. *Defaults* forgets taught colours.

## Settings (saved in localStorage)

| Group | Setting | Notes |
|---|---|---|
| Beat | Tempo | BPM (also [ ] keys). |
| | Rail height | Bottom of the rail band, as a fraction of the projector height. |
| | Distance per 1/16 | How far below the rail each extra 16th note is (projector heights). Lower it for a small wall. |
| | Echo bars, max balls per lane | Length of the echo / kept loops (4/4 bars); ball limit per lane. |
| HSV threshold | Hue / Sat / Val min & max | OpenCV ranges: H 0-179, S/V 0-255. Saturation is the key one: notes are saturated, the wall and the projected white light are not. |
| Mask cleanup | Morph kernel | Opening removes specks, closing fills holes. |
| | Process width | Frames are downscaled to this width before processing. |
| Note filter | Min / max area | % of the camera frame. |
| | Min rectangularity | blob area / its min-area rectangle; rejects odd shapes. |
| Detection | Rate | Detection runs at this rate (default 3 Hz), not every frame. |
| Tracking | Frames to add / remove | A note must be seen N rounds in a row to be added, and missing M rounds to be removed. |
| | Smoothing, match distance | Corner smoothing; how far a note may move between rounds and still be the same note. |
| Ball mask | Radius multiplier, camera lag | How much area around (and behind) each ball is blanked out before detection. |

## How it works

```
control.html (laptop)                                      projector.html (fullscreen)
 webcam ─► Detector (3 Hz) ─► NoteTracker ─► notes ───────► draws rail, lanes, balls,
   HSV threshold → blank ball/halo capsules      │           halos, ring, echo, toasts
   → open/close → contours → shape filter        ▼           from the shared clock
   → homography                          buildLanes()             │
                                                 ▼                │ keys, clicks
                          BeatEngine (clock, balls, scheduler,    │
                          echo, layers) ── beat / echo / hitFx ──►│
                                 │                                │
                                 └─► Web Audio (sample-accurate) ◄┘
```

- **Calibration** (`js/calibration.js`): the 4 clicked camera points and the 4
  known dot positions give a homography via `cv.getPerspectiveTransform`
  (camera px → projector-normalized 0..1) and its inverse. Stored in
  localStorage.
- **Detection** (`js/vision.js`): see the diagram; every temporary `cv.Mat` is
  freed.
- **Tracking** (`js/tracker.js`): nearest-centre matching with add/remove
  hysteresis, corner smoothing and a small deadband. Lanes only ever rebuild
  from tracked notes, so hands and people in front of the wall don't matter.
- **Lanes** (`js/lanes.js`): rail notes, targets, shadowed notes and the
  length of each lane in 16ths.
- **Beat** (`js/beat.js`): musical time is counted in 16ths on a clock that
  re-anchors on tempo changes. A ball is just the phase at which it hits, so
  its position is a formula: no physics. Every 25 ms the scheduler finds the
  hits in the next ~100 ms and schedules them on the `AudioContext` clock
  (`js/sound.js`, `js/instruments.js`). The projector draws the balls from
  the same clock (`performance.timeOrigin + performance.now()` is shared by
  both windows to ~1 ms) and gets each hit ahead of time for its halo.
- **Ball mask**: ball positions are analytic, so the control window knows
  where every ball and halo is and blanks those areas out of the camera
  image before detection. Balls stop a few pixels above the paper and the
  halo mask starts a few pixels outside it, so the mask never cuts into a
  note (which would shrink it, move the mask further in, and eat the note).
- **Messages** are documented in `js/channel.js`. Everything on the wire is in
  projector-normalized coordinates, so any projector resolution works.

## Files

```
control.html, projector.html, index.html
css/style.css
js/control.js      control window wiring (UI, detection loop, beat engine, overlays)
js/projector.js    projector window wiring (render loop, forwards keys/clicks)
js/camera.js       camera listing / opening
js/simcam.js       simulated wall camera
js/vision.js       OpenCV pipeline
js/calibration.js  calibration + click-snapping
js/homography.js   pure-JS 3x3 homography maths
js/tracker.js      note tracking / anti-flicker
js/lanes.js        rail notes -> lanes, targets, rhythm
js/beat.js         clock, balls, look-ahead scheduler, echo + layers
js/ring.js         instrument ring state
js/keys.js         keymap shared by both windows
js/instruments.js  Web Audio synth voices
js/colors.js       note colours, pitches, colour classification
js/sound.js        audio context, clock conversion, playNote
js/render.js       projector drawing (shared with the simulator)
js/channel.js      BroadcastChannel + message protocol
js/settings.js     settings schema + localStorage
js/cvload.js       waits for OpenCV.js to be ready
vendor/            opencv.js 4.10
tests/             unit + end-to-end tests
```

## Tests

```sh
node tests/unit.mjs          # tracker, homography, snapping, lanes, beat, echo, ring (Node only)
npm install                  # once: installs playwright for the e2e test
npx playwright install chromium   # once, if no browser is installed
node tests/e2e.mjs           # headless browser run on the simulated wall
```

The end-to-end test calibrates with deliberately sloppy clicks, then checks
the notes it finds against the simulator's ground truth, drags and removes
notes. Then it builds a wall with one rail note and a target 4 × unit below,
starts the clock from the projector window and checks the halos arrive every
625 ms at 96 BPM (±8 ms), that **B** doubles the hits, that balls and halos
are never detected as notes, that clicking the target and spinning the ring
sets `kick`, the mute / tempo / help keys, and that a kept layer still plays
after the target is taken down. Screenshots are saved in `tests/out/`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Camera list says "Camera 1…" / black feed | Grant camera permission (Mac settings above), then press ↻. |
| "Projector: not connected" | Both windows must be opened from the same `http://localhost:8000`. |
| Notes flicker in/out | Raise *Frames to remove*, lower *Sat min*, raise *Morph kernel*. |
| Wall texture or shadows detected | Raise *Sat min*/*Min area*, keep *Only detect inside the projected area* on. |
| Crosshair is offset | Recalibrate; make sure clicks went 1→2→3→4 clockwise from top-left. |
| Detection is slow (> 100 ms) | Lower *Process width* to 640 or 480. |
| Notes far away aren't picked up (tiny white dots in the mask) | Lower *Min area* (0.01), raise *Process width* (1280), lower *Morph kernel* (3). Also check *Freeze notes* is off. |
| Beige/wood wall shows up in the mask | Narrow *Hue min/max* to your note colour, e.g. green notes 35-85, yellow 20-35, pink 150-175. |
| A lane doesn't open | Its note's centre must be inside the dashed rail. Raise *Rail height* if your notes are big. |
| Lanes are too slow / the wall is too small | Lower *Distance per 1/16*. |
| Arrow keys do nothing | They only spin the instrument ring (click a note or press E first). |
