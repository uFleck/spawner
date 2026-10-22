//! .NET: SDK-style web and worker projects run with `dotnet run`; old-style web projects that opt into IIS Express
//! are built with MSBuild and served by IIS Express on the port in their `<IISUrl>`.

use super::{Claim, Detector};
use crate::discovery::no_window;
use crate::model::{AppDef, AppMode, Program, StepSpec};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const WEB_PROJECT_GUID: &str = "349c5851-65df-11da-9384-00065b846f21";

pub struct Dotnet;

impl Detector for Dotnet {
    fn name(&self) -> &'static str {
        "dotnet"
    }

    /// Never claims the folder: a .NET project can sit next to apps of other technologies.
    fn detect(&self, dir: &Path, root: &Path, out: &mut Vec<AppDef>) -> Claim {
        let Ok(entries) = std::fs::read_dir(dir) else { return Claim::None };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_csproj = entry.file_type().is_ok_and(|t| !t.is_dir())
                && entry.file_name().to_string_lossy().to_lowercase().ends_with(".csproj");
            if is_csproj {
                out.extend(classify(root, &path));
            }
        }
        Claim::None
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Flavor {
    DotnetRun,
    IisExpress,
}

fn classify(root: &Path, csproj: &Path) -> Option<AppDef> {
    let text = std::fs::read_to_string(csproj).ok()?;
    let (flavor, port) = classify_csproj(&text)?;
    let rel = csproj.strip_prefix(root).ok().map(|p| p.to_string_lossy().replace('\\', "/"))?;
    let name = csproj.file_stem()?.to_string_lossy().into_owned();
    Some(app_def(flavor, &rel, &name, port))
}

pub fn classify_csproj(text: &str) -> Option<(Flavor, Option<u16>)> {
    let lower = text.to_lowercase();
    if lower.contains("sdk=\"microsoft.net.sdk.web\"") || lower.contains("sdk=\"microsoft.net.sdk.worker\"") {
        return Some((Flavor::DotnetRun, None));
    }
    if lower.contains(WEB_PROJECT_GUID) && lower.contains("<useiisexpress>true") {
        return Some((Flavor::IisExpress, iis_port(text)));
    }
    None
}

fn iis_port(text: &str) -> Option<u16> {
    let start = text.find("<IISUrl>")? + "<IISUrl>".len();
    let url = text[start..].split('<').next()?;
    let after_host = url.rsplit(':').next()?;
    after_host.trim_end_matches('/').parse().ok()
}

/// The app for the project file at `rel` (relative to the project folder, `/`-separated). Both flavors run from the
/// file's own folder. An IIS app without a port is still listed; starting it fails because its step needs `{port}`.
pub fn app_def(flavor: Flavor, rel: &str, name: &str, port: Option<u16>) -> AppDef {
    let (dir, file) = rel.rsplit_once('/').unwrap_or((".", rel));
    let step = |program, args: &[&str], ready: &[&str]| StepSpec {
        program,
        args: args.iter().map(|a| a.to_string()).collect(),
        cwd: dir.to_string(),
        ready: ready.iter().map(|r| r.to_string()).collect(),
    };
    let (kind, steps) = match flavor {
        Flavor::DotnetRun => (
            "dotnet-run",
            vec![step(Program::path("dotnet"), &["run", "--project", file], &["Now listening on", "Application started"])],
        ),
        Flavor::IisExpress => (
            "iis-express",
            vec![
                step(
                    Program::Msbuild,
                    &[file, "-t:Build", "-p:Configuration=Debug", "-nologo", "-m", "-consoleloggerparameters:ErrorsOnly"],
                    &[],
                ),
                step(Program::IisExpress, &["/path:{cwd}", "/port:{port}", "/clr:v4.0"], &["IIS Express is running"]),
            ],
        ),
    };
    AppDef {
        id: rel.into(),
        name: name.into(),
        project: rel.into(),
        kind: kind.into(),
        mode: AppMode::Service,
        port,
        check_port: flavor == Flavor::IisExpress,
        learn_port: false,
        steps,
        description: None,
        params: Vec::new(),
    }
}

pub fn find_msbuild() -> Option<PathBuf> {
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let pf86 = std::env::var("ProgramFiles(x86)").ok()?;
            let vswhere = Path::new(&pf86).join("Microsoft Visual Studio/Installer/vswhere.exe");
            let mut cmd = std::process::Command::new(vswhere);
            cmd.args([
                "-latest",
                "-prerelease",
                "-products",
                "*",
                "-requires",
                "Microsoft.Component.MSBuild",
                "-find",
                "MSBuild\\**\\Bin\\MSBuild.exe",
            ]);
            no_window(&mut cmd);
            let out = cmd.output().ok()?;
            let line = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
            let path = PathBuf::from(line);
            path.is_file().then_some(path)
        })
        .clone()
}

pub fn find_iis_express() -> Option<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .map(|p| Path::new(&p).join("IIS Express/iisexpress.exe"))
        .find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_old_style_iis_web_project_with_port() {
        let csproj = r#"<Project><PropertyGroup><ProjectTypeGuids>{349c5851-65df-11da-9384-00065b846f21};{fae04ec0}</ProjectTypeGuids><UseIISExpress>true</UseIISExpress></PropertyGroup><IISUrl>http://localhost:42318/</IISUrl></Project>"#;
        assert_eq!(classify_csproj(csproj), Some((Flavor::IisExpress, Some(42318))));
    }

    #[test]
    fn classifies_sdk_web_and_ignores_libraries() {
        assert_eq!(classify_csproj(r#"<Project Sdk="Microsoft.NET.Sdk.Web"></Project>"#), Some((Flavor::DotnetRun, None)));
        assert_eq!(classify_csproj(r#"<Project Sdk="Microsoft.NET.Sdk"></Project>"#), None);
    }

    #[test]
    fn dotnet_run_app_launches_from_the_project_folder_and_holds_no_machine_path() {
        let app = app_def(Flavor::DotnetRun, "src/Api/Api.csproj", "Api", None);
        assert_eq!((app.id.as_str(), app.kind.as_str(), app.mode, app.check_port), ("src/Api/Api.csproj", "dotnet-run", AppMode::Service, false));
        let [step] = app.steps.as_slice() else { panic!("one step") };
        assert_eq!(step.program, Program::path("dotnet"));
        assert_eq!((step.args.as_slice(), step.cwd.as_str()), (["run", "--project", "Api.csproj"].map(String::from).as_slice(), "src/Api"));
        assert_eq!(step.ready, ["Now listening on", "Application started"]);
    }

    #[test]
    fn iis_app_builds_then_serves_and_checks_its_port() {
        let app = app_def(Flavor::IisExpress, "Bill.csproj", "Bill", Some(42318));
        assert!(app.check_port);
        assert_eq!(app.kind, "iis-express");
        let programs: Vec<_> = app.steps.iter().map(|s| &s.program).collect();
        assert_eq!(programs, [&Program::Msbuild, &Program::IisExpress]);
        assert_eq!(app.steps[0].cwd, ".");
        assert!(app.steps[0].ready.is_empty());
        assert_eq!(app.steps[1].args, ["/path:{cwd}", "/port:{port}", "/clr:v4.0"]);
        assert_eq!(app.steps[1].ready, ["IIS Express is running"]);
    }
}
