//! Node: a folder with a `package.json` yields one app per npm script worth running. Dev servers (`dev`, `start`...)
//! are services that are ready when their output says so; one-shot scripts (`build`, `test`...) are tasks. Both
//! run as `<package manager> run <script>` in the package's folder, with the manager picked from the lockfile.
//!
//! A monorepo is not special-cased: every `package.json` the walk meets gets its own set of apps.
//! The `tauri` script is deliberately not listed here: `detect::tauri` owns `tauri dev`, so a Tauri app's `dev`
//! (the web front end alone, when it is a Vite script) and `tauri dev` (the whole desktop app) are two distinct apps.

use super::{Claim, Detector};
use crate::model::{AppDef, AppMode, Program, StepSpec};
use serde_json::Value;
use std::path::Path;

/// Scripts that start something that keeps running. Extend this list to surface more of them.
pub const SERVICE_SCRIPTS: &[&str] = &["dev", "start", "serve", "preview", "storybook"];

/// Scripts that run to their end. Anything not listed here or above is left out, to keep the sidebar quiet.
pub const TASK_SCRIPTS: &[&str] = &["build", "test", "lint", "typecheck", "check", "format", "generate", "migrate"];

/// Output fragments that mean a dev server is up (matched case-sensitively, as a substring).
pub const READY: &[&str] = &[
    "Local:",
    "ready in",
    "Ready in",
    "listening on",
    "Listening on",
    "compiled successfully",
    "Compiled successfully",
    "started server on",
    "Server running",
];

pub struct Node;

impl Detector for Node {
    fn name(&self) -> &'static str {
        "node"
    }

    /// Never claims the folder: a package can sit next to a .NET project or hold a Tauri app.
    fn detect(&self, dir: &Path, root: &Path, out: &mut Vec<AppDef>) -> Claim {
        let Some(manifest) = read_manifest(&dir.join("package.json")) else { return Claim::None };
        let pm = package_manager(dir, root, &manifest);
        out.extend(apps(&manifest, pm, &rel(root, dir), &folder_name(dir)));
        Claim::None
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pm {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

/// Checked in this order within one folder, so a stray `package-lock.json` does not outrank `pnpm-lock.yaml`.
const LOCKFILES: &[(&str, Pm)] = &[
    ("pnpm-lock.yaml", Pm::Pnpm),
    ("package-lock.json", Pm::Npm),
    ("yarn.lock", Pm::Yarn),
    ("bun.lockb", Pm::Bun),
    ("bun.lock", Pm::Bun),
];

impl Pm {
    pub fn program(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
            Self::Yarn => "yarn",
            Self::Bun => "bun",
        }
    }

    /// The arguments that run `script` and pass `extra` to it. npm needs `--` in front of them; the others forward them.
    pub fn run_args(self, script: &str, extra: &[&str]) -> Vec<String> {
        let mut args = vec!["run".to_string(), script.to_string()];
        if self == Self::Npm && !extra.is_empty() {
            args.push("--".into());
        }
        args.extend(extra.iter().map(|a| a.to_string()));
        args
    }

    fn from_field(manifest: &Value) -> Option<Self> {
        let field = manifest.get("packageManager")?.as_str()?;
        match field.split('@').next()? {
            "pnpm" => Some(Self::Pnpm),
            "npm" => Some(Self::Npm),
            "yarn" => Some(Self::Yarn),
            "bun" => Some(Self::Bun),
            _ => None,
        }
    }
}

/// The package manager for the package in `dir`: the lockfile in `dir` or in the nearest folder above it, up to the
/// project folder `root`; else the manifest's `packageManager` field; else npm.
pub fn package_manager(dir: &Path, root: &Path, manifest: &Value) -> Pm {
    let mut current = dir;
    loop {
        if let Some((_, pm)) = LOCKFILES.iter().find(|(file, _)| current.join(file).is_file()) {
            return *pm;
        }
        match current.parent() {
            Some(parent) if current != root && current.starts_with(root) => current = parent,
            _ => break,
        }
    }
    Pm::from_field(manifest).unwrap_or(Pm::Npm)
}

/// The parsed `package.json` when it exists and is a JSON object. A malformed one is skipped, never an error.
pub fn read_manifest(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    value.is_object().then_some(value)
}

/// `dir` relative to the project folder, `/`-separated; empty for the project folder itself.
pub fn rel(root: &Path, dir: &Path) -> String {
    dir.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}

pub fn join_rel(dir: &str, file: &str) -> String {
    if dir.is_empty() { file.to_string() } else { format!("{dir}/{file}") }
}

/// A step's working directory: relative to the project folder, with `.` for the folder itself.
pub fn cwd_of(rel_dir: &str) -> String {
    if rel_dir.is_empty() { ".".into() } else { rel_dir.into() }
}

pub fn folder_name(dir: &Path) -> String {
    dir.file_name().map_or_else(|| "app".into(), |n| n.to_string_lossy().into_owned())
}

/// What the app is built on, shown as its badge. A framework outranks the bundler it happens to use.
pub fn kind_of(manifest: &Value) -> &'static str {
    let has = |name: &str| ["dependencies", "devDependencies"].iter().any(|k| manifest.get(k).and_then(|d| d.get(name)).is_some());
    if has("next") {
        "next"
    } else if has("react-scripts") {
        "react"
    } else if has("vite") {
        "vite"
    } else {
        "node"
    }
}

