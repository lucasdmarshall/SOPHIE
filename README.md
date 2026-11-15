# SOPHIE

SOPHIE is a Windows hand-gesture desktop controller. A Tauri 2 preview captures a webcam, runs MediaPipe Hand Landmarker locally, and sends 21-point hand landmark frames to Rust. Rust recognizes gestures and injects mouse input through Windows `SendInput`.

## Install

Download `SOPHIE_x.y.z_x64-setup.exe` from the [Releases](https://github.com/lucasdmarshall/SOPHIE/releases) page and run it. Nothing else is needed:

- No administrator rights: SOPHIE installs for the current user, with a Start menu entry.
- The hand model, WebAssembly runtime and fonts are inside the installer; SOPHIE never downloads anything at run time.
- WebView2 comes with Windows 11. On an older Windows 10 PC without it, the setup installs it silently (this one step needs an internet connection).
- The Visual C++ runtime is built into `sophie.exe`.

The only thing Windows may ask for is camera permission. If the camera stays off, open **Settings › Privacy & security › Camera** and turn on **Let desktop apps access your camera**. SOPHIE shows a link to that page when the camera is blocked.

## Build from source

One command installs whatever is missing (Node.js LTS, Rust, the Visual Studio C++ Build Tools with the Windows SDK, through winget), installs the npm packages, and builds the installer:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Build
```

Without `-Build` it only prepares the machine; then run SOPHIE in development mode with `npm run app:dev`.

Pushing a `v*` tag runs the [Release workflow](.github/workflows/release.yml), which builds the installer on a clean GitHub runner and attaches it to a GitHub release.

The model is bundled in `public/models/hand_landmarker.task`; the dev and build scripts copy the installed MediaPipe WASM runtime into `public/wasm`. Camera access is requested when you press **Start control**. SOPHIE then parks the preview outside the screen and stays in the system tray so WebView2 can keep processing camera frames. Use the tray menu to show the preview, pause, resume, or quit. The model comes from Google's [Hand Landmarker model bundle](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task).

## Mouse gestures

Choose **Standard** or **Lazy** in the preview before starting control. SOPHIE remembers the selected mode and Lazy cursor speed in `%APPDATA%\SOPHIE\control.toml`.

### Standard mode

- Right hand, index finger raised: move the cursor. Movement uses adaptive smoothing and a small dead zone to reduce jitter.
- Thumb and index pinch, quick release: left click. Pinch and move to start dragging (80 ms minimum), or hold for 250 ms; release to drop. The cursor stays fixed while a click is pending.
- Index, middle and ring fingers raised, pinky folded, for a brief hold: right click once. Thumb and middle pinch does not right-click.
- Victory fingers (index and middle raised, ring and pinky folded): move upward to scroll up, downward to scroll down. Reverse without pausing. The thumb can rest naturally. Filtered palm displacement drives small wheel increments; cursor movement is paused during scrolling.
- Standard cursor filtering damps stationary jitter while responding to deliberate motion. Edge panning requires hand movement, so holding still near the camera boundary does not continuously move the cursor.
- Fist: freeze the cursor.

Use **Calibrate reach** in the preview to record the comfortable limits of your right-hand movement. Move the hand to the left, right, top, and bottom limits, then press **Save reach**. The sensitivity slider changes how much screen movement a given hand movement produces. Moving the hand near a calibrated edge extends cursor reach, so screen-edge controls remain reachable. A fist freezes the cursor; when you point again, cursor motion resumes from its frozen position without a jump. Settings persist in `%APPDATA%\SOPHIE\calibration.toml`.

### Lazy mode

Rest your right hand and move your index finger like a small trackpad. Cursor movement follows finger movement relative to the palm; it stops when the finger stops, even if the finger remains off-center. A dead zone and filtering suppress landmark jitter. The Lazy cursor speed slider controls movement gain. Make a fist, reposition the finger, and point again to continue from the same cursor position without a jump.

After moving to a new location, hold the finger still. A small, click-through clockwise ring near the cursor fills over 1.2 seconds by default, then left-clicks once. Set the delay from 0.7 to 2.5 seconds in the preview. Small hand shake within the click area does not restart the ring. Moving farther cancels or rearms it. Tracking loss, pause, or stop cancels it. The first click requires a small cursor movement, preventing an accidental click when control starts.

- Index and middle fingers: scroll by moving the fingers vertically.
- Middle finger alone, held 0.9 seconds: right click.
- Index, middle, and ring fingers, held 0.9 seconds: toggle drag; repeat to release. A fist also releases drag.
- Fist: pause cursor movement. A bent index finger can still steer when the thumb is not tucked.

SOPHIE releases a held mouse button if frames stop arriving. It disarms after two seconds without camera frames or five seconds without the selected hand; use **Resume control** in the tray menu to rearm.

The tracker runs in one-hand mode and tolerates a brief 180 ms landmark loss before resetting gesture smoothing. The preview shows processed tracking FPS, model inference time, the camera's negotiated mode, a brightness estimate, and handedness confidence. The brightness estimate is a rough warning, not a measure of motion blur or landmark accuracy. In a dim room, add soft light in front of the hand and avoid a bright window behind it; a camera's low-light exposure setting may reduce its frame rate.

## Recorded controls

Choose a predefined control (Previous page, Next page, Scroll up, Scroll down, Left click, or Right click), name the gesture, and press **Record gesture**. After the 3–2–1 countdown, make one directional hand movement for 1.3 seconds. The recording replaces the chosen control's default gesture. Recording that control again replaces its previous recording; removing it restores the default behavior.

The matcher uses palm coordinates normalized by hand size and a resampled motion path. The thumb is ignored for posture matching. Keep the four-finger pose consistent during recording. Index-only is reserved for cursor movement. Recordings are saved in `%APPDATA%\SOPHIE\gestures.toml`. A recorded pose also suppresses built-in scroll/right-click output during recognition to avoid two actions firing. Previous/next page uses the foreground application's back/forward navigation.

## Build checks

```powershell
npm run build
npm run app:check
npm run app:test
npm run app:build
```

The [design specification](docs/superpowers/specs/2026-11-11-sophie-gesture-control-design.md) defines the remaining activation, configuration, shortcut, and installer work.
