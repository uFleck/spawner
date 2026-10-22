use crate::detect::{self, discover_apps, discover_apps_in, skipped};
use crate::model::{AppDef, Group, Project, Root};
use crate::roots;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

const MAIN_GROUP: &str = "main";
const SCRIPTS_GROUP: &str = "scripts";

pub struct Found {
    pub repo: String,
    pub path: PathBuf,
    pub branch: Option<String>,
    /// The first worktree of a git repo: its main checkout.
    pub is_main: bool,
    /// A plain folder (not a git checkout) scanned directly as one project.
    pub loose: bool,
    pub apps: Vec<AppDef>,
}

/// Scans every root and lays the result out as groups, in root order.
pub fn scan_roots(configured: &[Root]) -> Vec<Group> {
    build_groups(configured.iter().map(|r| (r.clone(), scan_root(Path::new(&r.path)))).collect())
}

/// What one root contains:
/// - a git repo itself: that repo and its worktrees;
/// - otherwise a folder: its git children (repos and their worktrees), its non-git children as one project each,
///   and the folder itself as a project when it holds apps directly.
///
/// A folder that has a `.git` but also holds other checkouts is a folder, not a repo: a stray `git init` in a
/// workspace folder must not swallow the repos and task worktrees inside it as one giant project.
fn scan_root(root: &Path) -> Vec<Found> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut found = if is_git(root) && !holds_checkouts(root) { scan_repo(root) } else { scan_folder(root) };
    let mut seen = HashSet::new();
    found.retain(|f| seen.insert(roots::key(&normalize(&f.path))));
    found
}

