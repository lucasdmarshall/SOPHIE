import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { LandmarkFrame } from './types';

/** Loop period while control is disarmed. Must stay well under the 500 ms no-frame watchdog. */
const IDLE_INTERVAL_MS = 200;

export type TrackingResult = {
  frame: LandmarkFrame;
  inferenceMs: number;
  delegate: 'GPU' | 'CPU';
  brightness: number | null;
};

export type CameraMode = {
  width: number;
  height: number;
  frameRate?: number;
};

export type TrackingStart = {
  delegate: 'GPU' | 'CPU';
  cameraMode: CameraMode;
};

export class Tracker {
  private landmarker: HandLandmarker | null = null;
  private stream: MediaStream | null = null;
  private timerId = 0;
  private lastVideoTime = -1;
  private delegate: 'GPU' | 'CPU' = 'GPU';
  private lightCanvas = document.createElement('canvas');
  private brightness: number | null = null;
  private lastBrightnessAt = -Infinity;
  /**
   * True while gesture control is disarmed (paused after the hand left). Nothing acts on
   * landmarks then, so a few frames a second are enough to keep the watchdog fed and to
   * notice Resume, instead of running the model at full camera rate.
   */
  idle = false;

  constructor(private video: HTMLVideoElement) {
    this.lightCanvas.width = 32;
    this.lightCanvas.height = 24;
  }

  async start(onFrame: (result: TrackingResult) => void, onError: (error: Error) => void): Promise<TrackingStart> {
    if (this.stream) return { delegate: this.delegate, cameraMode: this.cameraMode() };
    const vision = await FilesetResolver.forVisionTasks('/wasm');
    let landmarker: HandLandmarker;
    try {
      landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
      });
      this.delegate = 'GPU';
    } catch {
      landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 1,
      });
      this.delegate = 'CPU';
    }
    this.landmarker = landmarker;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => {
        this.stop();
        onError(new Error('Camera disconnected'));
      }, { once: true }));
      this.lastVideoTime = -1;
      this.lastBrightnessAt = -Infinity;
      this.loop(onFrame, onError);
      return { delegate: this.delegate, cameraMode: this.cameraMode() };
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    clearTimeout(this.timerId);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.brightness = null;
    this.idle = false;
  }

  private cameraMode(): CameraMode {
    const settings = this.stream?.getVideoTracks()[0]?.getSettings();
    return {
      width: settings?.width ?? this.video.videoWidth,
      height: settings?.height ?? this.video.videoHeight,
      frameRate: settings?.frameRate,
    };
  }

  private measureBrightness(timestamp: number): void {
    if (timestamp - this.lastBrightnessAt < 2000) return;
    this.lastBrightnessAt = timestamp;
    const context = this.lightCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(this.video, 0, 0, 32, 24);
    const pixels = context.getImageData(0, 0, 32, 24).data;
    let total = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      total += (54 * pixels[index] + 183 * pixels[index + 1] + 19 * pixels[index + 2]) / 256;
    }
    this.brightness = Math.round(total / (pixels.length / 4));
  }

  private loop(onFrame: (result: TrackingResult) => void, onError: (error: Error) => void): void {
    if (!this.landmarker || !this.stream) return;
    try {
      if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      const timestamp = performance.now();
      this.measureBrightness(timestamp);
      const inferenceStarted = performance.now();
      const result = this.landmarker.detectForVideo(this.video, timestamp);
      const frame: LandmarkFrame = {
        timestamp_ms: timestamp,
        hands: result.landmarks.map((landmarks, index) => ({
          handedness: result.handedness[index]?.[0]?.categoryName === 'Left' ? 'Left' : 'Right',
          score: result.handedness[index]?.[0]?.score ?? 0,
          // The video is mirrored in the UI. Mirror the coordinates sent to Rust too.
          landmarks: landmarks.map(({ x, y, z }) => [1 - x, y, z]),
        })),
      };
      onFrame({ frame, inferenceMs: performance.now() - inferenceStarted, delegate: this.delegate, brightness: this.brightness });
      }
    } catch (error) {
      this.stop();
      onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // Timer scheduling is less tied to painting than requestAnimationFrame when parked in the tray.
    this.timerId = window.setTimeout(() => this.loop(onFrame, onError), this.idle ? IDLE_INTERVAL_MS : 16);
  }
}
