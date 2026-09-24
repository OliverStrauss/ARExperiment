# sticky-wall

A projector and a USB webcam both point at a wall. You stick sticky notes on the
wall; the projector shows ball(s) bouncing around that collide with the real
notes.

Plain HTML/JS, no framework, no build step. OpenCV.js (vision), matter.js
(physics), `<canvas>` (rendering), `BroadcastChannel` (sync between the two
windows). Both libraries are vendored in `vendor/`, so it runs offline.

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
5. Stick notes on the wall. A ball waits at the top of the projection: move
   it with **← →**, press **Space** to drop it and watch it bounce off the
   notes, press **R** to bring it back to the top.

`getUserMedia` needs `localhost` (or https); opening the files with `file://`
will not work. Both windows must come from the same address so they can talk.

**No hardware handy?** Choose **Simulated wall (test, no hardware)** in the
camera dropdown. It fakes a wall with sticky notes seen at an angle and mirrors
the projector's picture onto it, so calibration, detection and physics all work
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

**4. Physics**
- [ ] The ball bounces off notes and screen edges without slowing down.
- [ ] Moving a note updates the collisions without resetting the ball.
- [ ] While playing, the ball never becomes a note (watch "Notes: N in play").
      If it does, raise **Ball mask → Radius multiplier** or **Camera lag**.

## Controls

**Game keys** work in either window: **← →** move the waiting ball,
**Space** drops it (press again for a new ball), **R** resets, **M** switches
between the two modes:

- **Drop** (default): the ball waits at the top, you aim and drop it, it falls
  under gravity and bounces off the notes until it settles.
- **Bounce**: balls fly around at constant speed without gravity (Space then
  starts/pauses).

| control.html | |
|---|---|
| Mode | Switch Drop / Bounce |
| Calibrate / Done | Enter/leave calibration mode |
| Pause / Start, Reset ball, Add ball | Game controls |
| Gravity | Bounce mode only: toggle gravity (drop mode always has it) |
| Outlines | Faint note outlines on the projector (debug) |
| Crosshair test | Mouse over the feed → crosshair on the wall |
| Freeze notes | Stop updating notes (e.g. people walking in front) |
| Only detect inside the projected area | Ignore notes outside the calibrated area |

Projector-only keys: `F` fullscreen · `B` add ball · `G` gravity · `O` outlines.

## Settings (saved in localStorage)

| Group | Setting | Notes |
|---|---|---|
| HSV threshold | Hue / Sat / Val min & max | OpenCV ranges: H 0-179, S/V 0-255. Saturation is the key one: notes are saturated, the wall and the projected white light are not. |
| Mask cleanup | Morph kernel | Opening removes specks, closing fills holes. |
| | Process width | Frames are downscaled to this width before processing. |
| Note filter | Min / max area | % of the camera frame. |
| | Min rectangularity | blob area / its min-area rectangle; rejects odd shapes. |
| Detection | Rate | Detection runs at this rate (default 3 Hz), not every frame. |
| Tracking | Frames to add / remove | A note must be seen N rounds in a row to be added, and missing M rounds to be removed. |
| | Smoothing, match distance | Corner smoothing; how far a note may move between rounds and still be the same note. |
| Ball | Size, speed | Size as fraction of the projector height, speed in screen widths per second. |
| Ball mask | Radius multiplier, camera lag | How much area around (and behind) each ball is blanked out before detection. |

## How it works

```
control.html (laptop)                              projector.html (fullscreen)
 webcam ─► Detector (3 Hz) ───────────┐             ┌─► PhysicsWorld (matter.js)
   HSV threshold → blank ball capsules │  notes     │     walls + static note bodies
   → open/close → contours → area &    ├──────────► │     + balls (constant speed)
   shape filter → minAreaRect          │            │
   → homography → NoteTracker ─────────┘            └─► canvas render
                ▲                          balls (10 Hz)       │
                └────────── ball positions ◄───────────────────┘
```

- **Calibration** (`js/calibration.js`): the 4 clicked camera points and the 4
  known dot positions give a homography via `cv.getPerspectiveTransform`
  (camera px → projector-normalized 0..1) and its inverse. Stored in
  localStorage.
- **Detection** (`js/vision.js`): see the diagram; every temporary `cv.Mat` is
  freed.
- **Ball masking**: the projector reports ball positions and velocities; the
  control window maps them back into camera space and blanks a capsule that
  trails each ball by the camera lag. Notes touched by a ball keep their last
  shape while the ball is on them.
- **Tracking** (`js/tracker.js`): nearest-centre matching with add/remove
  hysteresis, corner smoothing and a small deadband, so the physics world only
  changes when a note really moved.
- **Physics** (`js/physics.js`): note bodies are diffed by id, so balls are
  never reset; a note that appears on top of a ball pushes it out.
- **Messages** are documented in `js/channel.js`. Everything on the wire is in
  projector-normalized coordinates, so any projector resolution works.

## Files

```
control.html, projector.html, index.html
css/style.css
js/control.js      control window wiring (UI, detection loop, overlays)
js/projector.js    projector window wiring (render loop, commands)
js/camera.js       camera listing / opening
js/simcam.js       simulated wall camera
js/vision.js       OpenCV pipeline
js/calibration.js  calibration + click-snapping
js/homography.js   pure-JS 3x3 homography maths
js/tracker.js      note tracking / anti-flicker
js/physics.js      matter.js world
js/render.js       projector drawing (shared with the simulator)
js/channel.js      BroadcastChannel + message protocol
js/settings.js     settings schema + localStorage
js/cvload.js       waits for OpenCV.js to be ready
vendor/            opencv.js 4.10, matter.js 0.20
tests/             unit + end-to-end tests
```

## Tests

```sh
node tests/unit.mjs          # tracker, homography, snapping, physics (Node only)
npm install                  # once: installs playwright for the e2e test
npx playwright install chromium   # once, if no browser is installed
node tests/e2e.mjs           # headless browser run on the simulated wall
```

The end-to-end test calibrates with deliberately sloppy clicks, then checks
the notes it finds against the simulator's ground truth. It also plays with
large balls whose light looks saturated to stress the ball mask, drags and
removes notes, and presses the game buttons. Screenshots are saved in
`tests/out/`.

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
| Ball tunnels through tiny notes | Lower *Ball speed* or raise *Min area* to ignore tiny notes. |
