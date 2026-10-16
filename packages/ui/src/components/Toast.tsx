import { CheckCircle2, Info, OctagonAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastTone = 'info' | 'success' | 'danger';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** ms; 0 keeps it until dismissed. Errors default to staying. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
}

const ToastContext = createContext<((t: ToastOptions) => number) | null>(null);

const icons = { info: Info, success: CheckCircle2, danger: OctagonAlert };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: ToastOptions) => {
      const id = nextId.current++;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      const duration = t.duration ?? (t.tone === 'danger' ? 0 : 4500);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="lu-toaster" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => {
          const Icon = icons[t.tone ?? 'info'];
          return (
            <div key={t.id} className="lu-toast" data-tone={t.tone ?? 'info'} role={t.tone === 'danger' ? 'alert' : 'status'}>
              <Icon aria-hidden />
              <div>
                <div className="lu-toast-title">{t.title}</div>
                {t.description && <div className="lu-toast-description">{t.description}</div>}
                {t.action && (
                  <button
                    type="button"
                    className="lu-button"
                    data-variant="ghost"
                    data-size="sm"
                    style={{ marginTop: 6, marginLeft: -8 }}
                    onClick={() => {
                      t.action!.onClick();
                      dismiss(t.id);
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button type="button" className="lu-button" data-variant="ghost" data-size="sm" data-icon-only="" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <X />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
