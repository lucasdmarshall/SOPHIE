use crate::calibration::Calibration;
use crate::filter::OneEuro;
use crate::input::MouseAction;
use crate::stabilizer::Stabilizer;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Pose {
    Cursor,
    RightClick,
    Scroll,
    OpenPalm,
    Clutch,
}

#[derive(Debug, Clone, Copy)]
pub struct GestureResult {
    pub pose: Pose,
    pub actions: [Option<MouseAction>; 3],
}

pub struct GestureEngine {
    calibration: Calibration,
    pose: Pose,
    candidate: Pose,
    candidate_frames: u8,
    left_pinched: bool,
    pinch_started_ms: u64,
    pinch_anchor: (f32, f32),
    previous_anchor: Option<(f32, f32)>,
    dragging: bool,
    /// Consecutive frames the pinch has looked open; one noisy frame must not drop a drag.
    open_frames: u8,
    /// Last time the hand was in the cursor pose, so a pinch that bends the index
    /// still counts as starting from Cursor.
    last_cursor_ms: Option<u64>,
    right_pose_started_ms: Option<u64>,
    right_click_fired: bool,
    stabilizer: Stabilizer,
    /// Cursor output is frozen until this time after a click or drop, so the fingers
    /// reopening do not drag the cursor off the target.
    hold_until_ms: u64,
    was_cursor_active: bool,
    /// Rest point to restore once a pose change away from Cursor is confirmed.
    pending_rewind: Option<(f32, f32)>,
    last_emitted_cursor: Option<(f32, f32)>,
    offset: (f32, f32),
    needs_reanchor: bool,
    last_scroll_y: Option<f32>,
    scroll_y_filter: OneEuro,
    scroll_remainder: f32,
}

impl Default for GestureEngine {
    fn default() -> Self {
        Self::with_calibration(Calibration::default())
    }
}

impl GestureEngine {
    pub fn with_calibration(calibration: Calibration) -> Self {
        Self {
            calibration,
            pose: Pose::Clutch,
            candidate: Pose::Clutch,
            candidate_frames: 0,
            left_pinched: false,
            pinch_started_ms: 0,
            pinch_anchor: (0.0, 0.0),
            previous_anchor: None,
            dragging: false,
            open_frames: 0,
            last_cursor_ms: None,
            right_pose_started_ms: None,
            right_click_fired: false,
            stabilizer: Stabilizer::default(),
            hold_until_ms: 0,
            was_cursor_active: false,
            pending_rewind: None,
            last_emitted_cursor: None,
            offset: (0.0, 0.0),
            needs_reanchor: true,
            last_scroll_y: None,
            scroll_y_filter: OneEuro::default(),
            scroll_remainder: 0.0,
        }
    }

    pub fn reset(&mut self) -> Option<MouseAction> {
        let release = self.dragging.then_some(MouseAction::LeftUp);
        let last_cursor = self.last_emitted_cursor;
        *self = Self::with_calibration(self.calibration);
        self.last_emitted_cursor = last_cursor;
        release
    }

    pub fn calibration(&self) -> Calibration {
        self.calibration
    }

    pub fn set_calibration(&mut self, calibration: Calibration) {
        self.calibration = calibration;
        self.stabilizer.clear();
        self.needs_reanchor = true;
    }

