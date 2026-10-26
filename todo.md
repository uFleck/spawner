# In-app updates (GitHub Releases + tauri-plugin-updater)
Execution: Split (Sonnet: Rust/updater config + release CI; Haiku: update button UI, README).
Decisions: release on tag `v*` (version taken from tag), Windows NSIS only, repo uFleck/spawner,
T3-style button in status bar: periodic background check -> dot + changelog popover above -> click downloads -> "Restart" applies.
- [x] A1 Sonnet: plugins updater+process (Rust + JS pkgs), tauri.conf updater/pubkey placeholder/nsis/createUpdaterArtifacts, capabilities (cargo check + tsc green)
- [x] A2 Sonnet: .github/workflows/release.yml (tag -> build -> sign -> release + latest.json, generated notes); fixed uploadUpdaterJson input + pnpm version
- [x] B1 Haiku: src/updater.ts + components/UpdateButton.tsx + StatusBar slot + css + store.stopAllAndWait (reviewed; tsc, vite build, cargo check green)
- [x] B2 Haiku: README "Releasing and updates"
- [ ] User: `pnpm tauri signer generate`, paste pubkey, add GH secrets, create repo + push, tag v0.1.1
- [ ] verify: cargo check, tsc, vite build; release build produces .sig; end-to-end: install v0.1.0 -> tag v0.1.1 -> update

# Hub: Worktree > Projects regroup + Panes UI + T3 (Feature playbook, Sonnet direct)
Execution: Sonnet direct (Rust<->TS contract change, open design). Reason per user CLAUDE.md model-routing.
- [x] how: read discovery/runner/lib/model + UI (done in-session)
- [x] architect: skip: single owner, shapes fixed by approved mockup design/hub.html
- [x] throughput: blocking=Rust model+tests; parallel=none (TS depends on contract); shared state=none; decomposition=one owner
- [x] delegate: skip: user CLAUDE.md says implement directly when design is open / crosses a layer
- [x] U1 Rust: model Group>Project, discovery grouping, tests green
- [x] U2 Rust: t3 module (register/open/registry), tests green
- [x] U3 TS: api/store contract + grouping
- [x] U4 UI: Panes tokens (new light), tooltip, IconButton, Sidebar tree, Toolbar, LogPane
- [x] verify: cargo test, tsc, vite build, real scan against C:\umbler, browser run
- [x] interrogate: skip: design not contested
- [x] PR: skip: repo has no commits, nothing asked

# Companion: floating log window at the screen edge (Sonnet direct)
Execution: Sonnet direct (new window + Win32 focus/placement + IPC contract; no cheap check covers the window behavior).
Decisions: Rust owns visibility (setting on, main not focused, something active or an undismissed error), shown with SW_SHOWNOACTIVATE
so it never steals focus; the page owns size and place (one SetWindowPos via `companion_place`); drag the robot to move, snaps to the nearer side.
- [x] Rust: companion.rs, `groups`/`companion_open`/`companion_dismiss`/`companion_place`, `companion` setting (default on), settings-changed event
- [x] TS: src/companion (feed, place, UI), main.tsx branch by window label, StatusBar toggle, focus-instance -> solo, tokens.css split
- [x] verify: cargo check, cargo test, tsc
- [ ] verify live: add C:\Projects\spawner to Spawner, run `tauri dev`; check no focus steal on show/click, hover tail, drag+snap, Alt+Tab, theme follow
