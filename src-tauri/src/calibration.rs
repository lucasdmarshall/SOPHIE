use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Calibration {
    pub x_min: f32,
    pub x_max: f32,
    pub y_min: f32,
    pub y_max: f32,
    pub sensitivity: f32,
    pub calibrated: bool,
}

impl Default for Calibration {
    fn default() -> Self {
        Self {
            x_min: 0.2,
            x_max: 0.8,
            y_min: 0.2,
            y_max: 0.8,
            sensitivity: 1.0,
            calibrated: false,
        }
    }
}

impl Calibration {
    pub fn validate(self) -> Result<Self, String> {
        let values = [
            self.x_min,
            self.x_max,
            self.y_min,
            self.y_max,
            self.sensitivity,
        ];
        if values.iter().any(|value| !value.is_finite())
            || self.x_min < 0.0
            || self.x_max > 1.0
            || self.y_min < 0.0
            || self.y_max > 1.0
            || self.x_max - self.x_min < 0.15
            || self.y_max - self.y_min < 0.15
            || !(0.7..=1.8).contains(&self.sensitivity)
        {
            return Err("invalid calibration range or sensitivity".into());
        }
        Ok(self)
    }

    pub fn load() -> Self {
        let Ok(path) = config_path() else {
            return Self::default();
        };
        let Ok(contents) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        toml::from_str::<Self>(&contents)
            .ok()
            .and_then(|calibration| calibration.validate().ok())
            .unwrap_or_default()
    }

    pub fn save(self) -> Result<(), String> {
        self.validate()?;
        let path = config_path()?;
        std::fs::create_dir_all(path.parent().ok_or("invalid calibration path")?)
            .map_err(|error| error.to_string())?;
        let contents = toml::to_string_pretty(&self).map_err(|error| error.to_string())?;
        std::fs::write(path, contents).map_err(|error| error.to_string())
    }

    pub fn map_x(self, value: f32) -> f32 {
        map_axis(value, self.x_min, self.x_max, self.sensitivity)
    }
    pub fn map_y(self, value: f32) -> f32 {
        map_axis(value, self.y_min, self.y_max, self.sensitivity)
    }
    pub fn pan_x(self, value: f32) -> f32 {
        edge_velocity(value, self.x_min, self.x_max, self.sensitivity)
    }
    pub fn pan_y(self, value: f32) -> f32 {
        edge_velocity(value, self.y_min, self.y_max, self.sensitivity)
    }
}

fn config_path() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA").ok_or("APPDATA is unavailable")?;
    Ok(PathBuf::from(base).join("SOPHIE").join("calibration.toml"))
}

fn effective_range(min: f32, max: f32, sensitivity: f32) -> (f32, f32) {
    let center = (min + max) * 0.5;
    let half_span = (max - min) * 0.5 / sensitivity;
    (center - half_span, center + half_span)
}

fn map_axis(value: f32, min: f32, max: f32, sensitivity: f32) -> f32 {
    let (start, end) = effective_range(min, max, sensitivity);
    ((value - start) / (end - start)).clamp(0.0, 1.0)
}

fn edge_velocity(value: f32, min: f32, max: f32, sensitivity: f32) -> f32 {
    let (start, end) = effective_range(min, max, sensitivity);
    let zone = (end - start) * 0.12;
    let left = ((start + zone - value) / zone).clamp(0.0, 1.0);
    let right = ((value - (end - zone)) / zone).clamp(0.0, 1.0);
    0.35 * (right * right - left * left)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitivity_and_edge_zone_cover_the_screen() {
        let mut calibration = Calibration::default();
        assert!(calibration.map_x(0.2) < 0.0001);
        assert_eq!(calibration.map_x(0.8), 1.0);
        calibration.sensitivity = 1.5;
        assert!(calibration.map_x(0.3) < 0.0001);
        assert_eq!(calibration.map_x(0.7), 1.0);
        assert!(calibration.pan_x(0.67) > 0.0);
        assert_eq!(calibration.pan_x(0.5), 0.0);
    }

    #[test]
    fn rejects_tiny_or_nonfinite_reach() {
        let mut calibration = Calibration::default();
        calibration.x_max = 0.3;
        assert!(calibration.validate().is_err());
        calibration.x_max = f32::NAN;
        assert!(calibration.validate().is_err());
    }
}
