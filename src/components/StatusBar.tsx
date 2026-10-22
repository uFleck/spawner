import { useMemo } from "react";
import { countLevels } from "../logModel";
import type { Snapshot } from "../store";
import { UpdateButton } from "./UpdateButton";

export function StatusBar({ snap, follow, onGuide }: { snap: Snapshot; follow: boolean; onGuide: () => void }) {
  const kinds = Object.values(snap.states).map((s) => s.kind);
  const running = kinds.filter((k) => k === "running").length;
  const busy = kinds.filter((k) => k === "building" || k === "starting").length;
  const failed = kinds.filter((k) => k === "failed").length;
  const { warn, err } = useMemo(() => countLevels(snap.logs), [snap.logs]);
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
      <UpdateButton snap={snap} />
      {mcp && (
        <button
          type="button"
          className={`mcp${mcp.url ? (mcp.portChanged ? " warn" : "") : " bad"}`}
          data-tip={mcp.url ? (mcp.portChanged ? "The usual port was busy, so Hub moved. Click to update Claude Code." : "MCP server for AI agents. Click to set up Claude Code.") : (mcp.error ?? "MCP server is not running")}
          data-side="top"
          onClick={onGuide}
        >
          <i className="ph ph-plugs-connected" />
          {mcp.url ? `mcp :${new URL(mcp.url).port}` : "mcp off"}
        </button>
      )}
      <span className="g">
        {snap.logs.length.toLocaleString()} lines · {warn} warn · <span className="bad-text">{err} err</span>
      </span>
      <span className={`g live${follow ? "" : " off"}`}>
        <i className="ph-fill ph-circle" />
        {follow ? "following" : "paused"}
      </span>
    </footer>
  );
}
