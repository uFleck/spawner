use crate::detect;
use crate::discovery::scan_roots;
use crate::roots;
use crate::watch;
use crate::level::{self, classify};
use crate::job::Job;
use crate::model::*;
use crate::worktree;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

const LOG_CAP: usize = 50_000;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub enum HubEvent {
    State(StateEvent),
    Log(LogLine),
    Port(PortEvent),
    Groups(Vec<Group>),
}

#[derive(Debug, Clone)]
pub struct Step {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub ready: Vec<String>,
    /// Read the service's port from the first local URL in its output (`find_local_port`).
    pub learn_port: bool,
    /// The checkout the app belongs to. Build steps of apps in the same checkout run one at a time, since apps of one
    /// solution build the projects they share into the same `obj` and `bin` folders.
    pub checkout: PathBuf,
}

struct Live {
    state: InstanceState,
    stop: Option<oneshot::Sender<()>>,
    /// Read from the instance's own output, so a dev server that picks its port still has a URL. Gone with the run.
    port: Option<u16>,
}

pub struct Hub {
    roots: Mutex<Vec<Root>>,
    roots_file: OnceLock<PathBuf>,
    /// `watch::key`s of the apps that run under `dotnet watch`.
    watched: Mutex<BTreeSet<String>>,
    watch_file: OnceLock<PathBuf>,
    groups: Mutex<Vec<Group>>,
    live: Mutex<HashMap<String, Live>>,
    logs: Mutex<VecDeque<LogLine>>,
    last_level: Mutex<HashMap<String, Level>>,
    /// One lock per checkout, held while any of its apps builds.
    builds: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
    seq: AtomicU64,
    job: Job,
    emit: Box<dyn Fn(HubEvent) + Send + Sync>,
}

#[derive(Clone)]
struct Ctx {
    hub: Arc<Hub>,
    id: String,
}

enum StepEnd {
    Exited(Option<i32>),
    Stopped,
    SpawnFailed(String),
}

