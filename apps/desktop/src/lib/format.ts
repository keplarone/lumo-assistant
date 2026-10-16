export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** "just now", "5 min ago", "Yesterday", "Mar 3". */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = now - t;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  if (min < 1) return future ? 'in a moment' : 'just now';
  if (min < 60) return future ? `in ${min} min` : `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return future ? `in ${h} h` : `${h} h ago`;
  const d = new Date(t);
  const today = new Date(now);
  const days = Math.round(abs / 86_400_000);
  if (!future && days === 1) return 'Yesterday';
  if (future && days === 1)
    return `Tomorrow ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(
    [],
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function greeting(name: string | null | undefined, hour: number = new Date().getHours()): string {
  const part =
    hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const n = name?.trim();
  return n ? `${part}, ${n}` : part;
}

export const isMac = () =>
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
/** The primary modifier shown in shortcuts. */
export const modKey = () => (isMac() ? '⌘' : 'Ctrl');
