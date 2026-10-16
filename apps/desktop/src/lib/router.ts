/** A tiny hash router: the compact window loads index.html#/compact, so routes live in the hash. */
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'conversation'; id: string }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'automations' }
  | { name: 'tasks' }
  | { name: 'settings'; section: string }
  | { name: 'compact' }
  | { name: 'styleguide' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b] = parts;
  switch (a) {
    case 'c':
      return b ? { name: 'conversation', id: b } : { name: 'home' };
    case 'projects':
      return b ? { name: 'project', id: b } : { name: 'projects' };
    case 'automations':
      return { name: 'automations' };
    case 'tasks':
      return { name: 'tasks' };
    case 'settings':
      return { name: 'settings', section: b ?? 'general' };
    case 'compact':
      return { name: 'compact' };
    case 'styleguide':
      return { name: 'styleguide' };
    default:
      return { name: 'home' };
  }
}

export function routeHref(r: Route): string {
  switch (r.name) {
    case 'home':
      return '#/';
    case 'conversation':
      return `#/c/${encodeURIComponent(r.id)}`;
    case 'projects':
      return '#/projects';
    case 'project':
      return `#/projects/${encodeURIComponent(r.id)}`;
    case 'automations':
      return '#/automations';
    case 'tasks':
      return '#/tasks';
    case 'settings':
      return `#/settings/${r.section}`;
    case 'compact':
      return '#/compact';
    case 'styleguide':
      return '#/styleguide';
  }
}

export function navigate(r: Route) {
  const href = routeHref(r);
  if (window.location.hash !== href) window.location.hash = href;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
