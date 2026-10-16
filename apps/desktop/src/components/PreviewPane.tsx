import { Button, IconButton } from '@lumo/ui';
import { ExternalLink, FolderOpen, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { previewUrl } from '../lib/preview';
import { navigate } from '../lib/router';

/**
 * A project's live preview. The page is untrusted: it runs scripts in a sandbox with an opaque
 * origin (no allow-same-origin), so it cannot reach Lumo's IPC or storage.
 */
export function PreviewPane({
  projectId,
  path = 'index.html',
  reloadKey,
  onClose,
  showOpenProject,
  siteUrl,
}: {
  projectId: string;
  path?: string;
  reloadKey?: number | string;
  onClose?: () => void;
  showOpenProject?: boolean;
  siteUrl?: string | null;
}) {
  const [nonce, setNonce] = useState(0);
  useEffect(() => setNonce((n) => n + 1), [reloadKey, path, projectId]);
  const src = previewUrl(projectId, path);
  return (
    <section className="lm-preview" aria-label="Preview">
      <div className="lm-preview-bar">
        <span className="lm-preview-path" title={path}>
          {path}
        </span>
        {siteUrl && (
          <a className="lm-link" href={siteUrl} target="_blank" rel="noreferrer">
            Live site <ExternalLink aria-hidden />
          </a>
        )}
        <IconButton
          label="Reload preview"
          icon={<RotateCw />}
          size="sm"
          onClick={() => setNonce((n) => n + 1)}
        />
        {showOpenProject && (
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderOpen />}
            onClick={() => navigate({ name: 'project', id: projectId })}
          >
            Open project
          </Button>
        )}
        {onClose && <IconButton label="Close preview" icon={<X />} size="sm" onClick={onClose} />}
      </div>
      <iframe
        key={nonce}
        className="lm-preview-frame"
        title={`Preview of ${path}`}
        src={src}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
      />
    </section>
  );
}
