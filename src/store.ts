import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useSyncExternalStore } from "react";
import {
  api,
  instanceId,
  isActive,
  parseInstanceId,
  watchKey,
  type AppDef,
  type Concluded,
  type Group,
  type InstanceState,
  type LogLine,
  type McpInfo,
  type PortEvent,
  type Project,
  type RefusedWorktree,
  type RemovedWorktree,
  type Root,
  type Settings,
  type StateEvent,
} from "./api";
import {
  MAIN,
  parsePresets,
  memberOf,
  resolvePreset,
  sameMember,
  type Preset,
  type PresetHit,
  type PresetMember,
} from "./presets";

const LOG_CAP = 20_000;

/** How long a conclusion can be undone. */
export const UNDO_MS = 15_000;
/** The check mark holds this long before the worktree folds away, which takes `FOLD_MS`. */
const DONE_MS = 750;
const FOLD_MS = 550;
const RESTORED_MS = 1_800;

/** A worktree on its way out. The scan stops listing it as soon as it is deleted, so the sidebar draws it from here until it has folded away. */
export interface Concluding {
  group: Group;
  /** Its place in `Snapshot.groups` when it started, so it folds away where it stood. */
  index: number;
  /** Whether it was pinned, so it keeps its place in the list while pins change underneath it. */
  pinned: boolean;
  phase: "working" | "done" | "out";
}

/** A worktree that could not be concluded, shown as a warning on its sidebar group. */
export interface ConcludeProblem {
  group: Group;
  refused: RefusedWorktree[];
  /** Set when nothing was tried at all, such as an app that would not stop. */
  message: string | null;
  /** Worktrees of the same task that were deleted before the others were refused; they are part of the undo once it succeeds. */
  removed: RemovedWorktree[];
}

/** A conclusion that can still be undone. */
export interface Undo {
  id: string;
  groupId: string;
  label: string;
  removed: RemovedWorktree[];
  pinnedGroup: boolean;
  pinnedApps: string[];
  status: "ready" | "restoring" | "restored";
  /** Only some of the task's worktrees were deleted; the rest were refused and are still listed. */
  partial: boolean;
}

export interface Snapshot {
  roots: Root[];
  groups: Group[];
  states: Record<string, InstanceState>;
  /** Ports that running instances printed, for apps without a fixed one. Keyed by instance id. */
  ports: Record<string, number>;
  entered: Record<string, number>;
  logs: LogLine[];
  mcp: McpInfo | null;
  settings: Settings;
  loading: boolean;
  /** Whether the first scan has finished. Until then `groups` is empty because nothing was looked at yet, not because the folders are gone. */
  scanned: boolean;
  error: string | null;
  /** The app whose start failed on a busy port, so the alert can offer to start it anyway. */
  portConflict: { projectId: string; appId: string } | null;
  /** The script whose params are being asked for before it runs. */
  runAsk: { projectId: string; appId: string } | null;
  /** The conclude dialog that is open. A "problem" one reads what happened from `problems`. */
  dialog: { kind: "confirm" | "problem"; group: Group } | null;
  concluding: Record<string, Concluding>;
  /** Keyed by group id. */
  problems: Record<string, ConcludeProblem>;
  undos: Undo[];
  /** Group ids just restored, highlighted for a moment. */
  revived: string[];
  presets: Preset[];
  /** Worktree group ids float to the top of the tree; instance ids get a Pinned section, each tagged with its worktree. */
  pins: Pins;
  /** When each instance last started, in epoch ms. Keyed by instance id; kept across restarts so the sidebar can sort by it. */
  lastRun: Record<string, number>;
  /** The apps a new preset starts with while its name is being typed, or null when no preset is being created. */
  presetDraft: { members: PresetMember[]; name: string } | null;
  /** Instance ids ticked with Ctrl+click, so a few of the running apps can be restarted or stopped together. */
  marked: string[];
  /** `watchKey`s of the apps that run under `dotnet watch`. */
  watched: string[];
}

