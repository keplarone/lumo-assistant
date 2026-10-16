import { Button, IconButton } from '@lumo/ui';
import { FileText, FolderInput, Globe, MapPin, Sun, Volume2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Composer, type ComposerHandle } from '../components/Composer';
import { rememberPendingSend } from '../components/ConversationView';
import { Mascot } from '../components/Mascot';
import { greeting } from '../lib/format';
import { api, on, type AttachmentInfo, type Brief } from '../lib/ipc';
import { navigate } from '../lib/router';
import { speech } from '../lib/speech';
import { useApp } from '../state/app';
import { markStartedHere } from '../state/runs';

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
    markStartedHere(started.runId);
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
        <BriefCard />
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
      </div>
    </div>
  );
}

/**
 * Today's morning brief, until the user dismisses it. The first time an unseen brief shows, it is
 * read aloud (when that setting is on) and marked seen, so it is read once a day, not on every visit.
 */
function BriefCard() {
  const app = useApp();
  const [brief, setBrief] = useState<Brief | null>(null);
  const readAloud = useRef(app.settings.briefReadAloud);
  readAloud.current = app.settings.briefReadAloud;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const b = (await api.everydayOverview().catch(() => null))?.brief ?? null;
      if (!alive || !b || b.seen) return;
      setBrief(b);
      if (readAloud.current) speech.speak(b.text);
      void api.markBriefSeen(b.day).catch(() => {});
    };
    void load();
    const sub = on('everyday-alert', (a) => {
      if (a.kind === 'brief') void load();
    });
    return () => {
      alive = false;
      void sub.then((u) => u());
    };
  }, []);

  if (!brief) return null;
  return (
    <div className="lm-card lm-brief lm-home-brief" role="region" aria-label="Your morning brief">
      <div className="lm-brief-head">
        <Sun aria-hidden />
        <span className="lm-row-title">Your morning brief</span>
        <IconButton size="sm" label="Dismiss the brief" icon={<X />} onClick={() => setBrief(null)} />
      </div>
      {brief.text.split('\n\n').map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      <div className="lm-row-actions">
        <Button size="sm" variant="ghost" icon={<Volume2 />} onClick={() => speech.speak(brief.text)}>
          Read aloud
        </Button>
        <Button size="sm" variant="ghost" onClick={() => navigate({ name: 'everyday' })}>
          Open My day
        </Button>
      </div>
    </div>
  );
}