fn scan_folder(root: &Path) -> Vec<Found> {
    let mut found = Vec::new();
    let own = discover_apps_in(root, 0);
    if !own.is_empty() {
        found.push(loose_project(root, own));
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        if is_git(&path) {
            found.extend(scan_repo(&path));
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || skipped(root, &name) || holds_checkouts(&path) {
            continue;
        }
        let apps = discover_apps(&path);
        if !apps.is_empty() {
            found.push(loose_project(&path, apps));
        }
    }
    found
}

fn loose_project(path: &Path, apps: Vec<AppDef>) -> Found {
    Found { repo: roots::folder_name(&normalize(path)), path: path.to_path_buf(), branch: None, is_main: false, loose: true, apps }
}

/// `.git` is a directory in a repo and a file in a linked worktree.
fn is_git(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// A task folder (`PAYMENT-9986/`) holding worktrees. Its apps are found through the repos that own them,
/// so scanning it as a plain project would list every app twice.
fn holds_checkouts(dir: &Path) -> bool {
    std::fs::read_dir(dir).into_iter().flatten().flatten().any(|e| e.file_type().is_ok_and(|t| t.is_dir()) && is_git(&e.path()))
}

fn scan_repo(path: &Path) -> Vec<Found> {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Vec::new();
    };
    let Some(porcelain) = git_worktree_list(path) else {
        return Vec::new();
    };
    parse_worktrees(&porcelain)
        .into_iter()
        .filter(|w| w.path.is_dir())
        .map(|w| Found {
            repo: name.clone(),
            apps: discover_apps(&w.path),
            path: w.path,
            branch: w.branch,
            is_main: w.is_main,
            loose: false,
        })
        .filter(|f| !f.apps.is_empty())
        .collect()
}

/// Turns each root's findings into groups and joins them. A project is listed once even when two roots overlap,
/// and a group id that two roots share (the same task id, `main`) is prefixed with its root so ids stay unique.
pub fn build_groups(per_root: Vec<(Root, Vec<Found>)>) -> Vec<Group> {
    let mut seen_projects = HashSet::new();
    let mut groups: Vec<Group> = per_root
        .into_iter()
        .flat_map(|(root, found)| {
            let found = found.into_iter().filter(|f| seen_projects.insert(roots::key(&normalize(&f.path)))).collect();
            group_found(found, &root)
        })
        .collect();
    let mut count = HashMap::<String, usize>::new();
    for g in &groups {
        *count.entry(g.id.clone()).or_default() += 1;
    }
    for g in groups.iter_mut().filter(|g| count[&g.id] > 1) {
        g.id = format!("{}::{}", g.root_path, g.id);
    }
    groups
}

/// A group is one unit of work: a task (`PAYMENT-9986`) holding one project per repo, the repos' main checkouts
/// when the root also has task worktrees, a lone non-task branch, or else everything else in the root.
pub fn group_found(mut found: Vec<Found>, root: &Root) -> Vec<Group> {
    let root_path = roots::normalize(&root.path);
    let root_id = roots::key(&root.path);
    let root_name = roots::display_name(root);
    let scripts = take_scripts(&mut found);
    let task_of = |f: &Found| if f.loose { None } else { task_label(&f.path, f.branch.as_deref()) };
    let has_tasks = found.iter().any(|f| task_of(f).is_some());
    let mut groups: Vec<Group> = Vec::new();
    for f in found {
        let (id, main) = match task_of(&f) {
            Some(task) => (task, false),
            None if f.is_main && has_tasks => (MAIN_GROUP.to_string(), true),
            None if f.is_main || f.loose => (root_name.clone(), false),
            None => (
                f.branch
                    .clone()
                    .or_else(|| f.path.file_name().map(|n| n.to_string_lossy().into_owned()))
                    .unwrap_or_else(|| "detached".into()),
                false,
            ),
        };
        let path = normalize(&f.path);
        let project = Project { id: path.clone(), repo: f.repo, path, branch: f.branch, apps: f.apps };
        match groups.iter_mut().find(|g| g.id == id) {
            Some(g) => g.projects.push(project),
            None => groups.push(Group {
                label: id.clone(),
                id,
                root: None,
                root_id: root_id.clone(),
                root_path: root_path.clone(),
                main,
                scripts: false,
                projects: vec![project],
            }),
        }
    }
    for g in &mut groups {
        g.projects.sort_by_key(|p| p.repo.to_lowercase());
        g.root = task_root(g);
    }
    groups.sort_by_key(|g| (g.main, !is_task_id(&g.id), task_sort_key(&g.id)));
    if !scripts.is_empty() {
        groups.push(Group { id: SCRIPTS_GROUP.into(), label: "Scripts".into(), root: None, root_id, root_path, main: false, scripts: true, projects: scripts });
    }
    groups
}

/// Moves the scripts (apps from a `spawner.json`) out of what was found, so they never sit between worktrees.
/// A script file committed in a repo is taken from its main checkout only, not once per worktree.
fn take_scripts(found: &mut Vec<Found>) -> Vec<Project> {
    let mut projects = Vec::new();
    for f in found.iter_mut() {
        let (scripts, rest): (Vec<AppDef>, Vec<AppDef>) = std::mem::take(&mut f.apps).into_iter().partition(|a| a.kind == detect::scripts::KIND);
        f.apps = rest;
        if !scripts.is_empty() && (f.is_main || f.loose) {
            let path = normalize(&f.path);
            projects.push(Project { id: format!("{path}#scripts"), repo: f.repo.clone(), path, branch: f.branch.clone(), apps: scripts });
        }
    }
    found.retain(|f| !f.apps.is_empty());
    projects.sort_by_key(|p| p.repo.to_lowercase());
    projects
}

fn task_root(g: &Group) -> Option<String> {
    if g.main || !is_task_id(&g.id) {
        return None;
    }
    let mut roots = g.projects.iter().map(|p| {
        let parent = Path::new(&p.path).parent()?;
        (parent.file_name()?.to_string_lossy() == g.id).then(|| normalize(parent))
    });
    let first = roots.next()??;
    roots.all(|r| r.as_deref() == Some(first.as_str())).then_some(first)
}

fn task_sort_key(id: &str) -> (String, std::cmp::Reverse<u64>) {
    match id.split_once('-') {
        Some((prefix, num)) => (prefix.to_lowercase(), std::cmp::Reverse(num.parse().unwrap_or(0))),
        None => (id.to_lowercase(), std::cmp::Reverse(0)),
    }
}

pub fn git_worktree_list(repo: &Path) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["worktree", "list", "--porcelain"]).current_dir(repo);
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

#[derive(Debug, PartialEq)]
pub struct RawWorktree {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub is_main: bool,
}

