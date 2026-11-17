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

/** Opens the PRs in the user's browser; WebView2 refuses window.open, so the backend hands each URL to the OS. */
function openPrs(urls: string[], onToast: (text: string) => void) {
  void Promise.all(urls.map((url) => actions.openUrl(url))).then(
    () => onToast(urls.length === 1 ? `Opened ${urls[0].replace(/^https?:\/\//, "")}` : `Opened ${urls.length} PRs`),
    () => void navigator.clipboard.writeText(urls.join("\n")).then(() => onToast("PR link copied"), () => undefined),
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
  // Where the code is on disk tells a T3 worktree from a main checkout that is merely on the branch.
  const where = group.root ?? group.projects[0]?.path ?? null;
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
          <h2 title={group.label}>{group.label}</h2>
          {/* The pill names the PR and colours its state; the strip below says the rest, so nothing is said twice. */}
          {prs.map((p) => {
            const facts = reviewOf(p);
            return (
              <span key={`${p.repo}#${p.number}`} className={`pill ${facts.cls}`} title={`${p.slug}#${p.number} · ${facts.text} · ${p.title}`}>
                <i className={`ph-bold ph-git-pull-request ${facts.icon}`} />
                {prs.length > 1 ? `${p.repo} ` : ""}#{p.number}
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
            <span className="repos">
              <i className="ph ph-folders" /> {repos.join(" · ")}
              {shared.length ? ` · ${shared.join(", ")} from main` : ""}
            </span>
            {where ? (
              <span className="path" title={where}>
                {where}
              </span>
            ) : null}
          </span>
          <span className="acts">
            {prs.length > 0 ? (
              <button
                type="button"
                className="btn btn-ghost sm"
                title={prs.map((p) => p.url).join("\n")}
                onClick={() => openPrs(prs.map((p) => p.url), log.onToast)}
              >
                <i className="ph ph-github-logo" />
                <span className="lbl">{prs.length > 1 ? `Open ${prs.length} PRs` : "Open PR"}</span>
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
              <div className="prl" key={`${p.repo}#${p.number}`}>
                <i className={`ph-bold ph-git-pull-request ${facts.icon}`} />
                <span className="ti" title={`#${p.number} ${p.title}`}>
                  {p.title}
                </span>
                <span className={`rs ${facts.cls}`}>{facts.text}</span>
                {facts.checks ? (
                  <span className={`ck ${facts.checks.cls}`} title={facts.checks.text}>
                    <i className={`ph-bold ${facts.checks.icon}`} />
                    {facts.checks.text}
                  </span>
                ) : null}
                <span className="grow" />
                <span className="via" title="Via gh pr list, once per repo, cached for a minute">
                  {p.slug} · {snap.prsAt ? ago(snap.prsAt) : "just now"}
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
