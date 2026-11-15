//! Holo Mode: SOPHIE's full-screen sci-fi environment.
//!
//! Explorer is never modified or replaced. Holo Mode is a separate full-screen window
//! that draws its own launcher, file galaxy and HUD; leaving it returns to the normal
//! desktop untouched.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const WINDOW_LABEL: &str = "holo";

/// The Holo window (three.js scene, WebGL context, render targets) is built on first entry
/// and freed this long after leaving, so SOPHIE carries none of it while it sits in the tray.
const RELEASE_AFTER: Duration = Duration::from_secs(180);
/// True while Holo Mode is on screen; hand frames are only streamed to it then.
static VISIBLE: AtomicBool = AtomicBool::new(false);
/// Set on entry. A freshly built window has no listeners yet when `holo-enter` is sent, so
/// its page asks `holo_ready` once loaded and enters then.
static PENDING_ENTER: AtomicBool = AtomicBool::new(false);
/// Bumped on every entry, so a release timer from an older visit does nothing.
static SESSION: AtomicU64 = AtomicU64::new(0);
/// Serializes building, showing and releasing the window.
static WINDOW_LOCK: Mutex<()> = Mutex::new(());
/// Last folder shown, so a rebuilt window reopens where the user left off.
static LAST_PATH: Mutex<String> = Mutex::new(String::new());

pub fn is_visible() -> bool {
    VISIBLE.load(Ordering::Acquire)
}

fn build_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("holo.html".into()))
        .title("SOPHIE · Holo Mode")
        .decorations(false)
        .skip_taskbar(true)
        .background_color(tauri::window::Color(3, 6, 12, 255))
        .visible(false)
        .additional_browser_args(crate::BROWSER_ARGS)
        .build()
        .map_err(|error| error.to_string())
}
/// Upper bound on entries sent to the galaxy; more than this is unreadable in 3D anyway.
const MAX_ENTRIES: usize = 240;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct HoloTheme {
    pub preset: String,
    pub primary: String,
    pub secondary: String,
    pub accent: String,
    /// Bloom and glow strength, 0.0..=2.0.
    pub glow: f32,
    /// Reduce motion: no glitch, no flicker, short transitions.
    pub reduced_motion: bool,
    /// Centerpiece style: reactor, atom, tesseract or none.
    #[serde(default = "default_core")]
    pub core: String,
    /// File arrangement: orbit, spiral, wall, helix, globe or neural.
    #[serde(default = "default_layout")]
    pub layout: String,
    /// Whole-scene look: grid (floor and centerpiece), hud (flat dial), starmap (open space) or tunnel.
    #[serde(default = "default_world")]
    pub world: String,
    /// Render quality: auto (lowers itself to protect hand tracking), high, balanced, saver.
    #[serde(default = "default_quality")]
    pub quality: String,
    /// Synthesized UI sound on or off.
    #[serde(default = "default_sound")]
    pub sound: bool,
    /// UI sound volume, 0.0..=1.0.
    #[serde(default = "default_volume")]
    pub volume: f32,
}

fn default_sound() -> bool {
    true
}

fn default_volume() -> f32 {
    0.6
}

const CORES: [&str; 4] = ["reactor", "atom", "tesseract", "none"];
const LAYOUTS: [&str; 6] = ["orbit", "spiral", "wall", "helix", "globe", "neural"];
const WORLDS: [&str; 4] = ["grid", "hud", "starmap", "tunnel"];
const QUALITIES: [&str; 4] = ["auto", "high", "balanced", "saver"];

fn default_quality() -> String {
    "auto".into()
}

fn default_world() -> String {
    "grid".into()
}

fn default_core() -> String {
    "reactor".into()
}

fn default_layout() -> String {
    "orbit".into()
}

impl Default for HoloTheme {
    fn default() -> Self {
        Self {
            preset: "arc".into(),
            primary: "#38e8ff".into(),
            secondary: "#7c6bff".into(),
            accent: "#ff4fd8".into(),
            glow: 1.0,
            reduced_motion: false,
            core: default_core(),
            layout: default_layout(),
            world: default_world(),
            quality: default_quality(),
            sound: default_sound(),
            volume: default_volume(),
        }
    }
}

