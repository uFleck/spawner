//! MCP server (Streamable HTTP, JSON responses only) so an AI agent drives the same Hub the user is watching.
//! Every start, stop and log line goes through `Hub`, so nothing an agent runs escapes the UI.

use crate::detect;
use crate::model::{AppDef, AppMode, Group, InstanceState, Level, LogLine, Root, instance_id};
use crate::runner::Hub;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 38_417;
const SUPPORTED: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const LOG_CHARS: usize = 30_000;
const DEFAULT_TAIL: usize = 100;
const MAX_TAIL: usize = 1_000;
const START_TIMEOUT: u64 = 90;
const STOP_TIMEOUT: u64 = 20;
const PORT_GRACE: Duration = Duration::from_secs(3);

const INSTRUCTIONS: &str = "Spawner runs and tracks the user's apps and scripts across the folders the user added to it, and the git worktrees in them. \
Use these tools instead of running dev servers or builds in a terminal, so the user sees every process and log in the Spawner window. \
Call hub_list_apps first. Select an app by `app` (plus `worktree` or `repo` when the name is ambiguous), by `path` (your working directory), or by `instance`. \
hub_start waits until a service is running, or a task has finished, or it has failed, and returns the log lines from that run. Use hub_logs with `since_seq` to poll for new output. \
To run your own script (a Python tool, a PowerShell helper) here, it has to be declared in a spawner.json: call hub_script_guide first, and do not run such scripts in a terminal.";

/// Ports to try, best first. The last port that worked comes before the default so a client config
/// that was written once keeps working; port 0 asks the OS for any free port, so binding cannot fail on a busy port.
pub fn candidate_ports(saved: Option<u16>, requested: Option<u16>) -> Vec<u16> {
    let mut ports = Vec::new();
    for p in requested.into_iter().chain(saved).chain(DEFAULT_PORT..=DEFAULT_PORT + 20).chain([0]) {
        if !ports.contains(&p) {
            ports.push(p);
        }
    }
    ports
}

/// Binds the first port in `ports` that is free. A port another program holds, or one Windows reserves, is skipped.
pub async fn serve(hub: Arc<Hub>, ports: &[u16]) -> Result<SocketAddr, String> {
    let mut last = String::from("no port to try");
    let mut bound = None;
    for &port in ports {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                bound = Some(listener);
                break;
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied) => {
                last = format!("127.0.0.1:{port} ({e})");
            }
            Err(e) => return Err(format!("could not listen on 127.0.0.1:{port} ({e})")),
        }
    }
    let listener = bound.ok_or_else(|| format!("could not listen on any port, last tried {last}"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let app = Router::new()
        .route("/mcp", post(rpc).get(not_allowed).delete(not_allowed))
        .with_state(hub);
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(addr)
}

async fn not_allowed() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
}

fn host_of(value: &str) -> &str {
    let rest = value.split_once("://").map_or(value, |(_, r)| r);
    let authority = rest.split('/').next().unwrap_or("");
    if let Some(end) = authority.strip_prefix('[').and_then(|a| a.find(']')) {
        return &authority[..end + 2];
    }
    authority.split(':').next().unwrap_or("")
}

/// Blocks DNS rebinding and browser pages: only loopback Host and Origin headers are served.
fn loopback_only(headers: &HeaderMap) -> bool {
    let loopback = |h: &str| matches!(host_of(h), "127.0.0.1" | "localhost" | "[::1]");
    let host_ok = headers.get(header::HOST).and_then(|v| v.to_str().ok()).is_some_and(loopback);
    let origin_ok = headers.get(header::ORIGIN).is_none_or(|v| v.to_str().is_ok_and(loopback));
    host_ok && origin_ok
}

fn json_response(value: Value) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], value.to_string()).into_response()
}

async fn rpc(State(hub): State<Arc<Hub>>, headers: HeaderMap, body: Bytes) -> Response {
    if !loopback_only(&headers) {
        return (StatusCode::FORBIDDEN, "spawner only answers loopback requests").into_response();
    }
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return json_response(failure(Value::Null, -32700, "parse error"));
    };
    let reply = match message {
        Value::Array(items) => {
            let mut replies = Vec::new();
            for item in items {
                replies.extend(handle(&hub, item).await);
            }
            (!replies.is_empty()).then_some(Value::Array(replies))
        }
        single => handle(&hub, single).await,
    };
    reply.map_or_else(|| StatusCode::ACCEPTED.into_response(), json_response)
}

fn failure(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

async fn handle(hub: &Arc<Hub>, message: Value) -> Option<Value> {
    let method = message.get("method")?.as_str()?.to_string();
    let id = message.get("id")?.clone();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method.as_str() {
        "initialize" => Ok(initialize(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tool_definitions()})),
        "tools/call" => call_tool(hub, &params).await,
        other => Err((-32601, format!("method not found: {other}"))),
    };
    Some(match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => failure(id, code, &message),
    })
}

fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let version = SUPPORTED.iter().find(|v| **v == asked).unwrap_or(&SUPPORTED[0]);
    json!({
        "protocolVersion": version,
        "capabilities": {"tools": {"listChanged": false}},
        "serverInfo": {"name": "spawner", "version": env!("CARGO_PKG_VERSION")},
        "instructions": INSTRUCTIONS,
    })
}

fn target_properties() -> Value {
    json!({
        "instance": {"type": "string", "description": "Exact instance id from hub_list_apps. Use instead of the fields below."},
        "app": {"type": "string", "description": "App name as listed, such as \"Bill.API\" or \"Acme.Bill.API\". Case-insensitive."},
        "worktree": {"type": "string", "description": "Worktree id, such as \"PAYMENT-9986\" or \"main\"."},
        "repo": {"type": "string", "description": "Repo name, such as \"bill\" or \"account\"."},
        "path": {"type": "string", "description": "Your working directory. Narrows the match to the project that contains it."}
    })
}

