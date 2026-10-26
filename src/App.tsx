import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConcludeDialog } from "./components/ConcludeDialog";
import { RunDialog } from "./components/RunDialog";
import { ContextMenuProvider, type MenuItem } from "./components/ContextMenu";
import { LogPane } from "./components/LogPane";
import { Palette } from "./components/Palette";
import { SetupGuide } from "./components/SetupGuide";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TooltipHost } from "./components/TooltipHost";
import { WindowControls } from "./components/WindowControls";
import { useSpawnerTheme } from "./spawnerTheme";
import { actions, indexInstances, initStore, useSnapshot } from "./store";
import "./styles/hub.css";

type Theme = "dark" | "light";

const storedTheme = (): Theme => {
  const saved = localStorage.getItem("hub-theme");
  if (saved === "dark" || saved === "light") return saved;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

const isNarrow = () => matchMedia("(max-width: 959px)").matches;

export default function App() {
  const snap = useSnapshot();
  const instances = useMemo(() => indexInstances(snap.groups), [snap.groups]);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [guide, setGuide] = useState(() => !localStorage.getItem("hub-guide-seen"));
  const [follow, setFollow] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; on: boolean }>({ text: "", on: false });
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void initStore();
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const first = !root.dataset.theme;
    root.dataset.theme = theme;
    localStorage.setItem("hub-theme", theme);
    if (first) return;
    root.classList.add("theming");
    const t = window.setTimeout(() => root.classList.remove("theming"), 450);
    return () => window.clearTimeout(t);
  }, [theme]);

  const showToast = useCallback((text: string) => {
    window.clearTimeout(toastTimer.current);
    setToast({ text, on: true });
    toastTimer.current = window.setTimeout(() => setToast((t) => ({ ...t, on: false })), 2400);
  }, []);

  const { onLogoClick } = useSpawnerTheme((on) =>
    showToast(on ? "Spawner theme unlocked" : "Spawner theme off"),
  );

  const toggleSide = useCallback(() => {
    if (isNarrow()) setDrawer((d) => !d);
    else setCollapsed((c) => !c);
  }, []);
  const closeGuide = useCallback(() => {
    localStorage.setItem("hub-guide-seen", "1");
    setGuide(false);
  }, []);
  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);

  const solo = useCallback(
    (id: string) => {
      const all = new Set([...instances.keys(), ...snap.logs.map((l) => l.instance)]);
      all.delete(id);
      setHidden(all);
      setSelected(id);
      const info = instances.get(id);
      showToast(`Showing only ${info?.appName ?? "this app"} · ${info?.group.label ?? ""}`);
    },
    [instances, snap.logs, showToast],
  );

  // The companion asks for one app's log when it is clicked.
  const soloRef = useRef(solo);
  soloRef.current = solo;
  useEffect(() => {
    const off = listen<string>("focus-instance", (e) => soloRef.current(e.payload));
    return () => void off.then((fn) => fn());
  }, []);

  /** Focuses one app's log, or shows every log again when it is already the only one shown. */
  const toggleFocus = useCallback(
    (id: string) => {
      const others = [...new Set([...instances.keys(), ...snap.logs.map((l) => l.instance)])].filter((o) => o !== id);
      const alone = !hidden.has(id) && others.every((o) => hidden.has(o));
      if (!alone) return solo(id);
      setHidden(new Set());
      setSelected(null);
      showToast("Showing all logs");
    },
    [instances, snap.logs, hidden, solo, showToast],
  );

  const fallbackMenu = useMemo<MenuItem[]>(
    () => [
      { label: "Rescan folders", icon: "ph ph-arrow-clockwise", run: () => void actions.refresh() },
      { label: "Add folder…", icon: "ph ph-folder-plus", run: () => void actions.addFolder() },
      "sep",
      { label: "Command palette", icon: "ph ph-command", run: () => setPalette(true) },
      { label: "Toggle sidebar", icon: "ph ph-sidebar-simple", run: toggleSide },
      { label: "Toggle theme", icon: theme === "dark" ? "ph ph-sun" : "ph ph-moon", run: toggleTheme },
      "sep",
      { label: "Connect an AI agent", icon: "ph ph-plugs-connected", run: () => setGuide(true) },
    ],
    [theme, toggleSide, toggleTheme],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (mod && k === "b") {
        e.preventDefault();
        toggleSide();
      } else if (mod && k === "r") {
        e.preventDefault();
        void actions.refresh();
      } else if (k === "escape") setDrawer(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggleSide]);

  return (
    <ContextMenuProvider fallback={fallbackMenu} onToast={showToast}>
    <div className={`app${collapsed ? " collapsed" : ""}${drawer ? " drawer" : ""}`}>
      <Sidebar
        snap={snap}
        instances={instances}
        theme={theme}
        onSolo={solo}
        onTheme={toggleTheme}
        onGuide={() => setGuide(true)}
        onLogoClick={onLogoClick}
        onToast={showToast}
      />
      <div className="main">
        <LogPane
          snap={snap}
          hidden={hidden}
          selected={selected}
          follow={follow}
          onFollow={setFollow}
          onHidden={setHidden}
          onFocus={toggleFocus}
          onToast={showToast}
          onToggleSide={toggleSide}
        />
        <StatusBar snap={snap} follow={follow} onGuide={() => setGuide(true)} />
      </div>
      <div className="scrim" onClick={() => setDrawer(false)} />
      <WindowControls />
      <TooltipHost />
      <Palette
        open={palette}
        snap={snap}
        onClose={() => setPalette(false)}
        onToggleSide={toggleSide}
        onTheme={toggleTheme}
        onToast={showToast}
        onGuide={() => setGuide(true)}
      />
      <SetupGuide open={guide} mcp={snap.mcp} onClose={closeGuide} onToast={showToast} />
      <ConcludeDialog snap={snap} />
      <RunDialog snap={snap} />
      <div className={`toast${toast.on ? " on" : ""}`}>
        <i className="ph-fill ph-check-circle" />
        <span>{toast.text}</span>
      </div>
    </div>
    </ContextMenuProvider>
  );
}
