/* Dev-only stand-in for the Tauri backend, so the UI can be driven in a plain browser (`pnpm dev`).
   Groups mirror a real scan of C:/dev; run/stop/log output is simulated.
   Folders can be added and removed in memory (`?empty` starts with none); an added folder shows as one project. */
import {
  api,
  isActive,
  rootName,
  type AppDef,
  type AppMode,
  type Group,
  type InstanceState,
  type Level,
  type LogLine,
  type Param,
  type PortEvent,
  type Pr,
  type Project,
  type ResolvedStack,
  type Root,
  type StackApp,
  type StackMissing,
  type StackRun,
  type StateEvent,
} from "../api";

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
  task("PAYMENT-10138", (r) => [account(r, "PAYMENT-10138")]),
  task("PAYMENT-10277", (r) => [account(r, "PAYMENT-10277"), bill(r, "PAYMENT-10277")]),
  task("PAYMENT-10264", (r) => [account(r, "PAYMENT-10264")]),
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
let settings = { notifyScripts: false, companion: true };
let startOnLogin = false;
const watched = new Set<string>();
const SAMPLE_FOLDERS = ["D:/side/notes-api", "C:/scripts/nightly", "C:/work/clients"];

/** The scenarios the cockpit can be opened in: `?s=review|conflict|nostack|nogh`. */
const SCENARIO = new URLSearchParams(location.search).get("s") ?? "review";
/** `?nogh` on its own also turns gh off, since that is what the state is about. */
const NO_GH = SCENARIO === "nogh" || new URLSearchParams(location.search).has("nogh");

/** One entry of a committed spawner.stack.json, before it is matched to a checkout. */
interface ManifestApp {
  repo: string;
  app: string;
  port?: number;
  scheme?: string;
  env?: Record<string, string>;
}

interface Manifest {
  name: string;
  apps: ManifestApp[];
  open: string[];
}

/**
 * repo -> spawner.stack.json. Committed in the account repo, so every worktree of account gets the stack; app-api and
 * acme-shield-api have none, which is where the no-stack card comes from. `?s=nostack` starts with no manifest at all.
 */
const MANIFESTS: Record<string, Manifest> = {
  account: {
    name: "Account + Bill",
    apps: [
      {
        repo: "account",
        app: "Acme.Account.Admin.Server",
        port: 5104,
        scheme: "https",
        env: { BillApi__BaseUrl: "http://localhost:{port:Acme.Bill.API}" },
      },
      { repo: "bill", app: "Acme.Bill.API", port: 42318 },
      { repo: "bill", app: "Acme.Bill.Charger.Monitor" },
    ],
    open: ["Acme.Account.Admin.Server"],
  },
};

