use std::f32::consts::PI;

pub struct OneEuro {
    min_cutoff: f32,
    beta: f32,
    previous: Option<Sample>,
}

#[derive(Clone, Copy)]
struct Sample {
    time_ms: u64,
    raw: f32,
    filtered: f32,
    derivative: f32,
}

impl Default for OneEuro {
    fn default() -> Self {
        Self::with_parameters(0.8, 2.0)
    }
}

impl OneEuro {
    pub fn with_parameters(min_cutoff: f32, beta: f32) -> Self {
        Self {
            previous: None,
            min_cutoff,
            beta,
        }
    }
    pub fn reset(&mut self) {
        self.previous = None;
    }

    pub fn update(&mut self, value: f32, time_ms: u64) -> f32 {
        let Some(previous) = self.previous else {
            self.previous = Some(Sample {
                time_ms,
                raw: value,
                filtered: value,
                derivative: 0.0,
            });
            return value;
        };
        let dt = (time_ms.saturating_sub(previous.time_ms).clamp(1, 100) as f32) / 1000.0;
        // Limit one-frame landmark glitches while allowing a fast hand sweep.
        let raw = previous.raw + (value - previous.raw).clamp(-3.0 * dt, 3.0 * dt);
        let speed = (raw - previous.raw) / dt;
        let derivative = low_pass(previous.derivative, speed, alpha(dt, 1.0));
        let cutoff = self.min_cutoff + self.beta * derivative.abs();
        let filtered = low_pass(previous.filtered, raw, alpha(dt, cutoff));
        self.previous = Some(Sample {
            time_ms,
            raw,
            filtered,
            derivative,
        });
        filtered
    }
}

fn alpha(dt: f32, cutoff: f32) -> f32 {
    let tau = 1.0 / (2.0 * PI * cutoff);
    1.0 / (1.0 + tau / dt)
}

fn low_pass(previous: f32, current: f32, alpha: f32) -> f32 {
    previous + alpha * (current - previous)
}

#[cfg(test)]
mod tests {
    use super::OneEuro;

    #[test]
    fn quiet_hand_jitter_is_damped() {
        let mut filter = OneEuro::default();
        filter.update(0.5, 0);
        let mut maximum_error = 0.0_f32;
        for i in 1..60 {
            let input = if i % 2 == 0 { 0.504 } else { 0.496 };
            let output = filter.update(input, i * 33);
            maximum_error = maximum_error.max((output - 0.5).abs());
        }
        assert!(maximum_error < 0.002, "filtered jitter: {maximum_error}");
    }

    #[test]
    fn deliberate_sweep_remains_responsive() {
        let mut filter = OneEuro::default();
        filter.update(0.2, 0);
        let mut output = 0.2;
        for i in 1..=15 {
            output = filter.update(0.2 + i as f32 * 0.02, i * 33);
        }
        assert!(output > 0.42, "sweep lagged at {output}");
    }
}
