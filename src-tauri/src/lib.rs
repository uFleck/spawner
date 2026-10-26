mod agent;
mod companion;
mod detect;
mod discovery;
mod job;
mod level;
mod mcp;
mod model;
mod notify;
mod roots;
mod runner;
mod watch;
mod worktree;
#[cfg(test)]
mod testutil;

use companion::Companion;
use model::{Group, InstanceState, LogLine, Root};
use notify::{Notifier, Settings};
use runner::{Hub, HubEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

/// Passed by the login entry so Spawner can start hidden in the tray.
const AUTOSTART_ARG: &str = "--autostart";
/// Written once the first-run default has been applied, so turning it off in the tray sticks.
const AUTOSTART_MARKER: &str = "autostart-initialized";

/// `UMBLER_ROOT` and `UMBLER_HUB_MCP_PORT` are the pre-rename env var names, still read as a fallback so existing setups keep working.
/// The value is a `;`-separated list of folders that only seeds the roots until `roots.json` exists.
fn env_roots() -> Option<String> {
    std::env::var("SPAWNER_ROOT").or_else(|_| std::env::var("UMBLER_ROOT")).ok()
}

/// A debug build gets its own identifier, so it runs beside an installed Spawner: its own single-instance lock,
/// its own app data directory (roots, MCP port file) and a "(dev)" window title.
fn context() -> tauri::Context {
    let mut context = tauri::generate_context!();
    if cfg!(debug_assertions) {
        let config = context.config_mut();
        config.identifier.push_str(".dev");
        for window in &mut config.app.windows {
            window.title.push_str(" (dev)");
        }
    }
    context
}

/// A file in Spawner's app data directory, next to `mcp-port.txt`.
fn data_file(app: &AppHandle, name: &str) -> tauri::Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join(name))
}

fn requested_mcp_port() -> Option<u16> {
    std::env::var("SPAWNER_MCP_PORT").or_else(|_| std::env::var("UMBLER_HUB_MCP_PORT")).ok().and_then(|p| p.parse().ok())
}

/// Where the MCP server listens. Both fields empty means it is still starting.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct McpInfo {
    url: Option<String>,
    error: Option<String>,
    /// The port Hub would normally use was taken, so clients configured for it need updating.
    port_changed: bool,
}

type McpState = Arc<Mutex<McpInfo>>;

#[tauri::command]
async fn scan(hub: State<'_, Arc<Hub>>) -> Result<Vec<Group>, String> {
    Ok(hub.inner().rescan().await)
}

#[tauri::command]
fn get_roots(hub: State<'_, Arc<Hub>>) -> Vec<Root> {
    hub.roots()
}

#[tauri::command]
async fn add_root(hub: State<'_, Arc<Hub>>, path: String, label: Option<String>) -> Result<Vec<Root>, String> {
    let roots = hub.add_root(&path, label)?;
    hub.inner().rescan().await;
    Ok(roots)
}

#[tauri::command]
async fn remove_root(hub: State<'_, Arc<Hub>>, path: String) -> Result<Vec<Root>, String> {
    let roots = hub.remove_root(&path)?;
    hub.inner().rescan().await;
    Ok(roots)
}

#[tauri::command]
async fn conclude_worktree(hub: State<'_, Arc<Hub>>, group_id: String, force: Option<bool>) -> Result<worktree::Concluded, String> {
    hub.inner().conclude(&group_id, force.unwrap_or(false)).await
}

#[tauri::command]
async fn restore_worktrees(hub: State<'_, Arc<Hub>>, removed: Vec<worktree::Removed>) -> Result<(), String> {
    hub.inner().restore(removed).await
}

/// Presets and pins, kept as one opaque JSON document the UI owns. They live in the app data directory so a webview reset cannot wipe them.
const UI_STATE_FILE: &str = "ui-state.json";

#[tauri::command]
fn load_ui_state(app: AppHandle) -> Result<Option<String>, String> {
    let file = data_file(&app, UI_STATE_FILE).map_err(|e| e.to_string())?;
    match std::fs::read_to_string(&file) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", file.display())),
    }
}