export interface InstanceInfo {
  id: string;
  appName: string;
  repo: string;
  group: Group;
  short: string;
}

let snapshot: Snapshot = {
  roots: [],
  groups: [],
  states: {},
  ports: {},
  entered: {},
  logs: [],
  mcp: null,
  settings: { notifyScripts: false, companion: true },
  loading: true,
  scanned: false,
  error: null,
  portConflict: null,
  runAsk: null,
  dialog: null,
  concluding: {},
  problems: {},
  undos: [],
  revived: [],
  presets: [],
  pins: { groups: [], apps: [] },
  lastRun: {},
  presetDraft: null,
  marked: [],
  watched: [],
};
const listeners = new Set<() => void>();
let lastSeq = 0;
let pending: LogLine[] = [];
let flushScheduled = false;

function set(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}

function appendLogs(lines: LogLine[]) {
  const fresh = lines.filter((l) => l.seq > lastSeq);
  if (fresh.length === 0) return;
  lastSeq = fresh[fresh.length - 1].seq;
  const merged = snapshot.logs.concat(fresh);
  set({ logs: merged.length > LOG_CAP ? merged.slice(merged.length - LOG_CAP) : merged });
}

function flushPending() {
  flushScheduled = false;
  const batch = pending;
  pending = [];
  appendLogs(batch);
}

function enqueueLog(line: LogLine) {
  pending.push(line);
  if (!flushScheduled) {
    flushScheduled = true;
    requestAnimationFrame(flushPending);
  }
}

function fail(e: unknown) {
  set({ error: String(e) });
}

function onState({ id, state }: StateEvent) {
  const changed = snapshot.states[id]?.kind !== state.kind;
  const started = isActive(state) && !isActive(snapshot.states[id]);
  set({
    states: { ...snapshot.states, [id]: state },
    entered: changed ? { ...snapshot.entered, [id]: Date.now() } : snapshot.entered,
    ...(started ? { lastRun: { ...snapshot.lastRun, [id]: Date.now() } } : {}),
  });
  if (started) persistUiState();
}

function onPort({ id, port }: PortEvent) {
  const { [id]: _gone, ...rest } = snapshot.ports;
  set({ ports: port == null ? rest : { ...rest, [id]: port } });
}

export interface Pins {
  groups: string[];
  apps: string[];
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const timestamps = (v: unknown): Record<string, number> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => Number.isFinite(e[1])))
    : {};

/** Presets, pins and last-run times live in a file in the app data directory. Nothing is written before they have been read, or the empty defaults would replace them. */
let uiStateLoaded = false;

function persistUiState() {
  if (!uiStateLoaded) return;
  const { presets, pins, lastRun } = snapshot;
  api.saveUiState(JSON.stringify({ presets, pins, lastRun })).catch(fail);
}

/** An older build kept them in the webview's localStorage; the first run on the file adopts them. */
function legacyUiState(): unknown {
  try {
    return {
      presets: JSON.parse(localStorage.getItem("hub-presets") ?? "[]"),
      pins: JSON.parse(localStorage.getItem("hub-pins") ?? "{}"),
    };
  } catch {
    return {};
  }
}

async function loadUiState() {
  let raw: unknown;
  let saved: string | null = null;
  try {
    saved = await api.loadUiState();
    raw = saved == null ? legacyUiState() : JSON.parse(saved);
  } catch (e) {
    // Left unloaded, so nothing is saved this session and the unreadable file stays as it is.
    fail(e);
    return;
  }
  const state = raw as { presets?: unknown; pins?: { groups?: unknown; apps?: unknown }; lastRun?: unknown } | null;
  set({
    presets: parsePresets(state?.presets),
    pins: { groups: strings(state?.pins?.groups), apps: strings(state?.pins?.apps) },
    lastRun: timestamps(state?.lastRun),
  });
  uiStateLoaded = true;
  if (saved == null) persistUiState();
}

