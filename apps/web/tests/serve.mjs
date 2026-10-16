/**
 * Minimal static server for the built site (dist/), used by the Playwright tests. Serves
 * directory indexes, real 404s with dist/404.html, and correct content types. No dependencies.
 *
 *   node tests/serve.mjs [port]
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const port = Number(process.argv[2] ?? process.env.PORT ?? 4329);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function resolvePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let p = join(root, clean);
  if (!p.startsWith(root)) return null;
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p) && existsSync(`${p}.html`)) p = `${p}.html`;
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

createServer((req, res) => {
  const url = req.url ?? '/';
  const path = url.split('?')[0];
  // Directory URLs without a trailing slash redirect, like most static hosts.
  const asDir = join(root, path);
  if (!path.endsWith('/') && existsSync(asDir) && statSync(asDir).isDirectory()) {
    res.writeHead(301, { location: `${path}/` });
    return res.end();
  }
  const file = resolvePath(url);
  if (!file) {
    res.writeHead(404, { 'content-type': types['.html'] });
    return createReadStream(join(root, '404.html')).pipe(res);
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
