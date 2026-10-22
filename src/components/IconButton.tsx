import type { ButtonHTMLAttributes } from "react";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: string;
  label: string;
  kbd?: string;
  side?: "top" | "bottom";
  pressed?: boolean;
  busy?: boolean;
  small?: boolean;
}

export function IconButton({ icon, label, kbd, side = "bottom", pressed, busy, small, className = "", ...rest }: Props) {
  return (
    <button
      type="button"
      className={`ib${small ? " sm" : ""} ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      data-tip={label}
      data-kbd={kbd}
      data-side={side}
      {...rest}
    >
      {busy ? <i className="ph ph-circle-notch spin" aria-hidden="true" /> : <i className={icon} aria-hidden="true" />}
    </button>
  );
}
