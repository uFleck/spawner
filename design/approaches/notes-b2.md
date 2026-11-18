# B2 · Review-first worktree cockpit: implementation notes

Mockup: `b2-review.html` (simulated backend in `kit/review.js`, styles from `kit/kit.css`). Screenshots: `shots/b2-*.png`.

B2 answers one question in one click: *what do I run to test this PR?* The rail lists worktrees with open PRs first, each with **Run stack**. The workspace shows the selected worktree's stack (apps, ports, run/stop) above its scoped logs. T3 Code is where conversations happen. Spawner only links to it.

**Built on `b2-cockpit`:** slices 1–5 below. The T3 link (slice 6, the `T3` tag, Open in T3 and the gh → T3 fallback) is not built: PRs come from gh only, and when gh fails the rail says "PRs unavailable" with the reason. The contract the code follows is `impl-b2.md`.

## What changed from B

| B (round 1) | B2 |
| --- | --- |
| Rail sorted by "Needs you", "Agent working", "Apps running", "In review", "Quiet" | **In review** (open PR), **Running**, **Recent** (collapsed). Folders and Scripts at the bottom. |
| Thread column: transcript, composer, new thread | Removed. There is no chat surface. **Open in T3** shows only when a thread matches. |
| Fail cards with **Fix with agent**, **Send to thread** on selected lines | Removed. A selection can be copied, and that is all. |
| Thread status polling every 3 s, "waiting for you" toasts | Removed. gh and T3 are each read once per repo every 60 s. |
| Apps strip with Start all / Stop all | A **stack** card from a committed manifest, with ports (default or override), conflicts inline, and Run/Stop stack. |
| T3 project per worktree (`t3project`, "not in T3") | None. T3 keeps one project per repo, and Spawner never registers anything. |
| "All apps & logs" view | Kept as a folded row under the rail sections; a worktree's log toolbar has an **All logs** way out. |

## Data model

The existing shapes stay: `Group` (worktree) > `Project` (repo checkout, `branch`) > `AppDef`. B2 adds three things:

```ts
// spawner.stack.json, committed at a repo root
interface StackManifest {
  name: string;
  apps: { repo: string; app: string; port?: number }[]; // app = AppDef.name (or AppDef.id), repo = Project.repo
  open?: string[];                                       // apps whose URL "Open" offers once they run
}

// Resolved per worktree, for the UI and MCP
interface ResolvedStack {
  source: { repo: string; file: string; committed: boolean };
  apps: StackApp[];
  missing: { repo: string; app: string }[]; // named in the manifest, not found (same idea as PresetHit.missing)
}
interface StackApp {
  instanceId: string;       // existing `${projectId}::${appId}` key
  checkout: "worktree" | "main";
  port: number | null;      // resolved
  portSource: "repo" | "detected" | "worktree" | "none";
  defaultPort: number | null;
}

// Spawner app data (ports.json), never committed
type PortOverrides = Record<string /* `${project path}::${app id}` */, number>;
```

**Resolution** follows the rule presets already use (`src/presets.ts` `resolve`): each `{repo, app}` comes from the worktree's checkout of `repo`, or from the main checkout when the worktree has none. Reuse that function. Do not write a second resolver.

**Which manifest applies:** the manifest is read from the worktree's own checkout, so a branch can change its stack in the PR that needs the change. When the worktree has several repos, the first one that has a manifest wins. Prefer the repo with the open PR.

**Shared apps:** if two worktrees resolve `bill` to `C:\umbler\bill`, they share one Bill API instance. This matches today's instance keying. The stack card labels it `main · shared`. **Stop stack** leaves a shared app running while another worktree's stack still has its own apps up, and says so in a toast.

## Review and PR source

- **Primary source:** `gh pr list --repo <owner/repo> --state open --json number,title,headRefName,isDraft,reviewDecision,statusCheckRollup,url`. Make one call per repo. Get the repo slug from `git remote get-url origin` (cached per main checkout).
- **Mapping:** a worktree is *in review* when any of its worktree checkouts (not main) has `Project.branch === headRefName` for that repo slug. Matching on repo slug plus branch avoids collisions when two repos use the same branch name.
- **Displayed fields:** number, title, draft, review decision (approved, changes requested, pending), and a checks summary from `statusCheckRollup` (passed / failing with names / running).
- **Cache:** 60 s per repo. Refresh on window focus if the data is older than 60 s. While the window is hidden, stop polling, except to keep the companion window current.
- **Backoff on failure:** 60 → 120 → 240 s, capped at 10 min. Keep the last good data and show its age ("via gh · 4 min ago").
- **Fallback chain:** gh → T3 `pullRequests` (number, url, state, no review data; the row says "review state needs gh") → no In review section. Stacks, logs and the rest keep working.
- A gh that is missing or not signed in shows in the rail's In review section ("PRs unavailable" and gh's message), not in the status bar.

