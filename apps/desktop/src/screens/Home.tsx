import {
  CalendarHeart,
  FileText,
  FolderInput,
  Globe,
  MapPin,
  MessageCircleHeart,
  Timer,
  Wrench,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Composer, type ComposerHandle } from '../components/Composer';
import { rememberPendingSend } from '../components/ConversationView';
import { Mascot } from '../components/Mascot';
import { greeting } from '../lib/format';
import { api, type AttachmentInfo } from '../lib/ipc';
import { navigate } from '../lib/router';
import { useApp } from '../state/app';
import { startedHere } from '../state/runs';

/** Real prompts that work with Lumo's tools today, for each mode. */
const PERSONAL = [
  {
    icon: <MessageCircleHeart />,
    label: 'Talk through my day',
    prompt: 'Can we talk for a bit? I want to think through how my day went.',
  },
  {
    icon: <MapPin />,
    label: 'Find pizza places near me',
    prompt: 'Find pizza places near me that are open now, and compare a few options.',
  },
  {
    icon: <FolderInput />,
    label: 'Organize my Downloads folder',
    prompt:
      'Organize my Downloads folder: group the files into folders by type, and show me the plan before moving anything.',
  },
  {
    icon: <CalendarHeart />,
    label: 'Plan a cozy weekend',
    prompt:
      'Help me plan a relaxing weekend at home with a few fun ideas, a simple meal plan and a short to-do list.',
  },
];

const WORK = [
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
  {
    icon: <Timer />,
    label: 'Send me a daily news brief',
    prompt: 'Set up an automation that sends me a short brief of the top tech news every weekday at 8am.',
  },
  {
    icon: <Wrench />,
    label: 'Fix a bug in my project',
    prompt:
      'Look at my project, find why the contact form does not submit, and fix it. Show me the change first.',
  },
];

export function Home() {
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
        <p className="lm-home-sub">
          {app.settings.mode === 'linx'
            ? 'Linx Code: build, fix and automate your work.'
            : 'Your personal AI assistant. Ask for anything, or just talk.'}
        </p>
        <Composer ref={composer} onSend={send} running={false} agents={app.agents} acceptDrops autoFocus />
        <div className="lm-suggestions" role="list" aria-label="Suggestions">
          {(app.settings.mode === 'linx' ? WORK : PERSONAL).map((s) => (
            <button
              key={s.label}
              type="button"
              role="listitem"
              className="lm-suggestion"
              onClick={() => {
                composer.current?.setText(s.prompt);
                if ('attach' in s && s.attach) void composer.current?.attach();
              }}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
