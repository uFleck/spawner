import { api, isActive, parseInstanceId } from "../api";
import { getFeed, isError, untilStopped } from "./feed";

/** The companion has no store of its own, so it starts and stops apps through the backend and watches its own feed. */
export const stopApp = (id: string) => api.stop(id);

export async function restartApp(id: string) {
  const { projectId, appId } = parseInstanceId(id);
  if (isActive(getFeed().states[id])) {
    await api.stop(id);
    await untilStopped(id);
  }
  await api.start(projectId, appId, false);
}

const idsWhere = (test: (state: ReturnType<typeof getFeed>["states"][string]) => boolean) =>
  Object.entries(getFeed().states).flatMap(([id, s]) => (test(s) ? [id] : []));

/** Runs and failed apps, the ones "restart all" brings back. */
export const restartableIds = () => idsWhere((s) => isActive(s) || isError(s));
export const activeIds = () => idsWhere((s) => isActive(s));

/** Tries again for a moment: the window may only just have been given focus, and the clipboard refuses until it has it. */
export async function copyText(text: string): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 90));
    }
  }
  return false;
}
