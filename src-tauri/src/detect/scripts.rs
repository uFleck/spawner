//! Scripts: a `spawner.json` declares the user's own commands (a Python tool, a PowerShell helper) as named apps.
//! They run as tasks by default, are listed apart from the worktrees (see `discovery`), and are what an AI agent
//! is taught to write when asked to make a script show up in Spawner (the `hub_script_guide` MCP tool serves `GUIDE`).
//!
//! The file lists `scripts`, each with a `name` and a `command`. A malformed file is reported as one failing
//! `spawner.json (invalid)` app that carries the parse error, so whoever wrote it sees what to fix.

use super::node::{cwd_of, join_rel, rel};
use super::{Claim, Detector};
use crate::model::{AppDef, AppMode, Param, ParamKind, Program, StepSpec};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

pub const FILE: &str = "spawner.json";
pub const KIND: &str = "script";

/// What an agent needs to declare a script. Served verbatim by `hub_script_guide`, after the folders Spawner scans.
pub const GUIDE: &str = r#"A script shows up in Spawner when a `spawner.json` next to it declares it. Spawner then lists it under "Scripts" (apart from the worktrees), runs it with hub_start, and shows its output in the log pane, so the user watches it run.

1. Put `spawner.json` in the folder that holds the scripts. That folder must be inside a folder Spawner scans (listed below).
2. Write it like this:

{
  "scripts": [
    {
      "name": "cust monitors",
      "command": ["python", "cust.py", "monitors"],
      "description": "Counts and ids of the global Bill monitor lists."
    },
    {
      "name": "cust snapshot",
      "command": ["python", "cust.py", "snapshot"],
      "description": "State of one customer's billing account.",
      "params": [
        { "name": "who", "required": true, "hint": "Email, walletId or appUserId of the customer", "placeholder": "ana@example.com" },
        { "name": "out", "flag": "--out", "hint": "Write the snapshot to this file instead of the log", "placeholder": "snapshot.json" },
        { "name": "env", "flag": "--env", "options": ["prod", "staging"], "default": "staging", "hint": "Which environment to read" },
        { "name": "verbose", "type": "flag", "flag": "-v", "hint": "Print every request" }
      ]
    }
  ]
}

Fields (anything else is rejected, so a typo is reported):
- name (required): unique in the file. The user and hub_start select the script by it.
- command (required): the program and its arguments, as a list (`["python", "cust.py", "monitors"]`) or one string (`"python cust.py monitors"`, quotes group words). Use `python`, never `python3`, on Windows.
- cwd: where it runs, relative to the folder of `spawner.json`. Default is that folder.
- description: one line on what it does.
- params: the arguments the script takes, when a fixed command is not enough (see below).
- usage: free text on extra arguments, for a script whose arguments are not worth declaring as `params`. An agent passes them as `args` to hub_start, and they are appended to `command`. Prefer `params`.
- mode: "task" (default) runs to its end and reports the exit code; "service" keeps running until stopped.
- ready: for a service, output fragments that mean it is up (a service without any is running as soon as it starts).
- port: for a service that listens on a fixed port.

Declare every argument as a param. When the user runs the script in Spawner, a form asks for each param, showing its `hint`, and the script does not start while a required one is empty. Without params the user would only learn what the script needs from its failure. Fields of a param:
- name (required): letters, digits, `_` and `-`; unique in the script. hub_start passes values under it.
- hint: what to enter, shown under the field. Say what the value is and where it comes from, not just its name.
- placeholder: an example value, shown inside the empty field.
- flag: the option that introduces the value (`--out`). Without a flag the value is a positional argument. A flag ending in `=` (`--out=`) is joined to the value into one argument.
- type: "text" (default), or "flag" for an on/off switch that adds its `flag` when on.
- options: the allowed values, offered as a choice (text only).
- required: true when the script cannot run without a value. Not for flags, and not together with `default`.
- default: used when the value is left empty. For a flag, `true` means on.

The params become arguments in the order they are declared, after `command`; an empty optional one adds nothing. List positional params in the order the script reads them.

Rules for a script that suits Spawner:
- Print what it does to stdout and its problems to stderr; the log pane is the user's view of it.
- Exit 0 on success and nonzero on failure, since that is what Spawner reports.
- Do not read from stdin: nothing answers it. Take input as arguments.
- Do not put secrets in `spawner.json`; it is read by the UI and can be committed.

