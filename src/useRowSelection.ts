import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

/**
 * Row selection for a log: click a row to toggle it, drag across rows to select every row in between, and drag inside
 * one row to leave the browser's own text selection alone. Rows are elements with class `row` and a `data-seq`.
 * `seqs` lists the rendered rows in order.
 */
export function useRowSelection(seqs: number[]) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const selRef = useRef(sel);
  selRef.current = sel;
  const seqsRef = useRef(seqs);
  seqsRef.current = seqs;
  const dragged = useRef(false);

  const pick = useCallback((seq: number) => {
    if (dragged.current || !window.getSelection()?.isCollapsed) return;
    setSel((cur) => {
      const next = new Set(cur);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSel(new Set()), []);

  // Holding the left button and moving across rows selects every row in between.
  // Staying inside the starting row leaves the native text selection alone.
  const onMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const host = e.currentTarget;
    const target = e.target as HTMLElement;
    const startRow = target.closest<HTMLElement>(".row");
    if (e.button !== 0 || !startRow || target.closest("button, .trace")) return;
    const all = seqsRef.current;
    const index = new Map(all.map((s, i) => [s, i]));
    const from = index.get(Number(startRow.dataset.seq));
    if (from === undefined) return;
    const base = selRef.current;
    let y = e.clientY;
    let moved = false;

    const rowIndexAtPointer = () => {
      const box = host.getBoundingClientRect();
      const el = document.elementFromPoint(box.left + 40, Math.min(Math.max(y, box.top + 1), box.bottom - 1));
      const row = el?.closest<HTMLElement>(".row");
      return (row && index.get(Number(row.dataset.seq))) ?? -1;
    };
    const update = () => {
      const to = rowIndexAtPointer();
      if (to < 0 || (!moved && to === from)) return;
      if (!moved) {
        moved = true;
        dragged.current = true;
        host.classList.add("dragging");
        window.getSelection()?.removeAllRanges();
      }
      setSel(new Set([...base, ...all.slice(Math.min(from, to), Math.max(from, to) + 1)]));
    };
    const block = (ev: Event) => moved && ev.preventDefault();
    const move = (ev: globalThis.MouseEvent) => {
      if (ev.buttons === 0) return stop();
      y = ev.clientY;
      update();
    };
    const autoscroll = window.setInterval(() => {
      if (!moved) return;
      const box = host.getBoundingClientRect();
      const d = y < box.top + 24 ? y - (box.top + 24) : y > box.bottom - 24 ? y - (box.bottom - 24) : 0;
      if (!d) return;
      host.scrollTop += Math.max(-30, Math.min(30, d / 2));
      update();
    }, 30);
    function stop() {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.removeEventListener("selectstart", block);
      window.clearInterval(autoscroll);
      host.classList.remove("dragging");
      // the click that follows mouseup must not toggle the row we ended on
      if (moved) window.setTimeout(() => (dragged.current = false), 0);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    document.addEventListener("selectstart", block);
  }, []);

  return { sel, setSel, pick, clear, onMouseDown };
}
