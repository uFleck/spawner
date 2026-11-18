//! `spawner.stack.json`: the committed stack of a worktree, resolved into what the stack card and the MCP tools show.
//!
//! The file names apps by repo and name (not ids), so a stack survives rescans: `{"apps":[{"repo":"bill","app":
//! "Acme.Bill.API"}]}`. Ports come from the file, from detection, or from a per-checkout override saved in
//! `ports.json` (never in a repo), so two worktrees of one repo can run side by side. A manifest entry may carry
//! `env` with `{port}`/`{port:Other app}` placeholders, so moving one app's port moves the URL the others call it on.

use crate::model::{AppDef, AppMode, Group, InstanceState, Project, instance_id};
use crate::runner::Hub;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const FILE: &str = "spawner.stack.json";

/// The app kinds that can be moved to another port, and how `apply_port` moves them. Everything else (tauri,
/// dotnet-test, tasks) keeps the port it was detected with and is shown read-only.
pub const PORT_KINDS: &[&str] = &["iis-express", "dotnet-run", "vite", "next", "react", "node"];

/// How long a stop waits for the apps to leave the process tree before reporting them as not stopped.
const STOP_WAIT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------------------------------------------
// The file

/// The manifest as written in a repo. Every field is checked, so a typo is an error on the stack card instead of a
/// silently ignored setting. `name`, `port`, `scheme`, `env` and `open` are optional.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StackFile {
    pub name: Option<String>,
    pub apps: Vec<Entry>,
    #[serde(default)]
    pub open: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Entry {
    pub repo: String,
    pub app: String,
    pub port: Option<u16>,
    pub scheme: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

pub fn parse(text: &str) -> Result<StackFile, String> {
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())
}

/// The file at `path`, with its name in the error so the card can name what to fix.
pub fn read(path: &Path) -> Result<StackFile, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    parse(&text).map_err(|e| format!("{} is invalid: {e}", path.display()))
}

