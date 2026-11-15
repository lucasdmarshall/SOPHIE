//! Holo Mode's terminal and app drawer.
//!
//! The terminal is one long-lived PowerShell process fed over stdin, so the working
//! folder and variables carry from one command to the next. It is not a pseudo console:
//! full-screen and prompting programs (editors, REPLs) will not work in it.
//!
//! The app drawer lists what the Start menu lists (`Get-StartApps`) and launches entries
//! through the shell's AppsFolder, which covers both classic and Store apps.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Marks the line that ends a command's output; the working folder follows it.
const DONE: &str = "\u{1}SOPHIE-DONE\u{1}";
/// Prefix PowerShell puts on error lines, so the page can colour them.
const ERROR: &str = "\u{2}";
const EVENT: &str = "holo-term";

struct Session {
    child: Child,
    stdin: ChildStdin,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// Bumped whenever a session starts, so a dead session's reader threads stay silent.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Where the last command left off; a restarted session resumes there.
static LAST_CWD: Mutex<String> = Mutex::new(String::new());
/// App ids from the last listing: only those can be launched.
static APP_IDS: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[derive(Clone, Serialize)]
struct TermEvent {
    /// out, err, done (a command finished) or exit (the session ended).
    kind: &'static str,
    text: String,
}

#[derive(Clone, Serialize)]
pub struct HoloApp {
    name: String,
    id: String,
}

fn powershell() -> Command {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: never flash a console over Holo Mode.
        command.creation_flags(0x0800_0000);
    }
    command
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// One stdin line that runs `command` in the session's own scope, prints errors with the
/// error prefix, and always finishes with the done marker and the working folder.
/// The command travels as base64, so quotes and newlines in it cannot break the line.
fn wrap(command: &str) -> String {
    format!(
        ". {{ try {{ . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')))) 2>&1 | ForEach-Object {{ if ($_ -is [Management.Automation.ErrorRecord]) {{ [char]2 + $_.ToString() }} else {{ $_ }} }} | Out-String -Stream | Write-Host }} catch {{ Write-Host ([char]2 + $_.ToString()) }}; Write-Host ([char]1 + 'SOPHIE-DONE' + [char]1 + (Get-Location).Path) }}\n",
        base64(command.as_bytes())
    )
}

fn emit(app: &AppHandle, kind: &'static str, text: String) {
    let _ = app.emit_to(crate::holo::WINDOW_LABEL, EVENT, TermEvent { kind, text });
}

fn forward(app: AppHandle, stream: impl Read + Send + 'static, generation: u64, errors: bool) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if GENERATION.load(Ordering::Acquire) != generation {
                return;
            }
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end_matches(['\r', '\n']);
            if let Some(cwd) = text.strip_prefix(DONE) {
                if let Ok(mut last) = LAST_CWD.lock() {
                    cwd.clone_into(&mut last);
                }
                emit(&app, "done", cwd.to_owned());
            } else if let Some(message) = text.strip_prefix(ERROR) {
                emit(&app, "err", message.to_owned());
            } else {
                emit(&app, if errors { "err" } else { "out" }, text.to_owned());
            }
        }
        // Only the stdout reader reports the end, and only for the live session.
        if !errors && GENERATION.load(Ordering::Acquire) == generation {
            if let Ok(mut session) = SESSION.lock() {
                *session = None;
            }
            emit(&app, "exit", String::new());
        }
    });
}

fn start(app: &AppHandle) -> Result<Session, String> {
    let mut cwd = LAST_CWD.lock().map(|last| last.clone()).unwrap_or_default();
    if cwd.is_empty() || !std::path::Path::new(&cwd).is_dir() {
        cwd = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
    }
    let mut child = powershell()
        .args(["-Command", "-"])
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start PowerShell: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("PowerShell has no input")?;
    let generation = GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    if let Some(stdout) = child.stdout.take() {
        forward(app.clone(), stdout, generation, false);
    }
    if let Some(stderr) = child.stderr.take() {
        forward(app.clone(), stderr, generation, true);
    }
    // UTF-8 both ways, then an empty command so the page learns the working folder.
    let setup = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8\n";
    stdin
        .write_all(setup.as_bytes())
        .and_then(|()| stdin.write_all(wrap("").as_bytes()))
        .and_then(|()| stdin.flush())
        .map_err(|error| error.to_string())?;
    Ok(Session { child, stdin })
}

