//! Concluding a task: taking its linked git worktrees off the disk, and putting them back.

use crate::discovery::{git_worktree_list, no_window, parse_worktrees};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// What `remove` took off the disk, enough for `restore` to check it out again.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    /// The repo's folder name, for messages.
    pub repo: String,
    pub path: String,
    /// The repo's main checkout, where git is run.
    pub main: String,
    /// `None` for a detached HEAD.
    pub branch: Option<String>,
    pub head: String,
}

/// A worktree git refused to remove.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Refused {
    pub repo: String,
    pub reason: String,
    /// Modified or untracked files are the reason, so `force` would take it.
    pub needs_force: bool,
}

/// The outcome of concluding a task: every worktree is tried, so some can be removed while others are refused.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Concluded {
    pub removed: Vec<Removed>,
    pub refused: Vec<Refused>,
}

fn git_stdout(dir: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    no_window(&mut cmd);
    let out = cmd.output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git_run(dir: &Path, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("cannot run git: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().trim_start_matches("fatal: ").to_string())
}

/// A linked worktree has a `.git` file pointing at its repo; a main checkout has a `.git` directory.
pub fn is_linked(path: &Path) -> bool {
    path.join(".git").is_file()
}

/// The repo's main checkout, where `git worktree remove` has to run: a worktree cannot remove the folder it is in.
fn main_checkout(worktree: &Path) -> Result<PathBuf, String> {
    let porcelain = git_worktree_list(worktree).ok_or_else(|| format!("git could not list the worktrees of {}", worktree.display()))?;
    parse_worktrees(&porcelain)
        .into_iter()
        .find(|w| w.is_main)
        .map(|w| w.path)
        .ok_or_else(|| format!("no main checkout found for {}", worktree.display()))
}

/// `git worktree remove`: deletes the folder and the repo's record of it, and keeps the branch. Without `force` git
/// refuses a worktree with modified or untracked files (ignored ones such as `node_modules` do not count).
pub fn remove(path: &Path, force: bool) -> Result<Removed, String> {
    if !is_linked(path) {
        return Err(format!("{} is a main checkout, not a linked worktree", path.display()));
    }
    let main = main_checkout(path)?;
    let head = git_stdout(path, &["rev-parse", "HEAD"]).ok_or_else(|| format!("git could not read HEAD of {}", path.display()))?;
    let removed = Removed {
        repo: main.file_name().map_or_else(|| main.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned()),
        path: path.to_string_lossy().into_owned(),
        main: main.to_string_lossy().into_owned(),
        branch: git_stdout(path, &["symbolic-ref", "--short", "-q", "HEAD"]).filter(|b| !b.is_empty()),
        head,
    };
    let mut args: Vec<&std::ffi::OsStr> = vec!["worktree".as_ref(), "remove".as_ref()];
    if force {
        args.push("--force".as_ref());
    }
    args.push(path.as_os_str());
    git_run(&main, &args)?;
    Ok(removed)
}

/// Undoes `remove`: checks the branch out again in the same folder. A branch that has since been deleted is recreated
/// at the commit it was on. Changes that were never committed, and ignored files such as `node_modules`, are gone for
/// good. Does nothing when the folder is already a worktree, so a retry after a partial failure is safe.
pub fn restore(r: &Removed) -> Result<(), String> {
    let path = Path::new(&r.path);
    if is_linked(path) {
        return Ok(());
    }
    if path.exists() {
        return Err(format!("{} already exists and is not a worktree", r.path));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let main = Path::new(&r.main);
    let mut args: Vec<&std::ffi::OsStr> = vec!["worktree".as_ref(), "add".as_ref()];
    match r.branch.as_deref() {
        Some(branch) if git_stdout(main, &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")]).is_some() => {
            args.extend([path.as_os_str(), branch.as_ref()]);
        }
        Some(branch) => args.extend(["-b".as_ref(), branch.as_ref(), path.as_os_str(), r.head.as_ref()]),
        None => args.extend(["--detach".as_ref(), path.as_os_str(), r.head.as_ref()]),
    }
    git_run(main, &args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{git, TempDir};

    /// A repo `dev/shop` with a task worktree `dev/PAYMENT-7/shop` on its own branch.
    fn task(tmp: &TempDir) -> (PathBuf, PathBuf) {
        let shop = tmp.dir("dev/shop");
        tmp.file("dev/shop/.gitignore", "node_modules\n");
        tmp.file("dev/shop/a.txt", "a");
        git(&shop, &["init", "-q"]);
        git(&shop, &["add", "."]);
        git(&shop, &["commit", "-q", "-m", "init"]);
        tmp.dir("dev/PAYMENT-7");
        let wt = tmp.path().join("dev/PAYMENT-7/shop");
        git(&shop, &["worktree", "add", "-q", "-b", "PAYMENT-7", &wt.to_string_lossy()]);
        (shop, wt)
    }

    #[test]
    fn removes_a_clean_worktree_even_with_ignored_files_and_keeps_its_branch() {
        let tmp = TempDir::new("wt-clean");
        let (shop, wt) = task(&tmp);
        tmp.file("dev/PAYMENT-7/shop/node_modules/x/index.js", "x");

        remove(&wt, false).unwrap();

        assert!(!wt.exists());
        assert!(shop.exists(), "the main checkout stays");
        let branches = Command::new("git").args(["branch", "--list", "PAYMENT-7"]).current_dir(&shop).output().unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).contains("PAYMENT-7"), "the branch is kept");
    }

    #[test]
    fn a_dirty_worktree_needs_force() {
        let tmp = TempDir::new("wt-dirty");
        let (_shop, wt) = task(&tmp);
        tmp.file("dev/PAYMENT-7/shop/wip.txt", "unsaved work");

        let err = remove(&wt, false).unwrap_err();
        assert!(err.contains("--force"), "{err}");
        assert!(wt.exists(), "nothing is deleted without force");

        remove(&wt, true).unwrap();
        assert!(!wt.exists());
    }

    #[test]
    fn restore_checks_the_branch_out_again_in_the_same_folder() {
        let tmp = TempDir::new("wt-restore");
        let (shop, wt) = task(&tmp);
        tmp.file("dev/PAYMENT-7/shop/b.txt", "b");
        git(&wt, &["add", "b.txt"]);
        git(&wt, &["commit", "-q", "-m", "work"]);

        let removed = remove(&wt, false).unwrap();
        assert_eq!(removed.repo, "shop");
        assert_eq!(removed.branch.as_deref(), Some("PAYMENT-7"));
        std::fs::remove_dir(tmp.path().join("dev/PAYMENT-7")).unwrap();

        restore(&removed).unwrap();
        assert!(is_linked(&wt));
        assert!(wt.join("b.txt").exists(), "the committed work is back");
        restore(&removed).unwrap();

        remove(&wt, false).unwrap();
        git(&shop, &["branch", "-D", "PAYMENT-7"]);
        restore(&removed).unwrap();
        assert!(wt.join("b.txt").exists(), "a deleted branch is recreated at the commit it was on");
    }

    #[test]
    fn restore_refuses_a_folder_that_is_in_the_way() {
        let tmp = TempDir::new("wt-restore-busy");
        let (_shop, wt) = task(&tmp);
        let removed = remove(&wt, false).unwrap();
        tmp.file("dev/PAYMENT-7/shop/other.txt", "x");
        let err = restore(&removed).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
    }

    #[test]
    fn a_main_checkout_is_never_removed() {
        let tmp = TempDir::new("wt-main");
        let (shop, _wt) = task(&tmp);
        let err = remove(&shop, true).unwrap_err();
        assert!(err.contains("main checkout"), "{err}");
        assert!(shop.join("a.txt").exists());
    }
}
