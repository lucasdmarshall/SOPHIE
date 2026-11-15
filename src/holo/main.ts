import '@fontsource/poppins/latin-600.css';
import '@fontsource/plus-jakarta-sans/latin-400.css';
import '@fontsource/plus-jakarta-sans/latin-600.css';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { categoryFor, HoloScene, type QualityTier } from './scene';
import { applyThemeCss, PRESETS, prefersReducedMotion } from './theme';
import { wait } from './tween';
import { WindowManager, type HoloView } from './windows';
import { FxLayer } from './fx';
import { sound } from './sound';
import { AppDrawer, SHELL_MARKUP, Terminal } from './shell';
import type { CoreStyle, HandFrame, HoloEntry, HoloListing, HoloPlace, HoloTheme, LayoutStyle, QualitySetting, SceneLayout, TrackingStatus, WorldStyle } from './types';
import './holo.css';

const EXECUTABLE = new Set(['exe', 'msi', 'bat', 'cmd', 'ps1', 'vbs', 'scr', 'com', 'reg', 'js', 'wsf', 'hta']);
const SCRAMBLE = '▓▒░<>/\\|#%01ΔΣΞ';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

document.querySelector<HTMLDivElement>('#holo')!.innerHTML = `
  <canvas id="scene"></canvas>
  <div class="scanlines" aria-hidden="true"></div>
  <div class="vignette" aria-hidden="true"></div>
  <div id="labels" aria-hidden="true"></div>
  <div class="frame-corner tl"></div><div class="frame-corner tr"></div><div class="frame-corner bl"></div><div class="frame-corner br"></div>

  <header class="hud-top">
    <div class="brand"><span class="brand-glyph"></span><div><strong>SOPHIE</strong><small>HOLO MODE · SPATIAL FILE MATRIX</small></div></div>
    <nav class="crumbs" id="crumbs" aria-label="Current folder"></nav>
    <div class="link" id="link" data-state="offline">
      <span class="link-dot"></span>
      <div><strong id="link-title">HAND LINK OFFLINE</strong><small id="link-detail">Gestures are off</small></div>
      <button class="holo-button small" id="link-action">START</button>
    </div>
    <div class="clock"><strong id="clock-time">--:--</strong><small id="clock-date">—</small></div>
  </header>

  <aside class="dock panel" aria-label="Places">
    <span class="panel-title">NAV // PLACES</span>
    <div id="places"></div>
  </aside>

  <aside class="inspector callout panel" id="inspector" hidden>
    <span class="panel-title" id="inspect-kind">OBJECT</span>
    <h2 id="inspect-name" data-scramble></h2>
    <dl>
      <div><dt>TYPE</dt><dd id="inspect-type"></dd></div>
      <div><dt>SIZE</dt><dd id="inspect-size"></dd></div>
      <div><dt>MODIFIED</dt><dd id="inspect-date"></dd></div>
    </dl>
    <p class="inspect-path" id="inspect-path"></p>
    <p class="callout-hint" id="inspect-hint"></p>
    <button class="holo-button primary" id="inspect-open">OPEN <span>↗</span></button>
    <p class="confirm" id="inspect-confirm" hidden>This launches a program. Open it anyway?
      <span><button class="holo-button danger" id="confirm-yes">LAUNCH</button><button class="holo-button" id="confirm-no">CANCEL</button></span>
    </p>
  </aside>

  <aside class="telemetry panel" aria-label="System telemetry">
    <span class="panel-title">SYS // TELEMETRY</span>
    <div class="tele-row"><span>CPU</span><b id="tele-cpu">—</b><canvas id="spark-cpu" width="96" height="22"></canvas></div>
    <div class="tele-row"><span>MEM</span><b id="tele-mem">—</b><canvas id="spark-mem" width="96" height="22"></canvas></div>
    <div class="tele-row"><span>TRACK</span><b id="tele-track">—</b><canvas id="spark-track" width="96" height="22"></canvas></div>
    <div class="tele-foot"><span id="tele-hand">HAND —</span><span id="tele-up">UP —</span></div>
  </aside>
  <svg class="arc-ring tl" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="52"/><circle class="inner" cx="60" cy="60" r="40"/></svg>
  <svg class="arc-ring br" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="52"/><circle class="inner" cx="60" cy="60" r="40"/></svg>
  <div class="standby-note" aria-hidden="true"><b>STANDBY</b><span>MOVE YOUR HAND OR THE MOUSE TO WAKE</span></div>

  <div class="hover-chip" id="hover-chip" hidden></div>
  <div class="skeleton-panel" aria-hidden="true"><canvas id="skeleton" width="168" height="132"></canvas><span>HAND // SCAN</span></div>
  <div class="windows-layer" id="windows"></div>
  <div class="window-dock" id="window-dock" hidden>
    <div class="dock-chips"></div>
    <div class="dock-actions">
      <button data-arrange="tile" title="Tile windows">⊞ TILE</button>
      <button data-arrange="cascade" title="Cascade windows">❐ CASCADE</button>
      <button data-arrange="min" title="Minimize all">▁ HIDE</button>
      <button data-arrange="close" title="Close all" class="danger">✕ ALL</button>
    </div>
  </div>

  <footer class="hud-bottom">
    <div class="stats"><span><b id="stat-folders">0</b> FOLDERS</span><span><b id="stat-files">0</b> FILES</span><span id="stat-hidden"></span><span class="perf" id="perf"></span></div>
    <p class="hint">PINCH A FOLDER TO DIVE · PINCH + MOVE TO DRAG A FILE OR SPIN THE VIEW · 3 FINGERS TO RISE · ESC TO EXIT</p>
    <div class="actions">
      <button class="holo-button" id="btn-up">▲ UP</button>
      <button class="holo-button" id="btn-recenter">⌖ RECENTER</button>
      <button class="holo-button" id="btn-apps">▦ APPS</button>
      <button class="holo-button" id="btn-term">›_ SHELL</button>
      <button class="holo-button" id="btn-theme">◐ THEME</button>
      <button class="holo-button danger" id="btn-exit">⏻ EXIT</button>
    </div>
  </footer>

  <section class="theme-panel panel" id="theme-panel" hidden aria-label="Holo color theme">
    <span class="panel-title">CHROMA // THEME</span>
    <div class="presets" id="presets"></div>
    <div class="style-row"><span>WORLD</span><div class="segmented" id="world-styles"></div></div>
    <div class="style-row"><span>CORE</span><div class="segmented" id="core-styles"></div></div>
    <div class="style-row"><span>LAYOUT</span><div class="segmented" id="layout-styles"></div></div>
    <div class="style-row"><span>RENDER</span><div class="segmented" id="quality-styles"></div></div>
    <div class="color-row">
      <label>PRIMARY<input type="color" id="color-primary"></label>
      <label>SECONDARY<input type="color" id="color-secondary"></label>
      <label>ACCENT<input type="color" id="color-accent"></label>
    </div>
    <label class="range">GLOW <b id="glow-value">1.0</b><input type="range" id="glow" min="0" max="2" step="0.1"></label>
    <label class="range">SOUND <b id="volume-value">60%</b><input type="range" id="volume" min="0" max="1" step="0.05"></label>
    <div class="sound-row"><label class="toggle"><input type="checkbox" id="sound-on"> UI SOUND</label><button class="holo-button small" id="sound-test">▶ TEST</button></div>
    <label class="toggle"><input type="checkbox" id="reduced-motion"> REDUCE MOTION &amp; FLICKER</label>
  </section>

  ${SHELL_MARKUP}
  <div class="toast" id="toast" role="status"></div>

  <div class="boot" id="boot" hidden>
    <div class="boot-line"></div>
    <svg class="boot-rings" viewBox="0 0 400 400" aria-hidden="true">
      <circle class="r1" cx="200" cy="200" r="180"/><circle class="r2" cx="200" cy="200" r="150"/>
      <circle class="r3" cx="200" cy="200" r="118"/><circle class="r4" cx="200" cy="200" r="92"/>
    </svg>
    <div class="boot-text">
      <h1 id="boot-title">SOPHIE</h1>
      <p>HOLOGRAPHIC INTERFACE</p>
      <ul id="boot-checks"></ul>
    </div>
  </div>
  <div class="power-off" id="power-off" hidden></div>
  <canvas id="fx" aria-hidden="true"></canvas>
`;