fn with_target(extra: Value) -> Value {
    let mut props = target_properties();
    if let (Some(p), Some(e)) = (props.as_object_mut(), extra.as_object()) {
        p.extend(e.clone());
    }
    json!({"type": "object", "properties": props})
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "hub_list_apps",
            "description": "List every runnable app Hub found, grouped as worktree > project (repo) > app, with kind (the technology and how it launches), mode, state, port, url and instance id. A dev server that picks its own port (Vite, Next, Tauri) has no port until it is running and has printed its URL; then port and url show it. mode is \"service\" for something that keeps running until stopped, or \"task\" for a command that runs to its end and reports an exit code. A group is a task worktree, the main checkouts, or a folder the user added (root_path). Call this first.",
            "inputSchema": {"type": "object", "properties": {
                "worktree": {"type": "string", "description": "Only this worktree id."},
                "only_active": {"type": "boolean", "description": "Only apps that are building, starting or running."},
                "rescan": {"type": "boolean", "description": "Rescan the disk first, for a worktree created a moment ago."}
            }}
        },
        {
            "name": "hub_start",
            "description": "Build and start an app in Hub, and return the log lines from this run. By default waits: for a service (mode \"service\") until it is running, has exited or has failed; for a task (mode \"task\") until it has finished, and then reports its exit code (a nonzero code is an error result). A task that is still running when timeout_seconds passes is reported as still running; poll it with hub_logs.",
            "inputSchema": with_target(json!({
                "wait": {"type": "boolean", "description": "Wait for a service to be running, or a task to finish. Default true."},
                "timeout_seconds": {"type": "integer", "description": format!("How long to wait. Default {START_TIMEOUT}.")},
                "log_lines": {"type": "integer", "description": "Log lines to return from this run. Default 40."},
                "params": {"type": "object", "additionalProperties": true, "description": "Values for a script's declared params, by param name (see `params` in hub_list_apps): {\"who\": \"ana@example.com\", \"verbose\": true}. A missing required param is refused before the script starts. Scripts only."},
                "args": {"type": "array", "items": {"type": "string"}, "description": "Extra arguments appended to a script's command, after its params, for a script that documents a usage instead of params. Scripts only."}
            }))
        },
        {
            "name": "hub_stop",
            "description": "Stop an app and its whole process tree. Waits until it has exited.",
            "inputSchema": with_target(json!({}))
        },
        {
            "name": "hub_restart",
            "description": "Stop the app if it is active, then start it again and wait like hub_start.",
            "inputSchema": with_target(json!({
                "timeout_seconds": {"type": "integer", "description": format!("How long to wait for the start. Default {START_TIMEOUT}.")},
                "log_lines": {"type": "integer", "description": "Log lines to return from this run. Default 40."}
            }))
        },
        {
            "name": "hub_logs",
            "description": "Read log lines. With no app selector it merges every instance. Poll by passing the next_since value from the previous call as since_seq.",
            "inputSchema": with_target(json!({
                "since_seq": {"type": "integer", "description": "Only lines with a higher seq."},
                "tail": {"type": "integer", "description": format!("Return the last N matching lines. Default {DEFAULT_TAIL}, max {MAX_TAIL}.")},
                "min_level": {"type": "string", "enum": ["debug", "info", "warn", "error"], "description": "Hide lines below this level."},
                "include_hub": {"type": "boolean", "description": "Include Hub's own lines (build commands, exit codes). Default true."},
                "query": {"type": "string", "description": "Only lines containing this text (case-insensitive), or matching it when regex is true."},
                "regex": {"type": "boolean", "description": "Treat query as a regular expression."}
            }))
        },
        {
            "name": "hub_clear_logs",
            "description": "Clear the logs of one app, or all logs when no selector is given, to get a clean slate before reproducing a problem.",
            "inputSchema": with_target(json!({}))
        },
        {
            "name": "hub_script_guide",
            "description": "How to make a script show up in Spawner: where to put its spawner.json, the format, and what a script that suits Spawner does. Call this before writing or running a script that hub_list_apps does not list, and when the user asks to wire up their scripts.",
            "inputSchema": {"type": "object", "properties": {}}
        },
        {
            "name": "hub_rescan",
            "description": "Rescan the configured folders for worktrees and apps.",
            "inputSchema": {"type": "object", "properties": {}}
        }
    ])
}

#[derive(Deserialize, Default, Debug)]
struct Target {
    instance: Option<String>,
    app: Option<String>,
    worktree: Option<String>,
    repo: Option<String>,
    path: Option<String>,
}

impl Target {
    fn is_empty(&self) -> bool {
        [&self.instance, &self.app, &self.worktree, &self.repo, &self.path].iter().all(|f| f.is_none())
    }
}

#[derive(Deserialize, Default)]
struct StartArgs {
    #[serde(flatten)]
    target: Target,
    wait: Option<bool>,
    timeout_seconds: Option<u64>,
    log_lines: Option<usize>,
    args: Option<Vec<String>>,
    params: Option<HashMap<String, Value>>,
}

/// Param values by name as text; an agent may give a number or a boolean for one.
fn param_values(params: Option<HashMap<String, Value>>) -> Result<HashMap<String, String>, String> {
    params
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| match v {
            Value::String(s) => Ok((k, s)),
            Value::Bool(_) | Value::Number(_) => Ok((k, v.to_string())),
            Value::Null => Ok((k, String::new())),
            _ => Err(format!("param `{k}` must be a string, number or boolean")),
        })
        .collect()
}

#[derive(Deserialize, Default)]
struct ListArgs {
    worktree: Option<String>,
    only_active: Option<bool>,
    rescan: Option<bool>,
}

#[derive(Deserialize, Default)]
struct LogsArgs {
    #[serde(flatten)]
    target: Target,
    since_seq: Option<u64>,
    tail: Option<usize>,
    min_level: Option<String>,
    include_hub: Option<bool>,
    query: Option<String>,
    regex: Option<bool>,
}

#[derive(Clone, Debug)]
struct Hit {
    worktree: String,
    worktree_label: String,
    repo: String,
    project_id: String,
    project_path: String,
    app: AppDef,
    instance: String,
}

impl Hit {
    fn label(&self) -> String {
        format!("{}@{}", self.app.name, self.worktree_label)
    }
}

/// Name without its first dotted segment ("Acme.Bill.API" -> "Bill.API"), accepted as a shorthand when selecting an app.
/// Used for matching only; apps are always displayed and listed under their full name.
fn short_name(name: &str) -> &str {
    name.split_once('.').map_or(name, |(_, rest)| rest)
}

/// An app id is the path of its project file; selecting by that path works with or without the file's extension.
fn without_extension(id: &str) -> &str {
    match id.rsplit_once('.') {
        Some((stem, ext)) if !ext.contains('/') => stem,
        _ => id,
    }
}

fn all_hits(groups: &[Group]) -> Vec<Hit> {
    groups
        .iter()
        .flat_map(|g| {
            g.projects.iter().flat_map(move |p| {
                p.apps.iter().map(move |a| Hit {
                    worktree: g.id.clone(),
                    worktree_label: g.label.clone(),
                    repo: p.repo.clone(),
                    project_id: p.id.clone(),
                    project_path: p.path.clone(),
                    app: a.clone(),
                    instance: instance_id(&p.id, &a.id),
                })
            })
        })
        .collect()
}

