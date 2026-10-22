/* Dev-only stand-in for the Tauri backend, so the UI can be driven in a plain browser (`pnpm dev`).
   Groups mirror a real scan of C:/dev; run/stop/log output is simulated.
   Folders can be added and removed in memory (`?empty` starts with none); an added folder shows as one project. */
import { rootName, type AppDef, type AppMode, type Group, type InstanceState, type Level, type LogLine, type Param, type PortEvent, type Root, type StateEvent } from "../api";

type Handler = (e: { event: string; id: number; payload: unknown }) => void;

/** App ids that run to their end (tasks); everything else is a service. */
const TASK_IDS = new Set<string>();

const app = (name: string, port: number | null = null, kind = "dotnet-run", mode: AppMode = "service"): AppDef => {
  const id = `${name}.csproj`;
  if (mode === "task") TASK_IDS.add(id);
  return { id, name, project: `${name}/${name}.csproj`, kind, mode, port, checkPort: kind === "iis-express", learnPort: false, steps: [], description: null, params: [] };
};

/** A package.json script, named and identified the way the Node detector does (`<package>:<script>`, `package.json#<script>`). */
const script = (pkg: string, name: string, kind: string, mode: AppMode = "service"): AppDef => {
  const id = `package.json#${name}`;
  if (mode === "task") TASK_IDS.add(id);
  return { id, name: `${pkg}:${name}`, project: "package.json", kind, mode, port: null, checkPort: false, learnPort: mode === "service", steps: [], description: null, params: [] };
};

/** The Tauri detector's app: the whole desktop app, where `dev` above is the web front end alone. */
const tauriDev = (pkg: string): AppDef => ({
  id: "src-tauri/tauri.conf.json#tauri-dev",
  name: `${pkg}:tauri dev`,
  project: "src-tauri/tauri.conf.json",
  kind: "tauri",
  mode: "service",
  port: null,
  checkPort: false,
  learnPort: true,
  steps: [],
  description: null,
  params: [],
});

/** A command declared in a spawner.json: a task named by the user, with what it is for. */
const customScript = (name: string, description: string | null, broken = false, params: Param[] = []): AppDef => {
  const id = `spawner.json#${name.replace(/\W+/g, "-")}`;
  TASK_IDS.add(id);
  return { id, name, project: "spawner.json", kind: "script", mode: "task", port: null, checkPort: false, learnPort: false, steps: broken ? [] : [{ program: { type: "path", name: "python" }, args: [], cwd: ".", ready: [] }], description, params };
};

/** Dev servers pick their own port; the mock hands out the one Vite uses in this repo. */
const DEV_PORT = 1420;

const project = (root: string, repo: string, branch: string | null, apps: AppDef[]) => ({
  id: `${root}/${repo}`,
  repo,
  path: `${root}/${repo}`,
  branch,
  apps,
});

const account = (root: string, branch: string) =>
  project(root, "account", branch, [
    app("Acme.Account.Admin.Server"),
    app("Acme.Account.App"),
    app("Acme.Account.Consumer"),
    app("Acme.Account.Tests", null, "dotnet-test", "task"),
  ]);
const bill = (root: string, branch: string) =>
  project(root, "bill", branch, [
    app("Acme.Bill.API", 42318, "iis-express"),
    app("Acme.Bill.Charger.Monitor", 52904, "iis-express"),
    app("Acme.Bill.Email", 7398, "iis-express"),
  ]);

const task = (id: string, projects: (root: string) => Group["projects"]): Group => ({
  id,
  label: id,
  root: `C:/dev/${id}`,
  rootId: "c:/dev",
  rootPath: "C:/dev",
  main: false,
  scripts: false,
  projects: projects(`C:/dev/${id}`),
});