function togglePin(kind: keyof Pins, id: string) {
  const list = snapshot.pins[kind];
  const pins = { ...snapshot.pins, [kind]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
  set({ pins });
  persistUiState();
}

const isLive = (id: string) => isActive(snapshot.states[id]);
const activeIds = () => Object.keys(snapshot.states).filter(isLive);
const pairOf = (h: PresetHit) => ({ projectId: h.project.id, appId: h.app.id });

function runningMembers(): PresetMember[] {
  const running = new Set(activeIds());
  return snapshot.groups.flatMap((g) =>
    g.projects.flatMap((p) => p.apps.filter((a) => running.has(instanceId(p.id, a.id))).map((a) => memberOf(p, a))),
  );
}

/** The first worktree (a task such as PAYMENT-9987, not main) that holds one of these instances, as a name to offer. */
function suggestName(instances: string[]): string {
  const wanted = new Set(instances);
  const task = snapshot.groups.find(
    (g) => !g.main && g.projects.some((p) => p.apps.some((a) => wanted.has(instanceId(p.id, a.id)))),
  );
  return task?.label ?? "";
}

function setPresets(presets: Preset[], patch: Partial<Snapshot> = {}) {
  set({ ...patch, presets });
  persistUiState();
}

const editPreset = (id: string, change: (p: Preset) => Preset) =>
  setPresets(snapshot.presets.map((p) => (p.id === id ? change(p) : p)));

function findApp(projectId: string, appId: string): AppDef | undefined {
  return snapshot.groups.flatMap((g) => g.projects).find((p) => p.id === projectId)?.apps.find((a) => a.id === appId);
}

/** Starts the apps together and reports every failure, not just the last. */
async function startInstances(pairs: { projectId: string; appId: string }[]) {
  const results = await Promise.allSettled(pairs.map((p) => api.start(p.projectId, p.appId, false)));
  const errors = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
  set({ error: errors.length ? errors.join("\n") : null, portConflict: null });
}

async function stopInstances(ids: string[]) {
  const results = await Promise.allSettled(ids.filter((id) => snapshot.states[id]?.kind !== "stopping").map((id) => api.stop(id)));
  const errors = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
  set({ error: errors.length ? errors.join("\n") : null });
}

const STOP_WAIT_MS = 30_000;

/** Resolves once the instance is no longer active, or after `STOP_WAIT_MS`. */
function untilStopped(id: string): Promise<void> {
  return new Promise((resolve) => {
    if (!isLive(id)) return resolve();
    const done = () => {
      clearTimeout(timer);
      listeners.delete(check);
      resolve();
    };
    const check = () => isLive(id) || done();
    const timer = setTimeout(done, STOP_WAIT_MS);
    listeners.add(check);
  });
}

/** Stops whatever of these is active, waits for it to end so the port is free, then starts all of them. */
async function restartInstances(pairs: { projectId: string; appId: string }[]) {
  const ids = pairs.map((p) => instanceId(p.projectId, p.appId));
  await stopInstances(ids.filter(isLive));
  await Promise.all(ids.map(untilStopped));
  await startInstances(pairs);
}

const rootKey = (path: string) => path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

/**
 * The backend rescans after a change and pushes the new groups, so only the list is set here. A folder being added
 * shows in the list right away, since the scan is the slow part; the backend's list replaces it, or it is taken back
 * if the backend refuses.
 */
async function changeRoots(change: () => Promise<Root[]>, adding?: Root) {
  const previous = snapshot.roots;
  const optimistic = adding && !previous.some((r) => rootKey(r.path) === rootKey(adding.path));
  set({ loading: true, ...(optimistic ? { roots: [...previous, adding] } : {}) });
  try {
    set({ roots: await change(), error: null });
  } catch (e) {
    if (optimistic) set({ roots: previous });
    fail(e);
  } finally {
    set({ loading: false });
  }
}

function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _gone, ...rest } = record;
  return rest;
}

