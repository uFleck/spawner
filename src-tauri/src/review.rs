//! The open pull requests of the repos Spawner knows, read once per repo with `gh` and cached for a minute.
//!
//! The rail lists worktrees with an open PR first, so each check needs a number, a title, the branch (matched against a
//! worktree's checkout), the review decision and a checks summary. This is read-only: Spawner never comments, reviews
//! or merges, and a missing or failing `gh` is an error the rail shows in its own section, never a panic.

use crate::model::Group;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::process::{Command, Output};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long one repo's answer is reused, so a window that refreshes on focus does not start `gh` again.
const CACHE_TTL: Duration = Duration::from_secs(60);
/// `gh` is a process start on Windows plus a network round trip; past this the call counts as failed.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// Names of failing checks kept for the row; past a handful the list says nothing more.
const FAILING_NAMES: usize = 5;
/// The fields asked of `gh pr list`, in one call per repo.
const FIELDS: &str = "number,title,headRefName,isDraft,reviewDecision,statusCheckRollup,url";

#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Checks {
    pub pass: u32,
    pub fail: u32,
    pub pending: u32,
    pub failing: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    /// The local repo the PR came from (the folder name of its checkout).
    pub repo: String,
    /// `owner/repo` from the git remote.
    pub slug: String,
    pub number: u64,
    pub title: String,
    pub head: String,
    pub draft: bool,
    /// `"approved"`, `"changes"`, `"pending"`, or null when GitHub reports no decision.
    pub review: Option<String>,
    pub url: String,
    pub checks: Checks,
}

/// What the rail gets: the PRs of the repos that answered, and why the others did not. One broken repo must not hide
/// the worktrees of the rest.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrFeed {
    pub prs: Vec<Pr>,
    pub errors: Vec<String>,
}

type Cache = HashMap<String, (Instant, Vec<Pr>)>;

/// Keyed by the checkout path the answer was read from.
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// The `(repo, path)` pairs to ask `gh` about: one per repo, preferring a main checkout, since the slug comes from the
/// remote and a worktree is as good as any other only until it is removed. One entry per repo also keeps a repo with
/// several worktrees from listing the same PRs twice.
pub fn checkouts(groups: &[Group]) -> Vec<(String, String)> {
    let mut repos: Vec<(String, String)> = Vec::new();
    let mut main_paths: HashMap<String, String> = HashMap::new();
    for group in groups {
        for project in &group.projects {
            let key = project.repo.to_lowercase();
            if group.main {
                main_paths.entry(key).or_insert_with(|| project.path.clone());
            }
            if !repos.iter().any(|(repo, _)| repo.eq_ignore_ascii_case(&project.repo)) {
                repos.push((project.repo.clone(), project.path.clone()));
            }
        }
    }
    for (repo, path) in repos.iter_mut() {
        if let Some(main) = main_paths.get(&repo.to_lowercase()) {
            *path = main.clone();
        }
    }
    repos
}

/// The open PRs of every checkout, in the order the repos are given. `force` skips the cache. A repo whose checkout
/// has no GitHub remote is skipped (a loose folder is not a repo). The repos are asked in parallel: a dozen `gh`
/// processes in a row would hold the rail for ten seconds. A failed repo is reported in `errors`, never as a whole
/// blank rail.
pub fn open_prs(checkouts: &[(String, String)], force: bool) -> PrFeed {
    let answers: Vec<(String, Vec<Pr>, Option<String>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = checkouts
            .iter()
            .map(|(repo, path)| {
                scope.spawn(move || {
                    let prs = if force { None } else { cached(path) };
                    if let Some(prs) = prs {
                        return (repo.clone(), prs, None);
                    }
                    let Some(slug) = slug_of(path) else { return (repo.clone(), Vec::new(), None) };
                    match prs_of(repo, &slug) {
                        Ok(prs) => {
                            remember(path, &prs);
                            (repo.clone(), prs, None)
                        }
                        Err(e) => (repo.clone(), Vec::new(), Some(e)),
                    }
                })
            })
            .collect();
        handles.into_iter().filter_map(|handle| handle.join().ok()).collect()
    });
    let mut feed = PrFeed { prs: Vec::new(), errors: Vec::new() };
    for (_, prs, error) in answers {
        feed.prs.extend(prs);
        if let Some(error) = error {
            feed.errors.push(error);
        }
    }
    feed
}

