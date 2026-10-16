import * as RDialog from '@radix-ui/react-dialog';
import * as RMenu from '@radix-ui/react-dropdown-menu';
import * as RPopover from '@radix-ui/react-popover';
import * as RTabs from '@radix-ui/react-tabs';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { Kbd } from './Display';

/* Dialog */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: DialogProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="lu-dialog-overlay" />
        <RDialog.Content
          className="lu-dialog"
          data-size={size}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="lu-dialog-header">
            <RDialog.Title className="lu-dialog-title">{title}</RDialog.Title>
            {description ? (
              <RDialog.Description className="lu-dialog-description">{description}</RDialog.Description>
            ) : (
              <RDialog.Description className="lu-visually-hidden">{title}</RDialog.Description>
            )}
          </div>
          {children && <div className="lu-dialog-body">{children}</div>}
          {footer && <div className="lu-dialog-footer">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/* Dropdown menu */

export const Menu = RMenu.Root;
export const MenuTrigger = RMenu.Trigger;

export function MenuContent({
  children,
  align = 'start',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  return (
    <RMenu.Portal>
      <RMenu.Content className={clsx('lu-menu', className)} align={align} sideOffset={4} collisionPadding={8}>
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  );
}

export function MenuItem({
  icon,
  shortcut,
  tone,
  children,
  onSelect,
  disabled,
}: {
  icon?: ReactNode;
  shortcut?: string[];
  tone?: 'danger';
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
}) {
  return (
    <RMenu.Item className="lu-menu-item" data-tone={tone} onSelect={onSelect} disabled={disabled}>
      {icon}
      <span>{children}</span>
      {shortcut && <Kbd keys={shortcut} />}
    </RMenu.Item>
  );
}

export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <RMenu.Label className="lu-menu-label">{children}</RMenu.Label>
);
export const MenuSeparator = () => <RMenu.Separator className="lu-menu-separator" />;

/* Popover */

export const Popover = RPopover.Root;
export const PopoverTrigger = RPopover.Trigger;
export const PopoverClose = RPopover.Close;
export function PopoverContent({
  children,
  side = 'bottom',
  align = 'center',
  className,
}: {
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  className?: string;
}) {
  return (
    <RPopover.Portal>
      <RPopover.Content
        className={clsx('lu-popover', className)}
        side={side}
        align={align}
        sideOffset={6}
        collisionPadding={8}
      >
        {children}
      </RPopover.Content>
    </RPopover.Portal>
  );
}

/* Tabs */

export const Tabs = RTabs.Root;
export const TabPanel = RTabs.Content;
export function TabList({ tabs, label }: { tabs: { value: string; label: ReactNode }[]; label: string }) {
  return (
    <RTabs.List className="lu-tabs-list" aria-label={label}>
      {tabs.map((t) => (
        <RTabs.Trigger key={t.value} value={t.value} className="lu-tab">
          {t.label}
        </RTabs.Trigger>
      ))}
    </RTabs.List>
  );
}