const canvas = $<HTMLCanvasElement>('#scene');
const inspector = $<HTMLElement>('#inspector');
const hoverChip = $<HTMLElement>('#hover-chip');
const themePanel = $<HTMLElement>('#theme-panel');
const confirmBox = $<HTMLElement>('#inspect-confirm');
const toastEl = $<HTMLElement>('#toast');

let theme: HoloTheme = { preset: 'arc', primary: '#38e8ff', secondary: '#7c6bff', accent: '#ff4fd8', glow: 1, reduced_motion: false, core: 'reactor', layout: 'orbit', world: 'grid', quality: 'auto', sound: true, volume: 0.6 };

/** The hud and starmap worlds bring their own arrangement; the grid world uses the chosen layout. */
function sceneLayout(): SceneLayout {
  if (theme.world === 'hud') return 'dial';
  if (theme.world === 'starmap') return 'constellation';
  return theme.world === 'tunnel' ? 'tunnel' : theme.layout;
}
let calloutMode: 'scan' | 'pinned' | null = null;
let dwellTimer = 0;
/** Tier chosen by the governor while quality is 'auto'. */
let autoTier: QualityTier = 'high';
let lowSince = 0;
let lastStep = 0;
let bestTrackingFps = 0;
let lastTracking = 0;
let tracking: TrackingStatus = { running: false, armed: false, fps: 0, hands: 0, pose: 'clutch' };
let listing: HoloListing | null = null;
let currentPath = '';
let places: HoloPlace[] = [];
let selected: HoloEntry | null = null;
let busy = false;
let active = false;
let saveTimer = 0;

const scene = new HoloScene(canvas, $('#labels'), {
  hover: (entry) => showHover(entry),
  select: (entry) => void openFile(entry),
  activate: (entry) => void navigate(entry.path, 'down', entry),
  back: () => void goUp(),
});

