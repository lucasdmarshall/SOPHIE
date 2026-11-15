use crate::filter::OneEuro;
use crate::gesture::Pose;
use crate::input::MouseAction;

const SHAKE_RADIUS: f32 = 0.018;
const REARM_DISTANCE: f32 = 0.025;

pub struct LazyResult {
    pub pose: Pose,
    pub actions: [Option<MouseAction>; 3],
    pub progress: Option<f32>,
    pub cursor: (f32, f32),
}

pub struct LazyEngine {
    pose: Pose,
    candidate: Pose,
    candidate_frames: u8,
    cursor: (f32, f32),
    last_emitted: (f32, f32),
    finger_x: OneEuro,
    finger_y: OneEuro,
    finger_anchor: Option<(f32, f32)>,
    dwell_origin: (f32, f32),
    dwell_started: Option<u64>,
    click_armed: bool,
    last_click: (f32, f32),
    right_started: Option<u64>,
    right_fired: bool,
    scroll_last: Option<f32>,
    scroll_remainder: f32,
    drag_started: Option<u64>,
    drag_latched: bool,
    dragging: bool,
}

impl LazyEngine {
    pub fn new(cursor: (f32, f32)) -> Self {
        Self {
            pose: Pose::Cursor,
            candidate: Pose::Cursor,
            candidate_frames: 0,
            cursor,
            last_emitted: cursor,
            finger_x: OneEuro::default(),
            finger_y: OneEuro::default(),
            finger_anchor: None,
            dwell_origin: cursor,
            dwell_started: None,
            click_armed: false,
            last_click: cursor,
            right_started: None,
            right_fired: false,
            scroll_last: None,
            scroll_remainder: 0.0,
            drag_started: None,
            drag_latched: false,
            dragging: false,
        }
    }

    pub fn reset(&mut self) -> Option<MouseAction> {
        let release = self.dragging.then_some(MouseAction::LeftUp);
        *self = Self::new(self.cursor);
        release
    }

    #[cfg(test)]
    pub fn cursor(&self) -> (f32, f32) {
        self.cursor
    }

