//! Helpers for the in-app setup guide: detect Claude Code and wire Hub's MCP server into it.

use crate::discovery::no_window;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const SERVER_NAME: &str = "spawner";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub installed: bool,
    pub version: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum LinkStatus {
    Connected,
    Failing { detail: String },
    /// Claude Code has the server, but under a URL Hub no longer listens on.
    Stale { configured: String },
    Missing,
}

struct Ran {
    ok: bool,
    text: String,
}

fn run_claude(args: &[&str], timeout: Duration) -> Result<Ran, String> {
    run_claude_with(args, timeout, None, None)
}

/// `stdin` carries a prompt, which avoids `cmd.exe` quoting for text with newlines and quotes.
fn run_claude_with(args: &[&str], timeout: Duration, stdin: Option<&str>, cwd: Option<&Path>) -> Result<Ran, String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", "claude"]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new("claude");
    cmd.args(args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not run claude: {e}"))?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(text.as_bytes()).map_err(|e| format!("could not send the prompt to claude: {e}"))?;
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return Err("claude did not answer in time".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let mut text = String::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_string(&mut text);
    }
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut text);
    }
    Ok(Ran { ok: status.success(), text })
}

fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

pub fn parse_version(ok: bool, text: &str) -> ClaudeStatus {
    let line = first_line(text);
    if ok && !line.is_empty() {
        ClaudeStatus { installed: true, version: Some(line) }
    } else {
        ClaudeStatus { installed: false, version: None }
    }
}

pub fn parse_link(ok: bool, text: &str, expected_url: &str) -> LinkStatus {
    if !ok {
        return if text.contains("No MCP server named") || text.trim().is_empty() {
            LinkStatus::Missing
        } else {
            LinkStatus::Failing { detail: first_line(text) }
        };
    }
    let configured = text.lines().map(str::trim).find_map(|l| l.strip_prefix("URL:")).map(str::trim);
    if let Some(url) = configured.filter(|u| !expected_url.is_empty() && *u != expected_url) {
        return LinkStatus::Stale { configured: url.to_string() };
    }
    match text.lines().map(str::trim).find_map(|l| l.strip_prefix("Status:")) {
        Some(status) if status.contains("Connected") => LinkStatus::Connected,
        Some(status) => LinkStatus::Failing { detail: status.trim().to_string() },
        None => LinkStatus::Failing { detail: "Claude Code did not report a status".into() },
    }
}

pub fn check_claude() -> ClaudeStatus {
    match run_claude(&["--version"], Duration::from_secs(15)) {
        Ok(ran) => parse_version(ran.ok, &ran.text),
        Err(_) => ClaudeStatus { installed: false, version: None },
    }
}

/// `claude mcp get` health-checks the server as a real MCP client, so "Connected" proves the whole path.
pub fn link_status(expected_url: &str) -> Result<LinkStatus, String> {
    let ran = run_claude(&["mcp", "get", SERVER_NAME], Duration::from_secs(40))?;
    Ok(parse_link(ran.ok, &ran.text, expected_url))
}

/// Pre-rename server name; removed best-effort on connect so the old entry does not linger next to the new one.
const LEGACY_SERVER_NAME: &str = "umbler-hub";

pub fn connect(url: &str) -> Result<(), String> {
    let _ = run_claude(&["mcp", "remove", LEGACY_SERVER_NAME, "--scope", "user"], Duration::from_secs(30));
    let _ = run_claude(&["mcp", "remove", SERVER_NAME, "--scope", "user"], Duration::from_secs(30));
    let ran = run_claude(
        &["mcp", "add", "--transport", "http", "--scope", "user", SERVER_NAME, url],
        Duration::from_secs(30),
    )?;
    if ran.ok { Ok(()) } else { Err(first_line(&ran.text)) }
}

fn claude_config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| {
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default();
        home.join(".claude")
    })
}

/// Puts `snippet` into `existing`. A section that starts with the same heading is replaced, so running this twice never duplicates it.
fn merge_guidance(existing: &str, snippet: &str) -> String {
    let crlf = existing.contains("\r\n");
    let existing = existing.replace("\r\n", "\n");
    let heading = snippet.lines().next().unwrap_or("").trim();
    let level = heading.chars().take_while(|c| *c == '#').count();
    let lines: Vec<&str> = existing.lines().collect();
    let mut fenced = false;
    let mut start = None;
    let mut end = lines.len();
    for (i, line) in lines.iter().enumerate() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        }
        if fenced {
            continue;
        }
        match start {
            None if line.trim_end() == heading => start = Some(i),
            Some(_) => {
                let depth = line.chars().take_while(|c| *c == '#').count();
                if depth > 0 && depth <= level && line.chars().nth(depth) == Some(' ') {
                    end = i;
                    break;
                }
            }
            None => {}
        }
    }
    let mut out = String::new();
    match start {
        Some(s) => {
            let before = lines[..s].join("\n").trim_end().to_string();
            let after = lines[end..].join("\n");
            if !before.is_empty() {
                out.push_str(&before);
                out.push_str("\n\n");
            }
            out.push_str(snippet);
            out.push('\n');
            if !after.is_empty() {
                out.push('\n');
                out.push_str(&after);
                out.push('\n');
            }
        }
        None => {
            let trimmed = existing.trim_end();
            if !trimmed.is_empty() {
                out.push_str(trimmed);
                out.push_str("\n\n");
            }
            out.push_str(snippet);
            out.push('\n');
        }
    }
    if crlf { out.replace('\n', "\r\n") } else { out }
}