const windows = new WindowManager($('#windows'), $('#window-dock'), {
  reduced: () => reduced(),
  colors: () => ({ primary: theme.primary, secondary: theme.secondary, accent: theme.accent }),
  openExternal: (path) => void openExternal(path),
  onChange: (count) => {
    $('#window-dock').hidden = count === 0;
    document.body.classList.toggle('has-windows', count > 0);
  },
});

const fx = new FxLayer($<HTMLCanvasElement>('#fx'), $<HTMLCanvasElement>('#skeleton'));
// Any real input lets audio start if the system began it suspended.
window.addEventListener('pointerdown', () => sound.unlock(), true);
window.addEventListener('keydown', () => sound.unlock(), true);

$('#sound-test').addEventListener('click', () => {
  sound.unlock();
  window.setTimeout(() => {
    sound.play('boot');
    const state = sound.state;
    if (state === 'running') toast('AUDIO // ONLINE');
    else if (state === 'off') toast('AUDIO // UI SOUND IS OFF OR VOLUME 0', 'error');
    else toast(`AUDIO // ${state.toUpperCase()} · CHECK WINDOWS VOLUME MIXER`, 'error');
  }, 120);
});

fx.onPress = (pressed, dragged) => {
  sound.play(pressed ? 'press' : dragged ? 'release' : 'select');
  if (pressed) {
    // A press means the user is acting, not reading: drop any pending or open analysis card.
    window.clearTimeout(dwellTimer);
    if (calloutMode === 'scan') closeInspector();
  }
};

// Interface elements tick softly under the cursor.
let lastHoverTarget: Element | null = null;
window.addEventListener('pointerover', (event) => {
  const target = (event.target as HTMLElement).closest('button, .place, .dock-chip, .crumb, .hwin-bar');
  if (target && target !== lastHoverTarget) sound.play('hover');
  lastHoverTarget = target;
});

function reduced(): boolean {
  return prefersReducedMotion(theme);
}

// ---------- Depth: HUD parallax and window tilt ----------

/** HUD pieces drift against the cursor so the interface reads as layers in front of the scene. */
const PARALLAX: [HTMLElement, number][] = [
  ['.hud-top', 7], ['.hud-bottom', 7], ['.dock', 11], ['.telemetry', 11], ['.skeleton-panel', 9], ['.arc-ring.tl', 14], ['.arc-ring.br', 14],
].map(([selector, depth]) => [$(selector as string), depth as number]);
const look = { x: 0, y: 0, tx: 0, ty: 0, px: -1, py: -1 };
let lastActivity = performance.now();
let standby = false;
/** Idle time before the interface drops into standby. */
const STANDBY_AFTER_MS = 60_000;

window.addEventListener(
  'pointermove',
  (event) => {
    look.tx = (event.clientX / window.innerWidth) * 2 - 1;
    look.ty = (event.clientY / window.innerHeight) * 2 - 1;
    look.px = event.clientX;
    look.py = event.clientY;
    markActive();
  },
  { passive: true },
);
window.addEventListener('keydown', () => markActive());

function markActive(): void {
  lastActivity = performance.now();
  if (standby) setStandby(false);
}

function setStandby(on: boolean): void {
  standby = on;
  document.body.classList.toggle('standby', on);
  scene.setStandby(on);
  if (!on) sound.play('toast');
}

let depthLooping = false;

function startDepthLoop(): void {
  if (depthLooping) return;
  depthLooping = true;
  requestAnimationFrame(depthLoop);
}

function depthLoop(): void {
  if (!active) {
    depthLooping = false;
    return;
  }
  requestAnimationFrame(depthLoop);
  if (!standby && performance.now() - lastActivity > STANDBY_AFTER_MS && !busy) setStandby(true);
  if (reduced()) return;
  const dx = look.tx - look.x;
  const dy = look.ty - look.y;
  if (Math.abs(dx) < 0.0005 && Math.abs(dy) < 0.0005) return;
  look.x += dx * 0.08;
  look.y += dy * 0.08;
  for (const [element, depth] of PARALLAX) {
    element.style.translate = `${(-look.x * depth).toFixed(2)}px ${(-look.y * depth * 0.6).toFixed(2)}px`;
  }
  if (look.px >= 0) windows.tilt(look.px, look.py);
}

// ---------- Telemetry ----------

interface Telemetry {
  cpu: number;
  mem_used: number;
  mem_total: number;
  uptime_ms: number;
}

const history: Record<'cpu' | 'mem' | 'track', number[]> = { cpu: [], mem: [], track: [] };
const HISTORY = 40;