    pub fn process(
        &mut self,
        points: &[[f32; 3]; 21],
        now_ms: u64,
        speed: f32,
        dwell_ms: u64,
    ) -> LazyResult {
        let local = finger_local(points);
        let raw_pose = lazy_pose(points);
        if raw_pose == self.candidate {
            self.candidate_frames = self.candidate_frames.saturating_add(1);
        } else {
            self.candidate = raw_pose;
            self.candidate_frames = 1;
        }
        if self.candidate_frames >= 3 {
            self.pose = raw_pose;
        }
        let pose = self.pose;
        let mut actions = [None; 3];
        let mut count = 0;

        if pose != Pose::Cursor {
            self.dwell_started = None;
            self.click_armed = false;
            self.finger_anchor = None;
            self.finger_x.reset();
            self.finger_y.reset();
        }

        match pose {
            Pose::Cursor => {
                self.right_started = None;
                self.right_fired = false;
                self.scroll_last = None;
                self.drag_started = None;
                self.drag_latched = false;
                let filtered = (
                    self.finger_x.update(local.0, now_ms),
                    self.finger_y.update(local.1, now_ms),
                );
                let anchor = self.finger_anchor.get_or_insert(filtered);
                let step_x = trackpad_step(filtered.0 - anchor.0, 0.03);
                let step_y = trackpad_step(filtered.1 - anchor.1, 0.035);
                anchor.0 += step_x;
                anchor.1 += step_y;
                self.cursor.0 = (self.cursor.0 + step_x * 1.4 * speed).clamp(0.0, 1.0);
                self.cursor.1 = (self.cursor.1 + step_y * 1.2 * speed).clamp(0.0, 1.0);
                if distance(self.cursor, self.last_emitted) >= 0.0015 {
                    actions[count] = Some(MouseAction::Move {
                        x: self.cursor.0,
                        y: self.cursor.1,
                    });
                    count += 1;
                    self.last_emitted = self.cursor;
                }
                if distance(self.cursor, self.last_click) >= REARM_DISTANCE {
                    self.click_armed = true;
                }
                let settled = step_x.abs() < 0.003 && step_y.abs() < 0.003;
                if !settled || distance(self.cursor, self.dwell_origin) > SHAKE_RADIUS {
                    self.dwell_origin = self.cursor;
                    self.dwell_started = None;
                }
                if settled && self.click_armed && !self.dragging {
                    let start = *self.dwell_started.get_or_insert(now_ms);
                    if now_ms.saturating_sub(start) >= dwell_ms {
                        actions[count] = Some(MouseAction::LeftClick);
                        self.click_armed = false;
                        self.last_click = self.cursor;
                        self.dwell_started = None;
                    }
                }
            }
            Pose::Scroll => {
                self.right_started = None;
                self.right_fired = false;
                self.drag_started = None;
                self.drag_latched = false;
                if let Some(last) = self.scroll_last {
                    self.scroll_remainder += (last - local.1) * 480.0 * speed;
                    if self.scroll_remainder.abs() >= 120.0 {
                        let steps = (self.scroll_remainder / 120.0).trunc() as i32;
                        self.scroll_remainder -= steps as f32 * 120.0;
                        actions[count] = Some(MouseAction::Scroll(steps * 120));
                    }
                }
                self.scroll_last = Some(local.1);
            }
            Pose::OpenPalm => {
                self.right_started = None;
                self.scroll_last = None;
                // Three raised fingers held for 900 ms toggles drag; all four raised pauses.
                if three_fingers(points) {
                    let start = *self.drag_started.get_or_insert(now_ms);
                    if now_ms.saturating_sub(start) >= 900 && !self.drag_latched {
                        actions[count] = Some(if self.dragging {
                            MouseAction::LeftUp
                        } else {
                            MouseAction::LeftDown
                        });
                        self.dragging = !self.dragging;
                        self.drag_latched = true;
                    }
                } else {
                    self.drag_started = None;
                    self.drag_latched = false;
                    if self.dragging {
                        actions[count] = Some(MouseAction::LeftUp);
                        self.dragging = false;
                    }
                }
            }
            Pose::Clutch | Pose::RightClick => {
                self.scroll_last = None;
                self.drag_started = None;
                self.drag_latched = false;
                if middle_only(points) {
                    let start = *self.right_started.get_or_insert(now_ms);
                    if now_ms.saturating_sub(start) >= 900 && !self.right_fired && !self.dragging {
                        actions[count] = Some(MouseAction::RightClick);
                        self.right_fired = true;
                    }
                } else {
                    self.right_started = None;
                    self.right_fired = false;
                    if self.dragging {
                        actions[count] = Some(MouseAction::LeftUp);
                        self.dragging = false;
                    }
                }
            }
        }
        let progress = self
            .dwell_started
            .map(|start| (now_ms.saturating_sub(start) as f32 / dwell_ms as f32).clamp(0.0, 1.0));
        LazyResult {
            pose,
            actions,
            progress,
            cursor: self.cursor,
        }
    }
}

fn finger_local(p: &[[f32; 3]; 21]) -> (f32, f32) {
    let base = midpoint(p[5], p[17]);
    let width = distance((p[5][0], p[5][1]), (p[17][0], p[17][1])).max(0.03);
    // Camera-aligned axes avoid a direction flip when the palm rotates sideways.
    ((p[8][0] - base.0) / width, (p[8][1] - base.1) / width)
}

fn lazy_pose(p: &[[f32; 3]; 21]) -> Pose {
    let middle = extended(p, 12, 10);
    let ring = extended(p, 16, 14);
    let pinky = extended(p, 20, 18);
    let index = extended(p, 8, 6);
    if index && middle && ring && pinky {
        Pose::OpenPalm
    } else if index && middle && ring {
        Pose::OpenPalm
    } else if index && middle && !ring && !pinky {
        Pose::Scroll
    } else if middle && !index && !ring && !pinky {
        Pose::Clutch
    } else if !middle && !ring && !pinky {
        // Index can bend during steering. A tight fist with tucked thumb pauses.
        let thumb_tucked = distance((p[4][0], p[4][1]), (p[9][0], p[9][1]))
            < distance((p[0][0], p[0][1]), (p[9][0], p[9][1])) * 0.35;
        if !index && thumb_tucked {
            Pose::Clutch
        } else {
            Pose::Cursor
        }
    } else {
        Pose::Clutch
    }
}

