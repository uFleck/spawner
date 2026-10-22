import { useState } from "react";
import { instanceId, type AppDef, type Param } from "../api";
import { actions, type Snapshot } from "../store";
import { Dialog } from "./ConcludeDialog";

/** What the user typed for each script, kept for the next run of it. Keyed by instance id; gone when Spawner closes. */
const lastValues = new Map<string, Record<string, string>>();

const startingValues = (params: Param[], remembered: Record<string, string> = {}) =>
  Object.fromEntries(params.map((p) => [p.name, remembered[p.name] ?? (p.kind === "flag" ? p.default ?? "" : "")]));

const isOn = (value: string) => ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());

function Field({ param, value, first, onChange, onEnter }: { param: Param; value: string; first: boolean; onChange: (v: string) => void; onEnter: () => void }) {
  const id = `run-${param.name}`;
  const label = (
    <label htmlFor={id}>
      <span className="nm">{param.name}</span>
      {param.flag && <code>{param.flag}</code>}
      {param.required && <span className="req">required</span>}
    </label>
  );
  if (param.kind === "flag") {
    return (
      <div className="run-fld check">
        <label htmlFor={id}>
          <input id={id} type="checkbox" checked={isOn(value)} data-first={first ? "" : undefined} onChange={(e) => onChange(String(e.target.checked))} />
          <span className="nm">{param.name}</span>
          {param.flag && <code>{param.flag}</code>}
        </label>
        {param.hint && <p className="hint">{param.hint}</p>}
      </div>
    );
  }
  return (
    <div className="run-fld">
      {label}
      {param.options.length > 0 ? (
        <select id={id} value={value} data-first={first ? "" : undefined} onChange={(e) => onChange(e.target.value)}>
          <option value="">{param.default ? `${param.default} (default)` : param.required ? "Choose…" : "—"}</option>
          {param.options.filter((o) => o !== param.default || value === o).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type="text"
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={param.placeholder ?? param.default ?? undefined}
          data-first={first ? "" : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onEnter())}
        />
      )}
      {param.hint && <p className="hint">{param.hint}</p>}
    </div>
  );
}

function RunForm({ projectId, app }: { projectId: string; app: AppDef }) {
  const key = instanceId(projectId, app.id);
  const [values, setValues] = useState(() => startingValues(app.params, lastValues.get(key)));
  const missing = app.params.filter((p) => p.kind === "text" && p.required && !values[p.name]?.trim());
  const run = () => {
    if (missing.length) return;
    lastValues.set(key, values);
    void actions.start(projectId, app.id, false, values);
  };
  return (
    <Dialog
      tone="ask"
      icon="ph ph-play"
      title={`Run “${app.name}”`}
      lead={app.description ?? "Fill in what the script needs, then run it."}
      onClose={actions.cancelRunAsk}
      footer={
        <>
          {missing.length > 0 && <span className="run-miss">Needs {missing.map((p) => p.name).join(", ")}</span>}
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={actions.cancelRunAsk}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={missing.length > 0} onClick={run}>
            <i className="ph-fill ph-play" aria-hidden="true" />
            Run
          </button>
        </>
      }
    >
      {app.params.map((p, i) => (
        <Field key={p.name} param={p} value={values[p.name] ?? ""} first={i === 0} onChange={(v) => setValues((cur) => ({ ...cur, [p.name]: v }))} onEnter={run} />
      ))}
    </Dialog>
  );
}

/** Asks for a script's params before it runs, with each one's hint, so the user learns what it needs from the form and not from its failure. */
export function RunDialog({ snap }: { snap: Snapshot }) {
  const ask = snap.runAsk;
  if (!ask) return null;
  const project = snap.groups.flatMap((g) => g.projects).find((p) => p.id === ask.projectId);
  const app = project?.apps.find((a) => a.id === ask.appId);
  return app ? <RunForm key={instanceId(ask.projectId, ask.appId)} projectId={ask.projectId} app={app} /> : null;
}
