import { useEffect, useRef } from "react";

const SHOW_DELAY = 350;
/** The sidebar is hovered constantly while moving through it, so its tooltips wait longer. */
const SIDEBAR_DELAY = 600;
/** How far up from the hovered element to look for text that ends in an ellipsis. */
const ELLIPSIS_DEPTH = 3;

/** The nearest element at or above `from` whose text ends in an ellipsis when it does not fit. */
function ellipsisAt(from: Element | null): HTMLElement | null {
  let el = from;
  for (let i = 0; el instanceof HTMLElement && i <= ELLIPSIS_DEPTH; i++, el = el.parentElement)
    if (getComputedStyle(el).textOverflow === "ellipsis") return el;
  return null;
}

/** What a tooltip would say for `from`. Outside the sidebar that is its `data-tip`. The sidebar has no
 * tooltips except the full text of a name that is cut short, which is only known once it is shown. Text cut short
 * anywhere else gets its full text too, unless something closer has a `data-tip`. */
function tipTarget(from: Element | null): { target: HTMLElement; sidebar: boolean } | null {
  const sidebar = from?.closest(".rail") != null;
  const target = (!sidebar && from?.closest<HTMLElement>("[data-tip]")) || ellipsisAt(from);
  return target ? { target, sidebar } : null;
}

const clipped = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1;

/** One tooltip for every `[data-tip]`. It waits out the delay on every hover, including when moving between targets. */
export function TooltipHost() {
  const tip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = tip.current!;
    let timer: number | undefined;
    let current: HTMLElement | null = null;

    const hide = () => el.classList.remove("on");

    const show = (target: HTMLElement) => {
      const text = target.dataset.tip ?? (clipped(target) ? target.textContent?.trim() : "");
      if (!text || !target.isConnected) return;
      el.replaceChildren();
      const label = document.createElement("span");
      label.textContent = text;
      el.append(label);
      el.classList.toggle("nokbd", !target.dataset.kbd);
      target.dataset.kbd?.split(" ").forEach((k) => {
        const kbd = document.createElement("span");
        kbd.className = "kbd";
        kbd.textContent = k;
        el.append(kbd);
      });
      el.style.left = "0px";
      el.style.top = "0px";
      const r = target.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let side = target.dataset.side ?? "bottom";
      if (side === "bottom" && r.bottom + h + 10 > innerHeight) side = "top";
      el.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
      el.style.top = `${side === "bottom" ? r.bottom + 8 : r.top - h - 8}px`;
      requestAnimationFrame(() => el.classList.add("on"));
    };

    const over = (e: PointerEvent) => {
      const hit = tipTarget(e.target as Element);
      const target = hit?.target ?? null;
      if (target === current) return;
      current = target;
      window.clearTimeout(timer);
      hide();
      if (!hit) return;
      timer = window.setTimeout(() => show(hit.target), hit.sidebar ? SIDEBAR_DELAY : SHOW_DELAY);
    };
    const down = () => {
      window.clearTimeout(timer);
      hide();
    };
    const out = (e: PointerEvent) => {
      if (e.relatedTarget) return;
      current = null;
      window.clearTimeout(timer);
      hide();
    };
    const focus = (e: FocusEvent) => {
      const target = tipTarget(e.target as Element)?.target;
      if (target?.matches(":focus-visible")) show(target);
    };

    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
    };
  }, []);

  return <div id="tip" ref={tip} role="tooltip" />;
}
