import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, isActive, isErrorExit, parseInstanceId, type InstanceState, type LogLine } from "../api";
import spawnerIcon from "../assets/spawner.svg";
import { indexInstances } from "../store";
import { dismiss, KEEP, useFeed } from "./feed";
import { anchorOfWindow, loadAnchor, place, saveAnchor, type Anchor } from "./place";
import "./companion.css";

/** Rows shown before the rest are summed up as "+N more". */
const ROWS = 6;
/** An app counts as printing right now for this long after its last line. */
const HOT_MS = 1_500;
/** The card fades back after this long without a line from any app. */
const QUIET_MS = 12_000;
const TUCK_KEY = "companion-tucked";

const isError = (s: InstanceState | undefined) => s?.kind === "failed" || isErrorExit(s);

function describe(s: InstanceState): string {
  switch (s.kind) {
    case "building":
      return "building…";
    case "starting":
      return "starting…";
    case "stopping":
      return "stopping…";
    case "exited":
      return s.code == null ? "stopped" : `exited with code ${s.code}`;
    case "failed":
      return s.message;
    default:
      return "running";
  }
}

const stateClass = (s: InstanceState) =>
  isError(s) ? "bad" : s.kind === "building" || s.kind === "starting" ? "busy" : s.kind === "stopping" ? "stopping" : "ok";

