//! Tauri: a folder with `src-tauri/tauri.conf.json` (or the `.json5` / `Tauri.toml` forms) is a desktop app, run in dev
//! mode as one service called `tauri dev`. It goes through the package manager's `tauri` script when the package has
//! one (`pnpm tauri dev` starts the front end through `beforeDevCommand`, builds the Rust side and opens the window).
//! Without that script it falls back to `cargo run` in `src-tauri`, which does not start a front end dev server.
//! A production `tauri build` is not offered: it is slow and writes installers.
//!
//! The `src-tauri` folder is the Rust half of the app the folder above it already reports, so it is claimed
//! (`Claim::Tree`) and nothing below it is scanned.

use super::node::{self, Pm};
use super::{Claim, Detector};
use crate::model::{AppDef, AppMode, Program, StepSpec};
use std::path::Path;

const CONFIG_FILES: &[&str] = &["tauri.conf.json", "tauri.conf.json5", "Tauri.toml"];
const SHELL_DIR: &str = "src-tauri";

/// What the window app prints once cargo has built it and launched it: `Running \`target\debug\app.exe\``.
/// Not matched by tauri's own `Running DevCommand (...)` / `Running BeforeDevCommand (...)` lines.
pub const READY: &[&str] = &["Running `"];

pub struct Tauri;

fn config_in(dir: &Path) -> Option<&'static str> {
    CONFIG_FILES.iter().copied().find(|f| dir.join(f).is_file())
}

impl Detector for Tauri {
    fn name(&self) -> &'static str {
        "tauri"
    }

    /// Claims `src-tauri` itself; the app folder above it is left to the other detectors too, since it holds a
    /// `package.json` whose scripts `detect::node` lists.
    fn detect(&self, dir: &Path, root: &Path, out: &mut Vec<AppDef>) -> Claim {
        if dir.file_name().is_some_and(|n| n == SHELL_DIR) && config_in(dir).is_some() {
            return Claim::Tree;
        }
        let shell = dir.join(SHELL_DIR);
        let Some(config) = config_in(&shell) else { return Claim::None };
        let manifest = node::read_manifest(&dir.join("package.json"));
        let runner = manifest.as_ref().filter(|m| node::has_script(m, "tauri")).map(|m| node::package_manager(dir, root, m));
        let package = manifest.as_ref().map_or_else(|| node::folder_name(dir), |m| node::package_name(m, &node::folder_name(dir)));
        out.push(app_def(runner, &node::rel(root, dir), config, &package));
        Claim::None
    }
}