fn key(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn cached(path: &str) -> Option<Vec<Pr>> {
    let cache = CACHE.lock().ok()?;
    let (at, prs) = cache.as_ref()?.get(&key(path))?;
    (at.elapsed() < CACHE_TTL).then(|| prs.clone())
}

fn remember(path: &str, prs: &[Pr]) {
    let Ok(mut cache) = CACHE.lock() else { return };
    cache.get_or_insert_with(HashMap::new).insert(key(path), (Instant::now(), prs.to_vec()));
}

/// `owner/repo` from the checkout's `origin`. `None` for a folder that is not a checkout of a GitHub repo, so one
/// loose folder in the scan does not hide every PR.
fn slug_of(path: &str) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["-C", path, "remote", "get-url", "origin"]);
    no_window(&mut cmd);
    match run(cmd, CALL_TIMEOUT) {
        Ok(out) if out.status.success() => parse_slug(&String::from_utf8_lossy(&out.stdout)),
        _ => None,
    }
}

/// `git@github.com:owner/repo.git`, `https://github.com/owner/repo.git` and `ssh://git@host/owner/repo` all give
/// `owner/repo`. Anything without a host and two path segments is not a slug.
pub fn parse_slug(remote: &str) -> Option<String> {
    let remote = remote.trim();
    let remote = remote.strip_suffix(".git").unwrap_or(remote);
    let remote = remote.trim_end_matches('/');
    // scp-like (`git@host:owner/repo`) has no scheme, and its path starts after the first colon. A single letter before
    // the colon is a Windows drive, not a host (`C:/dev/bill`).
    let path = match remote.split_once("://") {
        Some((_, rest)) => rest.split_once('/').map(|(_, path)| path)?,
        None => {
            let (host, path) = remote.split_once(':')?;
            if host.len() < 2 {
                return None;
            }
            path
        }
    };
    let mut segments = path.split('/').filter(|s| !s.is_empty());
    let owner = segments.next()?;
    let repo = segments.next()?;
    Some(format!("{owner}/{repo}"))
}

fn prs_of(repo: &str, slug: &str) -> Result<Vec<Pr>, String> {
    let mut cmd = Command::new("gh");
    cmd.args(["pr", "list", "--repo", slug, "--state", "open", "--limit", "50", "--json", FIELDS]);
    no_window(&mut cmd);
    let out = run(cmd, CALL_TIMEOUT).map_err(|failure| match failure {
        Failure::Missing => "gh was not found: install the GitHub CLI and run `gh auth login`".to_string(),
        Failure::Message(e) => format!("gh for {slug}: {e}"),
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let line = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("it failed");
        return Err(format!("gh pr list failed for {slug}: {line}"));
    }
    let value: Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("gh returned unexpected JSON for {slug}: {e}"))?;
    let items = value.as_array().ok_or_else(|| format!("gh returned no list of pull requests for {slug}"))?;
    Ok(items.iter().filter_map(|item| pr_from(repo, slug, item)).collect())
}

/// One entry of `gh pr list`. An entry without a number or a url is skipped: the row would have nothing to open.
fn pr_from(repo: &str, slug: &str, value: &Value) -> Option<Pr> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let number = value.get("number").and_then(Value::as_u64)?;
    let url = text("url");
    if url.is_empty() {
        return None;
    }
    let rollup: &[Value] = match value.get("statusCheckRollup").and_then(Value::as_array) {
        Some(items) => items,
        None => &[],
    };
    Some(Pr {
        repo: repo.to_string(),
        slug: slug.to_string(),
        number,
        title: text("title"),
        head: text("headRefName"),
        draft: value.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        review: review_state(value.get("reviewDecision").and_then(Value::as_str)),
        url,
        checks: checks_of(rollup),
    })
}

/// `gh`'s review decision as the rail shows it.
fn review_state(decision: Option<&str>) -> Option<String> {
    let decision = decision?.trim();
    if decision.is_empty() {
        return None;
    }
    let shown = match decision.to_ascii_uppercase().as_str() {
        "APPROVED" => "approved",
        "CHANGES_REQUESTED" => "changes",
        _ => "pending",
    };
    Some(shown.to_string())
}

