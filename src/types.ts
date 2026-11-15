export type Hand = {
  handedness: 'Left' | 'Right';
  score: number;
  landmarks: [number, number, number][];
};

export type LandmarkFrame = {
  timestamp_ms: number;
  hands: Hand[];
};

export type CoreStatus = {
  frames_received: number;
  fps: number;
  running: boolean;
  armed: boolean;
  pose: 'cursor' | 'right_click' | 'scroll' | 'open_palm' | 'clutch';
  mode: 'standard' | 'lazy';
};

export type ControlSettings = { mode: 'standard' | 'lazy'; lazy_speed: number; lazy_dwell_ms: number };

export type GestureSummary = { id: number; name: string; action: string };

export type Calibration = {
  x_min: number;
  x_max: number;
  y_min: number;
  y_max: number;
  sensitivity: number;
  calibrated: boolean;
};