function spark(id: string, values: number[], max: number): void {
  const canvasEl = $<HTMLCanvasElement>(id);
  const context = canvasEl.getContext('2d');
  if (!context) return;
  const { width, height } = canvasEl;
  context.clearRect(0, 0, width, height);
  if (values.length < 2) return;
  // --p is set straight from theme.primary, so read it there instead of forcing style resolution.
  const color = theme.primary || '#38e8ff';
  context.beginPath();
  values.forEach((value, i) => {
    const x = (i / (HISTORY - 1)) * width;
    const y = height - 1 - (Math.min(value, max) / max) * (height - 3);
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = color;
  context.lineWidth = 1.2;
  context.shadowColor = color;
  context.shadowBlur = 4;
  context.stroke();
  context.lineTo(((values.length - 1) / (HISTORY - 1)) * width, height);
  context.lineTo(0, height);
  context.closePath();
  context.globalAlpha = 0.12;
  context.fillStyle = color;
  context.fill();
  context.globalAlpha = 1;
}

function push(series: number[], value: number): void {
  series.push(value);
  if (series.length > HISTORY) series.shift();
}

function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days}D ${hours % 24}H`;
  return `${hours}H ${String(minutes % 60).padStart(2, '0')}M`;
}

async function sampleTelemetry(): Promise<void> {
  if (!active || document.hidden) return;
  try {
    const value = await invoke<Telemetry>('holo_telemetry');
    push(history.cpu, value.cpu);
    const memPercent = value.mem_total ? (value.mem_used / value.mem_total) * 100 : 0;
    push(history.mem, memPercent);
    $('#tele-cpu').textContent = `${value.cpu.toFixed(0)}%`;
    $('#tele-mem').textContent = value.mem_total ? `${(value.mem_used / 2 ** 30).toFixed(1)}/${(value.mem_total / 2 ** 30).toFixed(0)}G` : '—';
    $('#tele-up').textContent = `UP ${formatUptime(value.uptime_ms)}`;
    spark('#spark-cpu', history.cpu, 100);
    spark('#spark-mem', history.mem, 100);
  } catch {
    /* Telemetry is optional; the panel keeps its last values. */
  }
  push(history.track, tracking.running ? tracking.fps : 0);
  $('#tele-track').textContent = tracking.running ? `${tracking.fps.toFixed(0)} FPS` : 'OFF';
  spark('#spark-track', history.track, 60);
}
window.setInterval(() => void sampleTelemetry(), 1000);

/** The live landmark readout: index fingertip position in camera space. */
function renderHandReadout(frame: HandFrame | null): void {
  const tip = frame?.points?.[8];
  $('#tele-hand').textContent = tip ? `TIP ${tip[0].toFixed(3)} · ${tip[1].toFixed(3)}` : 'HAND —';
}

/** Decode text in from random glyphs, left to right. */
function scramble(element: HTMLElement, text: string, duration = 420): void {
  if (reduced()) {
    element.textContent = text;
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / duration);
    const fixed = Math.floor(text.length * progress);
    let out = text.slice(0, fixed);
    for (let i = fixed; i < text.length; i += 1) {
      out += text[i] === ' ' ? ' ' : SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)];
    }
    element.textContent = out;
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  sound.play(kind === 'error' ? 'error' : 'toast');
  toastEl.className = `toast show ${kind}`;
  scramble(toastEl, text, 300);
  window.clearTimeout(Number(toastEl.dataset.timer));
  toastEl.dataset.timer = String(window.setTimeout(() => toastEl.classList.remove('show'), 2600));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatDate(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Count a byte size up from zero, like a readout settling. */
function rollUp(element: HTMLElement, bytes: number): void {
  if (reduced()) {
    element.textContent = formatSize(bytes);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / 480);
    element.textContent = formatSize(Math.round(bytes * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function showHover(entry: HoloEntry | null): void {
  window.clearTimeout(dwellTimer);
  hoverChip.hidden = entry === null;
  if (!entry) {
    if (calloutMode === 'scan') closeInspector();
    return;
  }
  sound.play('hover');
  // Resting on an object for a moment runs an analysis scan beside it.
  if (calloutMode !== 'pinned') dwellTimer = window.setTimeout(() => inspect(entry, 'scan'), 420);
  hoverChip.innerHTML = `<span>${entry.is_dir ? 'FOLDER' : categoryFor(entry).toUpperCase()}</span>`;
  const name = document.createElement('strong');
  hoverChip.append(name);
  scramble(name, entry.name, 220);
}

function inspect(entry: HoloEntry, mode: 'scan' | 'pinned' = 'pinned'): void {
  if (mode === 'pinned') selected = entry;
  calloutMode = mode;
  confirmBox.hidden = true;
  inspector.hidden = false;
  inspector.classList.toggle('pinned', mode === 'pinned');
  $('#inspect-open').hidden = mode !== 'pinned';
  $('#inspect-hint').textContent = mode === 'pinned' ? '' : entry.is_dir ? 'PINCH TO DIVE IN' : 'PINCH TO OPEN';
  fx.linkCallout({ anchor: () => scene.screenPoint(entry.path), element: inspector, born: performance.now() });
  sound.play('scan');
  if (!reduced()) [140, 230, 320].forEach((delay) => window.setTimeout(() => sound.play('tick'), delay));
  inspector.classList.remove('enter');
  void inspector.offsetWidth;
  inspector.classList.add('enter');
  $('#inspect-kind').textContent = `OBJECT // ${categoryFor(entry).toUpperCase()}`;
  scramble($('#inspect-name'), entry.name);
  $('#inspect-type').textContent = entry.extension ? `.${entry.extension}` : categoryFor(entry);
  if (entry.is_dir) $('#inspect-size').textContent = '—';
  else rollUp($('#inspect-size'), entry.size);
  $('#inspect-date').textContent = formatDate(entry.modified_ms);
  $('#inspect-path').textContent = entry.path;
}

