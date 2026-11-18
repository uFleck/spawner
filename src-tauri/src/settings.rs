//! The app's settings, saved in `settings.json` in the app data directory. They are read at startup; every window
//! gets its own copy, and `lib.rs` applies a change as it arrives.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

pub const FILE_NAME: &str = "settings.json";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Show the companion window at the edge of the screen while apps run.
    pub companion: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { companion: true }
    }
}

pub struct SettingsStore {
    file: PathBuf,
    settings: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(file: PathBuf) -> Self {
        let settings = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Self { file, settings: Mutex::new(settings) }
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn the_companion_setting_survives_a_restart_and_defaults_to_on() {
        let dir = TempDir::new("settings");
        let s = SettingsStore::load(dir.path().join(FILE_NAME));
        assert!(s.settings().companion);
        s.save(Settings { companion: false }).unwrap();
        drop(s);
        assert!(!SettingsStore::load(dir.path().join(FILE_NAME)).settings().companion);
    }
}