## T3 integration (read-only)

- **List calls:** `t3 thread list --project <main checkout> --json`, once per repo every 60 s. There is never a call per worktree.
- **Mapping a thread to a worktree:** `thread.worktreePath` ≡ `Project.path` (normalized, case-insensitive), else `thread.branch` ≡ `Project.branch`. The list does not include branch or worktreePath, so call `t3 thread show <id> --json` **once per thread that has an open PR**, and cache the result by thread id (a thread's worktree path doesn't change).
- **What T3 adds to the UI:** a small `T3` tag on the rail row and **Open in T3** in the header. Both appear only when a thread matches. Open in T3 opens the thread's web link, or the repo's project if there is no link.
- **What never happens:** `t3 project add` for worktrees, thread lists, transcripts, status polling, notifications.
- **When T3 is missing or unreachable:** the status bar shows "T3 not found" and nothing else changes. A timeout counts as unreachable and follows the same backoff as gh.

## Stack and ports

**Defaults:** a port comes from the manifest, else from detection (`<IISUrl>` for IIS Express), else there is none.

**Overrides** are per worktree checkout, in `ports.json` under Spawner's app data, keyed by `${project path}::${app id}`. That key is per worktree by construction. Overrides for a worktree are deleted when the worktree is concluded. An override on a main-checkout app applies to every worktree that shares the app, and the editor says so.

The UI shows the port on every app tile with a `default` or `override` tag. When the app runs, the port opens the app. **Edit ports** turns the ports into inputs with live validation (shows the holder and suggests a port) and a **Default N** reset. A change applies at the next start. A running app on an old port shows `restart → :N`.

**Port conflict at start:** the app doesn't start. Inline, the tile reads "Port 5104 is in use by Account Web @ PAYMENT-10138" with these actions:

- **Use 5105 and start:** saves an override and starts.
- **Edit port**
- **Stop that one:** shown only when the holder is a Spawner instance.

The other apps in the stack still start. The free port is the next port that is not listening and not assigned to another app. Today's `check_port` probe stays the source of "in use"; the assigned check is new.

**No manifest yet:** a dashed card lists the detected apps as checkboxes (tasks unchecked) with two actions:

- **Use detected apps** writes `<repo>/spawner.stack.json` into the worktree's checkout. The card then reads "new, not committed" and offers **Copy JSON**.
- **Copy AI prompt** copies a prompt that names the file, its schema, the detected apps and the MCP calls to verify it. Nothing is sent anywhere.

Do not reuse the scripts `spawner.json`. Its parser has `deny_unknown_fields`, and it describes commands, not stacks. Use a separate file with its own parser. `deny_unknown_fields` is fine there too, and an invalid file is listed with its error, the same way scripts are.

## Port pass-through per app kind

The runner already substitutes `{port}` in step args (IIS Express uses `/port:{port}`). B2 sets `{port}` to the *resolved* port and adds the flag for the kinds that have none today.

| Kind | Today | With an override |
| --- | --- | --- |
| `iis-express` | `/port:{port}` from `<IISUrl>`, `check_port: true` | Same step, resolved port. No new code. |
| `dotnet-run` (web) | No port. The URL comes from `launchSettings.json`; the detector reads `<IISUrl>` only | Append `--urls {scheme}://localhost:{port}` to `dotnet run`. Command-line config beats the `ASPNETCORE_URLS` that the launch profile sets. Check this on Account Web (https, dev certificate). Set `check_port: true` when a port is known. |
| `dotnet-run` (worker) | No port | Not applicable: "no port · worker". |
| `vite` | `learn_port` from output | `npm run dev -- --port {port} --strictPort`. `--strictPort` makes Vite fail on a busy port instead of moving to another one. |
| `next` | `learn_port` | `npm run dev -- -p {port}` |
| other npm scripts | `learn_port` | `PORT={port}` env. **`StepSpec` has no `env` field today**, so add one. Without it, these apps show "port not settable". |
| `tauri` | `devUrl` fixed in `tauri.conf.json` | **Not overridable** in v1. The frontend port is baked into the config. Shown read-only. |
| scripts (`spawner.json`) | params | Only if the script declares a `port` param. Otherwise not overridable. |
| tasks | n/a | n/a |

## MCP tools

These are new tools next to `hub_start_preset` and `hub_stop_preset`. They take the same worktree argument: group id, label, branch or folder path.

