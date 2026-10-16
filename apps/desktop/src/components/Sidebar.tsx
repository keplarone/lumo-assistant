import { Badge, Button, Input, Kbd, StatusDot } from '@lumo/ui';
import {
  Activity,
  CircleHelp,
  Code2,
  FolderKanban,
  Heart,
  Plus,
  Search,
  Settings as SettingsIcon,
  Timer,
} from 'lucide-react';
import { forwardRef, useEffect, useState } from 'react';
import { api, type AppMode, type Conversation } from '../lib/ipc';
import { chirp } from '../state/mascot';
import { modKey, relativeTime } from '../lib/format';
import { navigate, routeHref, type Route } from '../lib/router';
import { useApp } from '../state/app';
import { useRuns } from '../state/runs';
import { LumoMark } from './Mascot';

export const Sidebar = forwardRef<HTMLInputElement, { route: Route; open?: boolean }>(function Sidebar(
  { route, open },
  searchRef,
) {
  const app = useApp();
  const runs = useRuns();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Conversation[] | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .listConversations(q, 50)
        .then((r) => live && setResults(r))
        .catch(() => live && setResults([]));
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  const runningConvs = new Set(
    [...runs.values()].filter((r) => r.status === 'running').map((r) => r.conversationId),
  );
  const activeCount = runningConvs.size;
  const list = results ?? app.conversations;
  const currentId = route.name === 'conversation' ? route.id : null;
  const mod = modKey();

  return (
    <nav className="lm-sidebar" id="lm-sidebar" aria-label="Lumo" data-open={open || undefined}>
      <div className="lm-brand" data-tauri-drag-region>
        <LumoMark size={22} />
        <span>{app.settings.mode === 'linx' ? 'Linx Code' : 'Lumo'}</span>
      </div>
      <ModeSwitch />
      <Button
        className="lm-new-task"
        variant="secondary"
        icon={<Plus />}
        onClick={() => navigate({ name: 'home' })}
        aria-keyshortcuts={mod === '⌘' ? 'Meta+N' : 'Control+N'}
      >
        New task
        <Kbd keys={[mod, 'N']} className="lm-new-task-kbd" />
      </Button>
      <div className="lm-search">
        <Search aria-hidden />
        <Input
          ref={searchRef}
          type="search"
          placeholder="Search conversations"
          aria-label="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        />
      </div>
      <div className="lm-sidebar-section" aria-live="polite">
        {results ? `${results.length} ${results.length === 1 ? 'match' : 'matches'}` : 'Recent'}
      </div>
      <ul className="lm-conv-list">
        {list.map((c) => (
          <li key={c.id}>
            <a
              className="lm-conv-item"
              href={routeHref({ name: 'conversation', id: c.id })}
              aria-current={c.id === currentId ? 'page' : undefined}
            >
              <span className="lm-conv-item-title">{c.title}</span>
              {runningConvs.has(c.id) ? (
                <StatusDot tone="accent" pulse label="Working" />
              ) : (
                <span className="lm-conv-item-time">{relativeTime(c.updatedAt)}</span>
              )}
            </a>
          </li>
        ))}
        {list.length === 0 && (
          <li className="lm-conv-empty">
            {results ? 'Nothing matches.' : 'Your conversations will appear here.'}
          </li>
        )}
      </ul>
      <ul className="lm-nav">
        {app.settings.mode === 'linx' && (
          <NavItem
            href={routeHref({ name: 'projects' })}
            icon={<FolderKanban />}
            label="Projects"
            current={route.name === 'projects' || route.name === 'project'}
          />
        )}
        <NavItem
          href={routeHref({ name: 'automations' })}
          icon={<Timer />}
          label="Automations"
          current={route.name === 'automations'}
        />
        <NavItem
          href={routeHref({ name: 'tasks' })}
          icon={<Activity />}
          label="Tasks"
          current={route.name === 'tasks'}
          extra={activeCount > 0 ? <Badge tone="accent">{activeCount} running</Badge> : null}
        />
        <NavItem
          href={routeHref({ name: 'settings', section: 'general' })}
          icon={<SettingsIcon />}
          label="Settings"
          current={route.name === 'settings' && route.section !== 'help'}
        />
        <NavItem
          href={routeHref({ name: 'settings', section: 'help' })}
          icon={<CircleHelp />}
          label="Help"
          current={route.name === 'settings' && route.section === 'help'}
        />
      </ul>
    </nav>
  );
});

const MODES: { id: AppMode; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: 'lumo', label: 'Lumo', hint: 'Your personal assistant', icon: <Heart /> },
  { id: 'linx', label: 'Linx Code', hint: 'Work and build tools', icon: <Code2 /> },
];

/** Lumo (personal, the default) or Linx Code (work and building), like a product switcher. */
function ModeSwitch() {
  const app = useApp();
  const mode = app.settings.mode ?? 'lumo';
  const pick = async (m: AppMode) => {
    if (m === mode) return;
    chirp('whoosh');
    try {
      await app.updateSettings({ mode: m });
      if (m === 'lumo' && (location.hash.startsWith('#/projects') || location.hash === ''))
        navigate({ name: 'home' });
    } catch (e) {
      app.reportError(e, 'Couldn’t switch');
    }
  };
  return (
    <div className="lm-mode" role="radiogroup" aria-label="Mode" data-mode={mode}>
      <span className="lm-mode-thumb" aria-hidden="true" />
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={mode === m.id}
          title={m.hint}
          className="lm-mode-option"
          onClick={() => void pick(m.id)}
        >
          {m.icon}
          <span>{m.label}</span>
        </button>
      ))}
    </div>
  );
}

function NavItem({
  href,
  icon,
  label,
  current,
  extra,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  current: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <li>
      <a className="lm-nav-item" href={href} aria-current={current ? 'page' : undefined}>
        {icon}
        <span>{label}</span>
        {extra}
      </a>
    </li>
  );
}
