import { useEffect, useState } from "react";
import { isActive, type Group, type ResolvedStack, type StackApp } from "../api";
import { actions, type Snapshot } from "../store";
import { IconButton } from "./IconButton";

interface Props {
  snap: Snapshot;
  group: Group;
  /** The worktree's stack, or null while it is being read for the first time. */
  stack: ResolvedStack | null;
  onToast: (text: string) => void;
}

const PORT_MIN = 1024;
const PORT_MAX = 65535;

/** What the checkout is, said the way the card needs it: a shared main checkout, or the worktree's own repo. */
const where = (app: StackApp) => (app.shared ? "main · shared" : app.repo);

/** A port field that commits on Enter or when it loses focus, and says why a value is refused. */
function PortEdit({ app, label, autoFocus }: { app: StackApp; label: string; autoFocus: boolean }) {
  const [value, setValue] = useState(() => String(app.port ?? app.defaultPort ?? ""));
  const port = Number(value);
  const valid = Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX;
  const dirty = valid && port !== app.port;
  const commit = () => {
    if (!dirty) return;
    void actions.setPort(app.projectId, app.appId, port);
  };
  const hint = !valid
    ? `${PORT_MIN}–${PORT_MAX}`
    : dirty
      ? "↵ to save"
      : app.portSource === "worktree"
        ? `saved, override for ${label}`
        : "repo default";
  return (
    <div className="edit">
      <input
        type="text"
        inputMode="numeric"
        className={valid ? "" : "bad"}
        value={value}
        aria-label={`Port for ${app.app}`}
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setValue(String(app.port ?? app.defaultPort ?? ""));
        }}
      />
      <button
        type="button"
        className="btn btn-ghost sm"
        disabled={app.defaultPort == null || app.portSource !== "worktree"}
        onClick={() => {
          if (app.defaultPort == null) return;
          setValue(String(app.defaultPort));
          void actions.setPort(app.projectId, app.appId, null);
        }}
      >
        Default {app.defaultPort ?? "—"}
      </button>
      <span className={`hint${valid ? (dirty ? " dirty" : "") : " bad"}`} title="Enter or leaving the field saves; Esc puts the saved port back">
        {hint}
      </span>
    </div>
  );
}

/** One app of the stack: what it is, where it runs, its port, and how to run or stop just it. */
function StackRow({
  snap,
  app,
  editing,
  focus,
  label,
  worktree,
  onEditPort,
}: {
  snap: Snapshot;
  app: StackApp;
  editing: boolean;
  focus: boolean;
  label: string;
  /** The worktree group id, for the "start it again" after a port move. */
  worktree: string;
  onEditPort: () => void;
}) {
  const state = snap.states[app.instance];
  const kind = state?.kind ?? "idle";
  const live = isActive(state);
  const conflict = snap.stackConflicts[app.instance];
  const livePort = snap.ports[app.instance] ?? null;
  // A running app keeps the port it started on; the card offers the next start's port beside it.
  const port = live ? (livePort ?? app.port) : app.port;
  const stale = live && app.port != null && livePort != null && livePort !== app.port;
  const override = app.portSource === "worktree";
  return (
    <li className="st-app" data-state={kind} data-conflict={conflict ? "" : undefined}>
      <span className="dot" />
      <div className="meta">
        <div className="nm">{app.app}</div>
        <div className="sub">
          <span className="kind">{app.kind}</span>
          <span>· {where(app)}</span>
          <span>· {app.mode === "task" ? "task" : live ? kind : conflict ? "blocked" : "stopped"}</span>
          {stale ? (
            <span className="stale" title={`This run started on :${livePort}; the next start uses :${app.port}`}>
              restart → :{app.port}
            </span>
          ) : null}
        </div>
        {editing && app.portSettable ? <PortEdit app={app} label={label} autoFocus={focus} /> : null}
      </div>
      {/* Fixed columns (port, tag, run) so the controls line up from card to card; the port itself opens the browser. */}
      <div className="acts">
        {port != null ? (
          <>
            <a
              className="port"
              href="#"
              title={app.url ? `Open ${app.url}` : `Open :${port}`}
              onClick={(e) => {
                e.preventDefault();
                void actions.openPort(port);
              }}
            >
              :{port}
              <i className="ph ph-arrow-up-right" />
            </a>
            <span
              className={`tag${override ? " ov" : ""}`}
              title={override ? `Override for ${label}, kept by Spawner. Repo default: ${app.defaultPort ?? "none"}` : "Repo default, from spawner.stack.json"}
            >
              {override ? "override" : "default"}
            </span>
          </>
        ) : (
          <span className="port none" title={app.portSettable ? "The app picks its own port when it starts" : `A ${app.kind} app cannot take a port`}>
            {app.portSettable ? "port at start" : "no port"}
          </span>
        )}
        <IconButton
          small
          className={live ? "danger" : ""}
          icon={live ? "ph-fill ph-stop" : "ph-fill ph-play"}
          label={live ? `Stop ${app.app}` : `Run ${app.app}`}
          disabled={kind === "stopping" || snap.stackBusy}
          onClick={() => void (live ? actions.stop(app.instance) : actions.start(app.projectId, app.appId))}
        />
      </div>
      {conflict ? (
        <div className="cf" role="alert">
          <span>
            <i className="ph-fill ph-warning-circle" /> Port <b>{conflict.port}</b> is in use
            {conflict.holder ? ` by ${conflict.holder}` : ""}. {app.app} didn’t start.
          </span>
          <button
            type="button"
            className="btn btn-ghost sm"
            onClick={() => {
              // Save first: start_stack resolves the ports on the backend, so it must see the new one.
              void (async () => {
                await actions.setPort(app.projectId, app.appId, conflict.free);
                actions.clearStackConflict(app.instance);
                await actions.startStack(worktree);
              })();
            }}
          >
            Use {conflict.free} and start
          </button>
          <button type="button" className="btn btn-ghost sm" onClick={onEditPort}>
            Edit port
          </button>
        </div>
      ) : null}
      <div className="bar">
        <i />
      </div>
    </li>
  );
}