const patchUndo = (id: string, patch: Partial<Undo>) =>
  set({ undos: snapshot.undos.map((u) => (u.id === id ? { ...u, ...patch } : u)) });

const dropUndo = (id: string) => set({ undos: snapshot.undos.filter((u) => u.id !== id) });

function patchConcluding(id: string, phase: Concluding["phase"]) {
  const current = snapshot.concluding[id];
  if (current) set({ concluding: { ...snapshot.concluding, [id]: { ...current, phase } } });
}

/** Puts an undo on offer, which lapses after `UNDO_MS` unless it is being used. */
function offerUndo(undo: Undo) {
  set({ undos: [...snapshot.undos.filter((u) => u.groupId !== undo.groupId), undo] });
  setTimeout(() => snapshot.undos.some((u) => u.id === undo.id && u.status === "ready") && dropUndo(undo.id), UNDO_MS);
}

function failConclude(group: Group, removed: RemovedWorktree[], refused: RefusedWorktree[], message: string | null) {
  const live = snapshot.groups.find((g) => g.id === group.id) ?? group;
  set({
    concluding: without(snapshot.concluding, group.id),
    problems: { ...snapshot.problems, [group.id]: { group: live, removed, refused, message } },
  });
  if (removed.length > 0) {
    offerUndo({ id: crypto.randomUUID(), groupId: group.id, label: group.label, removed, pinnedGroup: false, pinnedApps: [], status: "ready", partial: true });
  }
}

/** Deletes a task's worktrees with git. Running apps are stopped first, since they hold their folders open. */
async function runConclude(group: Group, force: boolean) {
  if (snapshot.concluding[group.id]) return;
  const earlier = snapshot.problems[group.id]?.removed ?? [];
  const index = Math.max(0, snapshot.groups.findIndex((g) => g.id === group.id));
  set({
    dialog: null,
    error: null,
    undos: snapshot.undos.filter((u) => u.groupId !== group.id || u.status !== "ready"),
    problems: without(snapshot.problems, group.id),
    concluding: { ...snapshot.concluding, [group.id]: { group, index, pinned: snapshot.pins.groups.includes(group.id), phase: "working" } },
  });
  const ids = group.projects.flatMap((p) => p.apps.map((a) => instanceId(p.id, a.id)));
  const running = ids.filter(isLive);
  await stopInstances(running);
  await Promise.all(running.map(untilStopped));
  let report: Concluded;
  try {
    report = await api.concludeWorktree(group.id, force);
  } catch (e) {
    return failConclude(group, earlier, [], String(e));
  }
  const removed = [...earlier, ...report.removed];
  if (report.refused.length > 0) return failConclude(group, removed, report.refused, null);

  const gone = new Set(ids);
  const undo: Undo | null =
    removed.length === 0
      ? null
      : {
          id: crypto.randomUUID(),
          groupId: group.id,
          label: group.label,
          removed,
          pinnedGroup: snapshot.pins.groups.includes(group.id),
          pinnedApps: snapshot.pins.apps.filter((a) => gone.has(a)),
          status: "ready",
          partial: false,
        };
  set({
    pins: { groups: snapshot.pins.groups.filter((g) => g !== group.id), apps: snapshot.pins.apps.filter((a) => !gone.has(a)) },
    error: null,
  });
  if (undo) offerUndo(undo);
  persistUiState();
  patchConcluding(group.id, "done");
  setTimeout(() => patchConcluding(group.id, "out"), DONE_MS);
  setTimeout(() => set({ concluding: without(snapshot.concluding, group.id) }), DONE_MS + FOLD_MS);
  await Promise.all(ids.map((id) => actions.clearLogs(id)));
}