impl HoloTheme {
    pub fn validate(self) -> Result<Self, String> {
        let colors = [&self.primary, &self.secondary, &self.accent];
        if colors.iter().any(|color| !is_hex_color(color))
            || !self.glow.is_finite()
            || !(0.0..=2.0).contains(&self.glow)
            || !CORES.contains(&self.core.as_str())
            || !LAYOUTS.contains(&self.layout.as_str())
            || !WORLDS.contains(&self.world.as_str())
            || !QUALITIES.contains(&self.quality.as_str())
            || !self.volume.is_finite()
            || !(0.0..=1.0).contains(&self.volume)
            || self.preset.len() > 32
            || !self
                .preset
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("invalid holo theme".into());
        }
        Ok(self)
    }

    pub fn load() -> Self {
        theme_path()
            .ok()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|contents| toml::from_str::<Self>(&contents).ok())
            .and_then(|theme| theme.validate().ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = theme_path()?;
        std::fs::create_dir_all(path.parent().ok_or("invalid theme path")?)
            .map_err(|error| error.to_string())?;
        let contents = toml::to_string_pretty(self).map_err(|error| error.to_string())?;
        std::fs::write(path, contents).map_err(|error| error.to_string())
    }
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn theme_path() -> Result<PathBuf, String> {
    let base = std::env::var_os("APPDATA").ok_or("APPDATA is unavailable")?;
    Ok(PathBuf::from(base).join("SOPHIE").join("holo.toml"))
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HoloEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Milliseconds since the Unix epoch, 0 when unknown.
    pub modified_ms: u64,
    pub extension: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct HoloListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<HoloEntry>,
    /// Entries left out because of `MAX_ENTRIES`.
    pub hidden_count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct HoloPlace {
    pub label: String,
    pub path: String,
    pub kind: String,
}

pub fn list_directory(path: &Path) -> Result<HoloListing, String> {
    let read = std::fs::read_dir(path).map_err(|error| format!("cannot open folder: {error}"))?;
    let mut entries: Vec<HoloEntry> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let metadata = entry.metadata().ok()?;
            if is_hidden(&name, &metadata) {
                return None;
            }
            let entry_path = entry.path();
            Some(HoloEntry {
                extension: entry_path
                    .extension()
                    .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default(),
                path: entry_path.to_string_lossy().into_owned(),
                is_dir: metadata.is_dir(),
                size: if metadata.is_dir() { 0 } else { metadata.len() },
                modified_ms: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |duration| duration.as_millis() as u64),
                name,
            })
        })
        .collect();
    // Folders first, then by name, case-insensitively, like Explorer.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let hidden_count = entries.len().saturating_sub(MAX_ENTRIES);
    entries.truncate(MAX_ENTRIES);
    Ok(HoloListing {
        path: path.to_string_lossy().into_owned(),
        parent: path.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
        hidden_count,
    })
}

#[cfg(windows)]
fn is_hidden(name: &str, metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    name.starts_with('.') || metadata.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn is_hidden(name: &str, _metadata: &std::fs::Metadata) -> bool {
    name.starts_with('.')
}

fn places() -> Vec<HoloPlace> {
    let mut places = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        for (label, sub, kind) in [
            ("Home", "", "home"),
            ("Desktop", "Desktop", "desktop"),
            ("Documents", "Documents", "documents"),
            ("Downloads", "Downloads", "downloads"),
            ("Pictures", "Pictures", "pictures"),
            ("Music", "Music", "music"),
            ("Videos", "Videos", "videos"),
        ] {
            let path = if sub.is_empty() {
                home.clone()
            } else {
                home.join(sub)
            };
            if path.is_dir() {
                places.push(HoloPlace {
                    label: label.into(),
                    path: path.to_string_lossy().into_owned(),
                    kind: kind.into(),
                });
            }
        }
    }
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if Path::new(&root).is_dir() {
            places.push(HoloPlace {
                label: format!("{}:", letter as char),
                path: root,
                kind: "drive".into(),
            });
        }
    }
    places
}

#[cfg(windows)]
fn shell_open(path: &Path) -> Result<(), String> {
    shell_execute(&path.to_string_lossy())
}

/// Open a path or a shell target such as `shell:AppsFolder\<app id>`.
#[cfg(windows)]
pub fn shell_execute(target: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute returns a value greater than 32 on success.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err("Windows could not open this item".into())
    }
}

#[cfg(not(windows))]
fn shell_open(_path: &Path) -> Result<(), String> {
    Err("opening files is only supported on Windows".into())
}

