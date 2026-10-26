import { invoke } from "@tauri-apps/api/core";

/** A service runs until it is stopped; a task runs to its end and reports an exit code. */
export type AppMode = "service" | "task";

/** Tools that must be found on the machine are named, never given as a path. */
export type Program = { type: "path"; name: string } | { type: "msbuild" } | { type: "iis-express" };

export interface StepSpec {
  program: Program;
  /** May hold `{cwd}` and `{port}`, which the backend fills in at start time. */
  args: string[];
  /** Relative to the project folder, or absolute. */
  cwd: string;
  ready: string[];
}

/** An argument a script declares in its spawner.json, asked for in a form before the script runs. */
export interface Param {
  name: string;
  /** "flag" is an on/off switch that adds its `flag`; "text" is a value, positional unless it has a `flag`. */
  kind: "text" | "flag";
  /** What to enter, shown under the field. */
  hint: string | null;
  /** An example value, shown inside the empty field. */
  placeholder: string | null;
  flag: string | null;
  /** The allowed values, when there is a fixed set. */
  options: string[];
  required: boolean;
  /** Used when the field is left empty. A flag's is "true" when it starts on. */
  default: string | null;
}

export interface AppDef {
  /** Unique within its project and stable across rescans. */
  id: string;
  name: string;
  /** The file the app was detected from, relative to the project folder. */
  project: string;
  /** The technology and how it launches, such as "dotnet-run". Shown as a badge. */
  kind: string;
  mode: AppMode;
  port: number | null;
  /** Starting is refused while something listens on `port`. */
  checkPort: boolean;
  /** The port is read from the running service's output (a dev server picks its own); see `Snapshot.ports`. */
  learnPort: boolean;
  steps: StepSpec[];
  /** What a script is for, or what is wrong with its spawner.json. Null for everything else. */
  description: string | null;
  /** What a script asks for before it runs. Empty for everything else. */
  params: Param[];
}

export interface Project {
  id: string;
  repo: string;
  path: string;
  branch: string | null;
  apps: AppDef[];
}

/** A folder Spawner scans. */
export interface Root {
  path: string;
  label?: string;
}

export interface Group {
  id: string;
  label: string;
  /** The task folder, when the group is a task whose checkouts all live in it. */
  root: string | null;
  /** The scan folder this group came from. */
  rootId: string;
  rootPath: string;
  main: boolean;
  /** The user's own scripts (declared in a spawner.json), listed apart from the worktrees. */
  scripts: boolean;
  projects: Project[];
}

/** A worktree that was deleted from disk, with what it takes to check it out again. */
export interface RemovedWorktree {
  repo: string;
  path: string;
  main: string;
  branch: string | null;
  head: string;
}

/** A worktree git refused to delete. */
export interface RefusedWorktree {
  repo: string;
  reason: string;
  /** Modified or untracked files are the reason, so deleting with `force` would work. */
  needsForce: boolean;
}

/** Concluding tries every worktree, so some can be deleted while others are refused. */
export interface Concluded {
  removed: RemovedWorktree[];
  refused: RefusedWorktree[];
}

export type InstanceState =
  | { kind: "idle" }
  | { kind: "building" }
  | { kind: "starting" }
  | { kind: "running"; pid: number }
  | { kind: "stopping" }
  | { kind: "exited"; code: number | null }
  | { kind: "failed"; message: string };

export interface ClaudeStatus {
  installed: boolean;
  version: string | null;
}

export type LinkStatus =
  | { state: "connected" }
  | { state: "failing"; detail: string }
  | { state: "stale"; configured: string }
  | { state: "missing" };

export interface Settings {
  /** Tell the user when a script starts and ends while Spawner is not the focused window. */
  notifyScripts: boolean;
  /** Show the companion window at the edge of the screen while apps run. */
  companion: boolean;
}

export type Stream = "out" | "err" | "sys";
export type Level = "dbg" | "inf" | "wrn" | "err" | "sys";

export interface McpInfo {
  url: string | null;
  error: string | null;
  portChanged: boolean;
}

/** The port a running instance printed, or null once it is gone. */
export interface PortEvent {
  id: string;
  port: number | null;
}

export interface LogLine {
  seq: number;
  instance: string;
  ts: number;
  stream: Stream;
  level: Level;
  text: string;
}

export interface StateEvent {
  id: string;
  state: InstanceState;
}

