import { useMemo, useState, type ReactNode } from "react";
import { canWatch, instanceId, isActive, isErrorExit, rootName, watchKey, type AppDef, type Group, type InstanceState, type Project, type Root } from "../api";
import { actions, type InstanceInfo, type Snapshot } from "../store";
import logo from "../assets/spawner.svg";
import { toggleWindowMaximize, startWindowDrag } from "../drag";
import { useContextMenu } from "./ContextMenu";
import { IconButton } from "./IconButton";
import { ReviewRail } from "./ReviewRail";
import { UndoToasts } from "./UndoToasts";

interface Props {
  snap: Snapshot;
  instances: Map<string, InstanceInfo>;
  theme: "dark" | "light";
  onSolo: (id: string) => void;
  onTheme: () => void;
  onGuide: () => void;
  onLogoClick: () => void;
}

function summarize(projects: Project[], states: Snapshot["states"]) {
  let running = 0;
  let busy = 0;
  let failed = 0;
  for (const p of projects)
    for (const a of p.apps) {
      const k = states[instanceId(p.id, a.id)]?.kind;
      if (k === "running") running++;
      else if (k === "building" || k === "starting") busy++;
      else if (k === "failed") failed++;
    }
  if (failed) return { text: `${failed} failed`, cls: "bad" };
  if (busy) return { text: `${busy} building`, cls: "" };
  if (running) return { text: `${running} running`, cls: "live" };
  return null;
}

function AppRow({
  project,
  app,
  state,
  port,
  marked,
  watched,
  pinned,
  where,
  onSolo,
}: {
  project: Project;
  app: AppDef;
  pinned: boolean;
  /** Ticked with Ctrl+click, to be restarted or stopped together with the other ticked apps. */
  marked: boolean;
  /** Runs under `dotnet watch`, so a change to its files rebuilds or hot-reloads it. */
  watched: boolean;
  /** The worktree, shown when the row is listed outside its own group. */
  where?: string;
  state?: InstanceState;
  /** The port to show: the app's fixed one, else the one its running instance printed. */
  port?: number | null;
  onSolo: (id: string) => void;
}) {
  const id = instanceId(project.id, app.id);
  const kind = state?.kind ?? "idle";
  const active = isActive(state);
  const canRun = !active;
  const menu = useContextMenu();
  return (
    <li
      className={`app-row${marked ? " marked" : ""}`}
      data-state={kind}
      data-exit={isErrorExit(state) ? "error" : undefined}
      onClick={(e) => (e.ctrlKey || e.metaKey) && actions.toggleMark(id)}
      onContextMenu={(e) => {
        menu.show(e, [
          canRun
            ? { label: kind === "failed" ? "Run again" : "Run", icon: "ph ph-play", run: () => void actions.start(project.id, app.id) }
            : { label: "Stop", icon: "ph ph-stop", danger: true, disabled: kind === "stopping", run: () => void actions.stop(id) },
          ...(canRun ? [] : [{ label: "Restart", icon: "ph ph-arrow-clockwise", disabled: kind === "stopping", run: () => void actions.restartApp(project.id, app.id) }]),
          ...(canWatch(app)
            ? [{ label: watched ? "Stop watching for changes" : "Watch for changes", icon: watched ? "ph ph-eye-slash" : "ph ph-eye", run: () => void actions.toggleWatch(project, app) }]
            : []),
          { label: marked ? "Unmark" : "Mark for batch restart", icon: marked ? "ph ph-minus-circle" : "ph ph-check-circle", run: () => actions.toggleMark(id) },
          ...(port ? [{ label: `Open :${port} in browser`, icon: "ph ph-globe", run: () => void actions.openPort(port) }] : []),
          { label: pinned ? "Unpin" : "Pin", icon: pinned ? "ph ph-push-pin-slash" : "ph ph-push-pin", run: () => actions.togglePinApp(id) },
          "sep",
          { label: "Show only this log", icon: "ph ph-rows", run: () => onSolo(id) },
          { label: "Clear this log", icon: "ph ph-trash", run: () => void actions.clearLogs(id) },
          "sep",
          { label: "Copy app name", icon: "ph ph-copy", run: () => menu.copy(app.name, "Name") },
        ]);
      }}
    >
      <span className="dot" />
      <div className="meta">
        <div className="nm">
          {app.name}
          {watched ? <i className="ph ph-eye watching" title="Watching for changes (dotnet watch)" /> : null}
        </div>
        <div className="sub">
          {where ? <span className="where">{where}</span> : <span className="kind">{watched ? "dotnet-watch" : app.kind}</span>}
          {port ? (
            <>
              <span> · </span>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void actions.openPort(port);
                }}
              >
                :{port} ↗
              </a>
            </>
          ) : null}
        </div>
      </div>
      <div className="acts">
        <span className="extra">
          {active ? (
            <IconButton
              small
              icon="ph ph-arrow-clockwise"
              label="Restart"
              disabled={kind === "stopping"}
              onClick={(e) => (e.stopPropagation(), void actions.restartApp(project.id, app.id))}
            />
          ) : null}
          {port ? (
            <IconButton small icon="ph ph-globe" label="Open in browser" onClick={(e) => (e.stopPropagation(), void actions.openPort(port))} />
          ) : null}
          <IconButton
            small
            className={pinned ? "pin on" : "pin"}
            icon={pinned ? "ph-fill ph-push-pin" : "ph ph-push-pin"}
            label={pinned ? "Unpin" : "Pin"}
            onClick={(e) => (e.stopPropagation(), actions.togglePinApp(id))}
          />
        </span>
        <button
          type="button"
          className={`ib main-act${canRun ? "" : " danger"}`}
          aria-label={canRun ? `Run ${app.name}` : `Stop ${app.name}`}
          disabled={kind === "stopping"}
          onClick={(e) => {
            e.stopPropagation();
            void (canRun ? actions.start(project.id, app.id) : actions.stop(id));
          }}
        >
          <i className="play ph-fill ph-play" />
          <i className="stop ph-fill ph-stop" />
        </button>
      </div>
      <div className="bar">
        <i />
      </div>
    </li>
  );
}

