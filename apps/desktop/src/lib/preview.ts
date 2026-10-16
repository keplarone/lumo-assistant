/**
 * URLs for the project preview protocol. Rust serves `preview://localhost/<project-id>/<path>`;
 * on Windows, WebView2 maps custom schemes to `http://<scheme>.localhost/`.
 */
export function isWindowsPlatform(
  nav: { userAgent?: string; platform?: string } = typeof navigator === 'undefined' ? {} : navigator,
): boolean {
  return /windows|win32|win64/i.test(`${nav.userAgent ?? ''} ${nav.platform ?? ''}`);
}

export function previewUrl(projectId: string, path = 'index.html', windows = isWindowsPlatform()): string {
  const clean = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .map(encodeURIComponent)
    .join('/');
  const base = windows ? 'http://preview.localhost' : 'preview://localhost';
  return `${base}/${encodeURIComponent(projectId)}/${clean}`;
}
