use serde::{Deserialize, Serialize};

/// How an app lives. A service runs until the user stops it and is "ready" when one of its patterns shows up in its output;
/// a task runs to its own end and reports the exit code.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AppMode {
    #[default]
    Service,
    Task,
}

/// The program a launch step runs. Tools that must be located on the machine are named here and found when the app
/// starts (see `detect::resolve`), so a missing tool is an error at start, and no machine path reaches the UI.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Program {
    /// Looked up on `PATH` like a shell would, or an absolute path.
    Path { name: String },
    Msbuild,
    IisExpress,
}

impl Program {
    pub fn path(name: &str) -> Self {
        Self::Path { name: name.into() }
    }
}

/// One command of a launch plan. Every step but the last prepares the next (a build) and must exit 0;
/// the last one is the app itself.
///
/// `args` may hold `{cwd}` (the resolved working directory) and `{port}` (the app's port; starting fails when
/// the app has none), which are filled in at start time so the spec itself never holds a machine path.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StepSpec {
    pub program: Program,
    pub args: Vec<String>,
    /// Relative to the project folder (`.` for the folder itself), or absolute.
    pub cwd: String,
    /// Output fragments that mean the app is up. Only a service's last step uses them.
    #[serde(default)]
    pub ready: Vec<String>,
}

/// What a script parameter holds: free text, or an on/off switch that adds its flag.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ParamKind {
    #[default]
    Text,
    Flag,
}

/// An argument a script takes, declared in its `spawner.json` so the UI can ask for it (with its `hint`) before the
/// script runs, instead of the user finding out from its failure. See `detect::scripts::build_args` for how values
/// become command-line arguments.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub name: String,
    pub kind: ParamKind,
    /// What to enter, shown under the field.
    pub hint: Option<String>,
    /// An example value, shown inside the empty field.
    pub placeholder: Option<String>,
    /// The option that introduces the value (`--out`). Without one a text value is a positional argument.
    pub flag: Option<String>,
    /// The allowed values, offered as a choice.
    pub options: Vec<String>,
    pub required: bool,
    /// Used when no value is given; for a flag, `"true"` means on.
    pub default: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppDef {
    /// Unique within its project and stable across rescans; the running instance is keyed by it.
    pub id: String,
    pub name: String,
    /// The file the detector found this app in, relative to the project folder.
    pub project: String,
    /// The technology and how it is launched (`dotnet-run`, `iis-express`), shown as a badge.
    pub kind: String,
    pub mode: AppMode,
    pub port: Option<u16>,
    /// Refuse to start while something already listens on `port`.
    pub check_port: bool,
    /// The port is not known up front (a dev server picks its own): read it from the first local URL the running
    /// service prints, and show that. Only meaningful for a service without a fixed `port`.
    pub learn_port: bool,
    pub steps: Vec<StepSpec>,
    /// What a script is for, or what is wrong with its `spawner.json`. Shown next to the app and in `hub_list_apps`.
    pub description: Option<String>,
    /// The arguments a script asks for before it runs. Empty for everything else.
    pub params: Vec<Param>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub repo: String,
    pub path: String,
    pub branch: Option<String>,
    pub apps: Vec<AppDef>,
}

/// A folder the user asked Spawner to scan. Persisted in `roots.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub label: String,
    /// The task folder (`C:/dev/PAYMENT-9986`) when the group is a task whose checkouts all live in it.
    pub root: Option<String>,
    /// The configured scan folder this group came from: a normalized key, and the path as configured.
    pub root_id: String,
    pub root_path: String,
    pub main: bool,
    /// The user's own scripts (declared in a `spawner.json`), which are not part of any worktree.
    pub scripts: bool,
    pub projects: Vec<Project>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum InstanceState {
    /// Never started, or a finished run that was forgotten; only ever sent as an event, `states()` omits it.
    Idle,
    Building,
    Starting,
    Running { pid: u32 },
    Stopping,
    Exited { code: Option<i32> },
    Failed { message: String },
}

impl InstanceState {
    pub fn describe(&self) -> String {
        match self {
            Self::Idle => "idle".into(),
            Self::Building => "building".into(),
            Self::Starting => "starting".into(),
            Self::Running { pid } => format!("running (pid {pid})"),
            Self::Stopping => "stopping".into(),
            Self::Exited { code: Some(c) } => format!("exited (code {c})"),
            Self::Exited { code: None } => "exited".into(),
            Self::Failed { message } => format!("failed: {message}"),
        }
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Building | Self::Starting | Self::Running { .. } | Self::Stopping
        )
    }
}

/// The port a running service turned out to listen on, or `None` once it is gone.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PortEvent {
    pub id: String,
    pub port: Option<u16>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Stream {
    Out,
    Err,
    Sys,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Dbg,
    Inf,
    Wrn,
    Err,
    Sys,
}

impl Level {
    pub fn label(self) -> &'static str {
        match self {
            Self::Dbg => "DBG",
            Self::Inf => "INF",
            Self::Wrn => "WRN",
            Self::Err => "ERR",
            Self::Sys => "HUB",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "debug" | "dbg" | "trace" => Some(Self::Dbg),
            "info" | "inf" => Some(Self::Inf),
            "warn" | "warning" | "wrn" => Some(Self::Wrn),
            "error" | "err" | "fatal" => Some(Self::Err),
            _ => None,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub seq: u64,
    pub instance: String,
    pub ts: u64,
    pub stream: Stream,
    pub level: Level,
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    pub id: String,
    pub state: InstanceState,
}

pub fn instance_id(project_id: &str, app_id: &str) -> String {
    format!("{project_id}::{app_id}")
}