/** Follows the main window's theme, which it keeps in the shared localStorage. */
function useTheme() {
  useEffect(() => {
    const apply = () => {
      const saved = localStorage.getItem("hub-theme");
      document.documentElement.dataset.theme =
        saved === "dark" || saved === "light" ? saved : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    };
    apply();
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, []);
}

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function Companion() {
  useTheme();
  const feed = useFeed();
  const now = useNow(500);
  const [tucked, setTucked] = useState(() => localStorage.getItem(TUCK_KEY) === "1");
  const [anchor, setAnchor] = useState<Anchor>(loadAnchor);
  const [hover, setHover] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const press = useRef<{ x: number; y: number } | null>(null);

  const names = useMemo(() => indexInstances(feed.groups), [feed.groups]);
  const rows = useMemo(() => {
    const label = (id: string) => names.get(id)?.appName ?? parseInstanceId(id).appId;
    return Object.entries(feed.states)
      .filter(([id, s]) => isActive(s) || (isError(s) && !feed.dismissed.includes(id)))
      .sort(([a, sa], [b, sb]) => Number(isError(sb)) - Number(isError(sa)) || label(a).localeCompare(label(b)))
      .map(([id, state]) => ({ id, state, name: label(id), short: names.get(id)?.short ?? "", last: feed.recent[id]?.[feed.recent[id].length - 1] }));
  }, [feed.states, feed.dismissed, feed.recent, names]);

  const running = rows.filter((r) => isActive(r.state)).length;
  const errors = rows.length - running;
  const hot = (id: string) => now - (feed.heard[id] ?? 0) < HOT_MS;
  const talking = rows.some((r) => hot(r.id));
  const quiet = rows.every((r) => now - (feed.heard[r.id] ?? 0) > QUIET_MS);
  const shown = rows.slice(0, ROWS);
  const focused = hover && rows.find((r) => r.id === hover);

  // The window is exactly as big as what it shows, so the desktop around it stays clickable.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (dragging.current) return;
        const r = el.getBoundingClientRect();
        void place(anchor, r.width, r.height);
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    // Moving onto a monitor with another scale lets Windows resize the window on its own; measure again.
    const off = getCurrentWindow().onScaleChanged(fit);
    return () => (observer.disconnect(), cancelAnimationFrame(frame), void off.then((fn) => fn()));
  }, [anchor]);

  /** Resolves when the user lets go; the window then snaps to the nearer side edge, or back to where it was. */
  const drag = useCallback(async () => {
    dragging.current = true;
    let next: Anchor | null = null;
    try {
      await api.companionDrag();
      next = await anchorOfWindow();
    } finally {
      dragging.current = false;
      if (next) saveAnchor(next);
      setAnchor((a) => next ?? { ...a });
    }
  }, []);

  const toggleTuck = () =>
    setTucked((t) => {
      localStorage.setItem(TUCK_KEY, t ? "0" : "1");
      return !t;
    });

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 0) press.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || !(e.buttons & 1) || Math.hypot(e.clientX - p.x, e.clientY - p.y) < 4) return;
    press.current = null;
    void drag();
  };
  const onPointerUp = () => {
    if (!press.current) return;
    press.current = null;
    toggleTuck();
  };

  return (
    <div ref={root} className={`cmp ${anchor.side}${tucked ? " tucked" : ""}`}>
      {!tucked && rows.length > 0 && (
        <div className="stack" onMouseLeave={() => setHover(null)}>
          {focused && <Tail name={focused.name} short={focused.short} lines={feed.recent[focused.id] ?? []} live={hot(focused.id)} />}
          <section className={`card${quiet ? " quiet" : ""}`}>
            <header className="card-h">
              <span className="sum">
                {running > 0 && <span>{running} running</span>}
                {errors > 0 && <span className="bad-text">{errors} failed</span>}
              </span>
              <span className="sp" />
              <button type="button" title="Open Spawner" onClick={() => void api.companionOpen()}>
                <i className="ph ph-arrow-square-out" />
              </button>
              <button type="button" title="Tuck away" onClick={toggleTuck}>
                <i className={`ph-bold ${anchor.side === "right" ? "ph-caret-right" : "ph-caret-left"}`} />
              </button>
            </header>
            <ul className="rows">
              {shown.map((r) => (
                <li
                  key={r.id}
                  className={`row ${stateClass(r.state)}${hot(r.id) ? " hot" : ""}${hover === r.id ? " on" : ""}`}
                  title={`Show ${r.name} in Spawner`}
                  onMouseEnter={() => setHover(r.id)}
                  onClick={() => void api.companionOpen(r.id)}
                >
                  <span className="dot" />
                  <span className="nm">
                    {r.name}
                    {r.short && <span className="wt">{r.short}</span>}
                  </span>
                  <span className={`ln ${isError(r.state) || !r.last ? "" : r.last.level}`}>
                    {isError(r.state) || !r.last ? describe(r.state) : r.last.text}
                  </span>
                  {isError(r.state) && (
                    <button
                      type="button"
                      className="x"
                      title="Dismiss"
                      onClick={(e) => (e.stopPropagation(), dismiss(r.id))}
                    >
                      <i className="ph-bold ph-x" />
                    </button>
                  )}
                </li>
              ))}
              {rows.length > ROWS && (
                <li className="more" onClick={() => void api.companionOpen()}>
                  +{rows.length - ROWS} more in Spawner
                </li>
              )}
            </ul>
          </section>
        </div>
      )}
      <button
        type="button"
        className={`guy${talking ? " talk" : ""}${errors > 0 ? " alarm" : ""}`}
        title={tucked ? "Show what's running (drag to move)" : "Tuck away (drag to move)"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <img src={spawnerIcon} alt="" draggable={false} />
        {rows.length > 0 && <span className="badge">{errors > 0 ? `!${errors}` : running}</span>}
      </button>
    </div>
  );
}

function Tail({ name, short, lines, live }: { name: string; short: string; lines: LogLine[]; live: boolean }) {
  return (
    <section className="tail">
      <header className="tail-h">
        <span className="nm">{name}</span>
        {short && <span className="wt">{short}</span>}
        <span className="sp" />
        <span className={`live${live ? " on" : ""}`}>{live ? "receiving" : "quiet"}</span>
      </header>
      <ol style={{ height: `calc(${KEEP} * var(--tail-line))` }}>
        {lines.length === 0 && <li className="empty">No output yet</li>}
        {lines.map((l) => (
          <li key={l.seq} className={l.level}>
            {l.text}
          </li>
        ))}
      </ol>
    </section>
  );
}
