import { useState } from "react";
import type { Root } from "../api";
import { Dialog } from "./ConcludeDialog";

/** What the user hands their AI agent. The format itself comes from the `hub_script_guide` MCP tool, so it is not repeated here. */
export function scriptsPrompt(roots: Root[]): string {
  const folders = roots.length ? roots.map((r) => `- ${r.path}`).join("\n") : "- (none added to Spawner yet)";
  return [
    "Wire up my scripts in Spawner, so I can run them from its Scripts section.",
    "",
    "1. Call Spawner's hub_script_guide tool and follow it exactly. It has the spawner.json format.",
    "2. Find the scripts I run by hand in these folders. Write a spawner.json next to them that declares each one worth running as a named command:",
    folders,
    '3. Call hub_rescan, then hub_list_apps, to check they are listed under "scripts". Run one with hub_start to prove it works.',
    "",
    "Do not change what the scripts do. Ask me when it is unclear which ones matter.",
  ].join("\n");
}

export function ScriptsGuide({ roots, onClose, onToast }: { roots: Root[]; onClose: () => void; onToast: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  const prompt = scriptsPrompt(roots);
  const copy = () => {
    void navigator.clipboard.writeText(prompt);
    setCopied(true);
    onToast("Prompt copied. Paste it to your AI agent");
  };
  return (
    <Dialog
      tone="ask"
      icon="ph ph-magic-wand"
      title="Tell AI to wire up my scripts"
      lead="Spawner runs a script once a spawner.json next to it declares it. Your agent can write that file."
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" data-first="" onClick={copy}>
            <i className={copied ? "ph-bold ph-check" : "ph ph-copy"} aria-hidden="true" />
            {copied ? "Copied" : "Copy prompt"}
          </button>
        </>
      }
    >
      <div className="copybox">
        <pre>{prompt}</pre>
      </div>
      <p className="dlg-note">
        <i className="ph ph-plugs-connected" aria-hidden="true" />
        Needs an agent connected to Spawner. Once connected, it is also taught this when it tries to run a script Spawner does not know.
      </p>
    </Dialog>
  );
}
