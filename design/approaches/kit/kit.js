/* Spawner × T3 Code mockup kit, shared by a-cockpit, b-mission-control and c-stage.
   One data set, one simulated backend, one simulated `t3` CLI, so the three layouts are comparable.

   Two layers on purpose:
   - TRUTH (T): what the T3 server knows. Agent runs mutate it on their own clock.
   - VIEW (S.threads): what Spawner last read with `t3 thread list/show`. The UI only ever renders this,
     so every T3 change shows up on the next poll, with its age, exactly as the real thing would. */
(() => {
  const K = (window.K = {});
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));
  Object.assign(K, { $, $$, esc, sleep });

  /* ───────── bus ───────── */
  const subs = {};
  K.on = (ev, fn) => (subs[ev] ||= []).push(fn);
  K.emit = (ev, d) => (subs[ev] || []).forEach((f) => f(d));
  let dirty = false;
  K.changed = () => {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(() => ((dirty = false), K.emit("render")));
  };
  /** Replaces an element's HTML only when it changed, and keeps typed text, focus and scroll across the swap. */
  const keyOf = (n) => {
    const d = n?.dataset || {};
    if (d.compose) return `[data-compose="${d.compose}"]`;
    if (d.newthread) return `[data-newthread="${d.newthread}"]`;
    if (n?.id) return `#${CSS.escape(n.id)}`;
    const k = d.k ? "data-k" : d.a ? "data-a" : null;
    if (!k) return null;
    const ref = ["id", "th", "wt"].find((x) => d[x]);
    return `[${k}="${d.k || d.a}"]${ref ? `[data-${ref}="${CSS.escape(d[ref])}"]` : ""}`;
  };
  K.put = (el, html) => {
    if (!el || el._html === html) return;
    const typed = [...el.querySelectorAll("textarea, input[type=text]")].filter((t) => t.value).map((t) => [keyOf(t), t.value]);
    const f = el.contains(document.activeElement) ? document.activeElement : null;
    const fk = keyOf(f), caret = f?.selectionStart;
    const scrolls = [...el.querySelectorAll("[data-scroll]")].map((s) => [s.dataset.scroll, s.scrollTop, s.scrollHeight - s.scrollTop - s.clientHeight < 30]);
    el.innerHTML = html;
    el._html = html;
    for (const [k, v] of typed) if (k) { const t = el.querySelector(k); if (t) t.value = v; }
    for (const [k, top, bottom] of scrolls) { const s = el.querySelector(`[data-scroll="${k}"]`); if (s) s.scrollTop = bottom ? s.scrollHeight : top; }
    el.querySelectorAll("[data-scroll]").forEach((s) => !scrolls.some(([k]) => k === s.dataset.scroll) && (s.scrollTop = s.scrollHeight));
    if (fk) {
      const t = el.querySelector(fk);
      if (t) {
        t.focus({ preventScroll: true });
        try { if (caret != null) t.setSelectionRange(caret, caret); } catch {}
      }
    }
  };

  /* ───────── clock: the demo starts at 09:41 today ───────── */
  const t0 = Date.now();
  const base = new Date();
  base.setHours(9, 41, 12, 120);
  K.now = () => base.getTime() + (Date.now() - t0);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  K.hms = (ts) => {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  };
  K.hm = (ts) => {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  K.ago = (ts) => {
    const s = Math.max(0, Math.round((K.now() - ts) / 1000));
    if (s < 5) return "just now";
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    const d = new Date(ts);
    return new Date(K.now()).toDateString() === d.toDateString() ? `today ${K.hm(ts)}` : `yesterday ${K.hm(ts)}`;
  };
  K.dur = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
  /** Relative times live in their own spans and are refreshed by a ticker, so nothing re-renders every second. */
  K.agoSpan = (ts) => `<span data-ago="${ts}">${K.ago(ts)}</span>`;
  K.elapsedSpan = (ts) => `<span data-elapsed="${ts}">0 s</span>`;
  setInterval(() => {
    $$("[data-ago]").forEach((e) => (e.textContent = K.ago(+e.dataset.ago)));
    $$("[data-elapsed]").forEach((e) => {
      const s = Math.floor((Date.now() - +e.dataset.elapsed) / 1000);
      e.textContent = s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
    });
  }, 1000);

  /* ───────── data: worktree > project (repo checkout) > app, as Spawner scans it ───────── */
  const HOME = "C:\\Users\\bruno";
  const T3WT = `${HOME}\\.t3\\worktrees`;
  const app = (key, name, kind, port, extra = {}) => ({ key, name, kind, port, ...extra });
  const WTS = [
    {
      id: "PAYMENT-9986", branch: "feat/refund-partial", root: "C:\\dev\\PAYMENT-9986", t3project: "C:\\dev\\PAYMENT-9986",
      projects: [
        { repo: "cadence", apps: [app("billing-api", "Billing API", "dotnet-run", 5050), app("billing-worker", "Billing Worker", "dotnet-run", null)] },
        { repo: "cibi", apps: [app("account-web", "Account Web", "iis-express", 5003)] },
      ],
    },
    {
      id: "PAYMENT-9987", branch: "fix/webhook-retry", root: "C:\\dev\\PAYMENT-9987", t3project: "C:\\dev\\PAYMENT-9987",
      projects: [
        { repo: "cibi", apps: [app("account-web", "Account Web", "iis-express", 5003, { breaks: true })] },
        { repo: "cadence", apps: [app("billing-api", "Billing API", "dotnet-run", 5050)] },
      ],
    },
    {
      id: "docs-search", branch: "t3/docs-search", root: null, t3project: "C:\\Projects\\waypoint", t3made: true,
      projects: [{ repo: "waypoint", path: `${T3WT}\\waypoint\\t3-docs-search`, apps: [app("docs", "Docs", "vite", null, { learn: 4321 })] }],
    },
    {
      id: "main", main: true, label: "Main checkouts", root: null, t3project: null,
      projects: [
        { repo: "spawner", path: "C:\\Projects\\spawner", apps: [app("web", "Spawner web", "vite", null, { learn: 1420 }), app("tauri", "Spawner desktop", "tauri", null)] },
        { repo: "hopper", path: "C:\\Projects\\hopper", apps: [app("tauri", "Hopper desktop", "tauri", null)] },
        { repo: "cadence", path: "C:\\dev\\cadence", apps: [app("billing-api", "Billing API", "dotnet-run", 5050)] },
        { repo: "cibi", path: "C:\\dev\\cibi", apps: [app("account-web", "Account Web", "iis-express", 5003)] },
        { repo: "waypoint", path: "C:\\Projects\\waypoint", apps: [app("docs", "Docs", "vite", null, { learn: 4321 })] },
      ],
    },
  ];
  const COLORS = ["var(--i1)", "var(--i2)", "var(--i3)", "var(--i4)", "var(--i5)"];
  const I = {}; // instances by id
  let ci = 0;
  for (const w of WTS) {
    w.label ||= w.id;
    w.short = w.main ? "main" : w.id.startsWith("PAYMENT-") ? w.id.slice(8) : w.id;
    for (const p of w.projects) {
      p.path ||= `${w.root}\\${p.repo}`;
      p.branch = w.main ? "main" : w.branch;
      p.ids = p.apps.map((a) => {
        const id = `${w.id}/${p.repo}::${a.key}`;
        I[id] = { id, wt: w.id, repo: p.repo, path: p.path, ...a, state: "idle", port: a.port, learned: null, color: COLORS[ci++ % 5], since: 0, exit: null, fails: 0 };
        return id;
      });
    }
    w.ids = w.projects.flatMap((p) => p.ids);
  }
  K.WTS = WTS;
  K.I = I;
  K.wt = (id) => WTS.find((w) => w.id === id);
  K.portOf = (i) => i.port ?? i.learned;
  const ID = { api: "PAYMENT-9986/cadence::billing-api", worker: "PAYMENT-9986/cadence::billing-worker", acc: "PAYMENT-9987/cibi::account-web", api87: "PAYMENT-9987/cadence::billing-api", docs: "docs-search/waypoint::docs" };
  K.ID = ID;

  /* ───────── state ───────── */
  const S = (K.S = {
    logs: [], seq: 0,
    sel: new Set(),
    threads: {}, // VIEW: what Spawner last read from T3
    seen: {}, // projectPath -> { at, error }
    outbox: {}, // threadId -> [{ id, text, state, err, lines }]
    fixes: {}, // instance id -> { threadId | null, phase, err, startedAt }
    mode: "ok", // ok | missing | down | slow
    unreg: false, // PAYMENT-9987 removed from T3, for the "project not registered" case
    calls: [],
    poll: { next: 0, interval: 3000, fails: 0, inflight: false, lastOk: 0, lastErr: null },
    alert: null,
  });

  /* ───────── logs ───────── */
  const LV = { dbg: "DBG", inf: "INF", wrn: "WRN", err: "ERR", sys: "hub", agent: "MCP" };
  K.LV = LV;
  function addLog(inst, level, text, ts = K.now()) {
    S.logs.push({ seq: ++S.seq, inst, level, text, ts });
    if (S.logs.length > 900) S.logs.splice(0, 300);
    K.changed();
  }
  K.addLog = addLog;
  // Seed: four minutes of PAYMENT-9986 and the failed build in PAYMENT-9987.
  (() => {
    let t = K.now() - 4 * 60_000;
    const at = (ms) => (t += ms);
    const L = (i, lv, tx, ms = rnd(300, 1400)) => addLog(i, lv, tx, at(ms));
    L(ID.api, "sys", "> dotnet run --project src/Cadence.Billing.Api", 0);
    L(ID.worker, "sys", "> dotnet run --project src/Cadence.Billing.Worker", 260);
    L(ID.api, "inf", "Now listening on: http://localhost:5050", 5400);
    L(ID.api, "inf", "Application started. Hosting environment: Development");
    L(ID.worker, "inf", 'Outbox listening on channel "billing.events" (poll=500ms)');
    L(ID.api, "inf", "GET /api/invoices/8842 → 200 (41ms)", 9000);
    L(ID.api, "inf", "POST /api/payments/refund → 202 (118ms) refundId=rf_8842");
    L(ID.worker, "inf", "Outbox: dispatched 12 events in 86ms");
    L(ID.api, "wrn", "Asaas webhook retry 2/5 for payment pay_3391 (HTTP 502)", 7000);
    L(ID.acc, "sys", "Building Account Web @ PAYMENT-9987 (MSBuild · Debug)…", 12000);
    L(ID.acc, "inf", "Cibi.Payments -> C:\\dev\\PAYMENT-9987\\cibi\\src\\Cibi.Payments\\bin\\Debug\\Cibi.Payments.dll", 3900);
    L(ID.acc, "err", "Services\\AsaasService.cs(48,17): error CS0246: The type or namespace name 'IAsaasGateway' could not be found (are you missing a using directive or an assembly reference?)", 1700);
    L(ID.acc, "err", "Services\\AsaasService.cs(212,31): error CS0246: The type or namespace name 'IAsaasGateway' could not be found (are you missing a using directive or an assembly reference?)", 4);
    L(ID.acc, "sys", "Build FAILED · 2 errors, 0 warnings · 6.1 s · Account Web stopped (exit 1)", 300);
    L(ID.worker, "inf", "Outbox: dispatched 3 events in 31ms", 20000);
    L(ID.api, "inf", "POST /api/payments/refund → 500 (203ms) refundId=rf_8851", 15000);
    L(ID.api, "err", "Unhandled exception processing refund rf_8851: System.InvalidOperationException: Refund exceeds captured amount (requested=250.00, captured=199.90)", 3);
    L(ID.api, "err", "   at Cadence.Billing.Refunds.RefundService.ApplyAsync(RefundCommand cmd) in RefundService.cs:line 118", 1);
    L(ID.api, "err", "   at Cadence.Billing.Api.Controllers.PaymentsController.Refund(RefundRequest req) in PaymentsController.cs:line 64", 1);
    L(ID.api, "inf", "GET /api/invoices/8851 → 200 (44ms)", 9000);
    L(ID.api, "wrn", "Slow query 812ms: SELECT * FROM PaymentAttempts WHERE ContractId = @p0", 8000);
    L(ID.worker, "inf", "Outbox: dispatched 7 events in 52ms", 11000);
    L(ID.api, "inf", "GET /api/invoices/8855 → 200 (36ms)", 14000);
    Object.assign(I[ID.api], { state: "running", since: K.now() - 230_000 });
    Object.assign(I[ID.worker], { state: "running", since: K.now() - 229_000 });
    Object.assign(I[ID.acc], { state: "failed", exit: "build failed (exit code 1)", fails: 1 });
    Object.assign(I[ID.docs], { state: "idle", since: K.now() - 3 * 3600_000 });
  })();
  const POOL = {
    "billing-api": [["inf", "GET /api/invoices/{n} → 200 ({ms}ms)"], ["inf", "POST /api/payments/refund → 202 ({ms}ms) refundId=rf_{n}"], ["dbg", "Resolved IRefundPolicy from scope policy=Standard"], ["inf", "GET /api/contracts/{n}/attempts → 200 ({ms}ms)"], ["wrn", "Asaas webhook retry 3/5 for payment pay_{n} (HTTP 502)"]],
    "billing-worker": [["inf", "Outbox: dispatched {k} events in {ms}ms"], ["inf", "Heartbeat ok lag=0.{k}s"], ["wrn", "Outbox lag {k}.1s above threshold 3s"]],
    "account-web": [["inf", "GET /billing/overview → 200 ({ms}ms)"], ["inf", "GET /account/invoices → 200 ({ms}ms)"], ["dbg", "Session refreshed for customer c_{n}"]],
    docs: [["inf", "[200] /guides/search {ms}ms"], ["inf", "[200] /reference/cli {ms}ms"], ["dbg", "[vite] hmr update /src/components/Search.astro"]],
    web: [["dbg", "[vite] hmr update /src/App.tsx"]],
    tauri: [["inf", "Running `target\\debug\\app.exe`"]],
  };
  const fill = (s) => s.replace("{n}", rnd(8856, 9400)).replace("{ms}", rnd(22, 190)).replace("{k}", rnd(1, 9));
  setInterval(() => {
    const live = Object.values(I).filter((i) => i.state === "running" && POOL[i.key]);
    if (!live.length) return;
    const i = live[rnd(0, live.length)];
    const [lv, tx] = POOL[i.key][rnd(0, POOL[i.key].length)];
    if (lv === "wrn" && Math.random() < 0.6) return;
    addLog(i.id, lv, fill(tx));
  }, 1300);

  /* ───────── simulated Spawner backend: start / stop / restart (the existing commands) ───────── */
  const active = (s) => ["building", "starting", "running", "stopping"].includes(s);
  K.active = active;
  function setState(i, state, extra = {}) {
    Object.assign(i, { state, ...extra });
    if (state === "running") i.since = K.now();
    K.changed();
  }
  K.app = {
    async start(id, force = false) {
      const i = I[id];
      if (!i || active(i.state)) return;
      const clash = i.port && Object.values(I).find((o) => o.id !== id && active(o.state) && K.portOf(o) === i.port);
      if (clash && !force) {
        S.alert = { text: `Can't start ${i.name} @ ${K.wt(i.wt).label}: port ${i.port} is already in use by ${clash.name} @ ${K.wt(clash.wt).label}.`, act: { label: `Stop that one and start`, run: async () => { S.alert = null; await K.app.stop(clash.id); K.app.start(id); } } };
        K.changed();
        return;
      }
      S.alert = null;
      const w = K.wt(i.wt);
      const built = i.kind === "dotnet-run" || i.kind === "iis-express";
      if (built) {
        setState(i, "building");
        addLog(id, "sys", i.kind === "iis-express" ? `Building ${i.name} @ ${w.label} (MSBuild · Debug)…` : `> dotnet run --project src/${i.repo === "cadence" ? "Cadence.Billing." + (i.key === "billing-api" ? "Api" : "Worker") : "Cibi.Account.Web"}`);
        await sleep(1700);
        if (i.state !== "building") return;
        if (i.breaks) {
          addLog(id, "err", "Services\\AsaasService.cs(48,17): error CS0246: The type or namespace name 'IAsaasGateway' could not be found (are you missing a using directive or an assembly reference?)");
          addLog(id, "err", "Services\\AsaasService.cs(212,31): error CS0246: The type or namespace name 'IAsaasGateway' could not be found (are you missing a using directive or an assembly reference?)");
          addLog(id, "sys", `Build FAILED · 2 errors, 0 warnings · 5.8 s · ${i.name} stopped (exit 1)`);
          i.fails++;
          return setState(i, "failed", { exit: "build failed (exit code 1)" });
        }
        if (i.kind === "iis-express") addLog(id, "sys", `Build succeeded in 5.2 s · iisexpress /path:${i.path}\\src\\Cibi.Account.Web /port:${i.port}`);
      }
      setState(i, "starting");
      if (i.kind === "vite") addLog(id, "sys", `> pnpm run dev`);
      if (i.kind === "tauri") addLog(id, "sys", `> pnpm run tauri dev`);
      await sleep(900);
      if (i.state !== "starting") return;
      if (i.learn) {
        i.learned = i.learn;
        addLog(id, "inf", `VITE v8.3.4  ready in ${rnd(380, 700)} ms`);
        addLog(id, "inf", `➜  Local:   http://localhost:${i.learn}/`);
      } else if (i.port) addLog(id, "inf", i.kind === "iis-express" ? "IIS Express is running." : `Now listening on: http://localhost:${i.port}`);
      else addLog(id, "inf", i.kind === "tauri" ? "Running `target\\debug\\app.exe`" : 'Outbox listening on channel "billing.events" (poll=500ms)');
      delete S.fixes[id];
      setState(i, "running", { exit: null });
    },
    async stop(id) {
      const i = I[id];
      if (!i || !active(i.state) || i.state === "stopping") return;
      setState(i, "stopping");
      await sleep(650);
      addLog(id, "sys", `${i.name} stopped`);
      setState(i, "idle", { learned: null });
    },
    async restart(id) {
      await K.app.stop(id);
      await K.app.start(id);
    },
    open(id) {
      const p = K.portOf(I[id]);
      if (p) K.toast(`Opened http://localhost:${p} in the browser`, { icon: "ph-globe" });
    },
  };

  /* ───────── TRUTH: the T3 server ───────── */
  const T = (K.T = { projects: {}, threads: {} });
  const ENV = "9e78efd4-818c-4920-abba-6f42ac34118e";
  const reg = (path, title) => (T.projects[path.toLowerCase()] = { id: "p-" + Math.random().toString(36).slice(2, 10), path, title });
  reg("C:\\dev\\PAYMENT-9986", "PAYMENT-9986");
  reg("C:\\dev\\PAYMENT-9987", "PAYMENT-9987");
  reg("C:\\Projects\\waypoint", "waypoint");
  reg("C:\\Projects\\spawner", "spawner");
  reg("C:\\Projects\\hopper", "hopper");
  let tn = 0;
  function mkThread(o) {
    const id = o.threadId || `${(0x2eeb68c7 + ++tn * 7919).toString(16)}-7e90-4bfd-a893-${String(tn).padStart(12, "0")}`;
    const th = { threadId: id, status: "completed", pending: 0, ask: null, settled: false, settledAt: null, provider: "claude", model: "claude-opus-5-5", items: 2, pr: null, createdBy: "user", createdAt: K.now(), updatedAt: K.now(), messages: [], worktreePath: null, branch: null, ...o };
    th.link = `https://app.t3.codes/threads/${ENV}/${id}`;
    T.threads[id] = th;
    return th;
  }
  const say = (th, role, text, via) => {
    th.messages.push({ role, text, runId: `run:${th.threadId.slice(0, 8)}:${th.messages.length}`, via });
    th.updatedAt = K.now();
    th.items += role === "assistant" ? rnd(3, 7) : 1;
  };
  const tRefund = mkThread({
    title: "Partial refunds for captured payments", projectPath: "C:\\dev\\PAYMENT-9986", branch: "feat/refund-partial", status: "running", items: 38, createdAt: K.now() - 49 * 60_000,
  });
  tRefund.messages = [
    { role: "user", text: "Add partial refunds in cadence: RefundService should accept any amount up to what was captured, write one ledger entry per partial refund, and keep the Billing API contract as it is." },
    { role: "assistant", text: "Plan:\n1. `RefundCommand` gets an `Amount`; full refund stays the default.\n2. `RefundPolicy.Partial` checks the amount against `CapturedAmount`.\n3. One `LedgerEntry` per partial refund.\n4. Tests in `RefundServiceTests`." },
    { role: "assistant", text: "Steps 1–3 are in. Writing the tests for the over-capture case now." },
  ];
  tRefund.updatedAt = K.now() - 40_000;
  const tSpike = mkThread({ title: "Spike: refund ledger shape", projectPath: "C:\\dev\\PAYMENT-9986", branch: "feat/refund-partial", status: "completed", settled: true, items: 22, createdAt: K.now() - 26 * 3600_000 });
  tSpike.messages = [{ role: "user", text: "Sketch how a partial refund should look in the ledger." }, { role: "assistant", text: "One `LedgerEntry` per refund, negative amount, `ParentEntryId` pointing at the capture. Written up in docs/ledger.md." }];
  tSpike.updatedAt = tSpike.settledAt = K.now() - 23 * 3600_000;
  const tDocs = mkThread({
    title: "Add search to the docs site", projectPath: "C:\\Projects\\waypoint", worktreePath: `${T3WT}\\waypoint\\t3-docs-search`, branch: "t3/docs-search", status: "completed", settled: true, items: 64, createdAt: K.now() - 3 * 3600_000,
    pr: { number: 212, title: "Add Pagefind search to the docs", state: "open", url: "https://github.com/uFleck/waypoint/pull/212" },
  });
  tDocs.messages = [{ role: "user", text: "Add full-text search to the docs site. Static only, no server." }, { role: "assistant", text: "Added Pagefind: indexes at build, `Search.astro` in the header, 14 kB of JS. Opened PR #212 and asked for review." }];
  tDocs.updatedAt = tDocs.settledAt = K.now() - 29 * 60_000;
  K.threadIds = { refund: tRefund.threadId, spike: tSpike.threadId, docs: tDocs.threadId };

  // The refund thread is mid-run when the demo opens.
  (async () => {
    for (let k = 0; k < 9 && tRefund.status === "running"; k++) {
      await sleep(rnd(5000, 7000));
      tRefund.items += rnd(2, 5);
      tRefund.updatedAt = K.now();
    }
    if (tRefund.status !== "running") return;
    say(tRefund, "assistant", "Partial refunds are in: `RefundPolicy.Partial`, one ledger entry per refund. `RefundServiceTests`: 48 passed. Billing API needs a restart to load it.");
    tRefund.status = "completed";
    queued(tRefund);
  })();

  /** A message sent to a busy thread waits for its next turn (what `t3 thread send` does), then gets an answer. */
  async function queued(th) {
    const next = th.queue?.shift();
    if (!next) return;
    th.status = "running";
    th.updatedAt = K.now();
    await sleep(6000);
    th.items += 6;
    await sleep(4000);
    say(th, "assistant", next.reply);
    th.status = "completed";
    queued(th);
  }
  function replyFor(th, text) {
    if (/rf_8851|captured amount/.test(text))
      return "rf_8851 asked for 250.00 against 199.90 captured, so the old guard threw. With partial refunds that request now returns 422 `amount_exceeds_captured` instead of a 500. Restart Billing API and retry the refund to check.";
    if (th.title.startsWith("Fix")) return "Checked again: Account Web builds with 0 errors. Retry it in Spawner.";
    return "Read it. Nothing in that needs a change on this branch; I left the code as it is.";
  }
  const fixScript = async (th, inst) => {
    await sleep(3500);
    say(th, "assistant", "`IAsaasGateway` is declared in `Cibi.Payments` (src/Cibi.Payments/Gateways/IAsaasGateway.cs), but `Cibi.Account.Web.csproj` has no reference to that project. Adding it.");
    await sleep(3500);
    th.pending = 1;
    th.ask = { kind: "permission", command: "dotnet add src/Cibi.Account.Web/Cibi.Account.Web.csproj reference src/Cibi.Payments/Cibi.Payments.csproj" };
    th.updatedAt = K.now();
    while (th.pending) await sleep(300);
    th.items += 3;
    await sleep(3200);
    I[inst].breaks = false;
    say(th, "assistant", "Added the project reference and ran `dotnet build`: 0 errors, 0 warnings. Changed `src/Cibi.Account.Web/Cibi.Account.Web.csproj` (+3 lines). I didn't start the app; retry it in Spawner.");
    th.status = "completed";
    queued(th);
  };
  /** What a user does in the T3 window, which Spawner can only observe. */
  K.approveInT3 = () => {
    const th = Object.values(T.threads).find((t) => t.pending);
    if (!th) return false;
    th.pending = 0;
    th.ask = null;
    th.updatedAt = K.now();
    S.poll.next = 0;
    return true;
  };

  /* ───────── the `t3` CLI, simulated with real latency, timeouts and failures ───────── */
  const TIMEOUT = 10_000;
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  K.cmd = (args) => "t3 " + args.map(q).join(" ");
  class CliError extends Error {
    constructor(kind, msg) {
      super(msg);
      this.kind = kind;
    }
  }
  const projectAt = (path) => {
    if (S.unreg && path.toLowerCase() === "c:\\dev\\payment-9987") return null;
    return T.projects[path.toLowerCase()];
  };
  const pub = (th) => ({ ...th, messages: th.messages.map((m) => ({ ...m })), ask: th.ask && { ...th.ask }, queue: undefined });
  const handlers = {
    "thread list"([, , , path]) {
      const p = projectAt(path);
      if (!p) throw new CliError("unregistered", `No T3 Code project matches '${path}'. Pass a project id or a path inside a project.`);
      return Object.values(T.threads).filter((t) => t.projectPath.toLowerCase() === path.toLowerCase()).map(pub);
    },
    "thread show"([, , id]) {
      return pub(T.threads[id]);
    },
    "thread start"([, , path], { stdin, title, inst }) {
      if (!projectAt(path)) throw new CliError("unregistered", `No T3 Code project matches '${path}'. Pass a project id or a path inside a project.`);
      const w = WTS.find((x) => x.t3project?.toLowerCase() === path.toLowerCase());
      const th = mkThread({ title, projectPath: path, branch: w?.branch ?? null, status: "running", items: 1 });
      th.messages.push({ role: "user", text: stdin, via: "spawner" });
      if (inst) fixScript(th, inst);
      else
        (async () => {
          await sleep(7000);
          say(th, "assistant", "Read the request and the worktree. I'll answer here; ask me to run anything through Spawner's MCP tools if you want it started.");
          th.status = "completed";
          queued(th);
        })();
      return { threadId: th.threadId };
    },
    "thread send"([, , id], { stdin }) {
      const th = T.threads[id];
      th.messages.push({ role: "user", text: stdin, via: "spawner" });
      th.items++;
      th.updatedAt = K.now();
      th.settled = false;
      (th.queue ||= []).push({ reply: replyFor(th, stdin) });
      const busy = th.status === "running";
      if (!busy) queued(th);
      return { threadId: id, queued: busy };
    },
    "project add"([, , path], { title }) {
      reg(path, title);
      if (path.toLowerCase() === "c:\\dev\\payment-9987") S.unreg = false;
      return { ok: true };
    },
    "app"([, path]) {
      if (S.waitingApproval) setTimeout(() => K.approveInT3() && K.toast("Approved in T3 Code · Spawner sees it on the next check", { kind: "agent", icon: "ph-check-circle" }), 2600);
      return { opened: path };
    },
    "--version"() {
      return "t3 v0.1.11-nightly.20261117.4825";
    },
  };
  async function cli(args, opts = {}) {
    const call = { id: Math.random(), cmd: K.cmd(args) + (opts.stdin ? "  (message on stdin)" : ""), started: Date.now(), state: "run", ms: 0 };
    S.calls.unshift(call);
    S.calls.length = Math.min(S.calls.length, 8);
    K.changed();
    try {
      if (S.mode === "missing") {
        await sleep(40);
        throw new CliError("missing", "'t3' is not recognized as an internal or external command (not on PATH, not in %USERPROFILE%\\.t3\\bin).");
      }
      const lat = S.mode === "slow" ? (opts.poll ? 11_000 : 6_200) : rnd(380, 900);
      await sleep(Math.min(lat, TIMEOUT));
      if (lat >= TIMEOUT) throw new CliError("timeout", `${call.cmd.split("  ")[0]} did not answer in ${TIMEOUT / 1000} s and was stopped.`);
      if (S.mode === "down" && args[0] !== "--version") throw new CliError("down", "T3 Code is not running: nothing answers at http://127.0.0.1:3773 (from server-runtime.json, pid 32260).");
      const key = args[0] === "app" || args[0] === "--version" ? args[0] : `${args[0]} ${args[1]}`;
      const out = handlers[key](args, opts);
      call.state = "ok";
      return out;
    } catch (e) {
      call.state = "bad";
      call.err = e.message;
      throw e;
    } finally {
      call.ms = Date.now() - call.started;
      K.changed();
    }
  }
  K.cli = cli;

  /* ───────── VIEW: polling `t3 thread list` (+ `show` for active threads) ───────── */
  const norm = (p) => (p || "").toLowerCase();
  K.wtOfThread = (th) => {
    if (th.worktreePath) return WTS.find((w) => w.projects.some((p) => norm(p.path) === norm(th.worktreePath)))?.id;
    return WTS.find((w) => norm(w.t3project) === norm(th.projectPath) && !w.t3made)?.id;
  };
  K.uiStatus = (th) => (!th ? "none" : th.starting ? "starting" : th.pending ? "waiting" : th.status === "running" ? "running" : th.settled ? "settled" : th.status === "failed" ? "failed" : "completed");
  const RANK = { waiting: 0, starting: 1, running: 1, failed: 2, completed: 3, settled: 4 };
  K.threadsOf = (wtId) => Object.values(S.threads).filter((t) => t.wt === wtId).sort((a, b) => RANK[K.uiStatus(a)] - RANK[K.uiStatus(b)] || b.updatedAt - a.updatedAt);
  K.lead = (wtId) => K.threadsOf(wtId)[0] || null;
  const polled = () => [...new Set(WTS.map((w) => w.t3project).filter(Boolean))];
  /** Whether T3 can be used for this worktree right now, and if not, why. */
  K.t3For = (wtId) => {
    const w = K.wt(wtId);
    if (S.mode === "missing") return { ok: false, kind: "missing" };
    if (S.mode === "down") return { ok: false, kind: "down" };
    if (!w?.t3project) return { ok: false, kind: "none" };
    if (S.seen[norm(w.t3project)]?.error?.kind === "unregistered" || (S.unreg && wtId === "PAYMENT-9987")) return { ok: false, kind: "unregistered", path: w.t3project };
    if (S.mode === "slow") return { ok: true, kind: "slow" };
    return { ok: true, kind: "ok" };
  };
  async function pollOnce() {
    const P = S.poll;
    P.inflight = true;
    K.changed();
    let failed = null;
    const lists = await Promise.allSettled(polled().map((path) => cli(["thread", "list", "--project", path, "--json"], { poll: true }).then((items) => ({ path, items }))));
    for (const [k, r] of lists.entries()) {
      const path = polled()[k];
      if (r.status === "fulfilled") {
        S.seen[norm(path)] = { at: K.now() };
        for (const th of r.value.items) {
          const prev = S.threads[th.threadId];
          S.threads[th.threadId] = { ...th, wt: K.wtOfThread(th), fetchedAt: K.now() };
          if (prev && K.uiStatus(prev) !== K.uiStatus(th)) K.emit("thread-changed", { id: th.threadId, from: K.uiStatus(prev), to: K.uiStatus(th) });
        }
      } else if (r.reason.kind === "unregistered") S.seen[norm(path)] = { at: K.now(), error: { kind: "unregistered", msg: r.reason.message } };
      else failed = r.reason;
    }
    S.waitingApproval = Object.values(S.threads).some((t) => t.pending);
    P.inflight = false;
    if (failed) {
      P.fails++;
      P.lastErr = { kind: failed.kind, msg: failed.message, at: K.now() };
      P.interval = Math.min(3000 * 2 ** P.fails, 120_000);
    } else {
      P.fails = 0;
      P.lastErr = null;
      P.lastOk = K.now();
      const busy = Object.values(S.threads).some((t) => ["running", "waiting", "starting"].includes(K.uiStatus(t)));
      P.interval = busy ? 3000 : 30_000;
    }
    P.next = Date.now() + P.interval;
    K.changed();
  }
  K.pollNow = () => (S.poll.next = 0);
  setInterval(() => {
    if (!S.poll.inflight && Date.now() >= S.poll.next) pollOnce();
  }, 400);
  K.health = () => {
    const P = S.poll;
    if (S.mode === "missing") return { state: "missing", label: "T3 not found" };
    if (P.lastErr?.kind === "down" || S.mode === "down") return { state: "down", label: "T3 offline" };
    if (P.lastErr?.kind === "timeout" || S.mode === "slow") return { state: "slow", label: "T3 slow" };
    return { state: "ok", label: "T3 :3773" };
  };
  K.stale = () => S.poll.lastErr && Object.keys(S.threads).length ? S.poll.lastOk : 0;

  /* ───────── actions on T3 ───────── */
  const titleOf = (text) => text.split("\n")[0].replace(/[`*]/g, "").slice(0, 60);
  K.t3 = {
    async open(wtId) {
      const w = K.wt(wtId);
      const path = w.t3project || w.projects[0].path;
      try {
        await cli(["app", path]);
        K.toast(`Opened ${w.label} in T3 Code${S.waitingApproval ? " · approve the command there" : ""}`, { kind: "agent", icon: "ph-arrow-square-out" });
      } catch (e) {
        K.toast(e.kind === "missing" ? "T3 Code isn't installed" : e.kind === "down" ? "T3 Code isn't running. Start it, then check again." : e.message, { kind: "bad", icon: "ph-x-circle", action: { label: "T3 status", run: () => K.ui.t3Dialog() } });
      }
    },
    async addProject(wtId) {
      const w = K.wt(wtId);
      S.adding = wtId;
      K.changed();
      try {
        await cli(["project", "add", w.t3project, "--title", w.label], { title: w.label });
        delete S.seen[norm(w.t3project)];
        K.toast(`${w.label} is a T3 project now`, { icon: "ph-check-circle" });
        K.pollNow();
      } catch (e) {
        K.toast(`Couldn't add ${w.label}: ${e.message}`, { kind: "bad", icon: "ph-x-circle" });
      } finally {
        S.adding = null;
        K.changed();
      }
    },
    /** Starts a thread in the worktree's existing folder. Never `--worktree`: that would make a second checkout Spawner doesn't run. */
    async start(wtId, text, { title, inst } = {}) {
      const w = K.wt(wtId);
      const tmp = "tmp-" + Math.random().toString(36).slice(2, 7);
      title ||= titleOf(text);
      S.threads[tmp] = { threadId: tmp, wt: wtId, title, starting: true, status: "running", items: 0, messages: [{ role: "user", text, via: "spawner" }], updatedAt: K.now(), createdAt: K.now(), startedAt: Date.now() };
      K.changed();
      try {
        if (K.t3For(wtId).kind === "unregistered") await K.t3.addProject(wtId);
        const { threadId } = await cli(["thread", "start", w.t3project, "-", "--title", title, "--json"], { stdin: text, title, inst });
        const th = await cli(["thread", "show", threadId, "--messages", "6", "--json"]);
        delete S.threads[tmp];
        S.threads[threadId] = { ...th, wt: wtId, fetchedAt: K.now() };
        K.pollNow();
        K.emit("thread-started", { id: threadId, tmp });
        return threadId;
      } catch (e) {
        delete S.threads[tmp];
        K.changed();
        throw e;
      }
    },
    async send(threadId, text, meta = {}) {
      const box = (S.outbox[threadId] ||= []);
      const m = { id: Math.random(), text, state: "sending", started: Date.now(), ...meta };
      box.push(m);
      K.changed();
      try {
        const r = await cli(["thread", "send", threadId, "-", "--json"], { stdin: text });
        m.state = "sent";
        m.queued = r.queued;
        K.pollNow();
        return r;
      } catch (e) {
        m.state = "failed";
        m.err = e.message;
        throw e;
      } finally {
        K.changed();
      }
    },
    retrySend(threadId, mid) {
      const box = S.outbox[threadId] || [];
      const m = box.find((x) => x.id === mid);
      if (!m) return;
      box.splice(box.indexOf(m), 1);
      return K.t3.send(threadId, m.text, { lines: m.lines }).catch(() => {});
    },
  };

  /* ───────── fix with agent ───────── */
  K.fixPrompt = (instId) => {
    const i = I[instId], w = K.wt(i.wt);
    const errs = S.logs.filter((l) => l.inst === instId && l.level === "err").slice(-4).map((l) => "  " + l.text);
    return `${i.name} (${i.repo}) fails to build in ${i.path} on branch ${w.branch}.\n\nBuild output (MSBuild, Debug):\n${errs.join("\n")}\n\nFix the build. Don't start the app yourself; I run it in Spawner (app "${i.name}", worktree ${w.label}). Tell me when it builds.`;
  };
  K.fixTitle = (instId) => `Fix CS0246 in ${I[instId].name}`;
  /** The fix's progress, read from the thread view so it only moves when a poll sees it move. */
  K.fixOf = (instId) => {
    const f = S.fixes[instId];
    if (!f) return null;
    const th = f.threadId && S.threads[f.threadId];
    return { ...f, th, status: f.phase === "starting" || f.phase === "error" ? f.phase : K.uiStatus(th) };
  };
  K.on("thread-started", ({ id, tmp }) => {
    for (const f of Object.values(S.fixes)) if (f.tmp === tmp) Object.assign(f, { threadId: id, phase: "thread" });
  });
  K.copy = (text, what) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    K.toast(`${what} copied`, { icon: "ph-copy" });
  };

  /* ───────── toasts ───────── */
  K.toast = (text, { kind = "", icon = "ph-check-circle", action = null, ms = 3600 } = {}) => {
    let host = $(".toasts");
    if (!host) {
      host = document.createElement("div");
      host.className = "toasts";
      $(".frame").appendChild(host);
    }
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.setAttribute("role", "status");
    t.innerHTML = `<i class="ph-fill ${icon}"></i><span>${esc(text)}</span>${action ? `<button class="lk">${esc(action.label)}</button>` : ""}`;
    if (action) t.querySelector("button").onclick = () => (action.run(), t.remove());
    host.appendChild(t);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => (t.classList.add("out"), setTimeout(() => t.remove(), 320)), ms);
  };

  /* ───────── dialogs (in-app, like ConcludeDialog; never native) ───────── */
  K.dlg = {
    open(html, { onClose } = {}) {
      K.dlg.close();
      const el = document.createElement("div");
      el.className = "dlg-scrim";
      el.innerHTML = html;
      el.addEventListener("mousedown", (e) => e.target === el && K.dlg.close());
      $(".frame").appendChild(el);
      K.dlg.el = el;
      K.dlg.onClose = onClose;
      setTimeout(() => (el.querySelector("[autofocus]") || el.querySelector(".btn-primary, .btn-agent"))?.focus(), 30);
      return el;
    },
    close() {
      K.dlg.el?.remove();
      K.dlg.el = null;
      K.dlg.onClose?.();
      K.dlg.onClose = null;
    },
  };

  /* ───────── UI fragments shared by the three layouts ───────── */
  const ui = (K.ui = {});
  const msgHTML = (s) => String(s).split(/```\n?/).map((part, k) => (k % 2 ? `<pre>${esc(part.replace(/\n$/, ""))}</pre>` : esc(part).replace(/`([^`\n]+)`/g, "<code>$1</code>"))).join("");
  ui.prChip = (th) => (th?.pr ? `<button class="pill pr" data-k="pr" data-url="${esc(th.pr.url)}" title="${esc(th.pr.title)}"><i class="ph-bold ph-git-pull-request"></i>#${th.pr.number} ${th.pr.state}</button>` : "");
  ui.statusWord = (st) => ({ starting: "starting", running: "agent working", waiting: "waiting for you", completed: "your turn", settled: "settled", failed: "run failed", none: "no thread" })[st];

  ui.failCard = (instId) => {
    const i = I[instId], w = K.wt(i.wt);
    if (i.state !== "failed") return "";
    const f = K.fixOf(instId), t3 = K.t3For(i.wt);
    const head = `<b>${esc(i.name)} didn't build</b> <span class="muted">· ${esc(w.label)}</span><code>CS0246 · 'IAsaasGateway' could not be found · Services\\AsaasService.cs (2 errors)</code>`;
    const viewBtn = (id) => `<button class="btn btn-ghost sm" data-k="focus-thread" data-id="${id}"><i class="ph ph-chat-circle-text"></i>View thread</button>`;
    if (!f || f.status === "error") {
      const usable = t3.ok || t3.kind === "unregistered";
      const fix = usable
        ? `<button class="btn btn-agent" data-k="fix" data-id="${instId}"><i class="ph ph-sparkle"></i>Fix with agent</button>`
        : `<button class="btn btn-ghost" data-k="fix-copy" data-id="${instId}"><i class="ph ph-copy"></i>Copy fix prompt</button>`;
      const why = !usable ? `<div class="prog"><i class="ph ph-plug"></i>${t3.kind === "missing" ? "T3 Code isn't installed" : "T3 Code is offline"}; the prompt works in any agent.</div>` : f?.status === "error" ? `<div class="prog" style="color:var(--err)"><i class="ph ph-x-circle"></i>${esc(f.err)}</div>` : "";
      return `<div class="failcard" data-fc="${instId}"><i class="ph-fill ph-warning-octagon"></i><div class="tx">${head}${why}</div><div class="acts">${fix}<button class="btn btn-ghost" data-k="start" data-id="${instId}"><i class="ph ph-arrow-clockwise"></i>Retry</button></div></div>`;
    }
    if (f.status === "starting")
      return `<div class="failcard agent" data-fc="${instId}"><i class="ph ph-sparkle"></i><div class="tx"><b>Starting a thread in T3…</b><div class="prog"><span class="spin"><i class="ph ph-circle-notch"></i></span>t3 thread start ${esc(w.t3project)} · ${K.elapsedSpan(f.startedAt)}</div></div><div class="acts"><button class="btn btn-quiet sm" data-k="start" data-id="${instId}">Retry anyway</button></div></div>`;
    const th = f.th;
    const last = [...(th?.messages || [])].reverse().find((m) => m.role === "assistant");
    if (f.status === "waiting")
      return `<div class="failcard wait" data-fc="${instId}"><i class="ph-fill ph-hand-palm"></i><div class="tx"><b>The agent needs your OK in T3 Code</b><code>${esc(th.ask?.command || "")}</code><div class="prog">Spawner can't approve commands; T3 asks for it. ${th ? `Seen ${K.agoSpan(th.fetchedAt)}.` : ""}</div></div><div class="acts"><button class="btn btn-primary" data-k="t3-open" data-wt="${i.wt}"><i class="ph ph-arrow-square-out"></i>Approve in T3</button>${viewBtn(th.threadId)}</div></div>`;
    if (f.status === "running")
      return `<div class="failcard agent" data-fc="${instId}"><i class="ph ph-sparkle"></i><div class="tx"><b>An agent is fixing it</b> <span class="muted">· ${esc(th.title)}</span><div class="prog"><span class="ts running"></span>${th.items} items · checked ${K.agoSpan(th.fetchedAt)}</div>${last ? `<div class="say">${msgHTML(last.text)}</div>` : ""}</div><div class="acts">${viewBtn(th.threadId)}<button class="btn btn-quiet sm" data-k="start" data-id="${instId}" title="The agent may still be editing files">Retry anyway</button></div></div>`;
    return `<div class="failcard done" data-fc="${instId}"><i class="ph-fill ph-check-circle"></i><div class="tx"><b>The agent says it's fixed</b> <span class="muted">· ${esc(th?.title || "")}</span>${last ? `<div class="say okb">${msgHTML(last.text)}</div>` : ""}</div><div class="acts"><button class="btn btn-primary nudge" data-k="start" data-id="${instId}"><i class="ph ph-arrow-clockwise"></i>Retry build</button>${th ? viewBtn(th.threadId) : ""}</div></div>`;
  };

  /** Shown wherever thread data would be, when T3 can't give it. Says what is missing and how to fix it. */
  ui.t3Problem = (wtId) => {
    const t = K.t3For(wtId), w = K.wt(wtId);
    if (t.kind === "missing")
      return `<div class="t3card missing"><b><i class="ph-fill ph-plug"></i>T3 Code isn't installed</b>Spawner looks for <code>t3</code> on PATH and in %USERPROFILE%\\.t3\\bin. Apps and logs work without it; threads, Fix with agent and Send to thread need it.<div class="acts"><button class="btn btn-ghost sm" data-k="t3-status"><i class="ph ph-arrows-clockwise"></i>Check again</button><button class="btn btn-quiet sm" data-k="toast" data-msg="Opened t3.codes in the browser">Get T3 Code</button></div></div>`;
    if (t.kind === "down")
      return `<div class="t3card down"><b><i class="ph-fill ph-plug"></i>T3 Code isn't running</b>The CLI is there, but nothing answers at 127.0.0.1:3773. Threads below are what it said at ${S.poll.lastOk ? K.hms(S.poll.lastOk).slice(0, 8) : "start-up"} and won't change until it's back. Spawner checks again in ${Math.round(S.poll.interval / 1000)} s.<div class="acts"><button class="btn btn-ghost sm" data-k="t3-open" data-wt="${wtId}"><i class="ph ph-arrow-square-out"></i>Open T3 Code</button><button class="btn btn-quiet sm" data-k="t3-recheck"><i class="ph ph-arrows-clockwise"></i>Check now</button></div></div>`;
    if (t.kind === "unregistered")
      return `<div class="t3card unreg"><b><i class="ph-fill ph-folder-simple-dashed"></i>${esc(w.label)} isn't a T3 project</b>T3 answered: "No T3 Code project matches '${esc(t.path)}'". Add it to see its threads here:<code>t3 project add ${esc(t.path)} --title ${esc(w.label)}</code><div class="acts"><button class="btn btn-primary sm" data-k="t3-add" data-wt="${wtId}" ${S.adding === wtId ? "disabled" : ""}>${S.adding === wtId ? '<span class="spin"><i class="ph ph-circle-notch"></i></span>Adding…' : '<i class="ph ph-plus"></i>Add to T3'}</button></div></div>`;
    return "";
  };
  ui.staleNote = () => {
    const P = S.poll;
    if (P.lastErr?.kind !== "timeout") return "";
    return `<div class="stale-note"><i class="ph ph-hourglass-medium"></i>t3 timed out · showing what it said at ${P.lastOk ? K.hms(P.lastOk).slice(0, 8) : "start-up"} · next try in ${Math.round(P.interval / 1000)} s</div>`;
  };

  ui.conversation = (threadId, { limit = 6 } = {}) => {
    const th = S.threads[threadId];
    if (!th) return `<div class="conv"><div class="conv-msgs"><p class="muted">Thread not found.</p></div></div>`;
    const st = K.uiStatus(th);
    const msgs = th.messages.slice(-limit);
    const sentIds = new Set(th.messages.map((m) => m.text));
    const out = (S.outbox[threadId] || []).filter((m) => m.state !== "sent" || !sentIds.has(m.text));
    const one = (m, local) => {
      const who = m.role === "assistant" ? `<i class="ph-fill ph-sparkle" style="color:var(--agent)"></i>agent` : `you${m.via === "spawner" || local ? ' <span class="tag">via Spawner</span>' : ""}${m.lines ? ` <span class="tag">${m.lines} log lines</span>` : ""}`;
      const note = local ? (m.state === "sending" ? `<div class="note"><span class="spin"><i class="ph ph-circle-notch"></i></span>Sending… ${K.elapsedSpan(m.started)}</div>` : m.state === "failed" ? `<div class="note"><i class="ph ph-x-circle"></i>Not sent: ${esc(m.err)} <button class="lk" data-k="resend" data-th="${threadId}" data-mid="${m.id}">Try again</button></div>` : `<div class="note"><i class="ph ph-check"></i>${m.queued ? "Queued: the agent gets it as its next turn" : "Sent"}</div>`) : "";
      return `<div class="msgb ${m.role || "user"}${local ? " " + m.state : ""}"><div class="who">${who}</div><div class="body">${msgHTML(m.text)}</div>${note}</div>`;
    };
    const hidden = th.messages.length - msgs.length;
    const ask = st === "waiting" ? `<div class="askcard"><b><i class="ph-fill ph-hand-palm"></i>Waiting for your approval</b>The agent wants to run:<code>${esc(th.ask?.command)}</code><div class="acts" style="display:flex;gap:6px"><button class="btn btn-primary sm" data-k="t3-open" data-wt="${th.wt}"><i class="ph ph-arrow-square-out"></i>Approve in T3</button><button class="btn btn-quiet sm" data-k="copy" data-text="${esc(th.link)}">Copy thread link</button></div><div class="why">Approvals happen in T3 Code; the CLI has no command for them. Spawner picks the result up on its next check.</div></div>` : "";
    const run = th.starting
      ? `<span class="ts starting"></span><span class="grow">starting thread · ${K.elapsedSpan(th.startedAt)}</span>`
      : `<span class="ts ${st}"></span><span class="grow">${ui.statusWord(st)} · ${th.items} items · ${esc(th.model || "default model")}</span><span title="When Spawner last read this thread">${th.fetchedAt ? K.agoSpan(th.fetchedAt) : ""}</span>`;
    return `<div class="conv">${ui.staleNote()}<div class="conv-msgs" data-scroll="${threadId}">${hidden > 0 ? `<button class="lk" data-k="link" data-url="${esc(th.link)}" style="align-self:center">${hidden} earlier messages · open in T3</button>` : ""}${msgs.map((m) => one(m)).join("")}${out.map((m) => one(m, true)).join("")}</div>${ask}<div class="runline">${run}</div>${ui.composer(threadId, st)}</div>`;
  };
  ui.composer = (threadId, st) => {
    const t3 = K.t3For(S.threads[threadId]?.wt);
    const off = !t3.ok || S.threads[threadId]?.starting;
    const hint = !t3.ok ? (t3.kind === "unregistered" ? "Add the project to T3 to send" : "T3 is offline · sending is off") : st === "running" ? "Busy · it gets this as its next turn" : st === "settled" ? "Sending reopens this settled thread" : "Ctrl+Enter to send";
    return `<div class="composer${off ? " off" : ""}"><div class="box"><textarea data-compose="${threadId}" placeholder="Message the agent…" ${off ? "disabled" : ""}></textarea><div class="row2"><span class="grow">${hint}</span><button class="btn btn-primary sm" data-k="compose-send" data-th="${threadId}"><i class="ph ph-paper-plane-tilt"></i>Send</button></div></div></div>`;
  };
  ui.newThread = (wtId) => {
    const w = K.wt(wtId), t3 = K.t3For(wtId);
    if (w.t3made) return `<div class="t3card"><b><i class="ph ph-info"></i>T3 made this worktree</b>New threads from the CLI start in the project folder or a new worktree, never in an existing one, so continue in the thread that owns it.</div>`;
    if (!t3.ok && t3.kind !== "unregistered") return "";
    return `<div class="composer"><div class="box"><textarea data-newthread="${wtId}" placeholder="Start a thread in ${esc(w.label)}: what should the agent do?"></textarea><div class="row2"><span class="grow mono" title="Runs in the existing folder, no new worktree">${t3.kind === "unregistered" ? "adds the project first, then " : ""}t3 thread start ${esc(w.t3project)}</span><button class="btn btn-agent sm" data-k="new-thread" data-wt="${wtId}"><i class="ph ph-sparkle"></i>Start thread</button></div></div></div>`;
  };

  /** The fix sheet: what will be sent, to which project, with the exact command. */
  ui.fixSheet = (instId) => {
    const i = I[instId], w = K.wt(i.wt), t3 = K.t3For(i.wt);
    const existing = K.threadsOf(i.wt).filter((t) => !t.starting);
    const title = K.fixTitle(instId);
    const el = K.dlg.open(`<div class="dlg" role="dialog" aria-label="Fix with agent" style="width:600px">
      <div class="dlg-h"><span class="dlg-ico"><i class="ph ph-sparkle"></i></span><div><h2>Fix ${esc(i.name)} with an agent</h2><p>Starts a T3 thread in <b>${esc(w.label)}</b> with the build output below. The agent asks in T3 before it runs commands. Retry stays available the whole time.</p></div></div>
      <div class="dlg-b">
        ${t3.kind === "unregistered" ? `<div class="t3card unreg" style="margin:0"><b><i class="ph-fill ph-folder-simple-dashed"></i>${esc(w.label)} isn't a T3 project yet</b>Starting adds it first:<code>t3 project add ${esc(w.t3project)} --title ${esc(w.label)}</code></div>` : ""}
        <div><label class="lbl">Thread</label><div class="picks">
          <label class="pick"><input type="radio" name="fx" value="new" checked><div class="meta"><div class="nm">New thread · ${esc(title)}</div><div class="sub">${esc(w.t3project)} · project's default model</div></div></label>
          ${existing.map((t) => `<label class="pick"><input type="radio" name="fx" value="${t.threadId}"><span class="ts ${K.uiStatus(t)}"></span><div class="meta"><div class="nm">${esc(t.title)}</div><div class="sub">${ui.statusWord(K.uiStatus(t))}${K.uiStatus(t) === "running" ? " · gets it as its next turn" : ""}</div></div></label>`).join("")}
        </div></div>
        <div><label class="lbl" for="fxmsg">Message</label><textarea id="fxmsg" rows="8">${esc(K.fixPrompt(instId))}</textarea></div>
        <div class="cmdline" id="fxcmd"><i class="ph ph-terminal"></i><span>t3 thread start ${esc(w.t3project)} - --title "${esc(title)}" --json  · message on stdin</span></div>
      </div>
      <div class="dlg-f"><span class="grow">Spawner checks the thread every 3 s while it runs.</span><button class="btn btn-ghost" data-k="close">Cancel</button><button class="btn btn-agent" id="fxgo"><i class="ph ph-sparkle"></i>${t3.kind === "unregistered" ? "Add project and start" : "Start thread"}</button></div></div>`);
    const cmd = $("#fxcmd", el), go = $("#fxgo", el);
    el.querySelectorAll('input[name="fx"]').forEach((r) => (r.onchange = () => {
      cmd.lastElementChild.textContent = r.value === "new" ? `t3 thread start ${w.t3project} - --title "${title}" --json  · message on stdin` : `t3 thread send ${r.value} - --json  · message on stdin`;
    }));
    go.onclick = async () => {
      const pick = $('input[name="fx"]:checked', el).value, text = $("#fxmsg", el).value;
      go.disabled = true;
      go.innerHTML = `<span class="spin"><i class="ph ph-circle-notch"></i></span>Starting… <span data-elapsed="${Date.now()}">0 s</span>`;
      cmd.className = "cmdline";
      try {
        if (pick === "new") {
          const f = (S.fixes[instId] = { phase: "starting", startedAt: Date.now(), tmp: null });
          K.dlg.close();
          K.changed();
          const before = Object.keys(S.threads);
          const p = K.t3.start(i.wt, text, { title, inst: instId });
          f.tmp = Object.keys(S.threads).find((k) => !before.includes(k));
          const id = await p;
          Object.assign(f, { threadId: id, phase: "thread" });
          K.toast(`Thread started · ${title}`, { kind: "agent", icon: "ph-sparkle", action: { label: "View", run: () => K.emit("focus-thread", id) } });
        } else {
          await K.t3.send(pick, text);
          S.fixes[instId] = { phase: "thread", threadId: pick };
          K.dlg.close();
          K.toast(`Sent to ${S.threads[pick].title}`, { kind: "agent", icon: "ph-paper-plane-tilt" });
        }
        K.changed();
      } catch (e) {
        if (S.fixes[instId]) Object.assign(S.fixes[instId], { phase: "error", err: e.message });
        K.changed();
        K.toast(`Couldn't start the thread: ${e.message}`, { kind: "bad", icon: "ph-x-circle", ms: 6000, action: { label: "T3 status", run: () => ui.t3Dialog() } });
      }
    };
  };

  /** Selected log lines → a thread. Shows the exact text before it goes. */
  ui.sendSheet = () => {
    const lines = S.logs.filter((l) => S.sel.has(l.seq));
    if (!lines.length) return;
    const insts = [...new Set(lines.map((l) => l.inst))];
    const i = I[insts[0]], w = K.wt(i.wt), t3 = K.t3For(i.wt);
    const threads = K.threadsOf(i.wt).filter((t) => !t.starting);
    const src = insts.map((x) => `${I[x].name} @ ${K.wt(I[x].wt).label} (${I[x].repo}, ${I[x].path})`).join(", ");
    const body = (note) => `${note ? note + "\n\n" : ""}From Spawner · ${src}:\n\`\`\`\n${lines.map((l) => `${K.hms(l.ts)} ${LV[l.level]} ${l.text}`).join("\n")}\n\`\`\``;
    const def = threads.find((t) => K.uiStatus(t) !== "settled")?.threadId || threads[0]?.threadId || "new";
    const el = K.dlg.open(`<div class="dlg" role="dialog" aria-label="Send to thread" style="width:620px">
      <div class="dlg-h"><span class="dlg-ico"><i class="ph ph-paper-plane-tilt"></i></span><div><h2>Send ${lines.length} log line${lines.length > 1 ? "s" : ""} to a thread</h2><p>From ${esc(insts.map((x) => I[x].name).join(", "))} in <b>${esc(w.label)}</b>. Threads of that worktree are listed first.</p></div></div>
      <div class="dlg-b">
        ${t3.ok ? "" : ui.t3Problem(i.wt).replace('class="t3card', 'style="margin:0" class="t3card')}
        <div><label class="lbl">Thread</label><div class="picks">
          ${threads.map((t) => { const st = K.uiStatus(t); return `<label class="pick"><input type="radio" name="sd" value="${t.threadId}" ${t.threadId === def ? "checked" : ""} ${t3.ok ? "" : "disabled"}><span class="ts ${st}"></span><div class="meta"><div class="nm">${esc(t.title)}</div><div class="sub">${ui.statusWord(st)}${st === "running" ? " · gets it as its next turn" : st === "settled" ? " · reopens it" : " · starts a run"}</div></div></label>`; }).join("")}
          <label class="pick"><input type="radio" name="sd" value="new" ${def === "new" ? "checked" : ""} ${t3.ok && !w.t3made ? "" : "disabled"}><span class="ts" style="color:var(--text-tertiary)"><i class="ph ph-plus"></i></span><div class="meta"><div class="nm">New thread in ${esc(w.label)}</div><div class="sub">${w.t3made ? "not possible for a worktree T3 made" : esc(w.t3project || "")}</div></div></label>
        </div></div>
        <div><label class="lbl" for="sdnote">Your note</label><input type="text" id="sdnote" placeholder="What should the agent do with these? e.g. why does this 500?" autofocus></div>
        <div><label class="lbl">Exactly what is sent</label><textarea id="sdprev" rows="7" readonly>${esc(body(""))}</textarea></div>
        <div class="cmdline" id="sdcmd"><i class="ph ph-terminal"></i><span></span></div>
      </div>
      <div class="dlg-f"><button class="btn btn-quiet" id="sdcopy"><i class="ph ph-copy"></i>Copy instead</button><span class="grow"></span><button class="btn btn-ghost" data-k="close">Cancel</button><button class="btn btn-primary" id="sdgo" ${t3.ok ? "" : "disabled"}><i class="ph ph-paper-plane-tilt"></i>Send</button></div></div>`);
    const note = $("#sdnote", el), prev = $("#sdprev", el), cmd = $("#sdcmd span", el);
    const pick = () => $('input[name="sd"]:checked', el)?.value;
    const sync = () => {
      prev.value = body(note.value.trim());
      const p = pick();
      cmd.textContent = p === "new" ? `t3 thread start ${w.t3project} - --json  · message on stdin` : `t3 thread send ${p} - --json  · message on stdin`;
    };
    note.oninput = sync;
    el.querySelectorAll('input[name="sd"]').forEach((r) => (r.onchange = sync));
    sync();
    $("#sdcopy", el).onclick = () => (K.copy(prev.value, "Lines as Markdown"), K.dlg.close());
    $("#sdgo", el).onclick = async (ev) => {
      const b = ev.currentTarget, p = pick(), text = prev.value;
      b.disabled = true;
      b.innerHTML = `<span class="spin"><i class="ph ph-circle-notch"></i></span>Sending…`;
      try {
        if (p === "new") {
          K.dlg.close();
          const id = await K.t3.start(w.id, text);
          K.toast("Thread started with your lines", { kind: "agent", icon: "ph-sparkle", action: { label: "View", run: () => K.emit("focus-thread", id) } });
        } else {
          K.dlg.close();
          K.emit("focus-thread", p);
          const r = await K.t3.send(p, text, { lines: lines.length });
          K.toast(`${lines.length} lines sent to “${S.threads[p].title}”${r.queued ? " · queued as its next turn" : ""}`, { kind: "agent", icon: "ph-paper-plane-tilt" });
        }
        S.sel.clear();
        K.changed();
      } catch (e) {
        K.toast(`Not sent: ${e.message}`, { kind: "bad", icon: "ph-x-circle", ms: 6000 });
      }
    };
  };

  /** T3 connection: every check, what it found, and the fix. Opened from the status bar chip. */
  ui.t3Dialog = () => {
    const render = () => {
      const h = K.health(), P = S.poll;
      const unreg = WTS.filter((w) => w.t3project && K.t3For(w.id).kind === "unregistered");
      const cliOk = S.mode !== "missing", srvOk = cliOk && S.mode !== "down";
      const last = S.calls.find((c) => c.state !== "run");
      const rows = [
        cliOk ? `<div class="check"><i class="ph-fill ph-check-circle"></i><div class="meta"><b>T3 Code CLI</b><code>%USERPROFILE%\\.t3\\bin\\t3.cmd</code> · v0.1.11-nightly.20261117</div></div>`
          : `<div class="check"><i class="ph-fill ph-x-circle"></i><div class="meta"><b>T3 Code CLI not found</b>Not on PATH and not in <code>%USERPROFILE%\\.t3\\bin</code>. Installing T3 Code adds it. Apps and logs keep working without it.<div class="acts"><button class="btn btn-ghost sm" data-k="toast" data-msg="Opened t3.codes in the browser">Get T3 Code</button></div></div></div>`,
        !cliOk ? `<div class="check"><i class="ph ph-circle muted"></i><div class="meta"><b>T3 Code server</b>Checked after the CLI is found.</div></div>`
          : srvOk ? `<div class="check"><i class="ph-fill ph-check-circle"></i><div class="meta"><b>T3 Code server</b>Answering at <code>http://127.0.0.1:3773</code> · pid 32260 · up since 08:39</div></div>`
          : `<div class="check"><i class="ph-fill ph-x-circle"></i><div class="meta"><b>T3 Code isn't running</b><code>server-runtime.json</code> names :3773 (pid 32260), but nothing answers there. Start T3 Code; Spawner notices on its own.<div class="acts"><button class="btn btn-ghost sm" data-k="t3-open" data-wt="PAYMENT-9986"><i class="ph ph-arrow-square-out"></i>Open T3 Code</button></div></div></div>`,
        unreg.length ? `<div class="check"><i class="ph-fill ph-warning-circle"></i><div class="meta"><b>${unreg.length} worktree${unreg.length > 1 ? "s aren't T3 projects" : " isn't a T3 project"}</b>${unreg.map((w) => `<code>t3 project add ${esc(w.t3project)} --title ${esc(w.label)}</code><div class="acts"><button class="btn btn-primary sm" data-k="t3-add" data-wt="${w.id}"><i class="ph ph-plus"></i>Add ${esc(w.label)}</button></div>`).join("")}</div></div>`
          : srvOk ? `<div class="check"><i class="ph-fill ph-check-circle"></i><div class="meta"><b>Projects</b>Every task worktree maps to a T3 project (by folder).</div></div>` : "",
        P.lastErr?.kind === "timeout" ? `<div class="check"><i class="ph-fill ph-warning-circle"></i><div class="meta"><b>T3 is slow to answer</b>${esc(P.lastErr.msg)} Spawner keeps the last answer on screen and backs off: next check in ${Math.round(P.interval / 1000)} s.<div class="acts"><button class="btn btn-ghost sm" data-k="t3-recheck"><i class="ph ph-arrows-clockwise"></i>Check now</button></div></div></div>`
          : last && cliOk ? `<div class="check"><i class="ph-fill ph-check-circle"></i><div class="meta"><b>Response time</b>Last call took ${K.dur(last.ms)}. Timeout is 10 s.</div></div>` : "",
      ].join("");
      return `<div class="dlg" role="dialog" aria-label="T3 Code connection" style="width:580px">
        <div class="dlg-h"><span class="dlg-ico${h.state === "ok" ? " ok" : ""}"><i class="ph ph-plugs-connected"></i></span><div><h2>T3 Code connection</h2><p>Spawner reads threads through the <code>t3</code> CLI. It never opens T3's database.</p></div></div>
        <div class="dlg-b"><div class="checks">${rows}</div>
          <div><label class="lbl">Recent t3 calls</label><ul class="calls">${S.calls.map((c) => `<li><span>${esc(c.cmd)}</span><span class="${c.state}">${c.state === "run" ? "running" : c.state === "ok" ? "ok" : "failed"} ${c.state === "run" ? `<span data-elapsed="${c.started}"></span>` : K.dur(c.ms)}</span></li>`).join("") || "<li><span>none yet</span></li>"}</ul></div>
        </div>
        <div class="dlg-f"><span class="grow">Checks every 3 s while an agent works, 30 s otherwise, doubling up to 2 min after a failure.</span><button class="btn btn-ghost" data-k="close">Close</button><button class="btn btn-primary" data-k="t3-recheck"><i class="ph ph-arrows-clockwise"></i>Check now</button></div></div>`;
    };
    const html = render();
    const el = K.dlg.open(html);
    const off = () => K.put(el, render());
    el._html = html;
    const tick = setInterval(() => (K.dlg.el === el ? off() : clearInterval(tick)), 500);
  };

  /* ───────── log view (merged, or scoped to some instances) ───────── */
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
  const RANKLV = { dbg: 0, inf: 1, sys: 1, agent: 1, wrn: 2, err: 3 };
  K.LogView = class {
    constructor(el, { scope = () => null, chips = true, label = "", failCards = true } = {}) {
      Object.assign(this, { el, scope, chips, failCards, lvl: "all", q: "", hidden: new Set(), count: 0, lastSeq: 0, key: "", cards: {} });
      el.classList.add("logv");
      el.innerHTML = `<div class="logv-bar"><label class="field"><i class="ph ph-magnifying-glass"></i><input placeholder="Filter${label ? " " + esc(label) : ""} logs" aria-label="Filter logs"></label><div class="seg" role="group" aria-label="Level"><button data-l="all" aria-pressed="true">All</button><button data-l="wrn"><span class="ld w"></span>Warn+</button><button data-l="err"><span class="ld e"></span>Errors</button></div><span class="grow"></span><span class="count"></span></div>${chips ? '<div class="sources"></div>' : ""}<div class="logw"><div class="log" tabindex="0" aria-label="Log lines"></div><div class="selbar"><span class="c"></span><button class="btn btn-quiet sm" data-k="sel-copy"><i class="ph ph-copy"></i>Copy</button><button class="btn btn-agent sm" data-k="send-sel"><i class="ph ph-paper-plane-tilt"></i>Send to thread</button><button class="ib sm" data-k="sel-clear" aria-label="Clear selection"><i class="ph ph-x"></i></button></div></div>`;
      this.log = $(".log", el);
      this.src = $(".sources", el);
      this.selbar = $(".selbar", el);
      $("input", el).oninput = (e) => ((this.q = e.target.value.toLowerCase()), this.update());
      $$(".seg button", el).forEach((b) => (b.onclick = () => {
        this.lvl = b.dataset.l;
        $$(".seg button", el).forEach((x) => x.setAttribute("aria-pressed", x === b));
        this.update();
      }));
      this.log.addEventListener("click", (e) => this.onRow(e));
      this.src?.addEventListener("click", (e) => {
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
      K.on("render", () => this.el.isConnected && this.update());
      this.update();
    }
    insts() {
      const sc = this.scope();
      return [...new Set(S.logs.map((l) => l.inst))].filter((i) => !sc || sc.has(i));
    }
    vis() {
      const sc = this.scope(), q = this.q;
      return S.logs.filter((l) => (!sc || sc.has(l.inst)) && !this.hidden.has(l.inst) && (this.lvl === "all" || (this.lvl === "wrn" ? RANKLV[l.level] >= 2 : l.level === "err")) && (!q || l.text.toLowerCase().includes(q) || I[l.inst].name.toLowerCase().includes(q)));
    }
    rowHTML(l, prev) {
      const i = I[l.inst], start = !prev || prev.inst !== l.inst;
      return `<div class="row l-${l.level}${start ? " run-start" : ""}${S.sel.has(l.seq) ? " sel" : ""}${l.seq > this.lastSeq && this.lastSeq ? " fresh" : ""}" data-seq="${l.seq}" style="--c:${i.color}"><span class="t">${K.hms(l.ts)}</span><span class="src">${start ? `${esc(i.name)} <span class="w">${esc(K.wt(i.wt).short)}</span>` : ""}</span><span class="lv">${LV[l.level]}</span><span class="msg">${tint(l.text)}</span></div>`;
    }
    update() {
      const vis = this.vis();
      const sc = this.scope();
      const key = [this.lvl, this.q, [...this.hidden].join(), sc ? [...sc].join() : "*", S.logs[0]?.seq].join("|");
      const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60;
      if (key !== this.key || vis.length < this.count) {
        this.key = key;
        this.cards = {};
        this.log.innerHTML = vis.length ? vis.map((l, k) => this.rowHTML(l, vis[k - 1])).join("") : `<div class="none">No lines${this.q || this.lvl !== "all" ? " match" : " yet. Start an app and its output shows up here"}.</div>`;
        this.count = vis.length;
      } else if (vis.length > this.count) {
        this.log.querySelector(".none")?.remove();
        this.log.insertAdjacentHTML("beforeend", vis.slice(this.count).map((l, k) => this.rowHTML(l, vis[this.count + k - 1])).join(""));
        this.count = vis.length;
      }
      this.lastSeq = S.seq;
      // Fail cards sit right after the failing app's last line, and update in place.
      const failed = this.failCards ? Object.values(I).filter((i) => i.state === "failed" && (!sc || sc.has(i.id)) && !this.hidden.has(i.id)) : [];
      for (const [id, card] of Object.entries(this.cards)) if (!failed.some((f) => f.id === id) || !card.isConnected) (card.remove(), delete this.cards[id]);
      for (const i of failed) {
        let card = this.cards[i.id];
        if (!card) {
          const lastRow = [...this.log.querySelectorAll(".row")].reverse().find((r) => S.logs.find((l) => l.seq === +r.dataset.seq)?.inst === i.id);
          card = this.cards[i.id] = document.createElement("div");
          lastRow ? lastRow.after(card) : this.log.appendChild(card);
        }
        K.put(card, ui.failCard(i.id));
      }
      if (atBottom) this.log.scrollTop = this.log.scrollHeight;
      this.syncChips();
      this.syncSel();
      $(".count", this.el).textContent = `${vis.length} lines · ${vis.filter((l) => l.level === "wrn").length} warn · ${vis.filter((l) => l.level === "err").length} err`;
    }
    syncChips() {
      if (!this.src) return;
      const ids = this.insts();
      const html = ids.map((id) => `<button class="chip${this.hidden.has(id) ? " off" : ""}" data-inst="${id}" style="--c:${I[id].color}" title="Click: hide/show · Ctrl+click: only this"><span class="cd"></span>${esc(I[id].name)} <span class="w">${esc(K.wt(I[id].wt).short)}</span><span class="n" data-n="${id}"></span><span class="n e" data-e="${id}" hidden></span></button>`).join("");
      K.put(this.src, html);
      for (const id of ids) {
        const n = S.logs.filter((l) => l.inst === id);
        const e = n.filter((l) => l.level === "err").length;
        const ne = this.src.querySelector(`[data-n="${CSS.escape(id)}"]`), ee = this.src.querySelector(`[data-e="${CSS.escape(id)}"]`);
        if (ne) ne.textContent = n.length;
        if (ee) (ee.hidden = !e), (ee.textContent = `${e} err`);
      }
    }
    syncSel() {
      const n = [...S.sel].filter((s) => this.log.querySelector(`.row[data-seq="${s}"]`)).length;
      this.selbar.classList.toggle("on", n > 0);
      $(".c", this.selbar).textContent = `${n} line${n === 1 ? "" : "s"} selected`;
      this.log.querySelectorAll(".row").forEach((r) => r.classList.toggle("sel", S.sel.has(+r.dataset.seq)));
    }
    onRow(e) {
      const r = e.target.closest(".row");
      if (!r || e.target.closest("button")) return;
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

  /* ───────── palette ───────── */
  K.palette = {
    extra: () => [],
    open() {
      let host = $("#pal");
      if (!host) {
        host = document.createElement("div");
        host.id = "pal";
        host.innerHTML = `<div class="pal" role="dialog" aria-label="Command palette"><div class="in"><i class="ph ph-magnifying-glass"></i><input placeholder="Run, stop, fix, open in T3, go to a task…" aria-label="Command"><span class="kbd">Esc</span></div><ul></ul></div>`;
        $(".frame").appendChild(host);
        host.addEventListener("mousedown", (e) => e.target === host && K.palette.close());
        const inp = $("input", host);
        inp.oninput = () => ((K.palette.a = 0), K.palette.draw());
        inp.onkeydown = (e) => {
          const n = K.palette.list.length;
          if (e.key === "ArrowDown") (K.palette.a = (K.palette.a + 1) % n), K.palette.draw(), e.preventDefault();
          else if (e.key === "ArrowUp") (K.palette.a = (K.palette.a - 1 + n) % n), K.palette.draw(), e.preventDefault();
          else if (e.key === "Enter") K.palette.run(K.palette.list[K.palette.a]);
          else if (e.key === "Escape") K.palette.close();
        };
        $("ul", host).addEventListener("click", (e) => {
          const it = e.target.closest(".item");
          if (it) K.palette.run(K.palette.list[+it.dataset.n]);
        });
      }
      host.classList.add("on");
      const inp = $("input", host);
      inp.value = "";
      K.palette.a = 0;
      K.palette.draw();
      setTimeout(() => inp.focus(), 20);
    },
    close: () => $("#pal")?.classList.remove("on"),
    run(c) {
      if (!c) return;
      K.palette.close();
      c.run();
    },
    commands() {
      const out = [...K.palette.extra()];
      for (const i of Object.values(I)) {
        const w = K.wt(i.wt);
        if (i.state === "failed" && K.t3For(i.wt).ok) out.push({ g: "Agent", icon: "ph-sparkle", label: `Fix ${i.name} @ ${w.label} with an agent`, run: () => ui.fixSheet(i.id) });
        out.push({ g: "Apps", icon: active(i.state) ? "ph-stop" : "ph-play", label: `${active(i.state) ? "Stop" : i.state === "failed" ? "Retry" : "Run"} ${i.name} @ ${w.label}`, run: () => (active(i.state) ? K.app.stop(i.id) : K.app.start(i.id)) });
        if (K.portOf(i) && i.state === "running") out.push({ g: "Apps", icon: "ph-globe", label: `Open ${i.name} :${K.portOf(i)}`, run: () => K.app.open(i.id) });
      }
      for (const w of WTS) if (w.t3project) out.push({ g: "T3 Code", icon: "ph-arrow-square-out", label: `Open ${w.label} in T3 Code`, k: "t3 app", run: () => K.t3.open(w.id) });
      for (const th of Object.values(S.threads)) if (th.pr) out.push({ g: "T3 Code", icon: "ph-git-pull-request", label: `Open PR #${th.pr.number} · ${th.pr.title}`, run: () => K.toast(`Opened ${th.pr.url.replace("https://", "")}`, { icon: "ph-git-pull-request" }) });
      if (S.sel.size) out.push({ g: "Logs", icon: "ph-paper-plane-tilt", label: `Send ${S.sel.size} selected lines to a thread`, run: ui.sendSheet });
      out.push({ g: "Spawner", icon: "ph-plugs-connected", label: "T3 Code connection…", run: ui.t3Dialog }, { g: "Spawner", icon: "ph-moon", label: "Toggle theme", k: "Ctrl Shift L", run: K.toggleTheme });
      return out;
    },
    draw() {
      const host = $("#pal"), q = $("input", host).value.toLowerCase().trim();
      const list = (K.palette.list = K.palette.commands().filter((c) => !q || c.label.toLowerCase().includes(q)));
      let g = "";
      $("ul", host).innerHTML = list.length ? list.map((c, n) => `${c.g !== g ? `<li class="grp">${(g = c.g)}</li>` : ""}<li class="item${n === K.palette.a ? " a" : ""}" data-n="${n}"><i class="ph ${c.icon}"></i>${esc(c.label)}${c.k ? `<span class="k">${c.k}</span>` : ""}</li>`).join("") : `<li class="none">Nothing matches.</li>`;
      $(".item.a", host)?.scrollIntoView({ block: "nearest" });
    },
  };

  /* ───────── theme ───────── */
  const stored = (() => {
    try {
      return localStorage.getItem("mock-theme");
    } catch {
      return null;
    }
  })();
  document.documentElement.dataset.theme = stored || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  K.toggleTheme = () => {
    const r = document.documentElement;
    r.classList.add("theming");
    r.dataset.theme = r.dataset.theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("mock-theme", r.dataset.theme);
    } catch {}
    setTimeout(() => r.classList.remove("theming"), 450);
    K.changed();
  };

  /* ───────── status bar (shared) ───────── */
  ui.statusBar = (extra = "") => {
    const run = Object.values(I).filter((i) => i.state === "running").length, bad = Object.values(I).filter((i) => i.state === "failed").length;
    const h = K.health(), calling = S.calls.some((c) => c.state === "run");
    const agents = Object.values(S.threads).filter((t) => ["running", "waiting"].includes(K.uiStatus(t))).length;
    return `<span class="g"><span class="dot" style="background:var(--ok)"></span>${run} running</span>${bad ? `<span class="g" style="color:var(--err)"><span class="dot" style="background:var(--err)"></span>${bad} failed</span>` : ""}${agents ? `<span class="g" style="color:var(--agent)"><span class="ts running" style="width:10px;height:10px"></span>${agents} agent${agents > 1 ? "s" : ""}</span>` : ""}${extra}<span class="sp"></span><button class="sbtn t3s${calling ? " calling" : ""}" data-t3="${h.state}" data-k="t3-status" title="T3 Code connection"><span class="dot"></span>${h.label}<span class="busy spin"><i class="ph ph-circle-notch"></i></span></button><button class="sbtn on"><i class="ph ph-robot"></i>companion</button><button class="sbtn" title="MCP server for agents"><i class="ph ph-plugs-connected"></i>mcp :38417</button>`;
  };
  ui.alertBar = () => (S.alert ? `<div class="alert" role="alert" style="display:flex;align-items:center;gap:8px;padding:6px 12px;background:color-mix(in srgb,var(--err) 12%,transparent);color:var(--err);font-size:12.5px"><i class="ph ph-x-circle"></i><span class="grow">${esc(S.alert.text)}</span><button class="btn btn-ghost sm" data-k="alert-act" style="color:inherit;border-color:currentColor">${esc(S.alert.act.label)}</button><button class="ib sm" data-k="alert-x" aria-label="Dismiss" style="color:inherit"><i class="ph ph-x"></i></button></div>` : "");

  /* ───────── global actions (data-k) ───────── */
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-k]");
    if (!b || b.disabled) return;
    const d = b.dataset;
    const act = {
      start: () => K.app.start(d.id),
      stop: () => K.app.stop(d.id),
      restart: () => K.app.restart(d.id),
      "open-port": () => K.app.open(d.id),
      fix: () => ui.fixSheet(d.id),
      "fix-copy": () => K.copy(K.fixPrompt(d.id), "Fix prompt"),
      "focus-thread": () => K.emit("focus-thread", d.id),
      "t3-open": () => K.t3.open(d.wt),
      "t3-add": () => K.t3.addProject(d.wt),
      "t3-status": () => ui.t3Dialog(),
      "t3-recheck": () => (K.pollNow(), K.toast("Checking T3…", { icon: "ph-arrows-clockwise", ms: 1500 })),
      pr: () => K.toast(`Opened ${d.url.replace("https://", "")}`, { icon: "ph-git-pull-request" }),
      link: () => K.toast(`Opened ${d.url.replace("https://", "").slice(0, 48)}…`, { icon: "ph-arrow-square-out" }),
      copy: () => K.copy(d.text, "Link"),
      toast: () => K.toast(d.msg, { icon: "ph-arrow-square-out" }),
      close: () => K.dlg.close(),
      "send-sel": () => ui.sendSheet(),
      "sel-clear": () => (S.sel.clear(), K.changed(), K.emit("render")),
      "sel-copy": () => K.copy(S.logs.filter((l) => S.sel.has(l.seq)).map((l) => `${K.hms(l.ts)} ${LV[l.level]} ${l.text}`).join("\n"), `${S.sel.size} lines`),
      resend: () => K.t3.retrySend(d.th, +d.mid),
      "alert-act": () => S.alert?.act.run(),
      "alert-x": () => ((S.alert = null), K.changed()),
      theme: () => K.toggleTheme(),
      palette: () => K.palette.open(),
      "compose-send": () => composeSend(d.th),
      "new-thread": () => newThread(d.wt),
    }[d.k];
    if (act) {
      e.stopPropagation();
      act();
    }
  });
  async function composeSend(threadId) {
    const ta = $(`[data-compose="${threadId}"]`);
    const text = ta?.value.trim();
    if (!text) return ta?.focus();
    ta.value = "";
    try {
      await K.t3.send(threadId, text);
    } catch {}
  }
  async function newThread(wtId) {
    const ta = $(`[data-newthread="${wtId}"]`);
    const text = ta?.value.trim();
    if (!text) return ta?.focus();
    ta.value = "";
    try {
      const id = await K.t3.start(wtId, text);
      K.emit("focus-thread", id);
    } catch (e) {
      ta.value = text;
      K.toast(`Couldn't start the thread: ${e.message}`, { kind: "bad", icon: "ph-x-circle", ms: 6000 });
    }
  }
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === "k") (e.preventDefault(), $("#pal.on") ? K.palette.close() : K.palette.open());
    else if (mod && e.shiftKey && k === "l") (e.preventDefault(), K.toggleTheme());
    else if (mod && k === "enter" && e.target.dataset?.compose) composeSend(e.target.dataset.compose);
    else if (mod && k === "enter" && e.target.dataset?.newthread) newThread(e.target.dataset.newthread);
    else if (k === "escape" && K.dlg.el) K.dlg.close();
    else if (k === "escape" && $("#pal.on")) K.palette.close();
  });
  K.on("thread-changed", ({ id, to }) => {
    const th = S.threads[id];
    if (to === "waiting") K.toast(`${th.title}: waiting for your approval in T3`, { kind: "warn", icon: "ph-hand-palm", ms: 5000, action: { label: "View", run: () => K.emit("focus-thread", id) } });
    if (to === "completed") K.toast(`${th.title}: the agent finished`, { kind: "agent", icon: "ph-check-circle", ms: 4500, action: { label: "View", run: () => K.emit("focus-thread", id) } });
  });

  /* ───────── demo controls: scenarios a reviewer can jump between ───────── */
  K.demo = (hooks) => {
    const fab = document.createElement("button");
    fab.className = "demo-fab";
    fab.innerHTML = `<i class="ph ph-flask"></i>DEMO`;
    fab.title = "Scenarios and degraded T3 (not part of the design) · press ` to toggle";
    const p = document.createElement("div");
    p.className = "demo";
    document.body.append(fab, p);
    const modes = [["ok", "T3 healthy"], ["missing", "Not installed"], ["down", "Server down"], ["slow", "CLI slow / timeout"]];
    const draw = () =>
      (p.innerHTML = `<h4>Scenarios</h4><div class="grid">
        <button data-s="morning">1 · Morning</button><button data-s="fix">2 · Failure → fix</button><button data-s="waiting">2b · Waiting for you</button><button data-s="approve">Approve in T3 (simulate)</button><button data-s="send">3 · Send log lines</button><button data-s="day">5 · Day-to-day</button></div>
        <h4>4 · T3 availability</h4><div class="grid">${modes.map(([m, l]) => `<button data-m="${m}" aria-pressed="${S.mode === m}">${l}</button>`).join("")}<button data-u aria-pressed="${S.unreg}">PAYMENT-9987 not a T3 project</button></div>
        <h4>View</h4><div class="grid"><button data-t>Toggle theme</button><button data-n aria-pressed="${document.documentElement.classList.contains("narrow")}">720 × 560</button><button data-pal>Ctrl K palette</button></div>
        <p>Calls to <code>t3</code> are simulated with real-ish latency (0.4–0.9 s; slow mode 6 s, list calls time out at 10 s). Spawner only learns about T3 changes when it polls.</p>`);
    draw();
    const toggle = () => p.classList.toggle("on");
    fab.onclick = toggle;
    document.addEventListener("keydown", (e) => e.key === "`" && !/INPUT|TEXTAREA/.test(e.target.tagName) && toggle());
    p.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.m) {
        S.mode = b.dataset.m;
        S.poll.lastErr = null;
        K.pollNow();
      }
      if ("u" in b.dataset) {
        S.unreg = !S.unreg;
        if (!S.unreg) delete S.seen["c:\\dev\\payment-9987"];
        K.pollNow();
      }
      if ("t" in b.dataset) K.toggleTheme();
      if ("pal" in b.dataset) K.palette.open();
      if ("n" in b.dataset) {
        document.documentElement.classList.toggle("narrow");
        setTimeout(() => K.emit("resize"), 520);
      }
      if (b.dataset.s) await K.scenario(b.dataset.s, hooks);
      draw();
      K.changed();
    });
  };
  K.scenario = async (s, hooks = {}) => {
    K.dlg.close();
    if (s === "approve") {
      if (!K.approveInT3()) K.toast("Nothing is waiting for approval right now", { icon: "ph-info", kind: "warn" });
      return;
    }
    if (s === "fix" || s === "waiting") {
      S.mode = "ok";
      hooks.focusWt?.("PAYMENT-9987");
      if (s === "waiting" && !S.fixes[ID.acc]) {
        const f = (S.fixes[ID.acc] = { phase: "starting", startedAt: Date.now() });
        K.changed();
        const id = await K.t3.start("PAYMENT-9987", K.fixPrompt(ID.acc), { title: K.fixTitle(ID.acc), inst: ID.acc });
        Object.assign(f, { threadId: id, phase: "thread" });
        hooks.focusThread?.(id);
      } else if (s === "fix") setTimeout(() => $(`[data-k="fix"]`)?.classList.add("nudge"), 400);
    }
    if (s === "send") {
      hooks.focusWt?.("PAYMENT-9986");
      await sleep(250);
      hooks.selectRefund?.();
      await sleep(200);
      ui.sendSheet();
    }
    if (s === "morning") hooks.morning?.();
    if (s === "day") hooks.day?.();
  };
  /** Deep links for screenshots: #fix, #waiting, #send, #mode=down, #narrow */
  K.boot = (hooks) => {
    window.__hooks = hooks;
    K.demo(hooks);
    const h = location.hash.slice(1);
    for (const part of h.split("&").filter(Boolean)) {
      const [k, v] = part.split("=");
      if (k === "mode") S.mode = v;
      else if (k === "unreg") S.unreg = true;
      else if (k === "narrow" || k === "clean") document.documentElement.classList.add(k);
      else if (k === "theme") document.documentElement.dataset.theme = v;
      else setTimeout(() => K.scenario(k, hooks), 900);
    }
  };
})();
