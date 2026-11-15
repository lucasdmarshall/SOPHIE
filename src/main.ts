import '@fontsource/poppins/latin-600.css';
import '@fontsource/plus-jakarta-sans/latin-400.css';
import '@fontsource/plus-jakarta-sans/latin-600.css';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { drawLandmarks } from './overlay';
import { Tracker, type TrackingResult } from './tracker';
import type { Calibration, ControlSettings, CoreStatus, GestureSummary } from './types';
import './style.css';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="shell">
    <header class="topbar"><div class="brand-mark">S</div><div class="brand">SOPHIE<span> / PREVIEW</span></div><span class="version">v0.2 · mouse control</span></header>
    <section class="intro"><div><p class="eyebrow">GESTURE CONTROL SYSTEM</p><h1>Your hand is<br><em>the cursor.</em></h1><p class="description" id="description">Start control to park SOPHIE in the system tray. Point to move, pinch thumb and index to click or drag, raise three fingers for right click, and move victory fingers up or down to scroll.</p></div><div class="state" id="state"><span class="state-dot"></span> DISARMED</div></section>
    <section class="preview"><video id="video" autoplay muted playsinline></video><canvas id="overlay" width="640" height="480"></canvas><div class="preview-label" id="preview-label">CAMERA OFFLINE</div><div class="preview-corner">LIVE LANDMARK FEED</div></section>
    <section class="bottom"><div class="metrics"><div><span class="metric-label">HANDS</span><strong id="hands">—</strong></div><div><span class="metric-label">TRACKING</span><strong id="fps">—</strong></div><div><span class="metric-label">INFERENCE</span><strong id="inference">—</strong></div><div><span class="metric-label">POSE</span><strong id="pose">—</strong></div><div><span class="metric-label">DELEGATE</span><strong id="delegate">—</strong></div></div><button id="holo-enter" class="secondary">Holo Mode ◈</button><button id="toggle">Start control <span>↗</span></button></section>
    <section class="mode-panel"><label>CONTROL MODE <select id="control-mode"><option value="standard">Standard · hand movement</option><option value="lazy">Lazy · finger steering + dwell click</option></select></label><p id="mode-help">Choose a mode before starting control.</p></section>
    <section class="reach" id="standard-settings"><div><span class="metric-label">CURSOR REACH</span><p id="reach-status">Loading settings…</p></div><button id="calibrate" class="secondary">Calibrate reach</button><label class="sensitivity">Sensitivity <strong id="sensitivity-value">1.0×</strong><input id="sensitivity" type="range" min="0.7" max="1.8" step="0.1" value="1"></label></section>
    <section class="reach" id="lazy-settings" hidden><div><span class="metric-label">LAZY MODE</span><p>Move the index finger like a small trackpad; the cursor stops when the finger stops. Hold still for a dwell click. Make a fist to reposition the finger without moving the cursor.</p></div><label class="sensitivity">Cursor speed <strong id="lazy-speed-value">1.0×</strong><input id="lazy-speed" type="range" min="0.5" max="2.0" step="0.1" value="1"></label><label class="sensitivity">Click delay <strong id="lazy-dwell-value">1.2 s</strong><input id="lazy-dwell" type="range" min="0.7" max="2.5" step="0.1" value="1.2"></label></section>
    <section class="gesture-library"><div><span class="metric-label">CUSTOM GESTURES</span><p>Record one clear directional hand movement, then assign it to a control. Recording starts after a 3 · 2 · 1 countdown.</p></div><div class="record-form"><label>Gesture name<input id="gesture-name" maxlength="32" placeholder="e.g. Wave up"></label><label>Control<select id="gesture-action"><option value="previous_page">Previous page</option><option value="next_page">Next page</option><option value="scroll_up">Scroll up</option><option value="scroll_down">Scroll down</option><option value="left_click">Left click</option><option value="right_click">Right click</option></select></label><button id="record-gesture" class="secondary">Record gesture</button></div><p id="record-status" class="record-status">Record while control is stopped. A custom pose replaces its built-in scroll or right click action.</p><div id="gesture-list" class="gesture-list"></div></section>
    <p class="diagnostics" id="diagnostics">Camera mode — · Brightness estimate — · Hand ID confidence —</p>
    <p class="message" id="message">Camera access is requested when you start. Use the tray icon to show the preview, pause, resume, or quit.</p>
  </main>`;

const video = document.querySelector<HTMLVideoElement>('#video')!;
const canvas = document.querySelector<HTMLCanvasElement>('#overlay')!;
const preview = document.querySelector<HTMLElement>('.preview')!;
const button = document.querySelector<HTMLButtonElement>('#toggle')!;
const calibrateButton = document.querySelector<HTMLButtonElement>('#calibrate')!;
const sensitivityInput = document.querySelector<HTMLInputElement>('#sensitivity')!;
const sensitivityValue = document.querySelector<HTMLElement>('#sensitivity-value')!;
const reachStatus = document.querySelector<HTMLElement>('#reach-status')!;
const modeSelect = document.querySelector<HTMLSelectElement>('#control-mode')!;
const lazySpeedInput = document.querySelector<HTMLInputElement>('#lazy-speed')!;
const lazySpeedValue = document.querySelector<HTMLElement>('#lazy-speed-value')!;
const lazyDwellInput = document.querySelector<HTMLInputElement>('#lazy-dwell')!;
const lazyDwellValue = document.querySelector<HTMLElement>('#lazy-dwell-value')!;
const recordButton = document.querySelector<HTMLButtonElement>('#record-gesture')!;
const gestureNameInput = document.querySelector<HTMLInputElement>('#gesture-name')!;
const gestureActionInput = document.querySelector<HTMLSelectElement>('#gesture-action')!;
const recordStatus = document.querySelector<HTMLElement>('#record-status')!;
const gestureList = document.querySelector<HTMLElement>('#gesture-list')!;
const message = document.querySelector<HTMLParagraphElement>('#message')!;
const diagnostics = document.querySelector<HTMLParagraphElement>('#diagnostics')!;
const previewLabel = document.querySelector<HTMLDivElement>('#preview-label')!;
const stateBadge = document.querySelector<HTMLDivElement>('#state')!;
const tracker = new Tracker(video);
let active = false;
let sending = false;
let lastStatusAt = 0;
let cameraMode = 'Camera mode —';
let calibrating = false;
let samples: [number, number][] = [];
let calibration: Calibration = { x_min: 0.2, x_max: 0.8, y_min: 0.2, y_max: 0.8, sensitivity: 1, calibrated: false };
let settings: ControlSettings = { mode: 'standard', lazy_speed: 1, lazy_dwell_ms: 1200 };
let bindings: GestureSummary[] = [];
let recording = false;
let capturing = false;
let recordToken = 0;
let recordedFrames: { timestamp_ms: number; landmarks: [number, number, number][] }[] = [];

function renderBindings(): void {
  gestureList.replaceChildren();
  if (bindings.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No recorded gestures yet.';
    gestureList.append(empty);
    return;
  }
  for (const binding of bindings) {
    const row = document.createElement('div');
    row.className = 'gesture-row';
    const label = document.createElement('span');
    label.textContent = `${binding.name} → ${binding.action.replaceAll('_', ' ')}`;
    const remove = document.createElement('button');
    remove.className = 'remove-gesture';
    remove.textContent = 'Remove';
    remove.disabled = active || calibrating || recording;
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        bindings = await invoke<GestureSummary[]>('delete_custom_gesture', { id: binding.id });
        renderBindings();
      } catch (error) {
        recordStatus.textContent = `Remove error: ${String(error)}`;
        remove.disabled = false;
      }
    });
    row.append(label, remove);
    gestureList.append(row);
  }
}

void invoke<GestureSummary[]>('list_custom_gestures').then((value) => { bindings = value; renderBindings(); }).catch(() => { renderBindings(); });

function renderMode(): void {
  modeSelect.value = settings.mode;
  lazySpeedInput.value = String(settings.lazy_speed);
  lazySpeedValue.textContent = `${settings.lazy_speed.toFixed(1)}×`;
  lazyDwellInput.value = String(settings.lazy_dwell_ms / 1000);
  lazyDwellValue.textContent = `${(settings.lazy_dwell_ms / 1000).toFixed(1)} s`;
  document.querySelector<HTMLElement>('#standard-settings')!.hidden = settings.mode !== 'standard';
  document.querySelector<HTMLElement>('#lazy-settings')!.hidden = settings.mode !== 'lazy';
  document.querySelector<HTMLElement>('#description')!.textContent = settings.mode === 'lazy'
    ? `Rest your hand and move the cursor with small index-finger motions. Stop the finger to stop the cursor; hold still for ${(settings.lazy_dwell_ms / 1000).toFixed(1)} seconds to click. The clockwise ring shows progress.`
    : 'Start control to park SOPHIE in the system tray. Point to move, pinch thumb and index to click or drag, raise three fingers for right click, and move victory fingers up or down to scroll.';
  document.querySelector<HTMLElement>('#mode-help')!.textContent = settings.mode === 'lazy'
    ? 'Two fingers scroll · middle finger alone right-clicks after 0.9 s · three fingers toggle drag after 0.9 s · fist pauses.'
    : 'Victory fingers + vertical movement scroll; index, middle and ring raised right-click once; pinch and move to drag.';
}

void invoke<ControlSettings>('get_control_settings').then((value) => { settings = value; renderMode(); }).catch(() => { renderMode(); });

function renderCalibration(): void {
  sensitivityInput.value = String(calibration.sensitivity);
  sensitivityValue.textContent = `${calibration.sensitivity.toFixed(1)}×`;
  reachStatus.textContent = calibration.calibrated ? 'Personal reach saved · move near an edge to extend reach' : 'Default reach · move near an edge to extend reach';
}

void invoke<Calibration>('get_calibration').then((value) => { calibration = value; renderCalibration(); }).catch(() => { renderCalibration(); });

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function sampleCalibration(frame: TrackingResult['frame']): void {
  const hand = frame.hands.find((item) => item.handedness === 'Right' && item.score >= 0.5);
  if (!hand) return;
  const x = (hand.landmarks[5][0] + hand.landmarks[9][0]) / 2;
  const y = (hand.landmarks[5][1] + hand.landmarks[9][1]) / 2;
  samples.push([x, y]);
  if (samples.length > 900) samples.shift();
  reachStatus.textContent = `${samples.length} frames · move your right hand to the comfortable left, right, top and bottom limits`;
}

async function finishCalibration(): Promise<void> {
  if (samples.length < 30) { message.textContent = 'Keep your hand in view a little longer before saving.'; return; }
  const xs = samples.map((sample) => sample[0]).sort((a, b) => a - b);
  const ys = samples.map((sample) => sample[1]).sort((a, b) => a - b);
  const x_min = Math.max(0, percentile(xs, 0.02) - 0.015);
  const x_max = Math.min(1, percentile(xs, 0.98) + 0.015);
  const y_min = Math.max(0, percentile(ys, 0.02) - 0.015);
  const y_max = Math.min(1, percentile(ys, 0.98) + 0.015);
  if (x_max - x_min < 0.15 || y_max - y_min < 0.15) {
    message.textContent = 'Move farther in both directions, then save calibration.';
    return;
  }
  try {
    calibration = await invoke<Calibration>('set_calibration', { calibration: { x_min, x_max, y_min, y_max, sensitivity: calibration.sensitivity, calibrated: true } });
    await stopTracking('Reach saved. Start control to use it.');
    renderCalibration();
  } catch (error) { message.textContent = `Calibration error: ${String(error)}`; }
}

function updateStatus(status: CoreStatus): void {
  stateBadge.innerHTML = `<span class="state-dot"></span> ${status.armed ? 'ARMED' : 'DISARMED'}`;
  stateBadge.classList.toggle('armed', status.armed);
  document.querySelector('#pose')!.textContent = status.pose.replace('_', ' ');
}

async function stopTracking(reason = 'Control stopped.'): Promise<void> {
  recordToken++;
  tracker.stop();
  active = false;
  calibrating = false;
  recording = false;
  capturing = false;
  recordedFrames = [];
  recordButton.disabled = false;
  calibrateButton.disabled = false;
  modeSelect.disabled = false;
  lazySpeedInput.disabled = false;
  lazyDwellInput.disabled = false;
  calibrateButton.textContent = 'Calibrate reach';
  renderCalibration();
  try { updateStatus(await invoke<CoreStatus>('stop_control')); } catch { /* The watchdog also releases held input. */ }
  void emitTo('holo', 'holo-tracking', { running: false, armed: false, fps: 0, hands: 0, pose: 'clutch' }).catch(() => {});
  try { await invoke('show_preview'); } catch { /* The window may be closing. */ }
  button.innerHTML = 'Start control <span>↗</span>';
  previewLabel.textContent = 'CAMERA OFFLINE';
  diagnostics.textContent = 'Camera mode — · Brightness estimate — · Hand ID confidence —';
  diagnostics.classList.remove('low-light');
  message.textContent = reason;
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  renderBindings();
}

/**
 * True while Holo Mode is open. Its hand cursor and skeleton are streamed straight from
 * Rust inside submit_frame, so this window only needs to know when to skip its own drawing.
 */
let holoVisible = false;
void listen<boolean>('holo-visibility', ({ payload }) => { holoVisible = payload; });

async function onFrame({ frame, inferenceMs, delegate, brightness }: TrackingResult): Promise<void> {
  // The preview is hidden behind Holo Mode; drawing it would only cost GPU time.
  if (!holoVisible) drawLandmarks(canvas, frame);
  if (calibrating) sampleCalibration(frame);
  if (capturing) {
    const hand = frame.hands.find((item) => item.handedness === 'Right' && item.score >= 0.5);
    if (hand) {
      recordedFrames.push({ timestamp_ms: frame.timestamp_ms, landmarks: hand.landmarks });
      recordStatus.textContent = `Recording… ${recordedFrames.length} hand frames`;
    }
  }
  if (!holoVisible) {
    document.querySelector('#hands')!.textContent = String(frame.hands.length);
    document.querySelector('#inference')!.textContent = `${inferenceMs.toFixed(0)} ms`;
    document.querySelector('#delegate')!.textContent = delegate;
  }
  // Keep one IPC call in flight. A slow Rust response must not queue stale frames.
  if (sending) return;
  sending = true;
  try {
    const status = await invoke<CoreStatus>('submit_frame', { frame });
    // Disarmed control ignores landmarks; Holo still shows the hand, so it keeps full rate.
    tracker.idle = status.running && !status.armed && !holoVisible;
    if (performance.now() - lastStatusAt > 150) {
      document.querySelector('#fps')!.textContent = `${status.fps.toFixed(0)} fps`;
      updateStatus(status);
      const light = brightness === null ? '—' : brightness < 65 ? `Low (${brightness}/255)` : brightness < 100 ? `Dim (${brightness}/255)` : `OK (${brightness}/255)`;
      const handId = frame.hands.find((hand) => hand.handedness === 'Right')?.score;
      diagnostics.textContent = `${cameraMode} · Brightness estimate ${light} · Hand ID confidence ${handId === undefined ? '—' : handId.toFixed(2)}`;
      diagnostics.classList.toggle('low-light', brightness !== null && brightness < 65);
      if (!recording) previewLabel.textContent = brightness !== null && brightness < 65 ? 'LOW LIGHT' : 'TRACKING ACTIVE';
      lastStatusAt = performance.now();
      void emitTo('holo', 'holo-tracking', { ...status, hands: frame.hands.length }).catch(() => {});
    }
  } catch (error) {
    await stopTracking(`Input stopped: ${String(error)}`);
  } finally {
    sending = false;
  }
}

/**
 * Explain a failed camera start in plain words. A blocked camera is the common case on a
 * fresh install: Windows turns off camera access for desktop apps in its privacy settings.
 */
function showCameraError(error: unknown, prefix: string): void {
  const name = error instanceof DOMException ? error.name : '';
  let text = `${prefix}: ${String(error)}`;
  let blocked = false;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    text = 'Windows is blocking the camera. Turn on "Camera access" and "Let desktop apps access your camera", then press Start again.';
    blocked = true;
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    text = 'No camera was found. Connect a webcam, then press Start again.';
  } else if (name === 'NotReadableError' || name === 'AbortError') {
    text = 'The camera is busy in another app (Teams, Zoom, Camera…). Close it, then press Start again.';
  }
  message.textContent = text;
  if (blocked) {
    const open = document.createElement('a');
    open.href = '#';
    open.className = 'message-action';
    open.textContent = 'Open camera settings';
    open.addEventListener('click', (event) => {
      event.preventDefault();
      invoke('open_camera_settings').catch(() => {});
    });
    message.append(' ', open);
  }
}

/** Start camera tracking and gesture control. Resolves true when control is running. */
async function startControl(): Promise<boolean> {
  if (active) return true;
  if (calibrating || recording) return false;
  button.disabled = true;
  calibrateButton.disabled = true;
  recordButton.disabled = true;
  message.textContent = 'Loading hand model and requesting camera…';
  try {
    const { delegate, cameraMode: mode } = await tracker.start(onFrame, (error) => { void stopTracking(`Camera stopped: ${error.message}`); });
    cameraMode = `Camera mode ${mode.width}×${mode.height}${mode.frameRate ? ` @ ${mode.frameRate.toFixed(0)} fps negotiated` : ''}`;
    // Match the canvas and preview to the camera's actual resolution.
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    preview.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    active = true;
    modeSelect.disabled = true;
    lazySpeedInput.disabled = true;
    lazyDwellInput.disabled = true;
    renderBindings();
    button.innerHTML = 'Stop control <span>×</span>';
    previewLabel.textContent = 'TRACKING ACTIVE';
    message.textContent = `${delegate} tracking is running. Use the tray icon to return here.`;
    updateStatus(await invoke<CoreStatus>('start_control'));
    return true;
  } catch (error) {
    tracker.stop();
    try { await invoke('stop_control'); } catch { /* No input to release if startup failed. */ }
    active = false;
    modeSelect.disabled = false;
    lazySpeedInput.disabled = false;
    lazyDwellInput.disabled = false;
    renderBindings();
    button.innerHTML = 'Start control <span>↗</span>';
    previewLabel.textContent = 'CAMERA OFFLINE';
    showCameraError(error, 'Camera or model error');
    return false;
  } finally {
    button.disabled = false;
    calibrateButton.disabled = active;
    recordButton.disabled = active;
  }
}

button.addEventListener('click', async () => {
  if (active || calibrating || recording) {
    const wasRecording = recording;
    await stopTracking();
    if (wasRecording) recordStatus.textContent = 'Recording canceled.';
    return;
  }
  await startControl();
});

/** Holo Mode always opens with hand tracking running, so gestures work inside it. */
async function openHolo(): Promise<void> {
  if (!active && !(await startControl())) {
    message.textContent = 'Opening Holo Mode without gestures: hand tracking could not start.';
  }
  try {
    await invoke('enter_holo');
  } catch (error) {
    message.textContent = `Holo Mode could not start: ${String(error)}`;
  }
}

document.querySelector<HTMLButtonElement>('#holo-enter')!.addEventListener('click', () => void openHolo());
void listen('holo-request', () => void openHolo());
void listen('holo-start-tracking', () => void startControl());

calibrateButton.addEventListener('click', async () => {
  if (calibrating) { await finishCalibration(); return; }
  calibrateButton.disabled = true;
  button.disabled = true;
  modeSelect.disabled = true;
  lazySpeedInput.disabled = true;
  lazyDwellInput.disabled = true;
  recordButton.disabled = true;
  samples = [];
  message.textContent = 'Loading camera for reach calibration…';
  try {
    const { cameraMode: mode } = await tracker.start(onFrame, (error) => { void stopTracking(`Camera stopped: ${error.message}`); });
    cameraMode = `Camera mode ${mode.width}×${mode.height}${mode.frameRate ? ` @ ${mode.frameRate.toFixed(0)} fps negotiated` : ''}`;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    preview.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    calibrating = true;
    calibrateButton.textContent = 'Save reach';
    button.innerHTML = 'Cancel calibration <span>×</span>';
    message.textContent = 'Move your right hand to all comfortable limits, then save reach.';
  } catch (error) {
    tracker.stop();
    showCameraError(error, 'Calibration camera error');
  } finally {
    calibrateButton.disabled = false;
    recordButton.disabled = calibrating;
    button.disabled = false;
    modeSelect.disabled = calibrating;
    lazySpeedInput.disabled = calibrating;
    lazyDwellInput.disabled = calibrating;
  }
});

sensitivityInput.addEventListener('change', async () => {
  sensitivityInput.disabled = true;
  try {
    calibration = await invoke<Calibration>('set_sensitivity', { sensitivity: Number(sensitivityInput.value) });
    renderCalibration();
  } catch (error) {
    message.textContent = `Sensitivity error: ${String(error)}`;
    renderCalibration();
  } finally { sensitivityInput.disabled = false; }
});

modeSelect.addEventListener('change', async () => {
  modeSelect.disabled = true;
  try {
    settings = await invoke<ControlSettings>('set_control_settings', { settings: { ...settings, mode: modeSelect.value } });
    renderMode();
  } catch (error) {
    message.textContent = `Mode error: ${String(error)}`;
    renderMode();
  } finally { modeSelect.disabled = false; }
});

lazySpeedInput.addEventListener('change', async () => {
  lazySpeedInput.disabled = true;
  try {
    settings = await invoke<ControlSettings>('set_control_settings', { settings: { ...settings, lazy_speed: Number(lazySpeedInput.value) } });
    renderMode();
  } catch (error) {
    message.textContent = `Cursor speed error: ${String(error)}`;
    renderMode();
  } finally { lazySpeedInput.disabled = false; }
});

lazyDwellInput.addEventListener('change', async () => {
  lazyDwellInput.disabled = true;
  try {
    settings = await invoke<ControlSettings>('set_control_settings', { settings: { ...settings, lazy_dwell_ms: Math.round(Number(lazyDwellInput.value) * 1000) } });
    renderMode();
  } catch (error) {
    message.textContent = `Click delay error: ${String(error)}`;
    renderMode();
  } finally { lazyDwellInput.disabled = false; }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

recordButton.addEventListener('click', async () => {
  const name = gestureNameInput.value.trim();
  const action = gestureActionInput.value;
  if (!name || !action) {
    recordStatus.textContent = 'Enter a gesture name and choose a control first.';
    return;
  }
  recording = true;
  capturing = false;
  recordedFrames = [];
  const token = ++recordToken;
  recordButton.disabled = true;
  calibrateButton.disabled = true;
  button.disabled = true;
  modeSelect.disabled = true;
  lazySpeedInput.disabled = true;
  lazyDwellInput.disabled = true;
  renderBindings();
  recordStatus.textContent = 'Loading camera for gesture recording…';
  try {
    const { cameraMode: mode } = await tracker.start(onFrame, (error) => { void stopTracking(`Camera stopped: ${error.message}`); });
    if (token !== recordToken) return;
    cameraMode = `Camera mode ${mode.width}×${mode.height}${mode.frameRate ? ` @ ${mode.frameRate.toFixed(0)} fps negotiated` : ''}`;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    preview.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    button.innerHTML = 'Cancel recording <span>×</span>';
    button.disabled = false;
    for (const count of [3, 2, 1]) {
      recordStatus.textContent = `Get ready · ${count}`;
      previewLabel.textContent = String(count);
      await delay(1000);
      if (token !== recordToken) return;
    }
    capturing = true;
    previewLabel.textContent = 'RECORDING';
    recordStatus.textContent = 'Recording… move your right hand clearly in one direction.';
    await delay(1300);
    if (token !== recordToken) return;
    capturing = false;
    bindings = await invoke<GestureSummary[]>('record_custom_gesture', { name, action, frames: recordedFrames });
    await stopTracking('Gesture saved. Start control to use it.');
    recordStatus.textContent = `Saved ${name} → ${action.replaceAll('_', ' ')}`;
    renderBindings();
  } catch (error) {
    await stopTracking(`Gesture recording stopped: ${String(error)}`);
    recordStatus.textContent = `Recording error: ${String(error)}`;
  }
});
