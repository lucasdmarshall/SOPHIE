import { convertFileSrc } from '@tauri-apps/api/core';
import { sound } from './sound';
import { chartData, mountChart, mountModel, parseTable, type ViewerColors } from './viewer3d';

export interface HoloView {
  kind: 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'model' | 'data' | 'external';
  name: string;
  path: string;
  extension: string;
  size: number;
  text: string | null;
  truncated: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface HoloWindow {
  id: number;
  view: HoloView;
  el: HTMLElement;
  chip: HTMLButtonElement;
  rect: Rect;
  restore: Rect | null;
  minimized: boolean;
  /** Frees GPU resources held by 3D viewers. */
  dispose: (() => void) | null;
}

interface Options {
  reduced: () => boolean;
  colors: () => ViewerColors;
  openExternal: (path: string) => void;
  onChange: (count: number) => void;
}

type Snap = 'left' | 'right' | 'max' | null;

const KIND_LABEL: Record<HoloView['kind'], string> = {
  image: 'IMG', video: 'VID', audio: 'AUD', pdf: 'PDF', text: 'TXT', model: '3D', data: 'DAT', external: 'EXT',
};
const DEFAULT_SIZE: Record<HoloView['kind'], [number, number]> = {
  image: [760, 540], video: [860, 520], audio: [480, 340], pdf: [780, 680], text: [760, 580], model: [720, 560], data: [880, 580], external: [480, 300],
};
/** Largest tilt toward the cursor, in degrees. */
const MAX_TILT = 3.5;
const MIN_W = 340;
const MIN_H = 230;
const MAX_WINDOWS = 10;
/** Distance from a screen edge that triggers snapping while dragging. */
const SNAP_EDGE = 28;

export function formatBytes(bytes: number): string {
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

/** SOPHIE's own floating windows inside Holo Mode. */
export class WindowManager {
  private windows: HoloWindow[] = [];
  private nextId = 1;
  private topZ = 10;
  private focused: HoloWindow | null = null;
  private readonly ghost: HTMLElement;

  constructor(
    private readonly layer: HTMLElement,
    private readonly dock: HTMLElement,
    private readonly options: Options,
  ) {
    this.ghost = document.createElement('div');
    this.ghost.className = 'snap-ghost';
    this.ghost.hidden = true;
    this.layer.append(this.ghost);
    window.addEventListener('resize', () => {
      for (const win of this.windows) {
        if (win.restore) this.place(win, this.workArea());
        else this.place(win, this.clamp(win.rect));
      }
    });
  }

  get count(): number {
    return this.windows.length;
  }

  /** Area windows may occupy: below the top HUD, above the dock and footer. */
  private workArea(): Rect {
    const top = 104;
    const bottom = 150;
    return { x: 24, y: top, w: window.innerWidth - 48, h: window.innerHeight - top - bottom };
  }

  private clamp(rect: Rect): Rect {
    const area = this.workArea();
    const w = Math.min(Math.max(rect.w, MIN_W), area.w);
    const h = Math.min(Math.max(rect.h, MIN_H), area.h);
    return {
      w,
      h,
      x: Math.min(Math.max(rect.x, area.x - w + 120), area.x + area.w - 120),
      y: Math.min(Math.max(rect.y, area.y), area.y + area.h - 46),
    };
  }

  private place(win: HoloWindow, rect: Rect): void {
    win.rect = rect;
    const style = win.el.style;
    style.left = `${rect.x}px`;
    style.top = `${rect.y}px`;
    style.width = `${rect.w}px`;
    style.height = `${rect.h}px`;
  }

  open(view: HoloView, origin?: { x: number; y: number }): void {
    const existing = this.windows.find((win) => win.view.path === view.path);
    if (existing) {
      if (existing.minimized) this.restoreFromDock(existing);
      this.focus(existing);
      this.pulse(existing);
      return;
    }
    if (this.windows.length >= MAX_WINDOWS) this.close(this.windows[0], true);

    const area = this.workArea();
    const [dw, dh] = DEFAULT_SIZE[view.kind];
    const offset = (this.windows.length % 6) * 34;
    const rect = this.clamp({
      w: dw,
      h: dh,
      x: area.x + (area.w - dw) / 2 + offset - 85,
      y: area.y + (area.h - dh) / 2 + offset - 60,
    });

    const el = document.createElement('section');
    el.className = `hwin kind-${view.kind}`;
    el.innerHTML = `
      <header class="hwin-bar">
        <i class="hwin-kind">${KIND_LABEL[view.kind]}</i>
        <strong class="hwin-title"></strong>
        <span class="hwin-meta">${formatBytes(view.size)}</span>
        <div class="hwin-ctrl">
          <button data-act="min" title="Minimize">▁</button>
          <button data-act="max" title="Maximize">▢</button>
          <button data-act="ext" title="Open in Windows app">↗</button>
          <button data-act="close" class="danger" title="Close">✕</button>
        </div>
      </header>
      <div class="hwin-body"></div>
      <div class="hwin-resize" aria-hidden="true"></div>
      <span class="hwin-corner c1"></span><span class="hwin-corner c2"></span>`;
    el.querySelector('.hwin-title')!.textContent = view.name;
    const chip = document.createElement('button');
    chip.className = 'dock-chip';
    chip.innerHTML = `<i>${KIND_LABEL[view.kind]}</i><span></span>`;
    chip.querySelector('span')!.textContent = view.name;

    const win: HoloWindow = { id: this.nextId++, view, el, chip, rect, restore: null, minimized: false, dispose: null };
    this.windows.push(win);
    this.layer.append(el);
    this.place(win, rect);
    this.renderBody(win);
    this.bind(win);
    this.dock.querySelector('.dock-chips')!.append(chip);
    this.focus(win);
    this.options.onChange(this.windows.length);
    sound.play('open');

    const fromX = (origin?.x ?? rect.x + rect.w / 2) - (rect.x + rect.w / 2);
    const fromY = (origin?.y ?? rect.y + rect.h / 2) - (rect.y + rect.h / 2);
    el.animate(
      [
        { transform: `translate(${fromX}px, ${fromY}px) scale(0.04, 0.01)`, opacity: 0, filter: 'brightness(4)' },
        { transform: `translate(${fromX * 0.3}px, ${fromY * 0.3}px) scale(0.9, 0.02)`, opacity: 1, filter: 'brightness(3)', offset: 0.45 },
        { transform: 'none', opacity: 1, filter: 'none' },
      ],
      { duration: this.options.reduced() ? 140 : 560, easing: 'cubic-bezier(.2,.9,.2,1)' },
    );
    // After the frame unfolds, the contents scan in behind a light bar.
    if (!this.options.reduced()) {
      el.classList.add('materialize');
      window.setTimeout(() => el.classList.remove('materialize'), 1400);
    }
  }

  /** Lean each window slightly toward the cursor; unfocused windows sit further back. */
  tilt(x: number, y: number): void {
    const reduced = this.options.reduced();
    for (const win of this.windows) {
      const style = win.el.style;
      if (reduced || win.minimized || win.restore || win.el.classList.contains('dragging')) {
        style.rotate = '';
        continue;
      }
      const dx = Math.max(-1, Math.min(1, (x - (win.rect.x + win.rect.w / 2)) / (window.innerWidth / 2)));
      const dy = Math.max(-1, Math.min(1, (y - (win.rect.y + win.rect.h / 2)) / (window.innerHeight / 2)));
      const angle = Math.min(1, Math.hypot(dx, dy)) * MAX_TILT;
      style.rotate = angle < 0.05 ? '' : `${(-dy).toFixed(3)} ${dx.toFixed(3)} 0 ${angle.toFixed(2)}deg`;
    }
  }

  private renderBody(win: HoloWindow): void {
    const body = win.el.querySelector<HTMLElement>('.hwin-body')!;
    const { view } = win;
    const fail = () => {
      body.innerHTML = '<div class="hwin-error"><b>SIGNAL CORRUPT</b><span>This file could not be decoded here.</span><button class="holo-button">OPEN IN WINDOWS APP ↗</button></div>';
      body.querySelector('button')!.addEventListener('click', () => this.options.openExternal(view.path));
    };
    const src = () => convertFileSrc(view.path);
    if (view.kind === 'image') {
      const img = document.createElement('img');
      img.className = 'viewer-image';
      img.alt = view.name;
      img.src = src();
      img.addEventListener('error', fail, { once: true });
      img.addEventListener('click', () => body.classList.toggle('actual-size'));
      body.append(img);
    } else if (view.kind === 'video') {
      const video = document.createElement('video');
      video.className = 'viewer-video';
      video.controls = true;
      video.autoplay = true;
      video.src = src();
      video.addEventListener('error', fail, { once: true });
      body.append(video);
    } else if (view.kind === 'audio') {
      body.innerHTML = `
        <div class="viewer-audio">
          <div class="audio-orb"><i></i><i></i><i></i><b>♪</b></div>
          <strong></strong>
          <audio controls autoplay></audio>
        </div>`;
      body.querySelector('strong')!.textContent = view.name;
      const audio = body.querySelector('audio')!;
      audio.src = src();
      audio.addEventListener('play', () => body.classList.add('playing'));
      audio.addEventListener('pause', () => body.classList.remove('playing'));
      audio.addEventListener('ended', () => body.classList.remove('playing'));
      audio.addEventListener('error', fail, { once: true });
    } else if (view.kind === 'pdf') {
      const frame = document.createElement('iframe');
      frame.className = 'viewer-pdf';
      frame.title = view.name;
      frame.src = src();
      body.append(frame);
    } else if (view.kind === 'model') {
      mountModel(body, view.path, view.extension, this.options.colors, this.options.reduced).then(
        (dispose) => {
          // The window may have closed while the model loaded.
          if (this.windows.includes(win)) win.dispose = dispose;
          else dispose();
        },
        () => fail(),
      );
    } else if (view.kind === 'data') {
      this.renderData(win, body);
    } else if (view.kind === 'text') {
      let text = view.text ?? '';
      if (view.extension === 'json') {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* Show invalid JSON as written. */
        }
      }
      const pre = document.createElement('pre');
      pre.className = 'viewer-text';
      const lines = text.split(/\r?\n/);
      const fragment = document.createDocumentFragment();
      for (const line of lines.slice(0, 20000)) {
        const row = document.createElement('span');
        row.textContent = line || ' ';
        fragment.append(row);
      }
      pre.append(fragment);
      if (view.truncated || lines.length > 20000) {
        const note = document.createElement('div');
        note.className = 'viewer-note';
        note.textContent = 'PARTIAL VIEW // FILE IS LARGER THAN THE HOLO BUFFER';
        body.append(note);
      }
      body.append(pre);
    }
  }

  /** A table file: 3D bar chart when it has numbers, plus a plain table view. */
  private renderData(win: HoloWindow, body: HTMLElement): void {
    const { view } = win;
    const rows = parseTable(view.text ?? '', view.extension === 'tsv' ? '\t' : ',');
    const data = chartData(rows);
    body.classList.add('viewer-data');
    body.innerHTML = `
      <div class="viewer-toolbar top">
        <div class="segmented"><button data-show="chart">CHART</button><button data-show="table">TABLE</button></div>
        <span>${rows.length.toLocaleString()} ROWS${view.truncated ? ' · PARTIAL' : ''}</span>
      </div>
      <div class="data-chart viewer-stage"></div>
      <div class="data-table"></div>`;
    const chartHost = body.querySelector<HTMLElement>('.data-chart')!;
    const tableHost = body.querySelector<HTMLElement>('.data-table')!;
    const table = document.createElement('table');
    for (const [index, row] of rows.slice(0, 500).entries()) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement(index === 0 ? 'th' : 'td');
        td.textContent = cell;
        tr.append(td);
      }
      table.append(tr);
    }
    tableHost.append(table);
    let chartReady = false;
    const show = (which: 'chart' | 'table') => {
      chartHost.hidden = which !== 'chart';
      tableHost.hidden = which !== 'table';
      body.querySelectorAll<HTMLButtonElement>('[data-show]').forEach((button) => button.classList.toggle('active', button.dataset.show === which));
      if (which === 'chart' && data && !chartReady) {
        chartReady = true;
        win.dispose = mountChart(chartHost, data, this.options.colors, this.options.reduced);
      }
    };
    const chartButton = body.querySelector<HTMLButtonElement>('[data-show="chart"]')!;
    chartButton.disabled = !data;
    if (!data) chartButton.title = 'No numeric columns to chart';
    body.querySelector('.viewer-toolbar')!.addEventListener('click', (event) => {
      const which = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-show]')?.dataset.show;
      if (which === 'chart' || which === 'table') show(which);
    });
    show(data ? 'chart' : 'table');
  }

  private bind(win: HoloWindow): void {
    const { el } = win;
    el.addEventListener('pointerdown', () => this.focus(win), true);
    el.querySelector('.hwin-ctrl')!.addEventListener('click', (event) => {
      const act = (event.target as HTMLElement).closest('button')?.dataset.act;
      if (act === 'close') this.close(win);
      else if (act === 'min') this.minimize(win);
      else if (act === 'max') this.toggleMax(win);
      else if (act === 'ext') this.options.openExternal(win.view.path);
    });
    win.chip.addEventListener('click', () => {
      if (win.minimized) this.restoreFromDock(win);
      else if (this.focused === win) this.minimize(win);
      else this.focus(win);
    });

    // Drag by the title bar (a pinch-and-move gesture arrives as the same pointer events).
    const bar = el.querySelector<HTMLElement>('.hwin-bar')!;
    bar.addEventListener('dblclick', (event) => {
      if (!(event.target as HTMLElement).closest('button')) this.toggleMax(win);
    });
    bar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
      bar.setPointerCapture(event.pointerId);
      // Dragging a maximized window restores it under the pointer, like Windows.
      if (win.restore) {
        const ratio = (event.clientX - win.rect.x) / win.rect.w;
        const restored = win.restore;
        win.restore = null;
        el.classList.remove('maximized');
        this.place(win, this.clamp({ ...restored, x: event.clientX - restored.w * ratio, y: event.clientY - 22 }));
      }
      const start = { px: event.clientX, py: event.clientY, x: win.rect.x, y: win.rect.y };
      let snap: Snap = null;
      el.classList.add('dragging');
      const move = (e: PointerEvent) => {
        this.place(win, this.clamp({ ...win.rect, x: start.x + e.clientX - start.px, y: start.y + e.clientY - start.py }));
        snap = e.clientX < SNAP_EDGE ? 'left' : e.clientX > window.innerWidth - SNAP_EDGE ? 'right' : e.clientY < SNAP_EDGE + 70 ? 'max' : null;
        this.showGhost(snap);
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        bar.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        this.showGhost(null);
        if (snap) this.snapTo(win, snap);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
      bar.addEventListener('pointercancel', up);
    });

    const handle = el.querySelector<HTMLElement>('.hwin-resize')!;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      win.restore = null;
      el.classList.remove('maximized');
      const start = { px: event.clientX, py: event.clientY, w: win.rect.w, h: win.rect.h };
      const move = (e: PointerEvent) => {
        this.place(win, this.clamp({ ...win.rect, w: start.w + e.clientX - start.px, h: start.h + e.clientY - start.py }));
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  private snapRect(snap: Exclude<Snap, null>): Rect {
    const area = this.workArea();
    if (snap === 'max') return area;
    const half = (area.w - 12) / 2;
    return { x: snap === 'left' ? area.x : area.x + half + 12, y: area.y, w: half, h: area.h };
  }

  private showGhost(snap: Snap): void {
    this.ghost.hidden = snap === null;
    if (!snap) return;
    const rect = this.snapRect(snap);
    Object.assign(this.ghost.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
  }

  private snapTo(win: HoloWindow, snap: Exclude<Snap, null>): void {
    sound.play('snap');
    win.restore = win.restore ?? { ...win.rect };
    win.el.classList.toggle('maximized', snap === 'max');
    this.animateTo(win, this.snapRect(snap));
  }

  private animateTo(win: HoloWindow, rect: Rect): void {
    const from = { ...win.rect };
    this.place(win, rect);
    if (this.options.reduced()) return;
    win.el.animate(
      [
        { transform: `translate(${from.x - rect.x}px, ${from.y - rect.y}px) scale(${from.w / rect.w}, ${from.h / rect.h})`, transformOrigin: '0 0' },
        { transform: 'none', transformOrigin: '0 0' },
      ],
      { duration: 280, easing: 'cubic-bezier(.2,.9,.2,1)' },
    );
  }

  toggleMax(win: HoloWindow): void {
    if (win.restore) {
      const restore = win.restore;
      win.restore = null;
      win.el.classList.remove('maximized');
      this.animateTo(win, this.clamp(restore));
    } else {
      this.snapTo(win, 'max');
    }
  }

  focus(win: HoloWindow): void {
    this.focused = win;
    win.el.style.zIndex = String(++this.topZ);
    for (const other of this.windows) {
      other.el.classList.toggle('focused', other === win);
      other.chip.classList.toggle('focused', other === win && !other.minimized);
    }
  }

  private pulse(win: HoloWindow): void {
    if (this.options.reduced()) return;
    win.el.animate([{ filter: 'brightness(2.2)' }, { filter: 'none' }], { duration: 420 });
  }

  minimize(win: HoloWindow): void {
    if (win.minimized) return;
    sound.play('snap');
    win.minimized = true;
    win.chip.classList.add('minimized');
    win.chip.classList.remove('focused');
    win.el.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => media.pause());
    const chip = win.chip.getBoundingClientRect();
    const finish = () => {
      if (win.minimized) win.el.hidden = true;
    };
    if (this.options.reduced()) {
      finish();
    } else {
      const dx = chip.x + chip.width / 2 - (win.rect.x + win.rect.w / 2);
      const dy = chip.y - (win.rect.y + win.rect.h / 2);
      win.el
        .animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.08)`, opacity: 0 }], { duration: 320, easing: 'cubic-bezier(.6,0,.8,.4)' })
        .finished.then(finish, finish);
    }
    this.focused = this.windows.filter((other) => !other.minimized).at(-1) ?? null;
    if (this.focused) this.focus(this.focused);
  }

  private restoreFromDock(win: HoloWindow): void {
    sound.play('open');
    win.minimized = false;
    win.el.hidden = false;
    win.chip.classList.remove('minimized');
    this.focus(win);
    if (!this.options.reduced()) {
      win.el.animate([{ transform: 'translateY(60px) scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 300, easing: 'cubic-bezier(.2,.9,.2,1)' });
    }
  }

  close(win: HoloWindow, instant = false): void {
    if (!instant) sound.play('close');
    this.windows = this.windows.filter((other) => other !== win);
    win.chip.remove();
    win.dispose?.();
    win.dispose = null;
    win.el.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => {
      media.pause();
      media.removeAttribute('src');
      media.load();
    });
    const remove = () => win.el.remove();
    if (instant || this.options.reduced()) {
      remove();
    } else {
      // CRT collapse: squash to a bright line, then to a point.
      win.el
        .animate(
          [
            { transform: 'none', filter: 'none', opacity: 1 },
            { transform: 'scale(1, .01)', filter: 'brightness(3)', opacity: 1, offset: 0.55 },
            { transform: 'scale(0, .01)', filter: 'brightness(5)', opacity: 0 },
          ],
          { duration: 380, easing: 'cubic-bezier(.7,0,.3,1)' },
        )
        .finished.then(remove, remove);
    }
    if (this.focused === win) {
      this.focused = this.windows.filter((other) => !other.minimized).at(-1) ?? null;
      if (this.focused) this.focus(this.focused);
    }
    this.options.onChange(this.windows.length);
  }

  /** Close the focused window. Returns false when there is none. */
  closeFocused(): boolean {
    if (!this.focused) return false;
    this.close(this.focused);
    return true;
  }

  closeAll(): void {
    for (const win of [...this.windows]) this.close(win, true);
  }

  /** Arrange every visible window in a grid. */
  tile(): void {
    const visible = this.windows.filter((win) => !win.minimized);
    if (!visible.length) return;
    const area = this.workArea();
    const columns = Math.ceil(Math.sqrt(visible.length * (area.w / area.h) * 0.75));
    const rows = Math.ceil(visible.length / columns);
    const gap = 12;
    const w = (area.w - gap * (columns - 1)) / columns;
    const h = (area.h - gap * (rows - 1)) / rows;
    visible.forEach((win, i) => {
      win.restore = null;
      win.el.classList.remove('maximized');
      this.animateTo(win, { x: area.x + (i % columns) * (w + gap), y: area.y + Math.floor(i / columns) * (h + gap), w: Math.max(MIN_W, w), h: Math.max(MIN_H, h) });
    });
  }

  cascade(): void {
    const area = this.workArea();
    this.windows.filter((win) => !win.minimized).forEach((win, i) => {
      win.restore = null;
      win.el.classList.remove('maximized');
      const [dw, dh] = DEFAULT_SIZE[win.view.kind];
      this.animateTo(win, this.clamp({ x: area.x + 40 + i * 36, y: area.y + i * 30, w: dw, h: dh }));
      this.focus(win);
    });
  }

  minimizeAll(): void {
    for (const win of this.windows) this.minimize(win);
  }
}
