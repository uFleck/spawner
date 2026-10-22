use crate::model::{Level, Stream};
use regex::Regex;
use std::sync::OnceLock;

const RULES: &[(&str, Level)] = &[
    (r"(?i)^\s*(fail|crit):", Level::Err),
    (r"(?i)^\s*warn:", Level::Wrn),
    (r"(?i)^\s*(dbug|trce):", Level::Dbg),
    (r"(?i)^\s*info:", Level::Inf),
    (r"\|\s*(ERROR|FATAL)\s*\|", Level::Err),
    (r"\|\s*WARN(ING)?\s*\|", Level::Wrn),
    (r"\|\s*(DEBUG|TRACE)\s*\|", Level::Dbg),
    (r"\[(ERR|ERROR|FTL|FATAL)\]", Level::Err),
    (r"\[(WRN|WARN)\]", Level::Wrn),
    (r"\berror [A-Z]{1,3}\d+:", Level::Err),
    (r"\bwarning [A-Z]{1,3}\d+:", Level::Wrn),
    // Everything below is for output that is not from .NET (npm, node, vite, tsc, cargo, python). It comes after the
    // .NET rules so a line they recognize keeps the level they give it.
    (r"(?i)^\s*npm (ERR!|error)", Level::Err),
    (r"(?i)^\s*npm warn", Level::Wrn),
    (r"\bERR_[A-Z0-9_]+", Level::Err),
    (r"\berror TS\d+", Level::Err),
    (r"\berror\[E\d+\]", Level::Err),
    (r"(?i)\[vite\].*\berror", Level::Err),
    (r"^Traceback \(most recent call last\)", Level::Err),
    (r"^\s*[A-Za-z_.]*(Error|Exception):", Level::Err),
    (r"(?i)^\s*error\b", Level::Err),
    (r"(?i)^\s*warn(ing)?\b", Level::Wrn),
    (r"\bWARN(ING)?\b", Level::Wrn),
    (r"(?i)\bwarning:", Level::Wrn),
    // Cargo and the Tauri CLI report plain progress on stderr, which would otherwise all read as errors.
    (r"^\s*(Compiling|Finished|Running|Building|Fresh|Checking|Downloading|Downloaded|Updating|Blocking|Locking|Documenting|Packaging|Installing|Info)\b", Level::Inf),
];

fn rules() -> &'static [(Regex, Level)] {
    static CELL: OnceLock<Vec<(Regex, Level)>> = OnceLock::new();
    CELL.get_or_init(|| RULES.iter().map(|(p, l)| (Regex::new(p).expect("valid level rule"), *l)).collect())
}

/// The level the line itself states, when it states one: a .NET console, NLog or MSBuild marker, or the common markers
/// of npm, node, vite, tsc, cargo and python. A line that says nothing about its level has none.
pub fn marked(text: &str) -> Option<Level> {
    rules().iter().find(|(re, _)| re.is_match(text)).map(|(_, level)| *level)
}

/// `marked`, else the stream decides: an unmarked stderr line counts as an error.
pub fn classify(stream: Stream, text: &str) -> Level {
    if stream == Stream::Sys {
        return Level::Sys;
    }
    marked(text).unwrap_or(if stream == Stream::Err { Level::Err } else { Level::Inf })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dotnet_console_nlog_and_msbuild_levels() {
        assert_eq!(classify(Stream::Out, "fail: Acme.X[0] boom"), Level::Err);
        assert_eq!(classify(Stream::Out, "warn: Acme.X[0] careful"), Level::Wrn);
        assert_eq!(classify(Stream::Out, "dbug: Acme.X[0] detail"), Level::Dbg);
        assert_eq!(classify(Stream::Out, "2026-10-19 14:02:11 | WARN | Bill.Outbox | lag"), Level::Wrn);
        assert_eq!(classify(Stream::Out, "a.cs(1,2): error CS0246: missing"), Level::Err);
        assert_eq!(classify(Stream::Out, "a.cs(1,2): warning CS8618: nullable"), Level::Wrn);
    }

    #[test]
    fn reads_node_npm_vite_tsc_cargo_and_python_levels() {
        let level = |text: &str| classify(Stream::Out, text);
        for line in [
            "npm ERR! code ELIFECYCLE",
            "npm error code ENOENT",
            "node:internal/modules/cjs/loader:1228 { code: 'ERR_MODULE_NOT_FOUND' }",
            "src/App.tsx(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
            "error[E0432]: unresolved import `foo`",
            "error: could not compile `spawner` (lib) due to 1 previous error",
            "Error: Cannot find module 'x'",
            "ERROR in ./src/index.js",
            "11:03:12 [vite] Internal server error: Failed to resolve import",
            "Traceback (most recent call last):",
            "TypeError: undefined is not a function",
            "ValueError: bad value",
        ] {
            assert_eq!(level(line), Level::Err, "{line}");
        }
        for line in [
            "npm warn deprecated inflight@1.0.6",
            "warning: unused variable: `x`",
            "warning[E0599]: odd",
            "  WARN  Issues with peer dependencies found",
            "WARN: low disk",
            "src/a.ts: warning: something",
            "(!) Some chunks are larger than 500 kB [WARN]",
        ] {
            assert_eq!(level(line), Level::Wrn, "{line}");
        }
        for line in ["  ➜  Local:   http://localhost:1420/", "VITE v8.0.1  ready in 412 ms", "Compiling spawner v0.1.0", "0 errors, 0 warnings", "Finished `dev` profile in 3.2s"] {
            assert_eq!(level(line), Level::Inf, "{line}");
        }
        assert_eq!(classify(Stream::Err, "some unmarked stderr"), Level::Err);
        for progress in [
            "   Compiling spawner v0.1.0 (C:\\umbler\\umbler-hub\\src-tauri)",
            "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.66s",
            "     Running `target\\debug\\spawner.exe`",
            "     Running BeforeDevCommand (`pnpm dev`)",
            "        Info Watching C:\\umbler\\umbler-hub\\src-tauri for changes...",
            "    Building [=======================> ] 390/391: spawner",
        ] {
            assert_eq!(classify(Stream::Err, progress), Level::Inf, "cargo and tauri progress goes to stderr: {progress}");
        }
        assert_eq!(classify(Stream::Err, "error: could not compile `spawner`"), Level::Err);        assert_eq!(classify(Stream::Err, "npm warn config"), Level::Wrn, "a marker beats the stream");
    }

    #[test]
    fn the_dotnet_levels_win_over_the_generic_rules() {
        assert_eq!(classify(Stream::Out, "info: Acme.X[0] error handling is enabled"), Level::Inf);
        assert_eq!(classify(Stream::Out, "warn: Acme.X[0] Error: retrying"), Level::Wrn);
        assert_eq!(classify(Stream::Out, "dbug: Acme.X[0] WARN-level filter off"), Level::Dbg);
        assert_eq!(classify(Stream::Out, "2026-10-19 14:02:11 | INFO | Bill | ERR_CONNECTION reset by peer"), Level::Err, "an explicit INFO column does not stop a node error code from showing");
        assert_eq!(classify(Stream::Out, "Now listening on: http://localhost:5003"), Level::Inf);
        assert_eq!(classify(Stream::Out, "Application started. Press Ctrl+C to shut down."), Level::Inf);
    }

    #[test]
    fn unmarked_lines_follow_their_stream() {
        assert_eq!(classify(Stream::Out, "Now listening on: http://localhost:5003"), Level::Inf);
        assert_eq!(classify(Stream::Err, "something on stderr"), Level::Err);
        assert_eq!(classify(Stream::Sys, "> dotnet build"), Level::Sys);
    }
}
