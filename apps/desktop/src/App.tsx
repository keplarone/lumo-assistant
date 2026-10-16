import { Button, Callout, Spinner, StatusDot, ToastProvider, TooltipProvider } from '@lumo/ui';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useRef, useState } from 'react';
import { ConversationView } from './components/ConversationView';
import { InputControlBanner } from './components/InputControlBanner';
import { LumoMark } from './components/Mascot';
import { Sidebar } from './components/Sidebar';
import { api, errorMessage, hasBridge, on } from './lib/ipc';
import { navigate, useRoute, type Route } from './lib/router';
import { applyTheme } from './lib/theme';
import { Automations } from './screens/Automations';
import { Compact } from './screens/Compact';
import { Home } from './screens/Home';
import { Onboarding } from './screens/Onboarding';
import { ProjectsList, ProjectView } from './screens/Projects';
import { Settings } from './screens/Settings';
import { Styleguide } from './screens/Styleguide';
import { Tasks } from './screens/Tasks';
import { AppProvider, useApp, type Boot } from './state/app';

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return 'main';
  }
}

/** The main window starts hidden; show it once the first frame has painted to avoid a blank flash. */
function useShowWhenPainted(ready: boolean) {
  useEffect(() => {
    if (!ready || windowLabel() !== 'main') return;
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        getCurrentWindow()
          .show()
          .catch(() => api.showMainWindow().catch(() => {}));
      }),
    );
    return () => cancelAnimationFrame(id);
  }, [ready]);
}

export function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bridge = hasBridge();

  useEffect(() => {
    if (!bridge) return;
    Promise.all([api.getSettings(), api.appInfo()])
      .then(([settings, info]) => {
        applyTheme(settings.theme);
        setBoot({ settings, info });
      })
      .catch((e) => setError(errorMessage(e)));
  }, [bridge]);

  useShowWhenPainted(!!boot || !!error || !bridge);

  if (!bridge) {
    return (
      <div className="lm-boot">
        <LumoMark size={28} />
        <p>Lumo’s interface runs inside the Lumo app. Start it with “pnpm dev” from the repository root.</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="lm-boot">
        <Callout tone="danger" title="Lumo couldn’t start">
          {error}
        </Callout>
      </div>
    );
  }
  if (!boot) {
    return (
      <div className="lm-boot">
        <Spinner label="Starting Lumo" />
      </div>
    );
  }
  return (
    <ToastProvider>
      <TooltipProvider>
        <AppProvider boot={boot}>
          <Root />
        </AppProvider>
      </TooltipProvider>
    </ToastProvider>
  );
}

function Root() {
  const app = useApp();
  const route = useRoute();
  if (route.name === 'compact') {
    if (!app.settings.onboarded) {
      return (
        <div className="lm-boot">
          <LumoMark size={24} />
          <p>Finish setting up Lumo in the main window first.</p>
          <Button variant="primary" onClick={() => void api.showMainWindow()}>
            Open Lumo
          </Button>
        </div>
      );
    }
    return (
      <>
        <InputControlBanner />
        <Compact />
      </>
    );
  }
  if (!app.settings.onboarded) return <Onboarding />;
  return <Shell route={route} />;
}

function GlobalPrivacy() {
  const [p, setP] = useState<{ kind: string; detail: string; at: number } | null>(null);
  useEffect(() => {
    const sub = on('privacy', (x) => setP({ ...x, at: Date.now() }));
    return () => void sub.then((u) => u());
  }, []);
  useEffect(() => {
    if (!p) return;
    const t = setTimeout(() => setP(null), 6000);
    return () => clearTimeout(t);
  }, [p]);
  if (!p) return null;
  return (
    <div className="lm-privacy lm-privacy-global" role="status">
      <StatusDot tone="live" pulse />
      <span>{p.detail}</span>
    </div>
  );
}

function Shell({ route }: { route: Route }) {
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        navigate({ name: 'home' });
        window.dispatchEvent(new Event('lumo:focus-composer'));
      } else if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    const sub = on(
      'open-conversation',
      (id) => typeof id === 'string' && navigate({ name: 'conversation', id }),
    );
    return () => {
      window.removeEventListener('keydown', onKey);
      void sub.then((u) => u());
    };
  }, []);

  return (
    <div className="lm-app">
      <a className="lm-skip" href="#main">
        Skip to content
      </a>
      <Sidebar ref={search} route={route} />
      <main className="lm-main" id="main" tabIndex={-1}>
        <InputControlBanner />
        <RouteView route={route} />
      </main>
      <GlobalPrivacy />
    </div>
  );
}

function RouteView({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'conversation':
      return <ConversationView key={route.id} conversationId={route.id} />;
    case 'projects':
      return <ProjectsList />;
    case 'project':
      return <ProjectView key={route.id} id={route.id} />;
    case 'automations':
      return <Automations />;
    case 'tasks':
      return <Tasks />;
    case 'settings':
      return <Settings section={route.section} />;
    case 'styleguide':
      return <Styleguide />;
    default:
      return <Home />;
  }
}