impl Hub {
    pub fn new(roots: Vec<Root>, emit: impl Fn(HubEvent) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            roots: Mutex::new(roots),
            roots_file: OnceLock::new(),
            watched: Mutex::new(BTreeSet::new()),
            watch_file: OnceLock::new(),
            groups: Mutex::new(Vec::new()),
            live: Mutex::new(HashMap::new()),
            logs: Mutex::new(VecDeque::new()),
            last_level: Mutex::new(HashMap::new()),
            builds: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(1),
            job: Job::new(),
            emit: Box::new(emit),
        })
    }

    pub fn set_groups(&self, groups: Vec<Group>) {
        *self.groups.lock().unwrap() = groups;
    }

    pub fn groups(&self) -> Vec<Group> {
        self.groups.lock().unwrap().clone()
    }

    pub fn roots(&self) -> Vec<Root> {
        self.roots.lock().unwrap().clone()
    }

    /// Where `add_root` and `remove_root` save the list. Without it they only change memory.
    pub fn persist_roots_to(&self, file: PathBuf) {
        let _ = self.roots_file.set(file);
    }

    /// Reads which apps are watched from `file` and saves later changes there. Without it they only change memory.
    pub fn persist_watch_to(&self, file: PathBuf) {
        *self.watched.lock().unwrap() = watch::load(&file);
        let _ = self.watch_file.set(file);
    }

    /// The `watch::key`s of the watched apps.
    pub fn watched(&self) -> Vec<String> {
        self.watched.lock().unwrap().iter().cloned().collect()
    }

    /// Watches or stops watching an app of `repo`. It takes effect the next time the app starts. Saves before
    /// committing, like `change_roots`.
    pub fn set_watch(&self, repo: &str, app_id: &str, on: bool) -> Result<Vec<String>, String> {
        let key = watch::key(repo, app_id);
        let mut watched = self.watched.lock().unwrap();
        let mut next = watched.clone();
        if on {
            next.insert(key);
        } else {
            next.remove(&key);
        }
        if let Some(file) = self.watch_file.get() {
            watch::save(file, &next)?;
        }
        *watched = next;
        Ok(watched.iter().cloned().collect())
    }

    pub fn add_root(&self, path: &str, label: Option<String>) -> Result<Vec<Root>, String> {
        self.change_roots(|current| roots::add(current, path, label))
    }

    pub fn remove_root(&self, path: &str) -> Result<Vec<Root>, String> {
        self.change_roots(|current| Ok(roots::remove(current, path)))
    }

    /// Saves before committing, so a failed write leaves memory and disk agreeing.
    fn change_roots(&self, change: impl FnOnce(&[Root]) -> Result<Vec<Root>, String>) -> Result<Vec<Root>, String> {
        let mut current = self.roots.lock().unwrap();
        let next = change(&current)?;
        if let Some(file) = self.roots_file.get() {
            roots::save(file, &next)?;
        }
        *current = next.clone();
        Ok(next)
    }

    pub async fn rescan(self: &Arc<Self>) -> Vec<Group> {
        let configured = self.roots();
        let groups = tauri::async_runtime::spawn_blocking(move || scan_roots(&configured)).await.unwrap_or_default();
        self.set_groups(groups.clone());
        (self.emit)(HubEvent::Groups(groups.clone()));
        groups
    }

    /// Concludes a task: removes each of its worktrees from disk with git (the branches stay), drops the task folder
    /// when that leaves it empty, and rescans so it leaves the list. Refused for the main checkouts, for anything that
    /// is not a linked worktree, and while one of its apps is running (a running app holds its folder open).
    /// Every worktree is tried; the ones git refused (modified files without `force`) come back in the report next to
    /// the ones that were removed, which `restore` can bring back.
    pub async fn conclude(self: &Arc<Self>, group_id: &str, force: bool) -> Result<worktree::Concluded, String> {
        let group = self.groups.lock().unwrap().iter().find(|g| g.id == group_id).cloned().ok_or("unknown worktree")?;
        if group.main {
            return Err("the main checkouts cannot be concluded".into());
        }
        if let Some(p) = group.projects.iter().find(|p| !worktree::is_linked(Path::new(&p.path))) {
            return Err(format!("{} is not a linked git worktree", p.path));
        }
        let running: Vec<String> = {
            let live = self.live.lock().unwrap();
            group
                .projects
                .iter()
                .flat_map(|p| p.apps.iter().map(move |a| (p, a)))
                .filter(|(p, a)| live.get(&instance_id(&p.id, &a.id)).is_some_and(|l| l.state.is_active()))
                .map(|(p, a)| format!("{} ({})", a.name, p.repo))
                .collect()
        };
        if !running.is_empty() {
            return Err(format!("stop {} first", running.join(", ")));
        }
        let task_folder = group.root.clone();
        let report = tauri::async_runtime::spawn_blocking(move || {
            let mut report = worktree::Concluded::default();
            for p in &group.projects {
                match worktree::remove(Path::new(&p.path), force) {
                    Ok(removed) => report.removed.push(removed),
                    Err(reason) => {
                        let needs_force = reason.contains("--force");
                        report.refused.push(worktree::Refused { repo: p.repo.clone(), reason, needs_force });
                    }
                }
            }
            if let Some(folder) = task_folder.filter(|_| report.refused.is_empty()) {
                let _ = std::fs::remove_dir(folder);
            }
            report
        })
        .await
        .map_err(|e| e.to_string())?;
        self.rescan().await;
        Ok(report)
    }

    /// Undoes a conclusion: checks the worktrees out again, then rescans so the task is listed. Every one is tried;
    /// the ones that could not be restored are named in the error.
    pub async fn restore(self: &Arc<Self>, removed: Vec<worktree::Removed>) -> Result<(), String> {
        let failures = tauri::async_runtime::spawn_blocking(move || {
            removed
                .iter()
                .filter_map(|r| worktree::restore(r).err().map(|e| format!("{}: {e}", r.repo)))
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| e.to_string())?;
        self.rescan().await;
        if failures.is_empty() { Ok(()) } else { Err(failures.join("\n")) }
    }

    /// The name of the script behind this instance, or none when it is not a script from a `spawner.json`.
    pub fn script_name(&self, instance: &str) -> Option<String> {
        let groups = self.groups.lock().unwrap();
        groups
            .iter()
            .filter(|g| g.scripts)
            .flat_map(|g| &g.projects)
            .find_map(|p| p.apps.iter().find(|a| instance_id(&p.id, &a.id) == instance).map(|a| a.name.clone()))
    }

    pub fn last_seq(&self) -> u64 {
        self.seq.load(Ordering::Relaxed) - 1
    }

    /// A hub-authored line in an instance's log, for actions that did not come from the UI.
    pub fn note(&self, instance: &str, text: impl Into<String>) {
        self.push_log(instance, Stream::Sys, text.into());
    }

    pub fn states(&self) -> HashMap<String, InstanceState> {
        self.live.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.state.clone())).collect()
    }

    /// The port each active instance was seen listening on, for instances that learn theirs.
    pub fn ports(&self) -> HashMap<String, u16> {
        self.live.lock().unwrap().iter().filter_map(|(k, v)| v.port.map(|p| (k.clone(), p))).collect()
    }

    pub fn port_of(&self, id: &str) -> Option<u16> {
        self.live.lock().unwrap().get(id).and_then(|l| l.port)
    }

    /// Keeps the first port an active instance reports: later local URLs in its output are usually other services.
    fn learn_port(&self, id: &str, port: u16) {
        {
            let mut live = self.live.lock().unwrap();
            match live.get_mut(id) {
                Some(l) if l.state.is_active() && l.port.is_none() => l.port = Some(port),
                _ => return,
            }
        }
        (self.emit)(HubEvent::Port(PortEvent { id: id.to_string(), port: Some(port) }));
    }

    pub fn logs_since(&self, since: u64) -> Vec<LogLine> {
        self.logs.lock().unwrap().iter().filter(|l| l.seq > since).cloned().collect()
    }

    pub fn clear_logs(&self, instance: Option<&str>) {
        let mut logs = self.logs.lock().unwrap();
        match instance {
            Some(id) => logs.retain(|l| l.instance != id),
            None => logs.clear(),
        }
        drop(logs);
        self.forget_finished(instance);
    }

    /// Drops the Failed/Exited state of one instance (or all) so it reads as idle again; active ones are left alone.
    fn forget_finished(&self, instance: Option<&str>) {
        let forgotten: Vec<String> = {
            let mut live = self.live.lock().unwrap();
            let ids: Vec<String> = live
                .iter()
                .filter(|(k, v)| !v.state.is_active() && instance.is_none_or(|id| id == k.as_str()))
                .map(|(k, _)| k.clone())
                .collect();
            for id in &ids {
                live.remove(id);
            }
            ids
        };
        for id in forgotten {
            (self.emit)(HubEvent::State(StateEvent { id, state: InstanceState::Idle }));
        }
    }

    /// An indented line is the body of the entry above it (.NET console puts the message under its `warn:` header,
    /// and stack frames under the exception, node prints stack frames under its error), so it takes that entry's level,
    /// unless it states a level of its own (cargo and tauri indent their `Compiling`/`Finished` progress lines and
    /// their `Error`/`Warn` lines alike). This and `level::classify` apply to every app; a technology whose indented
    /// output is not a continuation (a table, a pretty-printed object) would need the app's `kind` passed in here.
    fn level_for(&self, instance: &str, stream: Stream, text: &str) -> Level {
        let mut last = self.last_level.lock().unwrap();
        let level = match last.get(instance) {
            Some(prev) if stream != Stream::Sys && text.starts_with("   ") && level::marked(text).is_none() => *prev,
            _ => classify(stream, text),
        };
        if stream != Stream::Sys {
            last.insert(instance.to_string(), level);
        }
        level
    }

    fn push_log(&self, instance: &str, stream: Stream, text: String) {
        let line = LogLine {
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            instance: instance.to_string(),
            ts: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
            stream,
            level: self.level_for(instance, stream, &text),
            text,
        };
        {
            let mut logs = self.logs.lock().unwrap();
            if logs.len() >= LOG_CAP {
                logs.pop_front();
            }
            logs.push_back(line.clone());
        }
        (self.emit)(HubEvent::Log(line));
    }

    fn set_state(&self, id: &str, state: InstanceState) {
        let mut forgot_port = false;
        {
            let mut live = self.live.lock().unwrap();
            if let Some(l) = live.get_mut(id) {
                l.state = state.clone();
                if !state.is_active() {
                    forgot_port = l.port.take().is_some();
                }
            }
        }
        (self.emit)(HubEvent::State(StateEvent { id: id.to_string(), state }));
        if forgot_port {
            (self.emit)(HubEvent::Port(PortEvent { id: id.to_string(), port: None }));
        }
    }

    fn mark_running(&self, id: &str, pid: u32) {
        let promote = matches!(
            self.live.lock().unwrap().get(id).map(|l| &l.state),
            Some(InstanceState::Starting)
        );
        if promote {
            self.set_state(id, InstanceState::Running { pid });
        }
    }

    /// Starts an app. `force` kills whatever is listening on the app's port first, for the "use anyway" answer to a busy port.
    ///
    /// For a script, `values` fill its declared params (a missing required one is refused here, before
    /// anything runs), and `extra` arguments are added after them. Only scripts take either.
    pub fn start_with(self: &Arc<Self>, project_id: &str, app_id: &str, force: bool, values: &HashMap<String, String>, extra: &[String]) -> Result<(), String> {
        let (project, mut app) = self.find_app(project_id, app_id).ok_or("unknown app")?;
        if self.watched.lock().unwrap().contains(&watch::key(&project.repo, &app.id)) {
            watch::watching(&mut app);
        }
        if app.kind == detect::scripts::KIND {
            let mut tail = detect::scripts::build_args(&app.params, values).map_err(|e| format!("{}: {e}", app.name))?;
            tail.extend(extra.iter().cloned());
            if let Some(step) = app.steps.last_mut() {
                step.args.extend(tail);
            }
        } else if !values.is_empty() || !extra.is_empty() {
            return Err(format!("{} takes no extra arguments; only scripts declared in a spawner.json do", app.name));
        }
        let id = instance_id(project_id, app_id);
        if self.live.lock().unwrap().get(&id).is_some_and(|l| l.state.is_active()) {
            return Err("already running".into());
        }
        let left_running = match app.port.filter(|_| force && app.check_port) {
            Some(port) => free_port(port)?,
            None => {
                preflight(&app)?;
                Vec::new()
            }
        };
        let plan = launch_plan(Path::new(&project.path), &app)?;
        let (tx, rx) = oneshot::channel();
        self.live
            .lock()
            .unwrap()
            .insert(id.clone(), Live { state: InstanceState::Building, stop: Some(tx), port: None });
        self.set_state(&id, InstanceState::Building);
        for holder in left_running {
            self.note(&id, format!("{holder} holds the port and cannot be stopped; starting anyway"));
        }
        let ctx = Ctx { hub: self.clone(), id };
        tauri::async_runtime::spawn(run_plan(ctx, plan, rx));
        Ok(())
    }

    pub fn stop(&self, id: &str) -> Result<(), String> {
        let sender = {
            let mut live = self.live.lock().unwrap();
            let l = live.get_mut(id).ok_or("not running")?;
            if !l.state.is_active() {
                drop(live);
                self.forget_finished(Some(id));
                return Ok(());
            }
            l.stop.take()
        };
        self.set_state(id, InstanceState::Stopping);
        if let Some(tx) = sender {
            let _ = tx.send(());
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.live.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }

    fn find_app(&self, project_id: &str, app_id: &str) -> Option<(Project, AppDef)> {
        let groups = self.groups.lock().unwrap();
        groups.iter().flat_map(|g| &g.projects).find(|p| p.id == project_id).and_then(|p| {
            p.apps.iter().find(|a| a.id == app_id).map(|a| (p.clone(), a.clone()))
        })
    }
}