/// Writes the guidance into the user's CLAUDE.md directly. Having a `claude -p` child do it fails, because Claude Code
/// treats `~/.claude/CLAUDE.md` as a sensitive file and refuses edits there even with `acceptEdits`.
pub fn add_guidance(snippet: &str) -> Result<String, String> {
    let snippet = snippet.trim();
    if snippet.is_empty() || snippet.len() > 4_000 {
        return Err("nothing to add".into());
    }
    let dir = claude_config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not open {}: {e}", dir.display()))?;
    let file = dir.join("CLAUDE.md");
    let existing = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("could not read {}: {e}", file.display())),
    };
    let merged = merge_guidance(&existing, snippet);
    if merged == existing {
        return Ok(format!("{} already has this section.", file.display()));
    }
    std::fs::write(&file, merged).map_err(|e| format!("could not write {}: {e}", file.display()))?;
    Ok(format!("Added the section to {}.", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_needs_a_clean_exit_and_some_output() {
        assert_eq!(parse_version(true, "2.1.303 (Claude Code)\n").version.as_deref(), Some("2.1.303 (Claude Code)"));
        assert!(!parse_version(false, "'claude' is not recognized").installed);
        assert!(!parse_version(true, "  \n").installed);
    }

    #[test]
    fn link_status_reads_what_claude_mcp_get_prints() {
        let connected = "spawner:\n  Scope: User config\n  Status: \u{2714} Connected\n  Type: http\n";
        assert_eq!(parse_link(true, connected, ""), LinkStatus::Connected);
        let failing = "spawner:\n  Status: \u{2717} Failed to connect\n";
        assert_eq!(parse_link(true, failing, ""), LinkStatus::Failing { detail: "\u{2717} Failed to connect".into() });
        let missing = "No MCP server named \"spawner\". Configured servers: a, b";
        assert_eq!(parse_link(false, missing, ""), LinkStatus::Missing);
        assert!(matches!(parse_link(true, "spawner:\n  Scope: User\n", ""), LinkStatus::Failing { .. }));
    }

    #[test]
    fn a_url_that_differs_from_the_live_one_is_stale_even_if_the_status_looks_fine() {
        let text = "spawner:\n  Status: \u{2714} Connected\n  URL: http://127.0.0.1:47821/mcp\n";
        assert_eq!(
            parse_link(true, text, "http://127.0.0.1:47830/mcp"),
            LinkStatus::Stale { configured: "http://127.0.0.1:47821/mcp".into() }
        );
        assert_eq!(parse_link(true, text, "http://127.0.0.1:47821/mcp"), LinkStatus::Connected);
    }

    #[test]
    fn link_status_serializes_with_a_state_tag() {
        let json = serde_json::to_value(LinkStatus::Failing { detail: "x".into() }).unwrap();
        assert_eq!(json, serde_json::json!({"state": "failing", "detail": "x"}));
        assert_eq!(serde_json::to_value(LinkStatus::Missing).unwrap(), serde_json::json!({"state": "missing"}));
    }

    const SNIPPET: &str = "## Running apps\nUse hub_start.";

    #[test]
    fn guidance_is_appended_to_a_file_without_the_section() {
        assert_eq!(merge_guidance("", SNIPPET), "## Running apps\nUse hub_start.\n");
        assert_eq!(merge_guidance("# Notes\nhi\n", SNIPPET), "# Notes\nhi\n\n## Running apps\nUse hub_start.\n");
    }

    #[test]
    fn guidance_replaces_its_own_section_and_nothing_else() {
        let old = "# Top\n\n## Running apps\nold text\n\n## Other\nkeep me\n";
        let new = merge_guidance(old, SNIPPET);
        assert_eq!(new, "# Top\n\n## Running apps\nUse hub_start.\n\n## Other\nkeep me\n");
        assert_eq!(merge_guidance(&new, SNIPPET), new, "running it twice changes nothing");
    }

    #[test]
    fn guidance_ignores_headings_inside_code_fences_and_keeps_line_endings() {
        let old = "## Running apps\r\nold\r\n```\r\n# not a heading\r\n```\r\n## Next\r\nx\r\n";
        assert_eq!(merge_guidance(old, SNIPPET), "## Running apps\r\nUse hub_start.\r\n\r\n## Next\r\nx\r\n");
    }

    #[test]
    fn empty_or_oversized_guidance_is_refused_before_claude_runs() {
        assert!(add_guidance("   ").is_err());
        assert!(add_guidance(&"x".repeat(4_001)).is_err());
    }

    #[test]
    #[ignore = "makes one tiny claude call over stdin, edits nothing"]
    fn claude_answers_a_prompt_sent_over_stdin() {
        let ran = run_claude_with(&["-p", "--allowedTools", "Read"], Duration::from_secs(120), Some("Reply with exactly the word: pong"), None).unwrap();
        println!("{}", ran.text);
        assert!(ran.ok && ran.text.to_lowercase().contains("pong"), "{}", ran.text);
    }

    #[test]
    #[ignore = "runs the installed claude CLI (read-only: --version and mcp get)"]
    fn reads_the_real_claude_cli() {
        let status = check_claude();
        println!("{status:?}");
        assert!(status.installed, "claude is not on PATH");
        let link = link_status("http://127.0.0.1:47821/mcp").unwrap();
        println!("{link:?}");
    }
}