#[tauri::command]
fn save_ui_state(app: AppHandle, json: String) -> Result<(), String> {
    let file = data_file(&app, UI_STATE_FILE).map_err(|e| e.to_string())?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    // Write beside the target and rename, so a crash mid-write never leaves a half file.
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &file).map_err(|e| format!("cannot write {}: {e}", file.display()))
}

#[tauri::command]
fn get_watched(hub: State<'_, Arc<Hub>>) -> Vec<String> {
    hub.watched()
}

#[tauri::command]
fn set_watch(hub: State<'_, Arc<Hub>>, repo: String, app_id: String, on: bool) -> Result<Vec<String>, String> {
    hub.set_watch(&repo, &app_id, on)
}

#[tauri::command]
fn get_settings(notifier: State<'_, Arc<Notifier>>) -> Settings {
    notifier.settings()
}

/// Every window keeps its own copy of the settings, so a change is sent to all of them.
#[tauri::command]
fn set_settings(app: AppHandle, notifier: State<'_, Arc<Notifier>>, companion: State<'_, Arc<Companion>>, settings: Settings) -> Result<(), String> {
    notifier.save(settings)?;
    companion.set_enabled(&app, settings.companion);
    let _ = app.emit("settings-changed", settings);
    Ok(())
}

/// The last scan, without scanning again: the companion only needs the app names.
#[tauri::command]
fn groups(hub: State<'_, Arc<Hub>>) -> Vec<Group> {
    hub.groups()
}

/// Brings Spawner to the front, showing only `instance`'s log when one is given.
#[tauri::command]
fn companion_open(app: AppHandle, instance: Option<String>) {
    show_main_window(&app);
    if let Some(id) = instance {
        let _ = app.emit_to("main", "focus-instance", id);
    }
}

/// Stops showing an app that ended in an error, so the companion can go away once nothing else needs it.
#[tauri::command]
fn companion_dismiss(app: AppHandle, companion: State<'_, Arc<Companion>>, instance: String) {
    companion.dismiss(&app, &instance);
}

#[tauri::command]
fn mcp_info(state: State<'_, McpState>) -> McpInfo {
    state.lock().unwrap().clone()
}

#[tauri::command]
async fn claude_check() -> agent::ClaudeStatus {
    tauri::async_runtime::spawn_blocking(agent::check_claude).await.unwrap_or(agent::ClaudeStatus { installed: false, version: None })
}

