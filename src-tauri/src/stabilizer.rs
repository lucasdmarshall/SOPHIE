//! Adaptive cursor stabilizer for Standard mode.
//!
//! Real hands tremble, so the cursor is driven through three phases:
//! - Rest:   the cursor is held still. Small tremor around the rest point is absorbed.
//!           The hold radius adapts to the tremor measured while resting.
//! - Move:   once the tremor-free (low-passed) position leaves the hold radius, or the raw
//!           position jumps far, the cursor follows the light One Euro output. A decaying
//!           correction removes the jump between the held point and the filter output.
//! - Settle: when the hand has stopped (little net drift over a short window), the cursor
//!           quickly eases onto the tremor-free position instead of creeping after the
//!           slow One Euro tail, and then locks into Rest.
//!
//! The stabilizer also remembers where it last rested, so a gesture that starts right
//! after leaving rest (pinch, pose change, drop) can undo the motion it caused.

use crate::filter::OneEuro;
use std::collections::VecDeque;
use std::f32::consts::PI;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Rest,
    Move,
    Settle,
}

/// Low-pass cutoff of the tremor-free signal; physiological tremor sits around 4-12 Hz.
const SMOOTH_CUTOFF_HZ: f32 = 2.5;
/// Hold radius in normalized screen units (~3.5 px at 1920 wide).
const MIN_REST_RADIUS: f32 = 0.0018;
/// Upper bound so a noisy hand never makes small targets unreachable (~10 px at 1920).
const MAX_REST_RADIUS: f32 = 0.005;
/// Hold radius relative to the measured tremor amplitude.
const TREMOR_GAIN: f32 = 2.0;
const INITIAL_TREMOR: f32 = 0.0009;
/// Raw jump that leaves Rest immediately, for fast deliberate motion.
const FAST_ESCAPE: f32 = 0.012;
/// Window for deciding the hand has stopped.
const STOP_WINDOW_MS: u64 = 160;
const STOP_WINDOW_MIN_MS: u64 = 100;
const SETTLE_TAU_MS: f32 = 45.0;
const SETTLE_MAX_MS: u64 = 200;
const SETTLE_DONE_DISTANCE: f32 = 0.0004;
const CORRECTION_TAU_MS: f32 = 80.0;
/// Motion this soon after leaving Rest may be a gesture artifact and can be undone.
const REWIND_WINDOW_MS: u64 = 250;
const REWIND_MAX_DISTANCE: f32 = 0.02;

pub struct Stabilizer {
    phase: Phase,
    euro: (OneEuro, OneEuro),
    smooth: (f32, f32),
    output: (f32, f32),
    correction: (f32, f32),
    tremor: f32,
    history: VecDeque<(u64, (f32, f32))>,
    last_ms: u64,
    phase_started_ms: u64,
    rest_point: (f32, f32),
    rest_exit_ms: Option<u64>,
    initialized: bool,
}

impl Default for Stabilizer {
    fn default() -> Self {
        Self {
            phase: Phase::Rest,
            euro: (
                OneEuro::with_parameters(0.45, 4.0),
                OneEuro::with_parameters(0.45, 4.0),
            ),
            smooth: (0.0, 0.0),
            output: (0.0, 0.0),
            correction: (0.0, 0.0),
            tremor: INITIAL_TREMOR,
            history: VecDeque::with_capacity(16),
            last_ms: 0,
            phase_started_ms: 0,
            rest_point: (0.0, 0.0),
            rest_exit_ms: None,
            initialized: false,
        }
    }
}

impl Stabilizer {
    /// Forget all state; the next update starts at its target, resting.
    pub fn clear(&mut self) {
        let tremor = self.tremor;
        *self = Self::default();
        // The user's tremor level is a property of the hand, keep the estimate.
        self.tremor = tremor;
    }

    /// Start resting exactly at `point`.
    pub fn reset_to(&mut self, point: (f32, f32), now_ms: u64) {
        self.clear();
        self.euro.0.update(point.0, now_ms);
        self.euro.1.update(point.1, now_ms);
        self.smooth = point;
        self.output = point;
        self.rest_point = point;
        self.last_ms = now_ms;
        self.phase_started_ms = now_ms;
        self.history.push_back((now_ms, point));
        self.initialized = true;
    }

