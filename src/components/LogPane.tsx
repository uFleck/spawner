import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { isActive, type LogLine } from "../api";
import { buildRows, clock, colorVar, highlightRegex, isOwnFrame, matcherFor, squashRows, type Level, type Row, type Run } from "../logModel";
import { actions, indexInstances, type InstanceInfo, type Snapshot } from "../store";
import { useContextMenu } from "./ContextMenu";
import { IconButton } from "./IconButton";

const MAX_RENDERED = 1_500;
const MAX_TICKS = 400;

type LevelFilter = "all" | "wrn" | "err";

interface Props {
  snap: Snapshot;
  hidden: Set<string>;
  selected: string | null;
  follow: boolean;
  onFollow: (v: boolean) => void;
  onHidden: (next: Set<string>) => void;
  /** Focuses one app's log, or undoes that when it is already the only one shown. */
  onFocus: (id: string) => void;
  onToast: (text: string) => void;
  onToggleSide: () => void;
}

const TOK = /\b(GET|POST|PUT|DELETE|PATCH)\b|→ (\d{3})|\((\d+ms)\)|\b(\w+)=([\w.\-]+)|"([^"]+)"/g;

function mark(text: string, re: RegExp | null): ReactNode {
  if (!re) return text;
  const out: ReactNode[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<mark key={m.index}>{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  if (last === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Msg({ text, re }: { text: string; re: RegExp | null }) {
  const out: ReactNode[] = [];
  let last = 0;
  TOK.lastIndex = 0;
  for (let m = TOK.exec(text); m; m = TOK.exec(text)) {
    if (m.index > last) out.push(mark(text.slice(last, m.index), re));
    const k = m.index;
    if (m[1]) out.push(<span key={k} className="http">{mark(m[1], re)}</span>);
    else if (m[2])
      out.push(
        <span key={k}>
          → <span className={`http ${+m[2] < 300 ? "ok" : +m[2] < 400 ? "redir" : "bad"}`}>{m[2]}</span>
        </span>,
      );
    else if (m[3]) out.push(<span key={k}>(<span className="dur">{mark(m[3], re)}</span>)</span>);
    else if (m[4]) out.push(<span key={k} className="kv">{mark(m[4], re)}=<b>{mark(m[5], re)}</b></span>);
    else out.push(<span key={k} className="str">"{mark(m[6], re)}"</span>);
    last = k + m[0].length;
  }
  if (last < text.length) out.push(mark(text.slice(last), re));
  return <>{out}</>;
}

const LV_LABEL: Record<Level, string> = { inf: "INF", dbg: "DBG", wrn: "WRN", err: "ERR", sys: "hub" };

const LogRow = memo(function LogRow({
  row,
  run,
  expanded,
  info,
  start,
  fresh,
  selected,
  showTime,
  fw,
  re,
  onPick,
  onToggleRun,
}: {
  row: Row;
  run: Run | undefined;
  expanded: boolean;
  info: InstanceInfo | undefined;
  start: boolean;
  fresh: boolean;
  selected: boolean;
  showTime: boolean;
  fw: boolean;
  re: RegExp | null;
  onPick: (line: LogLine) => void;
  onToggleRun: (seq: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [isFresh] = useState(fresh);
  const { line, level, frames } = row;
  const own = frames.filter(isOwnFrame).length;
  return (
    <div
      className={`row l-${level}${start ? " run-start" : ""}${selected ? " sel" : ""}${isFresh ? " fresh" : ""}`}
      data-seq={line.seq}
      style={{ ["--c" as string]: info ? colorVar(line.instance) : "var(--text-tertiary)" }}
      onClick={() => onPick(line)}
    >
      <span className="t">{showTime ? clock(line.ts) : ""}</span>
      <span className="src">
        {start && info ? (
          <>
            {info.appName} <span className="w">{info.short}</span>
          </>
        ) : null}
      </span>
      <span className="lv">{LV_LABEL[level]}</span>
      <span className="msg">
        <Msg text={line.text} re={re} />
        {run && (
          <button
            type="button"
            className="fold rep"
            aria-expanded={expanded}
            title={`${run.rows.length} similar lines · last at ${clock(run.rows[run.rows.length - 1].line.ts)}`}
            onClick={(e) => (e.stopPropagation(), onToggleRun(line.seq))}
          >
            <i className="ph ph-caret-right" />×{run.rows.length}
          </button>
        )}
        {frames.length > 0 && (
          <button
            type="button"
            className="fold"
            aria-expanded={open}
            onClick={(e) => (e.stopPropagation(), setOpen(!open))}
          >
            <i className="ph ph-caret-right" />
            {frames.length} frames
          </button>
        )}
      </span>
      {frames.length > 0 && (
        <div className={`trace${open ? " open" : ""}${fw ? " fw" : ""}`} onClick={(e) => e.stopPropagation()}>
          <div className="in">
            <div className="pad">
              <div className="trace-bar">
                <span>
                  {own} in your code · {frames.length - own} in framework
                </span>
                <button type="button" onClick={() => void navigator.clipboard.writeText(frames.map((f) => f.text).join("\n"))}>
                  Copy trace
                </button>
              </div>
              {frames.map((f) => (
                <div key={f.seq} className={`f ${isOwnFrame(f) ? "own" : "fwf"}`}>
                  {f.text.trim()}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

function Seg({ value, onChange }: { value: LevelFilter; onChange: (v: LevelFilter) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const b = host.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!b || !thumb.current) return;
      thumb.current.style.width = `${b.offsetWidth}px`;
      thumb.current.style.transform = `translateX(${b.offsetLeft - 2}px)`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(host.current!);
    return () => ro.disconnect();
  }, [value]);
  const items: [LevelFilter, string, string | null][] = [
    ["all", "All", null],
    ["wrn", "Warn+", "w"],
    ["err", "Errors", "e"],
  ];
  return (
    <div className="seg" ref={host} role="group" aria-label="Level">
      <span className="thumb" ref={thumb} />
      {items.map(([v, label, dot]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {dot ? <span className={`ld ${dot}`} /> : null}
          <span className="tx">{label}</span>
        </button>
      ))}
    </div>
  );
}

export function LogPane({ snap, hidden, selected, follow, onFollow, onHidden, onFocus, onToast, onToggleSide }: Props) {
  const instances = useMemo(() => indexInstances(snap.groups), [snap.groups]);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [showSys, setShowSys] = useState(true);
  const [showTime, setShowTime] = useState(true);
  const [fw, setFw] = useState(false);
  const [squash, setSquash] = useState(true);
  const [openRuns, setOpenRuns] = useState<Set<number>>(new Set());
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState(0);
  const [menu, setMenu] = useState<{ top: number; right: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const vp = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);
  const seen = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const ctx = useContextMenu();

  const rows = useMemo(() => buildRows(snap.logs), [snap.logs]);

  const counts = useMemo(() => {
    const m = new Map<string, { n: number; err: number }>();
    for (const r of rows) {
      const c = m.get(r.line.instance) ?? { n: 0, err: 0 };
      c.n++;
      if (r.level === "err") c.err++;
      m.set(r.line.instance, c);
    }
    return m;
  }, [rows]);

  const filtered = useMemo(() => {
    const match = matcherFor(query);
    return rows.filter(
      (r) =>
        !hidden.has(r.line.instance) &&
        (showSys || r.level !== "sys") &&
        (level === "all" || (level === "wrn" ? r.level === "wrn" || r.level === "err" || r.level === "sys" : r.level === "err")) &&
        (!match || match(r.line.text)),
    );
  }, [rows, hidden, query, showSys, level]);

  const runs = useMemo(
    () => (squash ? squashRows(filtered) : filtered.map((r): Run => ({ rows: [r] }))).slice(-MAX_RENDERED),
    [filtered, squash],
  );

  /** Every line behind the visible rows, including the ones a collapsed run hides. */
  const lines = useMemo(() => runs.flatMap((r) => r.rows), [runs]);

  const collapsible = useMemo(() => new Map(runs.filter((r) => r.rows.length > 1).map((r) => [r.rows[0].line.seq, r])), [runs]);

  const visible = useMemo(
    () => runs.flatMap((r) => (r.rows.length > 1 && openRuns.has(r.rows[0].line.seq) ? r.rows : [r.rows[0]])),
    [runs, openRuns],
  );

  const toggleRun = useCallback(
    (seq: number) =>
      setOpenRuns((cur) => {
        const next = new Set(cur);
        if (!next.delete(seq)) next.add(seq);
        return next;
      }),
    [],
  );

  const re = useMemo(() => highlightRegex(query), [query]);

  const failed = useMemo(
    () =>
      Object.entries(snap.states)
        .filter(([, s]) => s.kind === "failed")
        .flatMap(([id, s]) => (s.kind === "failed" ? [{ id, message: s.message }] : [])),
    [snap.states],
  );

  useLayoutEffect(() => {
    const el = scroller.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [visible, failed, follow]);

  useEffect(() => {
    const delta = lines.length - prevLen.current;
    prevLen.current = lines.length;
    if (follow) setPending(0);
    else if (delta > 0) setPending((p) => p + delta);
  }, [lines.length, follow]);

  const syncVp = useCallback(() => {
    const el = scroller.current;
    const v = vp.current;
    if (!el || !v) return;
    const h = el.scrollHeight || 1;
    v.style.top = `${(el.scrollTop / h) * 100}%`;
    v.style.height = `${Math.max(6, (el.clientHeight / h) * 100)}%`;
  }, []);
  useLayoutEffect(syncVp, [visible, syncVp]);

  const ticks = useMemo(() => {
    const n = visible.length || 1;
    const marks = visible.flatMap((r, i) => (r.level === "err" || r.level === "wrn" ? [{ r, top: (i / n) * 100 }] : []));
    return marks.slice(-MAX_TICKS);
  }, [visible]);

  const selRef = useRef(sel);
  selRef.current = sel;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const dragged = useRef(false);

  const pick = useCallback((line: LogLine) => {
    if (dragged.current || !window.getSelection()?.isCollapsed) return;
    setSel((cur) => {
      const next = new Set(cur);
      if (!next.delete(line.seq)) next.add(line.seq);
      return next;
    });
  }, []);

  // Holding the left button and moving across rows selects every row in between.
  // Staying inside the starting row leaves the native text selection alone.
  const onLogMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    const host = e.currentTarget;
    const target = e.target as HTMLElement;
    const startRow = target.closest<HTMLElement>(".row");
    if (e.button !== 0 || !startRow || target.closest("button, .trace")) return;
    const seqs = visibleRef.current.map((r) => r.line.seq);
    const index = new Map(seqs.map((s, i) => [s, i]));
    const from = index.get(Number(startRow.dataset.seq));
    if (from === undefined) return;
    const base = selRef.current;
    let y = e.clientY;
    let moved = false;

    const rowIndexAtPointer = () => {
      const box = host.getBoundingClientRect();
      const el = document.elementFromPoint(box.left + 40, Math.min(Math.max(y, box.top + 1), box.bottom - 1));
      const row = el?.closest<HTMLElement>(".row");
      return (row && index.get(Number(row.dataset.seq))) ?? -1;
    };
    const update = () => {
      const to = rowIndexAtPointer();
      if (to < 0 || (!moved && to === from)) return;
      if (!moved) {
        moved = true;
        dragged.current = true;
        host.classList.add("dragging");
        window.getSelection()?.removeAllRanges();
      }
      setSel(new Set([...base, ...seqs.slice(Math.min(from, to), Math.max(from, to) + 1)]));
    };
    const block = (ev: Event) => moved && ev.preventDefault();
    const move = (ev: globalThis.MouseEvent) => {
      if (ev.buttons === 0) return stop();
      y = ev.clientY;
      update();
    };
    const autoscroll = window.setInterval(() => {
      if (!moved) return;
      const box = host.getBoundingClientRect();
      const d = y < box.top + 24 ? y - (box.top + 24) : y > box.bottom - 24 ? y - (box.bottom - 24) : 0;
      if (!d) return;
      host.scrollTop += Math.max(-30, Math.min(30, d / 2));
      update();
    }, 30);
    function stop() {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.removeEventListener("selectstart", block);
      window.clearInterval(autoscroll);
      host.classList.remove("dragging");
      // the click that follows mouseup must not toggle the row we ended on
      if (moved) window.setTimeout(() => (dragged.current = false), 0);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    document.addEventListener("selectstart", block);
  };

  const jumpTo = (seq: number) => {
    const el = scroller.current;
    const row = el?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!el || !row) return;
    onFollow(false);
    el.classList.add("smooth");
    el.scrollTop = row.offsetTop - 80;
    window.setTimeout(() => el.classList.remove("smooth"), 700);
  };

  const copySelected = async () => {
    const text = rows
      .filter((r) => sel.has(r.line.seq))
      .flatMap((r) => (collapsible.has(r.line.seq) && !openRuns.has(r.line.seq) ? collapsible.get(r.line.seq)!.rows : [r]))
      .map((r) => `${clock(r.line.ts)} ${instances.get(r.line.instance)?.appName ?? r.line.instance} ${r.line.text}`)
      .join("\n");
    await navigator.clipboard.writeText(text);
    onToast(`${sel.size} line${sel.size === 1 ? "" : "s"} copied`);
    setSel(new Set());
  };

  const toggleSource = (id: string) => {
    const next = new Set(hidden);
    if (!next.delete(id)) next.add(id);
    onHidden(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).tagName === "INPUT";
      if (e.key === "/" && !typing) (e.preventDefault(), searchRef.current?.focus());
      else if (e.key === "Escape") setSel(new Set());
      else if (e.key === "End" && !typing) onFollow(true);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") (e.preventDefault(), void actions.clearLogs());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onFollow]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("#menu, #more")) setMenu(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);

  const watermark = seen.current ?? (visible.length ? visible[visible.length - 1].line.seq : 0);
  useEffect(() => {
    if (visible.length) seen.current = Math.max(seen.current ?? 0, visible[visible.length - 1].line.seq);
  }, [visible]);

  const sources = [...counts.keys()].filter((id) => instances.has(id));
  let prevInstance = "";

  const opts: { icon: string; label: string; kbd?: string; pressed?: boolean; danger?: boolean; run: () => void }[] = [
    { icon: "ph ph-info", label: "Hub messages", pressed: showSys, run: () => setShowSys(!showSys) },
    { icon: "ph ph-clock", label: "Timestamps", pressed: showTime, run: () => setShowTime(!showTime) },
    { icon: "ph ph-stack-simple", label: "Framework stack frames", pressed: fw, run: () => setFw(!fw) },
    { icon: "ph ph-arrows-in-line-vertical", label: "Collapse similar lines", pressed: squash, run: () => setSquash(!squash) },
    { icon: "ph ph-arrow-line-down", label: "Follow output", kbd: "End", pressed: follow, run: () => onFollow(!follow) },
    {
      icon: "ph ph-download-simple",
      label: "Export visible lines",
      run: () => {
        const text = lines.map((r) => `${clock(r.line.ts)} ${r.line.text}`).join("\n");
        void navigator.clipboard.writeText(text);
        onToast(`${lines.length} lines copied`);
      },
    },
    { icon: "ph ph-trash", label: "Clear logs", kbd: "Ctrl L", danger: true, run: () => void actions.clearLogs() },
  ];

  return (
    <main className="logpane">
      <header className="toolbar" id="toolbar" data-tauri-drag-region>
        <IconButton icon="ph ph-sidebar-simple" label="Toggle sidebar" kbd="Ctrl B" onClick={onToggleSide} />
        <label className="field">
          <i className="ph ph-magnifying-glass" />
          <input
            ref={searchRef}
            placeholder="Filter logs · text or /regex/"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim() && <span className="count">{lines.length} lines</span>}
          <span className="kbd">/</span>
        </label>
        <span className="sep" />
        <Seg value={level} onChange={setLevel} />
        <span className="grow" data-tauri-drag-region />
        {opts.map((o, i) => (
          <span key={o.label} className="opt-wrap">
            {i === 5 && <span className="sep opt" />}
            <IconButton
              className={`opt${o.danger ? " danger" : ""}`}
              icon={o.icon}
              label={o.label}
              kbd={o.kbd}
              pressed={o.pressed}
              onClick={o.run}
            />
          </span>
        ))}
        <IconButton
          id="more"
          className="more"
          icon="ph ph-dots-three-outline-vertical"
          label="More options"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu(menu ? null : { top: r.bottom + 8, right: innerWidth - r.right });
          }}
        />
      </header>

      {menu && (
        <div className="menu on" id="menu" style={{ top: menu.top, right: menu.right }}>
          {opts.map((o) => (
            <button key={o.label} type="button" className={o.danger ? "danger" : ""} aria-pressed={o.pressed} onClick={o.run}>
              <i className={o.icon} />
              {o.label}
              {o.pressed !== undefined ? <i className="ph-bold ph-check tick" /> : o.kbd ? <span className="kbd">{o.kbd}</span> : null}
            </button>
          ))}
        </div>
      )}

      {sources.length > 0 && (
        <div className="sources">
          {sources.map((id) => {
            const info = instances.get(id)!;
            const c = counts.get(id)!;
            return (
              <div
                key={id}
                className={`chip${hidden.has(id) ? " off" : ""}${selected === id ? " cur" : ""}`}
                style={{ ["--c" as string]: colorVar(id) }}
              >
                <button
                  type="button"
                  className="chip-main"
                  aria-pressed={!hidden.has(id)}
                  data-tip="Ctrl + click: focus only this one"
                  onClick={(e) => (e.ctrlKey || e.metaKey ? onFocus(id) : toggleSource(id))}
                >
                  <span className="cd" />
                  {info.appName}
                  <span className="w">{info.group.label}</span>
                  <span className="n">{c.n}</span>
                  {c.err > 0 && <span className="n e">{c.err} err</span>}
                </button>
                <button
                  type="button"
                  className="chip-x"
                  aria-label={isActive(snap.states[id]) ? `Stop ${info.appName}` : `Close ${info.appName}`}
                  data-tip={isActive(snap.states[id]) ? "Close (stops the app)" : "Close (clears its log)"}
                  onClick={() => {
                    if (isActive(snap.states[id])) return void actions.stop(id);
                    if (!hidden.has(id) && sources.every((s) => s === id || hidden.has(s))) onFocus(id);
                    void actions.clearLogs(id);
                  }}
                >
                  <i className="ph ph-x" aria-hidden="true" />
                </button>
              </div>
            );
          })}
          <div className="sources-act">
            <button
              type="button"
              className="chip-act"
              disabled={sources.every((id) => isActive(snap.states[id]))}
              data-tip="Clear the logs of apps that are not running"
              onClick={() => {
                const kept = sources.filter((id) => isActive(snap.states[id]));
                if (kept.length && kept.every((id) => hidden.has(id))) onHidden(new Set());
                void actions.cleanStopped();
              }}
            >
              <i className="ph ph-broom" aria-hidden="true" />
              Clean
            </button>
            <button
              type="button"
              className="chip-act danger"
              data-tip="Stop every app and clear all logs"
              onClick={() => {
                onHidden(new Set());
                void actions.closeAll();
              }}
            >
              <i className="ph ph-x-circle" aria-hidden="true" />
              Close all
            </button>
          </div>
        </div>
      )}

      {snap.error && (
        <div className="alert" role="alert">
          <i className="ph ph-x-circle" aria-hidden="true" />
          <span>{snap.error}</span>
          {snap.portConflict && (
            <button
              type="button"
              className="alert-act"
              onClick={() => {
                const { projectId, appId } = snap.portConflict!;
                void actions.start(projectId, appId, true);
              }}
            >
              Use anyway
            </button>
          )}
          <IconButton small icon="ph ph-x" label="Dismiss" onClick={actions.dismissError} />
        </div>
      )}

      <div className="logwrap">
        <div
          className="log"
          ref={scroller}
          onMouseDown={onLogMouseDown}
          onContextMenu={(e) => {
            const seq = Number((e.target as HTMLElement).closest<HTMLElement>("[data-seq]")?.dataset.seq);
            const hit = Number.isNaN(seq) ? undefined : rows.find((r) => r.line.seq === seq);
            const picked = window.getSelection()?.toString() ?? "";
            ctx.show(e, [
              ...(picked ? [{ label: "Copy selected text", icon: "ph ph-copy", run: () => ctx.copy(picked, "Text") }] : []),
              ...(hit
                ? [
                    { label: "Copy line", icon: "ph ph-copy-simple", run: () => ctx.copy(hit.line.text, "Line") },
                    { label: sel.has(seq) ? "Deselect line" : "Select line", icon: "ph ph-check-square", run: () => pick(hit.line) },
                    "sep" as const,
                  ]
                : []),
              { label: "Follow output", icon: "ph ph-arrow-line-down", run: () => onFollow(!follow) },
              { label: "Copy visible lines", icon: "ph ph-download-simple", run: () => ctx.copy(lines.map((r) => `${clock(r.line.ts)} ${r.line.text}`).join("\n"), `${lines.length} lines`) },
              "sep",
              { label: "Clear logs", icon: "ph ph-trash", danger: true, run: () => void actions.clearLogs() },
            ]);
          }}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            if (atBottom && !follow) onFollow(true);
            else if (!atBottom && follow) onFollow(false);
            syncVp();
          }}
        >
          {visible.map((r) => {
            const start = r.line.instance !== prevInstance;
            prevInstance = r.line.instance;
            return (
              <LogRow
                key={r.line.seq}
                row={r}
                run={collapsible.get(r.line.seq)}
                expanded={openRuns.has(r.line.seq)}
                info={instances.get(r.line.instance)}
                start={start}
                fresh={seen.current !== null && r.line.seq > watermark}
                selected={sel.has(r.line.seq)}
                showTime={showTime}
                fw={fw}
                re={re}
                onPick={pick}
                onToggleRun={toggleRun}
              />
            );
          })}
          {visible.length === 0 && (
            <p className="empty">{rows.length ? "No lines match." : "No log output yet. Run an app from the sidebar."}</p>
          )}
          {failed.map((f) => {
            const info = instances.get(f.id);
            return (
              <div key={f.id} className="failcard">
                <i className="ph-fill ph-warning-octagon" />
                <div className="tx">
                  <b>{info?.appName ?? f.id} didn’t start</b>
                  <code>{f.message}</code>
                </div>
                {info && (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        const [projectId, appId] = f.id.split("::");
                        void actions.start(projectId, appId);
                      }}
                    >
                      <i className="ph ph-arrow-clockwise" />
                      Retry
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="dens">
          {ticks.map(({ r, top }) => (
            <i key={r.line.seq} className={r.level === "wrn" ? "w" : ""} style={{ top: `${top}%` }} onClick={() => jumpTo(r.line.seq)} />
          ))}
          <div className="vp" ref={vp} />
        </div>
        <div className={`float${!follow && pending > 0 && sel.size === 0 ? " on" : ""}`}>
          <button type="button" className="jump" onClick={() => onFollow(true)}>
            <i className="ph ph-arrow-down" />
            {pending} new line{pending === 1 ? "" : "s"}
          </button>
        </div>
        <div className={`float${sel.size > 0 ? " on" : ""}`}>
          <div className="selbar">
            <span className="c">
              {sel.size} line{sel.size === 1 ? "" : "s"}
            </span>
            <button type="button" className="btn btn-primary" onClick={() => void copySelected()}>
              <i className="ph ph-copy" />
              Copy
            </button>
            <IconButton icon="ph ph-x" label="Clear selection" kbd="Esc" onClick={() => setSel(new Set())} />
          </div>
        </div>
      </div>
    </main>
  );
}