/** Checks the deleted worktrees out again and puts back the pins they had. After a partial failure that also drops the warning, since the task is whole again. */
async function undoConclude(id: string) {
  const undo = snapshot.undos.find((u) => u.id === id);
  if (!undo || undo.status !== "ready") return;
  patchUndo(id, { status: "restoring" });
  // The group is about to be listed again, so it must not still be folding away.
  set({ concluding: without(snapshot.concluding, undo.groupId), dialog: null });
  try {
    await api.restoreWorktrees(undo.removed);
  } catch (e) {
    patchUndo(id, { status: "ready" });
    return fail(e);
  }
  const { groups, apps } = snapshot.pins;
  set({
    pins: {
      groups: undo.pinnedGroup && !groups.includes(undo.groupId) ? [...groups, undo.groupId] : groups,
      apps: [...new Set([...apps, ...undo.pinnedApps])],
    },
    problems: undo.partial ? without(snapshot.problems, undo.groupId) : snapshot.problems,
    revived: [...snapshot.revived, undo.groupId],
    error: null,
  });
  persistUiState();
  patchUndo(id, { status: "restored" });
  setTimeout(() => dropUndo(id), RESTORED_MS);
  setTimeout(() => set({ revived: snapshot.revived.filter((g) => g !== undo.groupId) }), RESTORED_MS + 600);
}

