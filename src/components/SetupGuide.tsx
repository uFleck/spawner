import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type AgentKind, type AgentStatus, type LinkStatus, type McpInfo } from "../api";

type StepState = "done" | "busy" | "fail" | "todo";

const AGENTS: AgentKind[] = ["claude", "opencode"];
const AGENT_INFO: Record<
  AgentKind,
  {
    name: string;
    command: string;
    install: string;
    addNote: string;
    addCommand: (url: string) => string;
    rules: string;
    globalRules: string;
    linked: string;
    failing: string;
  }
> = {
  claude: {
    name: "Claude Code",
    command: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    addNote: "This adds an MCP server named spawner to your Claude Code user settings, so it works in every project and worktree.",
    addCommand: (url) => `claude mcp add --transport http --scope user spawner ${url}`,
    rules: "CLAUDE.md",
    globalRules: "~/.claude/CLAUDE.md",
    linked: "Claude Code reached Hub. Restart any open Claude Code session so it loads the new server.",
    failing: "Claude Code added it but could not connect",
  },
  opencode: {
    name: "OpenCode",
    command: "opencode",
    install: "npm install -g @opencode/cli",
    addNote: "This adds an MCP server named spawner to your OpenCode global config, so it works in every project and worktree.",
    addCommand: (url) => `opencode mcp add spawner --global --url ${url}`,
    rules: "AGENTS.md",
    globalRules: "~/.config/opencode/AGENTS.md",
    linked: "OpenCode is configured. It watches its config and reloads MCP servers on its own, so no restart is needed.",
    failing: "OpenCode could not use the entry",
  },
};

const PROMPTS = [
  "Use the spawner tools to list my apps, then start the Bill API for this worktree and tell me if it fails to build.",
  "Check the spawner logs for errors since you last looked, and tell me which app they came from.",
];
const AGENT_MD = `## Running apps
Run and check apps through the spawner MCP tools (hub_list_apps, hub_start, hub_logs, hub_stop) instead of running dev servers or builds in a terminal. The user watches every process in Spawner.`;

function useClipboard() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback((key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(key);
    window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
  }, []);
  return { copied, copy };
}

function CopyBox({ id, text, copied, copy }: { id: string; text: string; copied: string | null; copy: (k: string, t: string) => void }) {
  const done = copied === id;
  return (
    <div className="copybox">
      <pre>{text}</pre>
      <button type="button" className={`ib sm${done ? " ok" : ""}`} aria-label="Copy" data-tip={done ? "Copied" : "Copy"} data-side="top" onClick={() => copy(id, text)}>
        <i className={done ? "ph-bold ph-check" : "ph ph-copy"} />
      </button>
    </div>
  );
}

function Step({
  n,
  state,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <li className={`step${open ? " open" : ""}`} data-s={state}>
      <button type="button" className="step-h" aria-expanded={open} onClick={onToggle}>
        <span className="step-ico">
          <span className="num">{n}</span>
          <i className="ph-bold ph-check check" />
          <i className="ph-bold ph-circle-notch spin" />
          <i className="ph-bold ph-warning warn" />
        </span>
        <span className="step-t">{title}</span>
        <span className="step-s">{summary}</span>
        <i className="ph-bold ph-caret-down caret-i" />
      </button>
      <div className="collapse">
        <div className="in">
          <div className="step-body">{children}</div>
        </div>
      </div>
    </li>
  );
}

interface Props {
  open: boolean;
  mcp: McpInfo | null;
  onClose: () => void;
  onToast: (text: string) => void;
}

