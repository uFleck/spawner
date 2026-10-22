//! Test helpers. A unique directory under the OS temp dir that is removed on drop.

use crate::model::{AppDef, AppMode};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

/// Runs git in `dir` with a throwaway identity, and fails the test when git fails.
pub fn git(dir: &Path, args: &[&str]) {
    let mut cmd = std::process::Command::new("git");
    cmd.args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]).args(args).current_dir(dir);
    crate::discovery::no_window(&mut cmd);
    assert!(cmd.output().is_ok_and(|o| o.status.success()), "git {args:?} failed in {}", dir.display());
}

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("spawner-test-{name}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Creates a directory (and parents) under this one and returns it.
    pub fn dir(&self, rel: &str) -> PathBuf {
        let p = self.0.join(rel);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Writes a file (creating parents) under this one.
    pub fn file(&self, rel: &str, text: &str) -> PathBuf {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, text).unwrap();
        p
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        if std::fs::remove_dir_all(&self.0).is_err() {
            // Git writes read-only object files, which Windows refuses to delete.
            make_writable(&self.0);
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn make_writable(dir: &Path) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if let Ok(meta) = entry.metadata() {
            let mut perms = meta.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(&path, perms);
            if meta.is_dir() {
                make_writable(&path);
            }
        }
    }
}

/// An app with no launch steps, for tests that only need something to list and select.
pub fn app(name: &str) -> AppDef {
    AppDef {
        id: format!("{name}.csproj"),
        name: name.into(),
        project: format!("{name}.csproj"),
        kind: "dotnet-run".into(),
        mode: AppMode::Service,
        port: None,
        check_port: false,
        learn_port: false,
        steps: Vec::new(),
        description: None,
        params: Vec::new(),
    }
}