function closeInspector(): void {
  inspector.hidden = true;
  calloutMode = null;
  fx.linkCallout(null);
  selected = null;
  scene.clearSelection();
}

async function openExternal(path: string): Promise<void> {
  try {
    await invoke('holo_open', { path });
    toast('HANDED OFF // WINDOWS APP');
  } catch (error) {
    toast(String(error).toUpperCase(), 'error');
  }
}

/** Open a file in a holo window when SOPHIE has a viewer for it, otherwise show its details. */
async function openFile(entry: HoloEntry): Promise<void> {
  try {
    const view = await invoke<HoloView>('holo_view', { path: entry.path });
    if (view.kind === 'external') {
      inspect(entry);
      return;
    }
    closeInspector();
    windows.open(view, scene.screenPoint(entry.path));
  } catch (error) {
    toast(String(error).toUpperCase(), 'error');
  }
}

async function openSelected(force = false): Promise<void> {
  if (!selected) return;
  if (!force && EXECUTABLE.has(selected.extension)) {
    confirmBox.hidden = false;
    return;
  }
  try {
    await invoke('holo_open', { path: selected.path });
    toast(`LAUNCHED // ${selected.name}`);
  } catch (error) {
    toast(String(error).toUpperCase(), 'error');
  }
}

function renderCrumbs(path: string): void {
  const crumbs = $<HTMLElement>('#crumbs');
  crumbs.replaceChildren();
  const parts = path.split(/[\\/]/).filter(Boolean);
  let built = '';
  parts.forEach((part, index) => {
    built = index === 0 ? `${part}\\` : `${built}${index > 1 ? '\\' : ''}${part}`;
    const target = built;
    const button = document.createElement('button');
    button.className = index === parts.length - 1 ? 'crumb current' : 'crumb';
    scramble(button, part, 260 + index * 60);
    button.addEventListener('click', () => {
      if (target !== currentPath) void navigate(target, 'up');
    });
    crumbs.append(button);
  });
}

function renderStats(value: HoloListing): void {
  const folders = value.entries.filter((entry) => entry.is_dir).length;
  $('#stat-folders').textContent = String(folders);
  $('#stat-files').textContent = String(value.entries.length - folders);
  $('#stat-hidden').textContent = value.hidden_count ? `+${value.hidden_count} NOT SHOWN` : '';
}

function renderPlaces(): void {
  const container = $<HTMLElement>('#places');
  container.replaceChildren();
  for (const place of places) {
    const button = document.createElement('button');
    button.className = `place kind-${place.kind}`;
    button.innerHTML = '<i></i><span></span>';
    button.querySelector('span')!.textContent = place.label.toUpperCase();
    button.dataset.path = place.path;
    button.addEventListener('click', () => void navigate(place.path, 'enter'));
    container.append(button);
  }
}

function markActivePlace(): void {
  document.querySelectorAll<HTMLButtonElement>('.place').forEach((button) => {
    button.classList.toggle('active', button.dataset.path === currentPath);
  });
}

async function navigate(path: string, kind: 'enter' | 'down' | 'up', target?: HoloEntry): Promise<void> {
  if (busy) return;
  busy = true;
  closeInspector();
  try {
    const request = invoke<HoloListing>('holo_list', { path });
    if (listing && kind !== 'enter') sound.play(kind === 'up' ? 'rise' : 'dive');
    const leaving = listing ? scene.leave(kind === 'up' ? 'up' : 'down', target) : Promise.resolve();
    const [next] = await Promise.all([request, leaving]);
    if (kind === 'down' && !reduced()) {
      document.body.classList.remove('warp');
      void document.body.offsetWidth;
      document.body.classList.add('warp');
    }
    listing = next;
    currentPath = next.path;
    renderCrumbs(next.path);
    renderStats(next);
    markActivePlace();
    await scene.show(next, kind, sceneLayout());
  } catch (error) {
    toast(`ACCESS DENIED // ${String(error).toUpperCase()}`, 'error');
    if (listing) await scene.show(listing, 'enter', sceneLayout());
  } finally {
    busy = false;
  }
}

async function goUp(): Promise<void> {
  if (listing?.parent && listing.parent !== listing.path) await navigate(listing.parent, 'up');
}

async function runBoot(): Promise<void> {
  const boot = $<HTMLElement>('#boot');
  const checks = $<HTMLElement>('#boot-checks');
  checks.replaceChildren();
  boot.hidden = false;
  boot.className = 'boot';
  void boot.offsetWidth;
  boot.classList.add('run');
  sound.play('boot');
  const scenePromise = scene.boot();
  if (reduced()) {
    $('#boot-title').textContent = 'SOPHIE';
    await wait(350);
  } else {
    await wait(380);
    scramble($('#boot-title'), 'SOPHIE', 700);
    const lines = ['OPTICAL HAND LINK', 'SPATIAL GRID', 'FILE MATRIX', 'CHROMA ENGINE'];
    for (const line of lines) {
      await wait(170);
      const item = document.createElement('li');
      item.innerHTML = `<span>${line}</span><i></i><b>ONLINE</b>`;
      checks.append(item);
    }
    await wait(420);
  }
  boot.classList.add('out');
  await Promise.all([scenePromise, wait(reduced() ? 150 : 600)]);
  boot.hidden = true;
}

