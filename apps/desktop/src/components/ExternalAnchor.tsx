import { api } from '../lib/ipc';
import { useApp } from '../state/app';

/** A link that opens in the default browser (Rust checks it is https). */
export function ExternalAnchor({
  href,
  children,
  className = 'lm-link',
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const app = useApp();
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        api.openExternal(href).catch((err) => app.reportError(err, `Couldn’t open ${href}`));
      }}
    >
      {children}
    </a>
  );
}