```text
hub_get_stack { worktree: string }
  → { worktree, branch, prs: [{ repo, number, url, review, checks }],
      source: { repo, file, committed } | null,
      apps: [{ app, repo, checkout: "worktree"|"main", shared: bool, kind,
               port: number|null, port_source: "repo"|"detected"|"worktree"|"none",
               default_port: number|null, state, url: string|null }],
      missing: [{ repo, app }],
      detected: [{ repo, app, kind, port }]   // only when source is null
    }

hub_set_port { worktree: string, app: string, port: number | null }
  → { app, port, port_source, applies: "next start" | "now (not running)",
      conflict?: { port, holder, free } }      // refuses a port that is listening; suggests `free`
  // null clears the override (back to the repo default). Errors for kinds that can't take a port.

hub_start_stack { worktree: string, apps?: string[], wait?: bool = true,
                  timeout_seconds?: number = 180, lines?: number = 40 }
  → { apps: [{ app, state, port, url, reused: bool,
               conflict?: { port, holder, free }, error?, last_lines? }] }
  // Starts every app concurrently, reuses shared apps that are already running,
  // and reports a conflict per app without failing the others. Same wait/lines semantics as hub_start.

hub_stop_stack { worktree: string, keep_shared?: bool = true }
  → { stopped: [app], kept: [{ app, used_by: [worktree] }] }
```

How an agent tests a branch:

1. Create the worktree (T3 or git).
2. `hub_rescan`, then `hub_get_stack` to see the stack and its ports.
3. `hub_set_port` if a port is taken or another stack runs next to it.
4. `hub_start_stack`.
5. `hub_logs` (already scoped by app) to read the result.
6. `hub_stop_stack`.

The mockup's DEMO, "AI: set port + start PAYMENT-10264", plays this flow. The calls show as `MCP` lines in the log.

## Migration slices (review and stacks first)

Each slice ships into today's sidebar and works on its own.

1. **Stack manifest and Run stack.** Parse `spawner.stack.json`, resolve it with the preset resolver, and add a Run stack / Stop stack button to the worktree header in today's sidebar. Add `hub_get_stack`, `hub_start_stack` and `hub_stop_stack`.
2. **Ports.** Add `ports.json` overrides, `{port}` resolution, `--urls`, `--port`, `-p`, `StepSpec.env`, the inline conflict with a free-port suggestion, the port editor, and `hub_set_port`.
3. **In review from gh.** Poll per repo with backoff, map PRs by repo plus branch, and put an In review section at the top of the sidebar with Run stack on each row. Add the PR strip in the workspace.
4. **Layout change to B2.** Make the rail In review / Running / Recent, give the selected worktree its stack card and scoped logs, and keep the merged log reachable. Move presets to "Save as stack" or keep them as they are under Scripts (open question).
5. **No-stack flow.** Add Use detected apps (writes the file) and Copy AI prompt.
6. **Optional T3 link.** One list call per repo every 60 s, `show` once per thread with an open PR, the `T3` tag and Open in T3.

## Risks

- **Ports wired between apps.** Account Web calls Bill API on 42318, a URL set in Account's config. If Bill API moves to 42319, Account Web still calls 42318. The manifest needs an optional per-app `env` that can reference another app's resolved port, for example `"env": { "BillApi__BaseUrl": "http://localhost:{port:Bill API}" }`. Without it, overriding a port that another app calls breaks the stack silently. The mockup does not show this; settle it before slice 2.
- **Shared main checkouts.** A stack that runs Bill API from `C:\umbler\bill` tests main's Bill API, not a branch's. This is correct when the PR is in account only, but it is easy to miss. The `main · shared` label is the only hint today.
- **dotnet `--urls` and launch profiles.** Some profiles also set `applicationUrl` with two URLs (http and https). `--urls` replaces both. Check that the https dev certificate still applies.
- **gh volume.** With N repos every 60 s, gh's rate limit is not a concern, but each call starts a process (about 300–600 ms on Windows). Run the calls in parallel and never on the UI thread.
- **headRefName from forks.** A fork PR whose branch name matches a local branch would map to the wrong worktree. Match on `headRepositoryOwner` too.
- **T3 output shape.** It is assumed from the brief: `list` has `pullRequests`, `show` has `branch` and `worktreePath`. If `list` ever includes those fields, drop the `show` calls.

## What the backend gained, and what it still can't do

