import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import { api, isActive, type Group, type InstanceState, type LogLine, type StateEvent } from "../api";
import { isFrame } from "../logModel";

/** Lines kept per app, for the tail shown on hover. */
export const KEEP = 8;
/** Log lines are applied in batches, so a chatty app does not re-render the window for every line. */
const BATCH_MS = 150;

export interface Feed {
  states: Record<string, InstanceState>;
  groups: Group[];
  /** The last `KEEP` lines of each instance, without stack frames or blank lines. */
  recent: Record<string, LogLine[]>;
  /** When each instance last printed, by this window's clock, so lines from before it opened do not count as live. */
  heard: Record<string, number>;
  /** Errored instances the user waved away. They come back when they start again. */
  dismissed: string[];
}

let feed: Feed = { states: {}, groups: [], recent: {}, heard: {}, dismissed: [] };
const subs = new Set<() => void>();

function set(patch: Partial<Feed>) {
  feed = { ...feed, ...patch };
  subs.forEach((s) => s());
}

let lastSeq = 0;
let pending: LogLine[] = [];
let timer: number | undefined;
/** Lines that arrive while the backlog is loading wait for it, or the older backlog would be dropped as already seen. */
let ready = false;

function take(lines: LogLine[], live: boolean) {
  const recent = { ...feed.recent };
  const heard = { ...feed.heard };
  const now = Date.now();
  // Two output streams of one app are read apart, so their lines can arrive slightly out of order.
  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
    if (line.seq <= lastSeq) continue;
    lastSeq = line.seq;
    if (isFrame(line) || !line.text.trim()) continue;
    const list = recent[line.instance] ?? [];
    recent[line.instance] = [...(list.length >= KEEP ? list.slice(list.length - KEEP + 1) : list), line];
    if (live) heard[line.instance] = now;
  }
  set({ recent, heard });
}

function flush() {
  timer = undefined;
  const batch = pending;
  pending = [];
  take(batch, true);
}

function onLine(line: LogLine) {
  pending.push(line);
  if (ready && timer === undefined) timer = window.setTimeout(flush, BATCH_MS);
}

function onState({ id, state }: StateEvent) {
  const { [id]: _gone, ...states } = feed.states;
  if (state.kind !== "idle") states[id] = state;
  const restarted = isActive(state) && !isActive(feed.states[id]);
  if (restarted) pending = pending.filter((l) => l.instance !== id);
  set({
    states,
    // A new run starts with an empty tail, so the last run's crash is not shown as current.
    ...(restarted ? { recent: { ...feed.recent, [id]: [] }, dismissed: feed.dismissed.filter((d) => d !== id) } : {}),
  });
}

let started = false;
async function start() {
  if (started) return;
  started = true;
  await listen<StateEvent>("instance-state", (e) => onState(e.payload));
  await listen<LogLine>("log-line", (e) => onLine(e.payload));
  await listen<Group[]>("groups-changed", (e) => set({ groups: e.payload }));
  const [groups, states, backlog] = await Promise.all([api.groups(), api.instanceStates(), api.logsSince(0)]);
  set({ groups, states });
  take(backlog, false);
  ready = true;
  flush();
}

export function dismiss(id: string) {
  set({ dismissed: [...feed.dismissed, id] });
  void api.companionDismiss(id);
}

export function useFeed(): Feed {
  useEffect(() => void start(), []);
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => feed,
  );
}
