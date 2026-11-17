# Spawner × T3 Code: implementation notes

How each affordance in the three mockups maps to code, what the backend has to add, and in what order to ship it. The mockups share one simulated backend (`kit/kit.js`), so the notes below apply to all three unless a section says otherwise.

## 1. What exists today, and what is new

Existing Tauri commands the mockups reuse unchanged:

| Affordance | Today |
|---|---|
| Run / Stop / Restart app, Retry after a failed build | `start`, `stop` (restart is stop then start in `store.ts`) |
| Open the app's port | `open_port`; port from `instance-port` events and learned ports |
| Log stream, level filter, source chips, selection | `logs_since` + `log-line` events; LogPane filtering is client-side |
| Worktree → project → app tree, branch, scripts | `groups`, `scan`, `groups-changed` |
| App state dots, building bar, fail cards | `instance-state` events (`building`, `starting`, `running`, `exited`, `failed`) |
| Status bar MCP port, companion toggle, theme | `mcp_info`, `get_settings` / `set_settings`, `settings-changed` |
| Conclude worktree with undo | `conclude_worktree`, `restore_worktrees` |

There is no T3 code in `src-tauri` today (`agent.rs` only wires MCP into agent CLIs). Everything T3-related is new and lives in one module.

### New: `src-tauri/src/t3.rs`

One owner of every `t3` call. It never reads `statev2.sqlite`.

```rust
pub enum T3Health { Ok { version: String, origin: String }, Missing, Down { origin: Option<String> }, Slow { last_ok: u64 } }

pub struct ThreadView {            // parsed from `thread list --json` (+ `show` for active ones)
    thread_id: String, project_path: String, title: String, link: String,
    status: String, settled: bool, pending_requests: u32,     // pending > 0 => "waiting for you"
    items: u32, model: Option<String>, updated_at: u64,
    branch: Option<String>, worktree_path: Option<String>,
    pull_request: Option<Pr>, messages: Vec<Message>,        // last N only, from `show`
    fetched_at: u64,                                         // when Spawner read it; the UI shows its age
}
pub enum T3Error { Missing, Down, Timeout, Unregistered { path: String }, Failed { code: i32, stderr: String } }
```

New commands (all async, none blocks the UI thread, each has a hard timeout):

| Command | `t3` call | Timeout | Used by |
|---|---|---|---|
| `t3_health()` | `t3 --version` + read `%USERPROFILE%\.t3\userdata\server-runtime.json` + `GET {origin}/` | 3 s | status-bar dot, T3 dialog, degraded cards |
| `t3_threads(project)` | `t3 thread list --project <path> --json` | 10 s | rail/tree/board thread lines, PR chips |
| `t3_thread(id, n)` | `t3 thread show <id> --messages <n> --json` | 10 s | conversation pane, fix card progress, ask card |
| `t3_start(project, message, title)` | `t3 thread start <project> - --title <t> --json` (message on stdin, **no `--wait`**) | 15 s | Fix with agent, New thread, Send to new thread |
| `t3_send(id, message)` | `t3 thread send <id> - --json` (stdin, no `--wait`) | 15 s | composer, Send to thread |
| `t3_open(project)` | `t3 app <path>` | 5 s | Open in T3, Approve in T3 |
| `t3_project_add(path, title)` | `t3 project add <path> --title <label>` | 10 s | Add to T3 (unregistered) |

Rules that keep it honest:

- **Never pass `--wait`.** `--wait` blocks until the agent finishes, which can take many minutes. Spawner starts or sends, gets the thread id back, and learns the rest by polling. The exit codes 1 (run failed) and 2 (waiting for an answer) are read from `thread show` fields (`status`, `pendingRequestCount`) instead.
- Messages go on stdin (`-`), never as an argument: log excerpts contain quotes, backslashes and newlines, and `cmd.exe` mangles them.
- Run `t3.cmd` through `std::process::Command` with `CREATE_NO_WINDOW`, kill the whole tree on timeout (same job-object pattern as `job.rs`).
- "No T3 Code project matches '<path>'" on stderr maps to `T3Error::Unregistered`. Anything else non-zero is `Failed` with stderr shown verbatim in the toast or card.
- Where the CLI is found: `t3` on PATH, then `%USERPROFILE%\.t3\bin\t3.cmd`. Cache the resolved path; re-resolve only when the user presses "Check again".

### New events

`t3-health` (`T3Health`), `t3-threads` (`{ project, threads: ThreadView[], fetched_at }`), `t3-thread` (one `ThreadView` with messages), `t3-error` (`{ project?, error: T3Error }`). The front end never polls; the Rust poller emits.

### Data model additions (front end, `store.ts`)

```ts
t3: { health: T3Health; threads: Record<string, ThreadView>; seen: Record<string /*project*/, { at: number; error?: T3Error }>;
      outbox: Record<string /*threadId*/, OutMsg[]>;   // optimistic sends: sending | sent | queued | failed (+ retry)
      fixes: Record<string /*instanceId*/, { threadId?: string; phase: "starting" | "thread" | "error"; err?: string; startedAt: number }> }
```

