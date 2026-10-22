import { useCallback, useEffect, useRef, useState } from "react";

/** Hidden easter-egg skin. Not listed anywhere in the UI; toggled by the Konami code or 7 quick logo clicks. */
const KEY = "hub-spawner";
const KONAMI = [
  "arrowup", "arrowup", "arrowdown", "arrowdown",
  "arrowleft", "arrowright", "arrowleft", "arrowright",
  "b", "a",
];
const CLICKS = 7;
const CLICK_WINDOW_MS = 2500;

export function useSpawnerTheme(onToggled: (on: boolean) => void) {
  const [on, setOn] = useState(() => localStorage.getItem(KEY) === "1");
  const notify = useRef(onToggled);
  notify.current = onToggled;

  useEffect(() => {
    const root = document.documentElement;
    if (on) root.dataset.skin = "spawner";
    else delete root.dataset.skin;
    localStorage.setItem(KEY, on ? "1" : "0");
  }, [on]);

  const current = useRef(on);
  current.current = on;
  const toggle = useCallback(() => {
    const next = !current.current;
    current.current = next;
    setOn(next);
    notify.current(next);
  }, []);

  useEffect(() => {
    let pos = 0;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === KONAMI[pos]) pos++;
      else pos = k === KONAMI[0] ? 1 : 0;
      if (pos === KONAMI.length) {
        pos = 0;
        toggle();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  const clicks = useRef<number[]>([]);
  const onLogoClick = useCallback(() => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < CLICK_WINDOW_MS), now];
    if (clicks.current.length >= CLICKS) {
      clicks.current = [];
      toggle();
    }
  }, [toggle]);

  return { on, onLogoClick };
}
