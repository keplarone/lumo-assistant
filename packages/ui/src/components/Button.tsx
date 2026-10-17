import { Slot } from '@radix-ui/react-slot';
import { clsx } from 'clsx';
import { forwardRef, type ButtonHTMLAttributes, type PointerEvent, type ReactNode } from 'react';
import { Spinner } from './Progress';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, keeps the button's width, and blocks clicks. */
  loading?: boolean;
  /** Leading icon (e.g. a lucide-react icon element). */
  icon?: ReactNode;
  /** Trailing icon. */
  iconRight?: ReactNode;
  /** Render the child element (e.g. a link) with button styling. */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    iconRight,
    asChild,
    className,
    children,
    disabled,
    type,
    onClick,
    onPointerDown,
    onPointerMove,
    onPointerLeave,
    ...rest
  },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  const solid = variant !== 'ghost';
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? 'button')}
      className={clsx('lu-button', className)}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={asChild ? undefined : disabled || loading}
      aria-disabled={asChild && disabled ? true : undefined}
      onClick={loading ? undefined : onClick}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
        ripple(e);
        onPointerDown?.(e);
      }}
      onPointerMove={(e: PointerEvent<HTMLButtonElement>) => {
        if (solid && size === 'lg') magnet(e);
        onPointerMove?.(e);
      }}
      onPointerLeave={(e: PointerEvent<HTMLButtonElement>) => {
        e.currentTarget.style.removeProperty('--_mx');
        e.currentTarget.style.removeProperty('--_my');
        onPointerLeave?.(e);
      }}
      {...rest}
    >
      {asChild ? (
        children
      ) : (
        <>
          {icon}
          {children != null && <span>{children}</span>}
          {iconRight}
          {loading && <Spinner />}
        </>
      )}
    </Comp>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'iconRight' | 'asChild'> {
  /** Accessible name, also shown as the tooltip. Required: icon-only buttons must be labelled. */
  label: string;
  icon: ReactNode;
  /** Optional keyboard shortcut shown in the tooltip, e.g. ['⌘', 'K']. */
  shortcut?: string[];
  /** Hide the tooltip (the label is still announced). */
  noTooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, shortcut, noTooltip, variant = 'ghost', ...rest },
  ref,
) {
  const button = (
    <Button ref={ref} variant={variant} aria-label={label} data-icon-only="" icon={icon} {...rest} />
  );
  if (noTooltip) return button;
  return (
    <Tooltip content={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  );
});

function reducedMotion() {
  return (
    document.documentElement.hasAttribute('data-reduced-motion') ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  );
}

/** A ripple from where the button was pressed. Purely visual; removed when it finishes. */
function ripple(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || reducedMotion()) return;
  const r = el.getBoundingClientRect();
  const dot = document.createElement('span');
  dot.className = 'lu-ripple';
  dot.setAttribute('aria-hidden', 'true');
  dot.style.left = `${e.clientX - r.left}px`;
  dot.style.top = `${e.clientY - r.top}px`;
  dot.style.setProperty('--_rs', String(Math.ceil((Math.hypot(r.width, r.height) * 2) / 12)));
  el.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove(), { once: true });
  setTimeout(() => dot.remove(), 1000);
}

/** Large solid buttons lean a few pixels toward the pointer. */
function magnet(e: PointerEvent<HTMLElement>) {
  if (reducedMotion()) return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
  const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
  el.style.setProperty('--_mx', `${(dx * 3).toFixed(2)}px`);
  el.style.setProperty('--_my', `${(dy * 2).toFixed(2)}px`);
}
