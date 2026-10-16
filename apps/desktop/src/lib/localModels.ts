import { formatBytes } from './format';
import type { LocalModel, LocalModelProgress } from './ipc';

/** 0..1 when the download has a size; undefined while it cannot be measured (checking a partial file). */
export function progressFraction(
  p: Pick<LocalModelProgress, 'completed' | 'total'> | null | undefined,
): number | undefined {
  if (!p || !(p.total > 0)) return undefined;
  return Math.min(1, Math.max(0, p.completed / p.total));
}

/** "1.2 GB of 5.2 GB", or what the download is doing when there is no size yet. */
export function progressText(p: LocalModelProgress | null | undefined): string {
  if (!p) return 'Starting…';
  if (p.status === 'verifying') return 'Checking the download…';
  if (p.status === 'checking') return 'Continuing an earlier download…';
  if (p.total > 0) return `${formatBytes(p.completed)} of ${formatBytes(p.total)}`;
  const s = p.status.trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Working…';
}

/** The memory warning for a model that may not fit, or null when it fits. */
export function memoryWarning(m: Pick<LocalModel, 'fits' | 'minMemoryGb'>, memoryGb: number): string | null {
  if (m.fits) return null;
  return `Needs ${m.minMemoryGb} GB of memory; this computer has ${memoryGb} GB.`;
}

/** How the built-in engine runs models here: "uses the GPU (Metal)" or "runs on the CPU". */
export function acceleratorText(accelerator: string): string {
  if (!accelerator || accelerator.toUpperCase() === 'CPU') return 'runs on the processor';
  return `uses the graphics chip (${accelerator})`;
}

export function formatGb(gb: number): string {
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}
