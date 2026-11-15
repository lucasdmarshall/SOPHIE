//! Holo Focus: while Holo Mode is open, SOPHIE (and the WebView2 processes that run its
//! scene and hand tracking) get above-normal CPU priority and other desktop apps drop to
//! below-normal. Nothing is closed or suspended, and every change is undone on exit.
//!
//! Only processes that were at normal priority are touched, so apps the user already
//! tuned keep their setting. Changes are written to disk first, so if SOPHIE crashes the
//! next start puts them back.

use std::collections::{HashMap, HashSet};

/// Never lowered: the shell, input, audio and graphics pieces the desktop needs to stay
/// responsive, plus security software. Most system processes cannot be opened anyway.
const PROTECTED: [&str; 28] = [
    "explorer.exe", "dwm.exe", "csrss.exe", "winlogon.exe", "lsass.exe", "services.exe",
    "smss.exe", "wininit.exe", "svchost.exe", "audiodg.exe", "ctfmon.exe", "sihost.exe",
    "fontdrvhost.exe", "taskhostw.exe", "runtimebroker.exe", "textinputhost.exe",
    "startmenuexperiencehost.exe", "shellexperiencehost.exe", "searchhost.exe",
    "msmpeng.exe", "securityhealthsystray.exe", "securityhealthservice.exe",
    "nvcontainer.exe", "nvdisplay.container.exe", "igfxem.exe", "radeonsoftware.exe",
    "taskmgr.exe", "conhost.exe",
];

#[derive(Clone, Debug)]
pub struct ProcessInfo {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
}

/// Which processes to boost (SOPHIE and its children) and which to lower (everything else
/// that is not protected). Pure, so it can be tested without touching real processes.
pub fn plan(processes: &[ProcessInfo], self_pid: u32) -> (Vec<u32>, Vec<u32>) {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for process in processes {
        if process.pid != process.parent {
            children.entry(process.parent).or_default().push(process.pid);
        }
    }
    let mut own = HashSet::from([self_pid]);
    let mut stack = vec![self_pid];
    while let Some(pid) = stack.pop() {
        for &child in children.get(&pid).map(Vec::as_slice).unwrap_or_default() {
            if own.insert(child) {
                stack.push(child);
            }
        }
    }
    let mut boost = Vec::new();
    let mut lower = Vec::new();
    for process in processes {
        if process.pid <= 4 {
            continue;
        }
        if own.contains(&process.pid) {
            boost.push(process.pid);
        } else if !PROTECTED.contains(&process.name.to_ascii_lowercase().as_str()) {
            lower.push(process.pid);
        }
    }
    (boost, lower)
}

/// One priority change: enough to undo it, and to refuse if the PID was reused.
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub pid: u32,
    pub created: u64,
    pub original: u32,
}

fn encode(changes: &[Change]) -> String {
    changes
        .iter()
        .map(|change| format!("{},{},{}\n", change.pid, change.created, change.original))
        .collect()
}

fn decode(text: &str) -> Vec<Change> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split(',').map(str::trim);
            Some(Change {
                pid: parts.next()?.parse().ok()?,
                created: parts.next()?.parse().ok()?,
                original: parts.next()?.parse().ok()?,
            })
        })
        .collect()
}

fn journal_path() -> Option<std::path::PathBuf> {
    std::env::var_os("APPDATA").map(|dir| std::path::PathBuf::from(dir).join("SOPHIE").join("focus-restore.txt"))
}

static ACTIVE: std::sync::Mutex<Vec<Change>> = std::sync::Mutex::new(Vec::new());
/// Whether Holo Mode currently wants focus. Engage and release run on worker threads, so a
/// quick enter-then-exit must not leave priorities changed after the exit.
static WANTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Ask for focus on or off; the work happens on a background thread.
pub fn request(on: bool) {
    WANTED.store(on, std::sync::atomic::Ordering::SeqCst);
    std::thread::spawn(move || if on { engage(); } else { release(); });
}

