//! The presets the window saves in `ui-state.json`, read here so an MCP agent can run them. The UI owns the file and its format.

use serde::Deserialize;
use serde_json::Value;

pub const FILE_NAME: &str = "ui-state.json";

/// The target of a preset that runs from the main checkouts.
pub const MAIN: &str = "main";

/// An app by repo and app id, so it survives across worktrees.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub repo: String,
    pub app_id: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Preset {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub members: Vec<Member>,
    /// A worktree group id, or `main`.
    #[serde(default = "main")]
    pub target: String,
}

fn main() -> String {
    MAIN.into()
}

/// The presets in the saved document. An entry that does not parse is skipped, as the window does.
pub fn parse(text: &str) -> Result<Vec<Preset>, String> {
    let doc: Value = serde_json::from_str(text).map_err(|e| format!("cannot read {FILE_NAME}: {e}"))?;
    let entries = doc.get("presets").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(entries.into_iter().filter_map(|p| serde_json::from_value(p).ok()).collect())
}

/// A preset by id or name, name compared without regard to case.
pub fn find<'a>(presets: &'a [Preset], wanted: &str) -> Option<&'a Preset> {
    presets.iter().find(|p| p.id == wanted).or_else(|| presets.iter().find(|p| p.name.eq_ignore_ascii_case(wanted)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_the_window_saves_and_skips_broken_entries() {
        let text = r#"{"pins":{},"presets":[
            {"id":"a","name":"Bill stack","target":"PAYMENT-9986","members":[{"repo":"bill","appId":"Bill.csproj","name":"Bill.API"}]},
            {"id":"b","name":"No members"},
            {"id":"c","name":"Defaults to main","members":[]}
        ]}"#;
        let presets = parse(text).unwrap();
        assert_eq!(presets.len(), 2);
        assert_eq!(presets[0].members[0], Member { repo: "bill".into(), app_id: "Bill.csproj".into(), name: "Bill.API".into() });
        assert_eq!(presets[1].target, MAIN);
    }

    #[test]
    fn a_preset_is_found_by_id_or_by_name_in_any_case() {
        let presets = parse(r#"{"presets":[{"id":"a","name":"Bill stack","members":[]}]}"#).unwrap();
        assert!(find(&presets, "a").is_some());
        assert!(find(&presets, "bill STACK").is_some());
        assert!(find(&presets, "nope").is_none());
    }

    #[test]
    fn a_missing_presets_key_is_no_presets() {
        assert!(parse("{}").unwrap().is_empty());
        assert!(parse("not json").is_err());
    }
}
