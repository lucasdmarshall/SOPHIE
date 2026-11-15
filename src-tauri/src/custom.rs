use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const KEYFRAMES: usize = 12;
const MAX_BINDINGS: usize = 12;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GestureBinding {
    pub id: u64,
    pub name: String,
    pub action: String,
    pub mask: u8,
    pub duration_ms: u64,
    pub path: Vec<[f32; 2]>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GestureSummary {
    pub id: u64,
    pub name: String,
    pub action: String,
}

#[derive(Deserialize)]
pub struct RecordingFrame {
    pub timestamp_ms: f64,
    pub landmarks: Vec<[f32; 3]>,
}

#[derive(Clone, Copy)]
struct Feature {
    center: (f32, f32),
    width: f32,
    mask: u8,
}

pub struct CustomGestures {
    bindings: Vec<GestureBinding>,
    history: VecDeque<(u64, Feature)>,
    last_trigger_ms: Option<u64>,
}

impl Default for CustomGestures {
    fn default() -> Self {
        Self {
            bindings: load_bindings(),
            history: VecDeque::new(),
            last_trigger_ms: None,
        }
    }
}

impl CustomGestures {
    pub fn reset(&mut self) {
        self.history.clear();
        self.last_trigger_ms = None;
    }

    pub fn summaries(&self) -> Vec<GestureSummary> {
        self.bindings
            .iter()
            .map(|binding| GestureSummary {
                id: binding.id,
                name: binding.name.clone(),
                action: binding.action.clone(),
            })
            .collect()
    }

    pub fn overrides(&self, action: crate::input::MouseAction) -> bool {
        let name = match action {
            crate::input::MouseAction::LeftClick => "left_click",
            crate::input::MouseAction::RightClick => "right_click",
            crate::input::MouseAction::Scroll(delta) if delta > 0 => "scroll_up",
            crate::input::MouseAction::Scroll(_) => "scroll_down",
            _ => return false,
        };
        self.bindings.iter().any(|binding| binding.action == name)
    }

    pub fn has_mask(&self, mask: u8) -> bool {
        self.bindings.iter().any(|binding| binding.mask == mask)
    }

    pub fn add(
        &mut self,
        name: String,
        action: String,
        frames: Vec<RecordingFrame>,
    ) -> Result<Vec<GestureSummary>, String> {
        if self.bindings.len() >= MAX_BINDINGS {
            return Err("gesture library is full (12 maximum)".into());
        }
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 32 {
            return Err("gesture name must be 1–32 characters".into());
        }
        if ![
            "previous_page",
            "next_page",
            "scroll_up",
            "scroll_down",
            "left_click",
            "right_click",
        ]
        .contains(&action.as_str())
        {
            return Err("unknown control action".into());
        }
        let (mask, duration_ms, path) = build_template(&frames)?;
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis() as u64;
        let binding = GestureBinding {
            id,
            name: name.into(),
            action,
            mask,
            duration_ms,
            path,
        };
        let mut next = self.bindings.clone();
        next.retain(|existing| existing.action != binding.action);
        next.push(binding);
        save_bindings(&next)?;
        self.bindings = next;
        self.reset();
        Ok(self.summaries())
    }

    pub fn delete(&mut self, id: u64) -> Result<Vec<GestureSummary>, String> {
        let mut next = self.bindings.clone();
        next.retain(|binding| binding.id != id);
        if next.len() == self.bindings.len() {
            return Err("gesture not found".into());
        }
        save_bindings(&next)?;
        self.bindings = next;
        self.reset();
        Ok(self.summaries())
    }

    pub fn observe(&mut self, points: &[[f32; 3]; 21], now_ms: u64) -> Option<String> {
        let feature = feature(points);
        self.history.push_back((now_ms, feature));
        while self
            .history
            .front()
            .is_some_and(|(time, _)| now_ms.saturating_sub(*time) > 3000)
        {
            self.history.pop_front();
        }
        if self
            .last_trigger_ms
            .is_some_and(|last| now_ms.saturating_sub(last) < 1600)
        {
            return None;
        }
        for binding in &self.bindings {
            if feature.mask != binding.mask {
                continue;
            }
            for factor in [0.8_f32, 1.0, 1.25] {
                let duration = (binding.duration_ms as f32 * factor) as u64;
                let start = now_ms.saturating_sub(duration);
                let candidate: Vec<_> = self
                    .history
                    .iter()
                    .copied()
                    .filter(|(time, _)| *time >= start)
                    .collect();
                if candidate.len() < 10
                    || candidate
                        .first()
                        .is_none_or(|(time, _)| *time > start + 100)
                {
                    continue;
                }
                let path = path_from_features(&candidate);
                if matches_path(&binding.path, &path) {
                    self.last_trigger_ms = Some(now_ms);
                    return Some(binding.action.clone());
                }
            }
        }
        None
    }
}

pub fn posture_mask(points: &[[f32; 3]; 21]) -> u8 {
    feature(points).mask
}

fn feature(points: &[[f32; 3]; 21]) -> Feature {
    let center = (
        (points[5][0] + points[9][0] + points[17][0]) / 3.0,
        (points[5][1] + points[9][1] + points[17][1]) / 3.0,
    );
    let width = distance(points[5], points[17]).max(0.03);
    let scale = distance(points[0], points[9]).max(0.001);
    let extended = |tip: usize, pip: usize| {
        distance(points[tip], points[0]) > distance(points[pip], points[0]) + 0.12 * scale
    };
    let mask = (extended(8, 6) as u8)
        | ((extended(12, 10) as u8) << 1)
        | ((extended(16, 14) as u8) << 2)
        | ((extended(20, 18) as u8) << 3);
    Feature {
        center,
        width,
        mask,
    }
}

fn build_template(frames: &[RecordingFrame]) -> Result<(u8, u64, Vec<[f32; 2]>), String> {
    if !(12..=90).contains(&frames.len()) {
        return Err("record at least 12 clear hand frames".into());
    }
    let mut features = Vec::with_capacity(frames.len());
    let first_time = frames[0].timestamp_ms;
    let mut previous = first_time;
    for frame in frames {
        if !frame.timestamp_ms.is_finite()
            || frame.timestamp_ms < previous
            || frame.landmarks.len() != 21
            || frame
                .landmarks
                .iter()
                .any(|point| point.iter().any(|value| !value.is_finite()))
        {
            return Err("invalid recorded landmarks".into());
        }
        previous = frame.timestamp_ms;
        let points: &[[f32; 3]; 21] = frame
            .landmarks
            .as_slice()
            .try_into()
            .map_err(|_| "invalid landmark count")?;
        features.push(((frame.timestamp_ms - first_time) as u64, feature(points)));
    }
    let duration = (previous - first_time) as u64;
    if !(500..=2500).contains(&duration) {
        return Err("record for about one second".into());
    }
    let mut counts = [0_usize; 16];
    for (_, item) in &features {
        counts[item.mask as usize] += 1;
    }
    let mask = (0..16).max_by_key(|index| counts[*index]).unwrap() as u8;
    if mask == 1 || counts[mask as usize] * 10 < features.len() * 7 {
        return Err(
            "keep one clear hand pose while moving; index-only is reserved for cursor control"
                .into(),
        );
    }
    let path = path_from_features(&features);
    let end = *path.last().unwrap();
    let net = (end[0] * end[0] + end[1] * end[1]).sqrt();
    if net < 0.25 {
        return Err("move the hand farther in one direction while recording".into());
    }
    Ok((mask, duration, path))
}

fn path_from_features(frames: &[(u64, Feature)]) -> Vec<[f32; 2]> {
    let (first_time, first) = frames[0];
    let duration = frames.last().unwrap().0.saturating_sub(first_time).max(1);
    let mut result = Vec::with_capacity(KEYFRAMES);
    let mut index = 0;
    for step in 0..KEYFRAMES {
        let target = first_time + duration * step as u64 / (KEYFRAMES - 1) as u64;
        while index + 1 < frames.len() - 1 && frames[index + 1].0 < target {
            index += 1;
        }
        let (t0, a) = frames[index];
        let (t1, b) = frames[(index + 1).min(frames.len() - 1)];
        let blend = if t1 == t0 {
            0.0
        } else {
            (target.saturating_sub(t0) as f32 / (t1 - t0) as f32).clamp(0.0, 1.0)
        };
        let x = a.center.0 + (b.center.0 - a.center.0) * blend;
        let y = a.center.1 + (b.center.1 - a.center.1) * blend;
        result.push([
            (x - first.center.0) / first.width,
            (y - first.center.1) / first.width,
        ]);
    }
    result
}

fn matches_path(template: &[[f32; 2]], candidate: &[[f32; 2]]) -> bool {
    if template.len() != KEYFRAMES || candidate.len() != KEYFRAMES {
        return false;
    }
    let a = template[KEYFRAMES - 1];
    let b = candidate[KEYFRAMES - 1];
    let a_len = a[0].hypot(a[1]);
    let b_len = b[0].hypot(b[1]);
    if a_len < 0.25 || b_len < 0.25 || !(0.5..=2.0).contains(&(b_len / a_len)) {
        return false;
    }
    if (a[0] * b[0] + a[1] * b[1]) / (a_len * b_len) < 0.85 {
        return false;
    }
    let scale = a_len / b_len;
    let error: f32 = template
        .iter()
        .zip(candidate)
        .map(|(a, b)| (a[0] - b[0] * scale).hypot(a[1] - b[1] * scale))
        .sum::<f32>()
        / KEYFRAMES as f32;
    error < 0.25
}

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

fn path() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA").ok_or("APPDATA is unavailable")?;
    Ok(PathBuf::from(base).join("SOPHIE").join("gestures.toml"))
}

