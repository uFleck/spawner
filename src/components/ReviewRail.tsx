import { useMemo, useState } from "react";
import { isActive, type Group, type Pr } from "../api";
import { ago, prsFor, reviewOf, scopeIds, serviceCount, worktrees } from "../review";
import { actions, type Snapshot } from "../store";

interface Props {
  snap: Snapshot;
  /** The filter box's text, without its state keywords. */
  query: string;
}

/** A worktree as the rail reads it: its PRs, and the instances whose state the row shows. */
interface Row {
  group: Group;
  prs: Pr[];
  /** Every app of the worktree's stack, shared main checkouts included, for the state dots. */
  ids: string[];
  /** Only the apps that run from the worktree's own checkout, which is what its Run/Stop button acts on. */
  own: string[];
}

/** The compact Run stack / Stop stack button every row carries: the cockpit's one-click path. */
function StackButton({ group, snap, live }: { group: Group; snap: Snapshot; live: boolean }) {
  const stack = snap.stacks[group.id];
  // Once the stack is known to be missing, the row says so instead of offering a start that cannot work.
  if (stack && !stack.source)
    return (
      <span className="wt-nostack" role="img" aria-label="No stack yet" title="No spawner.stack.json yet: open the worktree to set one up">
        <i className="ph ph-stack" aria-hidden="true" />
      </span>
    );
  if (live)
    return (
      <button
        type="button"
        className="runbtn stop"
        aria-label={`Stop stack ${group.label}`}
        data-tip="Stop stack"
        data-side="bottom"
        onClick={(e) => {
          e.stopPropagation();
          void actions.stopStack(group.id);
        }}
      >
        <i className="ph-fill ph-stop" />
      </button>
    );
  return (
    <button
      type="button"
      className="runbtn"
      aria-label={`Run stack ${group.label}`}
      data-tip="Run stack"
      data-side="bottom"
      disabled={snap.stackBusy}
      onClick={(e) => {
        e.stopPropagation();
        // Running from the rail is the one-click path: open the worktree so its stack and logs are right there.
        actions.selectWorktree(group.id);
        void actions.startStack(group.id);
      }}
    >
      <i className={snap.stackBusy ? "ph ph-circle-notch spin" : "ph-fill ph-play"} />
    </button>
  );
}

/** One app per dot, so a row says "two of these are up" without opening the worktree. */
function Dots({ ids, snap }: { ids: string[]; snap: Snapshot }) {
  return (
    <span className="dots">
      {ids.slice(0, 4).map((id) => {
        const state = snap.states[id];
        return <span key={id} className="dot" data-state={state?.kind ?? "idle"} title={`${id.split("::")[1]}: ${state?.kind ?? "idle"}`} />;
      })}
    </span>
  );
}