enum Verdict {
    Pass,
    Fail,
    Pending,
}

/// A check run reports a conclusion only once it is done; a commit status reports a state (`context`/`state`) and has
/// no conclusion at all.
fn verdict(status: &str) -> Verdict {
    match status.to_ascii_uppercase().as_str() {
        "SUCCESS" | "NEUTRAL" | "SKIPPED" => Verdict::Pass,
        "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" => Verdict::Fail,
        _ => Verdict::Pending,
    }
}

fn checks_of(rollup: &[Value]) -> Checks {
    let mut checks = Checks::default();
    for entry in rollup {
        let status = entry
            .get("conclusion")
            .and_then(Value::as_str)
            .or_else(|| entry.get("state").and_then(Value::as_str))
            .unwrap_or("");
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| entry.get("context").and_then(Value::as_str))
            .unwrap_or("");
        match verdict(status) {
            Verdict::Pass => checks.pass += 1,
            Verdict::Pending => checks.pending += 1,
            Verdict::Fail => {
                checks.fail += 1;
                if checks.failing.len() < FAILING_NAMES {
                    checks.failing.push(name.to_string());
                }
            }
        }
    }
    checks
}

enum Failure {
    /// The program is not on `PATH`.
    Missing,
    Message(String),
}

/// Runs a command with a deadline. The child cannot be killed from here, so a call that runs past it is abandoned and
/// failed: `gh` and `git` both give up on their own, and one slow repo must not hold the rail.
fn run(mut cmd: Command, timeout: Duration) -> Result<Output, Failure> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(cmd.output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Err(Failure::Missing),
        Ok(Err(e)) => Err(Failure::Message(e.to_string())),
        Err(_) => Err(Failure::Message(format!("no answer within {}s", timeout.as_secs()))),
    }
}