const DEV_SCRIPTS: Group = {
  id: "scripts",
  label: "Scripts",
  root: null,
  rootId: "c:/dev",
  rootPath: "C:/dev",
  main: false,
  scripts: true,
  projects: [
    project("C:/dev", "_tools", null, [
      customScript("cust monitors", "Counts and ids of the global Bill monitor lists."),
      customScript("cust snapshot", "Read-only customer snapshot.", false, [
        { name: "who", kind: "text", hint: "Email, walletId or appUserId of the customer", placeholder: "ana@example.com", flag: null, options: [], required: true, default: null },
        { name: "out", kind: "text", hint: "Write the snapshot to this file instead of the log", placeholder: "snapshot.json", flag: "--out", options: [], required: false, default: null },
        { name: "env", kind: "text", hint: "Which environment to read", placeholder: null, flag: "--env", options: ["prod", "staging"], required: false, default: "staging" },
        { name: "verbose", kind: "flag", hint: "Print every request", placeholder: null, flag: "-v", options: [], required: false, default: null },
      ]),
    ]),
  ],
};

const DEV_GROUPS: Group[] = [
  task("PAYMENT-9987", (r) => [account(r, "PAYMENT-9987")]),
  task("PAYMENT-9986", (r) => [account(r, "PAYMENT-9986"), project(r, "acme-site", "PAYMENT-9986", [app("Acme.Website")])]),
  task("PAYMENT-9483", (r) => [account(r, "PAYMENT-9483"), bill(r, "PAYMENT-9483")]),
  task("PAYMENT-9474", (r) => [
    project(r, "app-api", "PAYMENT-9474-shield-rules", [app("Acme.App.Api"), app("Acme.App.Migrations", null, "dotnet-run", "task")]),
    project(r, "acme-shield-api", "PAYMENT-9474-exempt", [app("Acme.Shield.Api")]),
  ]),
  {
    id: "main",
    label: "main",
    root: null,
    rootId: "c:/dev",
    rootPath: "C:/dev",
    main: true,
    scripts: false,
    projects: [
      account("C:/dev", "main"),
      bill("C:/dev", "main"),
      project("C:/dev", "acme-site", "main", [app("Acme.Website")]),
      project("C:/dev", "spawner", "main", [
        script("spawner", "build", "vite", "task"),
        script("spawner", "dev", "vite"),
        script("spawner", "preview", "vite"),
        tauriDev("spawner"),
      ]),
    ],
  },
];

const DEV = "C:/dev";
/** `?noscripts` starts without any script, to show the empty state. */
const EMPTY_SCRIPTS = new URLSearchParams(location.search).has("noscripts");
let settings = { notifyScripts: false };
const watched = new Set<string>();
const SAMPLE_FOLDERS = ["D:/side/notes-api", "C:/scripts/nightly", "C:/work/clients"];

const normalize = (p: string) => p.trim().replace(/\\/g, "/").replace(/\/+$/, "");

/** Worktrees the mock has concluded (by project id), so a rescan no longer lists them. */
const concluded = new Set<string>();
/** The task whose first conclusion fails for a reason `--force` does not fix, to show the warning's retry path. */
let flaky = "PAYMENT-9474";

/** What a scan would return for the added folders: C:/dev keeps its tasks, any other folder is one project. */
function groupsFor(roots: Root[]): Group[] {
  return roots.flatMap((root) => {
    if (normalize(root.path).toLowerCase() === DEV.toLowerCase())
      return [...DEV_GROUPS, ...(EMPTY_SCRIPTS ? [] : [DEV_SCRIPTS])].flatMap((g) => {
        const projects = g.projects.filter((p) => !concluded.has(p.id));
        return projects.length ? [{ ...g, projects }] : [];
      });
    const name = rootName(root);
    const folder = normalize(root.path);
    return [
      {
        id: name,
        label: name,
        root: null,
        rootId: folder.toLowerCase(),
        rootPath: folder,
        main: false,
        scripts: false,
        projects: [{ id: folder, repo: name, path: folder, branch: null, apps: [app(`${name}.Worker`)] }],
      },
    ];
  });
}

