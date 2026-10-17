import {
  Coffee,
  FileText,
  FolderInput,
  Globe,
  MapPin,
  RotateCcw,
  ShoppingBag,
  UtensilsCrossed,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Composer, type ComposerHandle } from '../components/Composer';
import { rememberPendingSend } from '../components/ConversationView';
import { Mascot } from '../components/Mascot';
import { greeting } from '../lib/format';
import { api, type AttachmentInfo, type RecentOrder } from '../lib/ipc';
import { navigate } from '../lib/router';
import { useApp } from '../state/app';
import { startedHere } from '../state/runs';

/** Real prompts that work with Lumo's tools today. */
const SUGGESTIONS = [
  {
    icon: <FolderInput />,
    label: 'Organize my Downloads folder',
    prompt:
      'Organize my Downloads folder: group the files into folders by type, and show me the plan before moving anything.',
  },
  {
    icon: <MapPin />,
    label: 'Find pizza places near me',
    prompt: 'Find pizza places near me that are open now, and compare a few options.',
  },
  {
    icon: <Globe />,
    label: 'Build a one-page website for my bakery',
    prompt:
      'Build a one-page website for my bakery with a hero, our menu highlights, opening hours and a contact section. Show me the preview.',
  },
  {
    icon: <FileText />,
    label: 'Summarize a file I attach',
    prompt: 'Summarize the attached file in a few bullet points.',
    attach: true,
  },
];

/** One-tap orders. Lumo still shows the order in a system dialog before it opens the app. */
const QUICK_ORDERS = [
  {
    icon: <UtensilsCrossed />,
    label: "Get me McDonald's",
    prompt: "Get me McDonald's. Ask me what I want if you don't know my usual.",
  },
  {
    icon: <Coffee />,
    label: 'Get me coffee',
    prompt: "Get me a coffee from somewhere near me. Ask me what I want if you don't know my usual.",
  },
  {
    icon: <ShoppingBag />,
    label: 'Get my groceries',
    prompt: 'Help me order groceries. Ask me what I need.',
  },
];

function againPrompt(o: RecentOrder): string {
  const items = o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ');
  return `Order again on ${o.appName}${o.store ? ` from ${o.store}` : ''}: ${items}.`;
}

export function Home() {
  const [recent, setRecent] = useState<RecentOrder[]>([]);
  useEffect(() => {
    api.recentOrders().then(setRecent, () => setRecent([]));
  }, []);
  const app = useApp();
  const composer = useRef<ComposerHandle>(null);
  useEffect(() => {
    const focus = () => composer.current?.focus();
    window.addEventListener('lumo:focus-composer', focus);
    return () => window.removeEventListener('lumo:focus-composer', focus);
  }, []);
  const send = async (text: string, attachments: AttachmentInfo[], agentId: string | null) => {
    const started = await api.startRun({ text, attachments: attachments.map((a) => a.token), agentId });
    startedHere.add(started.runId);
    rememberPendingSend(started.conversationId, text, attachments);
    void app.reloadConversations();
    navigate({ name: 'conversation', id: started.conversationId });
  };

  return (
    <div className="lm-home">
      <div className="lm-home-inner">
        <Mascot size="hero" className="lm-home-mascot" />
        <h1 className="lm-greeting">{greeting(app.settings.userName)}</h1>
        <p className="lm-home-sub">Tell Lumo what you want. Lumo figures out how to make it happen.</p>
        <Composer ref={composer} onSend={send} running={false} agents={app.agents} acceptDrops autoFocus />
        <div className="lm-suggestions" role="list" aria-label="Suggestions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              role="listitem"
              className="lm-suggestion"
              onClick={() => {
                composer.current?.setText(s.prompt);
                if (s.attach) void composer.current?.attach();
              }}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <div className="lm-suggestions lm-quick-orders" role="list" aria-label="Quick orders">
          {recent.slice(0, 3).map((o) => (
            <button
              key={o.id}
              type="button"
              role="listitem"
              className="lm-suggestion"
              title={againPrompt(o)}
              onClick={() => void send(againPrompt(o), [], null)}
            >
              <RotateCcw />
              <span>{o.store ?? o.appName} again</span>
            </button>
          ))}
          {QUICK_ORDERS.slice(0, recent.length ? 2 : 3).map((q) => (
            <button
              key={q.label}
              type="button"
              role="listitem"
              className="lm-suggestion"
              onClick={() => void send(q.prompt, [], null)}
            >
              {q.icon}
              <span>{q.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
