import { availableMonitors, currentMonitor, getCurrentWindow, primaryMonitor, type Monitor } from "@tauri-apps/api/window";
import { api } from "../api";

export type Side = "left" | "right";

/** Where the companion sticks: a side edge of a monitor's work area, at some height. */
export interface Anchor {
  side: Side;
  /** The companion's bottom edge, as a share of the work area's height from its top. */
  bottom: number;
  /** The monitor's name, or null for the primary one. */
  monitor: string | null;
}

const KEY = "companion-anchor";
const DEFAULT: Anchor = { side: "right", bottom: 0.86, monitor: null };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function loadAnchor(): Anchor {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if ((a?.side === "left" || a?.side === "right") && Number.isFinite(a.bottom)) {
      return { side: a.side, bottom: clamp(a.bottom, 0, 1), monitor: typeof a.monitor === "string" ? a.monitor : null };
    }
  } catch {
    // Unreadable: start from the default spot.
  }
  return DEFAULT;
}

export const saveAnchor = (anchor: Anchor) => localStorage.setItem(KEY, JSON.stringify(anchor));

/** The anchor's monitor, falling back to the primary one when it was unplugged. */
async function monitorOf(anchor: Anchor): Promise<Monitor | null> {
  const all = await availableMonitors();
  return all.find((m) => m.name === anchor.monitor) ?? (await primaryMonitor()) ?? all[0] ?? null;
}

/** Sizes the window to `width` x `height` CSS pixels and puts it flush against the anchor's edge. */
export async function place(anchor: Anchor, width: number, height: number) {
  const monitor = await monitorOf(anchor);
  if (!monitor) return;
  const scale = monitor.scaleFactor;
  const w = Math.ceil(width * scale);
  const h = Math.ceil(height * scale);
  const { position: at, size } = monitor.workArea;
  const x = anchor.side === "right" ? at.x + size.width - w : at.x;
  const y = clamp(at.y + Math.round(anchor.bottom * size.height) - h, at.y, at.y + size.height - h);
  await api.companionPlace(x, y, w, h);
}

/** Where the user dropped the window: the nearer side edge of the monitor it is on, at the height it was dropped. */
export async function anchorOfWindow(): Promise<Anchor | null> {
  const win = getCurrentWindow();
  const [monitor, pos, size] = await Promise.all([currentMonitor(), win.outerPosition(), win.outerSize()]);
  if (!monitor) return null;
  const { position: at, size: area } = monitor.workArea;
  return {
    side: pos.x + size.width / 2 < at.x + area.width / 2 ? "left" : "right",
    bottom: clamp((pos.y + size.height - at.y) / area.height, 0, 1),
    monitor: monitor.name,
  };
}
