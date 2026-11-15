use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_DWELL_MS: u64 = 1200;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControlMode {
    #[default]
    Standard,
    Lazy,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct ControlSettings {
    pub mode: ControlMode,
    pub lazy_speed: f32,
    #[serde(default = "default_dwell_ms")]
    pub lazy_dwell_ms: u64,
}

fn default_dwell_ms() -> u64 {
    DEFAULT_DWELL_MS
}

impl Default for ControlSettings {
    fn default() -> Self {
        Self {
            mode: ControlMode::Standard,
            lazy_speed: 1.0,
            lazy_dwell_ms: DEFAULT_DWELL_MS,
        }
    }
}

impl ControlSettings {
    pub fn validate(self) -> Result<Self, String> {
        if !self.lazy_speed.is_finite()
            || !(0.5..=2.0).contains(&self.lazy_speed)
            || !(700..=2500).contains(&self.lazy_dwell_ms)
        {
            return Err("invalid lazy speed or dwell time".into());
        }
        Ok(self)
    }

    pub fn load() -> Self {
        let Ok(path) = path() else {
            return Self::default();
        };
        let Ok(contents) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        toml::from_str::<Self>(&contents)
            .ok()
            .and_then(|settings| settings.validate().ok())
            .unwrap_or_default()
    }

    pub fn save(self) -> Result<(), String> {
        self.validate()?;
        let path = path()?;
        std::fs::create_dir_all(path.parent().ok_or("invalid settings path")?)
            .map_err(|error| error.to_string())?;
        std::fs::write(
            path,
            toml::to_string_pretty(&self).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
    }
}

fn path() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA").ok_or("APPDATA is unavailable")?;
    Ok(PathBuf::from(base).join("SOPHIE").join("control.toml"))
}