function GroupBlock({
  group,
  snap,
  onSolo,
  expand,
}: {
  group: Group;
  snap: Snapshot;
  onSolo: (id: string) => void;
  /** Shows the projects even when the user has the group collapsed. */
  expand: boolean;
}) {
  const [collapsed, setClosed] = useState(true);
  const closed = collapsed && !expand;
  const menu = useContextMenu();
  const sum = summarize(group.projects, snap.states);
  const live = group.projects.flatMap((p) => p.apps.map((a) => instanceId(p.id, a.id))).filter((i) => isActive(snap.states[i]));
  const phase = snap.concluding[group.id]?.phase;
  const problem = snap.problems[group.id];
  const back = snap.revived.includes(group.id);
  const pinned = snap.concluding[group.id]?.pinned ?? snap.pins.groups.includes(group.id);
  const root = snap.roots.find((r) => r.path === group.rootPath);
  const folder = root ? rootName(root) : group.rootPath;
  // A group named after its folder stands for the folder itself, so it carries the remove action.
  const isFolder = !group.main && !group.root && group.label === folder;
  // Only linked worktrees can be deleted; the backend refuses anything else.
  const concludable = !group.main && !isFolder;
  const branch = isFolder ? undefined : group.projects.find((p) => p.branch)?.branch;
  return (
    <div className={`wtg-wrap${phase === "out" ? " out" : ""}`}>
    <div className={`wtg${closed ? " closed" : ""}${phase ? ` is-${phase}` : ""}${back ? " back" : ""}${problem ? " has-problem" : ""}`}>
      <div
        className="wtg-h"
        onClick={() => setClosed(!closed)}
        onContextMenu={(e) =>
          menu.show(e, [
            { label: closed ? "Expand" : "Collapse", icon: closed ? "ph ph-caret-down" : "ph ph-caret-up", run: () => setClosed(!closed) },
            { label: `Restart running (${live.length})`, icon: "ph ph-arrow-clockwise", disabled: live.length === 0, run: () => void actions.restartRunning(live) },
            { label: pinned ? "Unpin worktree" : "Pin worktree", icon: pinned ? "ph ph-push-pin-slash" : "ph ph-push-pin", run: () => actions.togglePinGroup(group.id) },
            { label: "Copy path", icon: "ph ph-copy", run: () => menu.copy(group.root ?? group.rootPath, "Path") },
            ...(concludable
              ? ["sep" as const, { label: "Conclude worktree…", icon: "ph ph-check-circle", danger: true, run: () => actions.askConclude(group) }]
              : []),
            ...(isFolder && root
              ? ["sep" as const, { label: "Remove folder", icon: "ph ph-x", danger: true, run: () => void actions.removeRoot(root.path) }]
              : []),
          ])
        }
      >
        <span className="caret">
          <i className="ph-bold ph-caret-down" />
        </span>
        <div className="wtg-t">
          <b>{group.main ? "Main checkouts" : group.label}</b>
          <span>
            {group.projects.length} project{group.projects.length === 1 ? "" : "s"}
            {!group.main && branch && branch !== group.label ? ` · ${branch}` : ""}
          </span>
        </div>
        {phase ? (
          <span className="wtg-stat" role="status">
            {phase === "working" ? (
              <>
                <i className="ph-bold ph-circle-notch spin" aria-hidden="true" />
                Concluding…
              </>
            ) : (
              <>
                <i className="ph-fill ph-check-circle" aria-hidden="true" />
                Concluded
              </>
            )}
          </span>
        ) : (
          sum && <span className={`sum ${sum.cls}`}>{sum.text}</span>
        )}
        {problem && !phase && (
          <IconButton
            small
            className="wtg-warn"
            icon="ph-fill ph-warning"
            label="Could not conclude, see why"
            onClick={(e) => (e.stopPropagation(), actions.openProblem(group.id))}
          />
        )}
        <IconButton
          small
          className={pinned ? "wtg-pin on" : "wtg-pin"}
          icon={pinned ? "ph-fill ph-push-pin" : "ph ph-push-pin"}
          label={pinned ? "Unpin worktree" : "Pin worktree"}
          onClick={(e) => (e.stopPropagation(), actions.togglePinGroup(group.id))}
        />
        {isFolder && root && (
          <IconButton
            small
            className="wtg-x"
            icon="ph ph-x"
            label="Remove folder"
            onClick={(e) => (e.stopPropagation(), void actions.removeRoot(root.path))}
          />
        )}
      </div>
      <div className="collapse">
        <div className="in">
          {group.projects.map((p) => (
            <ProjectBlock key={p.id} project={p} snap={snap} onSolo={onSolo} expand={expand} />
          ))}
        </div>
      </div>
    </div>
    </div>
  );
}

