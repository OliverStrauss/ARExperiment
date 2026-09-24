# sticky-wall

A projector and a USB webcam both point at a wall. You stick sticky notes on the
wall; the projector shows ball(s) bouncing around that collide with the real
notes.

Plain HTML/JS, no build step. OpenCV.js (vision), matter.js (physics),
`<canvas>` (rendering), `BroadcastChannel` (sync between the two windows).
Both libraries are vendored in `vendor/`, so it works offline.

## Run it (macOS)

```sh
cd sticky-wall            # this folder
python3 -m http.server 8000
```

Then open **http://localhost:8000/control.html** in Chrome.
(`getUserMedia` needs `localhost` or https, it does not work from `file://`.)

## One-time Mac setup

| What | How |
|---|---|
| Projector as a second screen | System Settings → Displays → set the projector to **Extend** (not Mirror), native resolution. Leave "Displays have separate Spaces" on (default). |
| Browser | Chrome is recommended (camera labels, OpenCV WASM speed). |
| Camera permission | System Settings → Privacy & Security → Camera → enable Chrome. Without this the feed is black with no error. |
| Keep the screen awake | Run `caffeinate -d` in a terminal while playing. |
| iPhone camera | Continuity Camera can show up in the camera list; pick the USB webcam. |

Keep `control.html` visible on the laptop screen (not minimised or fully
covered): Chrome throttles hidden windows and detection would slow to ~1 Hz.
