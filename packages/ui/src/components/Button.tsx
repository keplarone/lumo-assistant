import { Slot } from '@radix-ui/react-slot';
import { clsx } from 'clsx';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
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
  { variant = 'secondary', size = 'md', loading = false, icon, iconRight, asChild, className, children, disabled, type, onClick, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
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