function Row({
  row,
  snap,
  current,
  onPick,
}: {
  row: Row;
  snap: Snapshot;
  current: boolean;
  onPick: () => void;
}) {
  const { group, prs, ids, own } = row;
  const pr = prs[0];
  const facts = pr ? reviewOf(pr) : null;
  // A shared main app running for another worktree must not turn this row's button into Stop.
  const live = own.some((id) => isActive(snap.states[id]));
  const stack = snap.stacks[group.id];
  // A no-stack worktree still says how many apps it has, from what the scan found.
  const apps = stack?.source ? stack.apps.length : serviceCount(group);
  const repos = [...new Set(group.projects.map((p) => p.repo))].join(" · ");
  return (
    <div
      className={`wt-row${pr ? " review" : ""}${current ? " cur" : ""}`}
      role="button"
      tabIndex={0}
      aria-current={current}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <span className={`wt-g ${facts?.icon ?? ""}`}>
        <i className={pr ? "ph-bold ph-git-pull-request" : live ? "ph-bold ph-git-branch" : "ph ph-git-branch"} />
      </span>
      <span className="wt-t">
        {group.label}
        {pr ? <span className="wt-num">#{pr.number}</span> : null}
        {prs.length > 1 ? <span className="wt-num" title={`${prs.length} open PRs`}>+{prs.length - 1}</span> : null}
      </span>
      <span className="wt-r">
        <StackButton group={group} snap={snap} live={live} />
      </span>
      {pr && facts ? (
        <>
          <span className="wt-s" title={pr.title}>
            {pr.title}
          </span>
          <span className="wt-m">
            {/* The dots sit on the state line, not beside the button, so the worktree name keeps its room. */}
            {live ? <Dots ids={ids} snap={snap} /> : null}
            <span className={`rs ${facts.cls}`}>{facts.text}</span>
            {facts.checks ? (
              <span className={`rs ${facts.checks.cls}`} title={facts.checks.text}>
                <i className={`ph-bold ${facts.checks.icon}`} />
                {facts.checks.short}
              </span>
            ) : null}
            {/* Repos are on the workspace header, and repeating them here is what squeezed the app count at 307 px. */}
            <span className="wt-dim wt-repos" title={apps ? `${repos} · ${apps} app${apps === 1 ? "" : "s"}` : repos}>
              {apps ? `${apps} app${apps === 1 ? "" : "s"}` : repos}
            </span>
          </span>
        </>
      ) : (
        <span className="wt-s">
          {repos}
          {apps ? ` · ${apps} app${apps === 1 ? "" : "s"}` : ""}
          {live ? ` · ${ids.filter((id) => isActive(snap.states[id])).length} running` : ""}
        </span>
      )}
    </div>
  );
}

/**
 * The rail's review-first body: worktrees with an open PR, then the ones running, then the rest folded away. Rising
 * into In review takes an open PR; nothing here talks to an agent or a board.
 */
export function ReviewRail({ snap, query }: Props) {
  const [recentOpen, setRecentOpen] = useState(false);
  const rows = useMemo(
    () =>
      worktrees(snap.groups).map((group): Row => {
        const stack = snap.stacks[group.id] ?? null;
        return {
          group,
          prs: prsFor(group, snap.prs),
          // The stack of a worktree that has never been opened is not known yet; its own apps are the honest guess.
          ids: scopeIds(group, stack),
          own: stack ? stack.apps.filter((a) => !a.shared).map((a) => a.instance) : scopeIds(group, null),
        };
      }),
    [snap.groups, snap.prs, snap.stacks],
  );

  const q = query.trim().toLowerCase();
  const matches = (row: Row) =>
    !q ||
    [
      row.group.label,
      ...row.group.projects.map((p) => `${p.repo} ${p.branch ?? ""}`),
      ...row.prs.map((p) => `#${p.number} ${p.title} ${p.head}`),
      ...row.group.projects.flatMap((p) => p.apps.map((a) => a.name)),
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);

  const review = rows.filter((r) => r.prs.length > 0 && matches(r));
  const running = rows.filter((r) => r.prs.length === 0 && matches(r) && r.ids.some((id) => isActive(snap.states[id])));
  const activity = (r: Row) => Math.max(0, ...r.ids.map((id) => snap.lastRun[id] ?? 0));
  const rest = rows
    .filter((r) => r.prs.length === 0 && !running.includes(r) && matches(r))
    .sort((a, b) => activity(b) - activity(a));
  const openRecent = recentOpen || q !== "" || rest.some((r) => r.group.id === snap.selectedWorktree);

  const empty = review.length === 0 && running.length === 0 && rest.length === 0;
  if (empty && !snap.prsError) return q ? <p className="empty">No worktree matches.</p> : null;

  const pick = (id: string) => actions.selectWorktree(id);

  return (
    <>
      {(review.length > 0 || snap.prsError !== null) && (
        <section className="wt-sec">
          <div className="wt-sec-h">
            <span className="t">In review</span>
            {review.length > 0 && <span className="n">{review.length}</span>}
            <span className="wt-src" title="gh pr list, once per repo, cached for a minute">
              {snap.prsError ? "gh" : snap.prsAt ? `via gh · ${ago(snap.prsAt)}` : "via gh"}
            </span>
          </div>
          {snap.prsError && (
            <p className="wt-note" role="status">
              <i className="ph ph-warning-circle" />
              PRs unavailable: {snap.prsError}
            </p>
          )}
          {review.map((row) => (
            <Row key={row.group.id} row={row} snap={snap} current={row.group.id === snap.selectedWorktree} onPick={() => pick(row.group.id)} />
          ))}
        </section>
      )}

      {running.length > 0 && (
        <section className="wt-sec">
          <div className="wt-sec-h">
            <span className="t">Running</span>
            <span className="n">{running.length}</span>
          </div>
          {running.map((row) => (
            <Row key={row.group.id} row={row} snap={snap} current={row.group.id === snap.selectedWorktree} onPick={() => pick(row.group.id)} />
          ))}
        </section>
      )}

      {rest.length > 0 && (
        <section className={`wt-sec${openRecent ? "" : " closed"}`}>
          <button type="button" className="wt-sec-h as-btn" aria-expanded={openRecent} onClick={() => setRecentOpen(!recentOpen)}>
            <i className="ph-bold ph-caret-down" />
            <span className="t">Recent</span>
            <span className="n">{rest.length}</span>
          </button>
          {openRecent &&
            rest.map((row) => (
              <Row key={row.group.id} row={row} snap={snap} current={row.group.id === snap.selectedWorktree} onPick={() => pick(row.group.id)} />
            ))}
        </section>
      )}
    </>
  );
}