pub fn parse_worktrees(porcelain: &str) -> Vec<RawWorktree> {
    porcelain
        .replace("\r\n", "\n")
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .enumerate()
        .filter_map(|(i, block)| {
            let mut path = None;
            let mut branch = None;
            let mut prunable = false;
            for line in block.lines() {
                if let Some(p) = line.strip_prefix("worktree ") {
                    path = Some(PathBuf::from(p));
                } else if let Some(b) = line.strip_prefix("branch ") {
                    branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
                } else if line.starts_with("prunable") {
                    prunable = true;
                }
            }
            if prunable {
                return None;
            }
            Some(RawWorktree { path: path?, branch, is_main: i == 0 })
        })
        .collect()
}

fn is_task_id(s: &str) -> bool {
    match s.split_once('-') {
        Some((prefix, num)) => {
            !prefix.is_empty()
                && prefix.chars().all(|c| c.is_ascii_alphabetic())
                && !num.is_empty()
                && num.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

pub fn task_label(path: &Path, branch: Option<&str>) -> Option<String> {
    if let Some(b) = branch.filter(|b| is_task_id(b)) {
        return Some(b.to_string());
    }
    let parent = path.parent()?.file_name()?.to_string_lossy().into_owned();
    is_task_id(&parent).then_some(parent)
}

fn normalize(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn parses_main_and_linked_worktrees() {
        let porcelain = "worktree C:/dev/bill\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/dev/PAYMENT-9483/bill\nHEAD def\nbranch refs/heads/PAYMENT-9483\n\nworktree C:/gone\nHEAD 000\ndetached\nprunable gitdir file points to non-existent location\n";
        let wts = parse_worktrees(porcelain);
        assert_eq!(wts.len(), 2);
        assert!(wts[0].is_main);
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert_eq!(wts[1].branch.as_deref(), Some("PAYMENT-9483"));
        assert!(!wts[1].is_main);
    }

    #[test]
    fn task_comes_from_branch_or_parent_folder() {
        let p = Path::new("C:/dev/PAYMENT-9483/bill");
        assert_eq!(task_label(p, Some("PAYMENT-9483")).as_deref(), Some("PAYMENT-9483"));
        assert_eq!(task_label(p, Some("hotfix")).as_deref(), Some("PAYMENT-9483"));
        assert_eq!(task_label(Path::new("C:/dev/bill"), Some("main")), None);
    }

    fn found(repo: &str, path: &str, branch: &str, is_main: bool) -> Found {
        Found {
            repo: repo.into(),
            path: PathBuf::from(path),
            branch: Some(branch.into()),
            is_main,
            loose: false,
            apps: vec![crate::testutil::app(repo)],
        }
    }

    #[test]
    fn groups_task_worktrees_across_repos_and_pools_main_checkouts() {
        let groups = grouped(vec![
            found("bill", "C:/dev/bill", "main", true),
            found("bill", "C:/dev/PAYMENT-9986/bill", "PAYMENT-9986", false),
            found("account", "C:/dev/account", "main", true),
            found("account", "C:/dev/PAYMENT-9986/account", "feat/refund", false),
            found("bill", "C:/dev/PAYMENT-10000/bill", "PAYMENT-10000", false),
        ]);
        let ids: Vec<_> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["PAYMENT-10000", "PAYMENT-9986", "main"]);
        let task = &groups[1];
        assert_eq!(task.root.as_deref(), Some("C:/dev/PAYMENT-9986"));
        let repos: Vec<_> = task.projects.iter().map(|p| p.repo.as_str()).collect();
        assert_eq!(repos, ["account", "bill"]);
        assert!(groups[2].main && groups[2].root.is_none());
        assert_eq!(groups[2].projects.len(), 2);
    }

    #[test]
    fn task_without_a_task_folder_has_no_t3_root() {
        let groups = grouped(vec![
            found("bill", "D:/elsewhere/bill", "PAYMENT-7", false),
            found("account", "C:/dev/PAYMENT-7/account", "PAYMENT-7", false),
        ]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].root, None);
    }

    #[test]
    fn lone_non_task_worktree_is_its_own_group() {
        let groups = grouped(vec![found("bill", "C:/dev/bill-hotfix", "hotfix/x", false)]);
        assert_eq!(groups[0].id, "hotfix/x");
        assert!(!groups[0].main);
    }

    #[test]
    #[ignore = "scans the real SPAWNER_ROOT (a ';' list; default C:/dev); run with --ignored --nocapture"]
    fn scan_real_root() {
        let value = std::env::var("SPAWNER_ROOT").unwrap_or_else(|_| "C:/dev".into());
        for g in scan_roots(&roots::from_env_value(&value)) {
            println!("{} main={} root={:?}", g.id, g.main, g.root);
            for p in &g.projects {
                let apps: Vec<_> = p.apps.iter().map(|a| format!("{}:{:?}", a.name, a.port)).collect();
                println!("    {} [{}] {}", p.repo, p.branch.as_deref().unwrap_or("-"), apps.join(", "));
            }
        }
    }

    #[test]
    fn group_json_matches_the_shape_the_ui_reads() {
        let groups = grouped(vec![found("bill", "C:/dev/PAYMENT-1/bill", "PAYMENT-1", false)]);
        let json = serde_json::to_value(&groups[0]).unwrap();
        let keys = |v: &serde_json::Value| {
            let mut k: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(keys(&json), ["id", "label", "main", "projects", "root", "rootId", "rootPath", "scripts"]);
        assert_eq!(keys(&json["projects"][0]), ["apps", "branch", "id", "path", "repo"]);
        assert_eq!(json["root"], "C:/dev/PAYMENT-1");
        assert_eq!(json["rootPath"], "C:/dev");
    }

    fn root(path: &str) -> Root {
        Root { path: path.into(), label: None }
    }

    fn grouped(found: Vec<Found>) -> Vec<Group> {
        group_found(found, &root("C:/dev"))
    }

    fn loose(repo: &str, path: &str) -> Found {
        Found { loose: true, branch: None, ..found(repo, path, "", false) }
    }

    #[test]
    fn without_task_worktrees_everything_goes_under_the_root() {
        let groups = group_found(
            vec![found("bill", "C:/dev/bill", "main", true), found("account", "C:/dev/account", "main", true), loose("scripts", "C:/dev/scripts")],
            &Root { path: "C:/dev".into(), label: Some("Work".into()) },
        );
        assert_eq!(groups.len(), 1);
        assert_eq!((groups[0].id.as_str(), groups[0].label.as_str(), groups[0].main), ("Work", "Work", false));
        assert_eq!(groups[0].root_path, "C:/dev");
        let repos: Vec<_> = groups[0].projects.iter().map(|p| p.repo.as_str()).collect();
        assert_eq!(repos, ["account", "bill", "scripts"]);
    }

    fn script_app(name: &str) -> AppDef {
        AppDef { kind: "script".into(), ..crate::testutil::app(name) }
    }

    #[test]
    fn scripts_get_their_own_group_after_the_worktrees_and_only_from_main_checkouts() {
        let with_scripts = |f: Found, script: &str| Found { apps: vec![crate::testutil::app("web"), script_app(script)], ..f };
        let groups = grouped(vec![
            with_scripts(found("bill", "C:/dev/bill", "main", true), "bill tool"),
            with_scripts(found("bill", "C:/dev/PAYMENT-1/bill", "PAYMENT-1", false), "bill tool"),
            Found { apps: vec![script_app("cust")], ..loose("tools", "C:/dev/_tools") },
        ]);
        let ids: Vec<_> = groups.iter().map(|g| (g.id.as_str(), g.scripts)).collect();
        assert_eq!(ids, [("PAYMENT-1", false), ("main", false), ("scripts", true)]);
        assert!(groups.iter().take(2).flat_map(|g| &g.projects).flat_map(|p| &p.apps).all(|a| a.kind != "script"));
        let scripts = &groups[2];
        let listed: Vec<_> = scripts.projects.iter().map(|p| (p.repo.as_str(), p.id.as_str(), p.apps[0].name.as_str())).collect();
        assert_eq!(listed, [("bill", "C:/dev/bill#scripts", "bill tool"), ("tools", "C:/dev/_tools#scripts", "cust")]);
        assert_eq!(scripts.projects[0].path, "C:/dev/bill", "the project path is the folder the commands run from");
    }

    #[test]
    fn a_folder_with_a_spawner_json_is_found_on_disk_as_scripts() {
        let tmp = TempDir::new("scripts");
        tmp.file("dev/_tools/spawner.json", r#"{"scripts":[{"name":"cust monitors","command":["python","cust.py","monitors"]}]}"#);
        let groups = scan_roots(&[root_at(&tmp.path().join("dev"))]);
        let [group] = groups.as_slice() else { panic!("one group: {groups:?}") };
        assert!(group.scripts && group.main == false);
        assert_eq!((group.projects[0].repo.as_str(), group.projects[0].apps[0].name.as_str()), ("_tools", "cust monitors"));
    }

    #[test]
    fn loose_projects_join_the_root_group_next_to_main_and_task_groups() {
        let groups = grouped(vec![
            found("bill", "C:/dev/bill", "main", true),
            found("bill", "C:/dev/PAYMENT-1/bill", "PAYMENT-1", false),
            loose("scripts", "C:/dev/scripts"),
        ]);
        let ids: Vec<_> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["PAYMENT-1", "dev", "main"]);
    }

    #[test]
    fn the_same_task_id_in_two_roots_stays_two_groups_with_unique_ids() {
        let groups = build_groups(vec![
            (
                root("C:/work"),
                vec![
                    found("bill", "C:/work/bill", "main", true),
                    found("bill", "C:/work/PAYMENT-1/bill", "PAYMENT-1", false),
                    found("bill", "C:/work/PAYMENT-2/bill", "PAYMENT-2", false),
                ],
            ),
            (
                root("D:/side"),
                vec![
                    found("shop", "D:/side/shop", "main", true),
                    found("shop", "D:/side/PAYMENT-1/shop", "PAYMENT-1", false),
                ],
            ),
        ]);
        let ids: Vec<_> = groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(
            ids,
            ["PAYMENT-2", "C:/work::PAYMENT-1", "C:/work::main", "D:/side::PAYMENT-1", "D:/side::main"],
            "ids shared by two roots get the root prefix; a unique id keeps its plain form"
        );
        assert!(groups.iter().filter(|g| g.label == "PAYMENT-1").all(|g| g.projects.len() == 1));
        assert_eq!(groups[3].root_path, "D:/side");
        assert_eq!(groups[3].label, "PAYMENT-1");
        let unique: HashSet<_> = groups.iter().map(|g| &g.id).collect();
        assert_eq!(unique.len(), groups.len());
    }

    #[test]
    fn a_project_under_two_overlapping_roots_is_listed_once() {
        let groups = build_groups(vec![
            (root("C:/dev"), vec![found("bill", "C:/dev/bill", "main", true)]),
            (root("C:/dev/bill"), vec![found("bill", "C:/dev/bill", "main", true)]),
        ]);
        assert_eq!(groups.iter().map(|g| g.projects.len()).sum::<usize>(), 1);
    }

    const WEB: &str = r#"<Project Sdk="Microsoft.NET.Sdk.Web"></Project>"#;
    const WORKER: &str = r#"<Project Sdk="Microsoft.NET.Sdk.Worker"></Project>"#;

    fn git(dir: &Path, args: &[&str]) {
        let mut cmd = Command::new("git");
        cmd.args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]).args(args).current_dir(dir);
        no_window(&mut cmd);
        assert!(cmd.output().is_ok_and(|o| o.status.success()), "git {args:?} failed in {}", dir.display());
    }

    fn projects(groups: &[Group]) -> Vec<(String, String)> {
        groups.iter().flat_map(|g| g.projects.iter().map(|p| (g.id.clone(), p.repo.clone()))).collect()
    }

    fn root_at(dir: &Path) -> Root {
        Root { path: dir.to_string_lossy().into_owned(), label: None }
    }

    #[test]
    fn a_plain_folder_is_one_project_named_after_it_and_its_loose_children_are_projects_too() {
        let tmp = TempDir::new("plain");
        let root_dir = tmp.dir("tools");
        tmp.file("tools/Run.csproj", WEB);
        tmp.file("tools/api/Api/Api.csproj", WEB);
        tmp.file("tools/worker/Worker.csproj", WORKER);
        tmp.file("tools/lib/Lib.csproj", r#"<Project Sdk="Microsoft.NET.Sdk"></Project>"#);
        tmp.file("tools/node_modules/x/X.csproj", WEB);
        tmp.file("tools/.hidden/H.csproj", WEB);

        let groups = scan_roots(&[root_at(&root_dir)]);
        assert_eq!(groups.len(), 1, "{:?}", projects(&groups));
        assert_eq!(groups[0].id, "tools");
        assert!(!groups[0].main);
        let by_repo: Vec<_> = groups[0].projects.iter().map(|p| (p.repo.as_str(), p.apps.len())).collect();
        assert_eq!(by_repo, [("api", 1), ("tools", 1), ("worker", 1)]);
        let own = groups[0].projects.iter().find(|p| p.repo == "tools").unwrap();
        assert_eq!(own.apps[0].id, "Run.csproj", "the folder itself only contributes its top level");
        let api = groups[0].projects.iter().find(|p| p.repo == "api").unwrap();
        assert_eq!(api.apps[0].id, "Api/Api.csproj");
        assert!(api.branch.is_none());
    }

    #[test]
    fn a_git_repo_can_be_a_root() {
        let tmp = TempDir::new("repo-root");
        let repo = tmp.dir("bill");
        tmp.file("bill/src/Bill.csproj", WEB);
        git(&repo, &["init", "-q"]);

        let groups = scan_roots(&[Root { path: repo.to_string_lossy().into_owned(), label: Some("Billing".into()) }]);
        assert_eq!(projects(&groups), [("Billing".to_string(), "bill".to_string())]);
        assert_eq!(groups[0].projects[0].apps[0].id, "src/Bill.csproj");
        assert!(groups[0].projects[0].path.ends_with("/bill"));
    }

    #[test]
    fn a_folder_of_repos_groups_task_worktrees_and_keeps_task_folders_out_of_the_loose_scan() {
        let tmp = TempDir::new("repos");
        let shop = tmp.dir("dev/shop");
        let bill = tmp.dir("dev/bill");
        tmp.file("dev/shop/Shop.csproj", WEB);
        tmp.file("dev/bill/Bill.csproj", WEB);
        tmp.file("dev/scripts/Job.csproj", WORKER);
        for repo in [&shop, &bill] {
            git(repo, &["init", "-q"]);
            git(repo, &["add", "."]);
            git(repo, &["commit", "-q", "-m", "init"]);
        }
        tmp.dir("dev/PAYMENT-7");
        let wt = tmp.path().join("dev/PAYMENT-7/shop");
        git(&shop, &["worktree", "add", "-q", "-b", "PAYMENT-7", &wt.to_string_lossy()]);

        let groups = scan_roots(&[root_at(&tmp.path().join("dev"))]);
        assert_eq!(
            projects(&groups),
            [
                ("PAYMENT-7".to_string(), "shop".to_string()),
                ("dev".to_string(), "scripts".to_string()),
                ("main".to_string(), "bill".to_string()),
                ("main".to_string(), "shop".to_string()),
            ],
            "task worktree, loose folder under the root group, both main checkouts; nothing twice"
        );
        assert!(groups[0].root.as_deref().is_some_and(|r| r.ends_with("/dev/PAYMENT-7")));
        let all: Vec<_> = groups.iter().flat_map(|g| g.projects.iter().map(|p| p.id.clone())).collect();
        assert_eq!(all.len(), all.iter().collect::<HashSet<_>>().len(), "project ids are unique");
    }

    #[test]
    fn a_stray_git_init_in_a_workspace_folder_does_not_hide_the_repos_and_task_worktrees_inside() {
        let tmp = TempDir::new("stray-git");
        let dev = tmp.dir("dev");
        let shop = tmp.dir("dev/shop");
        tmp.file("dev/shop/Shop.csproj", WEB);
        git(&dev, &["init", "-q"]);
        git(&shop, &["init", "-q"]);
        git(&shop, &["add", "."]);
        git(&shop, &["commit", "-q", "-m", "init"]);
        tmp.dir("dev/PAYMENT-7");
        let wt = tmp.path().join("dev/PAYMENT-7/shop");
        git(&shop, &["worktree", "add", "-q", "-b", "PAYMENT-7", &wt.to_string_lossy()]);

        let groups = scan_roots(&[root_at(&dev)]);
        assert_eq!(projects(&groups), [("PAYMENT-7".to_string(), "shop".to_string()), ("main".to_string(), "shop".to_string())]);
        assert!(groups.iter().flat_map(|g| &g.projects).all(|p| p.apps.len() == 1), "no app is listed twice");
    }

    #[test]
    fn missing_or_file_roots_scan_to_nothing() {
        let tmp = TempDir::new("missing");
        let file = tmp.file("x.txt", "x");
        let roots = [root_at(&tmp.path().join("nope")), root_at(&file)];
        assert!(scan_roots(&roots).is_empty());
        assert!(scan_roots(&[]).is_empty());
    }
}
