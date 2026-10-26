import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isActive, type InstanceState } from "../api";
import { useContextMenu, type MenuItem } from "../components/ContextMenu";
import { buildRows, clock, colorVar, highlightRegex, matcherFor, type Row } from "../logModel";
import type { InstanceInfo } from "../store";
import { useRowSelection } from "../useRowSelection";
import { activeIds, copyText, restartableIds, restartApp, stopApp } from "./control";
import { clearLogs, isError, type Feed } from "./feed";
import type { LevelFilter, View } from "./view";

/** Rows drawn at most, the same as the main window. */
const MAX_RENDERED = 1_500;

/** Wraps the matches of the search text in `<mark>`. */
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

const Line = memo(function Line({
  row,
  info,
  start,
  solo,
  selected,
  flash,
  re,
  onPick,
}: {
  row: Row;
  info: InstanceInfo | undefined;
  start: boolean;
  solo: boolean;
  selected: boolean;
  flash: boolean;
  re: RegExp | null;
  onPick: (seq: number) => void;
}) {
  const { line, level, frames } = row;
  return (
    <div
      className={`row l-${level}${start ? " run" : ""}${selected ? " sel" : ""}${flash ? " anchor" : ""}`}
      data-seq={line.seq}
      style={{ ["--c" as string]: info ? colorVar(line.instance) : "var(--text-tertiary)" }}
      onClick={() => onPick(line.seq)}
    >
      <span className="t">{clock(line.ts).slice(0, 8)}</span>
      <span className="m">
        {start && !solo && info && (
          <span className="tg">
            {info.appName}
            <i> {info.short}</i>
          </span>
        )}
        {mark(line.text, re)}
        {frames.map((f) => (
          <span key={f.seq} className="fr">
            {"\n"}
            {f.text.replace(/\s+$/, "")}
          </span>
        ))}
      </span>
    </div>
  );
});

const dotClass = (s: InstanceState | undefined) => {
  if (isError(s)) return "bad";
  if (s?.kind === "building" || s?.kind === "starting") return "busy";
  if (s && isActive(s) && s.kind !== "stopping") return "";
  return "stop";
};

const LEVELS: [LevelFilter, string][] = [
  ["all", "All"],
  ["wrn", "Warn"],
  ["err", "Err"],
];

export interface PanelProps {
  feed: Feed;
  names: Map<string, InstanceInfo>;
  view: View;
  patch: (p: Partial<View>) => void;
  /** Pinned with the pointer away: only the last few lines under the same filter. */
  compact: boolean;
  open: boolean;
  height: number;
  side: "left" | "right";
  /** Scroll to this line and highlight it, leaving the filters alone unless they hide it. */
  jump: { seq: number; nonce: number } | null;
  onHide: () => void;
  /** Brings Spawner to the front on this view, optionally changing it first. */
  onOpen: (next?: Partial<View>) => void;
  /** The user starts working in the panel, so it needs keyboard focus. */
  onWork: () => void;
  onInputBlur: () => void;
  toast: (text: string) => void;
}

