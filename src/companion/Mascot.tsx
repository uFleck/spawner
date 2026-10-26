import type { PointerEventHandler } from "react";
import spawnerIcon from "../assets/spawner.svg";

export type MascotState = "sleep" | "run" | "print" | "err";

interface Props {
  state: MascotState;
  /** Pulled against the screen edge, so only part of it shows. */
  tucked: boolean;
  /** Just came back out from the edge. */
  waking: boolean;
  /** Failed apps when there are any, else running apps. */
  count: number;
  title: string;
  onPointerDown: PointerEventHandler;
  onPointerMove: PointerEventHandler;
  onPointerUp: PointerEventHandler;
}

/** The pixel spawner on its own. Its flame is the status light: it throws pixels while apps print and turns red on a failure. */
export function Mascot({ state, tucked, waking, count, title, onPointerDown, onPointerMove, onPointerUp }: Props) {
  return (
    <button
      type="button"
      className={`mas ${state}${tucked ? " tuck" : ""}${waking ? " waking" : ""}${count > 0 ? " has-badge" : ""}`}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="sprite">
        <img src={spawnerIcon} alt="" draggable={false} />
      </div>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <i key={i} className="p" />
      ))}
      <span className="z">z</span>
      <span className="bdg">{count}</span>
    </button>
  );
}