impl Ctx {
    fn log(&self, stream: Stream, text: impl Into<String>) {
        self.hub.push_log(&self.id, stream, text.into());
    }

    fn sys(&self, text: impl Into<String>) {
        self.log(Stream::Sys, text);
    }
}

async fn run_plan(ctx: Ctx, plan: Vec<Step>, mut stop_rx: oneshot::Receiver<()>) {
    let last = plan.len().saturating_sub(1);
    for (i, step) in plan.iter().enumerate() {
        let service = i == last;
        ctx.hub.set_state(&ctx.id, if service { InstanceState::Starting } else { InstanceState::Building });
        let _build_turn = if service {
            None
        } else {
            match wait_for_build_turn(&ctx, &step.checkout, &mut stop_rx).await {
                Some(turn) => Some(turn),
                None => {
                    ctx.sys("stopped");
                    ctx.hub.set_state(&ctx.id, InstanceState::Exited { code: None });
                    return;
                }
            }
        };
        ctx.sys(format!("> {} {}", step.program.display(), step.args.join(" ")));
        let started = Instant::now();
        match run_step(&ctx, step, service, &mut stop_rx).await {
            StepEnd::Stopped => {
                ctx.sys("stopped");
                ctx.hub.set_state(&ctx.id, InstanceState::Exited { code: None });
                return;
            }
            StepEnd::SpawnFailed(err) => {
                ctx.sys(format!("failed to start: {err}"));
                ctx.hub.set_state(&ctx.id, InstanceState::Failed { message: err });
                return;
            }
            StepEnd::Exited(Some(0)) if !service => {
                ctx.sys(format!("build ok ({:.1}s)", started.elapsed().as_secs_f32()));
            }
            StepEnd::Exited(code) if !service => {
                ctx.sys(format!("build failed (exit code {code:?})"));
                ctx.hub.set_state(
                    &ctx.id,
                    InstanceState::Failed { message: format!("build failed (exit code {code:?})") },
                );
                return;
            }
            StepEnd::Exited(code) => {
                ctx.sys(format!("exited (code {code:?})"));
                ctx.hub.set_state(&ctx.id, InstanceState::Exited { code });
                return;
            }
        }
    }
}