Mapping a thread to a worktree (`wtOfThread`): if `show` returned `worktreePath`, match it against a `Project.path`; otherwise match `projectPath` against the worktree root (`Group.rootPath`). Threads whose path matches nothing are not shown (they belong to projects Spawner does not run).

Persist only `fixes` (so a restart still knows "this failed build has a thread") in `save_ui_state`. Thread data is never persisted; it is re-read on start.

## 2. Refresh strategy (T3 has no push API)

One poller in Rust, per T3 project Spawner knows about (one `thread list` per distinct project path, not per checkout):

| Situation | Interval |
|---|---|
| Any thread `running`, `starting` or waiting for you | 3 s for `thread list`; `thread show --messages 6` only for the thread on screen and for threads tied to a fix card |
| All threads idle or settled | 30 s |
| Spawner window hidden or minimised (tray / companion only) | 60 s, but keep 3 s for threads tied to a fix card so the companion and toasts stay right |
| Call failed (down / timeout) | back off: 3 → 6 → 12 → 24 → 48 → 96 → 120 s cap; reset on the first success |
| User action (start, send, add project, "Check now", window focus) | poll that project immediately |

- At most one call in flight per project; at most 3 `t3` processes at once overall.
- `t3_health` runs at start, on window focus if older than 60 s, and after any `Down`/`Missing` error. It is cached; nothing else calls `--version`.
- Cache the last good `ThreadView` per thread with `fetched_at`. On failure keep showing it, dimmed, with "as of 09:41" (the mockups' stale dot and the timeout note in the conversation).
- Emit `thread-changed` only when the derived status changes (`running → waiting`, `running → completed`); that drives the toasts ("waiting for your approval", "the agent finished") and the tray badge.

## 3. Failure, timeout and degraded handling

Every T3 action shows progress, a result and a failure, and none of them blocks the app:

| State | Detected by | What the UI says | Offered fix |
|---|---|---|---|
| Not installed | no `t3` on PATH or in `.t3\bin` | "T3 Code isn't installed" card where threads would be; Fix with agent becomes **Copy fix prompt** | Check again · Get T3 Code |
| Server down | CLI present, `server-runtime.json` missing/stale pid, or health GET fails | "T3 Code isn't running"; threads shown as of last success, dimmed | Open T3 Code (`t3 app`) · Check now |
| Project not registered | stderr "No T3 Code project matches" | "<worktree> isn't a T3 project" with the exact command | **Add to T3** (`t3 project add`), then the original action continues |
| CLI slow / timeout | 10 s timeout on list/show, 15 s on start/send | status bar "T3 slow"; conversation note "t3 timed out · showing 09:41 · next try in 24 s" | automatic backoff; Check now |
| Start fails | non-zero exit | fix card goes to error with stderr; new-thread composer keeps the typed text | Try again |
| Send fails | non-zero / timeout | the message stays in the conversation as "Not sent: …" | Try again (resends the same text) |
| Thread busy | `status: running` | composer hint "Busy · it gets this as its next turn"; message shows "Queued" | none needed |
| Waiting for an answer | `pendingRequestCount > 0` | "waiting for you" everywhere; ask card shows the command | **Approve in T3** = `t3 app <project>`; the CLI cannot approve, and the mockups say so |
| Agent finished | `status: completed` | fix card "The agent says it's fixed" + last message | **Retry build** (plain `start`) |

Things the mockups deliberately do not do: approve permissions from Spawner, stream tokens, start a thread in a new T3 worktree for a Spawner worktree (the `--worktree` flag makes a *new* worktree, which would split the task in two), or deep-link to a thread inside the desktop app (the CLI has none; the `link` URL opens the web app and is labelled that way).

Fix with agent prompt (built in Rust from the instance's last error lines, same text as `K.fixPrompt`):

```
Account Web (cibi) fails to build in C:\dev\PAYMENT-9987\cibi on branch fix/webhook-retry.

Build output (MSBuild, Debug):
  Services\AsaasService.cs(48,17): error CS0246: …
  Services\AsaasService.cs(212,31): error CS0246: …

Fix the build. Don't start the app yourself; I run it in Spawner (app "Account Web", worktree PAYMENT-9987). Tell me when it builds.
```

The dialog shows the exact text and the exact command before anything is sent (in-app `Dialog`, never a native one, per CLAUDE.md).

## 4. Per-approach mapping

### A · Cockpit (additive)

| Affordance | Implementation |
|---|---|
| Tree line under each worktree: lead thread, status, PR chip | `t3-threads` for `Group.rootPath`; lead = waiting > running > failed > completed > settled, then newest |
| "Add to T3" pill on unregistered worktrees | `t3_project_add` |
| Work panel (threads list, conversation, composer, Open in T3) | `t3_thread` for the selected thread; `t3_send`; `t3_open` |
| Fail card → Fix with agent / progress / Retry build | existing fail card in `LogPane` + `fixes` state + `t3_start` |
| Log selection → Send to thread | existing selection + new `SendSheet` dialog → `t3_send` or `t3_start` |
| Work panel badge with waiting count | derived from `threads` |
| Fold < 960 px | rail and Work panel become drawers over the log |

Cost: new panel component, fail-card states, two dialogs. Sidebar stays. Lowest risk.

### B · Mission control (thread-first)

| Affordance | Implementation |
|---|---|
| Rail of tasks in sections Needs you / Agent working / Apps running / In review / Quiet | derived per `Group` from instance states + lead thread (`facts()` in the mockup); no new backend |
| Task row health dots, PR chip, "why" line | instance states + `ThreadView.pull_request` |
| Workspace: app tiles, fail cards, logs scoped to the worktree, conversation | LogPane gets a `scope: Set<instanceId>` prop; tiles reuse Sidebar row actions |
| Thread tabs when a worktree has several threads | `threads` filtered by worktree |
| All apps & logs | today's merged view, kept as a rail entry |
| Folders, presets, pins, batch mark | move to the palette and a Folders page; pins become "pinned tasks" |
| Fold < 960 px | rail becomes a drawer; workspace switches Logs / Thread with tabs |

Cost: replaces `Sidebar.tsx` as the primary navigation; LogPane scoping; presets/batch move. Medium risk, mostly front end.

### C · Stage (board)

| Affordance | Implementation |
|---|---|
| Lanes Needs you / In motion / Parked, cards move on their own (FLIP) | same `facts()` as B; animation is front-end only |
| Card: mini app rows, 6-minute log sparkline, newest line, agent's last message, one next-action button | instance states; sparkline needs a per-instance ring of counts per 12 s bucket (cheap to keep in `store.ts`); last message from `t3_thread` for every lead thread (more `show` calls than A/B) |
| Zoom into a card (workspace = B's workspace) with a filmstrip of other tasks | same components as B |
| Fold < 960 px | lanes become a horizontal snap carousel; zoom uses Logs / Thread tabs |

Cost: everything in B plus the board, animation, and `thread show` for every lead thread (polling load grows with tasks). Highest risk. There is no merged "all logs" view in the mockup; shipping C would need one.

## 5. Migration slices

Each slice ships alone, is useful alone, and the later ones reuse it. Slices 1–4 are identical whichever layout wins.

1. **T3 detection and status.** `t3.rs` health + CLI resolution, status-bar dot ("T3 :3773" / "T3 offline" / "T3 not found"), T3 dialog that says what is missing and how to fix it. No threads yet. Proves the process handling and timeouts.
2. **Open in T3 + Add to T3.** `t3_open`, `t3_project_add` on the worktree header/context menu. First user-visible win; zero polling.
3. **Fix with agent.** `t3_start` from the existing fail card, `fixes` state, poller at 3 s for that one thread only, progress → waiting → completed → Retry build. Biggest single time saver (replaces copy logs → switch app → paste).
4. **Threads read-only + Send to thread.** Poller for all projects, thread lines and PR chips, log selection → `t3_send` / `t3_start`, toasts on waiting/completed.
5. **Layout.** A's Work panel *or* B's task rail. Recommended: B, keeping "All apps & logs" as today's view so nobody loses the merged stream.
6. Composer in Spawner (send follow-ups without switching app). Last, because T3 is the better place to talk to an agent.

## 6. Risks

- **CLI cost on Windows.** Each `t3` call starts a new process through `t3.cmd` (cold-start cost not measured yet; measure it in slice 1 before choosing intervals). Polling 4 projects every 3 s is ~1.3 processes/s while an agent runs. Mitigation: one `list` per project not per checkout, `show` only for on-screen and fix threads, 30 s when idle, 3-process cap. If T3 adds an HTTP/SSE API on the local server, switch to it and delete the poller.
- **CLI output is not a stable contract.** Parse with `serde` into the struct above with `#[serde(default)]` everywhere, and treat parse errors as `Failed` with a "T3 Code changed its output; update Spawner" message, not a crash.
- **Path matching.** Threads map to worktrees by path; case and trailing separators differ on Windows. Normalise (lowercase, `\`, no trailing slash) on both sides; the kit's `norm()` only lowercases.
- **Stale views look live.** Every thread view carries `fetched_at`; anything older than two poll intervals is dimmed. Never show a spinner for state Spawner has not re-read.
- **Prompt leakage.** Fix and Send put log lines into a third-party agent. The dialog shows the exact text first; nothing is sent automatically.
- **B moves presets and batch mark.** Existing users of presets need them in the palette and on the "All apps & logs" page before the tree goes away.

## 7. What I would not build

- Approving permissions from Spawner (no CLI surface; faking it with UI automation would be fragile and unsafe).
- A full chat client. Spawner shows the last few messages and a composer; history lives in T3 (the "N earlier messages · open in T3" link).
- `--worktree` thread starts from Spawner worktrees (creates a second worktree for the same task).
- Reading `statev2.sqlite` for speed (2.2 GB, locked, private schema).
- Drag-and-drop between board lanes in C. Lanes are derived from state; letting users drag would create a second source of truth.
- Auto-retrying a build when the agent says it is fixed. The agent may still be editing; Retry stays a deliberate click (with "Retry anyway" during the run).
