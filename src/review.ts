import { instanceId, type Group, type Pr, type ResolvedStack } from "./api";

/** How a PR reads at a glance: the review decision, and what CI says. */
export interface ReviewFacts {
  /** Colour of the row's summary text. */
  cls: "ok" | "warn" | "bad" | "mute";
  /** Colour class of the pull-request icon. */
  icon: "pr-ok" | "pr-warn" | "pr-bad" | "pr-draft";
  text: string;
  /** `text` says it in full for the PR strip; `short` fits the rail row, with `text` as its tooltip. */
  checks: { cls: "ok" | "warn" | "bad" | "mute"; icon: string; text: string; short: string } | null;
}

/**
 * `gh` reports the two things separately, so both are shown: a PR can be approved with a red build, or have changes
 * requested while CI is green. A draft has no review decision yet, so only its pending checks are worth saying.
 */
export function reviewOf(pr: Pr): ReviewFacts {
  const c = pr.checks;
  const failing = { cls: "bad" as const, icon: "ph-x", text: `${c.fail} failing: ${c.failing.join(", ")}`, short: `${c.fail} failing` };
  const pending = {
    cls: "mute" as const,
    icon: "ph-circle-dashed",
    text: `${c.pending} check${c.pending === 1 ? "" : "s"} running`,
    // "running" would read as apps running on a rail row that also shows app state.
    short: `${c.pending} pending`,
  };
  // Many repos have no CI at all; "0/0 checks passed" in green would claim a pass that never ran.
  const none = { cls: "mute" as const, icon: "ph-minus", text: "no checks yet", short: "no checks" };
  const passed = { cls: "ok" as const, icon: "ph-check", text: `${c.pass}/${c.pass} checks passed`, short: `${c.pass}/${c.pass} passed` };
  const checks = c.fail ? failing : c.pending ? pending : c.pass ? passed : none;
  if (pr.draft) return { cls: "mute", icon: "pr-draft", text: "Draft", checks: c.pending ? pending : null };
  if (pr.review === "changes") return { cls: "warn", icon: "pr-warn", text: "Changes requested", checks };
  if (c.fail) return { cls: "bad", icon: "pr-bad", text: "Checks failing", checks };
  if (pr.review === "approved") return { cls: "ok", icon: "pr-ok", text: "Approved", checks };
  return { cls: "mute", icon: "pr-ok", text: "Review pending", checks };
}

/**
 * The PRs of a worktree: a PR whose head branch is one of its checkouts, in the same repo. A branch name alone can
 * belong to a fork, which is why the repo has to match too; main checkouts never carry a review row.
 */
export function prsFor(group: Group, prs: Pr[]): Pr[] {
  if (group.main) return [];
  return prs.filter((pr) => group.projects.some((p) => !group.main && p.repo === pr.repo && pr.head === p.branch));
}

/** The worktrees: scanned groups that are not the main checkouts. */
export const worktrees = (groups: Group[]) => groups.filter((g) => !g.main);

/** The instance ids whose logs a worktree shows: its stack when one is known, else every app of its checkouts. */
export function scopeIds(group: Group, stack: ResolvedStack | null): string[] {
  if (stack) return stack.apps.map((a) => a.instance);
  return group.projects.flatMap((p) => p.apps.map((a) => instanceId(p.id, a.id)));
}

/** Short age for `via gh`, so a stale list is visible without a tooltip. */
export function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** The service apps a worktree can run, which is what a stack is made of. */
export const serviceCount = (group: Group) =>
  group.projects.reduce((n, p) => n + p.apps.filter((a) => a.mode === "service").length, 0);
