export type Ease = (t: number) => number;

export const ease = {
  linear: (t: number) => t,
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  outElastic: (t: number) => {
    if (t <= 0 || t >= 1) return t <= 0 ? 0 : 1;
    return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
  },
} satisfies Record<string, Ease>;

interface TweenOptions {
  from: number;
  to: number;
  duration: number;
  delay?: number;
  ease?: Ease;
  update: (value: number) => void;
}

interface Running extends Required<Omit<TweenOptions, 'delay'>> {
  start: number;
  resolve: () => void;
}

/** Frame-driven tweens; `tick` is called from the render loop. */
export class Tweener {
  private running: Running[] = [];
  /** Reduced motion: shorter tweens and no overshooting eases. */
  reduced = false;

  to(options: TweenOptions): Promise<void> {
    const scale = this.reduced ? 0.3 : 1;
    const chosen = options.ease ?? ease.outCubic;
    const overshoots = chosen === ease.outBack || chosen === ease.outElastic;
    return new Promise((resolve) => {
      this.running.push({
        from: options.from,
        to: options.to,
        duration: Math.max(1, options.duration * scale),
        ease: this.reduced && overshoots ? ease.outCubic : chosen,
        update: options.update,
        start: performance.now() + (options.delay ?? 0) * scale,
        resolve,
      });
    });
  }

  tick(now: number): void {
    const finished: Running[] = [];
    for (const tween of this.running) {
      if (now < tween.start) continue;
      const t = Math.min(1, (now - tween.start) / tween.duration);
      tween.update(tween.from + (tween.to - tween.from) * tween.ease(t));
      if (t >= 1) finished.push(tween);
    }
    if (finished.length === 0) return;
    this.running = this.running.filter((tween) => !finished.includes(tween));
    for (const tween of finished) tween.resolve();
  }

  /** Jump every running tween to its end value. */
  finishAll(): void {
    for (const tween of this.running) {
      tween.update(tween.to);
      tween.resolve();
    }
    this.running = [];
  }
}

export const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