fn norm_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn matching(groups: &[Group], t: &Target) -> Vec<Hit> {
    let same = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    let path = t.path.as_deref().map(norm_path);
    all_hits(groups)
        .into_iter()
        .filter(|h| t.instance.as_deref().is_none_or(|i| i == h.instance))
        .filter(|h| t.worktree.as_deref().is_none_or(|w| same(w, &h.worktree) || same(w, &h.worktree_label)))
        .filter(|h| t.repo.as_deref().is_none_or(|r| same(r, &h.repo)))
        .filter(|h| {
            t.app.as_deref().is_none_or(|a| {
                same(a, &h.app.name) || same(a, short_name(&h.app.name)) || same(a, without_extension(&h.app.id))
            })
        })
        .filter(|h| {
            path.as_deref().is_none_or(|p| {
                let project = norm_path(&h.project_path);
                p.starts_with(&project) || project.starts_with(p)
            })
        })
        .collect()
}

fn describe_hits(hits: &[Hit]) -> String {
    hits.iter().map(|h| format!("  {} (repo {}, instance {})", h.label(), h.repo, h.instance)).collect::<Vec<_>>().join("\n")
}

#[derive(Debug)]
enum Miss {
    Nothing,
    Ambiguous(String),
}

fn pick(groups: &[Group], t: &Target) -> Result<Hit, Miss> {
    let mut hits = matching(groups, t);
    match hits.len() {
        0 => Err(Miss::Nothing),
        1 => Ok(hits.remove(0)),
        _ => Err(Miss::Ambiguous(format!(
            "more than one app matches, narrow it with app, worktree, repo or path:\n{}",
            describe_hits(&hits)
        ))),
    }
}

async fn resolve(hub: &Arc<Hub>, t: &Target) -> Result<Hit, String> {
    if t.is_empty() {
        return Err("name an app: give app (and worktree or repo), path, or instance. hub_list_apps shows them.".into());
    }
    let mut groups = hub.groups();
    for attempt in 0..2 {
        match pick(&groups, t) {
            Ok(hit) => return Ok(hit),
            Err(Miss::Ambiguous(message)) => return Err(message),
            Err(Miss::Nothing) if attempt == 0 => groups = hub.rescan().await,
            Err(Miss::Nothing) => {}
        }
    }
    let known = all_hits(&groups);
    Err(format!(
        "no app matches {t:?}. Known apps:\n{}\nIf this is a script of your own, Spawner only runs scripts declared in a spawner.json: call hub_script_guide to see how.",
        if known.is_empty() { "  (no runnable apps found)".into() } else { describe_hits(&known) }
    ))
}

/// The script guide, with the folders Spawner scans so the agent knows where a `spawner.json` can go.
fn script_guide(roots: &[Root]) -> String {
    let folders = if roots.is_empty() {
        "  (none yet: the user adds one in the Spawner window)".to_string()
    } else {
        roots.iter().map(|r| format!("  {}", r.path)).collect::<Vec<_>>().join("\n")
    };
    format!("{}\n\nFolders Spawner scans:\n{folders}", detect::scripts::GUIDE)
}

struct Out {
    text: String,
    error: bool,
}

fn ok(text: impl Into<String>) -> Out {
    Out { text: text.into(), error: false }
}

fn bad(text: impl Into<String>) -> Out {
    Out { text: text.into(), error: true }
}

