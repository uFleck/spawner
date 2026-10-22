import { instanceId, type AppDef, type Group, type Project } from "./api";

/** An app by repo and app id, so it survives across worktrees (project ids are folder paths). */
export interface PresetMember {
  repo: string;
  appId: string;
  /** Shown when the app is not in the current scan. */
  name: string;
}

export interface Preset {
  id: string;
  name: string;
  members: PresetMember[];
  /** Where the preset runs: a worktree group id, or `MAIN`. */
  target: string;
}

export const MAIN = "main";

export interface PresetHit {
  member: PresetMember;
  project: Project;
  app: AppDef;
  group: Group;
  instance: string;
}

export interface Resolved {
  hits: PresetHit[];
  missing: PresetMember[];
}

const find = (groups: Group[], member: PresetMember): PresetHit | undefined => {
  for (const group of groups)
    for (const project of group.projects) {
      if (project.repo !== member.repo) continue;
      const app = project.apps.find((a) => a.id === member.appId);
      if (app) return { member, project, app, group, instance: instanceId(project.id, app.id) };
    }
};

/**
 * Each member runs from the target worktree when it has that repo, else from the main checkout. A task folder only holds
 * the repos being changed, so the rest of a preset falls back to main.
 */
export function resolvePreset(preset: Preset, groups: Group[]): Resolved {
  const main = groups.filter((g) => g.main);
  const task = preset.target === MAIN ? [] : groups.filter((g) => g.id === preset.target);
  const hits: PresetHit[] = [];
  const missing: PresetMember[] = [];
  for (const member of preset.members) {
    const hit = find(task, member) ?? find(main, member);
    if (hit) hits.push(hit);
    else missing.push(member);
  }
  return { hits, missing };
}

/** The worktrees a preset can run in: those holding at least one of its repos. */
export function targetsFor(preset: Preset, groups: Group[]): Group[] {
  const repos = new Set(preset.members.map((m) => m.repo));
  return groups.filter((g) => !g.main && g.projects.some((p) => repos.has(p.repo)));
}

export const targetLabel = (preset: Preset, groups: Group[]) =>
  preset.target === MAIN ? "main" : (groups.find((g) => g.id === preset.target)?.label ?? "main");

export function memberOf(project: Project, app: AppDef): PresetMember {
  return { repo: project.repo, appId: app.id, name: app.name };
}

export const sameMember = (a: PresetMember, b: PresetMember) => a.repo === b.repo && a.appId === b.appId;

export const parsePresets = (raw: unknown): Preset[] =>
  Array.isArray(raw) ? raw.filter((p): p is Preset => typeof p?.id === "string" && Array.isArray(p.members)) : [];