// ---------------------------------------------------------------------------------------------------------------
// What the UI and the MCP tools get

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StackSource {
    pub repo: String,
    pub file: String,
    pub committed: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StackAppOut {
    pub project_id: String,
    pub app_id: String,
    pub instance: String,
    pub app: String,
    pub repo: String,
    /// `"worktree"` for the worktree's own checkout, `"main"` when the repo is run from the main checkout instead.
    pub checkout: String,
    /// `checkout == "main"` in a worktree that is not main: stopping a stack leaves it for the other worktrees.
    pub shared: bool,
    pub kind: String,
    /// `"service"` or `"task"`.
    pub mode: String,
    pub port: Option<u16>,
    /// `"worktree"` (saved override), `"repo"` (manifest), `"detected"` or `"none"`.
    pub port_source: String,
    /// The manifest port, else the detected one; what "Default N" goes back to.
    pub default_port: Option<u16>,
    pub port_settable: bool,
    pub url: Option<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MissingOut {
    pub repo: String,
    pub app: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StackOut {
    pub worktree: String,
    pub label: String,
    pub branch: Option<String>,
    pub name: Option<String>,
    pub source: Option<StackSource>,
    pub open: Vec<String>,
    pub apps: Vec<StackAppOut>,
    pub missing: Vec<MissingOut>,
    /// Only without a manifest: the worktree's detected service apps, for "Use detected apps".
    pub detected: Vec<StackAppOut>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub app: String,
    pub instance: String,
    pub state: String,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub error: Option<String>,
    pub reused: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stop {
    pub app: String,
    pub instance: String,
    pub stopped: bool,
}

// ---------------------------------------------------------------------------------------------------------------
// Resolution

/// The stack of `worktree` (a group id or label, case-insensitive) with `overrides` applied. An invalid manifest is
/// an error naming its file; a worktree without one comes back with `source: None` and its detected service apps.
pub fn resolve(groups: &[Group], worktree: &str, overrides: &HashMap<String, u16>) -> Result<StackOut, String> {
    let group = find_group(groups, worktree).ok_or_else(|| unknown(groups, worktree))?;
    let main = groups.iter().find(|g| g.main && g.id != group.id);
    let mut out = StackOut {
        worktree: group.id.clone(),
        label: group.label.clone(),
        branch: group.projects.iter().find_map(|p| p.branch.clone()),
        name: None,
        source: None,
        open: Vec::new(),
        apps: Vec::new(),
        missing: Vec::new(),
        detected: Vec::new(),
    };
    let Some(found) = manifest(group)? else {
        out.detected = detected(group);
        return Ok(out);
    };

    out.name = found.file.name.clone();
    out.open = found.file.open.clone();
    out.source = Some(StackSource {
        repo: found.repo.clone(),
        file: found.path.display().to_string(),
        committed: committed(&found.path),
    });

    let mut declared: Vec<BTreeMap<String, String>> = Vec::new();
    for entry in &found.file.apps {
        let hit = find_project(group, main, &entry.repo).and_then(|(project, owner)| {
            project.apps.iter().find(|a| matches_app(&a.name, &a.id, &entry.app)).map(|app| (project, owner, app))
        });
        let Some((project, owner, app)) = hit else {
            out.missing.push(MissingOut { repo: entry.repo.clone(), app: entry.app.clone() });
            continue;
        };
        let key = instance_id(&project.id, &app.id);
        let (port, source) = match (overrides.get(&key).copied(), entry.port, app.port) {
            (Some(port), ..) => (Some(port), "worktree"),
            (None, Some(port), _) => (Some(port), "repo"),
            (None, None, Some(port)) => (Some(port), "detected"),
            (None, None, None) => (None, "none"),
        };
        let scheme = scheme_name(entry.scheme.as_deref());
        let default_port = entry.port.or(app.port);
        let checkout = checkout_of(group, owner);
        out.apps.push(app_out(group, project, app, &checkout, &scheme, port, source, default_port));
        declared.push(entry.env.clone());
    }

    // The env values may name another app's port, so they are filled once every app's port is known.
    let ports: Vec<(String, String, Option<u16>)> = out.apps.iter().map(|a| (a.app.clone(), a.app_id.clone(), a.port)).collect();
    for (row, env) in out.apps.iter_mut().zip(declared) {
        row.env = resolved_env(&env, &row.project_id, row.port, &ports);
    }
    Ok(out)
}

/// `resolve` over the hub's last scan and saved overrides.
pub fn current(hub: &Arc<Hub>, worktree: &str) -> Result<StackOut, String> {
    resolve(&hub.groups(), worktree, &hub.port_overrides())
}

/// Writes `FILE` from the worktree's detected service apps, for "Use detected apps". `only` keeps the named apps
/// (case-insensitive) so the card's checkboxes mean something; `None` keeps every service app. Refused when the file
/// already exists, so a hand-written or committed stack is never overwritten.
pub fn write(hub: &Arc<Hub>, worktree: &str, only: Option<&[String]>) -> Result<StackOut, String> {
    let groups = hub.groups();
    let group = find_group(&groups, worktree).ok_or_else(|| unknown(&groups, worktree))?;
    if let Some(existing) = group.projects.iter().map(|p| Path::new(&p.path).join(FILE)).find(|p| p.exists()) {
        return Err(format!("{} already exists; edit it instead of writing a new one", existing.display()));
    }
    let Some(target) = group.projects.first() else {
        return Err(format!("{} has no checkout to write {} in", group.label, FILE));
    };
    let picked = only.map(|names| names.iter().map(|n| n.to_lowercase()).collect::<Vec<_>>());
    let apps: Vec<_> = group
        .projects
        .iter()
        .flat_map(|p| p.apps.iter().filter(|a| a.mode == AppMode::Service).map(move |a| (p, a)))
        .filter(|(_, app)| picked.as_ref().is_none_or(|names| names.contains(&app.name.to_lowercase())))
        .map(|(project, app)| {
            let mut entry = serde_json::Map::new();
            entry.insert("repo".into(), json!(project.repo));
            entry.insert("app".into(), json!(app.name));
            if let Some(port) = app.port {
                entry.insert("port".into(), json!(port));
            }
            serde_json::Value::Object(entry)
        })
        .collect();
    if apps.is_empty() {
        return Err(format!("no service apps detected in {}: write {} by hand", group.label, FILE));
    }
    let doc = json!({ "name": group.label, "apps": apps });
    let path = Path::new(&target.path).join(FILE);
    let text = format!("{}\n", serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?);
    std::fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    resolve(&hub.groups(), worktree, &hub.port_overrides())
}

// ---------------------------------------------------------------------------------------------------------------
// Ports

/// Moves a copy of `app` to `port`: sets its port, makes the runner check it and stops it from learning another one,
/// and adds the flag its kind needs. Call it on a fresh clone, never on an app kept in the scan.
pub fn apply_port(app: &mut AppDef, port: u16, scheme: &str) -> Result<(), String> {
    if !PORT_KINDS.contains(&app.kind.as_str()) {
        return Err(format!("{} cannot take a port override ({})", app.name, app.kind));
    }
    if app.steps.is_empty() {
        return Err(format!("{} has no launch steps to pass a port to", app.name));
    }
    let flag: Vec<String> = match app.kind.as_str() {
        "iis-express" => Vec::new(),
        "dotnet-run" => vec!["--".into(), "--urls".into(), format!("{}://localhost:{port}", scheme_name(Some(scheme)))],
        "vite" => vec!["--".into(), "--port".into(), port.to_string(), "--strictPort".into()],
        "next" => vec!["--".into(), "-p".into(), port.to_string()],
        // A Node app that reads PORT picks it up from the environment; npm itself passes it on.
        _ => {
            for step in &mut app.steps {
                step.env.insert("PORT".into(), port.to_string());
            }
            Vec::new()
        }
    };
    app.port = Some(port);
    app.check_port = true;
    app.learn_port = false;
    if let (Some(step), false) = (app.steps.last_mut(), flag.is_empty()) {
        step.args.extend(flag);
    }
    Ok(())
}

/// The scheme the worktree's manifest gives one app (`https`), so a per-app start reaches the same URL a stack start
/// does. `None` when the worktree has no manifest, the app is not in it, or the file does not parse (the stack card
/// reports that separately).
pub fn scheme_of(groups: &[Group], project: &Project, app_id: &str) -> Option<String> {
    let app = project.apps.iter().find(|a| a.id == app_id)?;
    let group = groups.iter().find(|g| g.projects.iter().any(|p| p.id == project.id))?;
    let found = manifest(group).ok().flatten()?;
    let entry = found
        .file
        .apps
        .iter()
        .find(|e| e.repo.eq_ignore_ascii_case(&project.repo) && matches_app(&app.name, &app.id, &e.app))?;
    Some(scheme_name(entry.scheme.as_deref()))
}

/// `http` unless the manifest says otherwise.
fn scheme_name(wanted: Option<&str>) -> String {
    match wanted.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.eq_ignore_ascii_case("https") => "https".into(),
        _ => "http".into(),
    }
}

/// The scheme of an already resolved app, read back from its url; `http` when it has no port.
fn scheme_of_out(app: &StackAppOut) -> String {
    app.url.as_deref().and_then(|u| u.split_once("://")).map_or_else(|| "http".into(), |(s, _)| s.to_string())
}

// ---------------------------------------------------------------------------------------------------------------
// Env interpolation

/// Fills `{cwd}`, `{port}` (this app's port) and `{port:Other app}` in a manifest env value. An unknown placeholder is
/// an error, never a literal: an app started with `http://localhost:{port:Bill API}` in its config would fail later
/// and elsewhere.
pub fn interpolate(
    raw: &str,
    cwd: &str,
    own: Option<u16>,
    port_of: &dyn Fn(&str) -> Option<u16>,
) -> Result<String, String> {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let token = &after[..end];
        match token {
            "cwd" => out.push_str(cwd),
            "port" => {
                let port = own.ok_or("this app has no port to fill {port} with; give it a port in spawner.stack.json")?;
                out.push_str(&port.to_string());
            }
            _ => match token.strip_prefix("port:") {
                Some(name) => {
                    let port = port_of(name.trim()).ok_or_else(|| {
                        format!("{{port:{name}}} names no app of this stack with a port (check the app name in spawner.stack.json)")
                    })?;
                    out.push_str(&port.to_string());
                }
                None => return Err(format!("unknown placeholder {{{token}}}: use {{port}}, {{port:App}} or {{cwd}}")),
            },
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// The resolved values of a manifest env block. Used at resolve time, where a placeholder that cannot be filled yet
/// stays as written: the card can then show it, and `start` refuses the app with the error instead.
fn resolved_env(env: &BTreeMap<String, String>, cwd: &str, own: Option<u16>, ports: &[(String, String, Option<u16>)]) -> BTreeMap<String, String> {
    env.iter()
        .map(|(key, raw)| (key.clone(), filled(raw, cwd, own, ports)))
        .collect()
}

fn filled(raw: &str, cwd: &str, own: Option<u16>, ports: &[(String, String, Option<u16>)]) -> String {
    interpolate(raw, cwd, own, &|wanted| port_named(ports, wanted)).unwrap_or_else(|_| raw.to_string())
}

fn port_named(ports: &[(String, String, Option<u16>)], wanted: &str) -> Option<u16> {
    ports.iter().find(|(name, id, _)| matches_app(name, id, wanted)).and_then(|(_, _, port)| *port)
}

/// The env of one app at start, on every one of its steps. The error names the variable, so a typo in the manifest is
/// easy to find.
fn env_for_start(app: &StackAppOut, cwd: &str, ports: &[(String, String, Option<u16>)]) -> Result<BTreeMap<String, String>, String> {
    app.env
        .iter()
        .map(|(key, raw)| {
            let value = interpolate(raw, cwd, app.port, &|wanted| port_named(ports, wanted))
                .map_err(|e| format!("{}: env {key}: {e}", app.app))?;
            Ok((key.clone(), value))
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------
// Starting and stopping

/// Starts the selected apps of a worktree's stack concurrently and waits up to `wait` for each to be running (a
/// service) or finished (a task). One app's failure never blocks the others: it comes back in that app's `Run`.
pub async fn start(hub: &Arc<Hub>, worktree: &str, only: Option<Vec<String>>, wait: Duration) -> Result<Vec<Run>, String> {
    let groups = groups_of(hub).await;
    let resolved = resolve(&groups, worktree, &hub.port_overrides())?;
    if resolved.source.is_none() {
        return Err("no spawner.stack.json: use write_stack or add one".into());
    }
    let names = only.as_deref().unwrap_or_default();
    let selected: Vec<&StackAppOut> = match names.is_empty() {
        true => resolved.apps.iter().filter(|a| a.mode == mode_str(AppMode::Service)).collect(),
        false => resolved.apps.iter().filter(|a| names.iter().any(|n| matches_app(&a.app, &a.app_id, n))).collect(),
    };
    if selected.is_empty() {
        let known: Vec<&str> = resolved.apps.iter().map(|a| a.app.as_str()).collect();
        return Err(format!("no app to start in the stack of {} (it has: {})", resolved.label, known.join(", ")));
    }

    let ports: Vec<(String, String, Option<u16>)> = resolved.apps.iter().map(|a| (a.app.clone(), a.app_id.clone(), a.port)).collect();
    let states = hub.states();
    let mut runs: Vec<Run> = Vec::with_capacity(selected.len());
    let mut pending: Vec<(usize, String, bool)> = Vec::new();

    for app in &selected {
        let id = instance_id(&app.project_id, &app.app_id);
        if let Some(state) = states.get(&id).filter(|s| s.is_active()) {
            runs.push(Run {
                app: app.app.clone(),
                instance: id.clone(),
                state: kind(Some(state)).into(),
                port: hub.port_of(&id).or(app.port),
                url: url_of(app, hub.port_of(&id).or(app.port)),
                error: None,
                reused: true,
            });
            continue;
        }
        let (project, mut def) = match fresh(&groups, &app.project_id, &app.app_id) {
            Some(found) => found,
            None => {
                runs.push(failed(app, format!("{} is no longer in the scan; rescan and try again", app.app)));
                continue;
            }
        };
        if let Some(port) = app.port.filter(|_| app.port_settable)
            && let Err(e) = apply_port(&mut def, port, &scheme_of_out(app))
        {
            runs.push(failed(app, e));
            continue;
        }
        match env_for_start(app, &project.path, &ports) {            Err(e) => {
                runs.push(failed(app, e));
                continue;
            }
            Ok(env) => {
                for step in &mut def.steps {
                    for (key, value) in &env {
                        step.env.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        match hub.start_app(&project, def, false) {
            Err(e) => runs.push(failed(app, e)),
            Ok(()) => {
                hub.note(&id, format!("stack start ({})", resolved.label));
                pending.push((runs.len(), id.clone(), app.mode == mode_str(AppMode::Service)));
                runs.push(Run {
                    app: app.app.clone(),
                    instance: id,
                    state: "starting".into(),
                    port: app.port,
                    url: app.url.clone(),
                    error: None,
                    reused: false,
                });
            }
        }
    }

    if !pending.is_empty() && !wait.is_zero() {
        let awaited: Vec<(String, bool)> = pending.iter().map(|(_, id, service)| (id.clone(), *service)).collect();
        wait_all(hub, &awaited, wait).await;
    }
    let states = hub.states();
    for (index, id, _) in pending {
        let app = selected[index];
        runs[index] = finished(hub, &states, app, &id);
    }
    Ok(runs)
}

/// Stops the service apps of a worktree's stack. `keep_shared` leaves the ones that run from a main checkout alone,
/// because another worktree may still be using them.
pub async fn stop(hub: &Arc<Hub>, worktree: &str, keep_shared: bool) -> Result<Vec<Stop>, String> {
    let groups = groups_of(hub).await;
    let resolved = resolve(&groups, worktree, &hub.port_overrides())?;
    if resolved.source.is_none() {
        return Err("no spawner.stack.json: use write_stack or add one".into());
    }
    let states = hub.states();
    let mut out = Vec::new();
    let mut waiting = Vec::new();
    for app in resolved.apps.iter().filter(|a| a.mode == mode_str(AppMode::Service)) {
        let id = instance_id(&app.project_id, &app.app_id);
        if keep_shared && app.shared {
            out.push(Stop { app: app.app.clone(), instance: id, stopped: false });
            continue;
        }
        let active = states.get(&id).is_some_and(InstanceState::is_active);
        let stopping = active && hub.stop(&id).is_ok();
        if stopping {
            waiting.push(id.clone());
        }
        out.push(Stop { app: app.app.clone(), instance: id, stopped: stopping });
    }
    if !waiting.is_empty() {
        let deadline = Instant::now() + STOP_WAIT;
        while hub.states().iter().any(|(id, s)| waiting.contains(id) && s.is_active()) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let states = hub.states();
        for stop in out.iter_mut().filter(|s| s.stopped) {
            if states.get(&stop.instance).is_some_and(InstanceState::is_active) {
                stop.stopped = false;
            }
        }
    }
    Ok(out)
}

/// The scan, with a fresh one when Spawner has not scanned yet (an MCP call can arrive first).
async fn groups_of(hub: &Arc<Hub>) -> Vec<Group> {
    let groups = hub.groups();
    if groups.is_empty() { hub.rescan().await } else { groups }
}

/// The app as it is in the scan: a stack copy is configured from it, so nothing a start changes is kept.
fn fresh(groups: &[Group], project_id: &str, app_id: &str) -> Option<(Project, AppDef)> {
    groups
        .iter()
        .flat_map(|g| &g.projects)
        .find(|p| p.id == project_id)
        .and_then(|p| p.apps.iter().find(|a| a.id == app_id).map(|a| (p.clone(), a.clone())))
}

async fn wait_all(hub: &Arc<Hub>, pending: &[(String, bool)], timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let states = hub.states();
        let done = pending.iter().all(|(id, service)| match states.get(id) {
            Some(InstanceState::Running { .. }) => *service,
            Some(InstanceState::Exited { .. } | InstanceState::Failed { .. }) => true,
            _ => false,
        });
        if done || Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

fn finished(hub: &Arc<Hub>, states: &HashMap<String, InstanceState>, app: &StackAppOut, id: &str) -> Run {
    let state = states.get(id);
    let port = hub.port_of(id).or(app.port);
    Run {
        app: app.app.clone(),
        instance: id.to_string(),
        state: kind(state).into(),
        port,
        url: url_of(app, port),
        error: match state {
            Some(InstanceState::Failed { message }) => Some(message.clone()),
            Some(InstanceState::Exited { code: Some(code) }) if *code != 0 => Some(format!("exited with code {code}")),
            _ => None,
        },
        reused: false,
    }
}

fn failed(app: &StackAppOut, error: String) -> Run {
    Run {
        app: app.app.clone(),
        instance: instance_id(&app.project_id, &app.app_id),
        state: "failed".into(),
        port: app.port,
        url: app.url.clone(),
        error: Some(error),
        reused: false,
    }
}

/// The lowercase state the UI and the MCP reports use: `running`, `starting`, `building`, `stopped`...
pub fn kind(state: Option<&InstanceState>) -> &'static str {
    match state {
        None => "stopped",
        Some(InstanceState::Idle) => "idle",
        Some(InstanceState::Building) => "building",
        Some(InstanceState::Starting) => "starting",
        Some(InstanceState::Running { .. }) => "running",
        Some(InstanceState::Stopping) => "stopping",
        Some(InstanceState::Exited { .. }) => "exited",
        Some(InstanceState::Failed { .. }) => "failed",
    }
}

fn mode_str(mode: AppMode) -> &'static str {
    match mode {
        AppMode::Service => "service",
        AppMode::Task => "task",
    }
}

fn url_of(app: &StackAppOut, port: Option<u16>) -> Option<String> {
    port.map(|port| format!("{}://localhost:{port}", scheme_of_out(app)))
}

// ---------------------------------------------------------------------------------------------------------------
// Finding things

fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Whether a manifest entry's `app` names this app: by name, by id, or by id without its extension.
fn matches_app(name: &str, id: &str, wanted: &str) -> bool {
    same(name, wanted) || same(id, wanted) || same(without_extension(id), wanted)
}

fn without_extension(id: &str) -> &str {
    match id.rsplit_once('.') {
        Some((stem, ext)) if !ext.contains('/') => stem,
        _ => id,
    }
}

pub fn find_group<'a>(groups: &'a [Group], worktree: &str) -> Option<&'a Group> {
    let named = groups.iter().find(|g| same(&g.id, worktree) || same(&g.label, worktree));
    named.or_else(|| match same(worktree, "main") {
        true => groups.iter().find(|g| g.main),
        false => None,
    })
}

fn unknown(groups: &[Group], wanted: &str) -> String {
    let known: Vec<&str> = groups.iter().map(|g| g.id.as_str()).collect();
    match known.is_empty() {
        true => format!("no worktree {wanted:?}: Spawner has not scanned yet"),
        false => format!("no worktree {wanted:?}. Worktrees: {}", known.join(", ")),
    }
}

struct Manifest {
    repo: String,
    path: PathBuf,
    file: StackFile,
}

/// The first `spawner.stack.json` of the group's own checkouts that parses. A file that exists but does not parse is
/// an error: falling through to another repo's stack would hide the mistake in the PR's own file.
fn manifest(group: &Group) -> Result<Option<Manifest>, String> {
    for project in &group.projects {
        let path = Path::new(&project.path).join(FILE);
        if !path.is_file() {
            continue;
        }
        let file = read(&path)?;
        return Ok(Some(Manifest { repo: project.repo.clone(), path, file }));
    }
    Ok(None)
}

/// Whether the manifest is committed, so the card can say "new, not committed" for one written by "Use detected
/// apps". A folder that is not a git checkout is simply not committed.
fn committed(path: &Path) -> bool {
    let Some(dir) = path.parent() else { return false };
    let mut cmd = std::process::Command::new("git");
    cmd.args(["ls-files", "--error-unmatch", FILE]).current_dir(dir);
    crate::discovery::no_window(&mut cmd);
    cmd.output().is_ok_and(|o| o.status.success())
}

/// The project holding `repo`: the worktree's own checkout first, else the main one (`owner` says which).
fn find_project<'a>(group: &'a Group, main: Option<&'a Group>, repo: &str) -> Option<(&'a Project, &'a Group)> {
    let find = |g: &'a Group| g.projects.iter().find(|p| same(&p.repo, repo)).map(|p| (p, g));
    find(group).or_else(|| main.and_then(find))
}

fn checkout_of(group: &Group, owner: &Group) -> String {
    match group.main || owner.id != group.id {
        true => "main".into(),
        false => "worktree".into(),
    }
}

/// One row of the stack card. The caller already knows every field, and grouping them would only move the arguments
/// into a struct that is then destructured again.
#[allow(clippy::too_many_arguments, reason = "a flat row of the card, built from the manifest entry and the detected app")]
fn app_out(
    group: &Group,
    project: &Project,
    app: &AppDef,
    checkout: &str,
    scheme: &str,
    port: Option<u16>,
    port_source: &str,
    default_port: Option<u16>,
) -> StackAppOut {
    StackAppOut {
        project_id: project.id.clone(),
        app_id: app.id.clone(),
        instance: instance_id(&project.id, &app.id),
        app: app.name.clone(),
        repo: project.repo.clone(),
        checkout: checkout.into(),
        shared: checkout == "main" && !group.main,
        kind: app.kind.clone(),
        mode: mode_str(app.mode).into(),
        port,
        port_source: port_source.into(),
        default_port,
        port_settable: app.mode == AppMode::Service && PORT_KINDS.contains(&app.kind.as_str()),
        url: port.map(|port| format!("{scheme}://localhost:{port}")),
        env: BTreeMap::new(),
    }
}

/// The worktree's own service apps, for the no-stack card. Ports are the detected ones: an override only applies once
/// the app is in a stack.
fn detected(group: &Group) -> Vec<StackAppOut> {
    let checkout = if group.main { "main" } else { "worktree" };
    group
        .projects
        .iter()
        .flat_map(|project| {
            project
                .apps
                .iter()
                .filter(|app| app.mode == AppMode::Service)
                .map(move |app| app_out(group, project, app, checkout, "http", app.port, if app.port.is_some() { "detected" } else { "none" }, app.port))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::dotnet::{self, Flavor};
    use crate::model::{Program, StepSpec};
    use crate::testutil::{app, TempDir};

    fn project(path: &str, repo: &str, apps: Vec<AppDef>) -> Project {
        Project { id: path.into(), repo: repo.into(), path: path.into(), branch: None, apps }
    }

    fn group(id: &str, main: bool, projects: Vec<Project>) -> Group {
        Group { id: id.into(), label: id.into(), root: None, root_id: "c:/dev".into(), root_path: "C:/dev".into(), main, projects }
    }

    fn node_app(name: &str, kind: &str, port: Option<u16>) -> AppDef {
        AppDef {
            kind: kind.into(),
            port,
            learn_port: port.is_none(),
            steps: vec![StepSpec {
                program: Program::path("npm"),
                args: vec!["run".into(), "dev".into()],
                cwd: ".".into(),
                env: BTreeMap::new(),
                ready: Vec::new(),
            }],
            ..app(name)
        }
    }

    fn parsed(text: &str) -> StackFile {
        parse(text).unwrap_or_else(|e| panic!("{text} should parse: {e}"))
    }

    #[test]
    fn reads_the_manifest_and_names_what_is_wrong_with_it() {
        let file = parsed(
            r#"{"name":"Account + Bill","apps":[{"repo":"account","app":"Acme.Account.Admin.Server","port":5104,"scheme":"https","env":{"BillApi__BaseUrl":"http://localhost:{port:Acme.Bill.API}"}},{"repo":"bill","app":"Acme.Bill.API"}],"open":["Acme.Account.Admin.Server"]}"#,
        );
        assert_eq!(file.name.as_deref(), Some("Account + Bill"));
        assert_eq!(file.open, ["Acme.Account.Admin.Server"]);
        assert_eq!(file.apps[0].port, Some(5104));
        assert_eq!(file.apps[0].scheme.as_deref(), Some("https"));
        assert_eq!(file.apps[0].env["BillApi__BaseUrl"], "http://localhost:{port:Acme.Bill.API}");
        assert_eq!((file.apps[1].port, file.apps[1].env.len()), (None, 0), "port, scheme and env are optional");

        assert!(parse(r#"{"apps":[{"repo":"a","app":"b","port":"5104"}]}"#).is_err(), "a port must be a number");
        assert!(parse(r#"{"apps":[{"repo":"a","app":"b","prot":1}]}"#).unwrap_err().contains("unknown field"));
        assert!(parse(r#"{"apps":[{"repo":"a","app":"b"}],"extra":1}"#).unwrap_err().contains("unknown field"));
        assert!(parse(r#"{"name":"x"}"#).is_err(), "apps is required");
    }

    #[test]
    fn a_manifest_on_disk_is_read_and_an_invalid_one_names_its_file() {
        let tmp = TempDir::new("stack-read");
        let path = tmp.file("account/spawner.stack.json", r#"{"apps":[{"repo":"account","app":"Api"}]}"#);
        assert_eq!(read(&path).unwrap().apps[0].app, "Api");
        std::fs::write(&path, "{").unwrap();
        let err = read(&path).unwrap_err();
        assert!(err.contains("is invalid"), "{err}");
        assert!(err.contains("spawner.stack.json"), "{err}");
        assert!(read(&tmp.path().join("nope.json")).unwrap_err().contains("cannot read"));
    }

    /// account runs its own checkout; bill is not checked out in the worktree, so it comes from main.
    fn worktree_and_main() -> Vec<Group> {
        let account = node_app("Acme.Account.Admin.Server", "iis-express", Some(5100));
        let bill = node_app("Acme.Bill.API", "dotnet-run", Some(42318));
        vec![
            group(
                "PAYMENT-10138",
                false,
                vec![project("C:/dev/PAYMENT-10138/account", "account", vec![account.clone()])],
            ),
            group("main", true, vec![project("C:/dev/account", "account", vec![account]), project("C:/dev/bill", "bill", vec![bill])]),
        ]
    }

    #[test]
    fn resolves_from_the_worktree_then_main_and_marks_what_is_shared() {
        let tmp = TempDir::new("stack-resolve");
        tmp.file(
            "dev/PAYMENT-10138/account/spawner.stack.json",
            r#"{"name":"Account + Bill","apps":[{"repo":"account","app":"acme.account.admin.server","port":5104,"scheme":"https"},{"repo":"bill","app":"Acme.Bill.API"},{"repo":"shop","app":"Shop"}]}"#,
        );
        let mut groups = worktree_and_main();
        groups[0].projects[0].path = tmp.path().join("dev/PAYMENT-10138/account").to_string_lossy().replace('\\', "/");
        groups[1].projects[0].path = tmp.path().join("dev/account").to_string_lossy().replace('\\', "/");

        let out = resolve(&groups, "payment-10138", &HashMap::new()).unwrap();
        assert_eq!(out.worktree, "PAYMENT-10138");
        assert_eq!(out.name.as_deref(), Some("Account + Bill"), "the file's name, matched case-insensitively on the worktree");
        let source = out.source.clone().expect("a source");
        assert_eq!(source.repo, "account");
        assert!(source.file.ends_with("spawner.stack.json") && Path::new(&source.file).is_absolute());
        assert!(!source.committed, "the temp folder is not a git checkout");

        let account = &out.apps[0];
        assert_eq!((account.checkout.as_str(), account.shared), ("worktree", false));
        assert_eq!((account.port, account.port_source.as_str(), account.default_port), (Some(5104), "repo", Some(5104)));
        assert_eq!(account.url.as_deref(), Some("https://localhost:5104"));
        assert!(account.port_settable);

        let bill = &out.apps[1];
        assert_eq!((bill.checkout.as_str(), bill.shared, bill.port, bill.port_source.as_str()), ("main", true, Some(42318), "detected"));
        assert_eq!(bill.default_port, Some(42318));
        assert_eq!(bill.url.as_deref(), Some("http://localhost:42318"));
        assert!(bill.port_settable, "a dotnet-run app takes --urls");

        assert_eq!(out.missing.len(), 1, "shop is in no checkout of this worktree: {out:?}");
        assert_eq!((out.missing[0].repo.as_str(), out.missing[0].app.as_str()), ("shop", "Shop"));
        assert!(out.detected.is_empty(), "detected is only for a worktree without a manifest");
    }

    #[test]
    fn an_override_wins_over_the_manifest_and_clearing_it_goes_back() {
        let tmp = TempDir::new("stack-override");
        tmp.file(
            "dev/PAYMENT-10138/account/spawner.stack.json",
            r#"{"apps":[{"repo":"account","app":"Acme.Account.Admin.Server","port":5104,"scheme":"https"}]}"#,
        );
        let mut groups = worktree_and_main();
        groups[0].projects[0].path = tmp.path().join("dev/PAYMENT-10138/account").to_string_lossy().replace('\\', "/");
        let id = instance_id(&groups[0].projects[0].id, "Acme.Account.Admin.Server.csproj");
        let overrides = HashMap::from([(id.clone(), 5121u16)]);

        let out = resolve(&groups, "PAYMENT-10138", &overrides).unwrap();
        let app = &out.apps[0];
        assert_eq!((app.port, app.port_source.as_str(), app.default_port), (Some(5121), "worktree", Some(5104)));
        assert_eq!(app.url.as_deref(), Some("https://localhost:5121"), "the scheme still comes from the manifest");
        assert_eq!(out.apps[0].instance, id);

        let out = resolve(&groups, "PAYMENT-10138", &HashMap::new()).unwrap();
        assert_eq!((out.apps[0].port, out.apps[0].port_source.as_str()), (Some(5104), "repo"));
    }

    #[test]
    fn without_a_manifest_the_service_apps_are_detected() {
        let mut groups = worktree_and_main();
        let mut task = node_app("Acme.Account:build", "vite", None);
        task.mode = AppMode::Task;
        groups[0].projects[0].apps.push(task);

        let out = resolve(&groups, "PAYMENT-10138", &HashMap::new()).unwrap();
        assert!(out.source.is_none() && out.apps.is_empty());
        assert_eq!(out.detected.len(), 1, "a task is not part of a stack: {out:?}");
        assert_eq!(out.detected[0].app, "Acme.Account.Admin.Server");
        assert_eq!((out.detected[0].port, out.detected[0].port_source.as_str()), (Some(5100), "detected"));
        assert!(out.detected[0].port_settable, "an iis-express app takes a port");
    }

    #[test]
    fn an_unknown_worktree_is_named_with_the_ones_there_are() {
        let groups = worktree_and_main();
        let err = resolve(&groups, "nope", &HashMap::new()).unwrap_err();
        assert!(err.contains("PAYMENT-10138") && err.contains("main"), "{err}");
        assert_eq!(resolve(&groups, "MAIN", &HashMap::new()).unwrap().worktree, "main", "main is a worktree like any other");
        assert_eq!(resolve(&groups, "main", &HashMap::new()).unwrap().apps.len(), 0, "no manifest in the main checkouts");
    }

    #[test]
    fn a_task_is_listed_but_its_port_is_not_settable() {
        let tmp = TempDir::new("stack-task");
        tmp.file("account/spawner.stack.json", r#"{"apps":[{"repo":"account","app":"build"}]}"#);
        let mut build = node_app("build", "vite", None);
        build.mode = AppMode::Task;
        let groups = vec![group("PAYMENT-1", false, vec![project(&tmp.path().join("account").to_string_lossy().replace('\\', "/"), "account", vec![build])])];
        let out = resolve(&groups, "PAYMENT-1", &HashMap::new()).unwrap();
        assert_eq!((out.apps[0].mode.as_str(), out.apps[0].port_settable), ("task", false));
        assert_eq!((out.apps[0].port, out.apps[0].port_source.as_str()), (None, "none"));
    }

    fn step_args(app: &AppDef) -> Vec<String> {
        app.steps.last().map(|s| s.args.clone()).unwrap_or_default()
    }

    #[test]
    fn each_kind_takes_its_port_its_own_way() {
        let iis = dotnet::app_def(Flavor::IisExpress, "Bill.csproj", "Bill", Some(42318));
        let mut app = iis.clone();
        apply_port(&mut app, 43000, "http").unwrap();
        assert_eq!((app.port, app.check_port, app.learn_port), (Some(43000), true, false));
        assert_eq!(app.steps[1].args, ["/path:{cwd}", "/port:{port}", "/clr:v4.0"], "iis reads the port from its step");

        let mut app = dotnet::app_def(Flavor::DotnetRun, "src/Api/Api.csproj", "Api", None);
        apply_port(&mut app, 5104, "https").unwrap();
        assert_eq!(step_args(&app), ["run", "--project", "Api.csproj", "--no-build", "--", "--urls", "https://localhost:5104"]);

        let mut app = node_app("web:dev", "vite", None);
        apply_port(&mut app, 5173, "http").unwrap();
        assert_eq!(step_args(&app), ["run", "dev", "--", "--port", "5173", "--strictPort"]);

        let mut app = node_app("web:start", "next", None);
        apply_port(&mut app, 3000, "http").unwrap();
        assert_eq!(step_args(&app), ["run", "dev", "--", "-p", "3000"]);

        for kind in ["react", "node"] {
            let mut app = node_app("api:start", kind, None);
            apply_port(&mut app, 4000, "http").unwrap();
            assert_eq!(app.steps[0].env["PORT"], "4000", "{kind}");
            assert_eq!(app.port, Some(4000));
        }

        let mut tauri_app = crate::testutil::app("spawner:tauri dev");
        tauri_app.kind = "tauri".into();
        let err = apply_port(&mut tauri_app, 1420, "http").unwrap_err();
        assert_eq!(err, "spawner:tauri dev cannot take a port override (tauri)");
        let mut test_app = tauri_app.clone();
        test_app.kind = "dotnet-test".into();
        assert!(apply_port(&mut test_app, 1, "http").unwrap_err().contains("cannot take a port override"));
    }

    #[test]
    fn env_placeholders_are_filled_and_an_unknown_app_is_an_error() {
        let ports = vec![("Acme.Bill.API".to_string(), "Api.csproj".to_string(), Some(42318u16))];
        let own = Some(5104u16);
        let bill = |w: &str| port_named(&ports, w);
        assert_eq!(
            interpolate("https://localhost:{port};http://localhost:{port:acme.bill.api}/x", r"C:\dev\a", own, &bill).unwrap(),
            r"https://localhost:5104;http://localhost:42318/x"
        );
        assert_eq!(interpolate("{cwd}", "C:/dev/a", own, &bill).unwrap(), "C:/dev/a");
        assert!(interpolate("x", "C:/dev/a", own, &bill).is_ok(), "text without a placeholder is kept");

        let err = interpolate("http://localhost:{port:Nope}", "C:/dev/a", own, &bill).unwrap_err();
        assert!(err.contains("{port:Nope}") && err.contains("names no app"), "{err}");
        let err = interpolate("{port}", "C:/dev/a", None, &bill).unwrap_err();
        assert!(err.contains("no port"), "{err}");
        assert!(interpolate("{host}", "C:/dev/a", own, &bill).unwrap_err().contains("unknown placeholder"));

        let mut env = BTreeMap::new();
        env.insert("Url".to_string(), "http://localhost:{port:Acme.Bill.API}".to_string());
        let resolved = resolved_env(&env, "C:/dev/a", own, &ports);
        assert_eq!(resolved["Url"], "http://localhost:42318");
        let unresolved = resolved_env(&env, "C:/dev/a", own, &[]);
        assert_eq!(unresolved["Url"], "http://localhost:{port:Acme.Bill.API}", "the card shows it unresolved, start refuses it");
    }

    #[test]
    fn the_scheme_of_a_per_app_start_comes_from_the_manifest() {
        let tmp = TempDir::new("stack-scheme");
        tmp.file("account/spawner.stack.json", r#"{"apps":[{"repo":"account","app":"Acme.Account.Admin.Server","scheme":"https"}]}"#);
        let path = tmp.path().join("account").to_string_lossy().replace('\\', "/");
        let groups = vec![group("PAYMENT-1", false, vec![project(&path, "account", vec![node_app("Acme.Account.Admin.Server", "dotnet-run", None)])])];
        assert_eq!(scheme_of(&groups, &groups[0].projects[0], "Acme.Account.Admin.Server.csproj").as_deref(), Some("https"));
        assert!(scheme_of(&groups, &groups[0].projects[0], "nope").is_none());
    }

    #[tokio::test]
    async fn starting_a_stack_runs_services_and_waits_for_a_named_task() {
        let tmp = TempDir::new("stack-start");
        let port = crate::testutil::spare_port();
        tmp.file(
            "dev/PAYMENT-1/shop/spawner.stack.json",
            &format!(
                r#"{{"apps":[
                {{"repo":"shop","app":"Shop","port":{port}}},
                {{"repo":"shop","app":"Job"}},
                {{"repo":"shop","app":"Ghost"}}
            ]}}"#
            ),
        );
        let dir = tmp.path().join("dev/PAYMENT-1/shop").to_string_lossy().replace('\\', "/");
        let shop = AppDef {
            kind: "node".into(),
            port: None,
            learn_port: true,
            steps: vec![StepSpec {
                program: Program::path("cmd.exe"),
                args: vec!["/c".into(), "echo up && ping -n 30 127.0.0.1 >nul".into()],
                cwd: dir.clone(),
                env: BTreeMap::new(),
                ready: Vec::new(),
            }],
            ..app("Shop")
        };
        let mut job = shop.clone();
        job.name = "Job".into();
        job.id = "Job.cmd".into();
        job.mode = AppMode::Task;
        job.steps[0].args = vec!["/c".into(), "exit 0".into()];
        let hub = Hub::new(Vec::new(), |_| {});
        hub.set_groups(vec![group("PAYMENT-1", false, vec![project(&dir, "shop", vec![shop, job])])]);

        let resolved = resolve(&hub.groups(), "PAYMENT-1", &HashMap::new()).unwrap();
        assert_eq!(resolved.apps.len(), 2, "Ghost is in no scan, so it is missing, not an app: {resolved:?}");
        assert_eq!(resolved.missing.len(), 1);

        // Without a selection only the services start; a named task is waited for as well.
        let runs = start(&hub, "PAYMENT-1", None, Duration::from_secs(20)).await.unwrap();
        assert_eq!(runs.len(), 1, "{runs:?}");
        assert_eq!((runs[0].state.as_str(), runs[0].port, runs[0].url.as_deref()), ("running", Some(port), Some(format!("http://localhost:{port}").as_str())));

        let task = start(&hub, "PAYMENT-1", Some(vec!["job".into()]), Duration::from_secs(20)).await.unwrap();
        assert_eq!((task[0].app.as_str(), task[0].state.as_str(), task[0].error.is_none()), ("Job", "exited", true), "{task:?}");

        let again = start(&hub, "PAYMENT-1", None, Duration::from_secs(5)).await.unwrap();
        assert!(again[0].reused, "an app that is already running is left alone: {again:?}");
        assert_eq!(again[0].state, "running");

        let stopped = stop(&hub, "PAYMENT-1", false).await.unwrap();
        assert!(stopped.iter().any(|s| s.app == "Shop" && s.stopped), "{stopped:?}");
        hub.stop_all();
    }

    #[tokio::test]
    async fn a_stack_with_named_apps_starts_only_those() {
        let tmp = TempDir::new("stack-only");
        tmp.file("shop/spawner.stack.json", r#"{"apps":[{"repo":"shop","app":"One"},{"repo":"shop","app":"Two"}]}"#);
        let dir = tmp.path().join("shop").to_string_lossy().replace('\\', "/");
        let make = |name: &str| AppDef {
            kind: "node".into(),
            steps: vec![StepSpec {
                program: Program::path("cmd.exe"),
                args: vec!["/c".into(), "echo up && ping -n 30 127.0.0.1 >nul".into()],
                cwd: dir.clone(),
                env: BTreeMap::new(),
                ready: Vec::new(),
            }],
            ..app(name)
        };
        let hub = Hub::new(Vec::new(), |_| {});
        hub.set_groups(vec![group("PAYMENT-1", false, vec![project(&dir, "shop", vec![make("One"), make("two")])])]);

        let runs = start(&hub, "PAYMENT-1", Some(vec!["two".into()]), Duration::from_secs(20)).await.unwrap();
        assert_eq!(runs.len(), 1, "the selection is by name, any case: {runs:?}");
        assert_eq!(runs[0].app, "two");
        assert_eq!(runs[0].state, "running");
        hub.stop_all();

        let err = start(&hub, "PAYMENT-1", Some(vec!["Nope".into()]), Duration::from_secs(1)).await.unwrap_err();
        assert!(err.contains("no app to start") && err.contains("One"), "{err}");
    }

    #[tokio::test]
    async fn a_worktree_without_a_manifest_cannot_start_or_stop_a_stack() {
        let hub = Hub::new(Vec::new(), |_| {});
        hub.set_groups(worktree_and_main());
        let err = start(&hub, "PAYMENT-10138", None, Duration::from_secs(1)).await.unwrap_err();
        assert!(err.contains("no spawner.stack.json"), "{err}");
        let err = stop(&hub, "PAYMENT-10138", true).await.unwrap_err();
        assert!(err.contains("no spawner.stack.json"), "{err}");
    }

    #[tokio::test]
    async fn stop_leaves_a_shared_app_running_when_asked_to() {
        let tmp = TempDir::new("stack-stop-shared");
        tmp.file("dev/PAYMENT-1/account/spawner.stack.json", r#"{"apps":[{"repo":"account","app":"Account"},{"repo":"bill","app":"Bill"}]}"#);
        tmp.file("dev/bill/readme.txt", "");
        let account_dir = tmp.path().join("dev/PAYMENT-1/account").to_string_lossy().replace('\\', "/");
        let bill_dir = tmp.path().join("dev/bill").to_string_lossy().replace('\\', "/");
        let make = |name: &str, dir: &str| AppDef {
            kind: "node".into(),
            steps: vec![StepSpec {
                program: Program::path("cmd.exe"),
                args: vec!["/c".into(), "echo up && ping -n 30 127.0.0.1 >nul".into()],
                cwd: dir.to_string(),
                env: BTreeMap::new(),
                ready: Vec::new(),
            }],
            ..app(name)
        };
        let hub = Hub::new(Vec::new(), |_| {});
        hub.set_groups(vec![
            group("PAYMENT-1", false, vec![project(&account_dir, "account", vec![make("Account", &account_dir)])]),
            group("main", true, vec![project(&bill_dir, "bill", vec![make("Bill", &bill_dir)])]),
        ]);

        let runs = start(&hub, "PAYMENT-1", None, Duration::from_secs(20)).await.unwrap();
        assert_eq!(runs.iter().map(|r| r.state.as_str()).collect::<Vec<_>>(), ["running", "running"], "{runs:?}");

        let stopped = stop(&hub, "PAYMENT-1", true).await.unwrap();
        let of = |name: &str| stopped.iter().find(|s| s.app == name).cloned().expect(name);
        assert!(of("Account").stopped, "the worktree's own app stops: {stopped:?}");
        assert!(!of("Bill").stopped, "the shared main-checkout app is left running: {stopped:?}");
        assert!(hub.states().values().any(InstanceState::is_active), "Bill is still up");
        hub.stop_all();
    }

    #[test]
    fn write_is_refused_when_a_manifest_is_already_there() {
        let tmp = TempDir::new("stack-write");
        tmp.file("shop/readme.txt", "");
        let dir = tmp.path().join("shop").to_string_lossy().replace('\\', "/");
        let mut web = node_app("Shop", "vite", None);
        web.mode = AppMode::Service;
        let hub = Hub::new(Vec::new(), |_| {});
        hub.set_groups(vec![group("PAYMENT-1", false, vec![project(&dir, "shop", vec![web])])]);

        let out = write(&hub, "PAYMENT-1", Some(&["Shop".to_string()])).unwrap();
        assert_eq!(out.apps.len(), 1, "{out:?}");
        assert_eq!(out.apps[0].app, "Shop");
        assert!(out.source.is_some_and(|s| !s.committed));

        let text = std::fs::read_to_string(tmp.path().join("shop").join(FILE)).unwrap();
        let written = parse(&text).unwrap();
        assert_eq!(written.name.as_deref(), Some("PAYMENT-1"));
        assert_eq!((written.apps[0].repo.as_str(), written.apps[0].app.as_str()), ("shop", "Shop"));

        let err = write(&hub, "PAYMENT-1", None).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
    }
}