/** What `gh pr list` reports for the open branches, in the same shape as the backend's JSON. */
const PRS: Pr[] = [
  {
    repo: "account",
    slug: "ublr/account",
    number: 1720,
    title: "Show partial refunds on the invoice page",
    head: "PAYMENT-10138",
    draft: false,
    review: "approved",
    url: "https://github.com/ublr/account/pull/1720",
    checks: { pass: 14, fail: 0, pending: 0, failing: [] },
  },
  {
    repo: "account",
    slug: "ublr/account",
    number: 1736,
    title: "Retry Asaas webhooks with backoff",
    head: "PAYMENT-10277",
    draft: false,
    review: "changes",
    url: "https://github.com/ublr/account/pull/1736",
    checks: { pass: 13, fail: 1, pending: 0, failing: ["build-and-test"] },
  },
  // The same task's Bill side: a second PR on one worktree, in a repo with no CI, as most of the real ones are.
  {
    repo: "bill",
    slug: "ublr/bill",
    number: 412,
    title: "Expose the webhook retry budget on the Bill API",
    head: "PAYMENT-10277",
    draft: false,
    review: "pending",
    url: "https://github.com/ublr/bill/pull/412",
    checks: { pass: 0, fail: 0, pending: 0, failing: [] },
  },
  {
    repo: "account",
    slug: "ublr/account",
    number: 1734,
    title: "Tax breakdown on the invoice PDF",
    head: "PAYMENT-10264",
    draft: true,
    review: null,
    url: "https://github.com/ublr/account/pull/1734",
    checks: { pass: 9, fail: 0, pending: 5, failing: [] },
  },
];

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

  /** The committed manifests, mutable because write_stack adds one. `?s=nostack` starts with none. */
  const manifests: Record<string, Manifest> = SCENARIO === "nostack" ? {} : { ...MANIFESTS };
  /** Manifest repos written by write_stack: on disk but not committed yet, so the card says so. */
  const uncommitted = new Set<string>();
  /** Port overrides Spawner keeps per checkout, never committed. Keyed `projectId::appId`. */
  const overrides = new Map<string, number>();
  /** Kinds Spawner can hand a port to at start; the rest run on whatever their own config says. */
  const PORTABLE = new Set(["iis-express", "dotnet-run", "vite", "next", "react", "node"]);

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
  async function start(
    projectId: string,
    appId: string,
    params: Record<string, string> | null = null,
    opts: { port?: number | null; scheme?: string } = {},
  ) {
    const id = `${projectId}::${appId}`;
    const name = appId.replace(".csproj", "");
    const port = opts.port ?? null;
    const scheme = opts.scheme ?? "http";
    if (params) log(id, "sys", `params: ${JSON.stringify(params)}`);
    // The backend refuses a port something else holds, before it builds: the same message the card recognises.
    const holder = port == null ? null : holderOf(port, id);
    if (holder) {
      const message = `port ${port} is already in use by ${holder}`;
      log(id, "sys", `Not started: ${message}`);
      setState(id, { kind: "failed", message });
      return;
    }
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
    log(id, "sys", `> dotnet run --project ${name}${port != null ? ` --urls ${scheme}://localhost:${port}` : ""}`);
    await sleep(800);
    setState(id, { kind: "running", pid: 1000 + Math.floor(Math.random() * 9000) });
    if (port != null) {
      setPort(id, port);
      log(id, "out", `info: Microsoft.Hosting.Lifetime[14] Now listening on: ${scheme}://localhost:${port}`);
    } else {
      log(id, "out", "info: Microsoft.Hosting.Lifetime[14] Now listening on: http://localhost:5003");
    }
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

  /* ───────── stacks: spawner.stack.json resolved against the worktree's checkouts ───────── */

  const allGroups = () => groupsFor(roots);
  const allProjects = () => allGroups().flatMap((g) => g.projects);
  const mainProjects = () => allGroups().filter((g) => g.main).flatMap((g) => g.projects);
  const findGroup = (id: string) => allGroups().find((g) => g.id === id);
  const lower = (s: string) => s.toLowerCase();
  const instanceOf = (p: Project, a: AppDef) => `${p.id}::${a.id}`;

  /** A manifest names an app by name, by id, or by the id without its extension. */
  function findApp(project: Project, name: string): AppDef | undefined {
    const want = lower(name);
    return (
      project.apps.find((a) => lower(a.name) === want) ??
      project.apps.find((a) => lower(a.id) === want) ??
      project.apps.find((a) => lower(a.id.replace(/\.[^.]+$/, "")) === want)
    );
  }

  /** The worktree's own checkout of a repo, else the main one (which is then shared with every worktree). */
  const projectOf = (group: Group, repo: string) =>
    group.projects.find((p) => p.repo === repo) ?? mainProjects().find((p) => p.repo === repo);

  function stackApp(
    group: Group,
    project: Project,
    app: AppDef,
    manPort: number | undefined,
    scheme: string,
    envSpec: Record<string, string>,
    known: { name: string; port: number | null }[],
  ): StackApp {
    const instance = instanceOf(project, app);
    const own = group.projects.some((p) => p.id === project.id);
    const override = overrides.get(instance);
    const port = override ?? manPort ?? app.port ?? null;
    const portSource: StackApp["portSource"] =
      override != null ? "worktree" : manPort != null ? "repo" : app.port != null ? "detected" : "none";
    /** `{port}` is this app's port, `{port:Other}` another stack app's, `{cwd}` the checkout. */
    const fill = (raw: string) =>
      raw
        .replace(/\{port:([^}]+)\}/g, (whole, name: string) => {
          const hit = known.find((k) => lower(k.name) === lower(name.trim()));
          return hit?.port != null ? String(hit.port) : whole;
        })
        .replace(/\{port\}/g, port != null ? String(port) : "{port}")
        .replace(/\{cwd\}/g, project.path);
    return {
      projectId: project.id,
      appId: app.id,
      instance,
      app: app.name,
      repo: project.repo,
      checkout: own ? "worktree" : "main",
      shared: !own,
      kind: app.kind,
      mode: app.mode,
      port,
      portSource,
      defaultPort: manPort ?? app.port ?? null,
      portSettable: PORTABLE.has(app.kind),
      url: port != null ? `${scheme}://localhost:${port}` : null,
      env: Object.fromEntries(Object.entries(envSpec).map(([k, v]) => [k, fill(v)])),
    };
  }

  /** The worktree's service apps, for the no-stack card and for write_stack. */
  const detectedOf = (group: Group) =>
    group.projects.flatMap((p) =>
      p.apps.filter((a) => a.mode === "service").map((a) => stackApp(group, p, a, undefined, "http", {}, [])),
    );

  /** Walks the worktree's repos in order; the first committed manifest wins, as the backend does. */
  function resolveStack(group: Group): ResolvedStack {
    const branch = group.projects.find((p) => p.branch)?.branch ?? null;
    const base = { worktree: group.id, label: group.label, branch };
    const repo = group.projects.map((p) => p.repo).find((r) => manifests[r]);
    if (!repo) return { ...base, name: null, source: null, open: [], apps: [], missing: [], detected: detectedOf(group) };
    const manifest = manifests[repo];
    // Ports first: an app's env can point at another app's port.
    const known = manifest.apps.flatMap((e) => {
      const project = projectOf(group, e.repo);
      const app = project && findApp(project, e.app);
      if (!project || !app) return [];
      const instance = instanceOf(project, app);
      return [{ name: app.name, port: overrides.get(instance) ?? e.port ?? app.port ?? null }];
    });
    const apps: StackApp[] = [];
    const missing: StackMissing[] = [];
    for (const e of manifest.apps) {
      const project = projectOf(group, e.repo);
      const app = project && findApp(project, e.app);
      if (!project || !app) {
        missing.push({ repo: e.repo, app: e.app });
        continue;
      }
      apps.push(stackApp(group, project, app, e.port, e.scheme ?? "http", e.env ?? {}, known));
    }
    const own = group.projects.find((p) => p.repo === repo);
    return {
      ...base,
      name: manifest.name,
      source: { repo, file: `${own?.path ?? repo}/spawner.stack.json`, committed: !uncommitted.has(repo) },
      open: manifest.open,
      apps,
      missing,
      detected: [],
    };
  }

  /** The port this checkout's stack resolved for an app, so a per-app Run agrees with the card. */
  function resolvedPort(projectId: string, appId: string): { port: number | null; scheme: string } {
    for (const g of allGroups()) {
      const hit = resolveStack(g).apps.find((a) => a.projectId === projectId && a.appId === appId);
      if (hit) return { port: hit.port, scheme: hit.url?.startsWith("https") ? "https" : "http" };
    }
    const project = allProjects().find((p) => p.id === projectId);
    return { port: project?.apps.find((a) => a.id === appId)?.port ?? null, scheme: "http" };
  }

  /** What holds a port: another instance of this mock that is running on it. */
  function holderOf(port: number, self: string): string | null {
    for (const [id, state] of Object.entries(states)) {
      if (id === self || !isActive(state) || ports[id] !== port) continue;
      return id.split("::")[1].replace(/\.csproj$/, "");
    }
    return null;
  }

  /** The next port above `from` that no running instance holds. */
  function freePort(from: number): number {
    const taken = new Set<number>();
    for (const [id, state] of Object.entries(states)) if (isActive(state) && ports[id] != null) taken.add(ports[id]);
    let port = from + 1;
    while (taken.has(port)) port++;
    return port;
  }

  /** One straight from the command layer: the app moves building -> running, or fails on its port. */
  async function startStack(a: Record<string, unknown>): Promise<StackRun[]> {
    const group = findGroup(String(a.worktree ?? ""));
    if (!group) throw new Error("unknown worktree");
    const stack = resolveStack(group);
    if (!stack.source) throw new Error("no spawner.stack.json: use write_stack or add one");
    const only = (a.apps as string[] | null | undefined) ?? null;
    const selected = stack.apps.filter((x) => x.mode === "service" && (!only || only.includes(x.app)));
    // Every app at once, like the backend: one app's failure never holds the others back.
    return Promise.all(
      selected.map(async (x): Promise<StackRun> => {
        const running = states[x.instance];
        if (isActive(running)) {
          return { app: x.app, instance: x.instance, state: running.kind, port: x.port, url: x.url, error: null, reused: true };
        }
        await start(x.projectId, x.appId, null, {
          port: x.port,
          scheme: x.url?.startsWith("https") ? "https" : "http",
        });
        const done = states[x.instance];
        return {
          app: x.app,
          instance: x.instance,
          state: done?.kind ?? "stopped",
          port: ports[x.instance] ?? x.port,
          url: x.url,
          error: done?.kind === "failed" ? done.message : null,
          reused: false,
        };
      }),
    );
  }

  async function stopStack(a: Record<string, unknown>) {
    const group = findGroup(String(a.worktree ?? ""));
    if (!group) throw new Error("unknown worktree");
    const keepShared = a.keepShared !== false;
    const stack = resolveStack(group);
    // The UI passes keepShared = false, so this worktree really goes down; MCP may keep the shared main checkouts up.
    return Promise.all(
      stack.apps.map(async (x) => {
        const stopped = isActive(states[x.instance]) && !(keepShared && x.shared);
        if (stopped) await stop(x.instance);
        return { app: x.app, instance: x.instance, stopped };
      }),
    );
  }

  /** A little history, so a worktree's logs are not empty before anything has been started in this session. */
  function seedLogs() {
    const group = allGroups().find((g) => g.id === "PAYMENT-10138");
    const stack = group ? resolveStack(group) : null;
    const web = stack?.apps[0];
    if (!web) return;
    let at = Date.now() - 7 * 60_000;
    const push = (instance: string, level: Level, text: string) => {
      logs.push({ seq: seq++, instance, ts: (at += 500), stream: level === "err" ? "err" : level === "sys" ? "sys" : "out", level, text });
    };
    const apiApp = stack.apps.find((x) => x.app === "Acme.Bill.API");
    push(web.instance, "sys", `> dotnet build ${web.app} -nologo`);
    push(web.instance, "sys", `> dotnet run --project ${web.app} --no-build --urls https://localhost:${web.port}`);
    push(web.instance, "inf", `info: Microsoft.Hosting.Lifetime[14] Now listening on: https://localhost:${web.port}`);
    if (apiApp) push(apiApp.instance, "inf", `GET /invoices/88421/refunds → 200 (18ms) count=2`);
    push(web.instance, "inf", "GET /invoices/88421 → 200 (64ms) customer=c_4471");
    push(web.instance, "inf", "POST /invoices/88421/refunds → 202 (122ms) amount=49.90 kind=partial");
    if (apiApp) push(apiApp.instance, "wrn", "Slow query 812ms: SELECT * FROM RefundItems WHERE InvoiceId = @p0");
    push(web.instance, "sys", `${web.app} stopped`);
    const other = allGroups().find((g) => g.id === "PAYMENT-10277");
    const second = other ? resolveStack(other).apps[0] : null;
    if (second) {
      push(second.instance, "sys", `> dotnet run --project ${second.app} --no-build`);
      push(second.instance, "err", "Asaas webhook handler threw: System.TimeoutException: retry budget exhausted after 3 attempts");
    }
  }

  const commands: Record<string, (a: Record<string, unknown>) => unknown> = {
    scan: () => groupsFor(roots),
    groups: () => groupsFor(roots),
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
    start: (a) => {
      const resolved = resolvedPort(a.projectId as string, a.appId as string);
      return void start(a.projectId as string, a.appId as string, a.params as Record<string, string> | null, resolved);
    },
    stop: (a) => void stop(a.instanceId as string),

    /* stacks */
    stack: (a) => {
      const group = findGroup(String(a.worktree ?? ""));
      if (!group) throw new Error("unknown worktree");
      return resolveStack(group);
    },
    write_stack: async (a) => {
      await sleep(500);
      const group = findGroup(String(a.worktree ?? ""));
      if (!group) throw new Error("unknown worktree");
      const repo = group.projects.map((p) => p.repo).find((r) => !manifests[r]);
      if (!repo) throw new Error("spawner.stack.json already exists in this worktree");
      const wanted = Array.isArray(a.apps) ? new Set((a.apps as string[]).map((n) => n.toLowerCase())) : null;
      const detected = resolveStack(group).detected.filter((d) => !wanted || wanted.has(d.app.toLowerCase()));
      if (!detected.length) throw new Error("no service app to put in a stack");
      manifests[repo] = {
        name: repo[0].toUpperCase() + repo.slice(1),
        apps: detected.map((d) => ({ repo: d.repo, app: d.app, ...(d.port != null ? { port: d.port } : {}) })),
        open: detected.filter((d) => d.port != null).slice(0, 1).map((d) => d.app),
      };
      uncommitted.add(repo);
      return resolveStack(group);
    },
    set_port: (a) => {
      const instance = `${String(a.projectId)}::${String(a.appId)}`;
      if (a.port == null) overrides.delete(instance);
      else overrides.set(instance, Number(a.port));
    },
    free_port: (a) => freePort(Number(a.port ?? 0)),
    start_stack: (a) => startStack(a),
    stop_stack: (a) => stopStack(a),
    open_prs: async (a) => {
      if (NO_GH) throw new Error("gh is not installed (install GitHub CLI and run gh auth login)");
      await sleep(a.force ? 150 : 500);
      return { prs: PRS, errors: [] };
    },
    agent_check: async (a) => (
      await sleep(500),
      { installed: true, version: a.kind === "opencode" ? "2.2.7" : "2.1.303 (Claude Code)" }
    ),
    agent_link: async (a) => (
      await sleep(900),
      a.kind === "opencode"
        ? connected ? { state: "configured" } : STALE ? { state: "stale", configured: "http://127.0.0.1:38417/mcp" } : { state: "missing" }
        : connected ? { state: "connected" } : STALE ? { state: "stale", configured: "http://127.0.0.1:38417/mcp" } : { state: "missing" }
    ),
    agent_connect: async () => {
      await sleep(1200);
      connected = true;
    },
    agent_add_guidance: async (a) => (
      await sleep(2200),
      a.kind === "opencode" ? "Added a \"Running apps\" section to ~/.config/opencode/AGENTS.md." : "Added a \"Running apps\" section to ~/.claude/CLAUDE.md."
    ),
    mcp_info: () => ({ url: `http://127.0.0.1:${STALE ? 38435 : 38417}/mcp`, error: null, portChanged: STALE }),
    open_port: () => undefined,
    load_ui_state: () => null,
    save_ui_state: () => undefined,
    get_watched: () => [...watched],
    set_watch: (a) => (a.on ? watched.add(`${a.repo}::${a.appId}`) : watched.delete(`${a.repo}::${a.appId}`), [...watched]),
    get_settings: () => settings,
    companion_open: () => undefined,
    companion_focus: () => undefined,
    // undefined means the backend cannot say where the cursor is, so the page follows its own pointer events.
    companion_pointer: () => undefined,
    companion_place: () => undefined,
    companion_drag: () => undefined,
    companion_dismiss: () => undefined,
    set_settings: (a) => void (settings = a.settings as typeof settings),
    get_start_on_login: () => startOnLogin,
    set_start_on_login: (a) => void (startOnLogin = a.on as boolean),
  };

  seedLogs();
  if (SCENARIO === "conflict") {
    // PAYMENT-10138 is already up on the repo defaults, so PAYMENT-10264's stack finds 5104 taken.
    const group = allGroups().find((g) => g.id === "PAYMENT-10138");
    const stack = group ? resolveStack(group) : null;
    for (const app of stack?.apps ?? []) {
      if (app.port != null) ports[app.instance] = app.port;
      states[app.instance] = { kind: "running", pid: pid() };
      log(app.instance, "out", `info: Microsoft.Hosting.Lifetime[14] Now listening on: ${app.url ?? "http://localhost"}`);
    }
  }

  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "companion" }, currentWebview: { label: "companion", windowLabel: "companion" } },
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
      // The companion places itself against a monitor; the preview has none, so it stays where the page puts it.
      if (cmd === "plugin:window|available_monitors") return [];
      if (cmd.startsWith("plugin:window|")) return null;
      if (cmd === "plugin:dialog|open") return SAMPLE_FOLDERS[nextFolder++ % SAMPLE_FOLDERS.length];
      const fn = commands[cmd];
      if (!fn) throw new Error(`mock: unknown command ${cmd}`);
      return fn(args);
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
  // Lets a browser test play a backend event, such as the companion asking for its view to be restored.
  w.__mockEmit = emit;
}

/** For the companion preview (`?companion`): starts a few services so it has something to show. */
export async function startSome() {
  const groups = await api.scan();
  const services = groups.flatMap((g) => g.projects.flatMap((p) => p.apps.filter((a) => a.mode === "service").map((a) => [p.id, a.id] as const)));
  for (const [projectId, appId] of services.slice(0, 4)) await api.start(projectId, appId);
}