    #[cfg(test)]
    pub fn phase(&self) -> Phase {
        self.phase
    }

    fn radius(&self) -> f32 {
        (TREMOR_GAIN * self.tremor).clamp(MIN_REST_RADIUS, MAX_REST_RADIUS)
    }

    /// Where the cursor rested just before the current motion began, if that motion is
    /// recent and small enough to be an artifact of starting a gesture.
    pub fn rewind_point(&self, now_ms: u64) -> Option<(f32, f32)> {
        if self.phase == Phase::Rest || !self.initialized {
            return None;
        }
        let exit = self.rest_exit_ms?;
        (now_ms.saturating_sub(exit) <= REWIND_WINDOW_MS
            && distance(self.output, self.rest_point) <= REWIND_MAX_DISTANCE)
            .then_some(self.rest_point)
    }

    pub fn update(&mut self, target: (f32, f32), now_ms: u64) -> (f32, f32) {
        if !self.initialized {
            self.reset_to(target, now_ms);
            return target;
        }
        let dt_ms = now_ms.saturating_sub(self.last_ms).clamp(1, 100) as f32;
        self.last_ms = now_ms;

        let a = alpha(dt_ms / 1000.0, SMOOTH_CUTOFF_HZ);
        self.smooth.0 += a * (target.0 - self.smooth.0);
        self.smooth.1 += a * (target.1 - self.smooth.1);
        let euro = (
            self.euro.0.update(target.0, now_ms),
            self.euro.1.update(target.1, now_ms),
        );

        self.history.push_back((now_ms, self.smooth));
        while self
            .history
            .front()
            .is_some_and(|(time, _)| now_ms.saturating_sub(*time) > STOP_WINDOW_MS)
        {
            self.history.pop_front();
        }
        let window_drift = self.history.front().and_then(|(time, point)| {
            (now_ms.saturating_sub(*time) >= STOP_WINDOW_MIN_MS)
                .then(|| distance(*point, self.smooth))
        });

        let radius = self.radius();
        let escaped = distance(self.smooth, self.output) > radius
            || distance(target, self.output) > FAST_ESCAPE.max(2.5 * radius);

        match self.phase {
            Phase::Rest => {
                if escaped {
                    self.phase = Phase::Move;
                    self.phase_started_ms = now_ms;
                    self.rest_exit_ms = Some(now_ms);
                    // The previous frame's correction makes this frame move by exactly the
                    // filter's own step, with no jump from the held point.
                    self.output = (euro.0 + self.correction.0, euro.1 + self.correction.1);
                } else {
                    let residual = distance(target, self.smooth);
                    let rate = (dt_ms / 400.0).min(1.0);
                    self.tremor += (residual - self.tremor) * rate;
                    self.correction = (self.output.0 - euro.0, self.output.1 - euro.1);
                }
            }
            Phase::Settle => {
                let restarted = window_drift.is_some_and(|drift| drift > 1.5 * radius)
                    || distance(target, self.output) > FAST_ESCAPE.max(2.5 * radius);
                if restarted {
                    self.phase = Phase::Move;
                    self.phase_started_ms = now_ms;
                    self.output = (euro.0 + self.correction.0, euro.1 + self.correction.1);
                } else {
                    let k = 1.0 - (-dt_ms / SETTLE_TAU_MS).exp();
                    self.output.0 += k * (self.smooth.0 - self.output.0);
                    self.output.1 += k * (self.smooth.1 - self.output.1);
                    self.correction = (self.output.0 - euro.0, self.output.1 - euro.1);
                    if distance(self.output, self.smooth) < SETTLE_DONE_DISTANCE
                        || now_ms.saturating_sub(self.phase_started_ms) >= SETTLE_MAX_MS
                    {
                        self.phase = Phase::Rest;
                        self.phase_started_ms = now_ms;
                        self.rest_point = self.output;
                    }
                }
            }
            Phase::Move => {
                let decay = (-dt_ms / CORRECTION_TAU_MS).exp();
                self.correction.0 *= decay;
                self.correction.1 *= decay;
                self.output = (euro.0 + self.correction.0, euro.1 + self.correction.1);
                if window_drift.is_some_and(|drift| drift < radius) {
                    // The hand stopped: the new location, not the old rest, is intended.
                    self.phase = Phase::Settle;
                    self.phase_started_ms = now_ms;
                    self.rest_exit_ms = None;
                }
            }
        }
        self.output
    }
}

