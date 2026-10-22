//! Which .NET apps run under `dotnet watch`, so a change to their files rebuilds or hot-reloads them. The choice is the
//! user's, kept in `watch.json` in the app data directory. It is keyed by repo and app, not by checkout, so an app stays
//! watched in every worktree of its repo.

use crate::model::AppDef;
use std::collections::BTreeSet;
use std::path::Path;

pub const FILE_NAME: &str = "watch.json";

/// The kind a `dotnet run` app takes while it is watched, and the only kind that can be.
const WATCHED_KIND: &str = "dotnet-watch";

pub fn key(repo: &str, app_id: &str) -> String {
    format!("{repo}::{app_id}")
}

pub fn load(file: &Path) -> BTreeSet<String> {
    match std::fs::read_to_string(file) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!("spawner: ignoring unreadable {}: {e}", file.display());
            BTreeSet::new()
        }),
        Err(_) => BTreeSet::new(),
    }
}

pub fn save(file: &Path, keys: &BTreeSet<String>) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(keys).map_err(|e| e.to_string())?;
    std::fs::write(file, text).map_err(|e| format!("cannot write {}: {e}", file.display()))
}

/// Whether the app can run under `dotnet watch`: an SDK project that `dotnet run` starts.
pub fn can_watch(app: &AppDef) -> bool {
    app.kind == "dotnet-run"
}

/// Turns the app's `dotnet run --project X` into `dotnet watch --non-interactive --project X run`. Non-interactive
/// makes a change that cannot be hot-reloaded restart the app, since there is no terminal to ask in.
pub fn watching(app: &mut AppDef) {
    if !can_watch(app) {
        return;
    }
    let Some(step) = app.steps.last_mut() else { return };
    if step.args.first().map(String::as_str) != Some("run") {
        return;
    }
    let rest = step.args.split_off(1);
    step.args = ["watch", "--non-interactive"].map(String::from).into_iter().chain(rest).chain(["run".to_string()]).collect();
    app.kind = WATCHED_KIND.into();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::dotnet::{app_def, Flavor};
    use crate::testutil::TempDir;

    #[test]
    fn a_watched_app_runs_dotnet_watch_on_the_same_project() {
        let mut app = app_def(Flavor::DotnetRun, "src/Web/Web.csproj", "Web", None);
        watching(&mut app);
        assert_eq!(app.kind, "dotnet-watch");
        let [step] = app.steps.as_slice() else { panic!("one step") };
        assert_eq!(step.args, ["watch", "--non-interactive", "--project", "Web.csproj", "run"]);
        assert_eq!(step.cwd, "src/Web");
        assert_eq!(step.ready, ["Now listening on", "Application started"], "watch passes the app's own output through");
    }

    #[test]
    fn only_dotnet_run_apps_can_be_watched() {
        let mut iis = app_def(Flavor::IisExpress, "Bill.csproj", "Bill", Some(42318));
        let before = iis.clone();
        watching(&mut iis);
        assert_eq!(iis, before);
    }

    #[test]
    fn the_choice_survives_a_restart() {
        let dir = TempDir::new("watch");
        let file = dir.path().join(FILE_NAME);
        assert!(load(&file).is_empty());
        let keys = BTreeSet::from([key("shop", "Web/Web.csproj")]);
        save(&file, &keys).unwrap();
        assert_eq!(load(&file), keys);
    }
}
