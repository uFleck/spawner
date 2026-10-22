import { actions, UNDO_MS, type Snapshot } from "../store";

/** One bar per conclusion that can still be undone. The bar drains for as long as the undo is on offer. */
export function UndoToasts({ undos }: { undos: Snapshot["undos"] }) {
  if (undos.length === 0) return null;
  return (
    <div className="undo-stack" role="status">
      {undos.map((u) => (
        <div className={`undo ${u.status}${u.partial ? " partial" : ""}`} key={u.id}>
          <i className={u.status === "restored" ? "ph-fill ph-arrow-counter-clockwise" : u.partial ? "ph-fill ph-warning" : "ph-fill ph-check-circle"} aria-hidden="true" />
          <span className="undo-t">
            {u.status === "restored" ? (
              <>
                Restored <b>{u.label}</b>
              </>
            ) : u.status === "restoring" ? (
              <>
                Restoring <b>{u.label}</b>…
              </>
            ) : (
              <>
                {u.partial ? "Deleted " : "Concluded "}
                {u.partial && <>{u.removed.map((r) => r.repo).join(", ")} from </>}
                <b>{u.label}</b>
              </>
            )}
          </span>
          {u.status !== "restored" && (
            <button type="button" className="undo-act" disabled={u.status === "restoring"} onClick={() => void actions.undoConclude(u.id)}>
              {u.status === "restoring" ? <i className="ph-bold ph-circle-notch spin" aria-hidden="true" /> : <i className="ph-bold ph-arrow-u-up-left" aria-hidden="true" />}
              Undo
            </button>
          )}
          {u.status === "ready" && <span className="undo-bar" style={{ animationDuration: `${UNDO_MS}ms` }} />}
        </div>
      ))}
    </div>
  );
}