/// Start the session if it is not running. Its working folder arrives as a `done` event.
#[tauri::command]
pub fn term_start(app: AppHandle) -> Result<(), String> {
    let mut session = SESSION.lock().map_err(|_| "terminal state is unavailable")?;
    if session.is_none() {
        *session = Some(start(&app)?);
    }
    Ok(())
}

#[tauri::command]
pub fn term_run(command: String, app: AppHandle) -> Result<(), String> {
    if command.len() > 16 * 1024 {
        return Err("command is too long".into());
    }
    let mut session = SESSION.lock().map_err(|_| "terminal state is unavailable")?;
    if session.is_none() {
        *session = Some(start(&app)?);
    }
    let live = session.as_mut().ok_or("terminal is not running")?;
    let written = live
        .stdin
        .write_all(wrap(&command).as_bytes())
        .and_then(|()| live.stdin.flush());
    if let Err(error) = written {
        *session = None;
        return Err(format!("terminal session ended: {error}"));
    }
    Ok(())
}

/// Stop whatever is running by ending the session and everything it started.
/// The next command starts a fresh session in the same folder.
#[tauri::command]
pub fn term_stop(app: AppHandle) {
    let Ok(mut session) = SESSION.lock() else { return };
    if let Some(mut live) = session.take() {
        GENERATION.fetch_add(1, Ordering::AcqRel);
        // taskkill /T also ends programs the session launched, which Child::kill would orphan.
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &live.child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            kill.creation_flags(0x0800_0000);
        }
        let _ = kill.status();
        let _ = live.child.kill();
        let _ = live.child.wait();
        emit(&app, "exit", String::new());
    }
}

fn parse_apps(listing: &str) -> Vec<HoloApp> {
    let mut apps: Vec<HoloApp> = listing
        .lines()
        .filter_map(|line| {
            let (name, id) = line.trim_end().split_once('\t')?;
            let (name, id) = (name.trim(), id.trim());
            let lower = name.to_lowercase();
            // Start menu folders are full of uninstallers and manuals nobody launches from here.
            let noise = ["uninstall", "readme", "release notes", "documentation", "license"];
            (!name.is_empty() && !id.is_empty() && !noise.iter().any(|word| lower.contains(word)))
                .then(|| HoloApp { name: name.to_owned(), id: id.to_owned() })
        })
        .collect();
    apps.sort_by_key(|app| app.name.to_lowercase());
    apps.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    apps
}

/// Everything the Start menu can launch. Async: PowerShell takes about a second.
#[tauri::command]
pub async fn holo_apps() -> Result<Vec<HoloApp>, String> {
    let output = powershell()
        .args([
            "-Command",
            "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-StartApps | ForEach-Object { $_.Name + \"`t\" + $_.AppID }",
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("could not list apps: {error}"))?;
    let apps = parse_apps(&String::from_utf8_lossy(&output.stdout));
    if apps.is_empty() {
        return Err("Windows returned no apps".into());
    }
    if let Ok(mut ids) = APP_IDS.lock() {
        *ids = apps.iter().map(|app| app.id.clone()).collect();
    }
    Ok(apps)
}

#[tauri::command]
pub fn holo_launch(id: String) -> Result<(), String> {
    let known = APP_IDS.lock().map(|ids| ids.contains(&id)).unwrap_or(false);
    if !known {
        return Err("unknown app".into());
    }
    crate::holo::shell_execute(&format!("shell:AppsFolder\\{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn wrapped_command_is_one_line_whatever_it_contains() {
        let line = wrap("echo 'a'\n\"b\"");
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.ends_with('\n'));
        assert!(!line.contains("echo"));
    }

    #[test]
    fn app_listing_is_cleaned_sorted_and_deduplicated() {
        let apps = parse_apps("Zed\tzed.id\r\nUninstall Foo\tfoo.un\r\nalpha\ta.id\r\nAlpha\ta2.id\r\nbroken line\r\n");
        let names: Vec<&str> = apps.iter().map(|app| app.name.as_str()).collect();
        assert_eq!(names, ["alpha", "Zed"]);
    }
}