    pub fn process(&mut self, points: &[[f32; 3]; 21], now_ms: u64) -> GestureResult {
        let raw_pose = classify(points);
        if raw_pose == self.candidate {
            self.candidate_frames = self.candidate_frames.saturating_add(1);
        } else {
            self.candidate = raw_pose;
            self.candidate_frames = 1;
        }
        if self.candidate_frames >= 3 && !self.left_pinched {
            self.pose = raw_pose;
        }

        let anchor = (
            (points[5][0] + points[9][0]) * 0.5,
            (points[5][1] + points[9][1]) * 0.5,
        );
        let anchor_delta = self
            .previous_anchor
            .map_or((0.0, 0.0), |last| (anchor.0 - last.0, anchor.1 - last.1));
        self.previous_anchor = Some(anchor);
        let mapped = (
            self.calibration.map_x(anchor.0),
            self.calibration.map_y(anchor.1),
        );
        let mut actions = [None; 3];
        let mut count = 0;
        let scale = distance(points[0], points[9]).max(0.001);
        let left_distance = distance(points[4], points[8]) / scale;
        let right_distance = distance(points[4], points[12]) / scale;

        if self.pose == Pose::Cursor && raw_pose == Pose::Cursor {
            self.last_cursor_ms = Some(now_ms);
        }
        // A drag gets a wider release threshold: the hand moves, so the pinch gap jitters more.
        let release_gap = if self.dragging {
            PINCH_RELEASE_DRAGGING
        } else {
            PINCH_RELEASE
        };
        if self.left_pinched && left_distance > release_gap {
            self.open_frames = self.open_frames.saturating_add(1);
        } else {
            self.open_frames = 0;
        }

        if self.left_pinched {
            if !self.dragging && right_distance < 0.25 && right_distance + 0.08 < left_distance {
                // A thumb moving toward the middle finger must not become a left click or drag.
                self.left_pinched = false;
            } else if self.open_frames >= RELEASE_FRAMES {
                self.left_pinched = false;
                self.open_frames = 0;
                if self.dragging {
                    // Opening the pinch shifts the hand; drop where the hand had rested.
                    if let Some(point) = self.stabilizer.rewind_point(now_ms) {
                        actions[count] = Some(MouseAction::Move {
                            x: point.0,
                            y: point.1,
                        });
                        count += 1;
                        self.last_emitted_cursor = Some(point);
                    }
                    actions[count] = Some(MouseAction::LeftUp);
                    count += 1;
                    self.dragging = false;
                } else {
                    actions[count] = Some(MouseAction::LeftClick);
                    count += 1;
                }
                self.hold_until_ms = now_ms + RELEASE_HOLD_MS;
                self.needs_reanchor = true;
            } else if !self.dragging
                && (now_ms.saturating_sub(self.pinch_started_ms) >= 250
                    || (now_ms.saturating_sub(self.pinch_started_ms) >= 80
                        && (anchor.0 - self.pinch_anchor.0).hypot(anchor.1 - self.pinch_anchor.1)
                            >= 0.012))
            {
                actions[count] = Some(MouseAction::LeftDown);
                count += 1;
                self.dragging = true;
            }
        } else if (self.pose == Pose::Cursor
            || self
                .last_cursor_ms
                .is_some_and(|last| now_ms.saturating_sub(last) <= PINCH_POSE_GRACE_MS))
            && left_distance < PINCH_ENTER
            // The folded middle finger often sits near the thumb in a pinch, so only a
            // small margin is required for the thumb to be nearer the index tip.
            && left_distance + 0.03 < right_distance
        {
            self.open_frames = 0;
            self.left_pinched = true;
            self.pinch_started_ms = now_ms;
            self.pinch_anchor = anchor;
            // The thumb closing in moves the hand slightly before the pinch registers.
            // Undo that motion so the click or drag starts on the intended target.
            if let Some(point) = self.stabilizer.rewind_point(now_ms) {
                actions[count] = Some(MouseAction::Move {
                    x: point.0,
                    y: point.1,
                });
                count += 1;
                self.last_emitted_cursor = Some(point);
            }
            self.needs_reanchor = true;
        }

        if self.pose == Pose::RightClick && raw_pose == Pose::RightClick && !self.left_pinched {
            let started = *self.right_pose_started_ms.get_or_insert(now_ms);
            if !self.right_click_fired && now_ms.saturating_sub(started) >= 180 {
                actions[count] = Some(MouseAction::RightClick);
                count += 1;
                self.right_click_fired = true;
            }
        } else if self.pose != Pose::RightClick {
            self.right_pose_started_ms = None;
            self.right_click_fired = false;
        }

        let cursor_active = (self.pose == Pose::Cursor && raw_pose == Pose::Cursor)
            || self.left_pinched
            || self.dragging;
        if cursor_active && now_ms < self.hold_until_ms {
            self.pending_rewind = None;
            self.needs_reanchor = true;
        } else if cursor_active {
            self.pending_rewind = None;
            if self.needs_reanchor {
                if let Some(last) = self.last_emitted_cursor {
                    self.offset = (last.0 - mapped.0, last.1 - mapped.1);
                }
            }
            if raw_pose == Pose::Cursor && !self.left_pinched && !self.needs_reanchor {
                // Edge reach is displacement-driven: holding still never adds drift.
                self.offset.0 += self.calibration.pan_x(anchor.0).abs() * anchor_delta.0 * 4.0;
                self.offset.1 += self.calibration.pan_y(anchor.1).abs() * anchor_delta.1 * 4.0;
            }
            let target = (
                (mapped.0 + self.offset.0).clamp(0.0, 1.0),
                (mapped.1 + self.offset.1).clamp(0.0, 1.0),
            );
            // Prevent accumulated edge-panning offset from winding up past the screen edge.
            self.offset = (target.0 - mapped.0, target.1 - mapped.1);
            if self.needs_reanchor {
                self.stabilizer.reset_to(target, now_ms);
                self.needs_reanchor = false;
            }
            let next = self.stabilizer.update(target, now_ms);
            // Keep the cursor stable at pinch start, unless a drag is underway.
            if (!self.left_pinched || self.dragging)
                && !actions[..count].iter().any(|action| {
                    matches!(
                        action,
                        Some(MouseAction::LeftClick | MouseAction::RightClick)
                    )
                })
                && self.last_emitted_cursor.is_none_or(|last| {
                    (next.0 - last.0).hypot(next.1 - last.1) >= MOVE_EMIT_DISTANCE
                })
                && count < actions.len()
            {
                actions[count] = Some(MouseAction::Move {
                    x: next.0,
                    y: next.1,
                });
                count += 1;
                self.last_emitted_cursor = Some(next);
            }
        } else {
            if self.was_cursor_active {
                // The finger rising for scroll/right-click (or curling into a fist) moves
                // the palm before the new pose is recognized. Remember where we rested.
                self.pending_rewind = self.stabilizer.rewind_point(now_ms);
            }
            if self.pose != Pose::Cursor {
                if let Some(point) = self.pending_rewind.take() {
                    if count < actions.len() {
                        actions[count] = Some(MouseAction::Move {
                            x: point.0,
                            y: point.1,
                        });
                        count += 1;
                        self.last_emitted_cursor = Some(point);
                    }
                }
            }
            self.needs_reanchor = true;
        }
        self.was_cursor_active = cursor_active && now_ms >= self.hold_until_ms;

        if self.pose == Pose::Scroll && raw_pose == Pose::Scroll && !self.left_pinched {
            let y = self.scroll_y_filter.update(anchor.1, now_ms);
            if let Some(last_y) = self.last_scroll_y {
                // Signed displacement allows immediate reversal without a stroke timer.
                // Accumulating sub-threshold motion keeps slow scrolling usable.
                let delta = (last_y - y).clamp(-0.05, 0.05);
                if delta * self.scroll_remainder < 0.0 {
                    self.scroll_remainder = 0.0;
                }
                self.scroll_remainder += delta * 3000.0;
                if self.scroll_remainder.abs() >= 30.0 && count < actions.len() {
                    let amount = (self.scroll_remainder / 30.0).trunc() as i32 * 30;
                    self.scroll_remainder -= amount as f32;
                    actions[count] = Some(MouseAction::Scroll(amount));
                }
            }
            self.last_scroll_y = Some(y);
        } else {
            self.last_scroll_y = None;
            self.scroll_y_filter.reset();
            self.scroll_remainder = 0.0;
        }

        GestureResult {
            pose: self.pose,
            actions,
        }
    }
}

