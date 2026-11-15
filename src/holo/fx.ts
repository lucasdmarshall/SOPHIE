import type { HandFrame } from './types';

const HAND_LINKS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
/** Pinch gap where the progress ring starts filling, and where the pinch locks. */
const RING_START = 0.6;
const RING_LOCK = 0.25;
const HAND_STALE_MS = 500;

interface Wave {
  x: number;
  y: number;
  born: number;
  strong: boolean;
}

export interface CalloutLink {
  anchor: () => { x: number; y: number } | undefined;
  element: HTMLElement;
  born: number;
}

/**
 * 2D effects drawn above everything: the holographic hand cursor, pinch progress,
 * click shockwaves, drag tether, the callout's leader line and the mini hand skeleton.
 */
/** Side of the small canvas the hand cursor is drawn into (CSS px); fits rings, brackets, glow and labels. */
const CURSOR_BOX = 160;

export class FxLayer {
  /**
   * The context the draw helpers paint into. Normally the full-screen layer; while the
   * cursor is drawn it points at the cursor's own small canvas.
   */
  private ctx: CanvasRenderingContext2D;
  private readonly screenCtx: CanvasRenderingContext2D;
  /**
   * The cursor animates every frame, so it lives on a small canvas that is moved with a
   * transform. The full-screen layer is then only redrawn while a wave, trail, tether or
   * callout is on it, instead of being cleared and repainted at display rate.
   */
  private readonly cursorCanvas = document.createElement('canvas');
  private readonly cursorCtx: CanvasRenderingContext2D;
  private cursorTransform = '';
  private screenDirty = false;
  private skeletonKey = -2;
  private colorsVersion = 0;
  private skeletonColors = -1;
  private readonly skeleton: CanvasRenderingContext2D;
  private colors = { p: '#38e8ff', s: '#7c6bff', a: '#ff4fd8' };
  private reduced = false;
  private running = false;
  private pointer: { x: number; y: number } | null = null;
  private pressed = false;
  private pressOrigin = { x: 0, y: 0 };
  private dragging = false;
  private trail: { x: number; y: number; t: number }[] = [];
  private waves: Wave[] = [];
  private hand: HandFrame | null = null;
  private handAt = 0;
  private overTarget = false;
  private callout: CalloutLink | null = null;
  /** Called on press/release so sound and other feedback stay in one place. */
  onPress: (pressed: boolean, dragged: boolean) => void = () => {};