export const actions = {
  /** Opens the dialog that asks before a worktree is concluded. */
  askConclude: (group: Group) => set({ dialog: { kind: "confirm", group } }),
  /** Opens the dialog that explains why a worktree could not be concluded. */
  openProblem(groupId: string) {
    const problem = snapshot.problems[groupId];
    if (problem) set({ dialog: { kind: "problem", group: problem.group } });
  },
  closeDialog: () => set({ dialog: null }),
  confirmConclude() {
    const { dialog } = snapshot;
    return dialog?.kind === "confirm" ? runConclude(dialog.group, false) : Promise.resolve();
  },
  /** From the problem dialog: tries again, deleting work that was never committed when that is what git refused over. */
  proceedConclude() {
    const { dialog } = snapshot;
    const problem = dialog && snapshot.problems[dialog.group.id];
    if (dialog?.kind !== "problem" || !problem) return Promise.resolve();
    const group = snapshot.groups.find((g) => g.id === dialog.group.id) ?? problem.group;
    return runConclude(group, problem.refused.some((r) => r.needsForce));
  },
  /** From the problem dialog: brings back the worktrees that were deleted before the others were refused, and drops the warning. */
  restoreRemoved(groupId: string) {
    const problem = snapshot.problems[groupId];
    if (!problem || problem.removed.length === 0) return Promise.resolve();
    const existing = snapshot.undos.find((u) => u.groupId === groupId && u.status === "ready");
    if (existing) return undoConclude(existing.id);
    // The undo toast has lapsed, so one is made on the spot.
    const undo: Undo = { id: crypto.randomUUID(), groupId, label: problem.group.label, removed: problem.removed, pinnedGroup: false, pinnedApps: [], status: "ready", partial: true };
    set({ undos: [...snapshot.undos, undo] });
    return undoConclude(undo.id);
  },
  dismissProblem: (groupId: string) => set({ problems: without(snapshot.problems, groupId), dialog: null }),
  undoConclude,
  async refresh() {
    set({ loading: true });
    try {
      set({ groups: await api.scan(), loading: false, scanned: true, error: null });
    } catch (e) {
      set({ loading: false, scanned: true });
      fail(e);
    }
  },
  /** Runs an app. A script that declares params is asked for them first, unless `params` are given. */
  start(projectId: string, appId: string, force = false, params?: Record<string, string>) {
    if (!params && findApp(projectId, appId)?.params.length) return Promise.resolve(set({ runAsk: { projectId, appId }, error: null }));
    set({ runAsk: null });
    return api.start(projectId, appId, force, params).then(
      () => set({ error: null, portConflict: null }),
      (e) => {
        const busy = /port \d+ is already in use/.test(String(e));
        set({ error: String(e), portConflict: busy ? { projectId, appId } : null });
      },
    );
  },
  cancelRunAsk: () => set({ runAsk: null }),
  stop: (id: string) => api.stop(id).then(() => set({ error: null }), fail),
  togglePinGroup: (id: string) => togglePin("groups", id),
  togglePinApp: (id: string) => togglePin("apps", id),
  stopAll: () => stopInstances(activeIds()),
  /** Stops every running app and waits until each has ended, so the ports are free. */
  async stopAllAndWait() {
    const ids = activeIds();
    await stopInstances(ids);
    await Promise.all(ids.map(untilStopped));
  },
  restartAll: () => restartInstances(activeIds().map(parseInstanceId)),
  /** Restarts one app, or starts it if it is not running. */
  restartApp: (projectId: string, appId: string) => restartInstances([{ projectId, appId }]),
  /** Restarts only those of `ids` that are running, such as the apps of one worktree or repo. */
  restartRunning: (ids: string[]) => restartInstances(ids.filter(isLive).map(parseInstanceId)),
  /** Runs the app under `dotnet watch`, or back under `dotnet run`. A running app is restarted so the change applies now. */
  async toggleWatch(project: Project, app: AppDef) {
    const key = watchKey(project, app);
    const id = instanceId(project.id, app.id);
    try {
      set({ watched: await api.setWatch(project.repo, app.id, !snapshot.watched.includes(key)), error: null });
    } catch (e) {
      return fail(e);
    }
    if (isLive(id)) await restartInstances([{ projectId: project.id, appId: app.id }]);
  },
  toggleMark: (id: string) =>
    set({ marked: snapshot.marked.includes(id) ? snapshot.marked.filter((m) => m !== id) : [...snapshot.marked, id] }),
  clearMarks: () => set({ marked: [] }),
  async restartMarked() {
    const ids = snapshot.marked;
    set({ marked: [] });
    await restartInstances(ids.map(parseInstanceId));
  },
  async stopMarked() {
    const ids = snapshot.marked;
    set({ marked: [] });
    await stopInstances(ids.filter(isLive));
  },
  runPreset(preset: Preset) {
    const { hits } = resolvePreset(preset, snapshot.groups);
    return startInstances(hits.filter((h) => !isActive(snapshot.states[h.instance])).map(pairOf));
  },
  stopPreset: (preset: Preset) =>
    stopInstances(resolvePreset(preset, snapshot.groups).hits.map((h) => h.instance).filter(isLive)),
  restartPreset: (preset: Preset) => restartInstances(resolvePreset(preset, snapshot.groups).hits.map(pairOf)),
  /** Opens the new-preset name field, seeded with `seed`. */
  draftFromRunning: () => set({ presetDraft: { members: runningMembers(), name: suggestName(activeIds()) } }),
  draftFromApp: (member: PresetMember, instance: string) =>
    set({ presetDraft: { members: [member], name: suggestName([instance]) } }),
  cancelDraft: () => set({ presetDraft: null }),
  createPreset(name: string, members: PresetMember[]) {
    const preset: Preset = { id: crypto.randomUUID(), name, members, target: MAIN };
    setPresets([...snapshot.presets, preset], { presetDraft: null });
  },
  renamePreset: (id: string, name: string) => editPreset(id, (p) => ({ ...p, name })),
  deletePreset: (id: string) => setPresets(snapshot.presets.filter((p) => p.id !== id)),
  setPresetTarget: (id: string, target: string) => editPreset(id, (p) => ({ ...p, target })),
  addToPreset: (id: string, member: PresetMember) =>
    editPreset(id, (p) => (p.members.some((m) => sameMember(m, member)) ? p : { ...p, members: [...p.members, member] })),
  removeFromPreset: (id: string, member: PresetMember) =>
    editPreset(id, (p) => ({ ...p, members: p.members.filter((m) => !sameMember(m, member)) })),
  /** Replaces a preset's apps with the ones running now. */
  setPresetToRunning(id: string) {
    const members = runningMembers();
    if (members.length === 0) return fail("No apps are running to save.");
    editPreset(id, (p) => ({ ...p, members }));
  },
  async clearLogs(id?: string) {
    await api.clearLogs(id);
    set({ logs: id ? snapshot.logs.filter((l) => l.instance !== id) : [] });
  },
  /** Clears the log of every app that is not running, which drops their chips. */
  async cleanStopped() {
    const ids = [...new Set(snapshot.logs.map((l) => l.instance))].filter((id) => !isLive(id));
    await Promise.all(ids.map((id) => actions.clearLogs(id)));
  },
  /** Stops every running app, waits for them to end, then clears all logs. */
  async closeAll() {
    const ids = activeIds();
    await stopInstances(ids);
    await Promise.all(ids.map(untilStopped));
    await actions.clearLogs();
  },
  /** Opens the folder picker, then adds the chosen folder. */
  async addFolder() {
    try {
      const picked = await open({ directory: true, multiple: false, title: "Add a folder to scan" });
      if (typeof picked === "string") await actions.addRoot(picked);
    } catch (e) {
      fail(e);
    }
  },
  addRoot: (path: string, label?: string) => changeRoots(() => api.addRoot(path, label), { path, label }),
  removeRoot: (path: string) => changeRoots(() => api.removeRoot(path)),
  openPort: (port: number) => api.openPort(port).catch(fail),
  setNotifyScripts: (notifyScripts: boolean) => saveSettings({ notifyScripts }),
  setCompanion: (companion: boolean) => saveSettings({ companion }),
  dismissError: () => set({ error: null, portConflict: null }),
};