pub fn package_name(manifest: &Value, folder: &str) -> String {
    manifest.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()).unwrap_or(folder).to_string()
}

pub fn has_script(manifest: &Value, script: &str) -> bool {
    manifest.get("scripts").and_then(|s| s.get(script)).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
}

/// The apps of one package. `rel_dir` is its folder relative to the project folder (empty for the folder itself),
/// and `folder` names it when the manifest has no `name`. Ids are `<path of package.json>#<script>`.
pub fn apps(manifest: &Value, pm: Pm, rel_dir: &str, folder: &str) -> Vec<AppDef> {
    let package = package_name(manifest, folder);
    let kind = kind_of(manifest);
    let manifest_path = join_rel(rel_dir, "package.json");
    let listed = SERVICE_SCRIPTS
        .iter()
        .map(|s| (*s, AppMode::Service))
        .chain(TASK_SCRIPTS.iter().map(|s| (*s, AppMode::Task)));
    listed
        .filter(|(script, _)| has_script(manifest, script))
        .map(|(script, mode)| {
            let service = mode == AppMode::Service;
            AppDef {
                id: format!("{manifest_path}#{script}"),
                name: format!("{package}:{script}"),
                project: manifest_path.clone(),
                kind: kind.into(),
                mode,
                port: None,
                check_port: false,
                learn_port: service,
                steps: vec![StepSpec {
                    program: Program::path(pm.program()),
                    args: pm.run_args(script, &[]),
                    cwd: cwd_of(rel_dir),
                    ready: if service { READY.iter().map(|r| r.to_string()).collect() } else { Vec::new() },
                }],
                description: None,
                params: Vec::new(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use serde_json::json;

    fn by_script<'a>(apps: &'a [AppDef], script: &str) -> &'a AppDef {
        apps.iter().find(|a| a.id.ends_with(&format!("#{script}"))).unwrap_or_else(|| panic!("no {script} app in {apps:?}"))
    }

    #[test]
    fn a_package_yields_services_and_tasks_for_the_scripts_on_the_lists_only() {
        let manifest = json!({
            "name": "web",
            "scripts": {"dev": "vite", "preview": "vite preview", "build": "tsc && vite build", "test": "vitest", "deploy": "x", "postinstall": "y", "tauri": "tauri"},
            "devDependencies": {"vite": "^8"}
        });
        let apps = apps(&manifest, Pm::Pnpm, "web", "web");
        let mut ids: Vec<_> = apps.iter().map(|a| a.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["web/package.json#build", "web/package.json#dev", "web/package.json#preview", "web/package.json#test"]);

        let dev = by_script(&apps, "dev");
        assert_eq!((dev.name.as_str(), dev.kind.as_str(), dev.mode, dev.project.as_str()), ("web:dev", "vite", AppMode::Service, "web/package.json"));
        assert_eq!((dev.port, dev.check_port, dev.learn_port), (None, false, true));
        let [step] = dev.steps.as_slice() else { panic!("one step") };
        assert_eq!(step.program, Program::path("pnpm"));
        assert_eq!((step.args.as_slice(), step.cwd.as_str()), (["run", "dev"].map(String::from).as_slice(), "web"));
        assert_eq!(step.ready, READY);

        let build = by_script(&apps, "build");
        assert_eq!((build.mode, build.learn_port, build.steps[0].ready.is_empty()), (AppMode::Task, false, true));
    }

    #[test]
    fn the_package_folder_names_an_unnamed_package_and_the_project_folder_runs_from_dot() {
        let apps = apps(&json!({"scripts": {"start": "node ."}}), Pm::Npm, "", "my-api");
        assert_eq!((apps[0].id.as_str(), apps[0].name.as_str(), apps[0].kind.as_str()), ("package.json#start", "my-api:start", "node"));
        assert_eq!(apps[0].steps[0].cwd, ".");
        assert_eq!(apps[0].steps[0].program, Program::path("npm"));
    }

    #[test]
    fn empty_and_non_string_scripts_are_not_apps() {
        assert!(apps(&json!({"scripts": {"dev": "", "build": 3, "test": null}}), Pm::Npm, "", "x").is_empty());
        assert!(apps(&json!({"scripts": "nope"}), Pm::Npm, "", "x").is_empty());
        assert!(apps(&json!({"name": "x"}), Pm::Npm, "", "x").is_empty());
    }

    #[test]
    fn the_kind_label_prefers_the_framework_over_the_bundler() {
        let kind = |m: Value| kind_of(&m);
        assert_eq!(kind(json!({"devDependencies": {"vite": "1"}})), "vite");
        assert_eq!(kind(json!({"dependencies": {"vite": "1", "next": "15"}})), "next");
        assert_eq!(kind(json!({"dependencies": {"react-scripts": "5"}})), "react");
        assert_eq!(kind(json!({"dependencies": {"react": "19"}})), "node");
    }

    #[test]
    fn each_manager_runs_a_script_its_own_way() {
        assert_eq!(Pm::Pnpm.run_args("dev", &[]), ["run", "dev"]);
        assert_eq!(Pm::Npm.run_args("tauri", &["dev"]), ["run", "tauri", "--", "dev"]);
        assert_eq!(Pm::Yarn.run_args("tauri", &["dev"]), ["run", "tauri", "dev"]);
        assert_eq!(Pm::Bun.run_args("dev", &[]), ["run", "dev"]);
        assert_eq!([Pm::Npm, Pm::Pnpm, Pm::Yarn, Pm::Bun].map(Pm::program), ["npm", "pnpm", "yarn", "bun"]);
    }

    #[test]
    fn the_package_manager_comes_from_the_nearest_lockfile_inside_the_project() {
        let none = json!({});
        let tmp = TempDir::new("pm");
        let dir = |rel: &str| tmp.dir(rel);
        assert_eq!(package_manager(&dir("empty"), tmp.path(), &none), Pm::Npm, "no lockfile means npm");

        tmp.file("pnpm/pnpm-lock.yaml", "");
        tmp.file("npm/package-lock.json", "");
        tmp.file("yarn/yarn.lock", "");
        tmp.file("bun/bun.lockb", "");
        tmp.file("bun2/bun.lock", "");
        let pm = |rel: &str| package_manager(&dir(rel), tmp.path(), &none);
        assert_eq!([pm("pnpm"), pm("npm"), pm("yarn"), pm("bun"), pm("bun2")], [Pm::Pnpm, Pm::Npm, Pm::Yarn, Pm::Bun, Pm::Bun]);

        tmp.file("both/pnpm-lock.yaml", "");
        tmp.file("both/package-lock.json", "");
        tmp.file("both/yarn.lock", "");
        assert_eq!(pm("both"), Pm::Pnpm, "pnpm outranks the others in one folder");

        tmp.file("mono/pnpm-lock.yaml", "");
        assert_eq!(pm("mono/packages/ui"), Pm::Pnpm, "a package inherits its monorepo's lockfile");
        tmp.file("mono/packages/own/yarn.lock", "");
        assert_eq!(pm("mono/packages/own"), Pm::Yarn, "the nearest lockfile wins");
    }

    #[test]
    fn a_lockfile_above_the_project_folder_is_not_looked_at() {
        let tmp = TempDir::new("pm-above");
        tmp.file("pnpm-lock.yaml", "");
        let project = tmp.dir("proj/app");
        assert_eq!(package_manager(&project, &tmp.path().join("proj"), &json!({})), Pm::Npm);
        assert_eq!(package_manager(&project, &tmp.path().join("proj"), &json!({"packageManager": "yarn@4.1.0"})), Pm::Yarn, "the packageManager field is the fallback");
    }

    #[test]
    fn discovery_reads_package_json_files_and_skips_malformed_ones() {
        let tmp = TempDir::new("discover");
        tmp.file("package.json", r#"{"name":"root","scripts":{"dev":"vite","build":"vite build"},"devDependencies":{"vite":"1"}}"#);
        tmp.file("pnpm-lock.yaml", "");
        tmp.file("packages/api/package.json", "\u{feff}{\"name\":\"api\",\"scripts\":{\"start\":\"node .\"}}");
        tmp.file("packages/broken/package.json", r#"{"name": "broken", "scripts": {"dev": "#);
        tmp.file("packages/array/package.json", "[1, 2]");
        tmp.file("node_modules/dep/package.json", r#"{"name":"dep","scripts":{"build":"x"}}"#);
        tmp.file("dist/package.json", r#"{"name":"dist","scripts":{"build":"x"}}"#);

        let found = crate::detect::discover_apps(tmp.path());
        let mut ids: Vec<_> = found.iter().map(|a| a.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["package.json#build", "package.json#dev", "packages/api/package.json#start"]);
        let api = found.iter().find(|a| a.name == "api:start").unwrap();
        assert_eq!(api.steps[0].program, Program::path("pnpm"), "the monorepo's lockfile applies to its packages");
        assert_eq!(api.steps[0].cwd, "packages/api");
    }

    #[test]
    fn the_ready_patterns_cover_the_common_dev_servers() {
        let ready = |line: &str| READY.iter().any(|r| line.contains(r));
        for line in [
            "  ➜  Local:   http://localhost:1420/",
            "  VITE v8.0.1  ready in 412 ms",
            "   ▲ Next.js 15.0.0\n - Local:        http://localhost:3000",
            " ✓ Ready in 2.1s",
            "Compiled successfully!",
            "webpack compiled successfully",
            "Server listening on port 3000",
            "started server on 0.0.0.0:3000, url: http://localhost:3000",
            "Server running at http://127.0.0.1:8080/",
        ] {
            assert!(ready(line), "{line}");
        }
        assert!(!ready("VITE v8.0.1 starting"));
    }
}
