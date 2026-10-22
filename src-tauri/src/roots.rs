//! The folders Spawner scans: loaded from `roots.json`, or from `SPAWNER_ROOT` on first run.

use crate::model::Root;
use std::path::Path;

pub const FILE_NAME: &str = "roots.json";

/// Forward slashes and no trailing slash, the form every path in the model uses.
pub fn normalize(path: &str) -> String {
    let p = path.trim().replace('\\', "/");
    let trimmed = p.trim_end_matches('/');
    if trimmed.is_empty() || trimmed.ends_with(':') {
        // "/" and "C:/" must keep their slash.
        return if p.is_empty() { p } else { format!("{trimmed}/") };
    }
    trimmed.to_string()
}

/// What two roots are compared by: paths are case-insensitive on Windows.
pub fn key(path: &str) -> String {
    let n = normalize(path);
    if cfg!(windows) { n.to_lowercase() } else { n }
}

/// The folder name, or the whole path for a drive root.
pub fn folder_name(path: &str) -> String {
    let n = normalize(path);
    n.trim_end_matches('/').rsplit('/').next().filter(|s| !s.is_empty() && !s.ends_with(':')).unwrap_or(&n).to_string()
}

pub fn display_name(root: &Root) -> String {
    root.label.as_deref().map(str::trim).filter(|l| !l.is_empty()).map_or_else(|| folder_name(&root.path), str::to_string)
}

/// `SPAWNER_ROOT` is a `;`-separated list of folders.
pub fn from_env_value(value: &str) -> Vec<Root> {
    dedupe(value.split(';').filter(|p| !p.trim().is_empty()).map(|p| Root { path: normalize(p), label: None }).collect())
}

fn dedupe(roots: Vec<Root>) -> Vec<Root> {
    let mut seen = std::collections::HashSet::new();
    roots.into_iter().filter(|r| seen.insert(key(&r.path))).collect()
}

/// `roots.json` wins when it exists, even if it is empty (the user removed every folder).
/// The environment value only seeds the list before the file has ever been written.
pub fn load(file: &Path, env_value: Option<&str>) -> Vec<Root> {
    match std::fs::read_to_string(file) {
        Ok(text) => match serde_json::from_str::<Vec<Root>>(&text) {
            Ok(roots) => dedupe(roots.into_iter().map(|r| Root { path: normalize(&r.path), label: r.label }).collect()),
            Err(e) => {
                eprintln!("spawner: ignoring unreadable {}: {e}", file.display());
                Vec::new()
            }
        },
        Err(_) => env_value.map(from_env_value).unwrap_or_default(),
    }
}

pub fn save(file: &Path, roots: &[Root]) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(roots).map_err(|e| e.to_string())?;
    std::fs::write(file, text).map_err(|e| format!("cannot write {}: {e}", file.display()))
}

/// Adds a folder that exists. Adding one that is already there only updates its label.
pub fn add(roots: &[Root], path: &str, label: Option<String>) -> Result<Vec<Root>, String> {
    let path = normalize(path);
    if path.is_empty() {
        return Err("choose a folder".into());
    }
    if !Path::new(&path).is_dir() {
        return Err(format!("{path} is not a folder that exists"));
    }
    let label = label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
    let mut next = roots.to_vec();
    match next.iter_mut().find(|r| key(&r.path) == key(&path)) {
        Some(existing) => {
            if label.is_some() {
                existing.label = label;
            }
        }
        None => next.push(Root { path, label }),
    }
    Ok(next)
}

pub fn remove(roots: &[Root], path: &str) -> Vec<Root> {
    roots.iter().filter(|r| key(&r.path) != key(path)).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn normalizes_separators_and_trailing_slashes_but_keeps_drive_roots() {
        assert_eq!(normalize("C:\\dev\\bill\\"), "C:/dev/bill");
        assert_eq!(normalize("C:\\"), "C:/");
        assert_eq!(normalize("  /home/me/dev/ "), "/home/me/dev");
    }

    #[test]
    fn names_come_from_the_label_or_the_folder() {
        assert_eq!(display_name(&Root { path: "C:/dev/bill".into(), label: None }), "bill");
        assert_eq!(display_name(&Root { path: "C:/dev/bill".into(), label: Some("Work".into()) }), "Work");
        assert_eq!(display_name(&Root { path: "C:/dev/bill".into(), label: Some("  ".into()) }), "bill");
        assert_eq!(display_name(&Root { path: "C:/".into(), label: None }), "C:/");
    }

    #[test]
    fn env_value_is_a_semicolon_list_without_duplicates() {
        let roots = from_env_value("C:/dev; D:\\work\\ ;;C:\\dev\\");
        let paths: Vec<_> = roots.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["C:/dev", "D:/work"]);
    }

    #[test]
    fn roots_json_wins_over_the_environment_and_roundtrips() {
        let dir = TempDir::new("roots-json");
        let file = dir.path().join(FILE_NAME);
        assert_eq!(load(&file, Some("C:/from-env")).len(), 1, "no file yet: the environment seeds the list");
        assert!(load(&file, None).is_empty(), "no file and no environment: no roots");

        let roots = vec![Root { path: "C:/a".into(), label: Some("A".into()) }, Root { path: "C:/b".into(), label: None }];
        save(&file, &roots).unwrap();
        assert_eq!(load(&file, Some("C:/from-env")), roots);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"label\": \"A\"") && !text.contains("null"), "{text}");

        save(&file, &[]).unwrap();
        assert!(load(&file, Some("C:/from-env")).is_empty(), "an emptied file is not re-seeded");
    }

    #[test]
    fn unreadable_roots_json_loads_as_empty() {
        let dir = TempDir::new("roots-bad");
        let file = dir.path().join(FILE_NAME);
        std::fs::write(&file, "{not json").unwrap();
        assert!(load(&file, Some("C:/from-env")).is_empty());
    }

    #[test]
    fn add_validates_the_folder_and_dedupes_by_normalized_path() {
        let dir = TempDir::new("roots-add");
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let sub = sub.to_string_lossy().into_owned();

        let one = add(&[], &sub, None).unwrap();
        assert_eq!(one.len(), 1);
        let again = add(&one, &format!("{}/", sub.replace('\\', "/")), Some(" Work ".into())).unwrap();
        assert_eq!(again.len(), 1, "same folder spelled differently is the same root");
        assert_eq!(again[0].label.as_deref(), Some("Work"));
        let kept = add(&again, &sub, None).unwrap();
        assert_eq!(kept[0].label.as_deref(), Some("Work"), "re-adding without a label keeps the label");

        assert!(add(&one, &dir.path().join("missing").to_string_lossy(), None).is_err());
        let file = dir.path().join("a-file.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(add(&one, &file.to_string_lossy(), None).is_err(), "a file is not a folder");
        assert!(add(&one, "  ", None).is_err());
    }

    #[test]
    fn remove_matches_any_spelling_of_the_path() {
        let roots = vec![Root { path: "C:/a".into(), label: None }, Root { path: "C:/b".into(), label: None }];
        let left = remove(&roots, "C:\\a\\");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].path, "C:/b");
        assert_eq!(remove(&roots, "C:/nope").len(), 2);
    }
}