3. Call hub_rescan, then hub_list_apps (worktree "scripts") to see it. A broken file is listed as `spawner.json (invalid)` with the error in `description`. Fix it and rescan.
4. Run it with hub_start, with app set to the script's name and `params` set to an object of values by param name (`{"who": "ana@example.com", "verbose": "true"}`). A missing required param is refused before the script starts. Read the result there or with hub_logs. hub_list_apps shows each script's params."#;

pub struct Scripts;

impl Detector for Scripts {
    fn name(&self) -> &'static str {
        "scripts"
    }

    /// Never claims the folder: scripts can sit next to a package or a .NET project.
    fn detect(&self, dir: &Path, root: &Path, out: &mut Vec<AppDef>) -> Claim {
        let Ok(text) = std::fs::read_to_string(dir.join(FILE)) else { return Claim::None };
        let rel_dir = rel(root, dir);
        match parse(&text, &rel_dir) {
            Ok(apps) => out.extend(apps),
            Err(error) => out.push(invalid(&rel_dir, &error)),
        }
        Claim::None
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    scripts: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Command {
    Line(String),
    Argv(Vec<String>),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    name: String,
    command: Command,
    cwd: Option<String>,
    description: Option<String>,
    usage: Option<String>,
    #[serde(default)]
    params: Vec<ParamEntry>,
    mode: Option<AppMode>,
    #[serde(default)]
    ready: Vec<String>,
    port: Option<u16>,
}

/// A default may be written as a string, or as `true`/`false` for a flag.
#[derive(Deserialize)]
#[serde(untagged)]
enum DefaultValue {
    Bool(bool),
    Text(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ParamEntry {
    name: String,
    #[serde(rename = "type", default)]
    kind: ParamKind,
    hint: Option<String>,
    placeholder: Option<String>,
    flag: Option<String>,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    required: bool,
    default: Option<DefaultValue>,
}

fn param_def(entry: ParamEntry, script: &str) -> Result<Param, String> {
    let name = entry.name.trim().to_string();
    let bad = |what: &str| Err(format!("script \"{script}\": parameter \"{name}\" {what}"));
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(format!("script \"{script}\": a parameter name must be letters, digits, `_` or `-`, not \"{name}\""));
    }
    let flag = entry.flag.map(|f| f.trim().to_string()).filter(|f| !f.is_empty());
    if flag.as_deref().is_some_and(|f| !f.starts_with('-')) {
        return bad("has a flag that does not start with `-`");
    }
    let default = entry.default.map(|d| match d {
        DefaultValue::Bool(b) => b.to_string(),
        DefaultValue::Text(t) => t,
    });
    match entry.kind {
        ParamKind::Flag => {
            if flag.is_none() {
                return bad("is a flag and needs a `flag` such as \"-v\"");
            }
            if entry.required || !entry.options.is_empty() {
                return bad("is a flag, which can be neither required nor have options");
            }
            if default.as_deref().is_some_and(|d| as_switch(d).is_none()) {
                return bad("has a default that is not true or false");
            }
        }
        ParamKind::Text => {
            if entry.options.iter().any(|o| o.trim().is_empty()) {
                return bad("has an empty option");
            }
            if default.as_deref().is_some_and(|d| !entry.options.is_empty() && !entry.options.iter().any(|o| o == d)) {
                return bad("has a default that is not one of its options");
            }
            if entry.required && default.is_some() {
                return bad("is required, so a default would never be used; drop one");
            }
        }
    }
    let clean = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    Ok(Param {
        name,
        kind: entry.kind,
        hint: clean(entry.hint),
        placeholder: clean(entry.placeholder),
        flag,
        options: entry.options,
        required: entry.required,
        default,
    })
}

fn as_switch(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// The command-line arguments for `values` (by param name), in the order the params are declared. An empty value is
/// the same as none: it falls back to the default, and a required param without either is an error, so a script is
/// refused before it starts rather than failing on its own.
pub fn build_args(params: &[Param], values: &HashMap<String, String>) -> Result<Vec<String>, String> {
    if let Some(unknown) = values.keys().filter(|k| !params.iter().any(|p| &p.name == *k)).min() {
        let known = if params.is_empty() { "it takes none".to_string() } else { format!("it takes: {}", params.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")) };
        return Err(format!("`{unknown}` is not a parameter of this script ({known})"));
    }
    let mut args = Vec::new();
    for p in params {
        let given = values.get(&p.name).map(|v| v.trim()).filter(|v| !v.is_empty()).map(str::to_string).or_else(|| p.default.clone());
        let flag = p.flag.as_deref();
        match (p.kind, given) {
            (ParamKind::Flag, given) => match given.as_deref().map(as_switch) {
                Some(Some(true)) => args.extend(flag.map(str::to_string)),
                Some(None) => return Err(format!("`{}` is a switch: give true or false, not \"{}\"", p.name, given.unwrap_or_default())),
                _ => {}
            },
            (ParamKind::Text, None) if p.required => {
                let hint = p.hint.as_deref().map(|h| format!(": {h}")).unwrap_or_default();
                return Err(format!("missing required parameter `{}`{hint}", p.name));
            }
            (ParamKind::Text, None) => {}
            (ParamKind::Text, Some(value)) => {
                if !p.options.is_empty() && !p.options.contains(&value) {
                    return Err(format!("`{}` must be one of {}, not \"{value}\"", p.name, p.options.join(", ")));
                }
                match flag {
                    Some(f) if f.ends_with('=') => args.push(format!("{f}{value}")),
                    Some(f) => args.extend([f.to_string(), value]),
                    None => args.push(value),
                }
            }
        }
    }
    Ok(args)
}

fn parse(text: &str, rel_dir: &str) -> Result<Vec<AppDef>, String> {
    let manifest: Manifest = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
    let mut apps: Vec<AppDef> = Vec::new();
    for entry in manifest.scripts {
        let app = app_def(entry, rel_dir)?;
        if apps.iter().any(|a| a.id == app.id) {
            return Err(format!("two scripts are named \"{}\"; names must be unique", app.name));
        }
        apps.push(app);
    }
    Ok(apps)
}

fn app_def(entry: Entry, rel_dir: &str) -> Result<AppDef, String> {
    let name = entry.name.trim().to_string();
    if name.is_empty() {
        return Err("a script has an empty name".into());
    }
    let argv = match entry.command {
        Command::Line(line) => split_command(&line),
        Command::Argv(argv) => argv,
    };
    let Some((program, args)) = argv.split_first().filter(|(p, _)| !p.trim().is_empty()) else {
        return Err(format!("script \"{name}\" has an empty command"));
    };
    let cwd = match entry.cwd.as_deref().map(str::trim) {
        None | Some("" | ".") => cwd_of(rel_dir),
        Some(abs) if Path::new(abs).is_absolute() => abs.to_string(),
        Some(sub) => join_rel(rel_dir, sub.trim_start_matches("./")),
    };
    let mut params: Vec<Param> = Vec::new();
    for p in entry.params {
        let p = param_def(p, &name)?;
        if params.iter().any(|q| q.name == p.name) {
            return Err(format!("script \"{name}\" has two parameters named \"{}\"; names must be unique", p.name));
        }
        params.push(p);
    }
    let mode = entry.mode.unwrap_or(AppMode::Task);
    let service = mode == AppMode::Service;
    let description = match (entry.description, entry.usage) {
        (Some(d), Some(u)) => Some(format!("{d} Usage: {u}")),
        (Some(d), None) => Some(d),
        (None, Some(u)) => Some(format!("Usage: {u}")),
        (None, None) => None,
    };
    Ok(AppDef {
        id: format!("{}#{}", join_rel(rel_dir, FILE), slug(&name)),
        project: join_rel(rel_dir, FILE),
        kind: KIND.into(),
        mode,
        port: entry.port,
        check_port: service && entry.port.is_some(),
        learn_port: service && entry.port.is_none(),
        steps: vec![StepSpec {
            program: Program::path(program),
            args: args.to_vec(),
            cwd,
            ready: if service { entry.ready } else { Vec::new() },
        }],
        description,
        params,
        name,
    })
}

fn invalid(rel_dir: &str, error: &str) -> AppDef {
    AppDef {
        id: format!("{}#invalid", join_rel(rel_dir, FILE)),
        name: format!("{FILE} (invalid)"),
        project: join_rel(rel_dir, FILE),
        kind: KIND.into(),
        mode: AppMode::Task,
        port: None,
        check_port: false,
        learn_port: false,
        steps: Vec::new(),
        description: Some(format!("{FILE} is invalid: {error}")),
        params: Vec::new(),
    }
}

fn slug(name: &str) -> String {
    let slug: String = name.chars().map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    slug.trim_matches('-').to_string()
}

/// Words split on whitespace; single or double quotes group a word. No escapes, so a Windows path keeps its backslashes.
fn split_command(line: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut open = false;
    for c in line.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => word.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                open = true;
            }
            (None, c) if c.is_whitespace() => {
                if open || !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                    open = false;
                }
            }
            (None, c) => word.push(c),
        }
    }
    if open || !word.is_empty() {
        words.push(word);
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn apps(json: &str) -> Vec<AppDef> {
        parse(json, "tools").unwrap()
    }

    #[test]
    fn a_command_becomes_a_task_that_runs_in_the_folder_of_the_file() {
        let found = apps(r#"{"scripts":[{"name":"cust monitors","command":["python","cust.py","monitors"],"description":"Lists monitors."}]}"#);
        let [app] = found.as_slice() else { panic!("one app") };
        assert_eq!((app.id.as_str(), app.name.as_str(), app.kind.as_str()), ("tools/spawner.json#cust-monitors", "cust monitors", "script"));
        assert_eq!((app.mode, app.port, app.learn_port, app.description.as_deref()), (AppMode::Task, None, false, Some("Lists monitors.")));
        let [step] = app.steps.as_slice() else { panic!("one step") };
        assert_eq!((step.program.clone(), step.args.as_slice(), step.cwd.as_str()), (Program::path("python"), ["cust.py".to_string(), "monitors".to_string()].as_slice(), "tools"));
    }

    #[test]
    fn a_command_string_is_split_with_quotes_grouping_words() {
        assert_eq!(split_command(r#"python "my tool.py" --out 'a b' C:\x\y"#), ["python", "my tool.py", "--out", "a b", r"C:\x\y"]);
        assert_eq!(split_command(r#"echo "" x"#), ["echo", "", "x"]);
        let found = apps(r#"{"scripts":[{"name":"a","command":"python a.py -v"}]}"#);
        assert_eq!(found[0].steps[0].args, ["a.py", "-v"]);
    }

    #[test]
    fn cwd_is_relative_to_the_file_and_services_may_declare_a_port_and_ready_text() {
        let found = apps(r#"{"scripts":[{"name":"api","command":["python","-m","http.server","8000"],"cwd":"./site","mode":"service","port":8000,"ready":["Serving"]}]}"#);
        let app = &found[0];
        assert_eq!((app.mode, app.port, app.check_port, app.learn_port), (AppMode::Service, Some(8000), true, false));
        assert_eq!((app.steps[0].cwd.as_str(), app.steps[0].ready.as_slice()), ("tools/site", ["Serving".to_string()].as_slice()));
    }

    #[test]
    fn a_task_ignores_ready_text_and_usage_is_added_to_the_description() {
        let found = apps(r#"{"scripts":[{"name":"a","command":["x"],"ready":["up"],"usage":"x <id>"}]}"#);
        assert!(found[0].steps[0].ready.is_empty());
        assert_eq!(found[0].description.as_deref(), Some("Usage: x <id>"));
    }

    #[test]
    fn mistakes_are_named() {
        let err = |json: &str| parse(json, "").unwrap_err();
        assert!(err(r#"{"scripts":[{"name":"a","cmd":["x"]}]}"#).contains("unknown field `cmd`"));
        assert!(err(r#"{"scripts":[{"name":"a","command":[]}]}"#).contains("empty command"));
        assert!(err(r#"{"scripts":[{"name":"a","command":["x"]},{"name":"A","command":["y"]}]}"#).contains("must be unique"));
        assert!(err(r#"{"script":[]}"#).contains("unknown field `script`"));
        assert!(err("not json").contains("expected"));
    }

    const CUST: &str = r#"{"scripts":[{"name":"cust","command":["python","cust.py"],"params":[
        {"name":"who","required":true,"hint":"Email or walletId","placeholder":"ana@example.com"},
        {"name":"out","flag":"--out","hint":"Output file"},
        {"name":"env","flag":"--env=","options":["prod","staging"],"default":"staging"},
        {"name":"verbose","type":"flag","flag":"-v","default":false}]}]}"#;

    fn values(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn params_are_declared_with_their_hints_for_the_ui_to_ask() {
        let found = apps(CUST);
        let params = &found[0].params;
        assert_eq!(params.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["who", "out", "env", "verbose"]);
        assert_eq!((params[0].required, params[0].hint.as_deref(), params[0].placeholder.as_deref()), (true, Some("Email or walletId"), Some("ana@example.com")));
        assert_eq!((params[2].options.as_slice(), params[2].default.as_deref()), (["prod".to_string(), "staging".to_string()].as_slice(), Some("staging")));
        assert_eq!((params[3].kind, params[3].default.as_deref()), (ParamKind::Flag, Some("false")));
        assert!(apps(r#"{"scripts":[{"name":"a","command":["x"]}]}"#)[0].params.is_empty());
    }

    #[test]
    fn values_become_arguments_in_declared_order_and_empty_optional_ones_add_nothing() {
        let params = apps(CUST).remove(0).params;
        let args = |pairs: &[(&str, &str)]| build_args(&params, &values(pairs));
        assert_eq!(args(&[("who", "ana@x.com")]).unwrap(), ["ana@x.com", "--env=staging"]);
        assert_eq!(
            args(&[("verbose", "true"), ("out", " a b.json "), ("who", "7"), ("env", "prod")]).unwrap(),
            ["7", "--out", "a b.json", "--env=prod", "-v"]
        );
        assert_eq!(args(&[("who", "7"), ("out", "   "), ("verbose", "false")]).unwrap(), ["7", "--env=staging"]);
    }

    #[test]
    fn a_missing_required_value_is_refused_with_its_hint() {
        let params = apps(CUST).remove(0).params;
        let err = |pairs: &[(&str, &str)]| build_args(&params, &values(pairs)).unwrap_err();
        assert_eq!(err(&[]), "missing required parameter `who`: Email or walletId");
        assert!(err(&[("who", "  ")]).contains("missing required parameter `who`"));
        assert!(err(&[("who", "1"), ("env", "dev")]).contains("must be one of prod, staging"));
        assert!(err(&[("who", "1"), ("verbose", "maybe")]).contains("give true or false"));
        assert!(err(&[("who", "1"), ("nope", "x")]).contains("`nope` is not a parameter of this script (it takes: who, out, env, verbose)"));
        assert!(build_args(&[], &values(&[("x", "1")])).unwrap_err().contains("it takes none"));
        assert!(build_args(&[], &HashMap::new()).unwrap().is_empty());
    }

    #[test]
    fn parameter_mistakes_are_named() {
        let err = |param: &str| parse(&format!(r#"{{"scripts":[{{"name":"a","command":["x"],"params":[{param}]}}]}}"#), "").unwrap_err();
        assert!(err(r#"{"name":"a b"}"#).contains("letters, digits"));
        assert!(err(r#"{"name":"v","type":"flag"}"#).contains("needs a `flag`"));
        assert!(err(r#"{"name":"v","type":"flag","flag":"v"}"#).contains("does not start with `-`"));
        assert!(err(r#"{"name":"v","type":"flag","flag":"-v","required":true}"#).contains("neither required"));
        assert!(err(r#"{"name":"e","options":["a"],"default":"b"}"#).contains("not one of its options"));
        assert!(err(r#"{"name":"e","required":true,"default":"b"}"#).contains("never be used"));
        assert!(err(r#"{"name":"e"},{"name":"e"}"#).contains("two parameters named \"e\""));
        assert!(err(r#"{"name":"e","hin":"x"}"#).contains("unknown field `hin`"));
    }

    #[test]
    fn the_file_is_found_on_disk_and_a_broken_one_is_listed_with_its_error() {
        let dir = TempDir::new("scripts");
        std::fs::write(dir.path().join(FILE), r#"{"scripts":[{"name":"a","command":["x"]}]}"#).unwrap();
        let mut out = Vec::new();
        assert_eq!(Scripts.detect(dir.path(), dir.path(), &mut out), Claim::None);
        assert_eq!((out.len(), out[0].steps[0].cwd.as_str()), (1, "."));

        std::fs::write(dir.path().join(FILE), "{").unwrap();
        let mut out = Vec::new();
        Scripts.detect(dir.path(), dir.path(), &mut out);
        let [bad] = out.as_slice() else { panic!("one app") };
        assert!(bad.steps.is_empty() && bad.description.as_deref().unwrap().contains("spawner.json is invalid"));
    }
}
