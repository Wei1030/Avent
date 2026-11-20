import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.js";
import { cx } from "../lib/format.js";

export function Button({
  variant = "default",
  size,
  icon,
  iconRight,
  busy,
  children,
  className,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "warn" | "danger" | "danger-outline" | "soft" | "ghost";
  size?: "sm" | "lg";
  icon?: string;
  iconRight?: string;
  busy?: boolean;
}) {
  const iconOnly = !children && Boolean(icon);
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={cx(
        "btn",
        variant !== "default" && variant,
        size,
        iconOnly && "icon-only",
        busy && "busy",
        className
      )}
      {...rest}
    >
      {busy ? <span className="spinner" /> : icon && <Icon name={icon} size={size === "sm" ? 14 : 15} />}
      {children}
      {iconRight && <Icon name={iconRight} size={13} />}
    </button>
  );
}

export function Chip({
  tone,
  mono,
  outline,
  icon,
  onRemove,
  onClick,
  title,
  children,
  className,
}: {
  tone?: "accent" | "warn" | "crit" | "good";
  mono?: boolean;
  outline?: boolean;
  icon?: string;
  onRemove?: () => void;
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "chip",
        tone,
        mono && "mono",
        outline && "outline",
        onClick && "clickable",
        className
      )}
      onClick={onClick}
      title={title}
    >
      {icon && <Icon name={icon} size={12} />}
      {children}
      {onRemove && (
        <span
          className="x"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="x" size={11} />
        </span>
      )}
    </span>
  );
}

export function Status({
  tone,
  children,
}: {
  tone: "good" | "warn" | "crit" | "info" | "idle";
  children: ReactNode;
}) {
  return <span className={cx("status", tone)}>{children}</span>;
}

export function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
}) {
  return (
    <span
      className={cx("toggle", on && "on", disabled && "disabled")}
      onClick={() => !disabled && onChange(!on)}
    >
      <span className="track" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function Check({
  on,
  onChange,
  children,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <span className={cx("check", on && "on")} onClick={() => onChange(!on)}>
      <span className="box">{on && <Icon name="check" size={12} strokeWidth={2.5} />}</span>
      {children && <span>{children}</span>}
    </span>
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; disabled?: boolean }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          className={cx(value === o.value && "on")}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  className,
}: {
  value: T;
  tabs: Array<{ value: T; label: ReactNode; count?: number }>;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cx("tabs", className)}>
      {tabs.map((tb) => (
        <button
          key={tb.value}
          type="button"
          className={cx(value === tb.value && "on")}
          onClick={() => onChange(tb.value)}
        >
          {tb.label}
          {tb.count !== undefined && <span className="count">{tb.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Popover({
  anchor,
  open,
  onClose,
  align = "left",
  placement = "bottom",
  className,
  style,
  children,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  align?: "left" | "right";
  placement?: "bottom" | "top";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const next: CSSProperties = {};
    if (placement === "top") {
      next.bottom = window.innerHeight - rect.top + 6;
    } else {
      next.top = rect.bottom + 6;
    }
    if (align === "right") {
      next.right = Math.max(8, window.innerWidth - rect.right);
    } else {
      next.left = Math.min(rect.left, Math.max(8, window.innerWidth - 360));
    }
    setPos(next);
  }, [open, anchor, align, placement]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, anchor, onClose]);

  if (!open || !anchor) return null;
  return createPortal(
    <div ref={ref} className={cx("popover", className)} style={{ ...pos, ...style }}>
      {children}
    </div>,
    document.body
  );
}

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  desc?: string;
  right?: string;
  icon?: string;
  disabled?: boolean;
}

export function Select<T extends string = string>({
  value,
  options,
  onChange,
  size,
  borderless,
  icon,
  placement = "bottom",
  align = "left",
  className,
  footer,
}: {
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (v: T) => void;
  size?: "sm";
  borderless?: boolean;
  icon?: string;
  placement?: "bottom" | "top";
  align?: "left" | "right";
  className?: string;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={cx("select-btn", size, borderless && "borderless", className)}
        onClick={() => setOpen(!open)}
      >
        {(icon || current?.icon) && <Icon name={(icon || current?.icon)!} size={14} className="ink2" />}
        <span className="label">{current?.label ?? value}</span>
        <Icon name="chevDown" size={13} className="muted" />
      </button>
      <Popover
        anchor={btnRef.current}
        open={open}
        onClose={() => setOpen(false)}
        placement={placement}
        align={align}
        style={{ minWidth: Math.max(220, btnRef.current?.offsetWidth ?? 220) }}
      >
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            disabled={opt.disabled}
            className={cx("menu-item", opt.value === value && "on")}
            onClick={() => {
              onChange(opt.value);
              setOpen(false);
            }}
          >
            {opt.icon && <Icon name={opt.icon} size={14} />}
            <span className="grow">
              {opt.label}
              {opt.desc && <span className="desc">{opt.desc}</span>}
            </span>
            {opt.right && <span className="right">{opt.right}</span>}
            {opt.value === value && <Icon name="check" size={14} />}
          </button>
        ))}
        {footer && (
          <>
            <div className="menu-sep" />
            <div onClick={() => setOpen(false)}>{footer}</div>
          </>
        )}
      </Popover>
    </>
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  wide,
  className,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  wide?: boolean;
  className?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("modal", wide && "wide", className)}>
        <div className="modal-head">
          <div className="grow">
            <h2>{title}</h2>
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          <Button variant="ghost" size="sm" icon="x" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export function UserAvatar({ size = 13 }: { size?: number }) {
  return (
    <span className="avatar">
      <Icon name="user" size={size} />
    </span>
  );
}
