import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

export type MenuItem =
  | "sep"
  | { label: string; icon?: string; danger?: boolean; disabled?: boolean; run: () => void };

interface Api {
  /** Opens the menu at the pointer and replaces the browser's own. */
  show: (e: ReactMouseEvent, items: MenuItem[]) => void;
  copy: (text: string, what?: string) => void;
}

const Ctx = createContext<Api>({ show: (e) => e.preventDefault(), copy: () => {} });
export const useContextMenu = () => useContext(Ctx);

const editable = (t: EventTarget | null) => t instanceof HTMLElement && t.closest("input, textarea, [contenteditable='true']") !== null;

interface Open {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * Owns the one app context menu. Components call `show` from their own `onContextMenu`; a right-click nobody claimed
 * gets `fallback`, so the browser's menu (Reload, Inspect…) never appears. Text fields keep the native menu for paste.
 */
export function ContextMenuProvider({ fallback, onToast, children }: { fallback: MenuItem[]; onToast: (text: string) => void; children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  const show = useCallback<Api["show"]>((e, items) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen({ x: e.clientX, y: e.clientY, items });
  }, []);

  const copy = useCallback<Api["copy"]>(
    (text, what) => {
      void navigator.clipboard.writeText(text).then(() => onToast(`${what ?? "Text"} copied`));
    },
    [onToast],
  );

  useEffect(() => {
    const unclaimed = (e: MouseEvent) => {
      if (e.defaultPrevented || editable(e.target)) return;
      e.preventDefault();
      setOpen({ x: e.clientX, y: e.clientY, items: fallbackRef.current });
    };
    document.addEventListener("contextmenu", unclaimed);
    return () => document.removeEventListener("contextmenu", unclaimed);
  }, []);

  const close = useCallback(() => setOpen(null), []);
  const api = useMemo(() => ({ show, copy }), [show, copy]);
  return (
    <Ctx.Provider value={api}>
      {children}
      {open && <Menu key={`${open.x},${open.y}`} {...open} onClose={close} />}
    </Ctx.Provider>
  );
}

function Menu({ x, y, items, onClose }: Open & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current!;
    setPos({
      left: Math.max(4, Math.min(x, innerWidth - el.offsetWidth - 4)),
      top: Math.max(4, Math.min(y, innerHeight - el.offsetHeight - 4)),
    });
    el.focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const move = (e: ReactKeyboardEvent) => {
    const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (!buttons.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[at === -1 && e.key === "ArrowUp" ? buttons.length - 1 : next].focus();
  };

  return (
    <div
      className="menu ctx"
      role="menu"
      tabIndex={-1}
      ref={ref}
      style={pos}
      onKeyDown={move}
      onContextMenu={(e) => (e.preventDefault(), e.stopPropagation())}
    >
      {items.map((item, i) =>
        item === "sep" ? (
          <div key={i} className="msep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={item.danger ? "danger" : ""}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.icon && <i className={item.icon} aria-hidden="true" />}
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
