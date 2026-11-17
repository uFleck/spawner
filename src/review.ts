import { instanceId, type Group, type Pr, type ResolvedStack } from "./api";

/** How a PR reads at a glance: the review decision, and what CI says. */
export interface ReviewFacts {
  /** Colour of the row's summary text. */
  cls: "ok" | "warn" | "bad" | "mute";
  /** Colour class of the pull-request icon. */
  icon: "pr-ok" | "pr-warn" | "pr-bad" | "pr-draft";
  text: string;
  checks: { cls: "ok" | "warn" | "bad" | "mute"; text: string } | null;
}

/**
 * `gh` reports the two things separately, so both are shown: a PR can be approved with a red build, or have changes
 * requested while CI is green. A draft has no review decision yet, so only its pending checks are worth saying.
 */
export function reviewOf(pr: Pr): ReviewFacts {
  const c = pr.checks;
  const failing = { cls: "bad" as const, text: `${c.fail} failing: ${c.failing.join(", ")}` };
  const pending = { cls: "mute" as const, text: `${c.pending} check${c.pending === 1 ? "" : "s"} running` };
  const checks = c.fail ? failing : c.pending ? pending : { cls: "ok" as const, text: `${c.pass}/${c.pass} checks passed` };
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

/** The worktrees: scanned groups that are neither the main checkouts nor the user's scripts. */
export const worktrees = (groups: Group[]) => groups.filter((g) => !g.main && !g.scripts);

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
