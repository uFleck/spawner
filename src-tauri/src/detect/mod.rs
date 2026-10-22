//! Finds what is runnable in a folder. A `Detector` knows one technology: it looks at a directory and reports the
//! apps defined there as data (`AppDef`: kind, mode, port and launch steps), so the runner never needs to know
//! the technology. To support a new one, add a module with a `Detector` and list it in `DETECTORS`.

pub mod dotnet;
pub mod node;
pub mod scripts;
pub mod tauri;

use crate::model::{AppDef, Program};
use std::path::{Path, PathBuf};

/// Folders the walk never enters: build output, dependencies and tool caches, which hold copies of other projects.
pub const SKIP_DIRS: &[&str] = &[
    "bin", "obj", "node_modules", "packages", ".git", ".vs", ".jj", "graphify-out", "docs",
    ".nuget", "wwwroot", "dist", "build", "target", ".next", ".turbo", ".venv",
];
pub const MAX_DEPTH: usize = 8;

/// Whether the walk leaves the folder `name` inside `parent` alone. `packages` is NuGet's restore folder next to a
/// solution, but also where a JS monorepo keeps its packages, so it is entered when `parent` has a `package.json`.
pub fn skipped(parent: &Path, name: &str) -> bool {
    if name.eq_ignore_ascii_case("packages") && parent.join("package.json").is_file() {
        return false;
    }
    SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(name))
}

/// What a detector says about the directory it was just asked about.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code, reason = "Dir is for detectors of overlapping technologies; the registered ones claim only None or Tree")]
pub enum Claim {
    /// Nothing to claim: the other detectors still look at this directory.
    None,
    /// This directory is this detector's own: detectors after it skip it, so one app is not reported twice.
    Dir,
    /// Like `Dir`, and the walk does not descend into it either (the app owns everything below).
    Tree,
}

pub trait Detector: Sync {
    #[allow(dead_code, reason = "identifies a detector in diagnostics; nothing reads it yet")]
    fn name(&self) -> &'static str;

    /// Pushes the apps defined directly in `dir`. `root` is the project folder the walk started from; an app's `id`
    /// and `project` are paths relative to it, `/`-separated.
    fn detect(&self, dir: &Path, root: &Path, out: &mut Vec<AppDef>) -> Claim;
}

/// Tried in this order for every directory, so an earlier detector can claim a directory ahead of a later one.
/// `scripts` is first because it never claims a directory, and a `spawner.json` must be read wherever it sits.
static DETECTORS: &[&dyn Detector] = &[&scripts::Scripts, &dotnet::Dotnet, &node::Node, &tauri::Tauri];

/// Everything runnable under `dir`, found by descending at most `MAX_DEPTH` folders. The seam `discovery` uses.
pub fn discover_apps(dir: &Path) -> Vec<AppDef> {
    discover_apps_in(dir, MAX_DEPTH)
}

/// Like `discover_apps`, descending at most `max_depth` folders below `dir` (0 looks only at `dir` itself).
pub fn discover_apps_in(dir: &Path, max_depth: usize) -> Vec<AppDef> {
    discover_with(DETECTORS, dir, max_depth)
}

fn discover_with(detectors: &[&dyn Detector], dir: &Path, max_depth: usize) -> Vec<AppDef> {
    let mut found = Vec::new();
    walk(detectors, dir, dir, 0, max_depth, &mut found);
    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    found
}

fn walk(detectors: &[&dyn Detector], root: &Path, dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<AppDef>) {
    let mut descend = true;
    for detector in detectors {
        match detector.detect(dir, root, out) {
            Claim::None => {}
            Claim::Dir => break,
            Claim::Tree => {
                descend = false;
                break;
            }
        }
    }
    if !descend || depth >= max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().is_ok_and(|t| t.is_dir()) && !skipped(dir, &name) {
            walk(detectors, root, &entry.path(), depth + 1, max_depth, out);
        }
    }
}

/// Finds the executable of a step's program. Tools that have to be located are looked up here, when an app starts,
/// so a machine without them still lists the app and fails with a readable message only when it is run.
pub fn resolve(program: &Program) -> Result<PathBuf, String> {
    match program {
        Program::Path { name } => Ok(script_on_path(name).unwrap_or_else(|| name.into())),
        Program::Msbuild => dotnet::find_msbuild().ok_or_else(|| "MSBuild not found (install Visual Studio Build Tools)".into()),
        Program::IisExpress => dotnet::find_iis_express().ok_or_else(|| "IIS Express not found".into()),
    }
}