fn kind(s: Option<&InstanceState>) -> &'static str {
    match s {
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

/// The port to show for an app: the fixed one from its definition, else the one its running instance printed.
fn shown_port(app: &AppDef, learned: Option<u16>) -> Option<u16> {
    app.port.or(learned)
}

fn list_json(
    groups: &[Group],
    states: &HashMap<String, InstanceState>,
    ports: &HashMap<String, u16>,
    worktree: Option<&str>,
    only_active: bool,
) -> Value {
    let worktrees: Vec<Value> = groups
        .iter()
        .filter(|g| worktree.is_none_or(|w| w.eq_ignore_ascii_case(&g.id) || w.eq_ignore_ascii_case(&g.label)))
        .filter_map(|g| {
            let projects: Vec<Value> = g
                .projects
                .iter()
                .filter_map(|p| {
                    let apps: Vec<Value> = p
                        .apps
                        .iter()
                        .filter_map(|a| {
                            let id = instance_id(&p.id, &a.id);
                            let state = states.get(&id);
                            let port = shown_port(a, ports.get(&id).copied());
                            if only_active && !state.is_some_and(InstanceState::is_active) {
                                return None;
                            }
                            Some(json!({
                                "app": a.name,
                                "full_name": a.name,
                                "kind": a.kind,
                                "mode": a.mode,
                                "port": port,
                                "url": port.map(|port| format!("http://localhost:{port}")),
                                "state": kind(state),
                                "detail": state.map(InstanceState::describe),
                                "description": a.description,
                                "params": (!a.params.is_empty()).then_some(&a.params),
                                "instance": id,
                            }))
                        })
                        .collect();
                    (!apps.is_empty()).then(|| json!({"repo": p.repo, "branch": p.branch, "path": p.path, "apps": apps}))
                })
                .collect();
            (!projects.is_empty()).then(|| json!({"worktree": g.id, "label": g.label, "root": g.root, "root_path": g.root_path, "main": g.main, "scripts": g.scripts, "projects": projects}))
        })
        .collect();
    if groups.iter().any(|g| g.scripts) {
        json!({"worktrees": worktrees})
    } else {
        json!({"worktrees": worktrees, "hint": "No scripts are registered. To run your own scripts in Spawner, call hub_script_guide."})
    }
}

fn clock(ts: u64) -> String {
    let s = ts / 1000 % 86_400;
    format!("{:02}:{:02}:{:02}Z", s / 3600, s / 60 % 60, s % 60)
}

struct LogQuery {
    ids: Option<Vec<String>>,
    since: u64,
    min_level: Option<Level>,
    include_hub: bool,
    text: Option<Box<dyn Fn(&str) -> bool + Send>>,
    tail: usize,
}

fn select_logs(lines: Vec<LogLine>, q: &LogQuery) -> (Vec<LogLine>, usize) {
    let mut hits: Vec<LogLine> = lines
        .into_iter()
        .filter(|l| l.seq > q.since)
        .filter(|l| q.ids.as_ref().is_none_or(|ids| ids.contains(&l.instance)))
        .filter(|l| if l.level == Level::Sys { q.include_hub } else { q.min_level.is_none_or(|m| l.level >= m) })
        .filter(|l| q.text.as_ref().is_none_or(|f| f(&l.text)))
        .collect();
    let total = hits.len();
    if total > q.tail {
        hits.drain(..total - q.tail);
    }
    (hits, total)
}

fn render_logs(lines: &[LogLine], labels: &HashMap<String, String>, total: usize) -> String {
    let mut shown: Vec<String> = Vec::new();
    let mut chars = 0;
    for l in lines.iter().rev() {
        let label = labels.get(&l.instance).map_or(l.instance.as_str(), String::as_str);
        let row = format!("{} {} {} {} {}", l.seq, clock(l.ts), label, l.level.label(), l.text);
        chars += row.len() + 1;
        if chars > LOG_CHARS && !shown.is_empty() {
            break;
        }
        shown.push(row);
    }
    shown.reverse();
    let next = lines.last().map_or(0, |l| l.seq);
    let mut out = String::new();
    if shown.len() < total {
        out.push_str(&format!("(showing the last {} of {} matching lines)\n", shown.len(), total));
    }
    out.push_str(&shown.join("\n"));
    if shown.is_empty() {
        out.push_str("(no matching log lines)");
    }
    out.push_str(&format!("\nnext_since: {next}"));
    out
}

async fn wait_for(hub: &Arc<Hub>, id: &str, timeout: Duration, done: fn(&InstanceState) -> bool) -> Option<InstanceState> {
    let deadline = Instant::now() + timeout;
    loop {
        let state = hub.states().get(id).cloned();
        if state.as_ref().is_some_and(done) || Instant::now() >= deadline {
            return state;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn run_report(hub: &Hub, hit: &Hit, before: u64, lines: usize, state: Option<&InstanceState>, waited: Duration) -> Out {
    let (rows, total) = select_logs(
        hub.logs_since(before),
        &LogQuery { ids: Some(vec![hit.instance.clone()]), since: before, min_level: None, include_hub: true, text: None, tail: lines },
    );
    let labels = HashMap::from([(hit.instance.clone(), hit.label())]);
    let head = match state {
        Some(InstanceState::Running { .. }) if hit.app.mode == AppMode::Service => {
            let url = shown_port(&hit.app, hub.port_of(&hit.instance)).map(|p| format!(" at http://localhost:{p}")).unwrap_or_default();
            format!("{}: {}{url}", hit.label(), state.map(InstanceState::describe).unwrap_or_default())
        }
        Some(s @ (InstanceState::Failed { .. } | InstanceState::Exited { .. })) => format!("{}: {}", hit.label(), s.describe()),
        other => format!(
            "{}: still {} after {}s. Call hub_logs with since_seq={before} to keep watching.",
            hit.label(),
            kind(other),
            waited.as_secs()
        ),
    };
    let failed = match state {
        Some(InstanceState::Failed { .. }) => true,
        Some(InstanceState::Exited { code: Some(c) }) => *c != 0,
        _ => false,
    };
    let body = format!("{head}\ninstance: {}\n--- log lines from this run ---\n{}", hit.instance, render_logs(&rows, &labels, total));
    Out { text: body, error: failed }
}

/// A dev server can say it is ready a line or two before it prints its URL (Vite: `ready in`, then `Local:`), so a
/// service that is running but has not shown its port yet gets a moment to, so the report can carry the URL.
async fn wait_for_port(hub: &Arc<Hub>, id: &str) {
    let deadline = Instant::now() + PORT_GRACE;
    while hub.port_of(id).is_none() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn start_flow(hub: &Arc<Hub>, hit: &Hit, values: &HashMap<String, String>, extra: &[String], wait: bool, timeout: Duration, lines: usize) -> Out {
    if let Some(s) = hub.states().get(&hit.instance).filter(|s| s.is_active()) {
        return ok(format!("{} is already {}. Use hub_restart to rebuild it.", hit.label(), s.describe()));
    }
    let before = hub.last_seq();
    if let Err(e) = hub.start_with(&hit.project_id, &hit.app.id, false, values, extra) {
        return bad(format!("could not start {}: {e}", hit.label()));
    }
    hub.note(&hit.instance, "started via MCP");
    if !wait {
        return ok(format!("{} is starting. instance: {}\nnext_since: {before}", hit.label(), hit.instance));
    }
    let started = Instant::now();
    let done: fn(&InstanceState) -> bool = match hit.app.mode {
        AppMode::Service => |s| matches!(s, InstanceState::Running { .. } | InstanceState::Exited { .. } | InstanceState::Failed { .. }),
        AppMode::Task => |s| matches!(s, InstanceState::Exited { .. } | InstanceState::Failed { .. }),
    };
    let state = wait_for(hub, &hit.instance, timeout, done).await;
    if hit.app.learn_port && hit.app.mode == AppMode::Service && matches!(state, Some(InstanceState::Running { .. })) {
        wait_for_port(hub, &hit.instance).await;
    }
    run_report(hub, hit, before, lines, state.as_ref(), started.elapsed())
}

async fn stop_flow(hub: &Arc<Hub>, hit: &Hit) -> Out {
    let active = hub.states().get(&hit.instance).is_some_and(InstanceState::is_active);
    if !active {
        return ok(format!("{} is not running.", hit.label()));
    }
    if let Err(e) = hub.stop(&hit.instance) {
        return bad(format!("could not stop {}: {e}", hit.label()));
    }
    hub.note(&hit.instance, "stopped via MCP");
    let state = wait_for(hub, &hit.instance, Duration::from_secs(STOP_TIMEOUT), |s| !s.is_active()).await;
    match state {
        Some(s) if !s.is_active() => ok(format!("{}: {}", hit.label(), s.describe())),
        _ => bad(format!("{} did not stop within {STOP_TIMEOUT}s.", hit.label())),
    }
}

async fn call_tool(hub: &Arc<Hub>, params: &Value) -> Result<Value, (i32, String)> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let invalid = |e: serde_json::Error| (-32602, format!("invalid arguments for {name}: {e}"));
    let out = match name {
        "hub_list_apps" => {
            let a: ListArgs = serde_json::from_value(args).map_err(invalid)?;
            let groups = if a.rescan.unwrap_or(false) || hub.groups().is_empty() { hub.rescan().await } else { hub.groups() };
            let value = list_json(&groups, &hub.states(), &hub.ports(), a.worktree.as_deref(), a.only_active.unwrap_or(false));
            ok(serde_json::to_string_pretty(&value).unwrap_or_default())
        }
        "hub_start" | "hub_restart" => {
            let a: StartArgs = serde_json::from_value(args).map_err(invalid)?;
            let timeout = Duration::from_secs(a.timeout_seconds.unwrap_or(START_TIMEOUT).clamp(1, 600));
            let lines = a.log_lines.unwrap_or(40).min(MAX_TAIL);
            let extra = a.args.clone().unwrap_or_default();
            match (param_values(a.params.clone()), resolve(hub, &a.target).await) {
                (Err(e), _) | (_, Err(e)) => bad(e),
                (Ok(values), Ok(hit)) if name == "hub_start" => start_flow(hub, &hit, &values, &extra, a.wait.unwrap_or(true), timeout, lines).await,
                (Ok(values), Ok(hit)) => {
                    let stopped = stop_flow(hub, &hit).await;
                    if stopped.error { stopped } else { start_flow(hub, &hit, &values, &extra, true, timeout, lines).await }
                }
            }
        }
        "hub_stop" => {
            let t: Target = serde_json::from_value(args).map_err(invalid)?;
            match resolve(hub, &t).await {
                Err(e) => bad(e),
                Ok(hit) => stop_flow(hub, &hit).await,
            }
        }
        "hub_logs" => {
            let a: LogsArgs = serde_json::from_value(args).map_err(invalid)?;
            logs_tool(hub, a).await
        }
        "hub_clear_logs" => {
            let t: Target = serde_json::from_value(args).map_err(invalid)?;
            if t.is_empty() {
                hub.clear_logs(None);
                ok("cleared all logs")
            } else {
                let hits = matching(&hub.groups(), &t);
                if hits.is_empty() {
                    bad(format!("no app matches {t:?}"))
                } else {
                    hits.iter().for_each(|h| hub.clear_logs(Some(&h.instance)));
                    ok(format!("cleared logs for {}", hits.iter().map(Hit::label).collect::<Vec<_>>().join(", ")))
                }
            }
        }
        "hub_script_guide" => ok(script_guide(&hub.roots())),
        "hub_rescan" => {
            let groups = hub.rescan().await;
            let projects: usize = groups.iter().map(|g| g.projects.len()).sum();
            let apps: usize = groups.iter().flat_map(|g| &g.projects).map(|p| p.apps.len()).sum();
            let folders = hub.roots().len();
            if folders == 0 {
                ok("no folders configured: add one in the Spawner window")
            } else {
                ok(format!("found {} worktrees, {projects} projects, {apps} apps in {folders} folder{}", groups.len(), if folders == 1 { "" } else { "s" }))
            }
        }
        other => return Err((-32602, format!("unknown tool: {other}"))),
    };
    Ok(json!({"content": [{"type": "text", "text": out.text}], "isError": out.error}))
}

async fn logs_tool(hub: &Arc<Hub>, a: LogsArgs) -> Out {
    let min_level = match a.min_level.as_deref() {
        None => None,
        Some(s) => match Level::parse(s) {
            Some(l) => Some(l),
            None => return bad(format!("min_level must be debug, info, warn or error, got {s:?}")),
        },
    };
    let text: Option<Box<dyn Fn(&str) -> bool + Send>> = match a.query.as_deref().filter(|q| !q.is_empty()) {
        None => None,
        Some(q) if a.regex.unwrap_or(false) => match RegexBuilder::new(q).case_insensitive(true).build() {
            Ok(re) => Some(Box::new(move |t| re.is_match(t))),
            Err(e) => return bad(format!("invalid regex: {e}")),
        },
        Some(q) => {
            let needle = q.to_lowercase();
            Some(Box::new(move |t| t.to_lowercase().contains(&needle)))
        }
    };
    let mut groups = hub.groups();
    let ids = if a.target.is_empty() {
        None
    } else {
        let mut hits = matching(&groups, &a.target);
        if hits.is_empty() {
            groups = hub.rescan().await;
            hits = matching(&groups, &a.target);
        }
        if hits.is_empty() {
            return bad(format!("no app matches {:?}", a.target));
        }
        Some(hits.iter().map(|h| h.instance.clone()).collect())
    };
    let labels: HashMap<String, String> = all_hits(&groups).into_iter().map(|h| (h.instance.clone(), h.label())).collect();
    let since = a.since_seq.unwrap_or(0);
    let tail = a.tail.unwrap_or(DEFAULT_TAIL).clamp(1, MAX_TAIL);
    let query = LogQuery { ids, since, min_level, include_hub: a.include_hub.unwrap_or(true), text, tail };
    let (rows, total) = select_logs(hub.logs_since(since), &query);
    if rows.is_empty() && since > 0 {
        return ok(format!("(no new lines)\nnext_since: {since}"));
    }
    ok(render_logs(&rows, &labels, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Project, Stream};

    use crate::testutil::app;

    fn groups() -> Vec<Group> {
        let project = |root: &str, repo: &str, apps: Vec<AppDef>| Project {
            id: format!("{root}/{repo}"),
            repo: repo.into(),
            path: format!("{root}/{repo}"),
            branch: None,
            apps,
        };
        vec![
            Group {
                id: "PAYMENT-9986".into(),
                label: "PAYMENT-9986".into(),
                root: Some("C:/dev/PAYMENT-9986".into()),
                root_id: "c:/dev".into(),
                root_path: "C:/dev".into(),
                main: false,
                scripts: false,
                projects: vec![project("C:/dev/PAYMENT-9986", "bill", vec![app("Acme.Bill.API")]), project("C:/dev/PAYMENT-9986", "account", vec![app("Acme.Account.App")])],
            },
            Group {
                id: "main".into(),
                label: "main".into(),
                root: None,
                root_id: "c:/dev".into(),
                root_path: "C:/dev".into(),
                main: true,
                scripts: false,
                projects: vec![project("C:/dev", "bill", vec![app("Acme.Bill.API")])],
            },
        ]
    }

    fn target(app: Option<&str>, worktree: Option<&str>, path: Option<&str>) -> Target {
        Target { app: app.map(Into::into), worktree: worktree.map(Into::into), path: path.map(Into::into), ..Default::default() }
    }

    #[test]
    fn app_name_matches_with_or_without_the_company_prefix() {
        let g = groups();
        assert!(pick(&g, &target(Some("account.app"), None, None)).is_ok());
        assert!(pick(&g, &target(Some("Acme.Account.App"), None, None)).is_ok());
    }

    #[test]
    fn same_app_in_two_worktrees_is_ambiguous_until_narrowed() {
        let g = groups();
        let Err(Miss::Ambiguous(err)) = pick(&g, &target(Some("Bill.API"), None, None)) else { panic!("expected ambiguity") };
        assert!(err.contains("PAYMENT-9986") && err.contains("main"), "{err}");
        assert_eq!(pick(&g, &target(Some("Bill.API"), Some("main"), None)).unwrap().worktree, "main");
    }

    #[test]
    fn working_directory_picks_the_worktree() {
        let g = groups();
        let hit = pick(&g, &target(Some("Bill.API"), None, Some("C:\\dev\\PAYMENT-9986\\bill\\Bill.Api"))).unwrap();
        assert_eq!(hit.worktree, "PAYMENT-9986");
    }

    #[test]
    fn nothing_matching_is_reported_as_missing() {
        assert!(matches!(pick(&groups(), &target(Some("Nope"), None, None)), Err(Miss::Nothing)));
    }

    #[test]
    fn only_loopback_hosts_and_origins_are_served() {
        let headers = |host: &str, origin: Option<&str>| {
            let mut h = HeaderMap::new();
            h.insert(header::HOST, host.parse().unwrap());
            if let Some(o) = origin {
                h.insert(header::ORIGIN, o.parse().unwrap());
            }
            h
        };
        assert!(loopback_only(&headers("127.0.0.1:47821", None)));
        assert!(loopback_only(&headers("localhost:47821", Some("http://localhost:3000"))));
        assert!(!loopback_only(&headers("evil.example:47821", None)));
        assert!(!loopback_only(&headers("127.0.0.1:47821", Some("https://evil.example"))));
    }

    fn line(seq: u64, instance: &str, level: Level, text: &str) -> LogLine {
        LogLine { seq, instance: instance.into(), ts: 1_000 * seq, stream: Stream::Out, level, text: text.into() }
    }

    #[test]
    fn log_selection_filters_by_level_query_and_instance_then_tails() {
        let lines = vec![
            line(1, "a", Level::Inf, "started"),
            line(2, "a", Level::Err, "boom one"),
            line(3, "b", Level::Err, "boom two"),
            line(4, "a", Level::Wrn, "careful"),
            line(5, "a", Level::Sys, "exited"),
        ];
        let q = |min: Option<Level>, hub: bool, ids: Option<Vec<String>>, tail: usize| LogQuery { ids, since: 0, min_level: min, include_hub: hub, text: None, tail };
        let (errs, _) = select_logs(lines.clone(), &q(Some(Level::Err), false, Some(vec!["a".into()]), 10));
        assert_eq!(errs.iter().map(|l| l.seq).collect::<Vec<_>>(), [2]);
        let (warns, _) = select_logs(lines.clone(), &q(Some(Level::Wrn), true, None, 10));
        assert_eq!(warns.iter().map(|l| l.seq).collect::<Vec<_>>(), [2, 3, 4, 5]);
        let (last, total) = select_logs(lines.clone(), &q(None, true, None, 2));
        assert_eq!(last.iter().map(|l| l.seq).collect::<Vec<_>>(), [4, 5]);
        assert_eq!(total, 5);
        let mut text = q(None, true, None, 10);
        text.text = Some(Box::new(|t| t.contains("two")));
        assert_eq!(select_logs(lines, &text).0.len(), 1);
    }

    #[test]
    fn rendered_logs_end_with_the_cursor() {
        let labels = HashMap::from([("a".to_string(), "App@main".to_string())]);
        let out = render_logs(&[line(7, "a", Level::Err, "boom")], &labels, 1);
        assert!(out.contains("7 00:00:07Z App@main ERR boom"), "{out}");
        assert!(out.ends_with("next_since: 7"));
    }

    async fn rpc_over_tcp(addr: SocketAddr, host: &str, body: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req = format!(
            "POST /mcp HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn serves_the_mcp_handshake_and_tool_list_over_http() {
        let hub = Hub::new(Vec::new(), |_| {});
        hub.set_groups(groups());
        let addr = serve(hub, &[0]).await.unwrap();

        let init = rpc_over_tcp(addr, "127.0.0.1", r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#).await;
        assert!(init.contains("200 OK") && init.contains("\"serverInfo\"") && init.contains("spawner"), "{init}");

        let note = rpc_over_tcp(addr, "127.0.0.1", r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await;
        assert!(note.starts_with("HTTP/1.1 202"), "{note}");

        let tools = rpc_over_tcp(addr, "localhost", r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).await;
        for name in ["hub_list_apps", "hub_start", "hub_stop", "hub_restart", "hub_logs", "hub_clear_logs", "hub_rescan"] {
            assert!(tools.contains(name), "missing {name}: {tools}");
        }

        let list = rpc_over_tcp(addr, "127.0.0.1", r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hub_list_apps","arguments":{}}}"#).await;
        assert!(list.contains("PAYMENT-9986") && list.contains("Account.App"), "{list}");

        let forbidden = rpc_over_tcp(addr, "evil.example", r#"{"jsonrpc":"2.0","id":4,"method":"ping"}"#).await;
        assert!(forbidden.starts_with("HTTP/1.1 403"), "{forbidden}");
    }

    #[tokio::test]
    #[ignore = "needs the dotnet 9 SDK; builds and runs a throwaway web app on 127.0.0.1:5199"]
    async fn runs_a_real_app_through_the_mcp_tools() {
        let dir = std::env::temp_dir().join(format!("hub-mcp-{}", std::process::id()));
        let app_dir = dir.join("Demo");
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::write(
            app_dir.join("Demo.csproj"),
            r#"<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net9.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>"#,
        )
        .unwrap();
        std::fs::write(
            app_dir.join("Program.cs"),
            r#"var app = WebApplication.Create(args); app.MapGet("/", () => "hi"); app.Logger.LogWarning("demo warning"); app.Run("http://127.0.0.1:5199");"#,
        )
        .unwrap();

        let path = dir.to_string_lossy().replace('\\', "/");
        let hub = Hub::new(Vec::new(), |_| {});
        hub.set_groups(vec![Group {
            id: "PAYMENT-1".into(),
            label: "PAYMENT-1".into(),
            root: Some(path.clone()),
            root_id: path.clone(),
            root_path: path.clone(),
            main: false,
            scripts: false,
            projects: vec![Project {
                id: path.clone(),
                repo: "demo".into(),
                path: path.clone(),
                branch: None,
                apps: vec![crate::detect::dotnet::app_def(
                    crate::detect::dotnet::Flavor::DotnetRun,
                    "Demo/Demo.csproj",
                    "Acme.Demo",
                    Some(5199),
                )],
            }],
        }]);
        let addr = serve(hub.clone(), &[0]).await.unwrap();
        let call = |id: u32, tool: &str, args: &str| {
            let body = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"{tool}","arguments":{args}}}}}"#);
            async move { rpc_over_tcp(addr, "127.0.0.1", &body).await }
        };

        let started = call(1, "hub_start", r#"{"app":"Demo","timeout_seconds":120}"#).await;
        assert!(started.contains("running (pid") && started.contains("http://localhost:5199"), "{started}");
        assert!(started.contains("Now listening on"), "{started}");
        assert!(started.contains("started via MCP"), "{started}");

        let errors = call(2, "hub_logs", r#"{"app":"Demo","min_level":"warn","include_hub":false}"#).await;
        assert!(errors.contains("demo warning") && errors.contains("WRN"), "{errors}");
        assert!(!errors.contains("Now listening on"), "{errors}");

        let listed = call(3, "hub_list_apps", r#"{"only_active":true}"#).await;
        assert!(listed.contains(r#"state\": \"running"#) || listed.contains("running"), "{listed}");

        let again = call(4, "hub_start", r#"{"app":"Demo"}"#).await;
        assert!(again.contains("already running"), "{again}");

        let stopped = call(5, "hub_stop", r#"{"app":"Demo"}"#).await;
        assert!(stopped.contains("exited") || stopped.contains("not running"), "{stopped}");
        assert!(!hub.states().values().any(InstanceState::is_active));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn cmd_task(script: &str) -> AppDef {
        let mut task = app("job");
        task.kind = "custom".into();
        task.mode = AppMode::Task;
        task.steps = vec![crate::model::StepSpec {
            program: crate::model::Program::path("cmd.exe"),
            args: vec!["/c".into(), script.into()],
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            ready: Vec::new(),
        }];
        task
    }

    fn hub_with(app: &AppDef) -> (Arc<Hub>, Hit) {
        let hub = Hub::new(Vec::new(), |_| {});
        let project = Project { id: "p".into(), repo: "r".into(), path: "p".into(), branch: None, apps: vec![app.clone()] };
        let group = Group { id: "g".into(), label: "g".into(), root: None, root_id: "r".into(), root_path: "r".into(), main: false, scripts: false, projects: vec![project] };
        hub.set_groups(vec![group]);
        let hit = all_hits(&hub.groups()).remove(0);
        (hub, hit)
    }

    #[tokio::test]
    async fn a_script_takes_extra_arguments_and_nothing_else_does() {
        let mut script = cmd_task("echo");
        script.kind = "script".into();
        let (hub, hit) = hub_with(&script);
        let out = start_flow(&hub, &hit, &HashMap::new(), &["snapshot".into(), "a@b.c".into()], true, Duration::from_secs(10), 40).await;
        assert!(!out.error && out.text.contains("snapshot a@b.c"), "{}", out.text);

        let (hub, hit) = hub_with(&cmd_task("echo"));
        let out = start_flow(&hub, &hit, &HashMap::new(), &["x".into()], true, Duration::from_secs(10), 40).await;
        assert!(out.error && out.text.contains("takes no extra arguments"), "{}", out.text);
        let out = start_flow(&hub, &hit, &HashMap::from([("x".into(), "1".into())]), &[], true, Duration::from_secs(10), 40).await;
        assert!(out.error && out.text.contains("takes no extra arguments"), "{}", out.text);
    }

    #[tokio::test]
    async fn a_script_with_params_is_refused_without_its_required_value_and_runs_with_it() {
        let mut script = cmd_task("echo");
        script.kind = "script".into();
        script.params = vec![crate::model::Param {
            name: "who".into(),
            kind: crate::model::ParamKind::Text,
            hint: Some("Email of the customer".into()),
            placeholder: None,
            flag: Some("--who".into()),
            options: Vec::new(),
            required: true,
            default: None,
        }];
        let (hub, hit) = hub_with(&script);
        let out = start_flow(&hub, &hit, &HashMap::new(), &[], true, Duration::from_secs(10), 40).await;
        assert!(out.error && out.text.contains("missing required parameter `who`: Email of the customer"), "{}", out.text);
        assert!(hub.states().is_empty(), "nothing ran");

        let values = param_values(Some(HashMap::from([("who".to_string(), json!("a@b.c"))]))).unwrap();
        let out = start_flow(&hub, &hit, &values, &[], true, Duration::from_secs(10), 40).await;
        assert!(!out.error && out.text.contains("--who a@b.c"), "{}", out.text);

        assert_eq!(param_values(Some(HashMap::from([("n".to_string(), json!(3)), ("v".to_string(), json!(true)), ("z".to_string(), json!(null))]))).unwrap(), HashMap::from([("n".to_string(), "3".to_string()), ("v".to_string(), "true".to_string()), ("z".to_string(), String::new())]));
        assert!(param_values(Some(HashMap::from([("l".to_string(), json!(["a"]))]))).is_err());
    }

    #[test]
    fn the_guide_names_the_folders_spawner_scans_and_the_listing_hints_until_scripts_exist() {
        let guide = script_guide(&[Root { path: "C:/umbler".into(), label: None }]);
        assert!(guide.contains("spawner.json") && guide.ends_with("C:/umbler"), "{guide}");
        assert!(script_guide(&[]).contains("the user adds one in the Spawner window"));

        let groups = groups();
        let listed = list_json(&groups, &HashMap::new(), &HashMap::new(), None, false);
        assert!(listed["hint"].as_str().unwrap().contains("hub_script_guide"));
        let mut with_scripts = groups;
        with_scripts[0].scripts = true;
        assert!(list_json(&with_scripts, &HashMap::new(), &HashMap::new(), None, false).get("hint").is_none());
    }

    #[tokio::test]
    async fn starting_a_task_waits_for_its_exit_and_reports_the_code_and_log() {
        let (hub, hit) = hub_with(&cmd_task("echo compiling&& exit 2"));
        let out = start_flow(&hub, &hit, &HashMap::new(), &[], true, Duration::from_secs(10), 40).await;
        assert!(out.error, "a nonzero exit is an error result");
        assert!(out.text.contains("exited (code 2)") && out.text.contains("compiling"), "{}", out.text);

        let (hub, hit) = hub_with(&cmd_task("echo fine"));
        let out = start_flow(&hub, &hit, &HashMap::new(), &[], true, Duration::from_secs(10), 40).await;
        assert!(!out.error && out.text.contains("exited (code 0)") && out.text.contains("fine"), "{}", out.text);
    }

    #[tokio::test]
    async fn a_task_still_running_at_the_timeout_is_not_reported_as_up() {
        let (hub, hit) = hub_with(&cmd_task("ping -n 30 127.0.0.1 >nul"));
        let out = start_flow(&hub, &hit, &HashMap::new(), &[], true, Duration::from_secs(1), 40).await;
        assert!(!out.error && out.text.contains("still running after"), "{}", out.text);
        assert!(!out.text.contains("localhost"), "{}", out.text);
        hub.stop_all();
        wait_for(&hub, &hit.instance, Duration::from_secs(10), |s| !s.is_active()).await;
    }

    #[test]
    fn the_app_list_shows_kind_and_mode() {
        let mut task = app("job");
        task.kind = "custom".into();
        task.mode = AppMode::Task;
        let project = Project { id: "p".into(), repo: "r".into(), path: "p".into(), branch: None, apps: vec![app("web"), task] };
        let group = Group { id: "g".into(), label: "g".into(), root: None, root_id: "r".into(), root_path: "r".into(), main: false, scripts: false, projects: vec![project] };
        let json = list_json(&[group], &HashMap::new(), &HashMap::new(), None, false);
        let apps = &json["worktrees"][0]["projects"][0]["apps"];
        assert_eq!((apps[0]["kind"].as_str(), apps[0]["mode"].as_str()), (Some("dotnet-run"), Some("service")));
        assert_eq!((apps[1]["kind"].as_str(), apps[1]["mode"].as_str()), (Some("custom"), Some("task")));
    }

    #[test]
    fn the_app_list_shows_a_learned_port_as_the_url_unless_the_app_has_a_fixed_one() {
        let mut dev = app("dev");
        dev.learn_port = true;
        let mut fixed = app("fixed");
        fixed.port = Some(7398);
        let project = Project { id: "p".into(), repo: "r".into(), path: "p".into(), branch: None, apps: vec![dev.clone(), fixed.clone()] };
        let group = Group { id: "g".into(), label: "g".into(), root: None, root_id: "r".into(), root_path: "r".into(), main: false, scripts: false, projects: vec![project] };
        let learned = HashMap::from([(instance_id("p", &dev.id), 5173), (instance_id("p", &fixed.id), 9999)]);
        let json = list_json(std::slice::from_ref(&group), &HashMap::new(), &learned, None, false);
        let apps = &json["worktrees"][0]["projects"][0]["apps"];
        assert_eq!((apps[0]["port"].as_u64(), apps[0]["url"].as_str()), (Some(5173), Some("http://localhost:5173")));
        assert_eq!((apps[1]["port"].as_u64(), apps[1]["url"].as_str()), (Some(7398), Some("http://localhost:7398")), "the fixed port wins");
        let none = list_json(&[group], &HashMap::new(), &HashMap::new(), None, false);
        assert_eq!(none["worktrees"][0]["projects"][0]["apps"][0]["url"], Value::Null);
    }

    fn port_1420_is_busy() -> bool {
        ["127.0.0.1:1420", "[::1]:1420"]
            .iter()
            .any(|a| std::net::TcpStream::connect_timeout(&a.parse().unwrap(), Duration::from_millis(300)).is_ok())
    }

    /// Starts one of this repo's own detected apps through the MCP tools, checks the URL it learned, then stops it
    /// and checks that nothing is left holding port 1420. Returns what `hub_start` reported.
    async fn run_this_repo_app_through_mcp(app_id: &str) -> String {
        assert!(!port_1420_is_busy(), "something already listens on 1420 (a running `pnpm dev` or `pnpm tauri dev`?)");
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_string_lossy().replace('\\', "/");
        let apps = crate::detect::discover_apps(std::path::Path::new(&repo));
        let app = apps.iter().find(|a| a.id == app_id).unwrap_or_else(|| panic!("{app_id} is not detected: {apps:?}")).clone();

        let hub = Hub::new(Vec::new(), |_| {});
        hub.set_groups(vec![Group {
            id: "main".into(),
            label: "main".into(),
            root: None,
            root_id: repo.clone(),
            root_path: repo.clone(),
            main: true,
            scripts: false,
            projects: vec![Project { id: repo.clone(), repo: "umbler-hub".into(), path: repo.clone(), branch: None, apps: vec![app.clone()] }],
        }]);
        let addr = serve(hub.clone(), &[0]).await.unwrap();
        let call = |id: u32, tool: &str, args: String| {
            let body = format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"{tool}","arguments":{args}}}}}"#);
            async move { rpc_over_tcp(addr, "127.0.0.1", &body).await }
        };
        let args = format!(r#"{{"app":"{}","timeout_seconds":300}}"#, app.name);

        let started = call(1, "hub_start", args.clone()).await;
        assert!(started.contains("running (pid") && started.contains("at http://localhost:1420"), "{started}");
        assert_eq!(hub.ports().values().copied().collect::<Vec<_>>(), [1420]);
        assert!(port_1420_is_busy(), "vite is not listening");

        let listed = call(2, "hub_list_apps", r#"{"only_active":true}"#.into()).await;
        assert!(listed.contains("http://localhost:1420"), "{listed}");

        let stopped = call(3, "hub_stop", args).await;
        assert!(stopped.contains("exited"), "{stopped}");
        let freed = Instant::now() + Duration::from_secs(5);
        while port_1420_is_busy() {
            assert!(Instant::now() < freed, "port 1420 is still held after stop: the process tree was not killed");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert!(hub.ports().is_empty(), "the learned port goes with the run");
        started
    }

    #[tokio::test]
    #[ignore = "needs pnpm and this repo's node_modules; runs the repo's own vite dev server on 127.0.0.1:1420 (shares it with the tauri test: use --test-threads=1)"]
    async fn runs_this_repos_vite_dev_server_through_the_mcp_tools_and_stop_frees_its_port() {
        let started = run_this_repo_app_through_mcp("package.json#dev").await;
        assert!(started.contains("Local:"), "{started}");
    }

    #[tokio::test]
    #[ignore = "needs pnpm, Rust and a free 1420 (use --test-threads=1); opens a Spawner window from this repo's target dir (it exits at once if another Spawner is running, single-instance)"]
    async fn runs_this_repos_tauri_dev_through_the_mcp_tools_and_stop_closes_the_window_and_frees_the_port() {
        let started = run_this_repo_app_through_mcp("src-tauri/tauri.conf.json#tauri-dev").await;
        assert!(started.contains("Running `"), "{started}");
        let leftover = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-Process spawner -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*umbler-hub*target*' } | ForEach-Object { $_.Id }"])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&leftover.stdout).trim().is_empty(), "the app window survived stop: {}", String::from_utf8_lossy(&leftover.stdout));
    }

    #[test]
    fn the_ui_json_names_tools_symbolically_and_holds_no_machine_path() {
        let app = crate::detect::dotnet::app_def(crate::detect::dotnet::Flavor::IisExpress, "src/Bill.csproj", "Bill", Some(42318));
        let json = serde_json::to_value(&app).unwrap();
        assert_eq!(json["kind"], "iis-express");
        assert_eq!(json["mode"], "service");
        assert_eq!(json["checkPort"], true);
        assert_eq!(json["steps"][0]["program"], json!({"type": "msbuild"}));
        assert_eq!(json["steps"][1]["program"], json!({"type": "iis-express"}));
        assert_eq!(json["steps"][1]["cwd"], "src");
        assert!(!json.to_string().contains(":\\") && !json.to_string().contains(":/"), "{json}");
    }

    #[test]
    fn candidate_ports_prefer_the_requested_then_saved_then_default_and_end_with_any() {
        let ports = candidate_ports(Some(47_830), Some(50_000));
        assert_eq!(&ports[..3], &[50_000, 47_830, DEFAULT_PORT]);
        assert_eq!(ports.last(), Some(&0));
        assert_eq!(ports.iter().filter(|p| **p == 47_830).count(), 1);
        assert_eq!(candidate_ports(None, None)[0], DEFAULT_PORT);
    }

    #[tokio::test]
    async fn a_busy_port_falls_through_to_the_next_free_one() {
        let busy = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let busy_port = busy.local_addr().unwrap().port();
        let hub = Hub::new(Vec::new(), |_| {});
        let addr = serve(hub, &[busy_port, 0]).await.unwrap();
        assert_ne!(addr.port(), busy_port);
        let reply = rpc_over_tcp(addr, "127.0.0.1", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).await;
        assert!(reply.contains("200 OK"), "{reply}");
    }
}
