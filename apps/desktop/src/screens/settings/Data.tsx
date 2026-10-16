import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Switch,
  Textarea,
} from '@lumo/ui';
import { Bot, Brain, Download, Folder, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { relativeTime } from '../../lib/format';
import {
  api,
  errorMessage,
  type AgentDef,
  type Grant,
  type MemoryCategory,
  type MemoryItem,
  type ToolInfo,
} from '../../lib/ipc';
import { useApp } from '../../state/app';
import { SectionHeader, SettingRow, useSave } from './parts';

// ---- Permissions --------------------------------------------------------------------------------

export function PermissionsSection() {
  const app = useApp();
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [caps, setCaps] = useState<[string, string][]>([]);
  const reload = useCallback(async () => {
    try {
      const [g, c] = await Promise.all([api.listGrants(), api.listCapabilities()]);
      setGrants(g);
      setCaps(c);
    } catch (e) {
      app.reportError(e, 'Couldn’t load permissions');
    }
  }, [app]);
  useEffect(() => void reload(), [reload]);

  const addFolder = async () => {
    try {
      if (await api.grantFolder()) await reload();
    } catch (e) {
      app.reportError(e, 'Couldn’t add the folder');
    }
  };
  const revoke = async (id: string) => {
    try {
      await api.revokeGrant(id);
      await reload();
    } catch (e) {
      app.reportError(e, 'Couldn’t remove access');
    }
  };
  const setCap = async (cap: string, on: boolean) => {
    try {
      if (on) await api.grantCapability(cap);
      else {
        const g = grants?.find((x) => x.kind === 'capability' && x.target === cap);
        if (g) await api.revokeGrant(g.id);
      }
      await reload();
    } catch (e) {
      app.reportError(e, 'Couldn’t change the permission');
    }
  };

  const folders = grants?.filter((g) => g.kind === 'folder') ?? [];
  return (
    <>
      <SectionHeader
        title="Permissions"
        description="Lumo can only reach what you grant here. Every action is checked by Lumo’s core, whatever the model asks for."
      />
      <div className="lm-tiers">
        <div className="lm-tier">
          <Badge>Read</Badge>
          <p>
            Looking at files in granted folders, searching the web, finding places. Runs on its own and is
            logged.
          </p>
        </div>
        <div className="lm-tier">
          <Badge tone="accent">Change</Badge>
          <p>
            Creating, editing or moving files, opening links. Lumo asks in the conversation first; every file
            change can be undone.
          </p>
        </div>
        <div className="lm-tier">
          <Badge tone="warning">Sensitive</Badge>
          <p>
            Running commands, checkout and sign-in pages, larger deletions, screen capture. Confirmed in a
            system dialog every time; never in automations.
          </p>
        </div>
      </div>

      <div className="lm-settings-subhead">
        <h3>Folders</h3>
        <Button variant="secondary" icon={<FolderPlus />} onClick={() => void addFolder()}>
          Add folder
        </Button>
      </div>
      {grants === null ? (
        <Spinner label="Loading" />
      ) : folders.length === 0 ? (
        <p className="lm-muted">No folders yet. Lumo asks when a task needs one.</p>
      ) : (
        <ul className="lm-rows">
          {folders.map((g) => (
            <li key={g.id} className="lm-row">
              <Folder aria-hidden className="lm-row-icon" />
              <div className="lm-row-main">
                <span className="lm-row-title">{g.label}</span>
                <span className="lm-row-meta lm-mono">{g.target}</span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => void revoke(g.id)}>
                Remove access
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="lm-settings-subhead">
        <h3>Other access</h3>
      </div>
      {caps.map(([id, label]) => {
        const on = !!grants?.some((g) => g.kind === 'capability' && g.target === id);
        return (
          <SettingRow key={id} label={label}>
            <Switch checked={on} onCheckedChange={(v) => void setCap(id, v)} aria-label={label} />
          </SettingRow>
        );
      })}
    </>
  );
}

// ---- Memory -------------------------------------------------------------------------------------

const CATEGORIES: { value: MemoryCategory; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'preference', label: 'Preference' },
  { value: 'fact', label: 'Fact' },
  { value: 'person', label: 'Person' },
  { value: 'place', label: 'Place' },
];

export function MemorySection() {
  const app = useApp();
  const save = useSave();
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [adding, setAdding] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('general');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await api.listMemories());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => void reload(), [reload]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  return (
    <>
      <SectionHeader
        title="Memory"
        description="Things Lumo remembers between conversations. Lumo saves only what you ask it to, and you can change or delete anything here."
      />
      <SettingRow
        label="Use memory"
        description={
          app.settings.memoryEnabled
            ? 'On. Saved memories are shared with the model at the start of each message.'
            : 'Off. Nothing is remembered or shared.'
        }
      >
        <Switch
          checked={app.settings.memoryEnabled}
          onCheckedChange={(v) => void save({ memoryEnabled: v })}
          aria-label="Use memory"
        />
      </SettingRow>
      <form
        className="lm-memory-add"
        onSubmit={async (e) => {
          e.preventDefault();
          if (adding.trim() && (await run(() => api.addMemory(adding.trim(), category)))) setAdding('');
        }}
      >
        <Input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="Add something for Lumo to remember"
          aria-label="New memory"
          maxLength={1000}
        />
        <Select
          aria-label="Category"
          value={category}
          onValueChange={(v) => setCategory(v as MemoryCategory)}
          options={CATEGORIES}
          className="lm-memory-cat"
        />
        <Button type="submit" variant="secondary" icon={<Plus />} disabled={!adding.trim()}>
          Add
        </Button>
      </form>
      {error && (
        <p className="lm-inline-error" role="alert">
          {error}
        </p>
      )}
      {items === null ? (
        <Spinner label="Loading memories" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Brain />}
          title="Nothing remembered"
          description="When memory is on, ask Lumo to remember something, like “Remember that I prefer vegetarian places.”"
        />
      ) : (
        <ul className="lm-rows">
          {items.map((m) => (
            <li key={m.id} className="lm-row">
              {editing?.id === m.id ? (
                <form
                  className="lm-memory-edit"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await run(() => api.updateMemory(m.id, editing.text))) setEditing(null);
                  }}
                >
                  <Textarea
                    value={editing.text}
                    onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                    autoSize
                    maxRows={6}
                    aria-label="Edit memory"
                    autoFocus
                  />
                  <div className="lm-row-actions">
                    <Button type="submit" size="sm" variant="primary" disabled={!editing.text.trim()}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="lm-row-main">
                    <span className="lm-row-title lm-wrap">{m.content}</span>
                    <span className="lm-row-meta">
                      {CATEGORIES.find((c) => c.value === m.category)?.label ?? m.category} ·{' '}
                      {relativeTime(m.updatedAt)}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Pencil />}
                    onClick={() => setEditing({ id: m.id, text: m.content })}
                    aria-label="Edit memory"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 />}
                    onClick={() => void run(() => api.deleteMemory(m.id))}
                    aria-label="Delete memory"
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="lm-setting-block lm-row-actions">
        <Button
          variant="secondary"
          icon={<Download />}
          disabled={!items?.length}
          onClick={async () => {
            try {
              const p = await api.exportMemories();
              if (p) app.announce(`Exported to ${p}`);
            } catch (e) {
              app.reportError(e, 'Couldn’t export');
            }
          }}
        >
          Export
        </Button>
        <Button
          variant="ghost"
          icon={<Trash2 />}
          disabled={!items?.length}
          onClick={() => setConfirmAll(true)}
        >
          Delete all
        </Button>
      </div>
      <Dialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Delete every memory?"
        description={`All ${items?.length ?? 0} memories are removed from this computer. This can’t be undone.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmAll(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (await run(() => api.deleteAllMemories())) setConfirmAll(false);
              }}
            >
              Delete all
            </Button>
          </>
        }
      />
    </>
  );
}

// ---- Agents -------------------------------------------------------------------------------------

export function AgentsSection() {
  const app = useApp();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [editing, setEditing] = useState<AgentDef | null>(null);
  const [deleting, setDeleting] = useState<AgentDef | null>(null);
  useEffect(() => {
    api.listTools().then(setTools, () => setTools([]));
    void app.reloadAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <SectionHeader
        title="Assistants"
        description="Custom versions of Lumo with their own instructions and tools. Pick one in the message box when you start a new task."
      />
      <div className="lm-settings-subhead">
        <span />
        <Button
          variant="secondary"
          icon={<Plus />}
          onClick={() => setEditing({ name: '', description: '', instructions: '', tools: [], model: null })}
        >
          New assistant
        </Button>
      </div>
      {app.agents.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title="No custom assistants"
          description="For example, a “Writing helper” that only reads files and answers in British English."
        />
      ) : (
        <ul className="lm-rows">
          {app.agents.map((a) => (
            <li key={a.id} className="lm-row">
              <Bot aria-hidden className="lm-row-icon" />
              <div className="lm-row-main">
                <span className="lm-row-title">{a.name}</span>
                <span className="lm-row-meta">
                  {a.description || 'No description'} ·{' '}
                  {a.tools.length ? `${a.tools.length} tools` : 'All tools'}
                  {a.model ? ` · ${app.info.models.find(([id]) => id === a.model)?.[1] ?? a.model}` : ''}
                </span>
              </div>
              <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(a)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 />}
                aria-label={`Delete ${a.name}`}
                onClick={() => setDeleting(a)}
              />
            </li>
          ))}
        </ul>
      )}
      {editing && <AgentEditor agent={editing} tools={tools} onClose={() => setEditing(null)} />}
      <Dialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="Conversations that used it are kept."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  if (deleting?.id) await api.deleteAgent(deleting.id);
                  setDeleting(null);
                  await app.reloadAgents();
                } catch (e) {
                  app.reportError(e, 'Couldn’t delete');
                }
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </>
  );
}

function AgentEditor({ agent, tools, onClose }: { agent: AgentDef; tools: ToolInfo[]; onClose: () => void }) {
  const app = useApp();
  const [a, setA] = useState<AgentDef>(agent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choosable = tools.filter((t) => !['update_plan', 'ask_user', 'present_options'].includes(t.name));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveAgent({ ...a, name: a.name.trim(), model: a.model || null });
      await app.reloadAgents();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={agent.id ? 'Edit assistant' : 'New assistant'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!a.name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="lm-form">
        <Field label="Name" error={error}>
          <Input
            value={a.name}
            onChange={(e) => setA({ ...a, name: e.target.value })}
            maxLength={60}
            autoFocus
          />
        </Field>
        <Field label="Description">
          <Input
            value={a.description}
            onChange={(e) => setA({ ...a, description: e.target.value })}
            maxLength={200}
          />
        </Field>
        <Field
          label="Instructions"
          description="How this assistant should behave, added to Lumo’s own rules (which it can’t override)."
        >
          <Textarea
            value={a.instructions}
            onChange={(e) => setA({ ...a, instructions: e.target.value })}
            rows={5}
            autoSize
            maxRows={12}
          />
        </Field>
        <div className="lm-field-inline">
          <span className="lu-field-label">Model</span>
          <Select
            aria-label="Model"
            value={a.model ?? 'default'}
            onValueChange={(v) => setA({ ...a, model: v === 'default' ? null : v })}
            options={[
              { value: 'default', label: 'Use the default model' },
              ...app.info.models.map(([id, label]) => ({ value: id, label })),
            ]}
          />
        </div>
        <fieldset className="lm-fieldset">
          <legend className="lu-field-label">Tools</legend>
          <p className="lu-field-description">
            Leave all unchecked to allow every tool. Plans, questions and option cards are always available.
            Permissions still apply to every tool.
          </p>
          <ul className="lm-checks lm-checks-grid">
            {choosable.map((t) => (
              <li key={t.name}>
                <label className="lm-check" title={t.description}>
                  <Checkbox
                    checked={a.tools.includes(t.name)}
                    onCheckedChange={(c) =>
                      setA({ ...a, tools: c ? [...a.tools, t.name] : a.tools.filter((x) => x !== t.name) })
                    }
                  />
                  <span>
                    <span className="lm-check-name">{t.name}</span>
                    <span className="lm-check-desc">{t.description.split('. ')[0]}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      </div>
    </Dialog>
  );
}
