use crate::calibration::Calibration;
use crate::custom::{posture_mask, CustomGestures, GestureSummary, RecordingFrame};
use crate::gesture::{GestureEngine, Pose};
use crate::input::WindowsInput;
use crate::lazy::LazyEngine;
use crate::settings::{ControlMode, ControlSettings};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};

#[derive(Deserialize)]
pub struct Hand {
    handedness: String,
    score: f32,
    landmarks: Vec<[f32; 3]>,
}

#[derive(Deserialize)]
pub struct LandmarkFrame {
    timestamp_ms: f64,
    hands: Vec<Hand>,
}

pub struct ControlState(pub Mutex<Controller>);

impl Default for ControlState {
    fn default() -> Self {
        Self(Mutex::new(Controller::default()))
    }
}

pub struct Controller {
    running: bool,
    armed: bool,
    frames_received: u64,
    recent_frames: VecDeque<Instant>,
    last_frame: Option<Instant>,
    last_hand: Option<Instant>,
    started: Instant,
    last_report: Instant,
    gesture: GestureEngine,
    custom: CustomGestures,
    lazy: LazyEngine,
    settings: ControlSettings,
    overlay_visible: bool,
    input: WindowsInput,
    pose: Pose,
}

impl Default for Controller {
    fn default() -> Self {
        let input = WindowsInput::new();
        let lazy = LazyEngine::new(input.cursor_normalized());
        Self {
            running: false,
            armed: false,
            frames_received: 0,
            recent_frames: VecDeque::new(),
            last_frame: None,
            last_hand: None,
            started: Instant::now(),
            last_report: Instant::now(),
            gesture: GestureEngine::with_calibration(Calibration::load()),
            custom: CustomGestures::default(),
            lazy,
            settings: ControlSettings::load(),
            overlay_visible: false,
            input,
            pose: Pose::Clutch,
        }
    }
}