#[cfg(not(windows))]
pub fn shell_execute(_target: &str) -> Result<(), String> {
    Err("launching apps is only supported on Windows".into())
}

/// Largest text file shown in a holo window; longer files are cut and flagged.
const MAX_TEXT_BYTES: usize = 1024 * 1024;

const IMAGE_EXT: [&str; 10] = [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif", "apng",
];
const VIDEO_EXT: [&str; 4] = ["mp4", "webm", "m4v", "mov"];
const AUDIO_EXT: [&str; 6] = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];
const TEXT_EXT: [&str; 34] = [
    "txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonc", "xml", "yaml", "yml", "toml",
    "ini", "cfg", "conf", "html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx", "rs", "py", "c",
    "h", "cpp", "hpp", "java", "go", "sh", "sql", "bat",
];

/// 3D models shown as a rotatable hologram.
const MODEL_EXT: [&str; 4] = ["glb", "gltf", "obj", "stl"];
/// Tables shown as a 3D chart (and as a table).
const DATA_EXT: [&str; 2] = ["csv", "tsv"];

/// What a holo window can show for a file.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct HoloView {
    /// image, video, audio, pdf, text, or external (no built-in viewer).
    pub kind: String,
    pub name: String,
    pub path: String,
    pub extension: String,
    pub size: u64,
    pub text: Option<String>,
    pub truncated: bool,
}

pub fn view_kind(extension: &str) -> &'static str {
    let ext = extension.to_ascii_lowercase();
    let ext = ext.as_str();
    if IMAGE_EXT.contains(&ext) {
        "image"
    } else if VIDEO_EXT.contains(&ext) {
        "video"
    } else if AUDIO_EXT.contains(&ext) {
        "audio"
    } else if ext == "pdf" {
        "pdf"
    } else if MODEL_EXT.contains(&ext) {
        "model"
    } else if DATA_EXT.contains(&ext) {
        "data"
    } else if TEXT_EXT.contains(&ext) {
        "text"
    } else {
        "external"
    }
}