fn no_window(cmd: &mut Command) {
    crate::discovery::no_window(cmd);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Project;
    use serde_json::json;

    #[test]
    fn a_github_remote_gives_owner_and_repo() {
        for remote in [
            "git@github.com:umbler/bill.git",
            "git@github.com:umbler/bill",
            "https://github.com/umbler/bill.git",
            "https://github.com/umbler/bill",
            "ssh://git@github.com/umbler/bill.git",
            "ssh://git@github.com:22/umbler/bill.git",
            "  https://github.com/umbler/bill/  ",
        ] {
            assert_eq!(parse_slug(remote).as_deref(), Some("umbler/bill"), "{remote}");
        }
        assert_eq!(parse_slug("https://dev.azure.com/org/project/_git/bill").as_deref(), Some("org/project"));
        for remote in ["", "C:/dev/bill", "D:\\dev\\bill", "https://github.com/umbler"] {
            assert_eq!(parse_slug(remote), None, "{remote}");
        }
    }

    #[test]
    fn the_review_decision_maps_to_the_three_states_the_rail_shows() {
        assert_eq!(review_state(Some("APPROVED")).as_deref(), Some("approved"));
        assert_eq!(review_state(Some("CHANGES_REQUESTED")).as_deref(), Some("changes"));
        assert_eq!(review_state(Some("REVIEW_REQUIRED")).as_deref(), Some("pending"));
        assert_eq!(review_state(Some("")), None);
        assert_eq!(review_state(None), None);
    }

    /// The shape `gh pr list --json ...` returns, cut to the fields Spawner reads.
    const GH_LIST: &str = r#"[
        {"number":1720,"title":"PAYMENT-10138 fix the refund total","headRefName":"PAYMENT-10138","isDraft":false,
         "reviewDecision":"APPROVED","url":"https://github.com/umbler/account/pull/1720",
         "statusCheckRollup":[
            {"__typename":"CheckRun","name":"build","conclusion":"SUCCESS","status":"COMPLETED"},
            {"__typename":"CheckRun","name":"tests","conclusion":"SKIPPED","status":"COMPLETED"},
            {"__typename":"CheckRun","name":"lint","conclusion":"NEUTRAL","status":"COMPLETED"},
            {"__typename":"StatusContext","context":"ci/e2e","state":"SUCCESS"}
         ]},
        {"number":1736,"title":"PAYMENT-10277 send the receipt once","headRefName":"PAYMENT-10277","isDraft":false,
         "reviewDecision":"CHANGES_REQUESTED","url":"https://github.com/umbler/account/pull/1736",
         "statusCheckRollup":[
            {"__typename":"CheckRun","name":"tests","conclusion":"FAILURE","status":"COMPLETED"},
            {"__typename":"CheckRun","name":"e2e","conclusion":"TIMED_OUT","status":"COMPLETED"},
            {"__typename":"CheckRun","name":"glossary","conclusion":"ACTION_REQUIRED","status":"COMPLETED"},
            {"__typename":"StatusContext","context":"ci/legacy","state":"ERROR"},
            {"__typename":"CheckRun","name":"one-too-many","conclusion":"CANCELLED","status":"COMPLETED"},
            {"__typename":"CheckRun","name":"deploy","conclusion":null,"status":"IN_PROGRESS"},
            {"__typename":"StatusContext","context":"ci/pending","state":"PENDING"}
         ]},
        {"number":1734,"title":"PAYMENT-10264 spike the invoice list","headRefName":"PAYMENT-10264","isDraft":true,
         "reviewDecision":null,"url":"https://github.com/umbler/account/pull/1734","statusCheckRollup":[]},
        {"number":0,"title":"no url","headRefName":"x","url":""}
    ]"#;

    fn listed() -> Vec<Pr> {
        let items: Vec<Value> = serde_json::from_str(GH_LIST).unwrap();
        items.iter().filter_map(|item| pr_from("account", "umbler/account", item)).collect()
    }

    #[test]
    fn a_listed_pull_request_carries_what_the_rail_and_the_header_need() {
        let prs = listed();
        assert_eq!(prs.len(), 3, "an entry without a url is skipped");
        let first = &prs[0];
        assert_eq!(
            (first.repo.as_str(), first.slug.as_str(), first.number, first.title.as_str(), first.head.as_str()),
            ("account", "umbler/account", 1720, "PAYMENT-10138 fix the refund total", "PAYMENT-10138")
        );
        assert_eq!((first.draft, first.review.as_deref()), (false, Some("approved")));
        assert_eq!(first.url, "https://github.com/umbler/account/pull/1720");
        assert_eq!(prs[1].review.as_deref(), Some("changes"));
        assert_eq!((prs[2].draft, prs[2].review.as_deref()), (true, None));
    }

    #[test]
    fn checks_are_counted_and_the_failing_names_are_capped() {
        assert_eq!(listed()[0].checks, Checks { pass: 4, fail: 0, pending: 0, failing: Vec::new() });

        let failing = &listed()[1].checks;
        assert_eq!((failing.pass, failing.fail, failing.pending), (0, 5, 2), "a null conclusion is pending: {failing:?}");
        assert_eq!(failing.failing, ["tests", "e2e", "glossary", "ci/legacy", "one-too-many"], "capped at five names");
        assert_eq!(listed()[2].checks, Checks::default());
    }

    #[test]
    fn one_repo_is_asked_about_once_and_main_checkouts_are_preferred() {
        let project = |path: &str, repo: &str| Project { id: path.into(), repo: repo.into(), path: path.into(), branch: None, apps: Vec::new() };
        let group = |id: &str, main: bool, projects: Vec<Project>| Group {
            id: id.into(),
            label: id.into(),
            root: None,
            root_id: "c:/dev".into(),
            root_path: "C:/dev".into(),
            main,
            projects,
        };
        let groups = vec![
            group("PAYMENT-1", false, vec![project("C:/dev/PAYMENT-1/bill", "bill"), project("C:/dev/PAYMENT-1/shop", "shop")]),
            group("main", true, vec![project("C:/dev/bill", "bill")]),
        ];
        let found = checkouts(&groups);
        assert_eq!(found, [("bill".to_string(), "C:/dev/bill".to_string()), ("shop".to_string(), "C:/dev/PAYMENT-1/shop".to_string())]);
    }

    #[test]
    fn a_rollup_that_is_not_a_list_counts_nothing() {
        let items: Vec<Value> = serde_json::from_value(json!([{"number": 1, "url": "u", "statusCheckRollup": "bad"}])).unwrap();
        let pr = pr_from("r", "o/r", &items[0]).expect("a number and a url are enough");
        assert_eq!(pr.checks, Checks::default());
        assert_eq!(pr.review, None);
    }
}
