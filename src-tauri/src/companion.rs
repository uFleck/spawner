//! The companion: a small always-on-top window at the edge of the screen that shows what the running apps print,
//! so the user can follow them without switching to Spawner. It is shown while something runs or an app ended in an
//! error the user has not dismissed, and hidden while the main window has focus. When to show it is decided here;
//! the window sizes and places itself (`src/companion`).

use crate::model::{InstanceState, StateEvent};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "companion";

#[derive(Default)]
struct Seen {
    active: HashSet<String>,
    /// Instances whose last run failed or exited with a nonzero code, until they start again or the user dismisses them.
    errored: HashSet<String>,
    main_focused: bool,
    enabled: bool,
    shown: bool,
}

#[derive(Default)]
pub struct Companion {
    seen: Mutex<Seen>,
}

fn is_error(state: &InstanceState) -> bool {
    match state {
        InstanceState::Failed { .. } => true,
        InstanceState::Exited { code: Some(c) } => *c != 0,
        _ => false,
    }
}

impl Companion {
    pub fn new(enabled: bool) -> Self {
        Self { seen: Mutex::new(Seen { enabled, ..Seen::default() }) }
    }

    pub fn on_state(&self, app: &AppHandle, event: &StateEvent) {
        self.update(app, |s| {
            if event.state.is_active() {
                s.active.insert(event.id.clone());
                s.errored.remove(&event.id);
            } else {
                s.active.remove(&event.id);
                if is_error(&event.state) {
                    s.errored.insert(event.id.clone());
                } else {
                    s.errored.remove(&event.id);
                }
            }
        });
    }

    pub fn set_main_focused(&self, app: &AppHandle, focused: bool) {
        self.update(app, |s| s.main_focused = focused);
    }

    pub fn set_enabled(&self, app: &AppHandle, enabled: bool) {
        self.update(app, |s| s.enabled = enabled);
    }

    pub fn dismiss(&self, app: &AppHandle, id: &str) {
        self.update(app, |s| {
            s.errored.remove(id);
        });
    }

    /// Applies `change`, then shows or hides the window when that flips whether it should be visible.
    fn update(&self, app: &AppHandle, change: impl FnOnce(&mut Seen)) {
        let show = {
            let mut s = self.seen.lock().unwrap();
            change(&mut s);
            let want = s.enabled && !s.main_focused && !(s.active.is_empty() && s.errored.is_empty());
            if want == s.shown {
                return;
            }
            s.shown = want;
            want
        };
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || match window(&handle) {
            Some(window) => set_visible(&window, show),
            // Not built, so nothing is shown: the next update tries again.
            None => {
                if let Some(c) = handle.try_state::<Arc<Companion>>() {
                    c.seen.lock().unwrap().shown = false;
                }
            }
        });
    }
}

/// The companion window, built hidden the first time it is needed.
fn window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    const SIZE: f64 = 72.0;
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Spawner companion")
        .inner_size(SIZE, SIZE);
    // Starts in the bottom right corner, where the page puts it by default once it has loaded and measured itself.
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let right = (area.position.x as f64 + area.size.width as f64) / scale;
        let bottom = (area.position.y as f64 + area.size.height as f64 * 0.86) / scale;
        builder = builder.position(right - SIZE, bottom - SIZE);
    }
    let window = builder
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()
        .ok()?;
    hide_from_alt_tab(&window);
    Some(window)
}

/// Shown without activating it, so the window the user is typing in keeps focus. Tauri's `show` activates the
/// window, and its hidden flag would go stale after a raw show, so both directions go through Win32 here.
#[cfg(windows)]
fn set_visible(window: &WebviewWindow, show: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNOACTIVATE, ShowWindow};
    if let Ok(hwnd) = window.hwnd() {
        unsafe { ShowWindow(hwnd.0, if show { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
    }
}

#[cfg(not(windows))]
fn set_visible(window: &WebviewWindow, show: bool) {
    let _ = if show { window.show() } else { window.hide() };
}

/// Moves and sizes the companion in one step, in physical pixels. Its content is pinned to the bottom of the window,
/// so a separate move and resize would draw one frame with the rows shifted.
#[tauri::command]
pub fn companion_place(app: AppHandle, x: i32, y: i32, width: u32, height: u32) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    place(&window, x, y, width, height);
}

#[cfg(windows)]
fn place(window: &WebviewWindow, x: i32, y: i32, width: u32, height: u32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER, SetWindowPos};
    if let Ok(hwnd) = window.hwnd() {
        unsafe { SetWindowPos(hwnd.0, std::ptr::null_mut(), x, y, width as i32, height as i32, SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER) };
    }
}

#[cfg(not(windows))]
fn place(window: &WebviewWindow, x: i32, y: i32, width: u32, height: u32) {
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = window.set_size(tauri::PhysicalSize::new(width, height));
}

/// Lets the user drag the companion and returns once they let go, so the page knows when to snap it to an edge.
#[tauri::command]
pub async fn companion_drag(app: AppHandle) {
    let (done, dropped) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(LABEL) {
            drag(&window);
        }
        let _ = done.send(());
    });
    let _ = dropped.await;
}

/// Tauri's `start_dragging` posts the message and returns at once. Sent instead, the OS move loop runs inside the
/// call, which returns when the mouse button is released.
#[cfg(windows)]
fn drag(window: &WebviewWindow) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, HTCAPTION, SendMessageW, WM_NCLBUTTONDOWN};
    if let Ok(hwnd) = window.hwnd() {
        let mut at = POINT { x: 0, y: 0 };
        unsafe {
            GetCursorPos(&mut at);
            ReleaseCapture();
            let point = ((at.y as u16 as u32) << 16 | at.x as u16 as u32) as isize;
            SendMessageW(hwnd.0, WM_NCLBUTTONDOWN, HTCAPTION as usize, point);
        }
    }
}

#[cfg(not(windows))]
fn drag(window: &WebviewWindow) {
    let _ = window.start_dragging();
}

/// A tool window is left out of Alt+Tab, which `skip_taskbar` alone does not do.
#[cfg(windows)]
fn hide_from_alt_tab(window: &WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW};
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let style = GetWindowLongPtrW(hwnd.0, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd.0, GWL_EXSTYLE, (style | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize));
        }
    }
}

#[cfg(not(windows))]
fn hide_from_alt_tab(_window: &WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_failure_or_nonzero_exit_is_an_error() {
        assert!(is_error(&InstanceState::Failed { message: "x".into() }));
        assert!(is_error(&InstanceState::Exited { code: Some(1) }));
        assert!(!is_error(&InstanceState::Exited { code: Some(0) }));
        assert!(!is_error(&InstanceState::Exited { code: None }));
        assert!(!is_error(&InstanceState::Idle));
    }
}