export function SetupGuide({ open, mcp, onClose, onToast }: Props) {
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [link, setLink] = useState<LinkStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState<number | null>(null);
  const [guidance, setGuidance] = useState<{ busy: boolean; text: string | null; failed: boolean }>({ busy: false, text: null, failed: false });
  const { copied, copy } = useClipboard();
  const refreshSeq = useRef(0);

  const info = AGENT_INFO[agent];

  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    setChecking(true);
    const found = await api.agentCheck(agent).catch((): AgentStatus => ({ installed: false, version: null }));
    if (seq !== refreshSeq.current) return;
    setStatus(found);
    const next = found.installed
      ? await api.agentLink(agent).catch((e): LinkStatus => ({ state: "failing", detail: String(e) }))
      : null;
    if (seq !== refreshSeq.current) return;
    setLink(next);
    setChecking(false);
  }, [agent]);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setLink(null);
    setError(null);
    setGuidance({ busy: false, text: null, failed: false });
    void refresh();
  }, [open, agent, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await api.agentConnect(agent);
      onToast(`Added spawner to ${info.name}`);
    } catch (e) {
      setError(String(e));
    }
    await refresh();
    setConnecting(false);
  };

  const addGuidance = async () => {
    setGuidance({ busy: true, text: null, failed: false });
    try {
      setGuidance({ busy: false, text: await api.agentAddGuidance(agent, AGENT_MD), failed: false });
    } catch (e) {
      setGuidance({ busy: false, text: String(e), failed: true });
    }
  };

  const url = mcp?.url ?? "";
  const hubState: StepState = mcp?.url ? "done" : mcp?.error ? "fail" : "busy";
  const installedState: StepState = !status ? "busy" : status.installed ? "done" : "fail";
  const linkedNow = link?.state === "connected" || link?.state === "configured";
  const linkState: StepState = connecting ? "busy" : !status?.installed ? "todo" : !link || checking ? "busy" : linkedNow ? "done" : link.state === "failing" || link.state === "stale" ? "fail" : "todo";
  const tryState: StepState = linkState === "done" ? "done" : "todo";
  const states = [hubState, installedState, linkState];
  const firstOpen = states.findIndex((s) => s !== "done");
  const current = manual ?? (firstOpen === -1 ? 3 : firstOpen);
  useEffect(() => setManual(null), [firstOpen]);
  const toggle = (i: number) => setManual(current === i ? -1 : i);

  const installedSummary = !status ? "checking…" : status.installed ? (status.version ?? "installed") : "not found";
  const linkSummary =
    linkState === "busy"
      ? connecting
        ? "adding…"
        : "checking…"
      : link?.state === "connected"
        ? "connected"
        : link?.state === "configured"
          ? "configured"
          : link?.state === "failing"
            ? agent === "opencode"
              ? "needs attention"
              : "not responding"
            : link?.state === "stale"
              ? "outdated URL"
              : "not added";
  const doneLabel = agent === "claude" ? "Connected" : "Configured";

  return (
    <div className={`guide-scrim${open ? " on" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="guide" role="dialog" aria-modal="true" aria-label="Connect an AI agent">
        <header className="guide-h">
          <div>
            <h2>Connect an AI agent</h2>
            <p>Let Claude Code or OpenCode start, stop and read your apps through Hub, so every process stays visible here.</p>
          </div>
          <button type="button" className="ib" aria-label="Close" data-tip="Close" data-kbd="Esc" onClick={onClose}>
            <i className="ph ph-x" />
          </button>
        </header>

        <div className="guide-pick" role="group" aria-label="Agent">
          {AGENTS.map((kind) => (
            <button key={kind} type="button" aria-pressed={agent === kind} onClick={() => setAgent(kind)}>
              {AGENT_INFO[kind].name}
            </button>
          ))}
        </div>

        <ol className="steps">
          <Step n={1} state={hubState} title="Hub is listening" summary={mcp?.url ? new URL(mcp.url).host : mcp?.error ? "not running" : "starting…"} open={current === 0} onToggle={() => toggle(0)}>
            {mcp?.url ? (
              <>
                <p>Hub serves an MCP endpoint on this machine only, for as long as it is open.</p>
                <CopyBox id="url" text={mcp.url} copied={copied} copy={copy} />
                {mcp.portChanged && <p className="hint">The usual port was busy, so Hub picked a free one. Clients set up for the old port need step 3 again.</p>}
              </>
            ) : (
              <p className="err">
                {mcp?.error ?? "Starting…"} Hub tries a range of ports and then any free one, so this is unusual. Restart Hub, and if it keeps happening set <code>SPAWNER_MCP_PORT</code>.
              </p>
            )}
          </Step>

          <Step n={2} state={installedState} title={`${info.name} is installed`} summary={installedSummary} open={current === 1} onToggle={() => toggle(1)}>
            {!status ? (
              <p>Looking for {info.name}…</p>
            ) : status.installed ? (
              <p>Found {info.name} {status.version}.</p>
            ) : (
              <>
                <p>Hub could not find the <code>{info.command}</code> command. Install {info.name}, then check again.</p>
                <CopyBox id="install" text={info.install} copied={copied} copy={copy} />
                <p className="hint">Needs Node.js. If you install it while Hub is open, restart Hub so it sees the new PATH.</p>
                <button type="button" className="btn btn-ghost" disabled={checking} onClick={() => void refresh()}>
                  <i className={`ph ph-arrow-clockwise${checking ? " spin" : ""}`} />
                  Check again
                </button>
              </>
            )}
          </Step>

          <Step n={3} state={linkState} title={`Add Hub to ${info.name}`} summary={linkSummary} open={current === 2} onToggle={() => toggle(2)}>
            <p>{info.addNote}</p>
            <div className="actions">
              <button type="button" className="btn btn-primary" disabled={!mcp?.url || !status?.installed || connecting} onClick={() => void connect()}>
                <i className={`ph ${connecting ? "ph-circle-notch spin" : "ph-plugs-connected"}`} />
                {linkedNow ? "Add again" : link?.state === "stale" ? `Update ${info.name}` : `Add to ${info.name}`}
              </button>
              <button type="button" className="btn btn-ghost" disabled={checking || !status?.installed} onClick={() => void refresh()}>
                <i className={`ph ph-arrow-clockwise${checking ? " spin" : ""}`} />
                Check connection
              </button>
            </div>
            {linkedNow && <p className="okline"><i className="ph-bold ph-check" /> {info.linked}</p>}
            {link?.state === "stale" && (
              <p className="err">
                {info.name} still points at <code>{link.configured}</code>, but Hub is now on <code>{url}</code>. Update it.
              </p>
            )}
            {link?.state === "failing" && <p className="err">{info.failing} ({link.detail}).</p>}
            {error && <p className="err">{error}</p>}
            <details>
              <summary>Prefer the terminal?</summary>
              <CopyBox id="add" text={info.addCommand(url)} copied={copied} copy={copy} />
            </details>
          </Step>

          <Step n={4} state={tryState} title="Try it" summary={linkState === "done" ? "ready" : "after step 3"} open={current === 3} onToggle={() => toggle(3)}>
            <p>Start a new {info.name} session and ask for something like this. Using T3 Code? It runs the agent you pick as the provider, so open a new thread and the tools should be there.</p>
            {PROMPTS.map((p, i) => (
              <CopyBox key={p} id={`p${i}`} text={p} copied={copied} copy={copy} />
            ))}
            <p>
              To make it the default, add this to your project <code>{info.rules}</code> or <code>{info.globalRules}</code>.
            </p>
            <CopyBox id="md" text={AGENT_MD} copied={copied} copy={copy} />
            <div className="actions">
              <button type="button" className="btn btn-ghost" disabled={!status?.installed || guidance.busy} onClick={() => void addGuidance()}>
                <i className={`ph ${guidance.busy ? "ph-circle-notch spin" : "ph-sparkle"}`} />
                {guidance.busy ? "Adding…" : "Add it for me"}
              </button>
              <span className="hint">Writes the section into your user-level <code>{info.globalRules}</code>, replacing an older copy and leaving the rest untouched.</span>
            </div>
            {guidance.text && (guidance.failed ? <p className="err">{guidance.text}</p> : <p className="okline"><i className="ph-bold ph-check" /> {guidance.text}</p>)}
            <details>
              <summary>Using Codex or another agent?</summary>
              <p className="hint">Any client that speaks MCP over HTTP can use the same URL.</p>
              <CopyBox
                id="json"
                text={JSON.stringify(
                  agent === "opencode"
                    ? { mcp: { servers: { spawner: { type: "remote", url } } } }
                    : { mcpServers: { spawner: { type: "http", url } } },
                  null,
                  2,
                )}
                copied={copied}
                copy={copy}
              />
              <CopyBox id="toml" text={`[mcp_servers.spawner]\nurl = "${url}"`} copied={copied} copy={copy} />
            </details>
          </Step>
        </ol>

        <footer className="guide-f">
          <span className={`pill ${linkState === "done" ? "ok" : ""}`}>
            <i className={linkState === "done" ? "ph-bold ph-check" : "ph ph-circle"} />
            {linkState === "done" ? doneLabel : "Not connected yet"}
          </span>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {linkState === "done" ? "Done" : "Skip for now"}
          </button>
        </footer>
      </div>
    </div>
  );
}
