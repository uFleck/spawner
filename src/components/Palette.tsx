import { useEffect, useMemo, useRef, useState } from "react";
import { instanceId, isActive, rootName } from "../api";
import { resolvePreset, targetLabel } from "../presets";
import { actions, type Snapshot } from "../store";

interface Command {
  group: string;
  icon: string;
  label: string;
  kbd?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  snap: Snapshot;
  onClose: () => void;
  onToggleSide: () => void;
  onTheme: () => void;
  onToast: (text: string) => void;
  onGuide: () => void;
}

export function Palette({ open, snap, onClose, onToggleSide, onTheme, onToast, onGuide }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    for (const g of snap.groups) {
      const where = g.main ? "main" : g.label;
      for (const p of g.projects)
        for (const a of p.apps) {
          const id = instanceId(p.id, a.id);
          const up = isActive(snap.states[id]);
          list.push({
            group: "Run",
            icon: up ? "ph ph-stop" : "ph ph-play",
            label: `${up ? "Stop" : "Run"} ${a.name} @ ${where}`,
            run: () => void (up ? actions.stop(id) : actions.start(p.id, a.id)),
          });
        }
    }
    list.unshift(
      { group: "All apps", icon: "ph ph-arrow-clockwise", label: "Restart all", run: () => void actions.restartAll() },
      { group: "All apps", icon: "ph ph-stop", label: "Stop all", run: () => void actions.stopAll() },
      ...snap.presets.map((p): Command => {
        const { hits } = resolvePreset(p, snap.groups);
        const up = hits.length > 0 && hits.every((h) => isActive(snap.states[h.instance]));
        return {
          group: "Presets",
          icon: up ? "ph ph-stop" : "ph ph-play",
          label: `${up ? "Stop" : "Run"} preset ${p.name} @ ${targetLabel(p, snap.groups)}`,
          run: () => void (up ? actions.stopPreset(p) : actions.runPreset(p)),
        };
      }),
    );
    list.push(
      { group: "Logs", icon: "ph ph-trash", label: "Clear logs", kbd: "Ctrl L", run: () => void actions.clearLogs() },
      { group: "View", icon: "ph ph-sidebar-simple", label: "Toggle sidebar", kbd: "Ctrl B", run: onToggleSide },
      { group: "View", icon: "ph ph-moon", label: "Toggle theme", run: onTheme },
      { group: "Folders", icon: "ph ph-folder-plus", label: "Add folder…", run: () => void actions.addFolder() },
      ...snap.roots.map((r) => ({
        group: "Folders",
        icon: "ph ph-folder-minus",
        label: `Remove folder ${rootName(r)}`,
        run: () => void actions.removeRoot(r.path),
      })),
      { group: "Hub", icon: "ph ph-plugs-connected", label: "Connect an AI agent (Claude Code)", run: onGuide },
      { group: "Hub", icon: "ph ph-arrow-clockwise", label: "Rescan folders", run: () => void actions.refresh() },
    );
    return list;
  }, [snap.groups, snap.states, snap.roots, snap.presets, onToggleSide, onTheme, onGuide]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const t = window.setTimeout(() => input.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
    onToast(c.label);
  };

  let group = "";
  return (
    <div id="pal" className={open ? "on" : ""} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pal">
        <div className="in">
          <i className="ph ph-magnifying-glass" />
          <input
            ref={input}
            placeholder="Run, stop, toggle…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive(Math.min(items.length - 1, active + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive(Math.max(0, active - 1));
              } else if (e.key === "Enter") run(items[active]);
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <ul>
          {items.map((c, i) => {
            const head = c.group !== group;
            group = c.group;
            return (
              <li key={`${c.group}:${c.label}:${i}`} className="wrap">
                {head && <div className="grp">{c.group}</div>}
                <div className={`item${i === active ? " a" : ""}`} onMouseMove={() => setActive(i)} onClick={() => run(c)}>
                  <i className={c.icon} />
                  {c.label}
                  {c.kbd && (
                    <span className="k">
                      {c.kbd.split(" ").map((k) => (
                        <span key={k} className="kbd">
                          {k}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
          {items.length === 0 && <li className="none">No commands match.</li>}
        </ul>
      </div>
    </div>
  );
}
