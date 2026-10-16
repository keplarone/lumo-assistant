/**
 * App-wide state for one window: settings, app info, agents, the conversation list and the live
 * region. Everything comes from Rust; nothing here is invented.
 */
import { useToast } from '@lumo/ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  errorMessage,
  on,
  type AgentDef,
  type AppInfo,
  type Conversation,
  type SecretStatus,
  type Settings,
} from '../lib/ipc';
import { mascotEventsFor } from '../lib/mascotEvents';
import { applyTheme } from '../lib/theme';
import { mascotBus } from './mascot';
import { runStore } from './runs';

interface AppState {
  settings: Settings;
  info: AppInfo;
  secrets: SecretStatus[];
  agents: AgentDef[];
  conversations: Conversation[];
  /** Merge a change into the settings and save it. Throws the command error (with a message). */
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>;
  reloadSettings: () => Promise<void>;
  reloadSecrets: () => Promise<void>;
  reloadAgents: () => Promise<void>;
  reloadConversations: () => Promise<void>;
  /** Announce a status change to assistive technology. */
  announce: (text: string) => void;
  /** Show a command error as a toast. */
  reportError: (e: unknown, title?: string) => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

export interface Boot {
  settings: Settings;
  info: AppInfo;
}

export function AppProvider({ boot, children }: { boot: Boot; children: ReactNode }) {
  const toast = useToast();
  const [settings, setSettings] = useState(boot.settings);
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const reportError = useCallback(
    (e: unknown, title = 'That didn’t work') =>
      toast({ title, description: errorMessage(e), tone: 'danger' }),
    [toast],
  );
  const announce = useCallback((text: string) => {
    setAnnouncement('');
    // A fresh string each time so repeated messages are still read.
    setTimeout(() => setAnnouncement(text), 30);
  }, []);

  const reloadSettings = useCallback(async () => setSettings(await api.getSettings()), []);
  const reloadSecrets = useCallback(async () => {
    try {
      setSecrets(await api.secretsStatus());
    } catch {
      setSecrets([]);
    }
  }, []);
  const reloadAgents = useCallback(async () => {
    try {
      setAgents(await api.listAgents());
    } catch {
      setAgents([]);
    }
  }, []);
  const reloadConversations = useCallback(async () => {
    try {
      setConversations(await api.listConversations(null, 100));
    } catch (e) {
      reportError(e, 'Couldn’t load conversations');
    }
  }, [reportError]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const saved = await api.saveSettings({ ...settingsRef.current, ...patch });
    setSettings(saved);
    return saved;
  }, []);

  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-reduced-motion', settings.reducedMotion);
  }, [settings.reducedMotion]);

  useEffect(() => {
    void reloadSecrets();
    void reloadAgents();
    void reloadConversations();
    const subs = [
      on('settings-changed', () => void reloadSettings()),
      on('runs-changed', () => void reloadConversations()),
      on('agent-event', (env) => {
        runStore.apply(env);
        mascotBus.send(mascotEventsFor(env.event));
        const ev = env.event;
        if (ev.type === 'run_started') void reloadConversations();
        if (ev.type === 'approval_requested' && !ev.native)
          announce(`Lumo needs your approval: ${ev.preview.title}`);
        if (ev.type === 'approval_requested' && ev.native)
          announce(`Confirm in the system dialog: ${ev.preview.title}`);
        if (ev.type === 'question') announce(`Lumo asks: ${ev.question}`);
        if (ev.type === 'run_finished') {
          const what =
            ev.status === 'done'
              ? 'Task finished.'
              : ev.status === 'failed'
                ? `Task failed. ${ev.error ?? ''}`
                : ev.status === 'cancelled'
                  ? 'Task stopped.'
                  : `Task ended: ${ev.status}.`;
          announce(what);
        }
      }),
    ];
    return () => subs.forEach((p) => void p.then((u) => u()));
  }, [announce, reloadAgents, reloadConversations, reloadSecrets, reloadSettings]);

  const value = useMemo<AppState>(
    () => ({
      settings,
      info: boot.info,
      secrets,
      agents,
      conversations,
      updateSettings,
      reloadSettings,
      reloadSecrets,
      reloadAgents,
      reloadConversations,
      announce,
      reportError,
    }),
    [
      settings,
      boot.info,
      secrets,
      agents,
      conversations,
      updateSettings,
      reloadSettings,
      reloadSecrets,
      reloadAgents,
      reloadConversations,
      announce,
      reportError,
    ],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="lu-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </Ctx.Provider>
  );
}