- Built: `StepSpec.env`, the `ports.json` override store, the gh client (`open_prs`, repos in parallel, partial errors), the stack parser with `env` and `{port:<app>}` (the linked-ports risk above is settled this way), and the four stack MCP tools.
- `dotnet-run` apps carry no port until the manifest gives one; the card then says "port at start".
- Tauri dev ports, scripts and tasks cannot take a port, since moving a Tauri port means moving the frontend's too. The card says "no port".
- With an override set, `learn_port` is off and the passed port is trusted.

## What not to build

- No chat, transcript, composer, conversation pane, "Send to thread" or "Fix with agent".
- No "Needs you" section, agent-status queue, agent notifications or thread status polling.
- No kanban, board, lanes, cards or drag.
- No `t3 project add` per worktree, and no T3 project per worktree.
- No PR review UI beyond the one strip (no diff, no comments). Open PR goes to GitHub.
- No committed per-worktree files. Overrides stay in app data.

## Open questions

- Should the merged "All logs" view stay as a footer row, or is the scoped view enough?
- Should Run stack on a review row also open the `open` app once it's up, or keep that as one more click (the mockup offers it as a button)?

## Follow-up after 0.1.12

Shipped in `cockpit-fixes` after using 0.1.12:

- The **Scripts** section is gone from the window. Script support was removed completely right after (see below).
- **Presets** are gone from the window: no section, no context-menu entries, no palette commands. The stack card absorbed saving a set of apps (**Save as stack**, defaulting to the ones already running). The `ui-state.json` key is kept verbatim so the `hub_*_preset` tools and presets saved by earlier versions still work.
- The PR pill at the top (`account #1736`) opens that PR on GitHub; the separate **Open PR** button is gone.
- Run/Stop are icon-only buttons in the rail and the workspace header, with tooltips.
- **All apps & logs** reads folder → worktree → projects. The folder row shows how many worktrees/projects it holds and how many apps are running.
- **Copy AI prompt…** opens a preview of the exact text, with the copy button in the dialog.
- Dragging works from the workspace header (and the rail header) even over the title, the pills' row and the metadata line; controls keep their clicks.

## After 0.1.13

Scripts are gone from Spawner, not just from the window:

- `spawner.json` is no longer read, so a script app cannot appear in a scan.
- `hub_script_guide`, the `params`/`args` arguments of `hub_start`, and the script notifications are removed.
- The agent instructions (`~/.claude/CLAUDE.md`, `~/.claude_linck/CLAUDE.md`, `~/.config/opencode/AGENTS.md`) now say Spawner and Hopper are mandatory in Umbler repos but used only when asked, and that scripts are not used through Spawner.

## How it was checked

**The implementation** (`b2-cockpit`): `cargo test` (161 passed, 9 ignored) and `npm run build`. A smoke test against the real backend on this machine: the scan (15 groups), `open_prs` (66 real open PRs across 12 repos in 2.8 s, with partial errors), a real `spawner.stack.json` resolved with `{port}` and `{port:<app>}`, a `set_port` override, and `start_stack` / `stop_stack` on a scratch Node app that answered on 5391, then on 5392 after the override (proving `PORT` and `env`). The window ran at 1280 × 800 on real data (`shots/impl/real-workspace.png`). The polish pass drove the mock UI in headless Chromium over CDP at 1280 × 800 and 720 × 560, light and dark, with a clean console (`shots/polish/`).

Real data differs from the mockup in three ways. Most real PRs have no CI, so the strip says "no checks yet" instead of a pass count. Many worktrees have no manifest yet, so the no-stack card is the common case and not an edge case. And a task can be a main checkout on the task branch (for example `C:/umbler/account` on PAYMENT-10277), which is why the header shows the checkout path.

**The mockup:** `b2-review.html` was served over http (`python -m http.server`) and run in headless Chromium (`chrome-headless-shell` 1208) with a script that clicks through every scenario:

- the default review in dark and light
- review row → Run stack → building → running → Open (toast `https://localhost:5104`) → Stop stack → idle
- editing a port to 5108, which then shows `override`
- no stack → Copy AI prompt → Use detected apps → 2 apps → Run stack → running
- port conflict on 5104 → "Use 5105 and start" → running with the override
- T3 absent: no T3 tag or button, PRs still from gh, "T3 not found" in the status bar
- a real 720 × 560 viewport in dark and light: rail off-canvas as a drawer, stack folded, logs 720 px wide, no horizontal scroll
- the MCP flow: port 5121 set and the stack running

The console had no errors. All screenshots come from these runs.

**Not covered:**

- Nothing ran against the real `gh`, `t3` or runner. Latency and failures are simulated.
- PR titles are illustrative. PR numbers and branches come from the brief.
- The gh-missing and both-missing fallbacks work only from the DEMO "Sources" toggles. They were not screenshotted.
