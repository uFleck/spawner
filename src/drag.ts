import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent } from "react";
import { inTauri } from "./components/WindowControls";

/** Controls that must keep their own click and focus, so a drag never starts on them. */
const INTERACTIVE = "button, a, input, textarea, select, label, [role='button'], [contenteditable='true'], [data-no-drag]";

const onControl = (target: EventTarget | null) => target instanceof Element && target.closest(INTERACTIVE) !== null;

/**
 * Drags the window from a title bar whose own children cover the `data-tauri-drag-region` element. Tauri's attribute
 * only applies to the element under the pointer, so a heading or the flexible spacer would otherwise swallow the drag.
 */
export function startWindowDrag(e: MouseEvent<HTMLElement>) {
  if (!inTauri || e.button !== 0 || onControl(e.target)) return;
  // A title bar does not select the text under it while the window moves.
  e.preventDefault();
  void getCurrentWindow().startDragging();
}

/** Double-clicking a title bar maximizes it, the way the OS title bar does. */
export function toggleWindowMaximize(e: MouseEvent<HTMLElement>) {
  if (!inTauri || onControl(e.target)) return;
  void getCurrentWindow().toggleMaximize();
}
