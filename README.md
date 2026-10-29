# Spawner

Desktop app (Tauri 2 + React) that scans the folders you add for repos, their git worktrees and loose project folders, runs the apps it finds without an IDE, and shows one merged log stream. Supports .NET, Node (Vite, Next, plain scripts) and Tauri; see Supported technologies.

The sidebar is organized as **worktree > projects > apps**. A worktree is one unit of work: a task folder such as `PAYMENT-9986` holding one project (repo checkout) per repo, plus a `main` group with every repo's main checkout.

## Supported technologies

| Technology | Found by | Apps | How it runs |
| --- | --- | --- | --- |
| .NET, legacy web project (`UseIISExpress`) | `.csproj` | service | MSBuild `Build` (Debug), then `iisexpress /path /port` using the port from `<IISUrl>` |
| .NET, SDK `Web` / `Worker` | `.csproj` | service | `dotnet run --project` |
| Node: Vite, Next, Create React App, plain Node (`kind` is `vite`, `next`, `react` or `node`) | `package.json` | services for the scripts `dev`, `start`, `serve`, `preview`, `storybook`; tasks for `build`, `test`, `lint`, `typecheck`, `check`, `format`, `generate`, `migrate` | `<pm> run <script>` in the package folder. The package manager comes from the nearest lockfile inside the project (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`/`bun.lock`), else the `packageManager` field, else npm. Other scripts are not listed (the two lists are consts in `detect/node.rs`). A monorepo yields one set per `package.json`. |
| Tauri | `src-tauri/tauri.conf.json` (or `.json5`, `Tauri.toml`) | service `tauri dev` | `<pm> run tauri dev` when the package has a `tauri` script, else `cargo run` in `src-tauri` (no front end dev server). Ready when cargo launches the window app. `tauri build` is not offered. |

In a Tauri app, `dev` is the web front end alone and `tauri dev` is the whole desktop app; both use the same dev server port, so run one at a time. `src-tauri` is claimed by the Tauri detector and is not scanned further. The walk skips `bin`, `obj`, `node_modules`, `dist`, `build`, `target`, `.next`, `.turbo`, `.venv` and similar (`packages` too, unless its parent has a `package.json`).

Services that pick their own port (Node and Tauri apps) get it from their output: the first `http(s)://localhost|127.0.0.1|[::1]|0.0.0.0:PORT` URL they print is shown in the sidebar and returned as `url` by the MCP tools. It is forgotten when the app stops. A Node service is "running" when its output matches one of the ready patterns (`Local:`, `ready in`, `listening on`, `compiled successfully`, `started server on`, `Server running`, ...); a `start` script that prints none of them stays "starting" until stopped.

### Adding a technology

Implement `Detector` (`src-tauri/src/detect/mod.rs`) in a new module under `src-tauri/src/detect/` and list it in `DETECTORS`:

```rust
pub struct Deno;

impl Detector for Deno {
    fn name(&self) -> &'static str { "deno" }

    // `dir` is a folder of the walk, `root` the project folder. Push one `AppDef` per runnable thing in `dir`;
    // `id` is unique and stable (a path plus a name), `project` the file you found it in, relative to `root`.
    fn detect(&self, dir: &Path, root: &Path, out: &mut Vec<AppDef>) -> Claim {
        if !dir.join("deno.json").is_file() { return Claim::None; }
        out.push(AppDef { /* kind, mode, steps: [StepSpec { program: Program::path("deno"), args, cwd, ready }], learn_port: true, .. */ });
        Claim::None // Claim::Dir hides the folder from later detectors; Claim::Tree also stops the walk below it
    }
}
```

A step's `cwd` is relative to the project folder; `args` may hold `{cwd}` and `{port}`. Tools that live on `PATH` need nothing more (on Windows, `.cmd` shims such as `npm` are resolved for you); a tool that must be located gets a `Program` variant and a lookup in `detect::resolve`. Log levels come from `level.rs`.

Each instance is a `(project, app)` pair with state `building → starting → running → stopping → exited | failed`. Stopping kills the whole process tree, and a Windows job object kills everything if the hub itself dies.

## Develop

Needs Rust, Node 24 (`.node-version`), pnpm, WebView2, and Visual Studio MSBuild + IIS Express for legacy web projects.

```
pnpm install
pnpm tauri dev
cd src-tauri && cargo test -- --ignored --test-threads=1
# real legacy web project build + serve + stop (needs C:/dev/bill), an MCP run of a throwaway dotnet 9 app on :5199,
# and this repo's own vite dev server and `tauri dev` through the MCP tools on :1420 (needs it free; the tauri one opens a window)
cd src-tauri && cargo test discovers_this_repo -- --ignored --nocapture   # prints the apps Spawner finds in this repo
```

## Releasing and updates

Releases are GitHub Releases at github.com/uFleck/spawner, built on Windows by `.github/workflows/release.yml` when a tag `vX.Y.Z` is pushed. The version comes from the tag and is written into `tauri.conf.json`, `Cargo.toml` and `package.json` during the build only, never committed, so don't bump versions in the repo:

```
git tag v0.2.0
git push origin v0.2.0
```

The release holds the NSIS installer (`*-setup.exe`), its `.sig`, and `latest.json`. GitHub generates the release notes from the commits and PRs since the previous tag.

Installed apps check `releases/latest/download/latest.json` 10 s after start and every 6 hours (release builds only). A newer version shows a dot on the update button in the status bar. Hovering it lists the changes; clicking downloads it, and "restart to update" stops running apps and installs.

One-time setup:

```
pnpm tauri signer generate -w ~/.tauri/spawner.key
```

Put the public key in `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, then add the repo secrets `TAURI_SIGNING_PRIVATE_KEY` (the private key file's contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep a backup of the private key: without it, installed copies can't be updated.

The installer isn't Authenticode-signed, so Windows SmartScreen warns on the first install ("More info" > "Run anyway"). Updates after that are verified by the updater signature.

## Folders

Spawner scans the folders you add (the **Add folder** button in the sidebar header, the Folders list at the bottom of the sidebar, or "Add folder" in the command palette; each folder has a remove button). They are saved in `roots.json` in the app data directory, next to `mcp-port.txt`:

```json
[{ "path": "C:/dev", "label": "optional display name" }]
```

There is no built-in default folder. Until `roots.json` exists, `SPAWNER_ROOT` (a `;`-separated list of folders) is used as the list, so you can seed a machine without clicking; the first add or remove writes `roots.json`, which then takes over. With neither, the sidebar asks you to add a folder. The pre-rename `UMBLER_ROOT` and `UMBLER_HUB_MCP_PORT` are still read as fallbacks.

A folder can be:

- a folder of git repos (`C:/dev`): every repo and its worktrees are scanned, and worktrees named after a task (`PAYMENT-9986/` folders or branches) are grouped by task with a `main` group for the main checkouts;
- a git repo itself: that repo and its worktrees;
- a plain folder: its non-git subfolders are projects of their own, and the folder itself is a project when it has apps at its top level. Plain projects are grouped under the folder, named by its label or folder name.

Group ids stay as they are (`PAYMENT-9986`, `main`) unless two folders produce the same id, in which case each is prefixed with its folder path. A project reachable from two overlapping folders is listed once.

## UI in a browser

`pnpm dev` outside Tauri installs `src/dev/mockBackend.ts`: groups from a real scan, simulated run/stop and log output. It is not part of the production bundle.

## MCP server

While Spawner is open it serves MCP at `http://127.0.0.1:38417/mcp` (Streamable HTTP, loopback only). If that port is taken, Spawner moves on by itself. It tries `SPAWNER_MCP_PORT` if set, then the port it used last time (kept in `mcp-port.txt` in its app data directory, so a client config stays valid), then 38417 to 38437, then any free port. When the port changes, the status bar chip turns amber and the setup guide offers to update Claude Code. An AI agent uses it to start, stop and read the same instances you see in the window, instead of running dev servers in a terminal you cannot track. Each start or stop from an agent adds a `started via MCP` or `stopped via MCP` line to that app's log.

```
claude mcp add --transport http spawner http://127.0.0.1:38417/mcp
```

The status bar shows the port, and clicking it opens the setup guide. The guide also opens on first launch, from the plug button in the sidebar header, and from the command palette ("Connect an AI agent"). It checks that Spawner is listening, that the `claude` command is installed, and then adds the server with `claude mcp add --scope user` and confirms it with `claude mcp get`, which health-checks Spawner as a real MCP client. It also removes a leftover pre-rename `umbler-hub` server entry. It ends with starter prompts and a `CLAUDE.md` snippet, so it can be handed to a coworker as is. Next to the snippet, "Ask Claude to add it" runs `claude -p` (prompt over stdin, tools limited to Read, Edit and Write, `acceptEdits`) in the Claude config directory (`CLAUDE_CONFIG_DIR`, default `~/.claude`) and has Claude write or replace that section in the user-level `CLAUDE.md`. Spawner looks for `claude` on the PATH it was started with.

| Tool | What it does |
| --- | --- |
| `hub_list_apps` | Worktree > project > app tree with state, port and instance id, and the folder (`root_path`) each group came from. `rescan` re-reads the disk. |
| `hub_start` | Builds and starts an app, waits for running or failed, and returns the log lines from that run. |
| `hub_stop` | Stops the app and its process tree, waits for exit. |
| `hub_restart` | Stop if active, then start. |
| `hub_logs` | Reads logs with `since_seq` polling, `min_level`, `query`/`regex` and a `tail` limit. |
| `hub_clear_logs` | Clears one app's logs, or all. |
| `hub_rescan` | Rescans the configured folders for new worktrees and apps. |
| `hub_list_presets` | The presets saved in the window, with the worktrees each can run in and how its apps resolve in its default worktree. |
| `hub_start_preset` | Starts every app of a preset concurrently, in its own worktree or the `worktree` given. Apps whose repo the worktree lacks run from main, as in the window. |
| `hub_stop_preset` | Stops the active apps of a preset. |

An app is selected by `app` (plus `worktree` or `repo` when the name is ambiguous), by `path` (the agent's working directory), or by `instance`. Log levels are read in the backend (`level.rs`) from .NET console, NLog and MSBuild formats and from the common markers of npm, node, vite, tsc, cargo and python, and an indented line takes the level of the entry above it unless it states its own.

## Known limits

- Two instances of the same app cannot run at once, because the port comes from the csproj (dev servers that pick their own port are not affected).
- A legacy web project is refused to start when its port is taken, for example by Visual Studio.
- NLog file output is not tailed yet, only the process output.