export function Panel({ feed, names, view, patch, compact, open, height, side, jump, onHide, onOpen, onWork, onInputBlur, toast }: PanelProps) {
  const ctx = useContextMenu();
  const logRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(0);
  const [flash, setFlash] = useState<number | null>(null);

  const rows = useMemo(() => buildRows(feed.logs), [feed.logs]);
  const match = useMemo(() => matcherFor(view.query), [view.query]);
  const re = useMemo(() => highlightRegex(view.query), [view.query]);
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (view.apps.length === 0 || view.apps.includes(r.line.instance)) &&
          (view.level === "all" || (view.level === "wrn" ? r.level === "wrn" || r.level === "err" || r.level === "sys" : r.level === "err")) &&
          (!match || match(r.line.text)),
      ),
    [rows, view.apps, view.level, match],
  );
  const shown = useMemo(() => filtered.slice(-MAX_RENDERED), [filtered]);
  const { sel, pick, clear, onMouseDown } = useRowSelection(useMemo(() => shown.map((r) => r.line.seq), [shown]));

  const ids = useMemo(() => {
    const all = new Set([...Object.keys(feed.states), ...feed.logs.map((l) => l.instance)]);
    const label = (id: string) => names.get(id)?.appName ?? id;
    return [...all].sort((a, b) => label(a).localeCompare(label(b)));
  }, [feed.states, feed.logs, names]);

  const running = Object.values(feed.states).filter(isActive).length;
  const failed = Object.entries(feed.states).filter(([id, s]) => isError(s) && !feed.dismissed.includes(id)).length;

  // ── scrolling ──
  const followRef = useRef(view.follow);
  followRef.current = view.follow;
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const programmatic = useRef(false);
  const freeze = useRef(0);
  /** Where the user had scrolled to before shrinking; null until known, then the saved anchor line says. */
  const saved = useRef<number | null>(null);
  /** The panel mounts fresh each time it opens, so the saved anchor line has to be scrolled back to once its row exists. */
  const restored = useRef(false);
  const anchorRef = useRef(view.anchor);
  anchorRef.current = view.anchor;
  const scrollRaf = useRef(0);

  const anchorTop = (el: HTMLElement) => {
    const seq = anchorRef.current;
    const row = seq === null ? null : el.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    return row ? row.offsetTop : null;
  };

  const toEnd = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => (programmatic.current = false));
  }, []);

  useLayoutEffect(() => {
    if (view.follow || compactRef.current) toEnd();
  }, [shown, view.follow, toEnd]);

  // Shrinking to a few lines pins the log to its end; growing back returns to where the user had scrolled to.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    freeze.current = Date.now() + 500;
    if (compact && restored.current) saved.current = el.scrollTop;
    const t0 = performance.now();
    let raf = 0;
    const loop = () => {
      programmatic.current = true;
      el.scrollTop = compact || followRef.current ? el.scrollHeight : (saved.current ?? anchorTop(el) ?? el.scrollHeight);
      programmatic.current = false;
      if (performance.now() - t0 < 260) raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [compact]);

  // The rows may arrive after the panel mounts, so keep trying until the anchor line is there.
  useLayoutEffect(() => {
    if (restored.current) return;
    const el = logRef.current;
    if (!el) return;
    if (followRef.current) {
      restored.current = true;
      return;
    }
    const top = anchorTop(el);
    if (top === null) return;
    restored.current = true;
    if (compactRef.current) {
      saved.current = top;
      return;
    }
    programmatic.current = true;
    el.scrollTop = top;
    requestAnimationFrame(() => (programmatic.current = false));
  }, [shown]);

  const prevLen = useRef(shown.length);
  useEffect(() => {
    const delta = shown.length - prevLen.current;
    prevLen.current = shown.length;
    if (view.follow || compactRef.current) setPending(0);
    else if (delta > 0) setPending((p) => p + delta);
  }, [shown.length, view.follow]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el || programmatic.current || compactRef.current || Date.now() < freeze.current) return;
    restored.current = true;
    cancelAnimationFrame(scrollRaf.current);
    scrollRaf.current = requestAnimationFrame(() => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (bottom) {
        if (!followRef.current) patch({ follow: true, anchor: null });
        setPending(0);
        return;
      }
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + 60, box.top + 6)?.closest<HTMLElement>(".row");
      patch({ follow: false, ...(top ? { anchor: Number(top.dataset.seq) } : {}) });
    });
  };

  // The error pill asks for a line: scroll to it, or clear filters that hide it first.
  const handled = useRef(0);
  const cleared = useRef(0);
  useEffect(() => {
    if (!jump || handled.current === jump.nonce) return;
    const el = logRef.current;
    const row = el?.querySelector<HTMLElement>(`[data-seq="${jump.seq}"]`);
    if (!el) return;
    if (!row) {
      if (cleared.current !== jump.nonce && rows.some((r) => r.line.seq === jump.seq)) {
        cleared.current = jump.nonce;
        patch({ apps: [], level: "all", query: "" });
        toast("Filters cleared, since they hid the error line");
      }
      return;
    }
    handled.current = jump.nonce;
    patch({ follow: false, anchor: jump.seq });
    const t = window.setTimeout(() => {
      programmatic.current = true;
      el.scrollTop = row.offsetTop - el.clientHeight / 2;
      requestAnimationFrame(() => (programmatic.current = false));
    }, 60);
    setFlash(jump.seq);
    const off = window.setTimeout(() => setFlash(null), 3200);
    return () => (window.clearTimeout(t), window.clearTimeout(off));
  }, [jump, rows, shown, patch, toast]);

  // ── actions ──
  const lineText = (r: Row) =>
    [`${clock(r.line.ts)} ${names.get(r.line.instance)?.appName ?? r.line.instance} ${r.line.text}`, ...r.frames.map((f) => f.text)].join("\n");
  const copy = async (text: string, what: string) => toast((await copyText(text)) ? `${what} copied` : "Could not copy");

  const copySelected = () => {
    const picked = shown.filter((r) => sel.has(r.line.seq));
    void copy(picked.map(lineText).join("\n"), `${picked.length} line${picked.length === 1 ? "" : "s"}`);
    clear();
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && clear();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [clear]);

  const fail = (e: unknown) => toast(String(e));
  const showOnly = (id: string, add: boolean) => {
    const apps = add ? (view.apps.includes(id) ? view.apps.filter((a) => a !== id) : [...view.apps, id]) : view.apps.length === 1 && view.apps[0] === id ? [] : [id];
    patch({ apps, follow: true, anchor: null });
  };

  const menuFor = (id: string | null): MenuItem[] => {
    if (id === null) {
      return [
        { label: "Restart all", icon: "ph ph-arrow-clockwise", run: () => void Promise.all(restartableIds().map(restartApp)).catch(fail) },
        { label: "Stop all", icon: "ph ph-stop", disabled: activeIds().length === 0, run: () => void Promise.all(activeIds().map(stopApp)).catch(fail) },
        "sep",
        { label: "Copy all logs", icon: "ph ph-copy", run: () => void copy(rows.map(lineText).join("\n"), "All logs") },
      ];
    }
    const state = feed.states[id];
    const name = names.get(id)?.appName ?? id;
    return [
      { label: isActive(state) || isError(state) ? "Restart" : "Start", icon: "ph ph-arrow-clockwise", run: () => void restartApp(id).catch(fail) },
      { label: "Stop", icon: "ph ph-stop", disabled: !isActive(state), run: () => void stopApp(id).catch(fail) },
      "sep",
      { label: "Show only this app", icon: "ph ph-funnel", run: () => patch({ apps: [id], follow: true, anchor: null }) },
      { label: "Copy this app’s logs", icon: "ph ph-copy", run: () => void copy(rows.filter((r) => r.line.instance === id).map(lineText).join("\n"), `${name} logs`) },
      { label: "Clear this app’s logs", icon: "ph ph-eraser", run: () => void clearLogs(id).then(() => toast(`Cleared ${name}’s logs`), fail) },
      "sep",
      { label: "Open in Spawner", icon: "ph ph-arrow-square-out", run: () => onOpen({ apps: [id], follow: true, anchor: null }) },
    ];
  };

  const filterLabel = [
    view.apps.length ? (view.apps.length === 1 ? (names.get(view.apps[0])?.appName ?? "1 app") : `${view.apps.length} apps`) : "",
    view.level === "all" ? "" : view.level === "err" ? "Err" : "Warn+",
    view.query ? `“${view.query}”` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const solo = view.apps.length === 1;
  const flashRow = flash;

  return (
    <section className={`pn a${open ? " open" : ""}${compact ? " compact" : ""}`} style={{ height }} onPointerDownCapture={onWork}>
      <div className="hd">
        <b>Spawner</b>
        <span className="sum">
          <span>{running} running</span>
          {failed > 0 && <span className="err-t">{failed} failed</span>}
        </span>
        {filterLabel && <span className="ftag">filter: {filterLabel}</span>}
        <span className="sp" />
        <button
          type="button"
          className={`ib pin${view.pinned ? " on" : ""}`}
          title="Pin: stays on screen and shrinks to 3 lines when you move away"
          onClick={() => patch({ pinned: !view.pinned })}
        >
          <i className={view.pinned ? "ph-fill ph-push-pin" : "ph ph-push-pin"} />
        </button>
        <button type="button" className="ib" title="Open Spawner with this view" onClick={() => onOpen()}>
          <i className="ph ph-arrow-square-out" />
        </button>
        <button type="button" className="ib" title="Hide" onClick={onHide}>
          <i className={`ph ph-caret-double-${side}`} />
        </button>
      </div>

      <div className="fold">
        <div className="foldin">
      <div className="chips">
        <button
          type="button"
          className={`chip${view.apps.length === 0 ? " cur" : ""}`}
          title="Show every app · right-click for options"
          onClick={() => patch({ apps: [], follow: true, anchor: null })}
          onContextMenu={(e) => ctx.show(e, menuFor(null))}
        >
          All apps
        </button>
        {ids.map((id) => {
          const state = feed.states[id];
          const name = names.get(id)?.appName ?? id;
          return (
            <button
              key={id}
              type="button"
              className={`chip${view.apps.includes(id) ? " cur" : ""}`}
              title={`Show only ${name}${names.get(id)?.short ? ` (${names.get(id)?.short})` : ""} · shift-click to add another · right-click for options`}
              onClick={(e) => showOnly(id, e.shiftKey)}
              onContextMenu={(e) => ctx.show(e, menuFor(id))}
            >
              <span className={`dot ${dotClass(state)}`} style={{ ["--c" as string]: colorVar(id) }} />
              {name}
              {names.get(id)?.short && <span className="w">{names.get(id)?.short}</span>}
              {isError(state) && <span className="n">error</span>}
              {!isActive(state) && !isError(state) && <span className="w">stopped</span>}
            </button>
          );
        })}
      </div>

      <div className="tb">
        <div className="field">
          <i className="ph ph-magnifying-glass" />
          <input
            placeholder="Filter logs · text or /regex/"
            aria-label="Filter logs"
            value={view.query}
            onChange={(e) => patch({ query: e.target.value, follow: true, anchor: null })}
            onBlur={onInputBlur}
          />
        </div>
        <div className="seg" role="group" aria-label="Level">
          {LEVELS.map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={v === "err" ? "e" : undefined}
              aria-pressed={view.level === v}
              onClick={() => patch({ level: v, follow: true, anchor: null })}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="ib" title="Copy visible lines" onClick={() => void copy(shown.map(lineText).join("\n"), `${shown.length} lines`)}>
          <i className="ph ph-copy" />
        </button>
        <button
          type="button"
          className={`ib${view.follow ? " on" : ""}`}
          title="Follow output"
          onClick={() => patch({ follow: !view.follow, anchor: null })}
        >
          <i className="ph ph-arrow-line-down" />
        </button>
      </div>
        </div>
      </div>

      <div className="logwrap">
        <div className="log" ref={logRef} onScroll={onScroll} onMouseDown={onMouseDown}>
          {shown.length === 0 && <div className="empty">{feed.logs.length === 0 ? "No output yet" : "No lines match these filters"}</div>}
          {shown.map((r, i) => (
            <Line
              key={r.line.seq}
              row={r}
              info={names.get(r.line.instance)}
              start={i > 0 && shown[i - 1].line.instance !== r.line.instance}
              solo={solo}
              selected={sel.has(r.line.seq)}
              flash={flashRow === r.line.seq}
              re={re}
              onPick={pick}
            />
          ))}
        </div>
        <button
          type="button"
          className={`jump${!view.follow && pending > 0 && sel.size === 0 ? " on" : ""}`}
          onClick={() => (patch({ follow: true, anchor: null }), setPending(0))}
        >
          <i className="ph ph-arrow-down" />
          <span>
            {pending} new line{pending === 1 ? "" : "s"}
          </span>
        </button>
        <div className={`float${sel.size > 0 ? " on" : ""}`}>
          <div className="selbar">
            <span className="c">
              {sel.size} line{sel.size === 1 ? "" : "s"}
            </span>
            <button type="button" className="btn pri" onClick={copySelected}>
              <i className="ph ph-copy" />
              Copy
            </button>
            <button type="button" className="ib" title="Clear selection (Esc)" onClick={clear}>
              <i className="ph ph-x" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

