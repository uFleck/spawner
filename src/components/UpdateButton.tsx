import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { isActive } from "../api";
import { actions, type Snapshot } from "../store";
import { checkForUpdates, download, getSnapshot, restart, startUpdateChecks, subscribe, type ReleaseNote } from "../updater";

/** How long a manual check's result stays on the button. */
const NOTE_MS = 3_000;
/** How long the popover lingers after the pointer leaves, so it can be reached. */
const CLOSE_MS = 150;

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

/** Plain-text view of a GitHub release body: links become their text, `* ` lines become list items. */
function Markdown({ body }: { body: string }) {
  const out: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (items.length === 0) return;
    out.push(<ul key={out.length}>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>);
    items = [];
  };
  for (const raw of body.split("\n")) {
    const line = raw.trim().replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*(.+?)\*\*/g, "$1");
    if (!line || /^Full Changelog/i.test(line)) continue;
    if (/^[*-]\s/.test(line)) {
      items.push(line.slice(2));
      continue;
    }
    flush();
    out.push(line.startsWith("#") ? <h4 key={out.length}>{line.replace(/^#+\s*/, "")}</h4> : <p key={out.length}>{line}</p>);
  }
  flush();
  return <>{out}</>;
}

function Release({ note }: { note: ReleaseNote }) {
  const date = shortDate(note.date);
  return (
    <section className="upd-rel">
      <h3>{`v${note.version}${date ? ` · ${date}` : ""}`}</h3>
      <Markdown body={note.body} />
    </section>
  );
}

/** Status-bar update button: checks for releases, shows the changelog, downloads, and restarts into the new version. */
export function UpdateButton({ snap }: { snap: Snapshot }) {
  const upd = useSyncExternalStore(subscribe, getSnapshot);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const noteTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    startUpdateChecks();
    return () => {
      window.clearTimeout(noteTimer.current);
      window.clearTimeout(closeTimer.current);
    };
  }, []);

  async function checkNow() {
    const result = await checkForUpdates();
    if (result === "available" || result === "busy") return;
    setNote(result === "none" ? "up to date" : "update check failed");
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), NOTE_MS);
  }

  async function restartNow() {
    const running = Object.values(snap.states).filter(isActive).length;
    try {
      if (running > 0) {
        const ok = await ask(`${running} running app${running === 1 ? "" : "s"} will be stopped.`, {
          title: "Restart to update",
          kind: "warning",
          okLabel: "Restart",
          cancelLabel: "Cancel",
        });
        if (!ok) return;
        await actions.stopAllAndWait();
      }
    } catch (e) {
      console.warn("restart cancelled", e);
      return;
    }
    await restart();
  }

  const enter = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const leave = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_MS);
  };

  const icon = <i className="ph ph-arrow-circle-up" aria-hidden="true" />;
  let button: ReactNode;
  switch (upd.kind) {
    case "checking":
      button = (
        <button type="button" className="upd" disabled aria-label="Checking for updates">
          <i className="ph ph-circle-notch spin" aria-hidden="true" />
        </button>
      );
      break;
    case "available":
      button = (
        <button type="button" className="upd" aria-label={`Update to v${upd.version}`} onClick={() => void download()}>
          <span className="upd-ico">
            {icon}
            <span className="upd-dot" />
          </span>
          {`v${upd.version}`}
        </button>
      );
      break;
    case "downloading":
      button = (
        <button type="button" className="upd" disabled>
          {upd.progress == null ? <i className="ph ph-circle-notch spin" aria-hidden="true" /> : icon}
          {upd.progress == null ? "updating" : `updating ${Math.round(upd.progress * 100)}%`}
        </button>
      );
      break;
    case "ready":
      button = (
        <button type="button" className="upd ready" onClick={() => void restartNow()}>
          {icon}
          restart to update
        </button>
      );
      break;
    case "error":
      button = (
        <button type="button" className="upd bad" data-tip={upd.message} data-side="top" onClick={() => void download()}>
          {icon}
          update failed
        </button>
      );
      break;
    default:
      button = note ? (
        <button type="button" className={`upd${note === "up to date" ? "" : " bad"}`} onClick={() => void checkNow()}>
          {icon}
          {note}
        </button>
      ) : (
        <button type="button" className="upd" aria-label="Check for updates" data-tip="Check for updates" data-side="top" onClick={() => void checkNow()}>
          {icon}
        </button>
      );
  }

  return (
    <span className="upd-wrap" onPointerEnter={enter} onPointerLeave={leave} onFocus={enter} onBlur={leave}>
      {button}
      {upd.kind === "available" && open && (
        <div className="upd-pop">
          {upd.notes.map((n) => (
            <Release key={n.version} note={n} />
          ))}
          <div className="upd-foot">Click to download</div>
        </div>
      )}
    </span>
  );
}