fn three_fingers(p: &[[f32; 3]; 21]) -> bool {
    extended(p, 8, 6) && extended(p, 12, 10) && extended(p, 16, 14) && !extended(p, 20, 18)
}

fn middle_only(p: &[[f32; 3]; 21]) -> bool {
    !extended(p, 8, 6) && extended(p, 12, 10) && !extended(p, 16, 14) && !extended(p, 20, 18)
}

fn extended(p: &[[f32; 3]; 21], tip: usize, pip: usize) -> bool {
    let wrist = (p[0][0], p[0][1]);
    let scale = distance(wrist, (p[9][0], p[9][1])).max(0.001);
    distance((p[tip][0], p[tip][1]), wrist) > distance((p[pip][0], p[pip][1]), wrist) + 0.12 * scale
}

fn midpoint(a: [f32; 3], b: [f32; 3]) -> (f32, f32) {
    ((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5)
}
fn distance(a: (f32, f32), b: (f32, f32)) -> f32 {
    (a.0 - b.0).hypot(a.1 - b.1)
}
fn trackpad_step(delta: f32, dead_zone: f32) -> f32 {
    if delta.abs() <= dead_zone + 0.0005 {
        0.0
    } else {
        (delta - dead_zone.copysign(delta)).clamp(-0.012, 0.012)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::DEFAULT_DWELL_MS;

    fn hand() -> [[f32; 3]; 21] {
        let mut p = [[0.5, 0.65, 0.0]; 21];
        p[0] = [0.5, 0.9, 0.0];
        p[5] = [0.4, 0.6, 0.0];
        p[9] = [0.5, 0.6, 0.0];
        p[17] = [0.7, 0.65, 0.0];
        p[6] = [0.4, 0.5, 0.0];
        p[8] = [0.4, 0.2, 0.0];
        p[10] = [0.5, 0.5, 0.0];
        p[12] = [0.5, 0.56, 0.0];
        p[14] = [0.6, 0.5, 0.0];
        p[16] = [0.6, 0.56, 0.0];
        p[18] = [0.7, 0.58, 0.0];
        p[20] = [0.7, 0.6, 0.0];
        p[4] = [0.2, 0.5, 0.0];
        p
    }

    #[test]
    fn resting_finger_does_not_move_or_click() {
        let mut engine = LazyEngine::new((0.5, 0.5));
        let p = hand();
        for i in 0..120 {
            let result = engine.process(&p, i * 33, 1.0, DEFAULT_DWELL_MS);
            assert!(result.actions.iter().all(Option::is_none));
            assert!(result.progress.is_none());
        }
    }

    #[test]
    fn small_landmark_jitter_does_not_walk_cursor_to_edge() {
        let mut engine = LazyEngine::new((0.5, 0.5));
        let p = hand();
        engine.process(&p, 0, 1.0, DEFAULT_DWELL_MS);
        for i in 1..=300 {
            let mut noisy = p;
            noisy[8][0] += if i % 2 == 0 { 0.002 } else { -0.002 };
            noisy[8][1] += if i % 3 == 0 { 0.002 } else { -0.002 };
            engine.process(&noisy, i * 33, 1.0, DEFAULT_DWELL_MS);
        }
        assert!(distance(engine.cursor(), (0.5, 0.5)) < 0.005);
    }

    #[test]
    fn finger_motion_then_hold_dwell_clicks_once_without_runaway() {
        let mut engine = LazyEngine::new((0.5, 0.5));
        let p = hand();
        engine.process(&p, 0, 1.0, DEFAULT_DWELL_MS);
        let mut deflected = p;
        deflected[8][0] += 0.06;
        for i in 1..50 {
            engine.process(&deflected, i * 33, 1.0, DEFAULT_DWELL_MS);
        }
        let stopped = engine.cursor();
        assert!(distance(stopped, (0.5, 0.5)) > 0.02);
        let mut clicks = 0;
        for i in 50..240 {
            let result = engine.process(&deflected, i * 33, 1.0, DEFAULT_DWELL_MS);
            clicks += result
                .actions
                .iter()
                .filter(|action| **action == Some(MouseAction::LeftClick))
                .count();
        }
        assert_eq!(clicks, 1);
        assert!(
            distance(stopped, engine.cursor()) < 0.001,
            "stationary finger kept moving the cursor"
        );
    }

    #[test]
    fn dwell_ring_tolerates_small_hand_shake() {
        let mut engine = LazyEngine::new((0.5, 0.5));
        let p = hand();
        engine.process(&p, 0, 1.0, DEFAULT_DWELL_MS);
        let mut target = p;
        target[8][0] += 0.06;
        for i in 1..50 {
            engine.process(&target, i * 33, 1.0, DEFAULT_DWELL_MS);
        }
        let mut clicks = 0;
        let mut saw_progress = false;
        for i in 50..105 {
            let mut shaking = target;
            shaking[8][0] += if i % 2 == 0 { 0.008 } else { -0.008 };
            shaking[8][1] += if i % 3 == 0 { 0.006 } else { -0.006 };
            let result = engine.process(&shaking, i * 33, 1.0, DEFAULT_DWELL_MS);
            saw_progress |= result.progress.is_some();
            clicks += result
                .actions
                .iter()
                .filter(|action| **action == Some(MouseAction::LeftClick))
                .count();
        }
        assert!(saw_progress);
        assert_eq!(clicks, 1);
    }

    #[test]
    fn palm_translation_does_not_steer() {
        let p = hand();
        let before = finger_local(&p);
        let mut moved = p;
        for point in &mut moved {
            point[0] += 0.08;
            point[1] -= 0.06;
        }
        let after = finger_local(&moved);
        assert!(distance(before, after) < 0.0001);
        moved[8][0] += 0.06;
        assert!(finger_local(&moved).0 > before.0);
    }

    #[test]
    fn middle_finger_dwell_right_clicks_once() {
        let mut engine = LazyEngine::new((0.5, 0.5));
        let p = hand();
        for i in 0..15 {
            engine.process(&p, i * 33, 1.0, DEFAULT_DWELL_MS);
        }
        let mut middle = p;
        middle[8] = middle[6];
        middle[12] = [0.5, 0.2, 0.0];
        let mut clicks = 0;
        for i in 15..70 {
            let result = engine.process(&middle, i * 33, 1.0, DEFAULT_DWELL_MS);
            clicks += result
                .actions
                .iter()
                .filter(|action| **action == Some(MouseAction::RightClick))
                .count();
        }
        assert_eq!(clicks, 1);
    }

    #[test]
    fn three_finger_hold_toggles_drag_and_fist_releases() {
        let mut engine = LazyEngine::new((0.5, 0.5));
        let p = hand();
        for i in 0..15 {
            engine.process(&p, i * 33, 1.0, DEFAULT_DWELL_MS);
        }
        let mut three = p;
        three[12] = [0.5, 0.2, 0.0];
        three[16] = [0.6, 0.2, 0.0];
        let mut down = false;
        for i in 15..50 {
            down |= engine
                .process(&three, i * 33, 1.0, DEFAULT_DWELL_MS)
                .actions
                .contains(&Some(MouseAction::LeftDown));
        }
        assert!(down);
        let mut fist = p;
        fist[8] = fist[6];
        fist[4] = fist[9];
        let mut up = false;
        for i in 50..55 {
            up |= engine
                .process(&fist, i * 33, 1.0, DEFAULT_DWELL_MS)
                .actions
                .contains(&Some(MouseAction::LeftUp));
        }
        assert!(up);
    }
}
