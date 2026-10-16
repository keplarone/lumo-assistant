import { clsx } from 'clsx';

export function Spinner({ size = 16, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      className={clsx('lu-spinner', className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="8" cy="8" r="6" opacity="0.25" />
      <circle cx="8" cy="8" r="6" strokeDasharray="28 100" strokeDashoffset="0" />
    </svg>
  );
}

export interface ProgressBarProps {
  /** 0..1. Omit for an indeterminate bar (only when progress truly cannot be measured). */
  value?: number;
  label: string;
  className?: string;
}

export function ProgressBar({ value, label, className }: ProgressBarProps) {
  const determinate = typeof value === 'number' && Number.isFinite(value);
  const pct = determinate ? Math.round(Math.min(1, Math.max(0, value)) * 100) : undefined;
  return (
    <div
      className={clsx('lu-progress', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={pct}
      data-indeterminate={determinate ? undefined : ''}
    >
      <div className="lu-progress-bar" style={determinate ? { width: `${pct}%` } : undefined} />
    </div>
  );
}

export function Skeleton({ width, height = 12, className }: { width?: number | string; height?: number | string; className?: string }) {
  return <div className={clsx('lu-skeleton', className)} style={{ width, height }} aria-hidden />;
}
