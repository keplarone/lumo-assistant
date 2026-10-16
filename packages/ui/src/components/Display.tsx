import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'lumen' | 'live';

export function Badge({ tone = 'neutral', icon, children, className }: { tone?: Exclude<Tone, 'live'>; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={clsx('lu-badge', className)} data-tone={tone}>
      {icon}
      {children}
    </span>
  );
}

export function StatusDot({ tone = 'neutral', pulse, label }: { tone?: Tone; pulse?: boolean; label?: string }) {
  return (
    <span
      className="lu-status-dot"
      data-tone={tone}
      data-pulse={pulse || undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/** Keyboard shortcut. `keys` like ['⌘', 'K']. */
export function Kbd({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={clsx('lu-kbd', className)}>
      {keys.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

export function Card({ interactive, className, ...rest }: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return <div className={clsx('lu-card', className)} data-interactive={interactive || undefined} {...rest} />;
}

export function Separator({ orientation = 'horizontal', className }: { orientation?: 'horizontal' | 'vertical'; className?: string }) {
  return <div className={clsx('lu-separator', className)} data-orientation={orientation} role="separator" aria-orientation={orientation} />;
}

const calloutIcons = { neutral: Info, accent: Info, success: CheckCircle2, warning: AlertTriangle, danger: OctagonAlert };

export function Callout({
  tone = 'neutral',
  title,
  children,
  className,
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const Icon = calloutIcons[tone];
  return (
    <div className={clsx('lu-callout', className)} data-tone={tone} role={tone === 'danger' || tone === 'warning' ? 'alert' : 'note'}>
      <Icon aria-hidden />
      <div>
        {title && <div className="lu-callout-title">{title}</div>}
        {children && <div className="lu-callout-body-inner">{children}</div>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  actions,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('lu-empty', className)}>
      {icon && <div className="lu-empty-icon" aria-hidden>{icon}</div>}
      <div className="lu-empty-title">{title}</div>
      {description && <p className="lu-empty-description">{description}</p>}
      {actions && <div className="lu-empty-actions">{actions}</div>}
    </div>
  );
}