/// On Windows, npm, pnpm, yarn and bun are often `.cmd` shims, which `CreateProcess` does not find by bare name (it
/// only appends `.exe`). So a bare name that a shell would run as a `.cmd`/`.bat` is resolved to that file, which
/// the standard library then starts through `cmd.exe` with safe argument quoting. Anything else (a real `.exe`, a
/// name not on `PATH`) is spawned by name as before. Elsewhere there is nothing to resolve.
fn script_on_path(name: &str) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let dirs: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH")?).collect();
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let exts: Vec<&str> = pathext.split(';').filter(|e| !e.is_empty()).collect();
    lookup(name, &dirs, &exts).filter(|p| is_script(p))
}

fn is_script(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// The first file a shell would run for `name`: per directory in order, the name as given when it has an extension,
/// else the name with each of `exts` (like `.EXE`) appended. A name with a path in it is never looked up.
fn lookup(name: &str, dirs: &[PathBuf], exts: &[&str]) -> Option<PathBuf> {
    if name.contains(['/', '\\']) || Path::new(name).is_absolute() {
        return None;
    }
    let candidates: Vec<String> =
        if Path::new(name).extension().is_some() { vec![name.to_string()] } else { exts.iter().map(|e| format!("{name}{e}")).collect() };
    dirs.iter().flat_map(|d| candidates.iter().map(move |c| d.join(c))).find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AppMode;
    use crate::testutil::TempDir;

    /// Reports one app named `label` in every directory holding a file called `marker`, and answers `claim` for it.
    struct Fake {
        label: &'static str,
        marker: &'static str,
        claim: Claim,
    }

    impl Detector for Fake {
        fn name(&self) -> &'static str {
            self.label
        }

        fn detect(&self, dir: &Path, root: &Path, out: &mut Vec<AppDef>) -> Claim {
            if !dir.join(self.marker).is_file() {
                return Claim::None;
            }
            let rel = dir.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            let mut app = crate::testutil::app(self.label);
            app.id = format!("{rel}:{}", self.label);
            app.kind = self.label.into();
            app.mode = AppMode::Task;
            out.push(app);
            self.claim
        }
    }

    fn ids(apps: &[AppDef]) -> Vec<String> {
        let mut ids: Vec<_> = apps.iter().map(|a| a.id.clone()).collect();
        ids.sort();
        ids
    }

    #[test]
    fn a_claimed_directory_is_not_reported_by_the_detectors_after_it() {
        let tmp = TempDir::new("claim");
        tmp.file("both/a.mark", "");
        tmp.file("both/b.mark", "");
        tmp.file("only-b/b.mark", "");
        let a = Fake { label: "a", marker: "a.mark", claim: Claim::Dir };
        let b = Fake { label: "b", marker: "b.mark", claim: Claim::None };

        let apps = discover_with(&[&a, &b], tmp.path(), 4);
        assert_eq!(ids(&apps), ["both:a", "only-b:b"], "a claims `both`, so b does not report it too; b still gets `only-b`");

        let unclaimed = Fake { claim: Claim::None, ..a };
        assert_eq!(ids(&discover_with(&[&unclaimed, &b], tmp.path(), 4)), ["both:a", "both:b", "only-b:b"]);
    }

    #[test]
    fn a_detector_that_comes_first_wins_the_claim() {
        let tmp = TempDir::new("order");
        tmp.file("x/a.mark", "");
        tmp.file("x/b.mark", "");
        let a = Fake { label: "a", marker: "a.mark", claim: Claim::Dir };
        let b = Fake { label: "b", marker: "b.mark", claim: Claim::Dir };
        assert_eq!(ids(&discover_with(&[&b, &a], tmp.path(), 4)), ["x:b"]);
    }

    #[test]
    fn a_claimed_tree_is_not_descended_into() {
        let tmp = TempDir::new("tree");
        tmp.file("app/a.mark", "");
        tmp.file("app/inner/a.mark", "");
        tmp.file("other/a.mark", "");
        let tree = Fake { label: "a", marker: "a.mark", claim: Claim::Tree };
        let dir = Fake { claim: Claim::Dir, ..tree };
        assert_eq!(ids(&discover_with(&[&tree], tmp.path(), 4)), ["app:a", "other:a"]);
        assert_eq!(ids(&discover_with(&[&dir], tmp.path(), 4)), ["app/inner:a", "app:a", "other:a"]);
    }

    #[test]
    fn the_walk_stops_at_max_depth_and_skips_junk_folders() {
        let tmp = TempDir::new("depth");
        tmp.file("a.mark", "");
        tmp.file("one/a.mark", "");
        tmp.file("one/two/a.mark", "");
        tmp.file("node_modules/x/a.mark", "");
        let a = Fake { label: "a", marker: "a.mark", claim: Claim::None };
        assert_eq!(ids(&discover_with(&[&a], tmp.path(), 0)), [":a"]);
        assert_eq!(ids(&discover_with(&[&a], tmp.path(), 1)), [":a", "one:a"]);
        assert_eq!(discover_with(&[&a], tmp.path(), 5).len(), 3, "node_modules is never entered");
    }

    #[test]
    fn programs_that_need_no_lookup_resolve_to_themselves() {
        assert_eq!(resolve(&Program::path("dotnet")), Ok(PathBuf::from("dotnet")));
        assert_eq!(resolve(&Program::path("C:/tools/x.exe")), Ok(PathBuf::from("C:/tools/x.exe")));
    }

    /// Discovery over this very repository. Run with `--ignored --nocapture` to print what Spawner finds in itself.
    #[test]
    #[ignore = "reads this repository's working tree; run with --ignored --nocapture"]
    fn discovers_this_repo() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let apps = discover_apps(repo);
        for a in &apps {
            let step = &a.steps[0];
            println!("{:<28} {:<7} {:<8} {:<34} {:?} {} (cwd {})", a.name, a.kind, format!("{:?}", a.mode), a.id, step.program, step.args.join(" "), step.cwd);
        }
        let names: Vec<_> = apps.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["spawner:build", "spawner:dev", "spawner:preview", "spawner:tauri dev"]);
    }

    #[test]
    fn a_bare_name_is_looked_up_like_a_shell_does() {
        let tmp = TempDir::new("lookup");
        let (first, second) = (tmp.dir("first"), tmp.dir("second"));
        tmp.file("first/tool.cmd", "");
        tmp.file("second/tool.exe", "");
        tmp.file("second/other.exe", "");
        let dirs = [first.clone(), second.clone()];
        let exts = [".com", ".exe", ".bat", ".cmd"];
        assert_eq!(lookup("tool", &dirs, &exts), Some(first.join("tool.cmd")), "an earlier folder wins over an earlier extension");
        assert_eq!(lookup("other", &dirs, &exts), Some(second.join("other.exe")));
        assert_eq!(lookup("tool.exe", &dirs, &exts), Some(second.join("tool.exe")), "a name with an extension is taken as given");
        assert_eq!(lookup("missing", &dirs, &exts), None);
        assert_eq!(lookup("sub/tool", &dirs, &exts), None, "a name with a path is not looked up");
        assert!(is_script(&first.join("tool.cmd")) && !is_script(&second.join("tool.exe")));
    }

    #[cfg(windows)]
    #[test]
    fn the_package_managers_on_this_machine_spawn_through_a_script_shim_when_they_are_one() {
        // Whatever is installed must be runnable by bare name: `.exe` shims by name, `.cmd` shims by their path.
        for tool in ["npm", "pnpm"] {
            let Ok(program) = resolve(&Program::path(tool)) else { continue };
            let Ok(out) = std::process::Command::new(&program).arg("--version").output() else {
                if which_dir(tool).is_none() {
                    continue;
                }
                panic!("{tool} is installed but {program:?} does not spawn");
            };
            assert!(out.status.success(), "{tool} --version failed via {program:?}");
        }
    }

    #[cfg(windows)]
    fn which_dir(tool: &str) -> Option<PathBuf> {
        let dirs: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH")?).collect();
        lookup(tool, &dirs, &[".EXE", ".CMD", ".BAT"])
    }

    #[test]
    fn packages_is_walked_only_next_to_a_package_json() {
        let tmp = TempDir::new("packages");
        assert!(skipped(tmp.path(), "packages"), "a NuGet restore folder");
        assert!(skipped(tmp.path(), "node_modules") && skipped(tmp.path(), "Target") && skipped(tmp.path(), ".next"));
        tmp.file("package.json", "{}");
        assert!(!skipped(tmp.path(), "packages"), "a JS monorepo keeps its packages there");
        assert!(skipped(tmp.path(), "node_modules"));
        assert!(!skipped(tmp.path(), "src"));
    }
}
