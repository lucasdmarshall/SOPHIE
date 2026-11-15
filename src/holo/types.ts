export type CoreStyle = 'reactor' | 'atom' | 'tesseract' | 'none';
export type LayoutStyle = 'orbit' | 'spiral' | 'wall' | 'helix' | 'globe' | 'neural';

/** The whole scene: grid floor with a centerpiece, a flat JARVIS-style dial, open space, or a data tunnel. */
export type WorldStyle = 'grid' | 'hud' | 'starmap' | 'tunnel';
/** What the scene can arrange files as: the user's layouts plus each world's own. */
export type SceneLayout = LayoutStyle | 'dial' | 'constellation' | 'tunnel';

export interface HoloTheme {
  preset: string;
  primary: string;
  secondary: string;
  accent: string;
  glow: number;
  reduced_motion: boolean;
  core: CoreStyle;
  layout: LayoutStyle;
  world: WorldStyle;
  quality: QualitySetting;
  sound: boolean;
  volume: number;
}

/** Live hand data streamed from the preview window while Holo Mode is open. */
export interface HandFrame {
  /** Thumb-to-index gap relative to hand size (pinch starts below 0.25). */
  gap: number;
  /** 21 mirrored landmarks, normalized 0..1. */
  points: [number, number][];
  pose: string;
}

export type QualitySetting = 'auto' | 'high' | 'balanced' | 'saver';

export interface TrackingStatus {
  running: boolean;
  armed: boolean;
  fps: number;
  hands: number;
  pose: string;
}

export interface HoloEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_ms: number;
  extension: string;
}

export interface HoloListing {
  path: string;
  parent: string | null;
  entries: HoloEntry[];
  hidden_count: number;
}

export interface HoloPlace {
  label: string;
  path: string;
  kind: string;
}

export type Tone = 'primary' | 'secondary' | 'accent';