async function enterHolo(): Promise<void> {
  if (active) return;
  active = true;
  lastActivity = performance.now();
  if (standby) setStandby(false);
  document.body.classList.remove('powering-off');
  $('#power-off').hidden = true;
  scene.start();
  fx.start();
  sound.resume();
  startDepthLoop();
  tickClock();
  renderLink();
  renderPerf();
  void emitTo('main', 'holo-visibility', true).catch(() => {});
  const boot = runBoot();
  if (!currentPath) currentPath = places.find((place) => place.kind === 'home')?.path ?? places[0]?.path ?? 'C:\\';
  listing = null;
  await wait(reduced() ? 0 : 900);
  await navigate(currentPath, 'enter');
  await boot;
}

async function exitHolo(): Promise<void> {
  if (!active) return;
  active = false;
  themePanel.hidden = true;
  windows.closeAll();
  closeInspector();
  const powerOff = $<HTMLElement>('#power-off');
  sound.play('power');
  await scene.powerDown();
  if (!reduced()) {
    powerOff.hidden = false;
    document.body.classList.add('powering-off');
    await wait(480);
  }
  scene.stop();
  fx.stop();
  sound.suspend();
  void emitTo('main', 'holo-visibility', false).catch(() => {});
  try {
    await invoke('exit_holo');
  } catch {
    /* The window may already be hidden. */
  }
}

function syncThemeInputs(): void {
  $<HTMLInputElement>('#volume').value = String(theme.volume);
  $('#volume-value').textContent = `${Math.round(theme.volume * 100)}%`;
  $<HTMLInputElement>('#sound-on').checked = theme.sound;
  $<HTMLInputElement>('#color-primary').value = theme.primary;
  $<HTMLInputElement>('#color-secondary').value = theme.secondary;
  $<HTMLInputElement>('#color-accent').value = theme.accent;
  $<HTMLInputElement>('#glow').value = String(theme.glow);
  $('#glow-value').textContent = theme.glow.toFixed(1);
  $<HTMLInputElement>('#reduced-motion').checked = theme.reduced_motion;
  document.querySelectorAll<HTMLButtonElement>('.preset').forEach((button) => {
    button.classList.toggle('active', button.dataset.id === theme.preset);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-world]').forEach((button) => {
    button.classList.toggle('active', button.dataset.world === theme.world);
  });
  // Centerpiece and layout only apply to the grid world.
  for (const id of ['#core-styles', '#layout-styles']) {
    $<HTMLElement>(id).parentElement?.classList.toggle('is-off', theme.world !== 'grid');
  }
  document.querySelectorAll<HTMLButtonElement>('[data-core]').forEach((button) => {
    button.classList.toggle('active', button.dataset.core === theme.core);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((button) => {
    button.classList.toggle('active', button.dataset.layout === theme.layout);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-quality]').forEach((button) => {
    button.classList.toggle('active', button.dataset.quality === theme.quality);
  });
}

function applyQuality(): void {
  const tier: QualityTier = theme.quality === 'auto' ? autoTier : theme.quality;
  if (tier !== scene.qualityTier) scene.setQuality(tier);
  document.documentElement.dataset.tier = tier;
}

/**
 * Hand tracking and this scene share the GPU. While quality is 'auto', step the scene
 * down whenever tracking falls clearly below what the camera delivered on its own.
 */
function governQuality(status: TrackingStatus): void {
  if (!status.running || !status.armed || status.hands === 0) {
    lowSince = 0;
    return;
  }
  bestTrackingFps = Math.max(bestTrackingFps, status.fps);
  if (theme.quality !== 'auto' || !active || autoTier === 'saver') return;
  const now = performance.now();
  const low = bestTrackingFps >= 20 && status.fps < Math.min(22, bestTrackingFps * 0.8);
  if (!low) {
    lowSince = 0;
    return;
  }
  if (!lowSince) lowSince = now;
  if (now - lowSince > 1500 && now - lastStep > 3000) {
    autoTier = autoTier === 'high' ? 'balanced' : 'saver';
    lastStep = now;
    lowSince = 0;
    applyQuality();
    toast(`RENDER // ${autoTier.toUpperCase()} · PROTECTING HAND TRACKING`);
  }
}

function renderPerf(): void {
  const tier = scene.qualityTier.toUpperCase();
  const track = tracking.running ? `${tracking.fps.toFixed(0)}` : '—';
  $('#perf').innerHTML = `RENDER <b>${scene.renderFps.toFixed(0)}</b> · TRACK <b>${track}</b> · <b>${theme.quality === 'auto' ? `AUTO/${tier}` : tier}</b>`;
}