async function saveSettings(patch: Partial<Settings>) {
  const previous = snapshot.settings;
  set({ settings: { ...previous, ...patch } });
  try {
    await api.setSettings({ ...previous, ...patch });
  } catch (e) {
    set({ settings: previous });
    fail(e);
  }
}

let initialized = false;
export async function initStore() {
  if (initialized) return;
  initialized = true;
  await listen<StateEvent>("instance-state", (e) => onState(e.payload));
  await listen<PortEvent>("instance-port", (e) => onPort(e.payload));
  await listen<LogLine>("log-line", (e) => enqueueLog(e.payload));
  await listen<Group[]>("groups-changed", (e) => set({ groups: e.payload, scanned: true }));
  await listen<Settings>("settings-changed", (e) => set({ settings: e.payload }));
  await listen<string | null>("logs-cleared", (e) => set({ logs: e.payload ? snapshot.logs.filter((l) => l.instance !== e.payload) : [] }));
  void watchMcp();
  await loadUiState();
  set({ roots: await api.getRoots() });
  set({ settings: await api.getSettings().catch(() => snapshot.settings) });
  set({ watched: await api.getWatched().catch(() => []) });
  await actions.refresh();
  const states = await api.instanceStates();
  const now = Date.now();
  set({
    states,
    entered: Object.fromEntries(Object.keys(states).map((id) => [id, now])),
  });
  set({ ports: await api.instancePorts() });
  appendLogs(await api.logsSince(0));
}

async function watchMcp() {
  for (let i = 0; i < 20; i++) {
    const mcp = await api.mcpInfo().catch(() => null);
    if (mcp && (mcp.url || mcp.error)) return set({ mcp });
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function useSnapshot(): Snapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}

export function indexInstances(groups: Group[]): Map<string, InstanceInfo> {
  const map = new Map<string, InstanceInfo>();
  for (const group of groups) {
    const short = group.main ? "main" : (group.label.split("-").pop() ?? group.label);
    for (const project of group.projects) {
      for (const app of project.apps) {
        const id = instanceId(project.id, app.id);
        map.set(id, { id, appName: app.name, repo: project.repo, group, short });
      }
    }
  }
  return map;
}