/** The AI prompt the mockup offers: what to write in spawner.stack.json, with what Spawner already detected. */
function aiPrompt(group: Group, stack: ResolvedStack): string {
  const repo = group.projects[0]?.repo ?? "this repo";
  const path = group.projects[0]?.path ?? repo;
  const apps = stack.detected
    .map((d) => `- ${d.repo}: ${d.app} (${d.kind}${d.port != null ? `, port ${d.port}` : ""}${d.portSettable ? "" : ", cannot take a port"})`)
    .join("\n");
  return [
    `Add a Spawner stack to ${repo}. Create ${repo}/spawner.stack.json at the repo root with the apps a reviewer needs to run and test a branch:`,
    "",
    "{",
    '  "name": "…",',
    '  "apps": [',
    "    {",
    `      "repo": "${repo}",`,
    '      "app": "<app name as Spawner lists it>",',
    '      "port": <default port>,',
    '      "env": { "<Setting__BaseUrl>": "http://localhost:{port:<other app name>}" }',
    "    },",
    '    { "repo": "<other repo>", "app": "<other app name>", "port": <default port> }',
    "  ],",
    '  "open": ["<the app to open in the browser>"]',
    "}",
    "",
    "Rules:",
    "- `repo` is the repo folder name; an app from a repo this worktree does not hold runs from its main checkout.",
    "- `port` is the repo default. A per-worktree port is an override that Spawner keeps in its app data (Edit ports, or hub_set_port); it is never written to this file or committed.",
    "- When one app calls another, link them with `env` and `{port:<app name>}` instead of hard-coding the port, so a moved port follows. `{port}` is the app's own port, `{cwd}` its folder.",
    "- Only iis-express, dotnet-run, vite, next, react and node apps can take a port; leave `port` out for the rest (tauri, scripts, tasks).",
    "",
    `Apps Spawner detected in ${path}:`,
    apps || "- (none)",
    "",
    `Then call hub_rescan and hub_get_stack({ worktree: "${group.label}" }) to check it, and hub_start_stack to run it.`,
  ].join("\n");
}

/**
 * The stack of the selected worktree: the manifest it came from, every app with its port, the per-app controls, the
 * overrides, and what to do about a busy port or a repo that has no manifest yet.
 */