impl Controller {
    pub fn is_armed(&self) -> bool {
        self.armed
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    pub fn frames_stale(&self) -> bool {
        self.last_frame
            .is_some_and(|last| last.elapsed() > Duration::from_millis(500))
    }

    pub fn pause(&mut self) {
        self.armed = false;
        self.pose = Pose::Clutch;
        self.gesture.reset();
        self.custom.reset();
        self.lazy.reset();
        let _ = self.input.release_all();
    }

    pub fn resume(&mut self) {
        if self.running {
            self.armed = true;
            self.last_hand = Some(Instant::now());
        }
    }

    pub fn watchdog(&mut self) {
        if !self.running {
            return;
        }
        let now = Instant::now();
        #[cfg(debug_assertions)]
        if now.duration_since(self.last_report) >= Duration::from_secs(2) {
            eprintln!(
                "SOPHIE tracking: {} frames, {:.1} fps, armed={}",
                self.frames_received,
                self.status().fps,
                self.armed
            );
            self.last_report = now;
        }
        if self
            .last_frame
            .is_some_and(|last| now.duration_since(last) > Duration::from_millis(500))
        {
            self.gesture.reset();
            self.custom.reset();
            self.lazy.reset();
            let _ = self.input.release_all();
            self.pose = Pose::Clutch;
        }
        if self
            .last_frame
            .is_some_and(|last| now.duration_since(last) > Duration::from_secs(2))
            || self
                .last_hand
                .is_some_and(|last| now.duration_since(last) > Duration::from_secs(5))
        {
            self.pause();
        }
    }

    fn status(&self) -> CoreStatus {
        let fps = self
            .recent_frames
            .front()
            .and_then(|first| {
                let seconds = first.elapsed().as_secs_f64();
                (seconds > 0.0)
                    .then_some(self.recent_frames.len().saturating_sub(1) as f64 / seconds)
            })
            .unwrap_or(0.0);
        CoreStatus {
            frames_received: self.frames_received,
            fps,
            running: self.running,
            armed: self.armed,
            pose: self.pose,
            mode: self.settings.mode,
        }
    }

    pub fn hide_dwell(&mut self, app: &AppHandle) {
        if self.overlay_visible {
            if let Some(window) = app.get_webview_window(crate::DWELL_LABEL) {
                let _ = window.hide();
            }
            self.overlay_visible = false;
        }
    }

    fn update_dwell(&mut self, app: &AppHandle, progress: Option<f32>, cursor: (f32, f32)) {
        let Some(progress) = progress else {
            self.hide_dwell(app);
            return;
        };
        let Some(window) = app.get_webview_window(crate::DWELL_LABEL) else {
            // Normally built by start_control; this covers a window that failed or was closed.
            crate::ensure_dwell_window(app);
            return;
        };
        let (x, y) = self.input.cursor_screen_point(cursor);
        let radius = (24.0 * window.scale_factor().unwrap_or(1.0)).round() as i32;
        let _ = window.set_position(PhysicalPosition::new(x - radius, y - radius));
        let _ = app.emit_to(crate::DWELL_LABEL, "dwell-progress", progress);
        if !self.overlay_visible {
            let _ = window.show();
            self.overlay_visible = true;
        }
    }
}

#[derive(Serialize)]
pub struct CoreStatus {
    frames_received: u64,
    fps: f64,
    running: bool,
    armed: bool,
    pose: Pose,
    mode: ControlMode,
}

#[tauri::command]
pub fn submit_frame(
    frame: LandmarkFrame,
    app: AppHandle,
    state: State<'_, ControlState>,
) -> Result<CoreStatus, String> {
    if !frame.timestamp_ms.is_finite() || frame.hands.len() > 2 {
        return Err("invalid frame metadata".into());
    }
    for hand in &frame.hands {
        if !matches!(hand.handedness.as_str(), "Left" | "Right")
            || !hand.score.is_finite()
            || hand.landmarks.len() != 21
            || hand
                .landmarks
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err("invalid hand landmarks".into());
        }
    }
    let now = Instant::now();
    let mut controller = state.0.lock().map_err(|_| "control state unavailable")?;
    controller.frames_received += 1;
    controller.last_frame = Some(now);
    controller.recent_frames.push_back(now);
    while controller
        .recent_frames
        .front()
        .is_some_and(|first| now.duration_since(*first) > Duration::from_secs(1))
    {
        controller.recent_frames.pop_front();
    }
    if controller.running && controller.armed {
        let hand = frame
            .hands
            .iter()
            .filter(|hand| hand.handedness == "Right" && hand.score >= 0.5)
            .max_by(|a, b| a.score.total_cmp(&b.score));
        if let Some(hand) = hand {
            controller.last_hand = Some(now);
            let points: &[[f32; 3]; 21] = hand
                .landmarks
                .as_slice()
                .try_into()
                .map_err(|_| "invalid landmark count")?;
            let elapsed_ms = now.duration_since(controller.started).as_millis() as u64;
            let mask = posture_mask(points);
            let custom_action = controller.custom.observe(points, elapsed_ms);
            let custom_owns_pose = controller.custom.has_mask(mask);
            let (pose, actions, dwell) = match controller.settings.mode {
                ControlMode::Standard => {
                    let result = controller.gesture.process(points, elapsed_ms);
                    (result.pose, result.actions, None)
                }
                ControlMode::Lazy => {
                    let speed = controller.settings.lazy_speed;
                    let dwell_ms = controller.settings.lazy_dwell_ms;
                    let result = controller.lazy.process(points, elapsed_ms, speed, dwell_ms);
                    (
                        result.pose,
                        result.actions,
                        Some((result.progress, result.cursor)),
                    )
                }
            };
            controller.pose = pose;
            for action in actions.into_iter().flatten() {
                if controller.custom.overrides(action) {
                    continue;
                }
                if custom_owns_pose
                    && matches!(
                        action,
                        crate::input::MouseAction::Scroll(_)
                            | crate::input::MouseAction::RightClick
                    )
                {
                    continue;
                }
                if let Err(error) = controller.input.apply(action) {
                    controller.pause();
                    controller.hide_dwell(&app);
                    return Err(error);
                }
            }
            if let Some(action) = custom_action {
                if let Err(error) = controller.input.control(&action) {
                    controller.pause();
                    controller.hide_dwell(&app);
                    return Err(error);
                }
            }
            if let Some((progress, cursor)) = dwell {
                controller.update_dwell(&app, progress, cursor);
            } else {
                controller.hide_dwell(&app);
            }
        } else {
            // Brief low-light misses should freeze the cursor, not reset its smoothing state.
            // Longer misses release a drag before the no-frame watchdog would fire.
            if controller
                .last_hand
                .is_none_or(|last| now.duration_since(last) > Duration::from_millis(180))
            {
                controller.gesture.reset();
                controller.custom.reset();
                controller.lazy.reset();
                controller.input.release_all()?;
                controller.pose = Pose::Clutch;
                controller.hide_dwell(&app);
            }
        }
    }
    controller.watchdog();
    if !controller.armed {
        controller.hide_dwell(&app);
    }
    // Holo Mode's hand cursor and skeleton come straight from here, so each frame crosses
    // the IPC boundary once instead of being re-sent from the preview window.
    if crate::holo::is_visible() {
        let _ = app.emit_to(
            crate::holo::WINDOW_LABEL,
            "holo-hand",
            holo_hand(&frame, controller.pose),
        );
    }
    Ok(controller.status())
}

/// Hand data for Holo Mode's cursor: pinch gap, 2D landmarks and the current pose.
#[derive(Clone, Serialize)]
struct HoloHand {
    /// Thumb-to-index gap divided by wrist-to-middle-MCP length.
    gap: f32,
    points: Vec<[f32; 2]>,
    pose: Pose,
}

fn holo_hand(frame: &LandmarkFrame, pose: Pose) -> Option<HoloHand> {
    let hand = frame
        .hands
        .iter()
        .find(|hand| hand.handedness == "Right" && hand.score >= 0.5)?;
    let p = &hand.landmarks;
    let scale = (p[0][0] - p[9][0]).hypot(p[0][1] - p[9][1]).max(0.001);
    Some(HoloHand {
        gap: (p[4][0] - p[8][0]).hypot(p[4][1] - p[8][1]) / scale,
        points: p.iter().map(|point| [point[0], point[1]]).collect(),
        pose,
    })
}