const SAMPLES = [
  "info: Microsoft.AspNetCore.Hosting.Diagnostics[1] Request starting HTTP/1.1 GET http://localhost:5003/billing/overview",
  "info: Acme.Account.Billing[0] GET /billing/overview → 200 (41ms) contract=771",
  "info: Acme.Account.Billing[0] POST /api/payments/refund → 202 (118ms) refundId=rf_8842",
  "warn: Acme.Account.Asaas[0] Asaas webhook retry 2/5 for payment pay_3391 (HTTP 502)",
  "dbug: Acme.Account.Policy[0] Resolved IRefundPolicy from scope policy=Standard",
  "2026-10-19 14:02:11.482 | INFO | Bill.Api.Startup | Heartbeat ok lag=0.3s",
  "2026-10-19 14:02:12.101 | WARN | Bill.Outbox | Outbox lag 4.2s above threshold 3s",
];

const TRACE = [
  "fail: Acme.Account.Refunds[0] Unhandled exception processing refund rf_8851: System.InvalidOperationException: Refund exceeds captured amount (requested=250.00, captured=199.90)",
  "   at Acme.Account.Refunds.RefundService.ApplyAsync(RefundCommand cmd) in RefundService.cs:line 118",
  "   at Acme.Account.Api.PaymentsController.Refund(RefundRequest req) in PaymentsController.cs:line 64",
  "   at Microsoft.AspNetCore.Mvc.Infrastructure.ActionMethodExecutor.Execute()",
  "   at Microsoft.AspNetCore.Routing.EndpointMiddleware.Invoke(HttpContext context)",
];

