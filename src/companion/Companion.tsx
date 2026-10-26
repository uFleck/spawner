import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, isActive, type LogLine } from "../api";
import { ContextMenuProvider } from "../components/ContextMenu";
import { isFrame } from "../logModel";
import { indexInstances } from "../store";
import { dismiss, isError, useFeed } from "./feed";
import { Mascot, type MascotState } from "./Mascot";
import { Panel } from "./Panel";
import { anchorOfWindow, loadAnchor, place, saveAnchor, type Anchor } from "./place";
import { saveView, useView, type View } from "./view";
import "./companion.css";

/** An app counts as printing right now for this long after its last line. */
const HOT_MS = 1_500;
/** With the panel away, the mascot tucks against the screen edge after this long without a line from any app. */
const QUIET_MS = 12_000;
const PANEL_W = 430;
/** Heights of the panel: fully open, and pinned with the pointer away. */
const FULL_H = Math.max(320, Math.min(540, Math.round(screen.availHeight) - 150));
const COMPACT_H = 90;
/** How long the pointer may be away before the panel shrinks (pinned) or goes (not pinned). */
const SHRINK_MS = 150;
const HIDE_MS = 250;
/** How often the backend is asked where the cursor is. */
const POLL_MS = 70;

/** Follows the main window's theme, and its hidden Minecraft skin, which it keeps in the shared localStorage. */
function useTheme() {
  useEffect(() => {
    const apply = () => {
      const saved = localStorage.getItem("hub-theme");
      const root = document.documentElement;
      root.dataset.theme = saved === "dark" || saved === "light" ? saved : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      if (localStorage.getItem("hub-spawner") === "1") root.dataset.skin = "spawner";
      else delete root.dataset.skin;
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

/** "just now", "42s ago", "about 1 min ago", "7 min ago". */
function ago(since: number, now: number): string {
  const s = Math.max(0, (now - since) / 1000);
  if (s < 10) return "just now";
  if (s < 45) return `${Math.round(s)}s ago`;
  if (s < 90) return "about 1 min ago";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** The line to show for a failed app: its last error line, or else the last thing it printed. */
function errorLine(logs: LogLine[], id: string): number | null {
  let last: number | null = null;
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    if (l.instance !== id) continue;
    if (l.level === "err" && !isFrame(l)) return l.seq;
    last ??= l.seq;
  }
  return last;
}

const editable = (t: EventTarget | null) => t instanceof HTMLElement && t.closest("input, textarea") !== null;

export function Companion() {
  // The menu is drawn by the provider; copy results are toasted by the panel itself.
  return (
    <ContextMenuProvider fallback={[]} onToast={() => {}}>
      <Inner />
    </ContextMenuProvider>
  );
}

function Inner() {
  useTheme();
  const feed = useFeed();
  const now = useNow(500);
  const [view, patch] = useView();
  const viewRef = useRef(view);
  viewRef.current = view;
  const [anchor, setAnchor] = useState<Anchor>(loadAnchor);
  /** The pointer is over the companion. */
  const [hover, setHover] = useState(false);
  /** Opened by hovering or clicking while not pinned. */
  const [hoverOpen, setHoverOpen] = useState(false);
  const [jump, setJump] = useState<{ seq: number; nonce: number } | null>(null);
  const [toast, setToast] = useState({ text: "", on: false });
  const root = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const press = useRef<{ x: number; y: number } | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);
  const hoverRef = useRef(false);
  const focused = useRef(false);
  const lastTouch = useRef(Date.now());

  const names = useMemo(() => indexInstances(feed.groups), [feed.groups]);
  const running = Object.values(feed.states).filter(isActive).length;
  const failedIds = useMemo(
    () =>
      Object.entries(feed.states)
        .filter(([id, s]) => isError(s) && !feed.dismissed.includes(id))
        .map(([id]) => id)
        .sort((a, b) => (feed.failedAt[b] ?? 0) - (feed.failedAt[a] ?? 0)),
    [feed.states, feed.dismissed, feed.failedAt],
  );

  const open = view.pinned || hoverOpen;
  const compact = open && view.pinned && !hover;
  const lastHeard = Math.max(0, ...Object.values(feed.heard));
  const mascot: MascotState = failedIds.length ? "err" : now - lastHeard < HOT_MS && running ? "print" : running ? "run" : "sleep";
  const quiet = now - Math.max(lastHeard, lastTouch.current) > QUIET_MS;
  const tucked = !open && quiet && failedIds.length === 0;

  const [waking, setWaking] = useState(false);
  const wasTucked = useRef(false);
  useEffect(() => {
    const wake = wasTucked.current && !tucked;
    wasTucked.current = tucked;
    if (!wake) return;
    setWaking(true);
    const t = window.setTimeout(() => setWaking(false), 800);
    return () => window.clearTimeout(t);
  }, [tucked]);

  // ── the panel stays mounted while it fades out, and the window only shrinks once it is gone ──
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) return setPresent(true);
    const t = window.setTimeout(() => setPresent(false), 200);
    return () => window.clearTimeout(t);
  }, [open]);
  const showPanel = open || present;
  const panelH = compact ? COMPACT_H : FULL_H;
  const target = showPanel ? panelH : 0;
  // The window grows before the panel does and shrinks after it has finished, so the animation is never clipped.
  const [slot, setSlot] = useState(target);
  const slotRef = useRef(slot);
  slotRef.current = slot;
  useEffect(() => {
    if (target >= slotRef.current) return setSlot(target);
    const t = window.setTimeout(() => setSlot(target), 300);
    return () => window.clearTimeout(t);
  }, [target]);

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

  // ── keyboard focus: only while the user works in the panel, and handed back after ──
  const work = useCallback(() => {
    if (focused.current) return;
    focused.current = true;
    void api.companionFocus(true);
  }, []);
  const release = useCallback(() => {
    if (!focused.current || hoverRef.current || document.activeElement instanceof HTMLInputElement) return;
    focused.current = false;
    void api.companionFocus(false);
  }, []);
  useEffect(() => {
    const lost = () => {
      focused.current = false;
      void api.companionFocus(false);
    };
    window.addEventListener("blur", lost);
    return () => window.removeEventListener("blur", lost);
  }, []);

  // ── auto-hide: only the mascot and the panel count as "the pointer is here" ──
  // Where the cursor is comes from the backend. The page's own mouse events cannot be trusted: clicking in the panel
  // moves keyboard focus to it, and the webview then reports that the mouse left, which would hide the panel.
  const awayTimer = useRef<number | undefined>(undefined);
  const polling = useRef(false);
  const enter = useCallback(() => {
    window.clearTimeout(awayTimer.current);
    window.clearTimeout(hideTimer.current);
    awayTimer.current = undefined;
    lastTouch.current = Date.now();
    hoverRef.current = true;
    setHover(true);
    setHoverOpen(true);
  }, []);
  const away = useCallback(() => {
    if (awayTimer.current !== undefined) return;
    const tick = () => {
      // A context menu keeps the panel as it is.
      if (document.querySelector(".menu.ctx")) {
        awayTimer.current = window.setTimeout(tick, 300);
        return;
      }
      awayTimer.current = undefined;
      hoverRef.current = false;
      setHover(false);
      setHoverOpen(false);
      release();
    };
    awayTimer.current = window.setTimeout(tick, viewRef.current.pinned ? SHRINK_MS : HIDE_MS);
  }, [release]);

  useEffect(() => {
    const el = document.documentElement;
    const overTarget = (t: EventTarget | null) => t instanceof Element && t.closest(".mas, .pn") !== null;
    // Moving onto the mascot or the panel opens at once; the backend decides when the pointer has gone.
    const onOver = (e: PointerEvent) => {
      if (overTarget(e.target)) enter();
      else if (!polling.current && hoverRef.current) away();
    };
    const onLeave = () => polling.current || away();
    document.addEventListener("pointerover", onOver);
    el.addEventListener("mouseleave", onLeave);

    let busy = false;
    const poll = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const at = await api.companionPointer();
        if (at === undefined) return; // no backend to ask: the page's own events are all there is
        polling.current = true;
        const scale = window.devicePixelRatio || 1;
        const x = at ? at[0] / scale : -1;
        const y = at ? at[1] / scale : -1;
        const near = [".mas", ".pn"].some((sel) => {
          const r = document.querySelector(sel)?.getBoundingClientRect();
          return !!r && x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6;
        });
        if (near) enter();
        else if (hoverRef.current) away();
      } catch {
        // The window is going away.
      } finally {
        busy = false;
      }
    }, POLL_MS);
    return () => {
      document.removeEventListener("pointerover", onOver);
      el.removeEventListener("mouseleave", onLeave);
      window.clearInterval(poll);
      window.clearTimeout(awayTimer.current);
    };
  }, [enter, away]);

  const showToast = useCallback((text: string) => {
    window.clearTimeout(toastTimer.current);
    setToast({ text, on: true });
    toastTimer.current = window.setTimeout(() => setToast((t) => ({ ...t, on: false })), 2400);
  }, []);

  /** Brings Spawner to the front on what the panel shows. The view is saved first, since the main window reads it. */
  const openSpawner = useCallback(
    (next?: Partial<View>) => {
      const v = { ...viewRef.current, ...next };
      saveView(v);
      if (next) patch(next);
      void api.companionOpen();
    },
    [patch],
  );

  const hide = () => {
    patch({ pinned: false });
    hoverRef.current = false;
    setHover(false);
    setHoverOpen(false);
  };

  // The pill: open on the newest failure's line, leaving the filters as they are.
  const showFailure = () => {
    const id = failedIds[0];
    const seq = id ? errorLine(feed.logs, id) : null;
    if (seq !== null) setJump({ seq, nonce: Date.now() });
    setHoverOpen(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => !hoverRef.current && setHoverOpen(false), 6000);
  };

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
    lastTouch.current = Date.now();
    if (!view.pinned) setHoverOpen((o) => !o);
  };

  const failedNow = failedIds[0];
  const failedName = failedNow ? (names.get(failedNow)?.appName ?? failedNow) : "";

  return (
    <div
      ref={root}
      className={`cmp ${anchor.side}`}
      onContextMenu={(e) => editable(e.target) || e.preventDefault()}
    >
      <div className="slot" style={{ height: slot, width: showPanel ? PANEL_W : 0 }}>
        {showPanel && (
          <Panel
            feed={feed}
            names={names}
            view={view}
            patch={patch}
            compact={compact}
            open={open}
            height={panelH}
            side={anchor.side}
            jump={jump}
            onHide={hide}
            onOpen={openSpawner}
            onWork={work}
            onInputBlur={release}
            toast={showToast}
          />
        )}
        <div className={`toast${toast.on ? " on" : ""}`}>{toast.text}</div>
      </div>
      <div className="base">
        {!open && failedNow && (
          <button type="button" className="pill show" onClick={showFailure}>
            <span className="dot" />
            <b>{failedName}</b>
            <span>error {ago(feed.failedAt[failedNow] ?? now, now)}</span>
            {failedIds.length > 1 && <span className="more">+{failedIds.length - 1}</span>}
            <span
              role="button"
              tabIndex={0}
              className="x"
              aria-label="Dismiss"
              onClick={(e) => (e.stopPropagation(), dismiss(failedNow))}
            >
              <i className="ph-bold ph-x" />
            </span>
          </button>
        )}
        <Mascot
          state={mascot}
          tucked={tucked}
          waking={waking}
          count={failedIds.length || running}
          title={tucked ? "Show what is running (drag to move)" : "Drag to move"}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </div>
    </div>
  );
}
