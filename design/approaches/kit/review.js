/* B2 · review-first worktree cockpit: the simulated backend.
   Separate from kit.js on purpose: kit.js models T3 threads and conversations, which B2 drops. What stays is the
   look (kit.css), the log view and the app lifecycle. Everything here has the shape of a real source:
   - `gh pr list --repo <owner/repo> --state open --json …` per repo, cached 60 s
   - `t3 thread list --project <main checkout> --json` per repo, cached 60 s, only to link a worktree to its thread
   - `spawner.stack.json`, committed in the repo, read from the worktree's own checkout
   - per-worktree port overrides, kept by Spawner (UI or MCP), never committed */
(() => {
  const R = (window.R = {});
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));
  Object.assign(R, { $, $$, esc, sleep });

  /* ───────── bus ───────── */
  const subs = {};
  R.on = (ev, fn) => (subs[ev] ||= []).push(fn);
  R.emit = (ev, d) => (subs[ev] || []).forEach((f) => f(d));
  let dirty = false;
  R.changed = () => {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(() => ((dirty = false), R.emit("render")));
  };
  /** Swaps an element's HTML only when it changed; keeps typed values and focus of inputs that carry data-key. */
  R.put = (el, html) => {
    if (!el || el._html === html) return;
    const typed = $$("input[data-key]", el).map((t) => [t.dataset.key, t.value, t === document.activeElement, t.selectionStart]);
    el.innerHTML = html;
    el._html = html;
    for (const [k, v, focused, caret] of typed) {
      const t = el.querySelector(`input[data-key="${CSS.escape(k)}"]`);
      if (!t) continue;
      t.value = v;
      if (focused) {
        t.focus({ preventScroll: true });
        try { t.setSelectionRange(caret, caret); } catch {}
      }
    }
  };

  /* ───────── clock: the demo starts at 14:20 ───────── */
  const t0 = Date.now(), base = new Date();
  base.setHours(14, 20, 4, 310);
  R.now = () => base.getTime() + (Date.now() - t0);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  R.hms = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
  R.ago = (ts) => {
    const s = Math.max(0, Math.round((R.now() - ts) / 1000));
    return s < 5 ? "just now" : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };

  /* ───────── repos, detected apps, committed stack manifests ───────── */
  const HOME = "C:\\Users\\Pichau", T3WT = `${HOME}\\.t3\\worktrees`;
  const D = (name, kind, port, extra = {}) => ({ name, kind, port, ...extra });
  const REPOS = (R.REPOS = {
    account: { gh: "ublr/account", main: "C:\\umbler\\account", apps: [D("Account Web", "dotnet-run", 5104, { proj: "src\\Account.Web\\Account.Web.csproj", scheme: "https" }), D("Account Tests", "dotnet-test", null, { task: true })] },
    bill: { gh: "ublr/bill", main: "C:\\umbler\\bill", apps: [D("Bill API", "iis-express", 42318, { proj: "src\\Bill.Api" }), D("Billing Worker", "dotnet-run", null, { proj: "src\\Bill.Worker\\Bill.Worker.csproj" })] },
    cadence: { gh: "ublr/cadence", main: "C:\\Projects\\cadence", apps: [D("Ledger API", "dotnet-run", 5050, { proj: "src\\Cadence.Ledger.Api\\Cadence.Ledger.Api.csproj" }), D("Ledger Worker", "dotnet-run", null, { proj: "src\\Cadence.Ledger.Worker\\Cadence.Ledger.Worker.csproj" })] },
    cibi: { gh: "ublr/cibi", main: "C:\\umbler\\cibi", apps: [D("Cibi Web", "iis-express", 5003, { proj: "src\\Cibi.Web" }), D("Cibi Jobs", "dotnet-run", null, { proj: "src\\Cibi.Jobs\\Cibi.Jobs.csproj" }), D("Cibi Migrate", "dotnet-run", null, { task: true })] },
  });
  /** repo -> spawner.stack.json. Committed, so every new worktree of the repo has it on its branch. */
  R.MANIFESTS = {
    account: { name: "Account + Bill", apps: [{ repo: "account", app: "Account Web", port: 5104 }, { repo: "bill", app: "Bill API", port: 42318 }, { repo: "bill", app: "Billing Worker" }], open: ["Account Web"] },
    cadence: { name: "Ledger", apps: [{ repo: "cadence", app: "Ledger API", port: 5050 }, { repo: "cadence", app: "Ledger Worker" }, { repo: "bill", app: "Bill API", port: 42318 }], open: ["Ledger API"] },
  };
  /* Worktrees as Spawner scans them: a branch and the repo checkouts on it. T3 worktrees hold one repo each. */
  R.WTS = [
    { id: "t3-8f4d95f7", label: "PAYMENT-10138", branch: "PAYMENT-10138", co: { account: `${T3WT}\\account\\t3-8f4d95f7` }, touched: 25 },
    { id: "PAYMENT-10277", label: "PAYMENT-10277", branch: "PAYMENT-10277", co: { account: "C:\\dev\\PAYMENT-10277\\account", bill: "C:\\dev\\PAYMENT-10277\\bill" }, touched: 70 },
    { id: "t3-2a91c0de", label: "PAYMENT-10264", branch: "PAYMENT-10264", co: { account: `${T3WT}\\account\\t3-2a91c0de` }, touched: 140 },
    { id: "PAYMENT-10190", label: "PAYMENT-10190", branch: "PAYMENT-10190", co: { cadence: "C:\\dev\\PAYMENT-10190\\cadence", bill: "C:\\dev\\PAYMENT-10190\\bill" }, touched: 6 },
    { id: "PAYMENT-10301", label: "PAYMENT-10301", branch: "PAYMENT-10301", co: { cibi: "C:\\dev\\PAYMENT-10301\\cibi" }, touched: 300 },
    { id: "PAYMENT-10122", label: "PAYMENT-10122", branch: "PAYMENT-10122", co: { bill: "C:\\dev\\PAYMENT-10122\\bill" }, touched: 2900 },
  ];
  R.wt = (id) => R.WTS.find((w) => w.id === id);

  /* ───────── sources: gh and t3, with the fields their --json output really has ───────── */
  const PRS = [
    { repo: "account", number: 1720, title: "Show partial refunds on the invoice page", headRefName: "PAYMENT-10138", isDraft: false, reviewDecision: "APPROVED", by: "guilherme-kilian", checks: { pass: 14, fail: 0, pending: 0, failing: [] } },
    { repo: "account", number: 1736, title: "Retry Asaas webhooks with backoff", headRefName: "PAYMENT-10277", isDraft: false, reviewDecision: "CHANGES_REQUESTED", by: "guilherme-kilian", checks: { pass: 13, fail: 1, pending: 0, failing: ["build-and-test"] } },
    { repo: "account", number: 1734, title: "Tax breakdown on the invoice PDF", headRefName: "PAYMENT-10264", isDraft: true, reviewDecision: "", by: null, checks: { pass: 9, fail: 0, pending: 5, failing: [] } },
  ];
  PRS.forEach((p) => (p.url = `https://github.com/${REPOS[p.repo].gh}/pull/${p.number}`));
  const THREADS = [
    { project: REPOS.account.main, threadId: "8f4d95f7-1c2e-4a7d-9b1e-0c4f2d6a8e31", title: "PAYMENT-10138 partial refunds on invoice page", branch: "PAYMENT-10138", worktreePath: `${T3WT}\\account\\t3-8f4d95f7`, pullRequests: [{ host: "github.com", repository: "ublr/account", number: 1720, state: "open" }] },
    { project: REPOS.account.main, threadId: "2a91c0de-77b0-4f4e-8a26-5d1e93c0f412", title: "PAYMENT-10264 tax breakdown", branch: "PAYMENT-10264", worktreePath: `${T3WT}\\account\\t3-2a91c0de`, pullRequests: [{ host: "github.com", repository: "ublr/account", number: 1734, state: "open" }] },
  ];
  const S = (R.S = {
    gh: "ok", t3: "ok", // ok | missing
    ghAt: R.now() - 23_000, t3At: R.now() - 41_000,
    logs: [], seq: 0, sel: new Set(),
    ports: {}, // instance id -> override port
    external: {}, // port -> holder outside Spawner
  });
  R.prsOf = (w) => {
    if (S.gh === "ok") return PRS.filter((p) => w.co[p.repo] && p.headRefName === w.branch).map((p) => ({ ...p, via: "gh" }));
    if (S.t3 === "ok") return THREADS.filter((t) => R.threadMatches(t, w)).flatMap((t) => t.pullRequests.filter((p) => p.state === "open").map((p) => ({ repo: p.repository.split("/")[1], number: p.number, url: `https://${p.host}/${p.repository}/pull/${p.number}`, title: PRS.find((x) => x.number === p.number)?.title, via: "t3" })));
    return [];
  };
  R.threadMatches = (t, w) => Object.values(w.co).some((p) => p.toLowerCase() === t.worktreePath.toLowerCase()) || t.branch === w.branch;
  R.threadOf = (w) => (S.t3 === "ok" ? THREADS.find((t) => R.threadMatches(t, w)) : null) || null;
  R.reviewSource = () => (S.gh === "ok" ? "gh" : S.t3 === "ok" ? "t3" : null);
  setInterval(() => {
    // the 60 s refresh, one call per repo for each source; the clock runs faster than real time in the demo
    if (R.now() - S.ghAt > 60_000 && S.gh === "ok") S.ghAt = R.now();
    if (R.now() - S.t3At > 60_000 && S.t3 === "ok") S.t3At = R.now();
    $$("[data-ago]").forEach((e) => (e.textContent = R.ago(+e.dataset.ago)));
  }, 1000);

  /* ───────── instances: one per (checkout, app), shared when two worktrees resolve to the same main checkout ───────── */
  const COLORS = ["var(--i1)", "var(--i2)", "var(--i3)", "var(--i4)", "var(--i5)"];
  const I = (R.I = {});
  let ci = 0;
  const inst = (repo, appName, checkout, from, wtLabel) => {
    const id = `${checkout}::${appName}`;
    if (!I[id]) {
      const def = REPOS[repo].apps.find((a) => a.name === appName);
      I[id] = { id, repo, checkout, from, wtLabel: from === "main" ? "main" : wtLabel, ...def, defPort: def.port, state: "idle", runPort: null, conflict: null, color: COLORS[ci++ % 5], since: 0 };
    }
    return I[id];
  };
  R.portOf = (i) => (i.defPort == null ? null : S.ports[i.id] ?? i.defPort);
  R.overridden = (i) => S.ports[i.id] != null && S.ports[i.id] !== i.defPort;
  /** Kinds Spawner can hand a port to at start; the rest run on whatever their own config says. */
  R.PORTABLE = { "dotnet-run": "--urls", "iis-express": "/port", vite: "--port", next: "-p", npm: "PORT" };
  const stackRepoOf = (w) => Object.keys(w.co).find((r) => R.MANIFESTS[r]);
  /** The worktree's stack: the manifest from its own checkout, each app resolved to this worktree's checkout or main. */
  R.stack = (w) => {
    const repo = stackRepoOf(w);
    if (!repo) return null;
    const m = R.MANIFESTS[repo];
    const items = m.apps.map((a) => {
      const own = w.co[a.repo];
      const i = inst(a.repo, a.app, own || REPOS[a.repo].main, own ? "worktree" : "main", w.label);
      if (a.port != null && i.defPort !== a.port) i.defPort = a.port;
      return i;
    });
    return { repo, file: `${w.co[repo]}\\spawner.stack.json`, name: m.name, open: m.open || [], items, fresh: m.fresh };
  };
  /** What the detectors find in the worktree's checkouts, for a repo with no manifest yet. */
  R.detected = (w) => Object.entries(w.co).flatMap(([repo, path]) => REPOS[repo].apps.map((a) => ({ repo, app: a, inst: a.task ? null : inst(repo, a.name, path, "worktree", w.label) })));
  R.scopeIds = (w) => {
    const st = R.stack(w);
    return st ? st.items.map((i) => i.id) : R.detected(w).filter((d) => d.inst).map((d) => d.inst.id);
  };
  R.usersOf = (i) => R.WTS.filter((w) => R.stack(w)?.items.includes(i));

  /* ───────── logs ───────── */
  R.LV = { dbg: "DBG", inf: "INF", wrn: "WRN", err: "ERR", sys: "hub", mcp: "MCP" };
  function addLog(id, level, text, ts = R.now()) {
    S.logs.push({ seq: ++S.seq, inst: id, level, text, ts });
    if (S.logs.length > 1200) S.logs.splice(0, 300);
    R.changed();
  }
  R.addLog = addLog;
  R.active = (s) => ["building", "starting", "running", "stopping"].includes(s);
  const cmdOf = (i, port) => {
    if (i.kind === "iis-express") return `iisexpress /path:${i.checkout}\\${i.proj} /port:${port} /clr:v4.0`;
    return `dotnet run --project ${i.proj} --no-build${port ? ` --urls ${i.scheme || "http"}://localhost:${port}` : ""}`;
  };
  const upLine = (i, port) => (i.kind === "iis-express" ? `IIS Express is running · http://localhost:${port}/` : port ? `Now listening on: ${i.scheme || "http"}://localhost:${port}` : i.name.includes("Worker") ? 'Outbox listening on channel "billing.events" (poll=500ms)' : "Worker started");

  /* Seed: PAYMENT-10190 running now; earlier runs of PAYMENT-10138 and PAYMENT-10277 left their logs. */
  (() => {
    const s138 = R.stack(R.wt("t3-8f4d95f7")).items, s277 = R.stack(R.wt("PAYMENT-10277")).items, s190 = R.stack(R.wt("PAYMENT-10190")).items;
    const [aw, ba, bw] = s138, [aw2] = s277, [la, lw] = s190;
    let t = R.now() - 27 * 60_000;
    const L = (i, lv, tx, ms = rnd(300, 1400)) => addLog(i.id, lv, tx, (t += ms));
    L(aw2, "sys", `> dotnet build ${aw2.proj} -nologo`, 0);
    L(aw2, "wrn", "Services\\AsaasWebhookService.cs(88,13): warning CS1998: This async method lacks 'await' operators and will run synchronously.", 6000);
    L(aw2, "sys", `> ${cmdOf(aw2, 5104)}`);
    L(aw2, "inf", "Now listening on: https://localhost:5104", 4800);
    L(aw2, "inf", "POST /webhooks/asaas → 500 (231ms) event=PAYMENT_RECEIVED", 9000);
    L(aw2, "err", "Asaas webhook handler threw: System.TimeoutException: retry budget exhausted after 3 attempts (backoff=2s)", 2);
    L(aw2, "sys", "Account Web stopped", 30000);
    t = R.now() - 24 * 60_000;
    L(ba, "sys", `Building Bill API @ main (MSBuild · Debug)…`, 0);
    L(aw, "sys", `> dotnet build ${aw.proj} -nologo`, 200);
    L(bw, "sys", `> ${cmdOf(bw)}`, 300);
    L(ba, "sys", `Build succeeded in 5.1 s · ${cmdOf(ba, 42318)}`, 5100);
    L(ba, "inf", upLine(ba, 42318), 600);
    L(bw, "inf", upLine(bw), 300);
    L(aw, "sys", `> ${cmdOf(aw, 5104)}`, 900);
    L(aw, "inf", "Now listening on: https://localhost:5104", 4300);
    L(aw, "inf", "GET /invoices/88421 → 200 (64ms) customer=c_4471", 12000);
    L(aw, "inf", "GET /api/invoices/88421/refunds → 200 (41ms)", 30);
    L(ba, "inf", "GET /invoices/88421/refunds → 200 (18ms) count=2", 10);
    L(aw, "inf", "POST /invoices/88421/refunds → 202 (122ms) amount=49.90 kind=partial", 9000);
    L(ba, "inf", "POST /refunds → 201 (77ms) refundId=rf_8842 partial=true", 40);
    L(bw, "inf", "Outbox: dispatched 3 events in 31ms", 600);
    L(ba, "wrn", "Slow query 812ms: SELECT * FROM RefundItems WHERE InvoiceId = @p0", 14000);
    L(aw, "sys", "Account Web stopped", 60000);
    L(ba, "sys", "Bill API stopped", 200);
    L(bw, "sys", "Billing Worker stopped", 200);
    t = R.now() - 6 * 60_000;
    L(la, "sys", `> ${cmdOf(la, 5050)}`, 0);
    L(lw, "sys", `> ${cmdOf(lw)}`, 200);
    L(la, "inf", upLine(la, 5050), 5200);
    L(lw, "inf", "Ledger worker started · consumer group ledger-dev", 600);
    L(la, "inf", "GET /ledger/accounts/c_4471/balance → 200 (22ms)", 40000);
    L(lw, "inf", "Posted 14 entries in 61ms batch=b_3301", 30000);
    for (const i of [la, lw]) Object.assign(i, { state: "running", since: R.now() - 6 * 60_000, runPort: R.portOf(i) });
    // PAYMENT-10277 has its own bill checkout; its overrides let it run next to PAYMENT-10138, which uses main.
    S.ports[aw2.id] = 5114;
    S.ports[s277[1].id] = 42319;
  })();
  const POOL = {
    "Account Web": [["inf", "GET /invoices/{n} → 200 ({ms}ms) customer=c_4471"], ["inf", "GET /billing/overview → 200 ({ms}ms)"], ["dbg", "Session refreshed for customer c_{n}"]],
    "Bill API": [["inf", "GET /invoices/{n}/refunds → 200 ({ms}ms) count={k}"], ["inf", "GET /contracts/{n} → 200 ({ms}ms)"], ["wrn", "Asaas webhook retry {k}/5 for payment pay_{n} (HTTP 502)"]],
    "Billing Worker": [["inf", "Outbox: dispatched {k} events in {ms}ms"], ["inf", "Heartbeat ok lag=0.{k}s"]],
    "Ledger API": [["inf", "GET /ledger/accounts/c_{n}/balance → 200 ({ms}ms)"], ["inf", "POST /ledger/entries → 201 ({ms}ms) batch=b_{n}"]],
    "Ledger Worker": [["inf", "Posted {k} entries in {ms}ms batch=b_{n}"]],
    "Cibi Web": [["inf", "GET /painel → 200 ({ms}ms)"]],
    "Cibi Jobs": [["inf", "Job SyncInvoices ran in {ms}ms rows={k}"]],
  };
  const fill = (s) => s.replace("{n}", rnd(88400, 89400)).replace("{ms}", rnd(14, 190)).replace("{k}", rnd(1, 9));
  setInterval(() => {
    const live = Object.values(I).filter((i) => i.state === "running" && POOL[i.name]);
    if (!live.length) return;
    const i = live[rnd(0, live.length)], [lv, tx] = POOL[i.name][rnd(0, POOL[i.name].length)];
    if (lv === "wrn" && Math.random() < 0.6) return;
    addLog(i.id, lv, fill(tx));
  }, 1400);

  /* ───────── lifecycle (start passes the resolved port to the process) ───────── */
  const setState = (i, state, extra = {}) => {
    Object.assign(i, { state, ...extra });
    if (state === "running") i.since = R.now();
    R.changed();
  };
  R.holderOf = (port, self) => {
    if (!port) return null;
    const o = Object.values(I).find((x) => x !== self && R.active(x.state) && (x.runPort ?? R.portOf(x)) === port);
    if (o) return { name: o.name, where: o.wtLabel, id: o.id };
    return S.external[port] ? { name: S.external[port], where: null, id: null } : null;
  };
  /** Busy now, or already given to another app (so two review stacks can run side by side later). */
  R.taken = (port, self) => !!R.holderOf(port, self) || Object.values(I).some((x) => x !== self && R.portOf(x) === port);
  R.freePort = (from, self) => {
    let p = from + 1;
    while (R.taken(p, self)) p++;
    return p;
  };
  R.app = {
    async start(id) {
      const i = I[id];
      if (!i || R.active(i.state)) return;
      const port = R.portOf(i), holder = R.holderOf(port, i);
      if (holder) {
        i.conflict = { port, holder, free: R.freePort(port, i) };
        addLog(id, "sys", `Not started: port ${port} is in use by ${holder.name}${holder.where ? " @ " + holder.where : ""}`);
        return R.changed();
      }
      i.conflict = null;
      const built = i.kind === "dotnet-run" || i.kind === "iis-express";
      if (built) {
        setState(i, "building");
        addLog(id, "sys", i.kind === "iis-express" ? `Building ${i.name} @ ${i.wtLabel} (MSBuild · Debug)…` : `> dotnet build ${i.proj} -nologo`);
        await sleep(rnd(1300, 2100));
        if (i.state !== "building") return;
        if (i.kind === "iis-express") addLog(id, "sys", `Build succeeded in ${(rnd(42, 61) / 10).toFixed(1)} s`);
      }
      setState(i, "starting", { runPort: port });
      addLog(id, "sys", `> ${cmdOf(i, port)}`);
      await sleep(rnd(700, 1200));
      if (i.state !== "starting") return;
      addLog(id, "inf", upLine(i, port));
      setState(i, "running");
    },
    async stop(id) {
      const i = I[id];
      if (!i || !R.active(i.state) || i.state === "stopping") return;
      setState(i, "stopping");
      await sleep(600);
      addLog(id, "sys", `${i.name} stopped`);
      setState(i, "idle", { runPort: null });
    },
    open(id) {
      const i = I[id], p = i.runPort ?? R.portOf(i);
      R.toast(`Opened ${i.scheme || "http"}://localhost:${p} in the browser`, { icon: "ph-globe" });
    },
  };
  /** hub_start_stack: every app at once; apps already running (a shared main checkout) are reused. */
  R.startStack = (w, only) => {
    const st = R.stack(w);
    if (!st) return;
    const items = st.items.filter((i) => !only || only.includes(i.name));
    items.forEach((i) => (i.conflict = null));
    items.forEach((i) => R.app.start(i.id));
    return items;
  };
  /** hub_stop_stack: a shared app keeps running while another worktree's stack still has apps up. */
  R.stopStack = (w) => {
    const st = R.stack(w);
    if (!st) return;
    const kept = [];
    for (const i of st.items) {
      i.conflict = null;
      const others = R.usersOf(i).filter((o) => o !== w && R.stack(o).items.some((x) => x !== i && x.from === "worktree" && R.active(x.state)));
      if (i.from === "main" && others.length && R.active(i.state)) kept.push(`${i.name} (${others.map((o) => o.label).join(", ")} uses it)`);
      else R.app.stop(i.id);
    }
    if (kept.length) R.toast(`Kept running: ${kept.join("; ")}`, { icon: "ph-info", kind: "warn", ms: 5000 });
  };
  /** hub_set_port: a worktree override, or back to the repo default. Takes effect at the next start. */
  R.setPort = (id, port, by = "ui") => {
    const i = I[id];
    if (port === i.defPort || port == null) delete S.ports[id];
    else S.ports[id] = port;
    i.conflict = null;
    addLog(id, by === "mcp" ? "mcp" : "sys", `${by === "mcp" ? "hub_set_port · " : ""}${i.name} port → ${R.portOf(i)}${R.overridden(i) ? ` (override for ${i.wtLabel}; repo default ${i.defPort})` : " (repo default)"}${R.active(i.state) ? " · restart to apply" : ""}`);
    R.changed();
  };
  R.adoptDetected = (w, chosen) => {
    const repo = Object.keys(w.co)[0];
    R.MANIFESTS[repo] = { name: `${repo[0].toUpperCase()}${repo.slice(1)}`, apps: chosen.map((d) => ({ repo: d.repo, app: d.app.name, ...(d.app.port ? { port: d.app.port } : {}) })), open: chosen.filter((d) => d.app.port).slice(0, 1).map((d) => d.app.name), fresh: true };
    R.changed();
  };
  R.manifestJson = (repo) => {
    const m = R.MANIFESTS[repo];
    return JSON.stringify({ name: m.name, apps: m.apps, open: m.open }, null, 2).replace(/\{\n\s+("repo": [^\n]+)\n\s+("app": [^\n]+?)(,\n\s+("port": \d+))?\n\s+\}/g, (_, a, b, __, c) => `{ ${a} ${b}${c ? " " + c : ""} }`);
  };

  /* ───────── log view (scoped to a worktree's stack). Selection copies; nothing is sent anywhere. ───────── */
  const TOK = /\b(GET|POST|PUT|DELETE)\b|→ (\d{3})|\((\d+ms)\)|\b(\w+)=([\w.\-]+)/g;
  const tint = (raw) => {
    let out = "", last = 0, m;
    TOK.lastIndex = 0;
    while ((m = TOK.exec(raw))) {
      out += esc(raw.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1]) out += `<span class="http">${m[1]}</span>`;
      else if (m[2]) out += `→ <span class="http ${+m[2] < 400 ? "ok" : "bad"}">${m[2]}</span>`;
      else if (m[3]) out += `(<span class="dur">${m[3]}</span>)`;
      else out += `<span class="kv">${esc(m[4])}=<b>${esc(m[5])}</b></span>`;
    }
    return out + esc(raw.slice(last));
  };
  const RANKLV = { dbg: 0, inf: 1, sys: 1, mcp: 1, wrn: 2, err: 3 };
  R.LogView = class {
    constructor(el, scope) {
      Object.assign(this, { el, scope, lvl: "all", q: "", hidden: new Set(), count: 0, lastSeq: 0, key: "", squash: true });
      el.classList.add("logv");
      el.innerHTML = `<div class="logv-bar"><label class="field"><i class="ph ph-magnifying-glass"></i><input placeholder="Filter this worktree's logs" aria-label="Filter logs"></label><div class="seg" role="group" aria-label="Level"><button data-l="all" aria-pressed="true">All</button><button data-l="wrn"><span class="ld w"></span>Warn+</button><button data-l="err"><span class="ld e"></span>Errors</button></div><button class="ib sm" data-sq aria-pressed="true" title="Squash repeated lines"><i class="ph ph-stack-simple"></i></button><span class="grow"></span><span class="count"></span></div><div class="sources"></div><div class="logw"><div class="log" tabindex="0" aria-label="Log lines"></div><div class="selbar"><span class="c"></span><button class="btn btn-quiet sm" data-sel="copy"><i class="ph ph-copy"></i>Copy</button><button class="ib sm" data-sel="clear" aria-label="Clear selection"><i class="ph ph-x"></i></button></div></div>`;
      this.log = $(".log", el);
      this.src = $(".sources", el);
      this.selbar = $(".selbar", el);
      $("input", el).oninput = (e) => ((this.q = e.target.value.toLowerCase()), this.update());
      $$(".seg button", el).forEach((b) => (b.onclick = () => {
        this.lvl = b.dataset.l;
        $$(".seg button", el).forEach((x) => x.setAttribute("aria-pressed", x === b));
        this.update();
      }));
      $("[data-sq]", el).onclick = (e) => {
        this.squash = !this.squash;
        e.currentTarget.setAttribute("aria-pressed", this.squash);
        this.update();
      };
      this.selbar.addEventListener("click", (e) => {
        const b = e.target.closest("[data-sel]");
        if (b?.dataset.sel === "copy") this.copySel();
        if (b?.dataset.sel === "clear") (S.sel.clear(), this.syncSel());
      });
      this.log.addEventListener("click", (e) => this.onRow(e));
      this.src.addEventListener("click", (e) => {
        const c = e.target.closest(".chip");
        if (!c) return;
        const id = c.dataset.inst;
        if (e.ctrlKey || e.metaKey) {
          const all = this.insts();
          const alone = all.every((x) => x === id || this.hidden.has(x)) && !this.hidden.has(id);
          this.hidden = alone ? new Set() : new Set(all.filter((x) => x !== id));
        } else this.hidden.has(id) ? this.hidden.delete(id) : this.hidden.add(id);
        this.update();
      });
      R.on("render", () => this.el.isConnected && this.update());
      this.update();
    }
    insts() {
      const sc = this.scope();
      return sc.filter((id) => I[id]);
    }
    vis() {
      const sc = new Set(this.scope()), q = this.q;
      const out = [];
      for (const l of S.logs) {
        if (!sc.has(l.inst) || this.hidden.has(l.inst)) continue;
        if (this.lvl !== "all" && (this.lvl === "wrn" ? RANKLV[l.level] < 2 : l.level !== "err")) continue;
        if (q && !l.text.toLowerCase().includes(q) && !I[l.inst].name.toLowerCase().includes(q)) continue;
        const prev = out[out.length - 1];
        if (this.squash && prev && prev.inst === l.inst && prev.text === l.text) { prev.times = (prev.times || 1) + 1; continue; }
        out.push({ ...l });
      }
      return out;
    }
    rowHTML(l, prev) {
      const i = I[l.inst], start = !prev || prev.inst !== l.inst;
      return `<div class="row l-${l.level}${start ? " run-start" : ""}${S.sel.has(l.seq) ? " sel" : ""}${l.seq > this.lastSeq && this.lastSeq ? " fresh" : ""}" data-seq="${l.seq}" style="--c:${i.color}"><span class="t">${R.hms(l.ts)}</span><span class="src">${start ? `${esc(i.name)} <span class="w">${esc(i.wtLabel === "main" ? "main" : i.wtLabel.replace("PAYMENT-", ""))}</span>` : ""}</span><span class="lv">${R.LV[l.level]}</span><span class="msg">${tint(l.text)}${l.times > 1 ? ` <span class="pill" style="height:16px">×${l.times}</span>` : ""}</span></div>`;
    }
    update() {
      const vis = this.vis(), sc = this.scope();
      const key = [this.lvl, this.q, this.squash, [...this.hidden].join(), sc.join(), S.logs[0]?.seq].join("|");
      const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60;
      const last = vis[vis.length - 1];
      if (key !== this.key || vis.length < this.count || (last && last.times !== this.lastTimes)) {
        this.key = key;
        this.log.innerHTML = vis.length ? vis.map((l, k) => this.rowHTML(l, vis[k - 1])).join("") : `<div class="none">No lines${this.q || this.lvl !== "all" ? " match" : " yet. Run the stack and its output shows up here"}.</div>`;
        this.count = vis.length;
      } else if (vis.length > this.count) {
        this.log.querySelector(".none")?.remove();
        this.log.insertAdjacentHTML("beforeend", vis.slice(this.count).map((l, k) => this.rowHTML(l, vis[this.count + k - 1])).join(""));
        this.count = vis.length;
      }
      this.lastTimes = last?.times;
      this.lastSeq = S.seq;
      if (atBottom) this.log.scrollTop = this.log.scrollHeight;
      this.syncChips();
      this.syncSel();
      $(".count", this.el).textContent = `${vis.length} lines · ${vis.filter((l) => l.level === "wrn").length} warn · ${vis.filter((l) => l.level === "err").length} err`;
    }
    syncChips() {
      const ids = this.insts();
      R.put(this.src, ids.map((id) => {
        const n = S.logs.filter((l) => l.inst === id), e = n.filter((l) => l.level === "err").length;
        return `<button class="chip${this.hidden.has(id) ? " off" : ""}" data-inst="${esc(id)}" style="--c:${I[id].color}" title="Click: hide/show · Ctrl+click: only this"><span class="cd"></span>${esc(I[id].name)} <span class="w">${esc(I[id].wtLabel === "main" ? "main" : "")}</span><span class="n">${n.length}</span>${e ? `<span class="n e">${e} err</span>` : ""}</button>`;
      }).join(""));
    }
    syncSel() {
      const n = [...S.sel].filter((s) => this.log.querySelector(`.row[data-seq="${s}"]`)).length;
      this.selbar.classList.toggle("on", n > 0);
      $(".c", this.selbar).textContent = `${n} line${n === 1 ? "" : "s"} selected`;
      this.log.querySelectorAll(".row").forEach((r) => r.classList.toggle("sel", S.sel.has(+r.dataset.seq)));
    }
    copySel() {
      const lines = S.logs.filter((l) => S.sel.has(l.seq));
      R.copy(lines.map((l) => `${R.hms(l.ts)} ${I[l.inst].name} ${R.LV[l.level]} ${l.text}`).join("\n"), `${lines.length} line${lines.length === 1 ? "" : "s"}`);
    }
    onRow(e) {
      const r = e.target.closest(".row");
      if (!r) return;
      const seq = +r.dataset.seq;
      if (e.shiftKey && this.anchor) {
        const rows = [...this.log.querySelectorAll(".row")].map((x) => +x.dataset.seq);
        const [a, b] = [rows.indexOf(this.anchor), rows.indexOf(seq)].sort((x, y) => x - y);
        rows.slice(a, b + 1).forEach((s) => S.sel.add(s));
      } else if (e.ctrlKey || e.metaKey) S.sel.has(seq) ? S.sel.delete(seq) : S.sel.add(seq);
      else if (S.sel.size === 1 && S.sel.has(seq)) S.sel.clear();
      else (S.sel.clear(), S.sel.add(seq));
      this.anchor = seq;
      this.syncSel();
    }
    selectWhere(fn) {
      S.sel.clear();
      S.logs.filter(fn).forEach((l) => S.sel.add(l.seq));
      this.syncSel();
      this.log.querySelector(".row.sel")?.scrollIntoView({ block: "center" });
    }
  };

  /* ───────── toasts, copy, theme ───────── */
  R.toast = (text, { kind = "", icon = "ph-check-circle", ms = 3600 } = {}) => {
    let host = $(".toasts");
    if (!host) {
      host = document.createElement("div");
      host.className = "toasts";
      $(".frame").appendChild(host);
    }
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.setAttribute("role", "status");
    t.innerHTML = `<i class="ph-fill ${icon}"></i><span>${esc(text)}</span>`;
    host.appendChild(t);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => (t.classList.add("out"), setTimeout(() => t.remove(), 320)), ms);
  };
  R.copy = (text, what) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    R.lastCopied = text;
    R.toast(`${what} copied`, { icon: "ph-copy" });
  };
  const stored = (() => { try { return localStorage.getItem("mock-theme"); } catch { return null; } })();
  document.documentElement.dataset.theme = stored || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  R.toggleTheme = () => {
    const r = document.documentElement;
    r.classList.add("theming");
    r.dataset.theme = r.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("mock-theme", r.dataset.theme); } catch {}
    setTimeout(() => r.classList.remove("theming"), 450);
    R.changed();
  };
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") (e.preventDefault(), R.toggleTheme());
  });
})();
