/**
 * Synthesized UI sound for Holo Mode. Every sound is generated with Web Audio at play
 * time, so there are no audio files to ship and the pitch follows the theme colour.
 */

type Cue =
  | 'hover' | 'select' | 'press' | 'release' | 'open' | 'close' | 'dive' | 'rise'
  | 'boot' | 'power' | 'error' | 'scan' | 'tick' | 'toast' | 'snap';

/**
 * Overall level for every cue. Measured peaks before this was added were 1.5-7% of full
 * scale, which is inaudible on laptop speakers; the limiter below keeps loud cues safe.
 */
const LOUDNESS = 3.5;

/** Minimum gap between repeats of the same cue, so jittery hover never buzzes. */
const COOLDOWN_MS: Partial<Record<Cue, number>> = { hover: 90, tick: 40, scan: 300, snap: 120 };

export class SoundEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly lastPlayed = new Map<Cue, number>();
  private enabled = true;
  private volume = 0.6;
  /** Base pitch in Hz, derived from the theme's primary hue. */
  private base = 440;

  configure(enabled: boolean, volume: number, primaryHex: string): void {
    this.enabled = enabled;
    this.volume = Math.min(1, Math.max(0, volume));
    this.base = pitchFromColor(primaryHex);
    if (this.master) this.master.gain.value = this.volume;
  }

  /** Audio state for the settings panel: running, suspended (blocked), or off. */
  get state(): string {
    if (!this.enabled || this.volume === 0) return 'off';
    return this.context?.state ?? 'idle';
  }

  /**
   * Called from real user input (pointer or key). Browsers may start audio suspended until
   * the user interacts, so every interaction gives the context another chance to start.
   */
  unlock(): void {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (ctx && ctx.state !== 'running') void ctx.resume();
  }

  /** Stop the audio thread while Holo Mode is closed; nothing plays then. */
  suspend(): void {
    if (this.context?.state === 'running') void this.context.suspend();
  }

  /** Restart a context that `suspend` stopped, ahead of the boot sound. */
  resume(): void {
    if (this.enabled && this.context?.state === 'suspended') void this.context.resume();
  }

  private ensure(): AudioContext | null {
    if (!this.enabled || this.volume === 0) return null;
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      // A gentle compressor keeps layered cues from clipping.
      const limiter = this.context.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.ratio.value = 6;
      this.master.connect(limiter).connect(this.context.destination);
      const length = this.context.sampleRate;
      this.noise = this.context.createBuffer(1, length, this.context.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    }
    if (this.context.state === 'suspended') void this.context.resume();
    return this.context;
  }

  private tone(freq: number, to: number, start: number, duration: number, gain: number, type: OscillatorType = 'sine'): void {
    const ctx = this.context!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(gain * LOUDNESS, start + Math.min(0.012, duration / 4));
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(env).connect(this.master!);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  private sweep(from: number, to: number, start: number, duration: number, gain: number, q = 4): void {
    const ctx = this.context!;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(to, start + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(gain * LOUDNESS, start + duration * 0.35);
    env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter).connect(env).connect(this.master!);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  play(cue: Cue): void {
    const now = performance.now();
    const cooldown = COOLDOWN_MS[cue] ?? 0;
    if (now - (this.lastPlayed.get(cue) ?? -Infinity) < cooldown) return;
    const ctx = this.ensure();
    if (!ctx) return;
    this.lastPlayed.set(cue, now);
    const t = ctx.currentTime + 0.005;
    const b = this.base;
    switch (cue) {
      case 'hover':
        this.tone(b * 4, b * 5, t, 0.035, 0.05);
        break;
      case 'select':
        this.tone(b * 2, b * 2, t, 0.06, 0.09, 'triangle');
        this.tone(b * 3, b * 3, t + 0.055, 0.08, 0.08, 'triangle');
        break;
      case 'press':
        this.tone(140, 70, t, 0.09, 0.22);
        this.tone(b * 3, b * 2.5, t, 0.04, 0.06, 'square');
        break;
      case 'release':
        this.tone(b * 2.5, b * 3.2, t, 0.05, 0.05, 'triangle');
        break;
      case 'open':
        this.sweep(300, 3200, t, 0.28, 0.12);
        this.tone(b, b * 2, t + 0.05, 0.22, 0.07, 'triangle');
        break;
      case 'close':
        this.sweep(3000, 250, t, 0.24, 0.1);
        this.tone(b * 2, b * 0.8, t, 0.2, 0.06, 'triangle');
        break;
      case 'dive':
        this.sweep(200, 5000, t, 0.55, 0.16, 2);
        this.tone(90, 45, t + 0.35, 0.4, 0.25);
        break;
      case 'rise':
        this.sweep(4000, 250, t, 0.45, 0.13, 2);
        break;
      case 'snap':
        this.tone(b * 1.5, b * 1.5, t, 0.05, 0.08, 'square');
        break;
      case 'boot':
        this.tone(55, 110, t, 1.6, 0.18);
        this.sweep(150, 6000, t + 0.2, 1.1, 0.07, 1.5);
        [1, 1.25, 1.5, 2].forEach((ratio, i) => this.tone(b * ratio, b * ratio, t + 0.55 + i * 0.12, 0.35, 0.06, 'triangle'));
        break;
      case 'power':
        this.tone(b, 40, t, 0.4, 0.12, 'sawtooth');
        this.sweep(2500, 120, t, 0.35, 0.08);
        break;
      case 'error':
        this.tone(160, 150, t, 0.11, 0.14, 'square');
        this.tone(160, 140, t + 0.15, 0.13, 0.14, 'square');
        break;
      case 'scan':
        for (let i = 0; i < 6; i += 1) this.tone(b * 6, b * 6, t + i * 0.045, 0.018, 0.035, 'square');
        break;
      case 'tick':
        this.tone(b * 8, b * 8, t, 0.012, 0.03, 'square');
        break;
      case 'toast':
        this.tone(b * 3, b * 4, t, 0.09, 0.05);
        break;
    }
  }
}

/** Map the primary colour's hue to a musical-ish base pitch between 330 and 660 Hz. */
function pitchFromColor(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) hue = ((b - r) / d + 2) / 6;
    else hue = ((r - g) / d + 4) / 6;
  }
  return 330 * 2 ** hue;
}

export const sound = new SoundEngine();
