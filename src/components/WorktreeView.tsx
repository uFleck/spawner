import { useEffect, useMemo } from "react";
import { isActive, type Group } from "../api";
import { ago, prsFor, reviewOf, scopeIds } from "../review";
import { actions, type Snapshot } from "../store";
import { IconButton } from "./IconButton";
import { LogPane, type LogPaneProps } from "./LogPane";
import { StackCard } from "./StackCard";

interface Props {
  snap: Snapshot;
  group: Group;
  /** The log view's own state, shared with the merged view so switching does not lose the setup. */
  log: Omit<LogPaneProps, "scope" | "scopeLabel">;
}

/** Opens a PR in the user's browser; WebView2 refuses window.open, so the backend hands it to the OS. */
function openPr(url: string, onToast: (text: string) => void) {
  void actions.openUrl(url).then(
    () => onToast(`Opened ${url.replace(/^https?:\/\//, "")}`),
    () => void navigator.clipboard.writeText(url).then(() => onToast("PR link copied"), () => undefined),
  );
}

/**
 * The workspace of one worktree: its header, the stack that runs it and the logs of exactly those apps. The worktree,
 * its PR and its stack are the whole surface; nothing else is offered here.
 */
export function WorktreeView({ snap, group, log }: Props) {
  const prs = prsFor(group, snap.prs);
  const stack = snap.stacks[group.id] ?? (snap.stackFor === group.id ? snap.stack : null);
  const scope = useMemo(() => new Set(scopeIds(group, stack)), [group, stack]);
  const branch = group.projects.find((p) => p.branch)?.branch ?? null;
  const repos = [...new Set(group.projects.map((p) => p.repo))];
  const shared = [...new Set((stack?.apps ?? []).filter((a) => a.shared).map((a) => a.repo))];
  const hasStack = !!stack?.source;
  const services = stack?.apps.filter((a) => a.mode === "service") ?? [];
  const live = services.filter((a) => isActive(snap.states[a.instance])).length;
  const allLive = services.length > 0 && live === services.length;

  // Opening a worktree reads its stack once; every start, stop and port move refreshes it through the store.
  useEffect(() => {
    void actions.loadStack(group.id);
  }, [group.id]);

  return (
    <div className="ws">
      <header className="ws-h" data-tauri-drag-region>
        <div className="ws-top">
          <IconButton icon="ph ph-sidebar-simple" label="Toggle sidebar" kbd="Ctrl B" onClick={log.onToggleSide} />
          <h2>{group.label}</h2>
          {prs.map((p) => {
            const facts = reviewOf(p);
            return (
              <span key={p.number} className={`pill ${facts.cls}`} title={`#${p.number} · ${facts.text}`}>
                <i className="ph-bold ph-git-pull-request" />#{p.number} · {facts.text}
              </span>
            );
          })}
          <span className="grow" />
        </div>
        <div className="ws-meta">
          <span className="sub">
            {branch && branch !== group.label ? (
              <span>
                <i className="ph ph-git-branch" /> {branch}
              </span>
            ) : null}
            <span>
              <i className="ph ph-folders" /> {repos.join(" · ")}
              {shared.length ? ` · ${shared.join(", ")} shared` : ""}
            </span>
          </span>
          <span className="acts">
            {prs[0] ? (
              <button type="button" className="btn btn-ghost sm" onClick={() => openPr(prs[0].url, log.onToast)}>
                <i className="ph ph-github-logo" />
                <span className="lbl">Open PR</span>
              </button>
            ) : null}
            {hasStack ? (
              <>
                <button
                  type="button"
                  className="btn btn-ghost sm"
                  disabled={snap.stackBusy || live === 0}
                  onClick={() => void actions.stopStack(group.id)}
                >
                  <i className="ph-fill ph-stop" />
                  <span className="lbl">Stop stack</span>
                </button>
                <button
                  type="button"
                  className="btn btn-primary sm"
                  disabled={snap.stackBusy || allLive}
                  onClick={() => void actions.startStack(group.id)}
                >
                  <i className={snap.stackBusy ? "ph ph-circle-notch spin" : "ph-fill ph-play"} />
                  {allLive ? "Stack running" : live ? "Run the rest" : "Run stack"}
                </button>
              </>
            ) : null}
          </span>
        </div>
      </header>

      {prs.length > 0 && (
        <div className="prs">
          {prs.map((p) => {
            const facts = reviewOf(p);
            return (
              <div className="prl" key={p.number}>
                <i className={`ph-bold ph-git-pull-request ${facts.icon}`} />
                <span className="num">#{p.number}</span>
                <span className="ti" title={p.title}>
                  {p.title}
                </span>
                <span className={`rs ${facts.cls}`}>{facts.text}</span>
                {facts.checks ? (
                  <span className={`ck ${facts.checks.cls}`}>
                    <i
                      className={`ph-bold ${
                        facts.checks.cls === "ok" ? "ph-check" : facts.checks.cls === "bad" ? "ph-x" : "ph-circle-dashed"
                      }`}
                    />
                    {facts.checks.text}
                  </span>
                ) : null}
                <span className="grow" />
                <span className="via" title="gh pr list, once per repo, cached for a minute">
                  {p.slug} · via gh · {snap.prsAt ? ago(snap.prsAt) : "just now"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <StackCard snap={snap} group={group} stack={stack} onToast={log.onToast} />
      <LogPane {...log} scope={scope} scopeLabel={group.label} />
    </div>
  );
}
