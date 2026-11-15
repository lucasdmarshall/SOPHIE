use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MouseAction {
    Move { x: f32, y: f32 },
    LeftDown,
    LeftUp,
    LeftClick,
    RightClick,
    Scroll(i32),
}

pub struct WindowsInput {
    left_held: bool,
    last_move: Option<(i32, i32)>,
}

impl WindowsInput {
    pub fn control(&mut self, action: &str) -> Result<(), String> {
        match action {
            "previous_page" => self.shortcut("Alt+Left"),
            "next_page" => self.shortcut("Alt+Right"),
            "scroll_up" => self.apply(MouseAction::Scroll(360)),
            "scroll_down" => self.apply(MouseAction::Scroll(-360)),
            "left_click" => self.apply(MouseAction::LeftClick),
            "right_click" => self.apply(MouseAction::RightClick),
            _ => Err("unknown control action".into()),
        }
    }
    pub fn shortcut(&mut self, shortcut: &str) -> Result<(), String> {
        let (modifiers, key) = parse_shortcut(shortcut)?;
        let mut events = Vec::with_capacity(modifiers.len() * 2 + 2);
        for modifier in &modifiers {
            events.push(key_input(*modifier, false));
        }
        events.push(key_input(key, false));
        events.push(key_input(key, true));
        for modifier in modifiers.iter().rev() {
            events.push(key_input(*modifier, true));
        }
        let sent = unsafe { SendInput(&events, std::mem::size_of::<INPUT>() as i32) };
        if sent != events.len() as u32 {
            let releases: Vec<_> = modifiers
                .iter()
                .rev()
                .map(|modifier| key_input(*modifier, true))
                .collect();
            unsafe { SendInput(&releases, std::mem::size_of::<INPUT>() as i32) };
            return Err(format!(
                "keyboard shortcut failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    pub fn new() -> Self {
        Self {
            left_held: false,
            last_move: None,
        }
    }

    pub fn cursor_normalized(&self) -> (f32, f32) {
        let mut point = POINT::default();
        if unsafe { GetCursorPos(&mut point) }.is_err() {
            return (0.5, 0.5);
        }
        let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
        let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
        let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(1);
        let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(1);
        (
            ((point.x - x) as f32 / width as f32).clamp(0.0, 1.0),
            ((point.y - y) as f32 / height as f32).clamp(0.0, 1.0),
        )
    }

    pub fn cursor_screen_point(&self, cursor: (f32, f32)) -> (i32, i32) {
        let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
        let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
        let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(1);
        let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(1);
        (
            x + (cursor.0 * (width - 1) as f32).round() as i32,
            y + (cursor.1 * (height - 1) as f32).round() as i32,
        )
    }

    pub fn apply(&mut self, action: MouseAction) -> Result<(), String> {
        match action {
            MouseAction::Move { x, y } => {
                let x = x.clamp(0.0, 1.0);
                let y = y.clamp(0.0, 1.0);
                let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(1);
                let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(1);
                let pixel = (
                    (x * (width - 1) as f32).round() as i32,
                    (y * (height - 1) as f32).round() as i32,
                );
                if self.last_move.is_some_and(|last| {
                    (pixel.0 - last.0).abs() <= 2 && (pixel.1 - last.1).abs() <= 2
                }) {
                    return Ok(());
                }
                self.send(
                    MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    (x * 65535.0).round() as i32,
                    (y * 65535.0).round() as i32,
                    0,
                )?;
                self.last_move = Some(pixel);
                Ok(())
            }
            MouseAction::LeftDown => {
                if !self.left_held {
                    self.send(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)?;
                    self.left_held = true;
                }
                Ok(())
            }
            MouseAction::LeftUp => self.release_all(),
            MouseAction::LeftClick => {
                self.send(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)?;
                self.send(MOUSEEVENTF_LEFTUP, 0, 0, 0)
            }
            MouseAction::RightClick => {
                self.send(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0)?;
                self.send(MOUSEEVENTF_RIGHTUP, 0, 0, 0)
            }
            MouseAction::Scroll(delta) => self.send(MOUSEEVENTF_WHEEL, 0, 0, delta as u32),
        }
    }

    pub fn release_all(&mut self) -> Result<(), String> {
        if self.left_held {
            self.left_held = false;
            self.send(MOUSEEVENTF_LEFTUP, 0, 0, 0)?;
        }
        Ok(())
    }

    fn send(&self, flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) -> Result<(), String> {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    mouseData: data,
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
        if sent == 1 {
            Ok(())
        } else {
            Err(format!(
                "SendInput failed: {}",
                std::io::Error::last_os_error()
            ))
        }
    }
}

fn key_input(key: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(key),
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                ..Default::default()
            },
        },
    }
}

fn parse_shortcut(shortcut: &str) -> Result<(Vec<u16>, u16), String> {
    let parts: Vec<_> = shortcut
        .split('+')
        .map(|part| part.trim().to_ascii_uppercase())
        .collect();
    if parts.is_empty() || parts.len() > 5 || parts.iter().any(String::is_empty) {
        return Err("use a shortcut like Ctrl+Shift+S".into());
    }
    let mut modifiers = Vec::new();
    let mut key = None;
    for part in parts {
        let modifier = match part.as_str() {
            "CTRL" | "CONTROL" => Some(0x11),
            "SHIFT" => Some(0x10),
            "ALT" => Some(0x12),
            "WIN" | "WINDOWS" => Some(0x5B),
            _ => None,
        };
        if let Some(modifier) = modifier {
            if key.is_some() || modifiers.contains(&modifier) {
                return Err("invalid modifier order or duplicate".into());
            }
            modifiers.push(modifier);
            continue;
        }
        if key.is_some() {
            return Err("shortcut needs exactly one key".into());
        }
        let vk = if part.len() == 1 && part.as_bytes()[0].is_ascii_alphanumeric() {
            part.as_bytes()[0] as u16
        } else if let Some(number) = part
            .strip_prefix('F')
            .and_then(|value| value.parse::<u16>().ok())
        {
            if (1..=12).contains(&number) {
                0x70 + number - 1
            } else {
                return Err("function key must be F1–F12".into());
            }
        } else {
            match part.as_str() {
                "ENTER" => 0x0D,
                "ESC" | "ESCAPE" => 0x1B,
                "SPACE" => 0x20,
                "TAB" => 0x09,
                "BACKSPACE" => 0x08,
                "DELETE" | "DEL" => 0x2E,
                "UP" => 0x26,
                "DOWN" => 0x28,
                "LEFT" => 0x25,
                "RIGHT" => 0x27,
                "HOME" => 0x24,
                "END" => 0x23,
                "PAGEUP" => 0x21,
                "PAGEDOWN" => 0x22,
                _ => return Err("unsupported shortcut key".into()),
            }
        };
        key = Some(vk);
    }
    key.map(|key| (modifiers, key))
        .ok_or_else(|| "shortcut needs a key".into())
}

#[cfg(test)]
mod shortcut_tests {
    use super::parse_shortcut;

    #[test]
    fn validates_key_chords() {
        assert_eq!(
            parse_shortcut("Ctrl+Shift+S").unwrap(),
            (vec![0x11, 0x10], 0x53)
        );
        assert!(parse_shortcut("Ctrl+Ctrl+S").is_err());
        assert!(parse_shortcut("Ctrl+S+X").is_err());
    }
}

impl Drop for WindowsInput {
    fn drop(&mut self) {
        let _ = self.release_all();
    }
}