const RELEASE_HOLD_MS: u64 = 150;
/// Thumb-to-index gap (relative to hand size) that starts a pinch.
const PINCH_ENTER: f32 = 0.25;
/// Gap that ends a pinch for a click.
const PINCH_RELEASE: f32 = 0.35;
/// Gap that ends a pinch while dragging.
const PINCH_RELEASE_DRAGGING: f32 = 0.42;
/// Frames the pinch must look open before it ends.
const RELEASE_FRAMES: u8 = 2;
/// A pinch may start this long after the cursor pose was last seen.
const PINCH_POSE_GRACE_MS: u64 = 300;
/// Thumb-to-index gap below which a bent index still counts as the cursor pose.
const PINCH_SHAPE_GAP: f32 = 0.35;
/// Smallest cursor step worth emitting; resting tremor is already held by the stabilizer.
const MOVE_EMIT_DISTANCE: f32 = 0.0012;

fn classify(points: &[[f32; 3]; 21]) -> Pose {
    let scale = distance(points[0], points[9]).max(0.001);
    let extended = |tip: usize, pip: usize| {
        distance(points[tip], points[0]) > distance(points[pip], points[0]) + 0.12 * scale
    };
    let middle = extended(12, 10);
    let ring = extended(16, 14);
    let pinky = extended(20, 18);
    // Pinching bends the index, which would otherwise read as a fist and cancel the pinch.
    // Unlike a fist, the bent index tip still reaches well past its knuckle.
    let pinch_shape = distance(points[4], points[8]) / scale < PINCH_SHAPE_GAP
        && distance(points[8], points[0]) > distance(points[5], points[0]) * 1.2;
    let index = extended(8, 6) || (pinch_shape && !middle && !ring && !pinky);
    match (index, middle, ring, pinky) {
        (true, false, false, false) => Pose::Cursor,
        (true, true, false, false) => Pose::Scroll,
        (true, true, true, false) => Pose::RightClick,
        _ => Pose::Clutch,
    }
}

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cursor_hand() -> [[f32; 3]; 21] {
        let mut p = [[0.5, 0.7, 0.0]; 21];
        p[0] = [0.5, 0.9, 0.0];
        p[4] = [0.2, 0.5, 0.0];
        p[5] = [0.4, 0.6, 0.0];
        p[6] = [0.4, 0.5, 0.0];
        p[8] = [0.4, 0.2, 0.0];
        p[9] = [0.5, 0.6, 0.0];
        p[10] = [0.5, 0.5, 0.0];
        p[12] = [0.5, 0.56, 0.0];
        p[14] = [0.6, 0.5, 0.0];
        p[16] = [0.6, 0.56, 0.0];
        p[18] = [0.7, 0.58, 0.0];
        p[20] = [0.7, 0.6, 0.0];
        p
    }

    fn actions(result: GestureResult) -> Vec<MouseAction> {
        result.actions.into_iter().flatten().collect()
    }

    #[test]
    fn cursor_requires_three_frames_and_fist_clutches() {
        let mut engine = GestureEngine::default();
        let hand = cursor_hand();
        assert_eq!(engine.process(&hand, 0).pose, Pose::Clutch);
        assert_eq!(engine.process(&hand, 33).pose, Pose::Clutch);
        let result = engine.process(&hand, 66);
        assert_eq!(result.pose, Pose::Cursor);
        assert!(actions(result)
            .iter()
            .any(|action| matches!(action, MouseAction::Move { .. })));
        let mut fist = hand;
        fist[8] = [0.4, 0.56, 0.0];
        engine.process(&fist, 99);
        engine.process(&fist, 132);
        let result = engine.process(&fist, 165);
        assert_eq!(result.pose, Pose::Clutch);
        assert!(actions(result).is_empty());
    }

    #[test]
    fn short_pinch_clicks_and_long_pinch_drags() {
        let mut engine = GestureEngine::default();
        let hand = cursor_hand();
        for time in [0, 33, 66] {
            engine.process(&hand, time);
        }
        let mut pinch = hand;
        pinch[4] = [0.4, 0.21, 0.0];
        engine.process(&pinch, 100);
        let mut click = actions(engine.process(&hand, 180));
        click.extend(actions(engine.process(&hand, 213)));
        assert!(click.contains(&MouseAction::LeftClick));
        engine.process(&pinch, 300);
        let down = engine.process(&pinch, 560);
        assert!(actions(down).contains(&MouseAction::LeftDown));
        let mut up = actions(engine.process(&hand, 600));
        up.extend(actions(engine.process(&hand, 633)));
        assert!(up.contains(&MouseAction::LeftUp));
    }

    #[test]
    fn moving_pinch_starts_drag_and_tracking_reset_releases() {
        let mut engine = GestureEngine::default();
        let hand = cursor_hand();
        for time in [0, 33, 66] {
            engine.process(&hand, time);
        }
        let mut pinch = hand;
        pinch[4] = [0.4, 0.21, 0.0];
        engine.process(&pinch, 100);
        for point in &mut pinch {
            point[0] += 0.03;
        }
        let result = actions(engine.process(&pinch, 190));
        assert!(result.contains(&MouseAction::LeftDown));
        assert!(result.iter().any(|a| matches!(a, MouseAction::Move { .. })));
        assert!(!result.contains(&MouseAction::LeftClick));
        assert_eq!(engine.reset(), Some(MouseAction::LeftUp));
        assert_eq!(engine.reset(), None);
    }

    #[test]
    fn stationary_victory_jitter_never_scrolls_clicks_or_moves() {
        let mut engine = GestureEngine::default();
        let mut hand = cursor_hand();
        hand[12] = [0.5, 0.2, 0.0];
        for time in [0, 33, 66] {
            engine.process(&hand, time);
        }
        for frame in 1..=90 {
            let mut noisy = hand;
            for point in &mut noisy {
                point[1] += if frame % 2 == 0 { 0.002 } else { -0.002 };
            }
            assert!(actions(engine.process(&noisy, 66 + frame * 33)).is_empty());
        }
        let mut open = hand;
        open[16] = [0.6, 0.2, 0.0];
        open[20] = [0.7, 0.2, 0.0];
        assert_eq!(classify(&open), Pose::Clutch);
    }

    #[test]
    fn middle_pinch_does_not_right_click_or_left_drag() {
        let mut engine = GestureEngine::default();
        let hand = cursor_hand();
        for time in [0, 33, 66] {
            engine.process(&hand, time);
        }
        let mut middle_pinch = hand;
        middle_pinch[4] = [0.5, 0.57, 0.0];
        let mut all = Vec::new();
        for time in [100, 200, 400] {
            all.extend(actions(engine.process(&middle_pinch, time)));
        }
        all.extend(actions(engine.process(&hand, 450)));
        assert!(!all.contains(&MouseAction::RightClick));
        assert!(!all
            .iter()
            .any(|action| matches!(action, MouseAction::LeftDown | MouseAction::LeftClick)));
    }

    #[test]
    fn ambiguous_pinch_does_not_select_text() {
        let mut engine = GestureEngine::default();
        let hand = cursor_hand();
        for time in [0, 33, 66] {
            engine.process(&hand, time);
        }
        let mut ambiguous = hand;
        ambiguous[4] = [0.45, 0.4, 0.0];
        ambiguous[8] = [0.44, 0.38, 0.0];
        ambiguous[12] = [0.46, 0.42, 0.0];
        for time in [100, 200, 400] {
            let result = actions(engine.process(&ambiguous, time));
            assert!(!result.iter().any(|action| matches!(
                action,
                MouseAction::LeftDown | MouseAction::LeftClick | MouseAction::RightClick
            )));
        }
    }

    #[test]
    fn pinch_switching_to_middle_cancels_pending_left_click_without_right_click() {
        let mut engine = GestureEngine::default();
        let hand = cursor_hand();
        for time in [0, 33, 66] {
            engine.process(&hand, time);
        }
        let mut near_index = hand;
        near_index[4] = [0.4, 0.21, 0.0];
        engine.process(&near_index, 100);
        let mut near_middle = hand;
        near_middle[4] = [0.5, 0.57, 0.0];
        let switched = actions(engine.process(&near_middle, 200));
        let released = actions(engine.process(&hand, 240));
        assert!(!switched
            .iter()
            .chain(released.iter())
            .any(|action| matches!(action, MouseAction::LeftClick | MouseAction::LeftDown)));
        assert!(!released.contains(&MouseAction::RightClick));
    }

    #[test]
    fn three_raised_fingers_right_click_once() {
        let mut engine = GestureEngine::default();
        let hand = cursor_hand();
        for time in [0, 33, 66] {
            engine.process(&hand, time);
        }
        let mut two = hand;
        two[12] = [0.5, 0.2, 0.0];
        two[16] = [0.6, 0.2, 0.0];
        let mut all = Vec::new();
        for time in [100, 133, 166, 200, 266, 366, 500, 700] {
            all.extend(actions(engine.process(&two, time)));
        }
        assert_eq!(
            all.iter()
                .filter(|action| **action == MouseAction::RightClick)
                .count(),
            1
        );
        assert!(!all
            .iter()
            .any(|action| matches!(action, MouseAction::LeftDown | MouseAction::LeftClick)));
    }

    #[test]
    fn victory_scroll_reverses_without_pause() {
        let mut engine = GestureEngine::default();
        let hand = cursor_hand();
        for time in [0, 33, 66] {
            engine.process(&hand, time);
        }
        let mut open = hand;
        open[12] = [0.5, 0.2, 0.0];
        open[4] = open[3];
        assert_eq!(classify(&open), Pose::Scroll);
        for time in [99, 132, 165] {
            engine.process(&open, time);
        }
        let mut up = Vec::new();
        for frame in 1..=10 {
            let mut swept = open;
            for point in &mut swept {
                point[1] -= frame as f32 * 0.015;
            }
            up.extend(actions(engine.process(&swept, 165 + frame * 33)));
        }
        assert!(up
            .iter()
            .any(|action| matches!(action, MouseAction::Scroll(delta) if *delta > 0)));
        let mut returned = Vec::new();
        for frame in 1..=10 {
            let mut swept = open;
            for point in &mut swept {
                point[1] -= (10 - frame) as f32 * 0.015;
            }
            returned.extend(actions(engine.process(&swept, 495 + frame * 33)));
        }
        assert!(returned
            .iter()
            .any(|action| matches!(action, MouseAction::Scroll(delta) if *delta < 0)));
        for frame in 1..=20 {
            engine.process(&open, 825 + frame * 33);
        }
        let mut down = Vec::new();
        for frame in 1..=10 {
            let mut swept = open;
            for point in &mut swept {
                point[1] += frame as f32 * 0.015;
            }
            down.extend(actions(engine.process(&swept, 1485 + frame * 33)));
        }
        assert!(down
            .iter()
            .any(|action| matches!(action, MouseAction::Scroll(delta) if *delta < 0)));
    }

    #[test]
    fn stable_hand_noise_does_not_emit_cursor_moves() {
        let mut engine = GestureEngine::default();
        let hand = cursor_hand();
        for time in [0, 33, 66] {
            engine.process(&hand, time);
        }
        let mut moves = 0;
        for frame in 1..=30 {
            let mut noisy = hand;
            let jitter = if frame % 2 == 0 { 0.001 } else { -0.001 };
            noisy[5][0] += jitter;
            noisy[9][0] += jitter;
            moves += actions(engine.process(&noisy, 66 + frame * 33))
                .iter()
                .filter(|action| matches!(action, MouseAction::Move { .. }))
                .count();
        }
        assert!(moves <= 1, "stable hand caused {moves} cursor moves");
        let mut moved = hand;
        moved[5][0] += 0.05;
        moved[9][0] += 0.05;
        let moved_actions = actions(engine.process(&moved, 1100));
        assert!(moved_actions
            .iter()
            .any(|action| matches!(action, MouseAction::Move { .. })));
    }

    #[test]
    fn clutch_keeps_cursor_at_last_position_on_reentry() {
        let mut engine = GestureEngine::default();
        let hand = cursor_hand();
        for time in [0, 33, 66] {
            engine.process(&hand, time);
        }
        let previous = engine.last_emitted_cursor.unwrap();
        let mut fist = hand;
        fist[8] = [0.4, 0.56, 0.0];
        for point in &mut fist {
            point[0] += 0.15;
        }
        for time in [99, 132, 165] {
            engine.process(&fist, time);
        }
        let mut shifted = hand;
        for point in &mut shifted {
            point[0] += 0.15;
        }
        for time in [198, 231, 264] {
            engine.process(&shifted, time);
        }
        let resumed = engine.last_emitted_cursor.unwrap();
        assert!((resumed.0 - previous.0).abs() < 0.002);
    }

    #[test]
    fn holding_near_edge_does_not_drift() {
        let mut engine = GestureEngine::default();
        let mut hand = cursor_hand();
        for point in &mut hand {
            point[0] += 0.3;
        }
        for time in [0, 33, 66] {
            engine.process(&hand, time);
        }
        let first = engine.last_emitted_cursor.unwrap().0;
        for frame in 3..33 {
            engine.process(&hand, frame * 33);
        }
        let last = engine.last_emitted_cursor.unwrap().0;
        assert!(
            (last - first).abs() < 0.003,
            "stationary edge cursor drifted: {first} -> {last}"
        );
    }

    fn shift_anchor(hand: &mut [[f32; 3]; 21], dx: f32) {
        hand[5][0] += dx;
        hand[9][0] += dx;
    }

    fn rest_engine(hand: &[[f32; 3]; 21]) -> (GestureEngine, (f32, f32)) {
        let mut engine = GestureEngine::default();
        for frame in 0..15 {
            engine.process(hand, frame * 33);
        }
        let rest = engine.last_emitted_cursor.unwrap();
        (engine, rest)
    }

    #[test]
    fn pinch_approach_motion_is_undone_before_click() {
        let hand = cursor_hand();
        let (mut engine, rest) = rest_engine(&hand);
        // Thumb closing in drags the palm anchor sideways for a few frames.
        let mut approaching = hand;
        let mut emitted = Vec::new();
        for (i, time) in [495, 528, 561].into_iter().enumerate() {
            shift_anchor(&mut approaching, 0.004);
            approaching[4] = [0.3 + i as f32 * 0.03, 0.35, 0.0];
            emitted.extend(actions(engine.process(&approaching, time)));
        }
        let mut pinch = approaching;
        pinch[4] = [0.4 + 0.012, 0.21, 0.0];
        emitted.extend(actions(engine.process(&pinch, 594)));
        let mut click = actions(engine.process(&approaching, 660));
        click.extend(actions(engine.process(&approaching, 693)));
        assert!(click.contains(&MouseAction::LeftClick));
        let at_click = engine.last_emitted_cursor.unwrap();
        assert!(
            (at_click.0 - rest.0).abs() < 0.0005,
            "click landed at {at_click:?}, rested at {rest:?}"
        );
        // Opening the fingers right after the click does not move the cursor.
        let mut after = Vec::new();
        for time in [726, 759] {
            after.extend(actions(engine.process(&hand, time)));
        }
        assert!(!after.iter().any(|a| matches!(a, MouseAction::Move { .. })));
    }

    #[test]
    fn raising_fingers_for_right_click_keeps_cursor_on_target() {
        let hand = cursor_hand();
        let (mut engine, rest) = rest_engine(&hand);
        let mut rising = hand;
        shift_anchor(&mut rising, 0.006);
        engine.process(&rising, 495);
        let mut three = rising;
        three[12] = [0.5, 0.2, 0.0];
        three[16] = [0.6, 0.2, 0.0];
        let mut all = Vec::new();
        for time in [528, 561, 594, 627, 700, 800] {
            all.extend(actions(engine.process(&three, time)));
        }
        let restore = all
            .iter()
            .position(|a| matches!(a, MouseAction::Move { .. }))
            .expect("cursor not restored");
        let click = all
            .iter()
            .position(|a| *a == MouseAction::RightClick)
            .expect("no right click");
        assert!(restore < click);
        let at_click = engine.last_emitted_cursor.unwrap();
        assert!((at_click.0 - rest.0).abs() < 0.0005);
    }

    #[test]
    fn natural_tremor_holds_and_slow_aim_moves() {
        let hand = cursor_hand();
        let (mut engine, rest) = rest_engine(&hand);
        for frame in 0..60_u64 {
            let mut noisy = hand;
            let t = frame as f32 * 0.033;
            let jitter = 0.0015 * (2.0 * std::f32::consts::PI * 7.0 * t).sin();
            shift_anchor(&mut noisy, jitter);
            noisy[5][1] += jitter * 0.6;
            noisy[9][1] += jitter * 0.6;
            let moved = actions(engine.process(&noisy, 495 + frame * 33));
            assert!(!moved.iter().any(|a| matches!(a, MouseAction::Move { .. })));
        }
        // Slow deliberate aim: 0.012 camera units per second.
        let start = 495 + 60 * 33;
        for frame in 1..=60_u64 {
            let mut aimed = hand;
            shift_anchor(&mut aimed, frame as f32 * 0.033 * 0.012);
            engine.process(&aimed, start + frame * 33);
        }
        let moved = engine.last_emitted_cursor.unwrap().0 - rest.0;
        let expected = 60.0 * 0.033 * 0.012 / 0.6;
        assert!(
            moved > expected * 0.7,
            "slow aim moved {moved} of {expected}"
        );
    }

    /// Cursor hand pinching with the index bent, as real pinches look.
    fn bent_pinch(hand: &[[f32; 3]; 21]) -> [[f32; 3]; 21] {
        let mut pinch = *hand;
        pinch[8] = [0.38, 0.48, 0.0];
        pinch[4] = [0.37, 0.49, 0.0];
        pinch
    }

    #[test]
    fn bent_index_pinch_still_reads_as_cursor_but_fist_does_not() {
        let hand = cursor_hand();
        let pinch = bent_pinch(&hand);
        assert_eq!(classify(&pinch), Pose::Cursor);
        let mut fist = hand;
        fist[8] = [0.42, 0.62, 0.0];
        fist[4] = [0.43, 0.6, 0.0];
        assert_eq!(classify(&fist), Pose::Clutch);
    }

    #[test]
    fn slow_bent_pinch_and_move_drags() {
        let hand = cursor_hand();
        let (mut engine, _) = rest_engine(&hand);
        // The thumb closes slowly over several frames while the index bends.
        let mut all = Vec::new();
        // Index already bent, thumb close but not yet touching: this used to read as a fist
        // for three frames, flip the pose to Clutch and make the pinch impossible.
        let mut closing = hand;
        closing[8] = [0.38, 0.48, 0.0];
        closing[4] = [0.30, 0.45, 0.0];
        for time in [495, 528, 561, 594] {
            all.extend(actions(engine.process(&closing, time)));
        }
        let mut pinch = bent_pinch(&hand);
        all.extend(actions(engine.process(&pinch, 627)));
        for step in 1..=8 {
            for point in &mut pinch {
                point[0] += 0.01;
            }
            all.extend(actions(engine.process(&pinch, 627 + step * 33)));
        }
        assert!(
            all.contains(&MouseAction::LeftDown),
            "pinch never became a drag"
        );
        assert!(
            !all.contains(&MouseAction::LeftUp),
            "drag dropped while pinched"
        );
        assert!(all.iter().any(|a| matches!(a, MouseAction::Move { .. })));
    }

    #[test]
    fn one_noisy_open_frame_does_not_drop_a_drag() {
        let hand = cursor_hand();
        let (mut engine, _) = rest_engine(&hand);
        let mut pinch = hand;
        pinch[4] = [0.4, 0.21, 0.0];
        engine.process(&pinch, 495);
        let mut all = Vec::new();
        for step in 1..=12_u64 {
            let mut frame = pinch;
            for point in &mut frame {
                point[0] += step as f32 * 0.008;
            }
            if step == 6 {
                // Landmark jitter: the thumb tip jumps away for a single frame.
                frame[4] = [frame[4][0] - 0.14, 0.21, 0.0];
            }
            all.extend(actions(engine.process(&frame, 495 + step * 33)));
        }
        assert!(all.contains(&MouseAction::LeftDown));
        assert!(
            !all.contains(&MouseAction::LeftUp),
            "single noisy frame dropped the drag"
        );
        let mut opened = hand;
        for point in &mut opened {
            point[0] += 0.1;
        }
        let mut end = actions(engine.process(&opened, 900));
        end.extend(actions(engine.process(&opened, 933)));
        assert!(end.contains(&MouseAction::LeftUp));
    }
}
