import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import { api, isActive, isErrorExit, type Group, type InstanceState, type LogLine, type StateEvent } from "../api";
import { isFrame } from "../logModel";

/** Lines kept in total, the same as the main window. */
const CAP = 20_000;
/** Log lines are applied in batches, so a chatty app does not re-render the window for every line. */
const BATCH_MS = 150;

export interface Feed {
  states: Record<string, InstanceState>;
  groups: Group[];
  /** Every line still in memory, oldest first. */
  logs: LogLine[];
  /** When each instance last printed, by this window's clock, so lines from before it opened do not count as live. */
  heard: Record<string, number>;
  /** When each errored instance failed, for "error 1 min ago". */
  failedAt: Record<string, number>;
  /** Errored instances the user waved away. They come back when they start again. */
  dismissed: string[];
}

let feed: Feed = { states: {}, groups: [], logs: [], heard: {}, failedAt: {}, dismissed: [] };
const subs = new Set<() => void>();

function set(patch: Partial<Feed>) {
  feed = { ...feed, ...patch };
  subs.forEach((s) => s());
}

export const getFeed = () => feed;

export const isError = (s: InstanceState | undefined) => s?.kind === "failed" || isErrorExit(s);

let lastSeq = 0;
let pending: LogLine[] = [];
let timer: number | undefined;
/** Lines that arrive while the backlog is loading wait for it, or the older backlog would be dropped as already seen. */
let ready = false;

function take(lines: LogLine[], live: boolean) {
  const fresh = [...lines].sort((a, b) => a.seq - b.seq).filter((l) => l.seq > lastSeq);
  if (fresh.length === 0) return;
  lastSeq = fresh[fresh.length - 1].seq;
  const merged = feed.logs.concat(fresh);
  const heard = { ...feed.heard };
  if (live) {
    const now = Date.now();
    for (const line of fresh) if (!isFrame(line) && line.text.trim()) heard[line.instance] = now;
  }
  set({ logs: merged.length > CAP ? merged.slice(merged.length - CAP) : merged, heard });
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
  const patch: Partial<Feed> = { states };
  if (isError(state) && !isError(feed.states[id])) patch.failedAt = { ...feed.failedAt, [id]: Date.now() };
  if (isActive(state) && !isActive(feed.states[id])) {
    const { [id]: _was, ...failedAt } = feed.failedAt;
    patch.failedAt = failedAt;
    patch.dismissed = feed.dismissed.filter((d) => d !== id);
  }
  set(patch);
}

function onCleared(id: string | null) {
  set({ logs: id ? feed.logs.filter((l) => l.instance !== id) : [] });
}

let started = false;
async function start() {
  if (started) return;
  started = true;
  await listen<StateEvent>("instance-state", (e) => onState(e.payload));
  await listen<LogLine>("log-line", (e) => onLine(e.payload));
  await listen<Group[]>("groups-changed", (e) => set({ groups: e.payload }));
  await listen<string | null>("logs-cleared", (e) => onCleared(e.payload));
  const [groups, states, backlog] = await Promise.all([api.groups(), api.instanceStates(), api.logsSince(0)]);
  // Errors that happened before this window opened are dated by the last line their app printed.
  const failedAt: Record<string, number> = {};
  for (const [id, s] of Object.entries(states)) {
    if (!isError(s)) continue;
    const last = [...backlog].reverse().find((l) => l.instance === id);
    failedAt[id] = last?.ts ?? Date.now();
  }
  set({ groups, states, failedAt });
  take(backlog, false);
  ready = true;
  flush();
}

export function dismiss(id: string) {
  set({ dismissed: [...feed.dismissed, id] });
  void api.companionDismiss(id);
}

/** Clears one app's log (or all of them) here and in the backend. */
export async function clearLogs(id?: string) {
  await api.clearLogs(id);
  onCleared(id ?? null);
}

/** Resolves once the instance is no longer active, or after `ms`. */
export function untilStopped(id: string, ms = 30_000): Promise<void> {
  return new Promise((resolve) => {
    if (!isActive(feed.states[id])) return resolve();
    const done = () => {
      window.clearTimeout(t);
      subs.delete(check);
      resolve();
    };
    const check = () => isActive(feed.states[id]) || done();
    const t = window.setTimeout(done, ms);
    subs.add(check);
  });
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