function renderStyles(): void {
  const cores: [CoreStyle, string][] = [['reactor', 'REACTOR'], ['atom', 'ATOM'], ['tesseract', 'TESSERACT'], ['none', 'NONE']];
  const layouts: [LayoutStyle, string][] = [['orbit', 'ORBIT'], ['spiral', 'SPIRAL'], ['wall', 'WALL'], ['helix', 'HELIX'], ['globe', 'GLOBE'], ['neural', 'NEURAL']];
  const worlds: [WorldStyle, string][] = [['grid', 'GRID'], ['hud', 'JARVIS HUD'], ['starmap', 'STAR MAP'], ['tunnel', 'TUNNEL']];
  for (const [id, name] of worlds) {
    const button = document.createElement('button');
    button.dataset.world = id;
    button.textContent = name;
    button.addEventListener('click', () => applyTheme({ ...theme, world: id }, true));
    $('#world-styles').append(button);
  }
  for (const [id, name] of cores) {
    const button = document.createElement('button');
    button.dataset.core = id;
    button.textContent = name;
    button.addEventListener('click', () => applyTheme({ ...theme, core: id }, true));
    $('#core-styles').append(button);
  }
  const qualities: [QualitySetting, string][] = [['auto', 'AUTO'], ['high', 'HIGH'], ['balanced', 'BALANCED'], ['saver', 'SAVER']];
  for (const [id, name] of qualities) {
    const button = document.createElement('button');
    button.dataset.quality = id;
    button.textContent = name;
    button.addEventListener('click', () => applyTheme({ ...theme, quality: id }, true));
    $('#quality-styles').append(button);
  }
  for (const [id, name] of layouts) {
    const button = document.createElement('button');
    button.dataset.layout = id;
    button.textContent = name;
    button.addEventListener('click', () => applyTheme({ ...theme, layout: id }, true));
    $('#layout-styles').append(button);
  }
}

/** Show whether hand tracking is feeding gestures, so a silent failure is visible. */
function renderLink(): void {
  const link = $<HTMLElement>('#link');
  const action = $<HTMLButtonElement>('#link-action');
  const stale = tracking.running && performance.now() - lastTracking > 2500;
  let state: string;
  let title: string;
  let detail: string;
  if (!tracking.running) {
    state = 'offline'; title = 'HAND LINK OFFLINE'; detail = 'Gestures are off';
  } else if (stale) {
    state = 'lost'; title = 'SIGNAL LOST'; detail = 'No camera frames';
  } else if (!tracking.armed) {
    state = 'paused'; title = 'CONTROL PAUSED'; detail = 'No hand for a while';
  } else if (tracking.hands === 0) {
    state = 'searching'; title = 'SEARCHING'; detail = 'Show your right hand';
  } else {
    state = 'live'; title = 'HAND LINK'; detail = `${tracking.pose.replace('_', ' ').toUpperCase()} · ${tracking.fps.toFixed(0)} FPS`;
  }
  link.dataset.state = state;
  $('#link-title').textContent = title;
  $('#link-detail').textContent = detail;
  action.hidden = !(state === 'offline' || state === 'paused');
  action.textContent = state === 'paused' ? 'RESUME' : 'START';
}

function applyTheme(next: HoloTheme, persist: boolean): void {
  theme = { ...next, world: next.world ?? 'grid' };
  const relayout = listing !== null && active && !busy && sceneLayout() !== scene.currentLayout;
  applyThemeCss(theme);
  scene.setTheme(theme, reduced());
  fx.setColors(theme.primary, theme.secondary, theme.accent);
  fx.setReduced(reduced());
  sound.configure(theme.sound, theme.volume, theme.primary);
  applyQuality();
  syncThemeInputs();
  if (relayout && listing) {
    busy = true;
    void scene.show(listing, 'enter', sceneLayout()).finally(() => { busy = false; });
  }
  if (!persist) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    invoke<HoloTheme>('set_holo_theme', { theme }).catch((error) => toast(`THEME NOT SAVED // ${String(error)}`, 'error'));
  }, 250);
}

function renderPresets(): void {
  const container = $<HTMLElement>('#presets');
  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.className = 'preset';
    button.dataset.id = preset.id;
    button.style.setProperty('--sw-p', preset.primary);
    button.style.setProperty('--sw-s', preset.secondary);
    button.style.setProperty('--sw-a', preset.accent);
    button.innerHTML = '<span class="swatch"><i></i><i></i><i></i></span><b></b>';
    button.querySelector('b')!.textContent = preset.name.toUpperCase();
    button.addEventListener('click', () => {
      applyTheme({ ...theme, preset: preset.id, primary: preset.primary, secondary: preset.secondary, accent: preset.accent }, true);
      toast(`CHROMA // ${preset.name.toUpperCase()}`);
    });
    container.append(button);
  }
}

