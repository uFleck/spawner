# B2 implementation contract (branch `b2-cockpit`)

Approved direction: [b2-review.html](b2-review.html) + [notes-b2.md](notes-b2.md). This file is the shared contract for the
two implementation agents. **Do not change the types, command names or field names below without telling the
orchestrator**: the Rust and TS sides are written in parallel against this file.

## Goal

Turn the approved B2 mockup into the real Spawner UI:

- Rail: **In review** (worktrees with open PRs, one-click Run stack), **Running**, **Recent**, then Scripts, the
  existing app tree (as "All apps & logs", collapsed) and Folders.
- Workspace, for the selected worktree: header (label, branch, PR chip, checks, Run stack, Stop stack, Open PR),
  **stack card** (apps, kind, state, port with default/override tag, run/stop per app, Edit ports, inline port
  conflict, no-stack setup), then that worktree's scoped merged logs.
- `spawner.stack.json` is a committed repo file; every new worktree of that repo inherits the stack.
- Port overrides are per checkout, saved by Spawner (never committed), and can be set from the UI or MCP.
- Linked ports: a manifest entry may carry `env` with `{port:<app name>}` interpolation, so moving Bill API's port
  updates `BillApi__BaseUrl` without touching application code. **This is the approved answer for linked ports.**
- MCP: `hub_get_stack`, `hub_set_port`, `hub_start_stack`, `hub_stop_stack`.

## Hard non-goals (rejected by the user)

- No chat, transcript, composer, conversation pane, "Send to thread", "Fix with agent".
- No kanban/board/lanes/cards/drag.
- No "Needs you", agent status queue, agent notifications, thread-status polling.
- No `t3 project add`, no T3 project per worktree, no T3 calls in this pass (a later polish slice adds one read-only
  link; nothing here may depend on T3).
- No committed per-worktree files. Overrides live in Spawner app data.
- Do not reuse `spawner.json` (scripts). It has `deny_unknown_fields` and describes commands, not stacks.

## Ownership

| Agent | May modify | Must not touch |
| --- | --- | --- |
| backend | `src-tauri/**` | `src/**` |
| frontend | `src/**` | `src-tauri/**` |

Both may read anything, including `design/approaches/b2-review.html` and `kit/review.js` (the simulated UI) and
`kit/kit.css`. Do not commit; the orchestrator reviews and commits.

---

## 1. Stack manifest