/// The `tauri dev` app for the app folder `rel_dir` (relative to the project folder, empty for the folder itself).
/// `runner` is the package manager that has a `tauri` script for it, or `None` for the `cargo run` fallback.
pub fn app_def(runner: Option<Pm>, rel_dir: &str, config: &str, package: &str) -> AppDef {
    let (label, step) = match runner {
        Some(pm) => ("tauri dev", (Program::path(pm.program()), pm.run_args("tauri", &["dev"]), node::cwd_of(rel_dir))),
        None => ("cargo run", (Program::path("cargo"), vec!["run".to_string()], node::join_rel(rel_dir, SHELL_DIR))),
    };
    let (program, args, cwd) = step;
    AppDef {
        id: format!("{}#{}", node::join_rel(&node::join_rel(rel_dir, SHELL_DIR), config), label.replace(' ', "-")),
        name: format!("{package}:{label}"),
        project: node::join_rel(&node::join_rel(rel_dir, SHELL_DIR), config),
        kind: "tauri".into(),
        mode: AppMode::Service,
        port: None,
        check_port: false,
        learn_port: true,
        steps: vec![StepSpec { program, args, cwd, ready: READY.iter().map(|r| r.to_string()).collect() }],
        description: None,
        params: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn a_tauri_app_runs_through_its_package_managers_tauri_script() {
        let app = app_def(Some(Pm::Pnpm), "", "tauri.conf.json", "spawner");
        assert_eq!((app.id.as_str(), app.name.as_str(), app.kind.as_str()), ("src-tauri/tauri.conf.json#tauri-dev", "spawner:tauri dev", "tauri"));
        assert_eq!((app.mode, app.port, app.learn_port, app.project.as_str()), (AppMode::Service, None, true, "src-tauri/tauri.conf.json"));
        let [step] = app.steps.as_slice() else { panic!("one step") };
        assert_eq!(step.program, Program::path("pnpm"));
        assert_eq!((step.args.as_slice(), step.cwd.as_str()), (["run", "tauri", "dev"].map(String::from).as_slice(), "."));
        assert_eq!(step.ready, ["Running `"]);

        let npm = app_def(Some(Pm::Npm), "apps/desk", "tauri.conf.json", "desk");
        assert_eq!(npm.steps[0].args, ["run", "tauri", "--", "dev"]);
        assert_eq!(npm.steps[0].cwd, "apps/desk");
        assert_eq!(npm.id, "apps/desk/src-tauri/tauri.conf.json#tauri-dev");
    }

    #[test]
    fn without_a_tauri_script_it_falls_back_to_cargo_run_in_src_tauri() {
        let app = app_def(None, "apps/desk", "Tauri.toml", "desk");
        assert_eq!((app.name.as_str(), app.id.as_str()), ("desk:cargo run", "apps/desk/src-tauri/Tauri.toml#cargo-run"));
        assert_eq!(app.steps[0].program, Program::path("cargo"));
        assert_eq!((app.steps[0].args.as_slice(), app.steps[0].cwd.as_str()), (["run"].map(String::from).as_slice(), "apps/desk/src-tauri"));
    }

    #[test]
    fn only_the_line_that_launches_the_window_app_means_ready() {
        // Captured from `pnpm tauri dev` on this repo (stderr, ANSI removed).
        let output = [
            "     Running BeforeDevCommand (`pnpm dev`)",
            "  ➜  Local:   http://localhost:1420/",
            "     Running DevCommand (`cargo  run --no-default-features --color always --`)",
            "        Info Watching C:\\umbler\\umbler-hub\\src-tauri for changes...",
            "   Compiling spawner v0.1.0 (C:\\umbler\\umbler-hub\\src-tauri)",
            "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.66s",
            "     Running `target\\debug\\spawner.exe`",
        ];
        let ready: Vec<_> = output.iter().filter(|l| READY.iter().any(|r| l.contains(r))).collect();
        assert_eq!(ready, [&"     Running `target\\debug\\spawner.exe`"]);
    }

    fn names(apps: &[AppDef]) -> Vec<&str> {
        apps.iter().map(|a| a.name.as_str()).collect()
    }

    #[test]
    fn discovery_lists_tauri_dev_beside_the_web_scripts_and_not_the_rust_crate() {
        let tmp = TempDir::new("tauri");
        tmp.file("package.json", r#"{"name":"spawner","scripts":{"dev":"vite","build":"tsc && vite build","preview":"vite preview","tauri":"tauri"},"devDependencies":{"vite":"1"}}"#);
        tmp.file("pnpm-lock.yaml", "");
        tmp.file("src-tauri/tauri.conf.json", "{}");
        tmp.file("src-tauri/Cargo.toml", "[package]\nname = \"spawner\"\n");
        tmp.file("src-tauri/gen/schemas/package.json", r#"{"name":"nested","scripts":{"build":"x"}}"#);
        tmp.file("src-tauri/target/debug/package.json", r#"{"name":"built","scripts":{"build":"x"}}"#);

        let apps = crate::detect::discover_apps(tmp.path());
        assert_eq!(names(&apps), ["spawner:build", "spawner:dev", "spawner:preview", "spawner:tauri dev"], "`tauri` itself is not listed twice and src-tauri is not scanned");
        let tauri = apps.iter().find(|a| a.kind == "tauri").unwrap();
        assert_eq!(tauri.steps[0].program, Program::path("pnpm"));
    }

    #[test]
    fn a_tauri_app_without_a_package_json_is_named_after_its_folder() {
        let tmp = TempDir::new("tauri-bare");
        tmp.file("desk/src-tauri/tauri.conf.json5", "{}");
        let apps = crate::detect::discover_apps(tmp.path());
        assert_eq!(names(&apps), ["desk:cargo run"]);
        assert_eq!(apps[0].steps[0].cwd, "desk/src-tauri");
    }

    #[test]
    fn a_package_with_a_tauri_conf_elsewhere_than_src_tauri_is_just_a_package() {
        let tmp = TempDir::new("tauri-other");
        tmp.file("package.json", r#"{"name":"p","scripts":{"dev":"vite"}}"#);
        tmp.file("other/tauri.conf.json", "{}");
        assert_eq!(names(&crate::detect::discover_apps(tmp.path())), ["p:dev"]);
    }
}
