import { useEffect, useRef, type ReactNode } from "react";
import { instanceId, isActive, type Group } from "../api";
import { actions, UNDO_MS, type ConcludeProblem, type Snapshot } from "../store";

export function Dialog({
  tone,
  icon,
  title,
  lead,
  onClose,
  footer,
  children,
}: {
  tone: "ask" | "warn";
  icon: string;
  title: string;
  lead: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("[data-first]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab" && box.current) {
        const items = [...box.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)")];
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
        e.preventDefault();
        items[next]?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="dlg-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dlg ${tone}`} role="dialog" aria-modal="true" aria-labelledby="dlg-title" ref={box}>
        <div className="dlg-h">
          <span className="dlg-ico">
            <i className={icon} aria-hidden="true" />
          </span>
          <div>
            <h2 id="dlg-title">{title}</h2>
            <p>{lead}</p>
          </div>
        </div>
        <div className="dlg-b">{children}</div>
        <div className="dlg-f">{footer}</div>
      </div>
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function ConfirmConclude({ group, states }: { group: Group; states: Snapshot["states"] }) {
  const running = group.projects.reduce(
    (n, p) => n + p.apps.filter((a) => isActive(states[instanceId(p.id, a.id)])).length,
    0,
  );
  return (
    <Dialog
      tone="ask"
      icon="ph ph-check-circle"
      title={`Conclude “${group.label}”?`}
      lead="The worktree folders are deleted from disk and the task leaves Spawner. The branches are kept."
      onClose={actions.closeDialog}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={actions.closeDialog}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" data-first onClick={() => void actions.confirmConclude()}>
            Conclude
          </button>
        </>
      }
    >
      <ul className="dlg-list">
        {group.projects.map((p, i) => (
          <li key={p.id} style={{ ["--i" as string]: i }}>
            <i className="ph ph-folder-simple" aria-hidden="true" />
            <span className="nm">{p.repo}</span>
            {p.branch && <span className="br">{p.branch}</span>}
          </li>
        ))}
      </ul>
      {running > 0 && (
        <p className="dlg-note warn">
          <i className="ph-fill ph-warning" aria-hidden="true" />
          {plural(running, "running app")} will be stopped first.
        </p>
      )}
      <p className="dlg-note">
        <i className="ph ph-arrow-counter-clockwise" aria-hidden="true" />
        You can undo this for {UNDO_MS / 1000} seconds. Folders such as node_modules are not restored.
      </p>
    </Dialog>
  );
}

function ConcludeProblemDialog({ problem }: { problem: ConcludeProblem }) {
  const { group, refused, removed, message } = problem;
  const force = refused.some((r) => r.needsForce);
  const lead = message
    ? "Nothing was deleted. Spawner could not get as far as removing the worktrees."
    : `Git refused to delete ${refused.length} of ${plural(group.projects.length + removed.length, "worktree")}.`;
  return (
    <Dialog
      tone="warn"
      icon="ph-fill ph-warning"
      title={`Could not conclude “${group.label}”`}
      lead={lead}
      onClose={actions.closeDialog}
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={() => actions.dismissProblem(group.id)}>
            Dismiss warning
          </button>
          <span className="grow" />
          <button type="button" className="btn btn-ghost" data-first={force ? "" : undefined} onClick={actions.closeDialog}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${force ? "btn-danger" : "btn-primary"}`}
            data-first={force ? undefined : ""}
            onClick={() => void actions.proceedConclude()}
          >
            {force ? "Delete anyway" : "Try again"}
          </button>
        </>
      }
    >
      <ul className="dlg-list why">
        {message && (
          <li>
            <i className="ph ph-x-circle" aria-hidden="true" />
            <code>{message}</code>
          </li>
        )}
        {refused.map((r, i) => (
          <li key={r.repo} style={{ ["--i" as string]: i }}>
            <i className="ph ph-folder-simple" aria-hidden="true" />
            <span className="nm">{r.repo}</span>
            {r.needsForce && <span className="br warn">uncommitted changes</span>}
            <code>{r.reason}</code>
          </li>
        ))}
      </ul>
      {removed.length > 0 && (
        <div className="dlg-note keep">
          <i className="ph ph-check" aria-hidden="true" />
          <span>
            {removed.map((r) => r.repo).join(", ")} {removed.length === 1 ? "was" : "were"} already deleted. To keep this task as it was:
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => void actions.restoreRemoved(group.id)}>
            <i className="ph ph-arrow-u-up-left" aria-hidden="true" />
            Restore {removed.length === 1 ? removed[0].repo : `${removed.length} worktrees`}
          </button>
        </div>
      )}
      {force && (
        <p className="dlg-note danger">
          <i className="ph-fill ph-warning-octagon" aria-hidden="true" />
          Deleting anyway discards the uncommitted and untracked changes for good. Undo cannot bring them back.
        </p>
      )}
    </Dialog>
  );
}

export function ConcludeDialog({ snap }: { snap: Snapshot }) {
  const { dialog } = snap;
  if (!dialog) return null;
  if (dialog.kind === "confirm") return <ConfirmConclude key={dialog.group.id} group={dialog.group} states={snap.states} />;
  const problem = snap.problems[dialog.group.id];
  return problem ? <ConcludeProblemDialog key={dialog.group.id} problem={problem} /> : null;
}
