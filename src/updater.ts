import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { inTauri } from "./components/WindowControls";

const RELEASES_URL = "https://api.github.com/repos/uFleck/spawner/releases?per_page=20";
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface ReleaseNote {
  version: string;
  date: string;
  body: string;
}

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes: ReleaseNote[] }
  | { kind: "downloading"; progress: number | null }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string | null;
}

let state: UpdateState = { kind: "idle" };
let pending: Update | null = null;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l());
}

/** For `useSyncExternalStore`. */
export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const getSnapshot = () => state;

/** Compares `X.Y.Z` versions, ignoring any pre-release suffix. Negative when `a` is older. */
function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map((n) => Number(n) || 0);
  const pb = b.split("-")[0].split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The releases between the running version and the one on offer, newest first. */
async function changelog(update: Update): Promise<ReleaseNote[]> {
  const fallback = [{ version: update.version, date: update.date ?? "", body: update.body ?? "" }];
  try {
    const current = await getVersion();
    const res = await fetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const releases = (await res.json()) as GithubRelease[];
    const notes = releases
      .filter((r) => !r.draft && !r.prerelease)
      .map((r) => ({ version: r.tag_name.replace(/^v/, ""), date: r.published_at ?? "", body: r.body ?? "" }))
      .filter((r) => compareVersions(r.version, current) > 0 && compareVersions(r.version, update.version) <= 0)
      .sort((a, b) => compareVersions(b.version, a.version));
    return notes.length > 0 ? notes : fallback;
  } catch (e) {
    console.warn("changelog unavailable", e);
    return fallback;
  }
}

/** Looks for a new release. A manual check reports its result; a failed one goes back to idle. */
export async function checkForUpdates(): Promise<"available" | "none" | "failed" | "busy"> {
  if (state.kind === "checking" || state.kind === "downloading" || state.kind === "ready") return "busy";
  set({ kind: "checking" });
  try {
    const update = await check();
    if (!update) {
      pending = null;
      set({ kind: "idle" });
      return "none";
    }
    pending = update;
    set({ kind: "available", version: update.version, notes: await changelog(update) });
    return "available";
  } catch (e) {
    console.warn("update check failed", e);
    set({ kind: "idle" });
    return "failed";
  }
}

/** Downloads the update on offer, reporting progress as it arrives. */
export async function download() {
  const update = pending;
  if (!update) return;
  let total = 0;
  let got = 0;
  set({ kind: "downloading", progress: null });
  try {
    await update.download((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      if (event.event === "Progress") {
        got += event.data.chunkLength;
        set({ kind: "downloading", progress: total > 0 ? Math.min(got / total, 1) : null });
      }
    });
    set({ kind: "ready", version: update.version });
  } catch (e) {
    set({ kind: "error", message: String(e) });
  }
}

/** Installs the downloaded update and relaunches the app. */
export async function restart() {
  const update = pending;
  if (!update) return;
  try {
    await update.install();
    await relaunch();
  } catch (e) {
    set({ kind: "error", message: String(e) });
  }
}

let started = false;

/** Checks shortly after launch, then every few hours. Only in a packaged app, never in dev or a browser. */
export function startUpdateChecks() {
  if (started || !inTauri || !import.meta.env.PROD) return;
  started = true;
  const tick = () => void checkForUpdates();
  window.setTimeout(() => {
    tick();
    window.setInterval(tick, CHECK_EVERY_MS);
  }, FIRST_CHECK_MS);
}
