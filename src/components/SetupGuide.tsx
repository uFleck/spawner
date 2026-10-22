import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type ClaudeStatus, type LinkStatus, type McpInfo } from "../api";

type StepState = "done" | "busy" | "fail" | "todo";

const INSTALL_CMD = "npm install -g @anthropic-ai/claude-code";
const PROMPTS = [
  "Use the spawner tools to list my apps, then start the Bill API for this worktree and tell me if it fails to build.",
  "Check the spawner logs for errors since you last looked, and tell me which app they came from.",
];
const CLAUDE_MD = `## Running apps
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
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [link, setLink] = useState<LinkStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState<number | null>(null);
  const [guidance, setGuidance] = useState<{ busy: boolean; text: string | null; failed: boolean }>({ busy: false, text: null, failed: false });
  const { copied, copy } = useClipboard();

  const refresh = useCallback(async () => {
    setChecking(true);
    const c = await api.claudeCheck().catch(() => ({ installed: false, version: null }));
    setClaude(c);
    setLink(c.installed ? await api.claudeLink().catch((e): LinkStatus => ({ state: "failing", detail: String(e) })) : null);
    setChecking(false);
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

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
      await api.claudeConnect();
      onToast("Added spawner to Claude Code");
    } catch (e) {
      setError(String(e));
    }
    await refresh();
    setConnecting(false);
  };

  const addGuidance = async () => {
    setGuidance({ busy: true, text: null, failed: false });
    try {
      setGuidance({ busy: false, text: await api.claudeAddGuidance(CLAUDE_MD), failed: false });
    } catch (e) {
      setGuidance({ busy: false, text: String(e), failed: true });
    }
  };

  const url = mcp?.url ?? "";
  const addCommand = `claude mcp add --transport http --scope user spawner ${url}`;
  const hubState: StepState = mcp?.url ? "done" : mcp?.error ? "fail" : "busy";
  const claudeState: StepState = !claude ? "busy" : claude.installed ? "done" : "fail";
  const linkState: StepState = connecting ? "busy" : !claude?.installed ? "todo" : !link || checking ? "busy" : link.state === "connected" ? "done" : link.state === "failing" || link.state === "stale" ? "fail" : "todo";
  const tryState: StepState = linkState === "done" ? "done" : "todo";
  const states = [hubState, claudeState, linkState];
  const firstOpen = states.findIndex((s) => s !== "done");
  const current = manual ?? (firstOpen === -1 ? 3 : firstOpen);
  useEffect(() => setManual(null), [firstOpen]);
  const toggle = (i: number) => setManual(current === i ? -1 : i);

  const claudeSummary = !claude ? "checking…" : claude.installed ? (claude.version ?? "installed") : "not found";
  const linkSummary =
    linkState === "busy" ? (connecting ? "adding…" : "checking…") : link?.state === "connected" ? "connected" : link?.state === "failing" ? "not responding" : link?.state === "stale" ? "outdated URL" : "not added";

  return (
    <div className={`guide-scrim${open ? " on" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="guide" role="dialog" aria-modal="true" aria-label="Connect an AI agent">
        <header className="guide-h">
          <div>
            <h2>Connect an AI agent</h2>
            <p>Let Claude Code start, stop and read your apps through Hub, so every process stays visible here.</p>
          </div>
          <button type="button" className="ib" aria-label="Close" data-tip="Close" data-kbd="Esc" onClick={onClose}>
            <i className="ph ph-x" />
          </button>
        </header>

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

          <Step n={2} state={claudeState} title="Claude Code is installed" summary={claudeSummary} open={current === 1} onToggle={() => toggle(1)}>
            {!claude ? (
              <p>Looking for Claude Code…</p>
            ) : claude.installed ? (
              <p>Found Claude Code {claude.version}.</p>
            ) : (
              <>
                <p>Hub could not find the <code>claude</code> command. Install Claude Code, then check again.</p>
                <CopyBox id="install" text={INSTALL_CMD} copied={copied} copy={copy} />
                <p className="hint">Needs Node.js. If you install it while Hub is open, restart Hub so it sees the new PATH.</p>
                <button type="button" className="btn btn-ghost" disabled={checking} onClick={() => void refresh()}>
                  <i className={`ph ph-arrow-clockwise${checking ? " spin" : ""}`} />
                  Check again
                </button>
              </>
            )}
          </Step>

          <Step n={3} state={linkState} title="Add Hub to Claude Code" summary={linkSummary} open={current === 2} onToggle={() => toggle(2)}>
            <p>
              This adds an MCP server named <code>spawner</code> to your Claude Code user settings, so it works in every project and worktree.
            </p>
            <div className="actions">
              <button type="button" className="btn btn-primary" disabled={!mcp?.url || !claude?.installed || connecting} onClick={() => void connect()}>
                <i className={`ph ${connecting ? "ph-circle-notch spin" : "ph-plugs-connected"}`} />
                {link?.state === "connected" ? "Add again" : link?.state === "stale" ? "Update Claude Code" : "Add to Claude Code"}
              </button>
              <button type="button" className="btn btn-ghost" disabled={checking || !claude?.installed} onClick={() => void refresh()}>
                <i className={`ph ph-arrow-clockwise${checking ? " spin" : ""}`} />
                Check connection
              </button>
            </div>
            {link?.state === "connected" && <p className="okline"><i className="ph-bold ph-check" /> Claude Code reached Hub. Restart any open Claude Code session so it loads the new server.</p>}
            {link?.state === "stale" && (
              <p className="err">
                Claude Code still points at <code>{link.configured}</code>, but Hub is now on <code>{url}</code>. Update it.
              </p>
            )}
            {link?.state === "failing" && <p className="err">Claude Code added it but could not connect ({link.detail}). Is Hub still open?</p>}
            {error && <p className="err">{error}</p>}
            <details>
              <summary>Prefer the terminal?</summary>
              <CopyBox id="add" text={addCommand} copied={copied} copy={copy} />
            </details>
          </Step>

          <Step n={4} state={tryState} title="Try it" summary={linkState === "done" ? "ready" : "after step 3"} open={current === 3} onToggle={() => toggle(3)}>
            <p>Start a new Claude Code session and ask for something like this. Using T3 Code with Claude as the provider? It runs Claude Code, so open a new thread and the tools should be there.</p>
            {PROMPTS.map((p, i) => (
              <CopyBox key={p} id={`p${i}`} text={p} copied={copied} copy={copy} />
            ))}
            <p>
              To make it the default, add this to your project <code>CLAUDE.md</code> or <code>~/.claude/CLAUDE.md</code>.
            </p>
            <CopyBox id="md" text={CLAUDE_MD} copied={copied} copy={copy} />
            <div className="actions">
              <button type="button" className="btn btn-ghost" disabled={!claude?.installed || guidance.busy} onClick={() => void addGuidance()}>
                <i className={`ph ${guidance.busy ? "ph-circle-notch spin" : "ph-sparkle"}`} />
                {guidance.busy ? "Adding…" : "Add it for me"}
              </button>
              <span className="hint">Writes the section into your user-level <code>~/.claude/CLAUDE.md</code>, replacing an older copy and leaving the rest untouched.</span>
            </div>
            {guidance.text && (guidance.failed ? <p className="err">{guidance.text}</p> : <p className="okline"><i className="ph-bold ph-check" /> {guidance.text}</p>)}
            <details>
              <summary>Using Codex or another agent?</summary>
              <p className="hint">Any client that speaks MCP over HTTP can use the same URL.</p>
              <CopyBox id="json" text={JSON.stringify({ mcpServers: { "spawner": { type: "http", url } } }, null, 2)} copied={copied} copy={copy} />
              <CopyBox id="toml" text={`[mcp_servers.spawner]\nurl = "${url}"`} copied={copied} copy={copy} />
            </details>
          </Step>
        </ol>

        <footer className="guide-f">
          <span className={`pill ${linkState === "done" ? "ok" : ""}`}>
            <i className={linkState === "done" ? "ph-bold ph-check" : "ph ph-circle"} />
            {linkState === "done" ? "Connected" : "Not connected yet"}
          </span>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {linkState === "done" ? "Done" : "Skip for now"}
          </button>
        </footer>
      </div>
    </div>
  );
}