pub fn describe_view(path: &Path) -> Result<HoloView, String> {
    let metadata = std::fs::metadata(path).map_err(|_| "item no longer exists".to_string())?;
    if metadata.is_dir() {
        return Err("folders open in the galaxy, not in a window".into());
    }
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let mut view = HoloView {
        kind: view_kind(&extension).into(),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        extension,
        size: metadata.len(),
        text: None,
        truncated: false,
    };
    if view.kind == "text" || view.kind == "data" {
        use std::io::Read;
        let mut bytes = Vec::with_capacity(MAX_TEXT_BYTES.min(metadata.len() as usize));
        std::fs::File::open(path)
            .and_then(|file| file.take(MAX_TEXT_BYTES as u64).read_to_end(&mut bytes))
            .map_err(|error| format!("cannot read file: {error}"))?;
        // A NUL byte early on means this "text" file is really binary.
        if bytes.iter().take(8192).any(|byte| *byte == 0) {
            view.kind = "external".into();
        } else {
            view.truncated = metadata.len() as usize > MAX_TEXT_BYTES;
            view.text = Some(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    Ok(view)
}

/// Describe a file for a holo window. Media files are added to the asset protocol scope
/// one at a time, so the window can stream exactly the file the user opened and nothing else.
#[tauri::command]
pub fn holo_view(path: String, app: AppHandle) -> Result<HoloView, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("file path must be absolute".into());
    }
    let view = describe_view(&path)?;
    if matches!(view.kind.as_str(), "image" | "video" | "audio" | "pdf" | "model") {
        app.asset_protocol_scope()
            .allow_file(&path)
            .map_err(|error| error.to_string())?;
    }
    // A .gltf names its buffers and textures by relative path, usually beside it or in a
    // subfolder, so the model's own folder has to be readable too.
    if view.extension == "gltf" {
        if let Some(folder) = path.parent() {
            app.asset_protocol_scope()
                .allow_directory(folder, true)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(view)
}

#[tauri::command]
pub fn get_holo_theme() -> HoloTheme {
    HoloTheme::load()
}

#[tauri::command]
pub fn set_holo_theme(theme: HoloTheme, app: AppHandle) -> Result<HoloTheme, String> {
    let theme = theme.validate()?;
    theme.save()?;
    let _ = app.emit_to(WINDOW_LABEL, "holo-theme", theme.clone());
    Ok(theme)
}

#[tauri::command]
pub fn holo_places() -> Vec<HoloPlace> {
    places()
}

#[tauri::command]
pub fn holo_list(path: String) -> Result<HoloListing, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("folder path must be absolute".into());
    }
    let listing = list_directory(&path)?;
    if let Ok(mut last) = LAST_PATH.lock() {
        last.clone_from(&listing.path);
    }
    Ok(listing)
}

/// What a newly loaded Holo page should do: enter now, and which folder to reopen.
#[derive(Serialize)]
pub struct HoloResume {
    enter: bool,
    path: String,
}

#[tauri::command]
pub fn holo_ready() -> HoloResume {
    HoloResume {
        enter: PENDING_ENTER.swap(false, Ordering::AcqRel),
        path: LAST_PATH.lock().map(|path| path.clone()).unwrap_or_default(),
    }
}

/// Open Windows' camera privacy page, where camera access for desktop apps is switched on.
#[tauri::command]
pub fn open_camera_settings() -> Result<(), String> {
    shell_execute("ms-settings:privacy-webcam")
}

#[tauri::command]
pub fn holo_open(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.exists() {
        return Err("item no longer exists".into());
    }
    shell_open(&path)
}

/// Async so building the window does not block the main thread it waits on.
#[tauri::command]
pub async fn enter_holo(app: AppHandle) -> Result<(), String> {
    show(&app)
}

#[tauri::command]
pub fn exit_holo(app: AppHandle) -> Result<(), String> {
    VISIBLE.store(false, Ordering::Release);
    PENDING_ENTER.store(false, Ordering::Release);
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("holo window unavailable")?;
    let _ = app.emit_to(WINDOW_LABEL, "holo-exit", ());
    crate::focus::request(false);
    window.hide().map_err(|error| error.to_string())?;
    let session = SESSION.load(Ordering::Acquire);
    std::thread::spawn(move || {
        std::thread::sleep(RELEASE_AFTER);
        let _guard = WINDOW_LOCK.lock();
        if !is_visible() && SESSION.load(Ordering::Acquire) == session {
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                let _ = window.destroy();
            }
        }
    });
    Ok(())
}

/// Live machine readings for the HUD. Values are real, never decorative.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Telemetry {
    /// Whole-system CPU use since the previous call, 0..=100.
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub uptime_ms: u64,
}

/// Previous (idle, total) CPU times, so each call reports use over the last interval.
static CPU_TIMES: std::sync::Mutex<Option<(u64, u64)>> = std::sync::Mutex::new(None);

/// CPU share busy between two (idle, total) samples.
fn cpu_busy(previous: Option<(u64, u64)>, now: (u64, u64)) -> f32 {
    let Some((idle_before, total_before)) = previous else {
        return 0.0;
    };
    let total = now.1.saturating_sub(total_before);
    if total == 0 {
        return 0.0;
    }
    let idle = now.0.saturating_sub(idle_before).min(total);
    (total - idle) as f32 / total as f32 * 100.0
}

#[cfg(windows)]
fn read_telemetry() -> Telemetry {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::Win32::System::Threading::GetSystemTimes;

    let ticks = |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    let mut telemetry = Telemetry::default();
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    // SAFETY: the three pointers refer to live, writable FILETIME values.
    if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_ok() {
        // Kernel time already includes idle time.
        let now = (ticks(idle), ticks(kernel) + ticks(user));
        if let Ok(mut previous) = CPU_TIMES.lock() {
            telemetry.cpu = cpu_busy(*previous, now);
            *previous = Some(now);
        }
    }
    let mut memory = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // SAFETY: dwLength is set as the API requires and the struct is writable.
    if unsafe { GlobalMemoryStatusEx(&mut memory) }.is_ok() {
        telemetry.mem_total = memory.ullTotalPhys;
        telemetry.mem_used = memory.ullTotalPhys.saturating_sub(memory.ullAvailPhys);
    }
    // SAFETY: no arguments; always succeeds.
    telemetry.uptime_ms = unsafe { GetTickCount64() };
    telemetry
}

#[cfg(not(windows))]
fn read_telemetry() -> Telemetry {
    Telemetry::default()
}