File: `spawner.stack.json` at a repo root (the worktree's checkout, so a PR can change its own stack).

```json
{
  "name": "Account + Bill",
  "apps": [
    {
      "repo": "account",
      "app": "Acme.Account.Admin.Server",
      "port": 5104,
      "scheme": "https",
      "env": { "BillApi__BaseUrl": "http://localhost:{port:Acme.Bill.API}" }
    },
    { "repo": "bill", "app": "Acme.Bill.API", "port": 42318 }
  ],
  "open": ["Acme.Account.Admin.Server"]
}
```

- `repo`: `Project.repo` (folder name of the repo).
- `app`: `AppDef.name` (case-insensitive), falling back to `AppDef.id` and to the id without extension.
- `port`, `scheme` (`http` default, or `https`), `env`, `open` are optional.
- `env` keys/values are strings. Placeholders: `{port}` (this app's resolved port), `{port:<app name>}` (another
  stack app's resolved port, matched like `app` above), `{cwd}`. An unresolvable placeholder is an error for that app
  at start, not a silent literal.
- Parsing: `serde` with `deny_unknown_fields`, camelCase. An invalid file is an error surfaced on the stack card
  (`source.file` + message), never a panic. Missing file ⇒ no source.

## 2. Rust

### 2.1 `src-tauri/src/stack.rs` (new)

```rust
pub const FILE: &str = "spawner.stack.json";

pub struct StackFile { pub name: Option<String>, pub apps: Vec<Entry>, pub open: Vec<String> }
pub struct Entry { pub repo: String, pub app: String, pub port: Option<u16>, pub scheme: Option<String>, pub env: BTreeMap<String, String> }

// JSON shapes (Serialize, rename_all = "camelCase")
pub struct StackSource { pub repo: String, pub file: String, pub committed: bool }
pub struct StackAppOut {
    pub project_id: String, pub app_id: String, pub instance: String,
    pub app: String, pub repo: String,
    pub checkout: String,   // "worktree" | "main"
    pub shared: bool,       // checkout == "main" and the worktree is not main
    pub kind: String,
    pub mode: String,       // "service" | "task"
    pub port: Option<u16>,
    pub port_source: String, // "worktree" | "repo" | "detected" | "none"
    pub default_port: Option<u16>, // manifest port else detected app.port
    pub port_settable: bool,
    pub url: Option<String>, // "{scheme}://localhost:{port}" when a port is known
    pub env: BTreeMap<String, String>, // resolved values, only what the manifest declares
}
pub struct MissingOut { pub repo: String, pub app: String }
pub struct StackOut {
    pub worktree: String, pub label: String, pub branch: Option<String>,
    pub name: Option<String>,
    pub source: Option<StackSource>,
    pub open: Vec<String>,
    pub apps: Vec<StackAppOut>,
    pub missing: Vec<MissingOut>,
    pub detected: Vec<StackAppOut>, // only when source is None: every service app of the worktree, for "Use detected apps"
}
```

Resolution rules:

1. Walk `group.projects` in order; the first `spawner.stack.json` that parses wins. Record its repo and absolute path.
   `committed` = `git -C <repo path> ls-files --error-unmatch spawner.stack.json` succeeds (no error if not a repo).
2. For each entry, find the project in the group with that `repo`: a non-main project first (the worktree's own
   checkout), else the main one. Find the app by name/id (case-insensitive). Not found ⇒ `missing`.
3. Port: worktree override (key `project.id::app.id`) ⇒ `worktree`; else manifest `port` ⇒ `repo`; else detected
   `app.port` ⇒ `detected`; else `none`. `default_port` is the same without the override.
4. `port_settable` is true for kinds `iis-express`, `dotnet-run`, `vite`, `next`, `react`, `node`, and false for
   `tauri`, `script`, `dotnet-test`, tasks.
5. `detected` (no manifest): every app of the worktree's own projects with `mode == "service"`, using detected
   ports; `port_source` = `detected` or `none`.

Also in `stack.rs`:

```rust
/// Applies a resolved port to a copy of the app: sets app.port, check_port = true, learn_port = false, and adds the
/// kind-specific flag. Returns Err for kinds that cannot take a port.
pub fn apply_port(app: &mut AppDef, port: u16, scheme: &str) -> Result<(), String>;
```

Port pass-through:

| kind | what `apply_port` does |
| --- | --- |
| `iis-express` | app.port = port (the step already has `/port:{port}`) |
| `dotnet-run` | append `--`, `--urls`, `{scheme}://localhost:{port}` to the last step's args |
| `vite` | append `--`, `--port`, `{port}`, `--strictPort` to the last step |
| `next` | append `--`, `-p`, `{port}` to the last step |
| `react`, `node` | set env `PORT={port}` on every step |
| anything else | `Err("<name> cannot take a port override (<kind>)")` |

`scheme` default `"http"`. Idempotence matters: apply to a fresh clone from `hub.groups()`, never to a cached app.

### 2.2 `src-tauri/src/runner.rs`

- `StepSpec` gains `env: BTreeMap<String, String>` (`#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]`).
  `Step` carries it too; `run_step` calls `cmd.envs(&step.env)`.
- `Hub` gains a port-override store loaded from `ports.json` in app data: `Mutex<HashMap<String, u16>>` keyed
  `project.id::app.id`, plus its file path. Methods:
  - `pub fn port_overrides(&self) -> HashMap<String, u16>`
  - `pub fn set_port_override(&self, project_id: &str, app_id: &str, port: Option<u16>) -> Result<(), String>` (writes
    atomically; `None` removes)
  - `pub fn read_ports_from(&self, file: PathBuf)` / `persist_ports_to(&self, file: PathBuf)`, same style as
    `read_ui_state_from`.
- `start_with` keeps its signature. After `find_app`, apply the override (if any) with `stack::apply_port` before
  preflight/`launch_plan`. So the UI's per-app Run and `hub_start` respect overrides.
- Add `pub fn start_app(self: &Arc<Self>, project: &Project, app: AppDef, force: bool) -> Result<(), String>` that
  does the preflight/plan/spawn part for an already-resolved app (no override applied, no script params). `start_with`
  delegates to it.
- Make `preflight`'s busy-port message keep the exact prefix `port {port} is already in use`, so the UI can recognise
  it. Expose `pub fn port_holder(port: u16) -> Option<String>` (process name from the existing netstat/tasklist code)
  and `pub fn free_port_suggestion(port: u16) -> u16` (next port not listening and not assigned to an app in
  `hub.ports()`/overrides; scan upward from `port + 1`).

### 2.3 `src-tauri/src/review.rs` (new)

```rust
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct Checks { pub pass: u32, pub fail: u32, pub pending: u32, pub failing: Vec<String> }
pub struct Pr {
    pub repo: String,   // local repo name (folder of the checkout)
    pub slug: String,   // owner/repo from the git remote
    pub number: u64, pub title: String, pub head: String,
    pub draft: bool,
    pub review: Option<String>, // "approved" | "changes" | "pending" | null
    pub url: String,
    pub checks: Checks,
}
```

- `pub fn open_prs(checkouts: &[(String, String)], force: bool) -> Result<Vec<Pr>, String>` where checkouts are
  `(repo_name, path)`. Cache per repo for 60 s in a `static` Mutex; `force` bypasses. Run `gh` with
  `spawn_blocking` from the command; each call gets a 20 s timeout (`std::process::Command` + a thread is fine;
  simpler: run them sequentially but cheaply — 2–4 repos).
- Command: `gh pr list --repo <slug> --state open --limit 50 --json number,title,headRefName,isDraft,reviewDecision,statusCheckRollup,url`.
- Slug from `git -C <path> remote get-url origin` (handle `git@github.com:owner/repo.git` and https).
- `review`: `APPROVED` → `approved`, `CHANGES_REQUESTED` → `changes`, anything else non-null → `pending`.
- `checks`: count `statusCheckRollup` entries: pass for `SUCCESS`/`NEUTRAL`/`SKIPPED`, fail for `FAILURE`/`ERROR`/
  `TIMED_OUT`/`CANCELLED`/`ACTION_REQUIRED`, pending otherwise; `failing` = names of failed ones (cap 5).
- A missing `gh`, a failed call or bad JSON returns `Err` with a readable message. No panics, no retries loop here.

### 2.4 `src-tauri/src/lib.rs`

New managed data file: `ports.json` (via `data_file`), passed to `hub.persist_ports_to(...)` and
`hub.read_ports_from(...)` in `setup`, next to `watch`/`ui-state`.

New Tauri commands (register all of them):

```rust
stack(hub, worktree: String) -> Result<stack::StackOut, String>
write_stack(hub, worktree: String) -> Result<stack::StackOut, String>   // writes FILE from detected service apps; Err if it exists
set_port(hub, project_id: String, app_id: String, port: Option<u16>) -> Result<(), String>
free_port(hub, port: u16) -> u16
start_stack(hub, worktree: String, apps: Option<Vec<String>>) -> Result<Vec<stack::Run>, String>
stop_stack(hub, worktree: String, keep_shared: Option<bool>) -> Result<Vec<stack::Stop>, String>
open_prs(hub, force: Option<bool>) -> Result<Vec<review::Pr>, String>
```

`stack::Run { app, instance, state: String, port: Option<u16>, url: Option<String>, error: Option<String>, reused: bool }`
and `stack::Stop { app, instance, stopped: bool }` (both camelCase). `state` uses the lowercase kind
(`running`, `failed`, `starting`, `building`, `stopped`...).

`start_stack`:

1. Resolve. If `source` is None, error `"no spawner.stack.json: use write_stack or add one"`.
2. Select apps: `apps` names if given, else every `mode == "service"` app. Ignore `missing`.
3. For each: skip if its instance is active (`reused: true`); otherwise build a fresh app from `hub.groups()`, apply
   the resolved port (if `port_settable` and a port exists), interpolate `env` (own `{port}` and `{port:Other}` from
   the other selected apps' resolved ports), put it on every step, then `hub.start_app(&project, app, false)`.
4. Wait concurrently until each is running/exited/failed (or `timeout_seconds`, default 180). Return per-app results;
   one app's error never blocks the others. Busy port ⇒ `error` text and `state: "failed"`.
5. UI calls wait with a 240 s allowance; MCP with its own timeout.

`stop_stack`: resolve, stop each selected app that is active. `keep_shared` (default **true for MCP, false for UI**
via the command argument) skips apps with `shared == true` when true.

`open_prs`: collect `(repo, path)` from every non-script group's projects (dedupe by path, prefer main checkout paths
for the slug), call `review::open_prs`.

### 2.5 `src-tauri/src/mcp.rs`

Add the four tools to `INSTRUCTIONS` + `tool_definitions()` + `call_tool`:

```
hub_get_stack  { worktree: string }
hub_set_port   { worktree: string, app: string, port: number|null }
hub_start_stack{ worktree: string, apps?: string[], wait?: bool = true, timeout_seconds?: number = 180, log_lines?: number = 40 }
hub_stop_stack { worktree: string, keep_shared?: bool = true }
```

- Worktree selection: id or label, case-insensitive (reuse `task_worktree`; `main` allowed).
- `hub_get_stack` returns the same JSON as the command, pretty-printed, plus a one-line hint when `source` is null:
  "No stack yet: call hub_start_stack after the user adds spawner.stack.json, or ask them to press Use detected apps."
  and, when `missing` is non-empty, the missing entries.
- `hub_set_port` saves the override and returns the new port + `port_source`. Error for non-settable kinds.
- `hub_start_stack` / `hub_stop_stack` use the same stack functions; format a compact per-app report like
  `preset_report` (one line per app: name, state, port/url or error).
- Do not remove or rename existing tools. `hub_list_presets` etc. keep working.

### 2.6 Rust tests

- `stack.rs`: parse valid/invalid; resolution worktree-vs-main; override precedence; `apply_port` for
  iis-express, dotnet-run (`--urls`), vite, next, node (`PORT`), tauri (error); env interpolation incl. unknown
  placeholder error.
- `runner.rs`: `Step.env` reaches the plan; override changes the effective port; `free_port_suggestion` skips a
  listening port.
- `review.rs`: slug parsing (`git@` and https), review mapping, checks counting (one test with a small JSON fixture;
  no real `gh`).
- `cargo test` must pass; `cargo check` must be clean.

---

## 3. TypeScript

### 3.1 `src/api.ts`

Add (mirror the Rust JSON exactly):

```ts
export interface StackSource { repo: string; file: string; committed: boolean }
export interface StackApp {
  projectId: string; appId: string; instance: string;
  app: string; repo: string;
  checkout: "worktree" | "main"; shared: boolean;
  kind: string; mode: AppMode;
  port: number | null; portSource: "worktree" | "repo" | "detected" | "none";
  defaultPort: number | null; portSettable: boolean;
  url: string | null; env: Record<string, string>;
}
export interface StackMissing { repo: string; app: string }
export interface ResolvedStack {
  worktree: string; label: string; branch: string | null; name: string | null;
  source: StackSource | null; open: string[];
  apps: StackApp[]; missing: StackMissing[]; detected: StackApp[];
}
export interface StackRun { app: string; instance: string; state: string; port: number | null; url: string | null; error: string | null; reused: boolean }
export interface StackStop { app: string; instance: string; stopped: boolean }
export interface PrChecks { pass: number; fail: number; pending: number; failing: string[] }
export interface Pr { repo: string; slug: string; number: number; title: string; head: string; draft: boolean; review: "approved" | "changes" | "pending" | null; url: string; checks: PrChecks }
```

`StepSpec` gains `env?: Record<string, string>`.

`api` gains:

```ts
stack: (worktree: string) => invoke<ResolvedStack>("stack", { worktree }),
writeStack: (worktree: string) => invoke<ResolvedStack>("write_stack", { worktree }),
setPort: (projectId: string, appId: string, port: number | null) => invoke<void>("set_port", { projectId, appId, port }),
freePort: (port: number) => invoke<number>("free_port", { port }),
startStack: (worktree: string, apps?: string[]) => invoke<StackRun[]>("start_stack", { worktree, apps: apps ?? null }),
stopStack: (worktree: string, keepShared = false) => invoke<StackStop[]>("stop_stack", { worktree, keepShared }),
openPrs: (force = false) => invoke<Pr[]>("open_prs", { force }),
```

### 3.2 `src/store.ts`

- `Snapshot` gains:
  - `stack: ResolvedStack | null` and `stackFor: string | null` (the worktree it belongs to),
  - `stacks: Record<string, ResolvedStack>` (cache keyed by worktree id),
  - `stackBusy: boolean`, `stackError: string | null`,
  - `prs: Pr[]`, `prsAt: number`, `prsError: string | null`,
  - `selectedWorktree: string | null` (null = All apps & logs / merged view),
  - `stackConflicts: Record<string, { port: number; holder: string | null; free: number }>` keyed by instance id.
- Actions:
  - `selectWorktree(id: string | null)` — sets selection, loads the stack (and its apps) if missing/stale.
  - `loadStack(id: string, force?: boolean)`.
  - `refreshPrs(force?: boolean)` — calls `api.openPrs`, sets `prs`/`prsAt`/`prsError`; never throws.
  - `setPort(projectId, appId, port)` — call, then reload every cached stack that contains the app.
  - `startStack(id, apps?)` — reload stack first, set `stackBusy`, call, refresh states/ports and the cached stack,
    turn `port {N} is already in use` errors into `stackConflicts` with `free = await api.freePort(N)`.
  - `stopStack(id)`, `writeStack(id)`, `clearStackConflict(instance)`.
  - `openPrs` are read-only; no polling in the store. `App.tsx` calls `refreshPrs()` on mount, every 60 s while the
    window is visible, and on window focus when older than 60 s. Failures back off (60 → 120 → 240, cap 600 s).
- Nothing is persisted for stacks/ports beyond `set_port` (backend owns `ports.json`).

### 3.3 `src/dev/mockBackend.ts`

Extend the mock with `stack`, `write_stack`, `set_port`, `free_port`, `start_stack`, `stop_stack`, `open_prs` so the
UI can be built and screenshotted in a plain browser (`npm run dev`):

- A manifest for `account`/`bill` matching the mock apps, a no-stack worktree (one group without a manifest), and a
  port-conflict group whose port is "busy".
- `open_prs` returns the real-looking PRs used in the mockup (#1720 `PAYMENT-10138` approved, #1736
  `PAYMENT-10277` changes requested + 1 failing, #1734 `PAYMENT-10264` draft).
- `start_stack` moves apps through building → running like `start`, and fails one app with
  `port 5104 is already in use` in the conflict group.
- Everything must still work when `open_prs` rejects (simulate with `?nogh`).

### 3.4 UI

Components:

- `src/components/ReviewRail.tsx` (new) — the rail body: search is today's field (in `Sidebar`), then sections
  **In review**, **Running**, **Recent** (collapsed by default). Rows: worktree label, repo(s), PR chip (number, title,
  review state, checks), app count, states dots, and a compact Run stack / Stop stack button. Rising to the top
  requires an open PR. Clicking selects the worktree (`actions.selectWorktree`).
- `src/components/StackCard.tsx` (new) — the whole stack area: source line (`repo/spawner.stack.json`, `new, not
  committed` when `!committed`), app rows (name, kind, `:port` with `default`/`override` tag, `main · shared`,
  run/stop per app, open), `Edit ports` toggles inputs with validation and a `Default N` reset, inline conflict
  (`Port N is in use...`, `Use F and start`, `Edit port`), missing entries, and the no-stack state (`No stack yet`,
  checkboxes of detected service apps, `Use detected apps`, `Copy AI prompt`).
- `src/components/WorktreeView.tsx` (new) — the workspace for `snap.selectedWorktree`: header (label, branch, PR
  chip + checks, `Run stack`, `Stop stack`, `Open PR`), the stack card, then the scoped logs. Renders `null` when
  nothing is selected.
- `src/components/LogPane.tsx` — add an optional `scope: Set<string> | null` prop: when set, only those instance ids'
  lines are shown, filters/search still work, and the app filter chips list only scoped apps. Header says
  `logs · <worktree label>` and offers `All logs` (calls `actions.selectWorktree(null)`).
- `src/App.tsx` — `snap.selectedWorktree` decides: `WorktreeView` (header + stack + `LogPane scope`) or today's merged
  `LogPane` unchanged. "All apps & logs" must stay reachable from the rail.
- `src/components/Sidebar.tsx` — replace the top tree with `ReviewRail`; keep Pinned, marks, Scripts, the existing tree
  under a collapsed **All apps & logs** row, and Folders. Remove the "runbar" restart/stop-all row from the top (keep
  those actions in the context menus / status bar already there).
- Styles in `src/styles/hub.css` using existing tokens/classes (`rail`, `wtg`, `apps`, `runbtn`, `btn`, `card`,
  `dot`, `sum live/bad`, `mono`, `muted`). Match the mockup's density and visual language; no new design system, no
  gradients, no shadows beyond what exists.

Behaviour rules:

- Selecting a review row selects that worktree; its stack card loads; Run stack runs it.
- A worktree with no stack shows the no-stack card, not an empty space.
- Port edits apply on the next start; a running app on an old port tags `restart → :N`.
- Stop stack stops every stack app (the UI passes `keepShared = false`).
- In review is empty when `open_prs` fails; the rest of the app works. Show `PRs unavailable: <short reason>` in the
  section only, and the age (`via gh · 4 min ago`) when data is stale.
- Narrow (≤ 959 px): the rail is today's drawer; the workspace stacks header/card/logs with no horizontal scroll.
- No chat surfaces anywhere.

### 3.5 Frontend checks

- `npm run build` (tsc + vite) passes with no `any` additions and no unused imports.
- Browser run through `npm run dev` (mock backend) at 1280×800 and 720×560, dark and light, in headless Chromium:
  default review, select a review row → Run stack → running → Stop stack, edit a port, conflict → Use N and start,
  no-stack → Use detected apps → Run stack, `All logs` back to merged, `?nogh` (no PRs) still usable.
- Screenshots (PNG, from those runs) into `design/approaches/shots/impl/` — `b2-rail.png`, `b2-workspace.png`,
  `b2-conflict.png`, `b2-nostack.png`, `b2-narrow.png`.
- Console clean. No forbidden strings (`chat`, `composer`, `kanban`, `needs you`, `add to t3`).

---

## 4. Verification by the orchestrator

- `cargo test` and `cargo check` in `src-tauri`; `npm run build` at the root.
- Read the diffs for the contract; fix mismatches.
- Run the real app once (`npm run tauri dev`) if the machine allows, confirm the stack card loads and the merged view
  still works, then hand to the polish agent (Opus, medium).

## 5. Known limits (write them into the notes, do not hide them)

- `dotnet run -- --urls <url>` overrides the launch profile's URLs; verify the https dev certificate still works on
  Account Web in the polish pass. If it does not, the manifest's `scheme` is the switch.
- Tauri dev ports stay read-only.
- Scripts are settable only through their own params; not in this pass.
- Fork PRs whose branch name matches a local branch can map to the wrong worktree; match `repo` + `head` only for now.
- gh is read-only here: no comments, reviews or merges.