/// Waits until no other app of the checkout is building. `None` when the app was stopped while it waited.
async fn wait_for_build_turn(
    ctx: &Ctx,
    checkout: &Path,
    stop_rx: &mut oneshot::Receiver<()>,
) -> Option<tokio::sync::OwnedMutexGuard<()>> {
    let lock = ctx.hub.builds.lock().unwrap().entry(checkout.to_path_buf()).or_default().clone();
    if let Ok(turn) = lock.clone().try_lock_owned() {
        return Some(turn);
    }
    ctx.sys("waiting for another build in this checkout to finish");
    tokio::select! {
        turn = lock.lock_owned() => Some(turn),
        _ = stop_rx => None,
    }
}

async fn run_step(
    ctx: &Ctx,
    step: &Step,
    service: bool,
    stop_rx: &mut oneshot::Receiver<()>,
) -> StepEnd {
    let mut cmd = Command::new(&step.program);
    cmd.args(&step.args)
        .current_dir(&step.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return StepEnd::SpawnFailed(format!("{} was not found (is it installed and on PATH?)", step.program.display()));
        }
        Err(e) => return StepEnd::SpawnFailed(e.to_string()),
    };
    let pid = child.id().unwrap_or(0);
    #[cfg(windows)]
    if service {
        if let Some(handle) = child.raw_handle() {
            ctx.hub.job.assign(handle);
        }
    }
    if service && step.ready.is_empty() {
        ctx.hub.set_state(&ctx.id, InstanceState::Running { pid });
    }

    let ready = if service { step.ready.clone() } else { Vec::new() };
    let learn = service && step.learn_port;
    let out = tokio::spawn(pump(child.stdout.take().unwrap(), Stream::Out, ctx.clone(), ready.clone(), learn, pid));
    let err = tokio::spawn(pump(child.stderr.take().unwrap(), Stream::Err, ctx.clone(), ready, learn, pid));

    let end = tokio::select! {
        status = child.wait() => StepEnd::Exited(status.ok().and_then(|s| s.code())),
        _ = stop_rx => {
            kill_tree(pid).await;
            let _ = child.wait().await;
            StepEnd::Stopped
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        let _ = out.await;
        let _ = err.await;
    })
    .await;
    end
}

async fn pump<R: AsyncRead + Unpin>(
    reader: R,
    stream: Stream,
    ctx: Ctx,
    ready: Vec<String>,
    learn_port: bool,
    pid: u32,
) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = strip_ansi(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']));
        if let Some(port) = learn_port.then(|| find_local_port(&text)).flatten() {
            ctx.hub.learn_port(&ctx.id, port);
        }
        if ready.iter().any(|m| text.contains(m.as_str())) {
            ctx.hub.mark_running(&ctx.id, pid);
        }
        ctx.log(stream, text);
    }
}

/// The port in the first `http(s)://localhost:PORT`-style URL on the line, for dev servers that print where they
/// listen (`Local: http://localhost:5173/`). Loopback and wildcard hosts only, so a URL of some other machine is
/// never taken for the service's own port.
pub fn find_local_port(text: &str) -> Option<u16> {
    static CELL: OnceLock<regex::Regex> = OnceLock::new();
    let re = CELL.get_or_init(|| {
        regex::Regex::new(r"https?://(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)").expect("valid local url pattern")
    });
    re.captures_iter(text).find_map(|c| c[1].parse::<u16>().ok().filter(|p| *p != 0))
}

async fn kill_tree(pid: u32) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let _ = cmd.status().await;
}

pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for n in chars.by_ref() {
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn port_in_use(port: u16) -> bool {
    [SocketAddr::from(([127, 0, 0, 1], port)), SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port))]
        .iter()
        .any(|addr| TcpStream::connect_timeout(addr, Duration::from_millis(300)).is_ok())
}

/// Process ids listening on `port`, read from `netstat`. Loopback and wildcard addresses of both IP versions.
fn listeners_on(port: u16) -> Vec<u32> {
    let mut cmd = std::process::Command::new("netstat");
    cmd.args(["-ano", "-p", "TCP"]);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, CREATE_NO_WINDOW);
    let Ok(out) = cmd.output() else { return Vec::new() };
    let suffix = format!(":{port}");
    let mut pids: Vec<u32> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            match cols[..] {
                [_, local, _, "LISTENING", pid] if local.ends_with(&suffix) => pid.parse().ok(),
                _ => None,
            }
        })
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

/// Image name of a process, for messages.
fn process_name(pid: u32) -> String {
    let mut cmd = std::process::Command::new("tasklist");
    cmd.args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, CREATE_NO_WINDOW);
    let out = cmd.output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let name = out.trim().split("\",\"").next().unwrap_or("").trim_matches('"').to_string();
    if name.is_empty() { format!("PID {pid}") } else { format!("{name} (PID {pid})") }
}