  constructor(
    private readonly canvas: HTMLCanvasElement,
    skeletonCanvas: HTMLCanvasElement,
  ) {
    this.screenCtx = canvas.getContext('2d')!;
    this.ctx = this.screenCtx;
    this.skeleton = skeletonCanvas.getContext('2d')!;
    this.cursorCanvas.width = this.cursorCanvas.height = CURSOR_BOX;
    this.cursorCanvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.cursorCanvas.style, {
      position: 'absolute', left: '0', top: '0', width: `${CURSOR_BOX}px`, height: `${CURSOR_BOX}px`,
      // Same layer as #fx (holo.css), placed after it so the cursor stays on top as before.
      zIndex: '12', pointerEvents: 'none', display: 'none', willChange: 'transform',
    });
    canvas.after(this.cursorCanvas);
    this.cursorCtx = this.cursorCanvas.getContext('2d')!;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      // Resizing clears the canvas; repaint whatever was on it.
      this.screenDirty = true;
    };
    resize();
    window.addEventListener('resize', resize);
    // Capture phase: every pointer event in the window passes here first, whatever handles it.
    window.addEventListener('pointermove', (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
      const target = event.target as HTMLElement | null;
      this.overTarget = Boolean(
        target?.closest('button, input, .hwin-bar, .hwin-resize, .place, .crumb, .dock-chip') ||
          (target?.id === 'scene' && target.classList.contains('over-node')),
      );
      if (this.pressed) {
        const moved = Math.hypot(event.clientX - this.pressOrigin.x, event.clientY - this.pressOrigin.y);
        if (moved > 8) this.dragging = true;
        if (this.dragging && !this.reduced) this.trail.push({ x: event.clientX, y: event.clientY, t: performance.now() });
      }
    }, true);
    window.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.pressed = true;
      this.dragging = false;
      this.pressOrigin = { x: event.clientX, y: event.clientY };
      this.trail = [];
      this.shockwave(event.clientX, event.clientY, false);
      this.onPress(true, false);
    }, true);
    const release = (event: PointerEvent) => {
      if (!this.pressed) return;
      const dragged = this.dragging;
      this.pressed = false;
      this.dragging = false;
      if (dragged) this.shockwave(event.clientX, event.clientY, true);
      this.onPress(false, dragged);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    document.addEventListener('pointerleave', () => (this.pointer = null));
  }

  setColors(p: string, s: string, a: string): void {
    this.colors = { p, s, a };
    this.colorsVersion += 1;
  }

  setReduced(reduced: boolean): void {
    this.reduced = reduced;
    if (reduced) this.trail = [];
  }

  setHand(frame: HandFrame | null): void {
    this.hand = frame;
    this.handAt = performance.now();
  }

  shockwave(x: number, y: number, strong: boolean): void {
    this.waves.push({ x, y, born: performance.now(), strong });
  }

  linkCallout(link: CalloutLink | null): void {
    this.callout = link;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    this.screenCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.screenDirty = false;
    this.cursorCanvas.style.display = 'none';
    this.cursorTransform = '';
  }

  private liveHand(now: number): HandFrame | null {
    return this.hand && now - this.handAt < HAND_STALE_MS ? this.hand : null;
  }

  private frame = (now: number) => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    this.ctx = this.screenCtx;
    const busy =
      (this.callout !== null && !this.callout.element.hidden) ||
      this.trail.length > 0 ||
      (this.pressed && this.dragging && this.pointer !== null) ||
      this.waves.length > 0;
    // An empty layer that was already cleared needs no work at all.
    if (busy || this.screenDirty) {
      const ctx = this.screenCtx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      this.drawCallout(now);
      this.drawTrail(now);
      this.drawTether(now);
      this.drawWaves(now);
      this.screenDirty = busy;
    }
    this.drawCursorLayer(now);
    this.drawSkeleton(now);
  };

  /** Draw the cursor into its own canvas, centred, and move that canvas under the pointer. */
  private drawCursorLayer(now: number): void {
    const style = this.cursorCanvas.style;
    if (!this.pointer) {
      if (style.display !== 'none') style.display = 'none';
      return;
    }
    const half = CURSOR_BOX / 2;
    const transform = `translate3d(${this.pointer.x - half}px, ${this.pointer.y - half}px, 0)`;
    if (transform !== this.cursorTransform) {
      style.transform = transform;
      this.cursorTransform = transform;
    }
    if (style.display === 'none') style.display = '';
    const ctx = this.cursorCtx;
    ctx.clearRect(0, 0, CURSOR_BOX, CURSOR_BOX);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.ctx = ctx;
    this.drawCursor(now, half, half);
    this.ctx = this.screenCtx;
  }

  private glow(color: string, blur: number): void {
    this.ctx.shadowColor = color;
    this.ctx.shadowBlur = blur;
  }

  private drawWaves(now: number): void {
    const ctx = this.ctx;
    this.waves = this.waves.filter((wave) => now - wave.born < 520);
    for (const wave of this.waves) {
      const t = (now - wave.born) / 520;
      const eased = 1 - (1 - t) ** 3;
      const max = wave.strong ? 90 : 46;
      ctx.globalAlpha = (1 - t) * 0.9;
      this.glow(wave.strong ? this.colors.a : this.colors.p, 14);
      ctx.strokeStyle = wave.strong ? this.colors.a : this.colors.p;
      ctx.lineWidth = 2.5 * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(wave.x, wave.y, 6 + eased * max, 0, Math.PI * 2);
      ctx.stroke();
      if (!this.reduced) {
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(wave.x, wave.y, 4 + eased * max * 0.6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  private drawTrail(now: number): void {
    this.trail = this.trail.filter((point) => now - point.t < 380);
    if (this.trail.length < 2) return;
    const ctx = this.ctx;
    this.glow(this.colors.a, 10);
    for (let i = 1; i < this.trail.length; i += 1) {
      const age = (now - this.trail[i].t) / 380;
      ctx.globalAlpha = (1 - age) * 0.7;
      ctx.strokeStyle = this.colors.a;
      ctx.lineWidth = 3 * (1 - age) + 0.5;
      ctx.beginPath();
      ctx.moveTo(this.trail[i - 1].x, this.trail[i - 1].y);
      ctx.lineTo(this.trail[i].x, this.trail[i].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  /** While dragging, an energy line ties the grab point to the hand. */
  private drawTether(now: number): void {
    if (!this.pressed || !this.dragging || !this.pointer) return;
    const ctx = this.ctx;
    const { x: ox, y: oy } = this.pressOrigin;
    const { x, y } = this.pointer;
    this.glow(this.colors.p, 12);
    ctx.strokeStyle = this.colors.p;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([10, 7]);
    ctx.lineDashOffset = -(now / 25);
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.setLineDash([]);
    // Anchor diamond where the grab began.
    ctx.save();
    ctx.translate(ox, oy);
    ctx.rotate(Math.PI / 4 + now / 600);
    ctx.strokeRect(-5, -5, 10, 10);
    ctx.restore();
    ctx.shadowBlur = 0;
  }

  /** Draws the cursor centred on (x, y) of the current context. */
  private drawCursor(now: number, x: number, y: number): void {
    const ctx = this.ctx;
    const t = now / 1000;
    const hand = this.liveHand(now);
    const pose = hand?.pose ?? 'cursor';
    const lock = this.overTarget;
    const radius = this.pressed ? 9 : lock ? 19 : 14;
    const dim = pose === 'clutch' && !this.pressed;

    ctx.globalAlpha = dim ? 0.45 : 1;
    this.glow(this.colors.p, 10);
    ctx.strokeStyle = this.colors.p;
    ctx.lineWidth = 2;
    // Two rotating arc segments.
    const spin = this.reduced ? 0 : t * 2.2;
    for (let i = 0; i < 2; i += 1) {
      ctx.beginPath();
      ctx.arc(x, y, radius, spin + i * Math.PI, spin + i * Math.PI + Math.PI * 0.55);
      ctx.stroke();
    }
    // Centre dot.
    ctx.fillStyle = this.pressed ? this.colors.a : this.colors.p;
    ctx.beginPath();
    ctx.arc(x, y, this.pressed ? 3.5 : 2.2, 0, Math.PI * 2);
    ctx.fill();

    if (lock && !this.pressed) {
      // Target-lock brackets.
      const b = radius + 7;
      const l = 6;
      ctx.strokeStyle = this.colors.a;
      this.glow(this.colors.a, 10);
      ctx.lineWidth = 2;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.beginPath();
        ctx.moveTo(x + sx * b, y + sy * (b - l));
        ctx.lineTo(x + sx * b, y + sy * b);
        ctx.lineTo(x + sx * (b - l), y + sy * b);
        ctx.stroke();
      }
    }

    // Pinch progress: fills as the thumb closes on the index finger.
    if (hand && !this.pressed && hand.gap < RING_START && pose !== 'scroll') {
      const progress = Math.min(1, Math.max(0, (RING_START - hand.gap) / (RING_START - RING_LOCK)));
      ctx.strokeStyle = this.colors.a;
      this.glow(this.colors.a, 12);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, radius + 9, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
    }
    if (this.pressed) {
      ctx.strokeStyle = this.colors.a;
      this.glow(this.colors.a, 14);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, radius + 9, 0, Math.PI * 2);
      ctx.stroke();
      this.label(this.dragging ? 'DRAG' : 'LOCK', x, y + radius + 26, this.colors.a);
    } else if (pose === 'scroll') {
      this.chevrons(x, y, radius, t);
    } else if (pose === 'clutch' && hand) {
      this.label('HOLD', x, y + radius + 22, this.colors.p);
    } else if (pose === 'right_click') {
      this.label('MENU', x, y + radius + 22, this.colors.a);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  private chevrons(x: number, y: number, radius: number, t: number): void {
    const ctx = this.ctx;
    const bounce = this.reduced ? 0 : Math.sin(t * 6) * 3;
    ctx.strokeStyle = this.colors.s;
    this.glow(this.colors.s, 10);
    ctx.lineWidth = 2.5;
    for (const dir of [-1, 1]) {
      const cy = y + dir * (radius + 14 + bounce);
      ctx.beginPath();
      ctx.moveTo(x - 8, cy - dir * 5);
      ctx.lineTo(x, cy);
      ctx.lineTo(x + 8, cy - dir * 5);
      ctx.stroke();
    }
  }

  private label(text: string, x: number, y: number, color: string): void {
    const ctx = this.ctx;
    ctx.shadowBlur = 0;
    ctx.font = '600 9px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.fillText(text.split('').join(' '), x, y);
  }

  /** Brackets around the analysed object and an elbow line out to its callout card. */
  private drawCallout(now: number): void {
    const link = this.callout;
    if (!link || link.element.hidden) return;
    const anchor = link.anchor();
    if (!anchor) return;
    // Keep the card beside its object, flipping sides near the screen edge.
    const w = link.element.offsetWidth;
    const h = link.element.offsetHeight;
    if (w === 0) return;
    let left = anchor.x + 96;
    if (left + w > window.innerWidth - 24) left = anchor.x - 96 - w;
    left = Math.min(Math.max(left, 24), window.innerWidth - w - 24);
    const top = Math.min(Math.max(anchor.y - 70, 104), window.innerHeight - h - 150);
    link.element.style.left = `${left}px`;
    link.element.style.top = `${top}px`;
    const rect = { left, top, right: left + w };
    const ctx = this.ctx;
    const age = Math.min(1, (now - link.born) / (this.reduced ? 1 : 320));
    const eased = 1 - (1 - age) ** 3;

    // Brackets snap in from wide to tight.
    const size = 22 + (1 - eased) * 26;
    const l = 7;
    ctx.strokeStyle = this.colors.a;
    this.glow(this.colors.a, 10);
    ctx.lineWidth = 2;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(anchor.x + sx * size, anchor.y + sy * (size - l));
      ctx.lineTo(anchor.x + sx * size, anchor.y + sy * size);
      ctx.lineTo(anchor.x + sx * (size - l), anchor.y + sy * size);
      ctx.stroke();
    }

    // Elbow leader line, drawn out progressively.
    const toRight = rect.left > anchor.x;
    const endX = toRight ? rect.left : rect.right;
    const endY = rect.top + 28;
    const elbowX = anchor.x + (toRight ? 1 : -1) * Math.min(46, Math.abs(endX - anchor.x) / 2);
    const points = [
      { x: anchor.x + (toRight ? size : -size), y: anchor.y },
      { x: elbowX, y: endY },
      { x: endX, y: endY },
    ];
    const lengths = [Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), Math.abs(points[2].x - points[1].x)];
    let remaining = (lengths[0] + lengths[1]) * eased;
    ctx.strokeStyle = this.colors.p;
    this.glow(this.colors.p, 8);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < 2 && remaining > 0; i += 1) {
      const portion = Math.min(1, remaining / Math.max(1, lengths[i]));
      ctx.lineTo(points[i].x + (points[i + 1].x - points[i].x) * portion, points[i].y + (points[i + 1].y - points[i].y) * portion);
      remaining -= lengths[i];
    }
    ctx.stroke();
    if (eased >= 1) {
      ctx.fillStyle = this.colors.p;
      ctx.beginPath();
      ctx.arc(endX, endY, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  private drawSkeleton(now: number): void {
    const ctx = this.skeleton;
    const { width, height } = ctx.canvas;
    const hand = this.liveHand(now);
    // Hand frames arrive at camera rate; redraw only when a new one (or a new theme) lands.
    const key = hand ? this.handAt : -1;
    if (key === this.skeletonKey && this.skeletonColors === this.colorsVersion) return;
    this.skeletonKey = key;
    this.skeletonColors = this.colorsVersion;
    ctx.clearRect(0, 0, width, height);
    if (!hand) return;
    const xs = hand.points.map((point) => point[0]);
    const ys = hand.points.map((point) => point[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 0.001);
    const scale = (Math.min(width, height) - 24) / span;
    const ox = (width - (Math.max(...xs) - minX) * scale) / 2;
    const oy = (height - (Math.max(...ys) - minY) * scale) / 2;
    const at = (i: number) => ({ x: ox + (hand.points[i][0] - minX) * scale, y: oy + (hand.points[i][1] - minY) * scale });
    ctx.lineCap = 'round';
    ctx.shadowColor = this.colors.p;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = this.colors.p;
    ctx.lineWidth = 1.8;
    for (const [a, b] of HAND_LINKS) {
      const p = at(a);
      const q = at(b);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    // The pinch pair: thumb tip and index tip, joined as they close.
    const thumb = at(4);
    const index = at(8);
    const closing = hand.gap < RING_START;
    ctx.strokeStyle = this.colors.a;
    ctx.shadowColor = this.colors.a;
    if (closing) {
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(thumb.x, thumb.y);
      ctx.lineTo(index.x, index.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (let i = 0; i < 21; i += 1) {
      const p = at(i);
      const tip = i === 4 || i === 8;
      ctx.fillStyle = tip ? this.colors.a : this.colors.p;
      ctx.beginPath();
      ctx.arc(p.x, p.y, tip ? 3.2 : 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
}
