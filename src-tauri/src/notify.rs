//! Desktop notifications for scripts, so the user can follow what an AI agent runs while Spawner is in the background.
//! Off until the user turns it on (the setting lives in `settings.json` in the app data directory). The decision
//! of what to say is here and pure; showing it, and skipping it while the window has focus, is `lib.rs`.

use crate::model::InstanceState;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

pub const FILE_NAME: &str = "settings.json";

#[derive(Serialize, Deserialize, Clone, Copy, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Tell the user when a script starts and when it ends, while the Spawner window is not focused.
    pub notify_scripts: bool,
}

pub struct Notifier {
    file: PathBuf,
    settings: Mutex<Settings>,
    /// Scripts that have started and not ended yet, tracked even while notifications are off so turning them on mid-run is right.
    running: Mutex<HashSet<String>>,
}

impl Notifier {
    pub fn load(file: PathBuf) -> Self {
        let settings = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Self { file, settings: Mutex::new(settings), running: Mutex::default() }
    }

    pub fn settings(&self) -> Settings {
        *self.settings.lock().unwrap()
    }

    pub fn save(&self, settings: Settings) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        std::fs::write(&self.file, json).map_err(|e| format!("cannot write {}: {e}", self.file.display()))?;
        *self.settings.lock().unwrap() = settings;
        Ok(())
    }

    /// The (title, body) to show for the script `name` (instance `id`) entering `state`, or none when nothing
    /// worth saying happened or notifications are off.
    pub fn note(&self, id: &str, name: &str, state: &InstanceState) -> Option<(String, String)> {
        let message = {
            let mut running = self.running.lock().unwrap();
            if state.is_active() {
                running.insert(id.to_string()).then(|| ("Script started".to_string(), name.to_string()))
            } else {
                running.remove(id).then(|| match state {
                    InstanceState::Exited { code: Some(0) } => (format!("Script finished: {name}"), "Exited with code 0".to_string()),
                    InstanceState::Exited { code: Some(c) } => (format!("Script failed: {name}"), format!("Exited with code {c}")),
                    InstanceState::Failed { message } => (format!("Script failed: {name}"), message.clone()),
                    _ => (format!("Script stopped: {name}"), "Stopped".to_string()),
                })
            }
        };
        message.filter(|_| self.settings().notify_scripts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn notifier(on: bool) -> (TempDir, Notifier) {
        let dir = TempDir::new("notify");
        let n = Notifier::load(dir.path().join(FILE_NAME));
        n.save(Settings { notify_scripts: on }).unwrap();
        (dir, n)
    }

    #[test]
    fn a_script_announces_its_start_once_and_its_end() {
        let (_dir, n) = notifier(true);
        let said = |s: InstanceState| n.note("p::a", "cust monitors", &s);
        assert_eq!(said(InstanceState::Building), Some(("Script started".into(), "cust monitors".into())));
        assert_eq!(said(InstanceState::Running { pid: 1 }), None, "building, starting and running are one start");
        assert_eq!(said(InstanceState::Exited { code: Some(0) }), Some(("Script finished: cust monitors".into(), "Exited with code 0".into())));
        assert_eq!(said(InstanceState::Idle), None, "forgetting a finished run says nothing");
    }

    #[test]
    fn failures_and_stops_are_told_apart() {
        let (_dir, n) = notifier(true);
        n.note("a", "x", &InstanceState::Building);
        assert_eq!(n.note("a", "x", &InstanceState::Exited { code: Some(2) }).unwrap().0, "Script failed: x");
        n.note("a", "x", &InstanceState::Building);
        assert_eq!(n.note("a", "x", &InstanceState::Failed { message: "no python".into() }).unwrap().1, "no python");
        n.note("a", "x", &InstanceState::Building);
        assert_eq!(n.note("a", "x", &InstanceState::Exited { code: None }).unwrap().0, "Script stopped: x");
    }

    #[test]
    fn off_says_nothing_but_keeps_track_so_turning_it_on_mid_run_still_reports_the_end() {
        let (_dir, n) = notifier(false);
        assert_eq!(n.note("a", "x", &InstanceState::Building), None);
        n.save(Settings { notify_scripts: true }).unwrap();
        assert!(n.note("a", "x", &InstanceState::Exited { code: Some(0) }).is_some());
    }

    #[test]
    fn the_setting_survives_a_restart_and_defaults_to_off() {
        let (dir, n) = notifier(true);
        assert!(Notifier::load(dir.path().join(FILE_NAME)).settings().notify_scripts);
        drop(n);
        assert!(!Notifier::load(dir.path().join("missing.json")).settings().notify_scripts);
    }
}
