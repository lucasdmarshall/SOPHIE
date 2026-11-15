mod bridge;
mod calibration;
mod custom;
mod filter;
mod focus;
mod gesture;
mod holo;
mod input;
mod lazy;
mod settings;
mod stabilizer;
mod term;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::thread::Thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Every webview in the app must use identical browser arguments (WebView2 shares one
/// environment). The preview window keeps tracking the camera while it is parked
/// offscreen or covered by full-screen Holo Mode, so Chromium must not throttle or
/// suspend it as an occluded background window. On laptops with two GPUs the scene and
/// hand tracking run on the faster one. Keep in sync with tauri.conf.json.
pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required --force_high_performance_gpu";

/// Label of the Lazy-mode dwell ring window.
pub(crate) const DWELL_LABEL: &str = "dwell";

/// The watchdog thread parks while control is stopped; start_control wakes it.
pub(crate) static WATCHDOG: OnceLock<Thread> = OnceLock::new();

static DWELL_CREATING: AtomicBool = AtomicBool::new(false);

/// Create the dwell ring window if it does not exist yet. Only Lazy mode uses it, so it is
/// built on demand instead of at startup. Building a window waits on the event loop, so it
/// runs on its own thread: the callers are synchronous commands on the main thread.
pub(crate) fn ensure_dwell_window(app: &AppHandle) {
    if app.get_webview_window(DWELL_LABEL).is_some() || DWELL_CREATING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let built = WebviewWindowBuilder::new(&app, DWELL_LABEL, WebviewUrl::App("dwell.html".into()))
            .title("SOPHIE · Click progress")
            .inner_size(48.0, 48.0)
            .decorations(false)
            .resizable(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .additional_browser_args(BROWSER_ARGS)
            .build();
        if let Ok(dwell) = built {
            let _ = dwell.set_ignore_cursor_events(true);
            let _ = dwell.set_focusable(false);
        }
        DWELL_CREATING.store(false, Ordering::Release);
    });
}

/// Free the dwell window when Standard mode is selected.
pub(crate) fn close_dwell_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(DWELL_LABEL) {
        let _ = window.destroy();
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(bridge::ControlState::default())
        .setup(|app| {
            // Undo any priority changes a crashed Holo session left behind.
            std::thread::spawn(focus::recover);
            // The dwell and Holo windows are created when first needed, not here.
            let holo = MenuItem::with_id(app, "holo", "Enter Holo Mode", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show preview", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause control", true, None::<&str>)?;
            let resume = MenuItem::with_id(app, "resume", "Resume control", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit SOPHIE", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&holo, &show, &pause, &resume, &quit])?;
            TrayIconBuilder::with_id("sophie")
                .icon(
                    app.default_window_icon()
                        .ok_or("app icon unavailable")?
                        .clone(),
                )
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    let state = app.state::<bridge::ControlState>();
                    match event.id().as_ref() {
                        "holo" => {
                            // The preview window starts hand tracking first, then opens Holo Mode.
                            let _ = app.emit_to("main", "holo-request", ());
                        }
                        "show" => {
                            let _ = bridge::show_preview(app.clone());
                        }
                        "pause" => {
                            if let Ok(mut control) = state.0.lock() {
                                control.pause();
                                control.hide_dwell(app);
                            }
                        }
                        "resume" => {
                            if let Ok(mut control) = state.0.lock() {
                                control.resume();
                            }
                        }
                        "quit" => {
                            if let Ok(mut control) = state.0.lock() {
                                control.pause();
                                control.hide_dwell(app);
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            let handle = app.handle().clone();
            let watchdog = std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(100));
                let state = handle.state::<bridge::ControlState>();
                let running = match state.0.lock() {
                    Ok(mut controller) => {
                        controller.watchdog();
                        if !controller.is_armed() || controller.frames_stale() {
                            controller.hide_dwell(&handle);
                        }
                        controller.is_running()
                    }
                    Err(_) => true,
                };
                // Nothing to watch while control is stopped: sleep until start_control.
                // A spurious wake-up only runs one extra (no-op) check.
                if !running {
                    std::thread::park();
                }
            });
            let _ = WATCHDOG.set(watchdog.thread().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge::submit_frame,
            bridge::start_control,
            bridge::stop_control,
            bridge::show_preview,
            bridge::resume_control,
            bridge::get_calibration,
            bridge::set_calibration,
            bridge::set_sensitivity,
            bridge::get_control_settings,
            bridge::set_control_settings,
            bridge::list_custom_gestures,
            bridge::record_custom_gesture,
            bridge::delete_custom_gesture,
            holo::get_holo_theme,
            holo::set_holo_theme,
            holo::holo_places,
            holo::holo_list,
            holo::holo_open,
            holo::holo_view,
            holo::enter_holo,
            holo::holo_ready,
            holo::exit_holo,
            holo::holo_telemetry,
            holo::open_camera_settings,
            term::term_start,
            term::term_run,
            term::term_stop,
            term::holo_apps,
            term::holo_launch
        ])
        .build(tauri::generate_context!())
        .expect("failed to build SOPHIE")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                focus::release();
            }
        });
}