/** One repo's apps. Starts collapsed; the header still shows what is running. */
function ProjectBlock({
  project: p,
  snap,
  onSolo,
  expand,
}: {
  project: Project;
  snap: Snapshot;
  onSolo: (id: string) => void;
  /** Shows the apps even when the user has the project collapsed. */
  expand: boolean;
}) {
  const [collapsed, setClosed] = useState(true);
  const closed = collapsed && !expand;
  const menu = useContextMenu();
  const sum = summarize([p], snap.states);
  const live = p.apps.map((a) => instanceId(p.id, a.id)).filter((i) => isActive(snap.states[i]));
  return (
    <div className={`proj${closed ? " closed" : ""}`}>
      <div
        className="proj-h"
        onClick={() => setClosed(!closed)}
        onContextMenu={(e) =>
          menu.show(e, [
            { label: closed ? "Expand" : "Collapse", icon: closed ? "ph ph-caret-down" : "ph ph-caret-up", run: () => setClosed(!closed) },
            { label: `Restart running (${live.length})`, icon: "ph ph-arrow-clockwise", disabled: live.length === 0, run: () => void actions.restartRunning(live) },
            { label: "Copy path", icon: "ph ph-copy", run: () => menu.copy(p.path, "Path") },
          ])
        }
      >
        <span className="caret">
          <i className="ph-bold ph-caret-down" />
        </span>
        <i className="ph ph-folder-simple" />
        <span className="nm">{p.repo}</span>
        {p.branch && <span className="br">{p.branch}</span>}
        {sum ? <span className={`sum ${sum.cls}`}>{sum.text}</span> : <span className="n">{p.apps.length}</span>}
      </div>
      <div className="collapse">
        <div className="in">
          <ul className="apps">
            {p.apps.map((a) => {
              const id = instanceId(p.id, a.id);
              return (
                <AppRow
                  key={a.id}
                  project={p}
                  app={a}
                  state={snap.states[id]}
                  port={a.port ?? snap.ports[id]}
                  marked={snap.marked.includes(id)}
                  watched={snap.watched.includes(watchKey(p, a))}
                  pinned={snap.pins.apps.includes(id)}
                  onSolo={onSolo}
                />
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** One scan folder: the worktrees it holds, each with its projects and apps. */
function FolderBlock({
  root,
  groups,
  snap,
  onSolo,
  expand,
}: {
  root: Root;
  groups: Group[];
  snap: Snapshot;
  onSolo: (id: string) => void;
  /** Shows the worktrees even when the folder is collapsed, while a filter is active. */
  expand: boolean;
}) {
  const [collapsed, setClosed] = useState(false);
  const open = !collapsed || expand;
  const menu = useContextMenu();
  const projects = groups.reduce((n, g) => n + g.projects.length, 0);
  const live = groups.reduce(
    (n, g) => n + g.projects.reduce((m, p) => m + p.apps.filter((a) => isActive(snap.states[instanceId(p.id, a.id)])).length, 0),
    0,
  );
  return (
    <div className={`fold-block${open ? "" : " closed"}`}>
      <div
        className="fold-h"
        onClick={() => setClosed(!collapsed)}
        onContextMenu={(e) =>
          menu.show(e, [
            { label: collapsed ? "Expand" : "Collapse", icon: collapsed ? "ph ph-caret-down" : "ph ph-caret-up", run: () => setClosed(!collapsed) },
            { label: "Copy path", icon: "ph ph-copy", run: () => menu.copy(root.path, "Path") },
            "sep",
            { label: "Remove folder", icon: "ph ph-x", danger: true, run: () => void actions.removeRoot(root.path) },
          ])
        }
      >
        <span className="caret">
          <i className="ph-bold ph-caret-down" />
        </span>
        <i className="ph ph-folder-simple fold-ico" />
        <div className="fold-t">
          <b>{rootName(root)}</b>
          <span title={root.path}>
            {groups.length} worktree{groups.length === 1 ? "" : "s"} · {projects} project{projects === 1 ? "" : "s"}
          </span>
        </div>
        {live > 0 ? <span className="sum live">{live} running</span> : null}
      </div>
      <div className="collapse">
        <div className="in">
          {groups.map((g) => (
            <GroupBlock key={g.id} group={g} snap={snap} onSolo={onSolo} expand={expand} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Today's app tree, folded away under one row: the review rail above is the way in now. */
function AllApps({ open, onToggle, count, live, current, children }: { open: boolean; onToggle: () => void; count: number; live: number; current: boolean; children: ReactNode }) {
  return (
    <section className={`allapps${open ? "" : " closed"}`}>
      <div className="allapps-h" onClick={onToggle}>
        <span className="caret">
          <i className="ph-bold ph-caret-down" />
        </span>
        <span className="t">All apps &amp; logs</span>
        {live > 0 ? <span className="sum live">{live} running</span> : <span className="n">{count}</span>}
        <IconButton
          small
          icon="ph ph-rows"
          label="Show the merged logs"
          pressed={current}
          onClick={(e) => (e.stopPropagation(), actions.selectWorktree(null))}
        />
      </div>
      <div className="collapse">
        <div className="in">{children}</div>
      </div>
    </section>
  );
}

/** Placeholder rows for the first scan and while a folder is added or removed, so the tree reads as being filled in rather than empty. */
function ScanningRows() {
  return (
    <div className="scanning" role="status" aria-live="polite">
      <div className="scanning-t">
        <i className="ph-bold ph-circle-notch spin" aria-hidden="true" />
        Scanning folders…
      </div>
      {[62, 48, 56].map((w) => (
        <div className="skel-row" key={w} aria-hidden="true">
          <span className="skel-dot" />
          <span className="skel-bar" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

function Folders({ roots, pending }: { roots: Root[]; pending: boolean }) {
  const [closed, setClosed] = useState(true);
  const menu = useContextMenu();
  return (
    <section className={`roots${closed ? " closed" : ""}`}>
      <div className="roots-h" onClick={() => setClosed(!closed)}>
        <span className="caret">
          <i className="ph-bold ph-caret-down" />
        </span>
        <span className="t">Folders</span>
        <span className="n">{roots.length}</span>
        <IconButton
          small
          icon="ph ph-folder-plus"
          label="Add folder"
          onClick={(e) => (e.stopPropagation(), void actions.addFolder())}
        />
      </div>
      <div className="collapse">
        <div className="in">
          <ul className="roots-list">
            {roots.map((r) => (
              <li
                className="root-row"
                key={r.path}
                onContextMenu={(e) =>
                  menu.show(e, [
                    { label: "Copy path", icon: "ph ph-copy", run: () => menu.copy(r.path, "Path") },
                    "sep",
                    { label: "Remove folder", icon: "ph ph-x", danger: true, run: () => void actions.removeRoot(r.path) },
                  ])
                }
              >
                <i className="ph ph-folder-simple" />
                <div className="meta">
                  <div className="nm">{rootName(r)}</div>
                  <div className="sub">{r.path}</div>
                </div>
                <IconButton small icon="ph ph-x" label="Remove folder" onClick={() => void actions.removeRoot(r.path)} />
              </li>
            ))}
            {roots.length === 0 && <li className="root-none">{pending ? "Loading folders…" : "No folders yet"}</li>}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Pinned apps listed together, each tagged with its worktree, so they can be run without opening anything. */
function PinnedApps({
  snap,
  query,
  onSolo,
  keep,
  recent,
}: {
  snap: Snapshot;
  query: string;
  onSolo: (id: string) => void;
  keep: ((id: string) => boolean) | null;
  recent: boolean;
}) {
  const q = query.trim().toLowerCase();
  const rows = snap.pins.apps.flatMap((id) => {
    if (keep && !keep(id)) return [];
    for (const g of snap.groups) {
      for (const p of g.projects)
        for (const a of p.apps)
          if (instanceId(p.id, a.id) === id) {
            const where = g.main ? `${p.repo} · main` : `${p.repo} · ${g.label}`;
            return `${a.name} ${where}`.toLowerCase().includes(q) ? [{ id, p, a, where }] : [];
          }
    }
    return [];
  });
  if (recent) rows.sort((a, b) => (snap.lastRun[b.id] ?? 0) - (snap.lastRun[a.id] ?? 0));
  if (rows.length === 0) return null;
  return (
    <section className="pinned">
      <div className="pinned-h">
        <i className="ph-fill ph-push-pin" />
        <span className="t">Pinned</span>
        <span className="n">{rows.length}</span>
      </div>
      <ul className="apps">
        {rows.map(({ id, p, a, where }) => (
          <AppRow
            key={id}
            project={p}
            app={a}
            state={snap.states[id]}
            port={a.port ?? snap.ports[id]}
            marked={snap.marked.includes(id)}
            watched={snap.watched.includes(watchKey(p, a))}
            pinned
            where={where}
            onSolo={onSolo}
          />
        ))}
      </ul>
    </section>
  );
}

/** Words typed in the filter box that act on app state instead of matching names. */
const KEYWORDS = ["running", "failed", "recent"] as const;
type Keyword = (typeof KEYWORDS)[number];

const isKeyword = (w: string): w is Keyword => (KEYWORDS as readonly string[]).includes(w.toLowerCase());

function parseQuery(query: string) {
  const flags = new Set<Keyword>();
  const text: string[] = [];
  for (const w of query.trim().split(/\s+/).filter(Boolean)) {
    const k = w.toLowerCase();
    if (isKeyword(k)) flags.add(k);
    else text.push(w);
  }
  return { text: text.join(" "), flags };
}

/** The apps the state keywords select, or null when none is typed. Several keywords select any of them. */
function stateMatcher(flags: Set<Keyword>, states: Snapshot["states"]): ((id: string) => boolean) | null {
  const running = flags.has("running");
  const failed = flags.has("failed");
  if (!running && !failed) return null;
  return (id) => {
    const s = states[id];
    return (running && isActive(s)) || (failed && (s?.kind === "failed" || isErrorExit(s)));
  };
}

/** Keeps only the apps `keep` accepts, dropping projects and groups left empty. */
function pruneApps(groups: Group[], keep: (id: string) => boolean): Group[] {
  return groups.flatMap((g) => {
    const projects = g.projects
      .map((p) => ({ ...p, apps: p.apps.filter((a) => keep(instanceId(p.id, a.id))) }))
      .filter((p) => p.apps.length > 0);
    return projects.length ? [{ ...g, projects }] : [];
  });
}

/** Most recently run first at every level. Never-run entries sink, in their original order. */
function sortByLastRun(groups: Group[], lastRun: Snapshot["lastRun"]): Group[] {
  const byRecent = <T,>(items: T[], at: (t: T) => number) => [...items].sort((a, b) => at(b) - at(a));
  const appAt = (p: Project) => (a: AppDef) => lastRun[instanceId(p.id, a.id)] ?? 0;
  const projectAt = (p: Project) => Math.max(0, ...p.apps.map(appAt(p)));
  const groupAt = (g: Group) => Math.max(0, ...g.projects.map(projectAt));
  const sorted = groups.map((g) => ({
    ...g,
    projects: byRecent(
      g.projects.map((p) => ({ ...p, apps: byRecent(p.apps, appAt(p)) })),
      projectAt,
    ),
  }));
  return byRecent(sorted, groupAt);
}

function filterGroups(groups: Group[], query: string): Group[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const has = (s: string) => s.toLowerCase().includes(q);
  return groups.flatMap((g) => {
    if (has(g.label)) return [g];
    const projects = g.projects
      .map((p) => (has(p.repo) || has(p.branch ?? "") ? p : { ...p, apps: p.apps.filter((a) => has(a.name)) }))
      .filter((p) => p.apps.length > 0);
    return projects.length ? [{ ...g, projects }] : [];
  });
}

export function Sidebar({ snap, theme, onSolo, onTheme, onGuide, onLogoClick }: Props) {
  const [query, setQuery] = useState("");
  const { text, flags } = useMemo(() => parseQuery(query), [query]);
  const recent = flags.has("recent");
  const keep = useMemo(() => stateMatcher(flags, snap.states), [flags, snap.states]);
  // A worktree being concluded is no longer in the scan, so it is put back where it stood until it has folded away.
  const listed = useMemo(() => {
    const list = [...snap.groups];
    Object.values(snap.concluding)
      .filter((c) => !list.some((g) => g.id === c.group.id))
      .sort((a, b) => a.index - b.index)
      .forEach((c) => list.splice(Math.min(c.index, list.length), 0, c.group));
    return list;
  }, [snap.groups, snap.concluding]);
  const groups = useMemo(() => {
    let found = filterGroups(listed, text);
    if (keep) found = pruneApps(found, keep);
    if (recent) found = sortByLastRun(found, snap.lastRun);
    const rank = (g: Group) => ((snap.concluding[g.id]?.pinned ?? snap.pins.groups.includes(g.id)) ? 0 : 1);
    return [...found].sort((a, b) => rank(a) - rank(b));
  }, [listed, snap.pins.groups, snap.concluding, snap.lastRun, text, keep, recent]);
  // The tree reads folder first: the worktrees a scan folder holds, and inside each its projects.
  const folders = useMemo(() => {
    const known = new Set(snap.roots.map((r) => r.path));
    const byRoot = new Map<string, Group[]>();
    const extra: Group[] = [];
    for (const g of groups) {
      if (!known.has(g.rootPath)) {
        extra.push(g);
        continue;
      }
      const list = byRoot.get(g.rootPath) ?? [];
      list.push(g);
      byRoot.set(g.rootPath, list);
    }
    const out = snap.roots
      .map((root) => ({ key: root.path, root, groups: byRoot.get(root.path) ?? [] }))
      .filter((f) => f.groups.length > 0);
    if (extra.length) out.push({ key: "other", root: { path: "", label: "Other folders" }, groups: extra });
    return out;
  }, [groups, snap.roots]);
  const liveApps = useMemo(
    () => groups.reduce((n, g) => n + g.projects.reduce((m, p) => m + p.apps.filter((a) => isActive(snap.states[instanceId(p.id, a.id)])).length, 0), 0),
    [groups, snap.states],
  );
  // The existing tree is a fallback now, so it starts folded; the review rail and the workspace are the front door.
  const [allOpen, setAllOpen] = useState(false);

  return (
    <aside className="rail" id="rail">
      <div className="rail-head" onMouseDown={startWindowDrag} onDoubleClick={toggleWindowMaximize}>
        <h1>
          <img className="brand" src={logo} alt="" width={20} height={20} draggable={false} onClick={onLogoClick} />
          Spawner
        </h1>
        <IconButton icon="ph ph-plugs-connected" label="Connect an AI agent" onClick={onGuide} />
        <IconButton
          icon="ph ph-arrow-clockwise"
          label="Rescan folders"
          kbd="Ctrl R"
          busy={snap.loading}
          disabled={snap.loading}
          onClick={() => void actions.refresh()}
        />
        <IconButton icon={theme === "dark" ? "ph ph-moon" : "ph ph-sun"} label="Toggle theme" onClick={onTheme} />
      </div>
      <label className="field">
        <i className="ph ph-funnel" />
        <input
          id="wq"
          placeholder="Filter, or type running, failed, recent"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {snap.marked.length > 0 && (
        <div className="runbar marks">
          <span>{snap.marked.length} marked</span>
          <IconButton small icon="ph ph-arrow-clockwise" label="Restart marked" onClick={() => void actions.restartMarked()} />
          <IconButton small className="danger" icon="ph ph-stop" label="Stop marked" onClick={() => void actions.stopMarked()} />
          <IconButton small icon="ph ph-x" label="Clear marks" onClick={actions.clearMarks} />
        </div>
      )}
      <div className="tree">
        <div className="tree-in">
          <ReviewRail snap={snap} query={text} />
          <PinnedApps snap={snap} query={text} onSolo={onSolo} keep={keep} recent={recent} />
          <AllApps open={allOpen} onToggle={() => setAllOpen(!allOpen)} count={groups.length} live={liveApps} current={snap.selectedWorktree === null}>
            {folders.map((f) => (
              <FolderBlock key={f.key} root={f.root} groups={f.groups} snap={snap} onSolo={onSolo} expand={keep !== null} />
            ))}
            {(snap.loading || (!snap.scanned && snap.roots.length > 0)) && <ScanningRows />}
            {groups.length === 0 && snap.groups.length > 0 && (keep || text) && <p className="empty">No apps match.</p>}
          </AllApps>
          {!snap.loading && snap.roots.length === 0 && (
            <div className="empty">
              <p>Add a folder to get started. Spawner scans it for repos, git worktrees and projects you can run.</p>
              <button type="button" className="empty-act" onClick={() => void actions.addFolder()}>
                <i className="ph ph-folder-plus" /> Add folder
              </button>
            </div>
          )}
          {snap.scanned && !snap.loading && snap.roots.length > 0 && snap.groups.length === 0 && (
            <p className="empty">No runnable apps found in the added folders.</p>
          )}
        </div>
      </div>
      <UndoToasts undos={snap.undos} />
      <Folders roots={snap.roots} pending={!snap.scanned} />
    </aside>
  );
}