export const instanceId = (projectId: string, appId: string) => `${projectId}::${appId}`;

export const parseInstanceId = (id: string) => {
  const at = id.indexOf("::");
  return { projectId: id.slice(0, at), appId: id.slice(at + 2) };
};

export const isActive =(s: InstanceState | undefined) =>
  !!s && ["building", "starting", "running", "stopping"].includes(s.kind);

/** A process that ended with a nonzero exit code. A stop by the user has no code. */
export const isErrorExit = (s: InstanceState | undefined) => s?.kind === "exited" && s.code != null && s.code !== 0;

/** Watching is kept per repo and app, so an app stays watched in every worktree of its repo. */
export const watchKey = (project: Pick<Project, "repo">, app: Pick<AppDef, "id">) => `${project.repo}::${app.id}`;

/** Only SDK web and worker projects, which `dotnet run` starts, can run under `dotnet watch`. */
export const canWatch = (app: Pick<AppDef, "kind">) => app.kind === "dotnet-run";

export const rootName = (root: Pick<Root, "path" | "label">) =>
  root.label?.trim() || root.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root.path;

export const api = {
  scan: () => invoke<Group[]>("scan"),
  /** The last scan's groups, without scanning again. */
  groups: () => invoke<Group[]>("groups"),
  getRoots: () => invoke<Root[]>("get_roots"),
  addRoot: (path: string, label?: string) => invoke<Root[]>("add_root", { path, label: label ?? null }),
  removeRoot: (path: string) => invoke<Root[]>("remove_root", { path }),
  /** Deletes the group's git worktrees from disk. `force` also takes ones with modified or untracked files. */
  concludeWorktree: (groupId: string, force = false) => invoke<Concluded>("conclude_worktree", { groupId, force }),
  /** Checks deleted worktrees out again, on their branches. Uncommitted changes and ignored files do not come back. */
  restoreWorktrees: (removed: RemovedWorktree[]) => invoke<void>("restore_worktrees", { removed }),
  /** `force` kills whatever listens on the app's port first. `params` are a script's values by param name; the backend refuses a missing required one. */
  start: (projectId: string, appId: string, force = false, params?: Record<string, string>) =>
    invoke<void>("start", { projectId, appId, force, params: params ?? null }),
  stop: (instanceId: string) => invoke<void>("stop", { instanceId }),
  instanceStates: () => invoke<Record<string, InstanceState>>("instance_states"),
  instancePorts: () => invoke<Record<string, number>>("instance_ports"),
  logsSince: (since: number) => invoke<LogLine[]>("logs_since", { since }),
  /** The saved presets and pins as JSON, or null before anything was ever saved. */
  loadUiState: () => invoke<string | null>("load_ui_state"),
  saveUiState: (json: string) => invoke<void>("save_ui_state", { json }),
  mcpInfo: () => invoke<McpInfo>("mcp_info"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),
  claudeCheck: () => invoke<ClaudeStatus>("claude_check"),
  claudeLink: () => invoke<LinkStatus>("claude_link"),
  claudeConnect: () => invoke<void>("claude_connect"),
  claudeAddGuidance: (snippet: string) => invoke<string>("claude_add_guidance", { snippet }),
  /** The `watchKey`s of the apps that run under `dotnet watch`. */
  getWatched: () => invoke<string[]>("get_watched"),
  /** Takes effect the next time the app starts. Returns the new list. */
  setWatch: (repo: string, appId: string, on: boolean) => invoke<string[]>("set_watch", { repo, appId, on }),
  openPort: (port: number) => invoke<void>("open_port", { port }),
  /** Brings the main window to the front, showing only this instance's log when one is given. */
  companionOpen: (instanceId?: string) => invoke<void>("companion_open", { instance: instanceId ?? null }),
  /** Moves and sizes the companion window in one step, in physical pixels. */
  companionPlace: (x: number, y: number, width: number, height: number) => invoke<void>("companion_place", { x, y, width, height }),
  /** Lets the user drag the companion window; resolves when they let go. */
  companionDrag: () => invoke<void>("companion_drag"),
  /** Stops showing an instance that ended in an error. */
  companionDismiss: (instanceId: string) => invoke<void>("companion_dismiss", { instance: instanceId }),
  clearLogs: (instanceId?: string) => invoke<void>("clear_logs", { instanceId: instanceId ?? null }),
};
