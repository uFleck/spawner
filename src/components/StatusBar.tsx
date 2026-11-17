import { useMemo } from "react";
import { countLevels } from "../logModel";
import { actions, type Snapshot } from "../store";
import { UpdateButton } from "./UpdateButton";

interface Props {
  snap: Snapshot;
  follow: boolean;
  /** The open worktree: the line counts are its own, since its logs are all the workspace shows. */
  scope: { label: string; ids: Set<string> } | null;
  onGuide: () => void;
}

export function StatusBar({ snap, follow, scope, onGuide }: Props) {
  const kinds = Object.values(snap.states).map((s) => s.kind);
  const running = kinds.filter((k) => k === "running").length;
  const busy = kinds.filter((k) => k === "building" || k === "starting").length;
  const failed = kinds.filter((k) => k === "failed").length;
  const logs = useMemo(() => (scope ? snap.logs.filter((l) => scope.ids.has(l.instance)) : snap.logs), [snap.logs, scope]);
  const { warn, err } = useMemo(() => countLevels(logs), [logs]);
  const mcp = snap.mcp;
  return (
    <footer className="status">
      {running > 0 && (
        <span className="g">
          <span className="dot ok" />
          {running} running
        </span>
      )}
      {busy > 0 && (
        <span className="g">
          <span className="dot warn" />
          {busy} building
        </span>
      )}
      {failed > 0 && (
        <span className="g">
          <span className="dot bad" />
          {failed} failed
        </span>
      )}
      <span className="sp" />
      {import.meta.env.PROD && <UpdateButton snap={snap} />}
      <button
        type="button"
        className={`mcp${snap.startOnLogin ? " on" : ""}`}
        data-tip={snap.startOnLogin ? "Spawner starts with you and waits in the tray. Click to turn off" : "Start Spawner when you log in, hidden in the tray"}
        data-side="top"
        aria-pressed={snap.startOnLogin}
        onClick={() => void actions.setStartOnLogin(!snap.startOnLogin)}
      >
        <i className={snap.startOnLogin ? "ph-fill ph-power" : "ph ph-power"} />
        <span className="lbl">start on login</span>
      </button>
      <button
        type="button"
        className={`mcp${snap.settings.companion ? " on" : ""}`}
        data-tip={snap.settings.companion ? "The companion shows running apps' logs at the screen edge while Spawner is in the background. Click to turn off" : "Show running apps' logs at the screen edge while Spawner is in the background"}
        data-side="top"
        aria-pressed={snap.settings.companion}
        onClick={() => void actions.setCompanion(!snap.settings.companion)}
      >
        <i className={snap.settings.companion ? "ph-fill ph-robot" : "ph ph-robot"} />
        <span className="lbl">companion</span>
      </button>
      {mcp && (
        <button
          type="button"
          className={`mcp${mcp.url ? (mcp.portChanged ? " warn" : "") : " bad"}`}
          data-tip={mcp.url ? (mcp.portChanged ? "The usual port was busy, so Hub moved. Click to update your AI agent." : "MCP server for AI agents. Click to set one up.") : (mcp.error ?? "MCP server is not running")}
          data-side="top"
          onClick={onGuide}
        >
          <i className="ph ph-plugs-connected" />
          {mcp.url ? `mcp :${new URL(mcp.url).port}` : "mcp off"}
        </button>
      )}
      <span className="g" data-tip={scope ? `Lines of ${scope.label}'s apps` : "Lines of every app"} data-side="top">
        {logs.length.toLocaleString()} lines · {warn} warn · <span className={err ? "bad-text" : undefined}>{err} err</span>
      </span>
      <span className={`g live${follow ? "" : " off"}`}>
        <i className="ph-fill ph-circle" />
        {follow ? "following" : "paused"}
      </span>
    </footer>
  );
}