export function StackCard({ snap, group, stack, onToast }: Props) {
  const [editing, setEditing] = useState(false);
  /** The app whose port field should take focus when editing opens, from the conflict's "Edit port". */
  const [focus, setFocus] = useState<string | null>(null);
  /** Detected apps the user unticked on the no-stack card, so "Use detected apps" writes only the rest. */
  const [dropped, setDropped] = useState<Set<string>>(() => new Set());
  /** Narrow windows fold the app list to its header line, so the logs keep the height; CSS ignores it when wide. */
  const [folded, setFolded] = useState(() => matchMedia("(max-width: 959px)").matches);
  useEffect(() => setDropped(new Set()), [group.id]);

  if (!stack) {
    return (
      <section className="stack" aria-label="Stack">
        {snap.stackError ? (
          <p className="st-error" role="alert">
            <i className="ph ph-warning-circle" /> {snap.stackError}
          </p>
        ) : (
          <p className="st-loading" role="status">
            <i className="ph ph-circle-notch spin" /> Reading the stack…
          </p>
        )}
      </section>
    );
  }

  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(
      () => onToast(`${what} copied`),
      () => onToast("Could not copy to the clipboard"),
    );
  };

  if (!stack.source) {
    const detected = stack.detected;
    const picked = detected.filter((d) => !dropped.has(d.instance));
    return (
      <section className="stack" aria-label="Stack">
        <div className="nostack">
          <i className="ph ph-stack-plus" aria-hidden="true" />
          <b>No stack yet</b>
          <p>
            Spawner found these apps in {group.label} ({group.projects.map((p) => p.repo).join(", ")}). A stack is the
            set a reviewer needs to run and test the branch; writing it to <code>spawner.stack.json</code> and
            committing it gives every new worktree of the repo the same one.
          </p>
          <div className="picks2">
            {detected.map((d) => (
              <label className="pk" key={d.instance} title={`${d.app} · ${d.kind}${d.port != null ? ` :${d.port}` : ""}`}>
                <input
                  type="checkbox"
                  checked={!dropped.has(d.instance)}
                  onChange={() =>
                    setDropped((old) => {
                      const next = new Set(old);
                      if (next.has(d.instance)) next.delete(d.instance);
                      else next.add(d.instance);
                      return next;
                    })
                  }
                />
                <span className="nm">{d.app}</span>
                <small>
                  {d.kind}
                  {d.port != null ? ` :${d.port}` : ""}
                </small>
              </label>
            ))}
            {detected.length === 0 && <span className="muted">No service app found in this worktree.</span>}
          </div>
          <div className="row2">
            <button
              type="button"
              className="btn btn-primary sm"
              disabled={snap.stackBusy || picked.length === 0}
              onClick={() => void actions.writeStack(group.id, picked.map((d) => d.app))}
            >
              <i className="ph ph-check" />
              Use detected apps
            </button>
            <button type="button" className="btn btn-ghost sm" onClick={() => copy(aiPrompt(group, stack), "AI prompt")}>
              <i className="ph ph-copy" />
              Copy AI prompt
            </button>
          </div>
        </div>
        {snap.stackError ? (
          <p className="st-error" role="alert">
            <i className="ph ph-warning-circle" /> {snap.stackError}
          </p>
        ) : null}
      </section>
    );
  }

  const live = stack.apps.filter((a) => isActive(snap.states[a.instance])).length;
  const opens = stack.apps.filter((a) => stack.open.includes(a.app) && isActive(snap.states[a.instance]));
  // The port editor needs every row; a busy port shows just its own row while folded, so the logs keep their room.
  const shut = folded && !editing;
  const conflicted = stack.apps.some((a) => snap.stackConflicts[a.instance]);
  return (
    <section className={`stack${shut ? " folded" : ""}${conflicted ? " has-cf" : ""}`} aria-label="Stack">
      <div className="st-h">
        <span className="st-title">Stack</span>
        <span className="st-name">{stack.name ?? "Spawner stack"}</span>
        <span className="st-from" title={stack.source.file}>
          {stack.source.repo}/spawner.stack.json{stack.source.committed ? "" : " · new, not committed"}
        </span>
        <span className="st-sum">
          {live ? `${live}/${stack.apps.length} running` : `${stack.apps.length} app${stack.apps.length === 1 ? "" : "s"} · ready`}
        </span>
        <span className="grow" />
        {opens.map((a) => {
          const port = snap.ports[a.instance] ?? a.port;
          return port != null ? (
            <button key={a.instance} type="button" className="btn btn-ghost sm" onClick={() => void actions.openPort(port)}>
              <i className="ph ph-globe" />
              Open {a.app}
            </button>
          ) : null;
        })}
        <button
          type="button"
          className="btn btn-ghost sm"
          aria-pressed={editing}
          onClick={() => {
            setFocus(null);
            setEditing(!editing);
          }}
        >
          <i className={editing ? "ph ph-check" : "ph ph-pencil-simple"} />
          <span className="lbl">{editing ? "Done" : "Edit ports"}</span>
        </button>
        <IconButton
          small
          className="st-fold"
          icon="ph-bold ph-caret-down"
          label={shut ? "Show the stack's apps" : "Fold the stack"}
          aria-expanded={!shut}
          onClick={() => setFolded(!shut)}
        />
      </div>

      <ul className="st-apps">
        {stack.apps.map((app) => (
          <StackRow
            key={app.instance}
            snap={snap}
            app={app}
            editing={editing}
            focus={focus === app.instance}
            label={group.label}
            worktree={group.id}
            onEditPort={() => {
              setFocus(app.instance);
              setEditing(true);
            }}
          />
        ))}
      </ul>

      {editing && (
        <p className="editfoot">
          <i className="ph ph-info" />
          A change here is an override for <b>{group.label}</b>, kept by Spawner and never committed. It applies at the
          next start. Repo defaults live in <code>{stack.source.repo}/spawner.stack.json</code>; agents set the same
          thing with <code>hub_set_port</code>.
        </p>
      )}
      {stack.missing.length > 0 && (
        <p className="st-missing">
          <i className="ph ph-warning" /> Not in this worktree: {stack.missing.map((m) => `${m.repo}/${m.app}`).join(", ")}
        </p>
      )}
      {snap.stackError ? (
        <p className="st-error" role="alert">
          <i className="ph ph-warning-circle" /> {snap.stackError}
        </p>
      ) : null}
    </section>
  );
}