#[tauri::command]
pub fn start_control(app: AppHandle, state: State<'_, ControlState>) -> Result<CoreStatus, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("preview window unavailable")?;
    let mut controller = state.0.lock().map_err(|_| "control state unavailable")?;
    controller.running = true;
    controller.armed = true;
    controller.last_frame = Some(Instant::now());
    controller.last_hand = Some(Instant::now());
    controller.gesture.reset();
    controller.custom.reset();
    controller.lazy = LazyEngine::new(controller.input.cursor_normalized());
    controller.pose = Pose::Clutch;
    controller.hide_dwell(&app);
    if controller.settings.mode == ControlMode::Lazy {
        crate::ensure_dwell_window(&app);
    }
    let status = controller.status();
    drop(controller);
    if let Some(watchdog) = crate::WATCHDOG.get() {
        watchdog.unpark();
    }
    window
        .set_skip_taskbar(true)
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(-32000, -32000))
        .map_err(|error| error.to_string())?;
    Ok(status)
}

#[tauri::command]
pub fn stop_control(app: AppHandle, state: State<'_, ControlState>) -> Result<CoreStatus, String> {
    let mut controller = state.0.lock().map_err(|_| "control state unavailable")?;
    controller.pause();
    controller.running = false;
    controller.hide_dwell(&app);
    Ok(controller.status())
}

#[tauri::command]
pub fn resume_control(state: State<'_, ControlState>) -> Result<CoreStatus, String> {
    let mut controller = state.0.lock().map_err(|_| "control state unavailable")?;
    controller.resume();
    Ok(controller.status())
}

#[tauri::command]
pub fn show_preview(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("preview window unavailable")?;
    window
        .set_skip_taskbar(false)
        .map_err(|error| error.to_string())?;
    window.center().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_calibration(state: State<'_, ControlState>) -> Result<Calibration, String> {
    let controller = state.0.lock().map_err(|_| "control state unavailable")?;
    Ok(controller.gesture.calibration())
}

#[tauri::command]
pub fn set_calibration(
    calibration: Calibration,
    state: State<'_, ControlState>,
) -> Result<Calibration, String> {
    let calibration = calibration.validate()?;
    let mut controller = state.0.lock().map_err(|_| "control state unavailable")?;
    if controller.running {
        return Err("stop control before calibrating".into());
    }
    calibration.save()?;
    controller.gesture.set_calibration(calibration);
    Ok(calibration)
}

#[tauri::command]
pub fn set_sensitivity(
    sensitivity: f32,
    state: State<'_, ControlState>,
) -> Result<Calibration, String> {
    let mut controller = state.0.lock().map_err(|_| "control state unavailable")?;
    let mut calibration = controller.gesture.calibration();
    calibration.sensitivity = sensitivity;
    let calibration = calibration.validate()?;
    calibration.save()?;
    controller.gesture.set_calibration(calibration);
    Ok(calibration)
}

#[tauri::command]
pub fn get_control_settings(state: State<'_, ControlState>) -> Result<ControlSettings, String> {
    let controller = state.0.lock().map_err(|_| "control state unavailable")?;
    Ok(controller.settings)
}

#[tauri::command]
pub fn set_control_settings(
    settings: ControlSettings,
    app: AppHandle,
    state: State<'_, ControlState>,
) -> Result<ControlSettings, String> {
    let settings = settings.validate()?;
    let mut controller = state.0.lock().map_err(|_| "control state unavailable")?;
    if controller.running {
        return Err("stop control before changing mode".into());
    }
    settings.save()?;
    controller.settings = settings;
    controller.lazy = LazyEngine::new(controller.input.cursor_normalized());
    if settings.mode != ControlMode::Lazy {
        controller.overlay_visible = false;
        crate::close_dwell_window(&app);
    }
    Ok(settings)
}

#[tauri::command]
pub fn list_custom_gestures(state: State<'_, ControlState>) -> Result<Vec<GestureSummary>, String> {
    let controller = state.0.lock().map_err(|_| "control state unavailable")?;
    Ok(controller.custom.summaries())
}

#[tauri::command]
pub fn record_custom_gesture(
    name: String,
    action: String,
    frames: Vec<RecordingFrame>,
    state: State<'_, ControlState>,
) -> Result<Vec<GestureSummary>, String> {
    let mut controller = state.0.lock().map_err(|_| "control state unavailable")?;
    if controller.running {
        return Err("stop control before recording a gesture".into());
    }
    controller.custom.add(name, action, frames)
}

#[tauri::command]
pub fn delete_custom_gesture(
    id: u64,
    state: State<'_, ControlState>,
) -> Result<Vec<GestureSummary>, String> {
    let mut controller = state.0.lock().map_err(|_| "control state unavailable")?;
    if controller.running {
        return Err("stop control before deleting a gesture".into());
    }
    controller.custom.delete(id)
}