#[tauri::command]
pub fn holo_telemetry() -> Telemetry {
    read_telemetry()
}

pub fn show(app: &AppHandle) -> Result<(), String> {
    let _guard = WINDOW_LOCK.lock();
    SESSION.fetch_add(1, Ordering::AcqRel);
    PENDING_ENTER.store(true, Ordering::Release);
    let window = match app.get_webview_window(WINDOW_LABEL) {
        Some(window) => window,
        None => build_window(app)?,
    };
    VISIBLE.store(true, Ordering::Release);
    window.show().map_err(|error| error.to_string())?;
    window
        .set_fullscreen(true)
        .map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    // Give SOPHIE's scene and tracking the CPU first; other apps step back slightly.
    crate::focus::request(true);
    app.emit_to(WINDOW_LABEL, "holo-enter", ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_rejects_bad_colors_and_glow() {
        assert!(HoloTheme::default().validate().is_ok());
        let mut theme = HoloTheme::default();
        theme.primary = "red".into();
        assert!(theme.validate().is_err());
        let mut theme = HoloTheme::default();
        theme.glow = 3.0;
        assert!(theme.validate().is_err());
        let mut theme = HoloTheme::default();
        theme.preset = "../x".into();
        assert!(theme.validate().is_err());
        let mut theme = HoloTheme::default();
        theme.layout = "maze".into();
        assert!(theme.validate().is_err());
        let mut theme = HoloTheme::default();
        theme.volume = 1.5;
        assert!(theme.validate().is_err());
    }

    #[test]
    fn older_theme_files_gain_style_defaults() {
        let old = "preset = \"arc\"
primary = \"#38e8ff\"
secondary = \"#7c6bff\"
accent = \"#ff4fd8\"
glow = 1.0
reduced_motion = false
";
        let theme: HoloTheme = toml::from_str(old).unwrap();
        assert_eq!(theme.core, "reactor");
        assert_eq!(theme.layout, "orbit");
        assert_eq!(theme.world, "grid");
        assert!(theme.validate().is_ok());
    }

    #[test]
    fn cpu_use_comes_from_the_interval_between_samples() {
        assert_eq!(cpu_busy(None, (50, 100)), 0.0);
        assert_eq!(cpu_busy(Some((50, 100)), (50, 100)), 0.0);
        // 100 ticks passed, 25 of them idle.
        assert_eq!(cpu_busy(Some((50, 100)), (75, 200)), 75.0);
        // Idle can never exceed the interval.
        assert_eq!(cpu_busy(Some((0, 0)), (500, 100)), 0.0);
    }

    #[test]
    fn view_kinds_cover_common_files() {
        assert_eq!(view_kind("PNG"), "image");
        assert_eq!(view_kind("mp4"), "video");
        assert_eq!(view_kind("mp3"), "audio");
        assert_eq!(view_kind("pdf"), "pdf");
        assert_eq!(view_kind("rs"), "text");
        assert_eq!(view_kind("GLB"), "model");
        assert_eq!(view_kind("stl"), "model");
        assert_eq!(view_kind("csv"), "data");
        assert_eq!(view_kind("docx"), "external");
        assert_eq!(view_kind("exe"), "external");
    }

    #[test]
    fn text_view_reads_text_and_rejects_binary() {
        let root = std::env::temp_dir().join(format!("sophie-holo-view-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.md"), "# Hello\nworld").unwrap();
        std::fs::write(root.join("fake.txt"), [0x4d, 0x5a, 0x00, 0x01]).unwrap();
        let note = describe_view(&root.join("note.md")).unwrap();
        assert_eq!(note.kind, "text");
        assert_eq!(note.text.as_deref(), Some("# Hello\nworld"));
        assert!(!note.truncated);
        assert_eq!(
            describe_view(&root.join("fake.txt")).unwrap().kind,
            "external"
        );
        assert!(describe_view(&root).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn listing_puts_folders_first_and_skips_dotfiles() {
        let root = std::env::temp_dir().join(format!("sophie-holo-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("zeta")).unwrap();
        std::fs::write(root.join("Alpha.txt"), "hello").unwrap();
        std::fs::write(root.join(".hidden"), "x").unwrap();
        let listing = list_directory(&root).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["zeta", "Alpha.txt"]);
        assert_eq!(listing.entries[1].size, 5);
        assert_eq!(listing.entries[1].extension, "txt");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
