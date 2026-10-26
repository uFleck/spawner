import { useCallback, useEffect, useState } from "react";

export type LevelFilter = "all" | "wrn" | "err";

/**
 * What the companion shows, kept where the main window can read it too (both windows share this origin's storage),
 * so "Open Spawner" lands on the same app, filter and line.
 */
export interface View {
  /** Instance ids shown. Empty shows every app. */
  apps: string[];
  level: LevelFilter;
  query: string;
  follow: boolean;
  /** The line at the top of the log while scrolled up. */
  anchor: number | null;
  /** Pinned: the panel stays on screen and shrinks to a few lines while the pointer is away. */
  pinned: boolean;
}

const KEY = "companion-view";
export const DEFAULT_VIEW: View = { apps: [], level: "all", query: "", follow: true, anchor: null, pinned: false };

export function loadView(): View {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v === "object") {
      return {
        apps: Array.isArray(v.apps) ? v.apps.filter((a: unknown) => typeof a === "string") : [],
        level: v.level === "wrn" || v.level === "err" ? v.level : "all",
        query: typeof v.query === "string" ? v.query : "",
        follow: v.follow !== false,
        anchor: Number.isFinite(v.anchor) ? v.anchor : null,
        pinned: v.pinned === true,
      };
    }
  } catch {
    // Unreadable: start from the default view.
  }
  return DEFAULT_VIEW;
}

export const saveView = (v: View) => localStorage.setItem(KEY, JSON.stringify(v));

export function useView(): [View, (patch: Partial<View>) => void] {
  const [view, setView] = useState<View>(loadView);
  useEffect(() => saveView(view), [view]);
  const patch = useCallback((p: Partial<View>) => setView((v) => ({ ...v, ...p })), []);
  return [view, patch];
}
