import { useEffect, useRef, useState, type MouseEvent } from "react";
import { isActive } from "../api";
import { MAIN, resolvePreset, targetLabel, targetsFor, type Preset } from "../presets";
import { actions, type Snapshot } from "../store";
import { useContextMenu } from "./ContextMenu";
import { IconButton } from "./IconButton";

/** A name field that commits on Enter and gives up on Escape or when it loses focus. */
function NameInput({
  initial = "",
  hint,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  hint?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  return (
    <li className="preset-row editing">
      <i className="ph ph-bookmark-simple" />
      <div className="meta">
        <input
          ref={input}
          autoFocus
          defaultValue={initial}
          placeholder="Preset name"
          aria-label="Preset name"
          onBlur={onCancel}
          onKeyDown={(e) => {
            const name = e.currentTarget.value.trim();
            if (e.key === "Enter" && name) onSubmit(name);
            else if (e.key === "Escape") onCancel();
          }}
        />
        {hint && <div className="sub">{hint}</div>}
      </div>
    </li>
  );
}

function PresetRow({ preset, snap }: { preset: Preset; snap: Snapshot }) {
  const [renaming, setRenaming] = useState(false);
  const menu = useContextMenu();
  const { hits, missing } = resolvePreset(preset, snap.groups);
  const live = hits.filter((h) => isActive(snap.states[h.instance]));
  const allUp = hits.length > 0 && live.length === hits.length;
  const busy = live.some((h) => ["building", "starting"].includes(snap.states[h.instance]?.kind ?? ""));
  const dot = allUp && !busy ? "running" : live.length ? "starting" : "idle";
  const where = targetLabel(preset, snap.groups);
  const targets = targetsFor(preset, snap.groups);

  if (renaming)
    return (
      <NameInput
        initial={preset.name}
        onSubmit={(name) => (actions.renamePreset(preset.id, name), setRenaming(false))}
        onCancel={() => setRenaming(false)}
      />
    );

  const runIn = (target: string) => {
    actions.setPresetTarget(preset.id, target);
    void actions.runPreset({ ...preset, target });
  };
  const targetItems = () => [
    { label: "Main checkouts", icon: preset.target === MAIN ? "ph-bold ph-check" : "ph ph-git-branch", run: () => runIn(MAIN) },
    ...targets.map((g) => ({
      label: g.label,
      icon: preset.target === g.id ? "ph-bold ph-check" : "ph ph-git-branch",
      run: () => runIn(g.id),
    })),
  ];
  const pickTarget = (e: MouseEvent) => menu.show(e, targetItems());

  return (
    <li
      className="preset-row"
      data-state={dot}
      onContextMenu={(e) =>
        menu.show(e, [
          allUp
            ? { label: "Stop", icon: "ph ph-stop", danger: true, run: () => void actions.stopPreset(preset) }
            : { label: "Run", icon: "ph ph-play", disabled: hits.length === 0, run: () => void actions.runPreset(preset) },
          { label: "Restart", icon: "ph ph-arrow-clockwise", disabled: hits.length === 0, run: () => void actions.restartPreset(preset) },
          "sep",
          ...targetItems().map((t) => ({ ...t, label: `Run in ${t.label}` })),
          "sep",
          { label: "Rename", icon: "ph ph-pencil-simple", run: () => setRenaming(true) },
          { label: "Replace with running apps", icon: "ph ph-arrows-clockwise", run: () => actions.setPresetToRunning(preset.id) },
          { label: "Delete preset", icon: "ph ph-trash", danger: true, run: () => actions.deletePreset(preset.id) },
        ])
      }
    >
      <span className="dot" />
      <div className="meta">
        <div className="nm">{preset.name}</div>
        <div className="sub">
          {preset.members.length === 0 ? (
            "No apps yet · right-click an app to add"
          ) : (
            <>
              <span className="mem">{preset.members.map((m) => m.name).join(" · ")}</span>
              <span> · </span>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  pickTarget(e);
                }}
              >
                {where}
              </a>
            </>
          )}
          {missing.length > 0 && <span className="warn-text"> · {missing.length} missing</span>}
        </div>
      </div>
      <div className="acts">
        <IconButton
          small
          className="hov"
          icon="ph ph-arrow-clockwise"
          label="Restart preset"
          disabled={hits.length === 0}
          onClick={() => void actions.restartPreset(preset)}
        />
        <IconButton
          icon={allUp ? "ph-fill ph-stop" : "ph-fill ph-play"}
          className={allUp ? "danger" : ""}
          label={allUp ? "Stop preset" : live.length ? "Start the rest" : "Run preset"}
          disabled={hits.length === 0}
          onClick={() => void (allUp ? actions.stopPreset(preset) : actions.runPreset(preset))}
        />
      </div>
    </li>
  );
}

export function Presets({ snap }: { snap: Snapshot }) {
  const [closed, setClosed] = useState(false);
  const draft = snap.presetDraft;
  return (
    <section className={`presets${closed ? " closed" : ""}`}>
      <div className="presets-h" onClick={() => setClosed(!closed)}>
        <span className="caret">
          <i className="ph-bold ph-caret-down" />
        </span>
        <span className="t">Presets</span>
        <span className="n">{snap.presets.length}</span>
        <IconButton
          small
          icon="ph ph-plus"
          label="New preset from running apps"
          onClick={(e) => (e.stopPropagation(), setClosed(false), actions.draftFromRunning())}
        />
      </div>
      <div className="collapse">
        <div className="in">
          <ul className="preset-list">
            {draft && (
              <NameInput
                initial={draft.name}
                hint={draft.members.length ? draft.members.map((m) => m.name).join(" · ") : "No apps yet"}
                onSubmit={(name) => actions.createPreset(name, draft.members)}
                onCancel={actions.cancelDraft}
              />
            )}
            {snap.presets.map((p) => (
              <PresetRow key={p.id} preset={p} snap={snap} />
            ))}
            {!draft && snap.presets.length === 0 && <li className="root-none">Run some apps, then save them with +</li>}
          </ul>
        </div>
      </div>
    </section>
  );
}
