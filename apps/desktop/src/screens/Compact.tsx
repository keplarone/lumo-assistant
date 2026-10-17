import { IconButton } from '@lumo/ui';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Composer } from '../components/Composer';
import { ConversationView, rememberPendingSend } from '../components/ConversationView';
import { Mascot } from '../components/Mascot';
import { greeting } from '../lib/format';
import { api, type AttachmentInfo } from '../lib/ipc';
import { useApp } from '../state/app';
import { markStartedHere } from '../state/runs';

/** The floating quick-ask window (label "compact", loaded at #/compact). */
export function Compact() {
  const app = useApp();
  const [conversationId, setConversationId] = useState<string | null>(null);

  const hide = () =>
    void getCurrentWindow()
      .hide()
      .catch(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc hides the window unless a dialog or menu is open (Radix handles those first).
      if (
        e.key === 'Escape' &&
        !e.defaultPrevented &&
        !document.querySelector('[role="dialog"],[role="menu"]')
      )
        hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = async (text: string, attachments: AttachmentInfo[], agentId: string | null) => {
    const started = await api.startRun({ text, attachments: attachments.map((a) => a.token), agentId });
    markStartedHere(started.runId);
    rememberPendingSend(started.conversationId, text, attachments);
    setConversationId(started.conversationId);
    void app.reloadConversations();
  };

  const openInLumo = async () => {
    try {
      await api.showMainWindow();
      if (conversationId) {
        // The main window follows its own hash; tell it where to go through the conversation list.
        await getCurrentWindow()
          .emitTo('main', 'open-conversation', conversationId)
          .catch(() => {});
      }
    } catch (e) {
      app.reportError(e, 'Couldn’t open Lumo');
    }
  };

  return (
    <div className="lm-compact">
      <header className="lm-compact-header" data-tauri-drag-region>
        <Mascot size="tiny" className="lm-compact-mascot" />
        <span className="lm-compact-title" data-tauri-drag-region>
          {conversationId ? 'Lumo' : greeting(app.settings.userName)}
        </span>
        {conversationId && (
          <IconButton label="New task" icon={<Plus />} size="sm" onClick={() => setConversationId(null)} />
        )}
        <IconButton label="Open in Lumo" icon={<Maximize2 />} size="sm" onClick={() => void openInLumo()} />
        <IconButton label="Hide" icon={<X />} size="sm" shortcut={['Esc']} onClick={hide} />
      </header>
      <main className="lm-compact-body" id="main">
        {conversationId ? (
          <ConversationView conversationId={conversationId} variant="compact" />
        ) : (
          <div className="lm-compact-new">
            <p className="lm-muted">What can Lumo do for you?</p>
            <Composer onSend={send} running={false} agents={app.agents} size="compact" autoFocus />
          </div>
        )}
      </main>
    </div>
  );
}