fn alpha(dt: f32, cutoff: f32) -> f32 {
    let tau = 1.0 / (2.0 * PI * cutoff);
    1.0 / (1.0 + tau / dt)
}

fn distance(a: (f32, f32), b: (f32, f32)) -> f32 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic tremor: two incommensurate sines plus pseudo-random noise.
    fn tremor(frame: u64, amplitude: f32) -> (f32, f32) {
        let t = frame as f32 * 0.033;
        let noise = ((frame * 2654435761) % 1000) as f32 / 1000.0 - 0.5;
        (
            amplitude * ((2.0 * PI * 8.0 * t).sin() * 0.7 + noise * 0.6),
            amplitude * ((2.0 * PI * 5.3 * t + 1.0).sin() * 0.7 - noise * 0.4),
        )
    }

    #[test]
    fn resting_tremor_keeps_cursor_still() {
        let mut s = Stabilizer::default();
        s.reset_to((0.5, 0.5), 0);
        for frame in 1..=120 {
            let jitter = tremor(frame, 0.003);
            let out = s.update((0.5 + jitter.0, 0.5 + jitter.1), frame * 33);
            assert_eq!(out, (0.5, 0.5), "tremor moved cursor at frame {frame}");
        }
        assert_eq!(s.phase(), Phase::Rest);
    }

    #[test]
    fn slow_deliberate_motion_is_followed() {
        let mut s = Stabilizer::default();
        s.reset_to((0.5, 0.5), 0);
        // 0.02 screen/s, roughly 40 px/s on a 1920 px wide screen.
        let mut out = (0.5, 0.5);
        for frame in 1..=90 {
            let x = 0.5 + frame as f32 * 0.033 * 0.02;
            out = s.update((x, 0.5), frame * 33);
        }
        let expected = 0.5 + 90.0 * 0.033 * 0.02;
        assert!(
            out.0 > 0.5 + (expected - 0.5) * 0.8,
            "slow motion lagged: {} of {}",
            out.0,
            expected
        );
    }

    #[test]
    fn stop_settles_on_target_without_creep() {
        let mut s = Stabilizer::default();
        s.reset_to((0.3, 0.5), 0);
        let mut frame = 1;
        while frame <= 12 {
            s.update((0.3 + frame as f32 * 0.02, 0.5), frame * 33);
            frame += 1;
        }
        let target = 0.3 + 12.0 * 0.02;
        let mut settled_at = None;
        for step in 0..60 {
            let jitter = tremor(step, 0.002);
            let out = s.update((target + jitter.0, 0.5 + jitter.1), (frame + step) * 33);
            if settled_at.is_none() && s.phase() == Phase::Rest {
                settled_at = Some((step, out));
            }
            if let Some((_, rest)) = settled_at {
                assert_eq!(out, rest, "cursor crept after settling");
            }
        }
        let (step, rest) = settled_at.expect("never settled");
        assert!(step * 33 <= 500, "settling took {} ms", step * 33);
        assert!(
            (rest.0 - target).abs() < 0.004,
            "settled off target: {rest:?}"
        );
    }

    #[test]
    fn leaving_rest_has_no_jump_and_can_rewind() {
        let mut s = Stabilizer::default();
        s.reset_to((0.5, 0.5), 0);
        for frame in 1..=10 {
            s.update((0.5, 0.5), frame * 33);
        }
        let out = s.update((0.508, 0.5), 11 * 33);
        assert!(out.0 - 0.5 < 0.006, "escape jumped to {}", out.0);
        let out = s.update((0.516, 0.5), 12 * 33);
        assert!(out.0 > 0.5);
        assert_eq!(s.rewind_point(12 * 33), Some((0.5, 0.5)));
        assert_eq!(s.rewind_point(12 * 33 + 400), None);
    }
}