/// Kills whatever listens on `port`. Listeners that cannot be stopped (system services, `netsh` port proxies run by
/// svchost, processes of another user) are left alone and returned by name, so the caller can start regardless.
fn free_port(port: u16) -> Result<Vec<String>, String> {
    let own = std::process::id();
    let mut left = Vec::new();
    for pid in listeners_on(port) {
        if pid == own {
            return Err(format!("port {port} is held by Spawner itself"));
        }
        let mut stopped = false;
        if pid > 4 {
            let mut cmd = std::process::Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
            #[cfg(windows)]
            std::os::windows::process::CommandExt::creation_flags(&mut cmd, CREATE_NO_WINDOW);
            stopped = cmd.status().is_ok_and(|s| s.success());
        }
        if !stopped {
            left.push(process_name(pid));
        }
    }
    if left.is_empty() {
        let deadline = Instant::now() + Duration::from_secs(5);
        while port_in_use(port) {
            if Instant::now() >= deadline {
                return Err(format!("port {port} is still in use after stopping its process"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    Ok(left)
}

/// Checks that run before anything is spawned. Only apps that ask for it (`check_port`) are held back by a busy port.
fn preflight(app: &AppDef) -> Result<(), String> {
    match app.port.filter(|_| app.check_port) {
        Some(port) if port_in_use(port) => {
            Err(format!("port {port} is already in use (is Visual Studio or another instance running it?)"))
        }
        _ => Ok(()),
    }
}

/// Turns an app's launch spec into the commands to run. Arguments are filled in first and programs located after,
/// so a missing port is reported before a missing tool, and any of them before anything runs.
pub fn launch_plan(project: &Path, app: &AppDef) -> Result<Vec<Step>, String> {
    if app.steps.is_empty() {
        return Err(app.description.clone().unwrap_or_else(|| format!("{} has no launch steps", app.name)));
    }
    let filled = app
        .steps
        .iter()
        .map(|spec| {
            let cwd = step_cwd(project, &spec.cwd);
            let args = spec.args.iter().map(|a| fill(a, &cwd, app)).collect::<Result<Vec<_>, _>>()?;
            Ok((cwd, args))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let task = app.mode == AppMode::Task;
    app.steps
        .iter()
        .zip(filled)
        .map(|(spec, (cwd, args))| {
            Ok(Step {
                program: detect::resolve(&spec.program)?,
                args,
                cwd,
                ready: if task { Vec::new() } else { spec.ready.clone() },
                learn_port: app.learn_port && !task && app.port.is_none(),
                checkout: project.to_path_buf(),
            })
        })
        .collect()
}

fn step_cwd(project: &Path, cwd: &str) -> PathBuf {
    match cwd {
        "" | "." => project.to_path_buf(),
        abs if Path::new(abs).is_absolute() => PathBuf::from(abs),
        rel => project.join(rel),
    }
}

fn fill(arg: &str, cwd: &Path, app: &AppDef) -> Result<String, String> {
    // Paths here mix `/` (from the stored roots) and `\`, and IIS Express serves nothing but empty 404s for such a /path.
    let shown = cwd.display().to_string();
    let arg = arg.replace("{cwd}", &if cfg!(windows) { shown.replace('/', "\\") } else { shown });
    if !arg.contains("{port}") {
        return Ok(arg);
    }
    let port = app.port.ok_or_else(|| format!("{} needs a port to start, but none was found for it", app.name))?;
    Ok(arg.replace("{port}", &port.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn collector() -> (Arc<Hub>, Arc<StdMutex<Vec<String>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let sink = seen.clone();
        let hub = Hub::new(Vec::new(), move |e| {
            let label = match e {
                HubEvent::State(s) => format!("state:{:?}", s.state),
                HubEvent::Log(l) => format!("log:{:?}:{}", l.stream, l.text),
                HubEvent::Groups(_) => "groups".to_string(),
                HubEvent::Port(p) => format!("port:{:?}", p.port),
            };
            sink.lock().unwrap().push(label);
        });
        (hub, seen)
    }

    fn register(hub: &Arc<Hub>, id: &str) -> (Ctx, oneshot::Sender<()>, oneshot::Receiver<()>) {
        let (tx, rx) = oneshot::channel();
        hub.live.lock().unwrap().insert(id.into(), Live { state: InstanceState::Building, stop: None, port: None });
        (Ctx { hub: hub.clone(), id: id.into() }, tx, rx)
    }

    fn cmd_step(script: &str, ready: &[&str]) -> Step {
        Step {
            program: "cmd.exe".into(),
            args: vec!["/c".into(), script.into()],
            cwd: std::env::temp_dir(),
            ready: ready.iter().map(|r| r.to_string()).collect(),
            learn_port: false,
            checkout: "C:/dev/shared".into(),
        }
    }

    /// An app defined by hand, with no detector involved: one `cmd.exe /c <script>` step run from the temp dir.
    fn cmd_app(name: &str, mode: AppMode, script: &str, ready: &[&str]) -> AppDef {
        AppDef {
            id: format!("{name}.cmd"),
            name: name.into(),
            project: format!("{name}.cmd"),
            kind: "custom".into(),
            mode,
            port: None,
            check_port: false,
            learn_port: false,
            steps: vec![StepSpec {
                program: Program::path("cmd.exe"),
                args: vec!["/c".into(), script.into()],
                cwd: std::env::temp_dir().to_string_lossy().into_owned(),
                ready: ready.iter().map(|r| r.to_string()).collect(),
            }],
            description: None,
            params: Vec::new(),
        }
    }

    fn listening() -> (std::net::TcpListener, u16) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        (listener, port)
    }

    fn put(hub: &Arc<Hub>, id: &str, state: InstanceState) {
        hub.live.lock().unwrap().insert(id.into(), Live { state, stop: None, port: None });
    }

    #[test]
    fn clearing_logs_forgets_finished_runs_only() {
        let (hub, seen) = collector();
        put(&hub, "failed", InstanceState::Failed { message: "boom".into() });
        put(&hub, "done", InstanceState::Exited { code: Some(1) });
        put(&hub, "up", InstanceState::Running { pid: 1 });
        hub.clear_logs(Some("up"));
        assert!(matches!(hub.states()["failed"], InstanceState::Failed { .. }));
        assert!(matches!(hub.states()["up"], InstanceState::Running { .. }));
        hub.clear_logs(None);
        let states = hub.states();
        assert!(!states.get("failed").is_some_and(InstanceState::is_active));
        assert!(!states.contains_key("failed") && !states.contains_key("done"));
        assert!(matches!(states["up"], InstanceState::Running { .. }));
        assert!(seen.lock().unwrap().iter().any(|s| s == "state:Idle"));
    }

    #[test]
    fn stop_forgets_a_failed_run_and_unknown_ids_still_error() {
        let (hub, _seen) = collector();
        put(&hub, "failed", InstanceState::Failed { message: "boom".into() });
        assert!(hub.stop("failed").is_ok());
        assert!(!hub.states().contains_key("failed"));
        assert!(hub.stop("failed").is_err());
        assert!(hub.stop("nope").is_err());
    }

    #[tokio::test]
    async fn service_streams_output_and_reports_exit_code() {
        let (hub, seen) = collector();
        let (ctx, _tx, rx) = register(&hub, "a");
        run_plan(ctx, vec![cmd_step("echo hello&& exit 3", &["hello"])], rx).await;
        let seen = seen.lock().unwrap().clone();
        assert!(seen.contains(&"log:Out:hello".to_string()), "{seen:?}");
        assert!(seen.iter().any(|s| s.starts_with("state:Running")), "{seen:?}");
        assert_eq!(hub.states()["a"], InstanceState::Exited { code: Some(3) });
    }

    #[tokio::test]
    async fn failing_prep_step_fails_instance_without_starting_service() {
        let (hub, seen) = collector();
        let (ctx, _tx, rx) = register(&hub, "b");
        run_plan(ctx, vec![cmd_step("exit 1", &[]), cmd_step("echo should-not-run", &[])], rx).await;
        assert!(matches!(hub.states()["b"], InstanceState::Failed { .. }));
        assert!(!seen.lock().unwrap().iter().any(|s| s.contains("should-not-run")));
    }

    #[tokio::test]
    async fn apps_of_one_checkout_build_one_at_a_time() {
        let (hub, seen) = collector();
        let (first, _tx1, rx1) = register(&hub, "first");
        let (second, _tx2, rx2) = register(&hub, "second");
        let slow = vec![cmd_step("ping -n 3 127.0.0.1 >nul", &[]), cmd_step("echo first-up", &["first-up"])];
        let quick = vec![cmd_step("exit 0", &[]), cmd_step("echo second-up", &["second-up"])];
        let a = tokio::spawn(run_plan(first, slow, rx1));
        tokio::time::sleep(Duration::from_millis(400)).await;
        let b = tokio::spawn(run_plan(second, quick, rx2));
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(hub.states()["second"], InstanceState::Building);
        assert!(seen.lock().unwrap().iter().any(|s| s.contains("waiting for another build")));
        a.await.unwrap();
        b.await.unwrap();
        assert_eq!(hub.states()["second"], InstanceState::Exited { code: Some(0) });
    }

    #[tokio::test]
    async fn stop_kills_the_whole_process_tree() {
        let (hub, _seen) = collector();
        let (ctx, tx, rx) = register(&hub, "c");
        let task = tokio::spawn(run_plan(ctx, vec![cmd_step("ping -n 60 127.0.0.1 >nul", &[])], rx));
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert!(matches!(hub.states()["c"], InstanceState::Running { .. }));
        tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap();
        assert_eq!(hub.states()["c"], InstanceState::Exited { code: None });
    }

    #[tokio::test]
    #[ignore = "needs C:/dev/bill, MSBuild and IIS Express; run with --ignored"]
    async fn bill_api_builds_serves_and_stops_on_a_spare_port() {
        let app = detect::dotnet::app_def(
            detect::dotnet::Flavor::IisExpress,
            "src/src/UI/Acme.Bill.API/Acme.Bill.API.csproj",
            "Acme.Bill.API",
            Some(42397),
        );
        let plan = launch_plan(Path::new("C:/dev/bill"), &app).unwrap();
        let (hub, seen) = collector();
        let (ctx, tx, rx) = register(&hub, "bill");
        let task = tokio::spawn(run_plan(ctx, plan, rx));

        let deadline = Instant::now() + Duration::from_secs(120);
        while !matches!(hub.states()["bill"], InstanceState::Running { .. }) {
            assert!(Instant::now() < deadline, "never reached Running: {:?}", seen.lock().unwrap());
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        assert!(port_in_use(42397), "iisexpress is not listening");

        tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(15), task).await.unwrap().unwrap();
        assert_eq!(hub.states()["bill"], InstanceState::Exited { code: None });
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!port_in_use(42397), "port still held after stop: process tree not killed");
    }

    #[tokio::test]
    async fn a_hand_built_task_runs_to_its_end_and_reports_the_exit_code() {
        // "ready" patterns mean nothing to a task: the plan drops them, and it is Running as soon as it spawns.
        let app = cmd_app("job", AppMode::Task, "echo working&& exit 3", &["working"]);
        let plan = launch_plan(Path::new("C:/unused"), &app).unwrap();
        assert!(plan[0].ready.is_empty());
        assert_eq!(plan[0].cwd, std::env::temp_dir());

        let (hub, seen) = collector();
        let (ctx, _tx, rx) = register(&hub, "job");
        run_plan(ctx, plan, rx).await;
        let seen = seen.lock().unwrap().clone();
        assert!(seen.iter().any(|s| s.starts_with("state:Running")), "{seen:?}");
        assert!(seen.contains(&"log:Out:working".to_string()), "{seen:?}");
        assert_eq!(hub.states()["job"], InstanceState::Exited { code: Some(3) });
    }

    #[tokio::test]
    async fn starting_a_task_through_the_hub_ends_in_exited() {
        let (hub, _seen) = collector();
        let app = cmd_app("job", AppMode::Task, "exit 0", &[]);
        let project = Project { id: "p".into(), repo: "r".into(), path: std::env::temp_dir().to_string_lossy().into_owned(), branch: None, apps: vec![app.clone()] };
        hub.set_groups(vec![Group { id: "g".into(), label: "g".into(), root: None, root_id: "r".into(), root_path: "r".into(), main: false, scripts: false, projects: vec![project] }]);
        hub.start_with("p", &app.id, false, &HashMap::new(), &[]).unwrap();
        let id = instance_id("p", &app.id);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !hub.states().get(&id).is_some_and(|s| matches!(s, InstanceState::Exited { .. })) {
            assert!(Instant::now() < deadline, "never exited: {:?}", hub.states());
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(hub.states()[&id], InstanceState::Exited { code: Some(0) });
    }

    #[tokio::test]
    async fn concluding_a_task_removes_its_worktrees_and_leaves_the_main_checkout() {
        use crate::testutil::{git, TempDir};
        let tmp = TempDir::new("conclude");
        let shop = tmp.dir("dev/shop");
        tmp.file("dev/shop/Shop.csproj", r#"<Project Sdk="Microsoft.NET.Sdk.Web"></Project>"#);
        git(&shop, &["init", "-q"]);
        git(&shop, &["add", "."]);
        git(&shop, &["commit", "-q", "-m", "init"]);
        tmp.dir("dev/PAYMENT-7");
        let wt = tmp.path().join("dev/PAYMENT-7/shop");
        git(&shop, &["worktree", "add", "-q", "-b", "PAYMENT-7", &wt.to_string_lossy()]);

        let hub = Hub::new(vec![Root { path: tmp.path().join("dev").to_string_lossy().into_owned(), label: None }], |_| {});
        let groups = hub.rescan().await;
        let ids: Vec<_> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["PAYMENT-7", "main"]);

        assert!(hub.conclude("main", true).await.unwrap_err().contains("main checkouts"));
        assert!(hub.conclude("nope", true).await.is_err());

        let app_id = groups[0].projects[0].apps[0].id.clone();
        let project_id = groups[0].projects[0].id.clone();
        put(&hub, &instance_id(&project_id, &app_id), InstanceState::Running { pid: 1 });
        let err = hub.conclude("PAYMENT-7", true).await.unwrap_err();
        assert!(err.contains("stop Shop"), "{err}");
        assert!(wt.exists(), "nothing is removed while an app runs");
        hub.live.lock().unwrap().clear();

        tmp.file("dev/PAYMENT-7/shop/wip.txt", "unsaved");
        let report = hub.conclude("PAYMENT-7", false).await.unwrap();
        assert!(report.removed.is_empty());
        assert_eq!(report.refused.len(), 1);
        assert_eq!(report.refused[0].repo, "shop");
        assert!(report.refused[0].needs_force, "{:?}", report.refused);
        assert!(wt.exists());

        let report = hub.conclude("PAYMENT-7", true).await.unwrap();
        assert!(report.refused.is_empty());
        assert!(!wt.exists());
        assert!(!tmp.path().join("dev/PAYMENT-7").exists(), "the emptied task folder goes too");
        assert!(shop.join("Shop.csproj").exists());
        let ids: Vec<_> = hub.groups().iter().map(|g| g.id.clone()).collect();
        assert_eq!(ids, ["dev"], "with no task left, the checkouts are listed under their folder");

        hub.restore(report.removed).await.unwrap();
        assert!(wt.join("Shop.csproj").exists(), "undo checks the worktree out again");
        let ids: Vec<_> = hub.groups().iter().map(|g| g.id.clone()).collect();
        assert_eq!(ids, ["PAYMENT-7", "main"], "and the task is listed again");
    }

    #[test]
    fn the_port_is_only_checked_when_the_app_asks_for_it() {
        let (_busy, port) = listening();
        let mut app = cmd_app("web", AppMode::Service, "exit 0", &[]);
        app.port = Some(port);
        assert_eq!(preflight(&app), Ok(()), "a busy port does not stop an app that does not check");
        app.check_port = true;
        let err = preflight(&app).unwrap_err();
        assert!(err.contains(&format!("port {port} is already in use")), "{err}");
        app.port = None;
        assert_eq!(preflight(&app), Ok(()), "nothing to check without a port");
        let (free, free_port) = listening();
        drop(free);
        app.port = Some(free_port);
        assert_eq!(preflight(&app), Ok(()), "a free port passes");
    }

    #[test]
    fn forcing_a_port_finds_its_listener_and_never_kills_spawner_itself() {
        let (_busy, port) = listening();
        assert!(listeners_on(port).contains(&std::process::id()));
        let err = free_port(port).unwrap_err();
        assert!(err.contains("Spawner itself"), "{err}");
    }

    #[test]
    fn launch_plan_fills_placeholders_and_keeps_start_time_errors() {
        let project = Path::new("C:/dev/x");
        let mut app = cmd_app("web", AppMode::Service, "exit 0", &["up"]);
        app.steps[0].cwd = "src/Api".into();
        app.steps[0].args = vec!["{cwd}".into(), "--port={port}".into()];
        app.port = Some(8080);
        let plan = launch_plan(project, &app).unwrap();
        assert_eq!(plan[0].cwd, project.join("src/Api"));
        let shown = project.join("src/Api").display().to_string();
        let native = if cfg!(windows) { shown.replace('/', "\\") } else { shown };
        assert_eq!(plan[0].args, [native, "--port=8080".into()]);
        assert_eq!(plan[0].ready, ["up"]);

        app.port = None;
        assert!(launch_plan(project, &app).unwrap_err().contains("needs a port"));
        app.steps.clear();
        assert!(launch_plan(project, &app).unwrap_err().contains("no launch steps"));
    }

    #[test]
    fn an_iis_app_without_a_port_fails_at_start_before_any_tool_is_looked_up() {
        let app = detect::dotnet::app_def(detect::dotnet::Flavor::IisExpress, "Bill.csproj", "Bill", None);
        assert!(launch_plan(Path::new("C:/dev/x"), &app).unwrap_err().contains("needs a port"));
    }

    #[test]
    fn indented_lines_take_the_level_of_the_entry_above() {
        let (hub, _) = collector();
        hub.push_log("a", Stream::Out, "warn: Demo[0]".into());
        hub.push_log("a", Stream::Out, "      demo warning".into());
        hub.push_log("b", Stream::Out, "      lone indented line".into());
        hub.push_log("a", Stream::Out, "info: Demo[0]".into());
        hub.push_log("a", Stream::Sys, "   > hub text".into());
        let levels: Vec<_> = hub.logs_since(0).iter().map(|l| (l.instance.clone(), l.level)).collect();
        assert_eq!(
            levels,
            [("a".into(), Level::Wrn), ("a".into(), Level::Wrn), ("b".into(), Level::Inf), ("a".into(), Level::Inf), ("a".into(), Level::Sys)]
        );
    }

    /// `npm` is a `.cmd` shim on Windows, which a bare-name spawn cannot start; this runs a real script through each
    /// package manager that is installed here.
    #[tokio::test]
    async fn a_package_script_runs_through_whatever_package_manager_is_installed() {
        use detect::node::{Pm, apps};
        let mut ran = 0;
        for pm in [Pm::Npm, Pm::Pnpm] {
            let installed = detect::resolve(&Program::path(pm.program()))
                .ok()
                .and_then(|p| std::process::Command::new(p).arg("--version").output().ok())
                .is_some_and(|o| o.status.success());
            if !installed {
                continue;
            }
            let tmp = crate::testutil::TempDir::new("pm-run");
            tmp.file("package.json", r#"{"name":"demo","scripts":{"build":"node -e \"console.log('built-ok')\""}}"#);
            let manifest = detect::node::read_manifest(&tmp.path().join("package.json")).unwrap();
            let app = apps(&manifest, pm, "", "demo").remove(0);
            let plan = launch_plan(tmp.path(), &app).unwrap();
            let (hub, seen) = collector();
            let (ctx, _tx, rx) = register(&hub, "pm");
            run_plan(ctx, plan, rx).await;
            let seen = seen.lock().unwrap().clone();
            assert!(seen.contains(&"log:Out:built-ok".to_string()), "{pm:?}: {seen:?}");
            assert_eq!(hub.states()["pm"], InstanceState::Exited { code: Some(0) }, "{pm:?}: {seen:?}");
            ran += 1;
        }
        println!("ran through {ran} package manager(s)");
    }

    #[test]
    fn an_indented_line_that_states_its_own_level_keeps_it() {
        let (hub, _) = collector();
        for text in [
            "error[E0432]: unresolved import",
            "  --> src/lib.rs:1:5",
            "   Compiling spawner v0.1.0",
            "        Error The \"beforeDevCommand\" terminated",
            "     Running `target\\debug\\spawner.exe`",
            "    at httpServerStart (file:///x/node.js:1:1)",
        ] {
            hub.push_log("t", Stream::Err, text.into());
        }
        let levels: Vec<_> = hub.logs_since(0).iter().map(|l| l.level).collect();
        assert_eq!(levels, [Level::Err, Level::Err, Level::Inf, Level::Err, Level::Inf, Level::Inf]);
    }

    #[test]
    fn finds_the_port_in_a_local_url() {
        let port = |t: &str| find_local_port(&strip_ansi(t));
        assert_eq!(port("  ➜  Local:   http://localhost:5173/"), Some(5173));
        assert_eq!(port("  ➜  Local:   http://localhost:\u{1b}[1m1420\u{1b}[22m/"), Some(1420), "vite bolds the port");
        assert_eq!(port("started server on 0.0.0.0:3000, url: http://0.0.0.0:3000"), Some(3000));
        assert_eq!(port("Server running at https://127.0.0.1:8443/app"), Some(8443));
        assert_eq!(port("listening on http://[::1]:4200"), Some(4200));
        assert_eq!(port("  ➜  Network: http://192.168.0.7:5173/"), None, "another machine's address is not ours");
        assert_eq!(port("proxy to http://example.com:8080 then http://localhost:9000"), Some(9000));
        assert_eq!(port("http://localhost:99999 http://localhost:0 http://localhost/"), None, "out of range, zero or no port");
        assert_eq!(port("Now listening on: localhost:5003"), None, "a bare host:port without a scheme is not a URL");
    }

    #[tokio::test]
    async fn a_service_that_prints_its_url_gets_that_port_until_it_ends() {
        let (hub, seen) = collector();
        let (ctx, tx, rx) = register(&hub, "dev");
        let mut step = cmd_step("echo   Local:   http://localhost:5173/&& echo other http://localhost:6000&& ping -n 30 127.0.0.1 >nul", &["Local:"]);
        step.learn_port = true;
        let task = tokio::spawn(run_plan(ctx, vec![step], rx));
        let deadline = Instant::now() + Duration::from_secs(10);
        while hub.port_of("dev").is_none() {
            assert!(Instant::now() < deadline, "no port learned: {:?}", seen.lock().unwrap());
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(hub.ports(), HashMap::from([("dev".to_string(), 5173)]), "the first URL wins");

        tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap();
        assert_eq!(hub.port_of("dev"), None, "the port goes with the run");
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.iter().filter(|s| s.starts_with("port:")).collect::<Vec<_>>(), ["port:Some(5173)", "port:None"], "{seen:?}");
    }

    #[test]
    fn only_services_that_ask_to_learn_their_port_do() {
        let mut app = cmd_app("web", AppMode::Service, "exit 0", &[]);
        app.learn_port = true;
        assert!(launch_plan(Path::new("C:/x"), &app).unwrap()[0].learn_port);
        app.port = Some(8080);
        assert!(!launch_plan(Path::new("C:/x"), &app).unwrap()[0].learn_port, "a fixed port is not second-guessed");
        app.port = None;
        app.mode = AppMode::Task;
        assert!(!launch_plan(Path::new("C:/x"), &app).unwrap()[0].learn_port, "a task serves nothing");
        app.mode = AppMode::Service;
        app.learn_port = false;
        assert!(!launch_plan(Path::new("C:/x"), &app).unwrap()[0].learn_port, ".NET apps keep their behavior");
    }

    #[test]
    fn strips_ansi_and_keeps_text() {
        assert_eq!(strip_ansi("\u{1b}[32minfo\u{1b}[0m: ok"), "info: ok");
    }
}