#[tauri::command]
async fn claude_link(state: State<'_, McpState>) -> Result<agent::LinkStatus, String> {
    let url = state.lock().unwrap().url.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || agent::link_status(&url)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn claude_connect(state: State<'_, McpState>) -> Result<(), String> {
    let url = state.lock().unwrap().url.clone().ok_or("the MCP server is not running")?;
    tauri::async_runtime::spawn_blocking(move || agent::connect(&url)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn claude_add_guidance(snippet: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || agent::add_guidance(&snippet)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_port(port: u16) -> Result<(), String> {
    let mut cmd = std::process::Command::new("explorer");
    cmd.arg(format!("http://localhost:{port}"));
    discovery::no_window(&mut cmd);
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn start(hub: State<'_, Arc<Hub>>, project_id: String, app_id: String, force: Option<bool>, params: Option<HashMap<String, String>>) -> Result<(), String> {
    hub.inner().start_with(&project_id, &app_id, force.unwrap_or(false), &params.unwrap_or_default(), &[])
}

#[tauri::command]
fn stop(hub: State<'_, Arc<Hub>>, instance_id: String) -> Result<(), String> {
    hub.stop(&instance_id)
}

#[tauri::command]
fn instance_states(hub: State<'_, Arc<Hub>>) -> HashMap<String, InstanceState> {
    hub.states()
}

#[tauri::command]
fn instance_ports(hub: State<'_, Arc<Hub>>) -> HashMap<String, u16> {
    hub.ports()
}

#[tauri::command]
fn logs_since(hub: State<'_, Arc<Hub>>, since: u64) -> Vec<LogLine> {
    hub.logs_since(since)
}

#[tauri::command]
fn clear_logs(hub: State<'_, Arc<Hub>>, instance_id: Option<String>) {
    hub.clear_logs(instance_id.as_deref());
}

/// Tells the user about a script's state change, unless they are looking at Spawner already.
fn notify_script(app: &AppHandle, notifier: &Notifier, event: &model::StateEvent) {
    let Some(hub) = app.try_state::<Arc<Hub>>() else { return };
    let Some(name) = hub.script_name(&event.id) else { return };
    let Some((title, body)) = notifier.note(&event.id, &name, &event.state) else { return };
    let focused = app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
    if !focused {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Turns on start-on-login the first time a release build runs; after that the tray toggle owns it.
fn enable_autostart_once(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(marker) = data_file(app, AUTOSTART_MARKER) else { return };
    if marker.exists() {
        return;
    }
    if app.autolaunch().enable().is_ok() {
        if let Some(dir) = marker.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&marker, "");
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Spawner", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(app, "login", "Start on login", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &login, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Spawner")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "login" => {
                let autolaunch = app.autolaunch();
                let _ = if login.is_checked().unwrap_or(false) { autolaunch.enable() } else { autolaunch.disable() };
                let _ = login.set_checked(autolaunch.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![AUTOSTART_ARG])))
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                WindowEvent::Focused(focused) => {
                    if let Some(companion) = window.try_state::<Arc<Companion>>() {
                        companion.set_main_focused(window.app_handle(), *focused);
                    }
                }
                _ => {}
            }
        })
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            enable_autostart_once(app.handle());
            build_tray(app.handle())?;
            if std::env::args().any(|a| a == AUTOSTART_ARG) {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            let handle = app.handle().clone();
            let roots_file = data_file(app.handle(), roots::FILE_NAME)?;
            let notifier = Arc::new(Notifier::load(data_file(app.handle(), notify::FILE_NAME)?));
            app.manage(notifier.clone());
            let companion = Arc::new(Companion::new(notifier.settings().companion));
            app.manage(companion.clone());
            let hub = Hub::new(roots::load(&roots_file, env_roots().as_deref()), move |event| {
                let _ = match event {
                    HubEvent::State(s) => {
                        notify_script(&handle, &notifier, &s);
                        companion.on_state(&handle, &s);
                        handle.emit("instance-state", s)
                    }
                    HubEvent::Log(l) => handle.emit("log-line", l),
                    HubEvent::Port(p) => handle.emit("instance-port", p),
                    HubEvent::Groups(g) => handle.emit("groups-changed", g),
                };
            });
            let mcp_state: McpState = Arc::default();
            hub.persist_roots_to(roots_file);
            hub.persist_watch_to(data_file(app.handle(), watch::FILE_NAME)?);
            app.manage(hub.clone());
            app.manage(mcp_state.clone());
            let port_file = data_file(app.handle(), "mcp-port.txt")?;
            tauri::async_runtime::spawn(async move {
                let saved = std::fs::read_to_string(&port_file).ok().and_then(|t| t.trim().parse::<u16>().ok());
                let usual = requested_mcp_port().or(saved).unwrap_or(mcp::DEFAULT_PORT);
                let ports = mcp::candidate_ports(saved, requested_mcp_port());
                let info = match mcp::serve(hub.clone(), &ports).await {
                    Ok(addr) => {
                        if let Some(dir) = port_file.parent() {
                            let _ = std::fs::create_dir_all(dir);
                        }
                        let _ = std::fs::write(&port_file, addr.port().to_string());
                        McpInfo { url: Some(format!("http://{addr}/mcp")), error: None, port_changed: addr.port() != usual }
                    }
                    Err(e) => McpInfo { url: None, error: Some(e), port_changed: false },
                };
                *mcp_state.lock().unwrap() = info;
                hub.rescan().await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan,
            get_roots,
            add_root,
            remove_root,
            conclude_worktree,
            restore_worktrees,
            mcp_info,
            get_settings,
            set_settings,
            groups,
            companion_open,
            companion_dismiss,
            companion::companion_place,
            companion::companion_drag,
            get_watched,
            set_watch,
            load_ui_state,
            save_ui_state,
            claude_check,
            claude_link,
            claude_connect,
            claude_add_guidance,
            open_port,
            start,
            stop,
            instance_states,
            instance_ports,
            logs_since,
            clear_logs
        ])
        .build(context())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(hub) = handle.try_state::<Arc<Hub>>() {
                hub.stop_all();
            }
        }
    });
}