#[cfg(windows)]
mod platform {
    use super::{Change, ProcessInfo};
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, GetPriorityClass, GetProcessTimes, OpenProcess, SetPriorityClass,
        PROCESS_CREATION_FLAGS, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
    };

    pub fn current_pid() -> u32 {
        // SAFETY: no arguments; always succeeds.
        unsafe { GetCurrentProcessId() }
    }

    pub fn processes() -> Vec<ProcessInfo> {
        let mut out = Vec::new();
        // SAFETY: the snapshot handle is closed below; the entry has its size set.
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return out;
            };
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
            while ok {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                out.push(ProcessInfo {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&entry.szExeFile[..len]),
                });
                ok = Process32NextW(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
        }
        out
    }

    struct Process(HANDLE);
    impl Drop for Process {
        fn drop(&mut self) {
            // SAFETY: the handle came from OpenProcess and is closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn open(pid: u32) -> Option<Process> {
        // SAFETY: plain handle request; failure (system or elevated process) is expected.
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION, false, pid) }
            .ok()
            .map(Process)
    }

    fn created(process: &Process) -> Option<u64> {
        let (mut a, mut b, mut c, mut d) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        // SAFETY: all four pointers refer to live FILETIME values.
        unsafe { GetProcessTimes(process.0, &mut a, &mut b, &mut c, &mut d) }.ok()?;
        Some((u64::from(a.dwHighDateTime) << 32) | u64::from(a.dwLowDateTime))
    }

    /// Move a process from `from` to `to`. Returns the change when it was made.
    pub fn shift(pid: u32, from: u32, to: u32) -> Option<Change> {
        let process = open(pid)?;
        // SAFETY: valid handle with query rights.
        let current = unsafe { GetPriorityClass(process.0) };
        if current != from {
            return None;
        }
        let created = created(&process)?;
        // SAFETY: valid handle with set rights; `to` is a documented priority class.
        unsafe { SetPriorityClass(process.0, PROCESS_CREATION_FLAGS(to)) }.ok()?;
        Some(Change { pid, created, original: current })
    }

    /// Undo one change, unless the PID now belongs to a different process.
    pub fn restore(change: &Change) {
        let Some(process) = open(change.pid) else { return };
        if created(&process) != Some(change.created) {
            return;
        }
        // SAFETY: valid handle with set rights; the class was read from this process.
        unsafe {
            let _ = SetPriorityClass(process.0, PROCESS_CREATION_FLAGS(change.original));
        }
    }
}

#[cfg(windows)]
use windows::Win32::System::Threading::{ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS};

/// Apply Holo Focus. Safe to call again; it is a no-op while already active.
#[cfg(windows)]
pub fn engage() -> usize {
    let Ok(mut active) = ACTIVE.lock() else { return 0 };
    if !WANTED.load(std::sync::atomic::Ordering::SeqCst) || !active.is_empty() {
        return active.len();
    }
    let (boost, lower) = plan(&platform::processes(), platform::current_pid());
    let normal = NORMAL_PRIORITY_CLASS.0;
    for pid in boost {
        active.extend(platform::shift(pid, normal, ABOVE_NORMAL_PRIORITY_CLASS.0));
    }
    for pid in lower {
        active.extend(platform::shift(pid, normal, BELOW_NORMAL_PRIORITY_CLASS.0));
    }
    if let Some(path) = journal_path() {
        let _ = std::fs::write(path, encode(&active));
    }
    active.len()
}

/// Undo Holo Focus.
#[cfg(windows)]
pub fn release() {
    let Ok(mut active) = ACTIVE.lock() else { return };
    for change in active.drain(..) {
        platform::restore(&change);
    }
    if let Some(path) = journal_path() {
        let _ = std::fs::remove_file(path);
    }
}

/// On startup: undo anything a crashed session left lowered.
#[cfg(windows)]
pub fn recover() {
    let Some(path) = journal_path() else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    for change in decode(&text) {
        platform::restore(&change);
    }
    let _ = std::fs::remove_file(path);
}

#[cfg(not(windows))]
pub fn engage() -> usize {
    0
}
#[cfg(not(windows))]
pub fn release() {}
#[cfg(not(windows))]
pub fn recover() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, name: &str) -> ProcessInfo {
        ProcessInfo { pid, parent, name: name.into() }
    }

    #[test]
    fn sophie_and_its_webviews_are_boosted_and_the_shell_is_left_alone() {
        let list = [
            p(4, 0, "System"),
            p(100, 50, "explorer.exe"),
            p(200, 100, "sophie.exe"),
            p(201, 200, "msedgewebview2.exe"),
            p(202, 201, "msedgewebview2.exe"),
            p(300, 100, "chrome.exe"),
            p(301, 300, "chrome.exe"),
            p(400, 1, "AudioDG.exe"),
            p(500, 1, "msedgewebview2.exe"),
        ];
        let (mut boost, mut lower) = plan(&list, 200);
        boost.sort();
        lower.sort();
        assert_eq!(boost, vec![200, 201, 202]);
        // Another app's WebView2 is not SOPHIE's and gets lowered like any app.
        assert_eq!(lower, vec![300, 301, 500]);
    }

    #[test]
    fn journal_round_trips_and_skips_bad_lines() {
        let changes = vec![Change { pid: 7, created: 123, original: 32 }, Change { pid: 9, created: 5, original: 32 }];
        let text = encode(&changes) + "garbage\n1,2\n";
        assert_eq!(decode(&text), changes);
    }
}