export function installMock() {
  const callbacks = new Map<number, Handler>();
  const listeners = new Map<string, Handler[]>();
  const states: Record<string, InstanceState> = {};
  const logs: LogLine[] = [];
  const tries = new Map<string, number>();
  let connected = false;
  const STALE = location.search.includes("stale");
  let roots: Root[] = location.search.includes("empty") ? [] : [{ path: DEV }];
  let nextFolder = 0;
  let seq = 1;
  let cb = 1;

  const emit = (event: string, payload: unknown) =>
    listeners.get(event)?.forEach((h) => h({ event, id: 0, payload }));
  const setState = (id: string, state: InstanceState) => {
    states[id] = state;
    emit("instance-state", { id, state } satisfies StateEvent);
  };
  const lastLevel = new Map<string, Level>();
  const levelOf = (instance: string, stream: LogLine["stream"], text: string): Level => {
    if (stream === "sys") return "sys";
    const prev = lastLevel.get(instance);
    const level: Level =
      prev && text.startsWith("   ") ? prev
      : /^\s*fail:|\berror CS\d+|^\s*(npm ERR!|error\b)/.test(text) ? "err"
      : /^\s*warn:|\| WARN \||^\s*warn(ing)?\b/i.test(text) ? "wrn"
      : /^\s*dbug:/.test(text) ? "dbg"
      : /^\s*(Compiling|Finished|Running|Info)\b/.test(text) ? "inf"
      : stream === "err" ? "err"
      : "inf";
    lastLevel.set(instance, level);
    return level;
  };
  const log = (instance: string, stream: LogLine["stream"], text: string) => {
    const line: LogLine = { seq: seq++, instance, ts: Date.now(), stream, level: levelOf(instance, stream, text), text };
    logs.push(line);
    emit("log-line", line);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const ports: Record<string, number> = {};
  const setPort = (id: string, port: number | null) => {
    if (port == null) delete ports[id];
    else ports[id] = port;
    emit("instance-port", { id, port } satisfies PortEvent);
  };

  const timers = new Map<string, number>();
  const pid = () => 1000 + Math.floor(Math.random() * 9000);
  /** A package script: a dev server prints its URL (which gives it a port), `tauri dev` also builds and opens the window, `build` ends. */
  async function runNode(id: string, appId: string) {
    const name = appId.split("#")[1];
    const tauri = appId.includes("tauri");
    setState(id, { kind: "starting" });
    log(id, "sys", tauri ? "> pnpm run tauri dev" : `> pnpm run ${name}`);
    await sleep(600);
    if (TASK_IDS.has(appId)) {
      setState(id, { kind: "running", pid: pid() });
      for (const line of ["vite v8.3.4 building for production...", "✓ 41 modules transformed.", "dist/assets/index-DxK3.js  218.40 kB │ gzip: 68.1 kB", "✓ built in 812ms"]) {
        log(id, "out", line);
        await sleep(400);
        if (states[id]?.kind === "stopping") return;
      }
      log(id, "sys", "exited (code 0)");
      setState(id, { kind: "exited", code: 0 });
      return;
    }
    if (tauri) log(id, "err", "     Running BeforeDevCommand (`pnpm dev`)");
    log(id, "out", "  VITE v8.3.4  ready in 260 ms");
    log(id, "out", `  ➜  Local:   http://localhost:${DEV_PORT}/`);
    setPort(id, DEV_PORT);
    if (tauri) {
      for (const line of ["   Compiling spawner v0.1.0 (C:\\dev\\spawner\\src-tauri)", "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.66s", "     Running `target\\debug\\spawner.exe`"]) {
        await sleep(700);
        if (states[id]?.kind === "stopping") return;
        log(id, "err", line);
      }
    }
    setState(id, { kind: "running", pid: pid() });
    timers.set(
      id,
      window.setInterval(() => log(id, "out", `${new Date().toLocaleTimeString("en-GB")} [vite] hmr update /src/components/Sidebar.tsx`), 2500),
    );
  }
  /** A task: runs a few steps, then ends on its own. The test run fails the first time to show a nonzero exit. */
  async function runTask(id: string, name: string) {
    setState(id, { kind: "starting" });
    log(id, "sys", `> dotnet test ${name}`);
    await sleep(500);
    setState(id, { kind: "running", pid: 1000 + Math.floor(Math.random() * 9000) });
    for (const line of ["Restore complete (0.4s)", "Starting test run: 24 tests", "Passed RefundServiceTests.Applies_partial_refund", "Passed PolicyTests.Resolves_standard_policy"]) {
      log(id, "out", line);
      await sleep(600);
      if (states[id]?.kind === "stopping") return;
    }
    const code = name.includes("Tests") && (tries.get(id) ?? 0) < 1 ? 1 : 0;
    tries.set(id, (tries.get(id) ?? 0) + 1);
    if (code) log(id, "err", "Failed RefundServiceTests.Rejects_over_capture [41 ms]");
    log(id, "sys", `exited (code ${code})`);
    setState(id, { kind: "exited", code });
  }
  async function start(projectId: string, appId: string, params: Record<string, string> | null = null) {
    const id = `${projectId}::${appId}`;
    const name = appId.replace(".csproj", "");
    if (params) log(id, "sys", `params: ${JSON.stringify(params)}`);
    if (appId.includes("#")) return runNode(id, appId);
    if (TASK_IDS.has(appId)) return runTask(id, name);
    setState(id, { kind: "building" });
    log(id, "sys", `> dotnet build ${name}`);
    await sleep(2400);
    if (name.includes("Account.Consumer") && (tries.get(id) ?? 0) < 1) {
      tries.set(id, 1);
      log(id, "err", "Services/AsaasService.cs(212,31): error CS0246: The type or namespace name 'IAsaasGateway' could not be found");
      setState(id, { kind: "failed", message: "build failed (exit 1)" });
      return;
    }
    setState(id, { kind: "starting" });
    log(id, "sys", `> dotnet run --project ${name}`);
    await sleep(800);
    setState(id, { kind: "running", pid: 1000 + Math.floor(Math.random() * 9000) });
    log(id, "out", "info: Microsoft.Hosting.Lifetime[14] Now listening on: http://localhost:5003");
    let n = 0;
    timers.set(
      id,
      window.setInterval(() => {
        n++;
        if (n % 9 === 0) TRACE.forEach((t) => log(id, "out", t));
        else log(id, "out", SAMPLES[Math.floor(Math.random() * SAMPLES.length)]);
      }, 900 + Math.random() * 600),
    );
  }
  async function stop(id: string) {
    setState(id, { kind: "stopping" });
    window.clearInterval(timers.get(id));
    await sleep(700);
    log(id, "sys", "stopped");
    setPort(id, null);
    setState(id, { kind: "exited", code: null });
  }

  const commands: Record<string, (a: Record<string, unknown>) => unknown> = {
    scan: () => groupsFor(roots),
    get_roots: () => roots,
    add_root: async (a) => {
      const path = normalize(String(a.path ?? ""));
      if (!path) throw new Error("choose a folder");
      if (!roots.some((r) => normalize(r.path).toLowerCase() === path.toLowerCase())) {
        roots = [...roots, { path, ...(a.label ? { label: String(a.label) } : {}) }];
      }
      await sleep(300);
      emit("groups-changed", groupsFor(roots));
      return roots;
    },
    remove_root: async (a) => {
      const path = normalize(String(a.path)).toLowerCase();
      roots = roots.filter((r) => normalize(r.path).toLowerCase() !== path);
      await sleep(200);
      emit("groups-changed", groupsFor(roots));
      return roots;
    },
    conclude_worktree: async (a) => {
      await sleep(900);
      const group = DEV_GROUPS.find((g) => g.id === a.groupId);
      if (!group) throw new Error("unknown worktree");
      const removed: unknown[] = [];
      const refused: unknown[] = [];
      for (const p of group.projects.filter((p) => !concluded.has(p.id))) {
        if (!a.force && p.repo === "account" && group.id === "PAYMENT-9483") {
          refused.push({ repo: p.repo, reason: `'${p.path}' contains modified or untracked files, use --force to delete it`, needsForce: true });
        } else if (group.id === flaky && p.repo === "app-api") {
          flaky = "";
          refused.push({ repo: p.repo, reason: `failed to delete '${p.path}': Permission denied (another process is using the folder)`, needsForce: false });
        } else {
          concluded.add(p.id);
          removed.push({ repo: p.repo, path: p.path, main: `C:/dev/${p.repo}`, branch: p.branch, head: "4f2a9c1" });
        }
      }
      emit("groups-changed", groupsFor(roots));
      return { removed, refused };
    },
    restore_worktrees: async (a) => {
      await sleep(900);
      for (const r of a.removed as { path: string }[]) concluded.delete(r.path);
      emit("groups-changed", groupsFor(roots));
    },
    instance_states: () => ({ ...states }),
    instance_ports: () => ({ ...ports }),
    logs_since: (a) => logs.filter((l) => l.seq > (a.since as number)),
    clear_logs: (a) => {
      const keep = a.instanceId ? logs.filter((l) => l.instance !== a.instanceId) : [];
      logs.splice(0, logs.length, ...keep);
    },
    start: (a) => void start(a.projectId as string, a.appId as string, a.params as Record<string, string> | null),
    stop: (a) => void stop(a.instanceId as string),
    claude_check: async () => (await sleep(500), { installed: true, version: "2.1.303 (Claude Code)" }),
    claude_link: async () => (
      await sleep(900),
      connected ? { state: "connected" } : STALE ? { state: "stale", configured: "http://127.0.0.1:38417/mcp" } : { state: "missing" }
    ),
    claude_connect: async () => {
      await sleep(1200);
      connected = true;
    },
    claude_add_guidance: async () => (await sleep(2200), "Added a \"Running apps\" section to ~/.claude/CLAUDE.md."),
    mcp_info: () => ({ url: `http://127.0.0.1:${STALE ? 38435 : 38417}/mcp`, error: null, portChanged: STALE }),
    open_port: () => undefined,
    load_ui_state: () => null,
    save_ui_state: () => undefined,
    get_watched: () => [...watched],
    set_watch: (a) => (a.on ? watched.add(`${a.repo}::${a.appId}`) : watched.delete(`${a.repo}::${a.appId}`), [...watched]),
    get_settings: () => settings,
    set_settings: (a) => void (settings = a.settings as typeof settings),
  };

  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    transformCallback: (fn: Handler) => {
      const id = cb++;
      callbacks.set(id, fn);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      if (cmd === "plugin:event|listen") {
        const list = listeners.get(args.event as string) ?? [];
        list.push(callbacks.get(args.handler as number)!);
        listeners.set(args.event as string, list);
        return cb++;
      }
      if (cmd.startsWith("plugin:event|")) return undefined;
      if (cmd === "plugin:dialog|open") return SAMPLE_FOLDERS[nextFolder++ % SAMPLE_FOLDERS.length];
      const fn = commands[cmd];
      if (!fn) throw new Error(`mock: unknown command ${cmd}`);
      return fn(args);
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
}