#[derive(Deserialize, Serialize)]
struct GestureFile {
    bindings: Vec<GestureBinding>,
}

fn load_bindings() -> Vec<GestureBinding> {
    let Ok(path) = path() else { return Vec::new() };
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    toml::from_str::<GestureFile>(&contents)
        .map(|file| {
            file.bindings
                .into_iter()
                .filter(|binding| binding.path.len() == KEYFRAMES && binding.mask <= 15)
                .take(MAX_BINDINGS)
                .collect()
        })
        .unwrap_or_default()
}

fn save_bindings(bindings: &[GestureBinding]) -> Result<(), String> {
    let path = path()?;
    std::fs::create_dir_all(path.parent().ok_or("invalid gesture path")?)
        .map_err(|error| error.to_string())?;
    std::fs::write(
        path,
        toml::to_string_pretty(&GestureFile {
            bindings: bindings.to_vec(),
        })
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hand(y: f32) -> [[f32; 3]; 21] {
        let mut p = [[0.5, 0.7 + y, 0.0]; 21];
        p[0] = [0.5, 0.9 + y, 0.0];
        p[5] = [0.4, 0.6 + y, 0.0];
        p[9] = [0.5, 0.6 + y, 0.0];
        p[17] = [0.7, 0.65 + y, 0.0];
        p[6] = [0.4, 0.5 + y, 0.0];
        p[8] = [0.4, 0.2 + y, 0.0];
        p[10] = [0.5, 0.5 + y, 0.0];
        p[12] = [0.5, 0.2 + y, 0.0];
        p[14] = [0.6, 0.5 + y, 0.0];
        p[16] = [0.6, 0.2 + y, 0.0];
        p[18] = [0.7, 0.58 + y, 0.0];
        p[20] = [0.7, 0.2 + y, 0.0];
        p
    }

    #[test]
    fn recorded_up_sweep_matches_up_but_not_down() {
        let frames: Vec<_> = (0..30)
            .map(|i| RecordingFrame {
                timestamp_ms: i as f64 * 33.0,
                landmarks: hand(-(i as f32) * 0.006).to_vec(),
            })
            .collect();
        let (mask, duration_ms, template) = build_template(&frames).unwrap();
        assert_eq!(mask, 15);
        let up: Vec<_> = (0..30)
            .map(|i| (i * 33, feature(&hand(-(i as f32) * 0.007))))
            .collect();
        let down: Vec<_> = (0..30)
            .map(|i| (i * 33, feature(&hand((i as f32) * 0.007))))
            .collect();
        assert!(matches_path(&template, &path_from_features(&up)));
        assert!(!matches_path(&template, &path_from_features(&down)));
        assert!(duration_ms > 900);
    }

    #[test]
    fn saved_template_triggers_one_action_on_matching_stroke() {
        let frames: Vec<_> = (0..30)
            .map(|i| RecordingFrame {
                timestamp_ms: i as f64 * 33.0,
                landmarks: hand(-(i as f32) * 0.006).to_vec(),
            })
            .collect();
        let (mask, duration_ms, path) = build_template(&frames).unwrap();
        let binding = GestureBinding {
            id: 1,
            name: "Wave up".into(),
            action: "scroll_up".into(),
            mask,
            duration_ms,
            path,
        };
        let serialized = toml::to_string_pretty(&GestureFile {
            bindings: vec![binding.clone()],
        })
        .unwrap();
        let restored: GestureFile = toml::from_str(&serialized).unwrap();
        let mut registry = CustomGestures {
            bindings: restored.bindings,
            history: VecDeque::new(),
            last_trigger_ms: None,
        };
        let mut fired = 0;
        for i in 0..50 {
            let y = -(i.min(29) as f32) * 0.006;
            fired += registry.observe(&hand(y), i * 33).is_some() as usize;
        }
        assert_eq!(fired, 1);
    }
}