function bindThemeInputs(): void {
  for (const key of ['primary', 'secondary', 'accent'] as const) {
    $<HTMLInputElement>(`#color-${key}`).addEventListener('input', (event) => {
      applyTheme({ ...theme, preset: 'custom', [key]: (event.target as HTMLInputElement).value }, true);
    });
  }
  $<HTMLInputElement>('#glow').addEventListener('input', (event) => {
    applyTheme({ ...theme, glow: Number((event.target as HTMLInputElement).value) }, true);
  });
  $<HTMLInputElement>('#volume').addEventListener('input', (event) => {
    applyTheme({ ...theme, volume: Number((event.target as HTMLInputElement).value) }, true);
  });
  $<HTMLInputElement>('#volume').addEventListener('change', () => sound.play('select'));
  $<HTMLInputElement>('#sound-on').addEventListener('change', (event) => {
    applyTheme({ ...theme, sound: (event.target as HTMLInputElement).checked }, true);
    sound.play('select');
  });
  $<HTMLInputElement>('#reduced-motion').addEventListener('change', (event) => {
    applyTheme({ ...theme, reduced_motion: (event.target as HTMLInputElement).checked }, true);
  });
}

function tickClock(): void {
  const now = new Date();
  $('#clock-time').textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  $('#clock-date').textContent = now.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
}

$('#inspect-open').addEventListener('click', () => void openSelected());
$('#confirm-yes').addEventListener('click', () => {
  confirmBox.hidden = true;
  void openSelected(true);
});
$('#confirm-no').addEventListener('click', () => (confirmBox.hidden = true));
$('#btn-up').addEventListener('click', () => void goUp());
$('#btn-recenter').addEventListener('click', () => scene.recenter());
$('#window-dock').querySelector('.dock-actions')!.addEventListener('click', (event) => {
  const action = (event.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.arrange;
  if (action === 'tile') windows.tile();
  else if (action === 'cascade') windows.cascade();
  else if (action === 'min') windows.minimizeAll();
  else if (action === 'close') windows.closeAll();
});
$('#link-action').addEventListener('click', () => {
  if (tracking.running) {
    invoke<TrackingStatus>('resume_control').catch(() => {});
  } else {
    void emitTo('main', 'holo-start-tracking').catch(() => {});
    toast('STARTING HAND LINK');
  }
});
$('#btn-exit').addEventListener('click', () => void exitHolo());
$('#btn-theme').addEventListener('click', () => {
  themePanel.hidden = !themePanel.hidden;
});

const drawer = new AppDrawer(toast);
const terminal = new Terminal(toast);
$('#btn-apps').addEventListener('click', () => drawer.toggle());
$('#btn-term').addEventListener('click', () => terminal.toggle());

window.addEventListener('keydown', (event) => {
  if (!active) return;
  // While the user types (search box, terminal), letters are text, not shortcuts.
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (typing && event.key !== 'Escape') return;
  if (event.key === 'Escape') {
    if (drawer.open) drawer.close();
    else if (terminal.open && typing) terminal.close();
    else if (!themePanel.hidden) themePanel.hidden = true;
    else if (!inspector.hidden) closeInspector();
    else if (windows.closeFocused()) { /* Closed the front window. */ }
    else void exitHolo();
  } else if (event.key === 'Backspace') {
    void goUp();
  } else if (event.key.toLowerCase() === 'r') {
    scene.recenter();
  } else if (event.key.toLowerCase() === 't') {
    themePanel.hidden = !themePanel.hidden;
  } else if (event.key.toLowerCase() === 'a') {
    event.preventDefault();
    drawer.toggle();
  } else if (event.key === '`') {
    event.preventDefault();
    terminal.toggle();
  } else if (event.key === 'Enter' && selected) {
    void openSelected();
  }
});

renderPresets();
renderStyles();
bindThemeInputs();
renderLink();
// HUD readouts only tick while Holo Mode is on screen.
window.setInterval(() => {
  if (!active) return;
  renderLink();
  renderPerf();
}, 500);
tickClock();
window.setInterval(() => {
  if (active) tickClock();
}, 1000);
applyTheme(theme, false);

void (async () => {
  try {
    applyTheme(await invoke<HoloTheme>('get_holo_theme'), false);
  } catch {
    /* Defaults stay. */
  }
  try {
    places = await invoke<HoloPlace[]>('holo_places');
    renderPlaces();
  } catch {
    places = [];
  }
  await listen('holo-enter', () => void enterHolo());
  let lastHandText = 0;
  await listen<HandFrame | null>('holo-hand', ({ payload }) => {
    fx.setHand(payload);
    if (payload) markActive();
    // The readout changes every frame; a few updates a second is plenty to read.
    const now = performance.now();
    if (now - lastHandText > 150) {
      lastHandText = now;
      renderHandReadout(payload);
    }
  });
  await listen('holo-exit', () => {
    fx.stop();
    sound.suspend();
    void emitTo('main', 'holo-visibility', false).catch(() => {});
    active = false;
    scene.stop();
  });
  await listen<HoloTheme>('holo-theme', ({ payload }) => applyTheme(payload, false));
  await listen<TrackingStatus>('holo-tracking', ({ payload }) => {
    tracking = payload;
    lastTracking = performance.now();
    governQuality(payload);
    if (active) renderLink();
  });
  // This window is built on first entry and freed a while after exit. A freshly loaded
  // page missed the `holo-enter` event, so ask whether to enter and where it left off.
  try {
    const resume = await invoke<{ enter: boolean; path: string }>('holo_ready');
    if (resume.path && !currentPath) currentPath = resume.path;
    if (resume.enter) void enterHolo();
  } catch {
    /* Older backend: entry arrives as the holo-enter event. */
  }
})();
