import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  SegmentedControl,
  Spinner,
  TabList,
  TabPanel,
  Tabs,
} from '@lumo/ui';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  Folder,
  FolderKanban,
  FolderOpen,
  History,
  Plus,
  Save,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Composer } from '../components/Composer';
import { ConversationView, rememberPendingSend } from '../components/ConversationView';
import { PreviewPane } from '../components/PreviewPane';
import { dateTime, formatBytes, relativeTime } from '../lib/format';
import {
  api,
  errorMessage,
  on,
  type AttachmentInfo,
  type FileNode,
  type Project,
  type ProjectKind,
  type Version,
} from '../lib/ipc';
import { navigate, routeHref } from '../lib/router';
import { useApp } from '../state/app';
import { markStartedHere } from '../state/runs';

const CodeEditor = lazy(() => import('../components/CodeEditor'));

const KINDS: { value: ProjectKind; label: string }[] = [
  { value: 'website', label: 'Website' },
  { value: 'document', label: 'Document' },
  { value: 'code', label: 'Code' },
  { value: 'other', label: 'Other' },
];
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? k;

function useProjects() {
  const app = useApp();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const reload = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      app.reportError(e, 'Couldn’t load projects');
      setProjects([]);
    }
  }, [app]);
  useEffect(() => {
    void reload();
    const sub = on('projects-changed', () => void reload());
    return () => void sub.then((u) => u());
  }, [reload]);
  return { projects, reload };
}

export function ProjectsList() {
  const { projects } = useProjects();
  const [creating, setCreating] = useState(false);
  return (
    <div className="lm-page">
      <header className="lm-page-header">
        <div>
          <h1 className="lm-page-title">Projects</h1>
          <p className="lm-page-sub">
            Things Lumo builds with you: websites, documents and code, each with a live preview and version
            history.
          </p>
        </div>
        <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
          New project
        </Button>
      </header>
      {projects === null ? (
        <Spinner label="Loading projects" />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban />}
          title="No projects yet"
          description="Create one here, or ask Lumo to build something, like “Build a one-page website for my bakery”."
          actions={
            <Button variant="secondary" icon={<Plus />} onClick={() => setCreating(true)}>
              New project
            </Button>
          }
        />
      ) : (
        <div className="lm-project-grid">
          {projects.map((p) => (
            <a key={p.id} href={routeHref({ name: 'project', id: p.id })} className="lm-project-link">
              <Card interactive className="lm-project-card">
                <div className="lm-project-card-head">
                  <span className="lm-project-name">{p.name}</span>
                  <Badge>{kindLabel(p.kind)}</Badge>
                </div>
                <span className="lm-project-path" title={p.path}>
                  {p.path}
                </span>
                <span className="lm-row-meta">Updated {relativeTime(p.updatedAt)}</span>
              </Card>
            </a>
          ))}
        </div>
      )}
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProjectKind>('website');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject(name.trim(), kind);
      onOpenChange(false);
      setName('');
      navigate({ name: 'project', id: p.id });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="Lumo creates a folder in Documents › Lumo Projects with version history, and gives itself access to it."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void create()}>
            Create project
          </Button>
        </>
      }
    >
      <form
        className="lm-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void create();
        }}
      >
        <Field label="Name" error={error}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoFocus
            placeholder="Bakery website"
          />
        </Field>
        <div className="lm-field-inline">
          <span className="lu-field-label">Kind</span>
          <SegmentedControl<ProjectKind>
            label="Kind of project"
            value={kind}
            onValueChange={setKind}
            options={KINDS}
          />
        </div>
      </form>
    </Dialog>
  );
}

// ---- Workspace ----------------------------------------------------------------------------------

interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'folder';
  bytes: number | null;
  children: TreeNode[];
}

export function buildTree(files: FileNode[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'folder', bytes: null, children: [] };
  const index = new Map<string, TreeNode>([['', root]]);
  const sorted = [...files].sort(
    (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
  );
  for (const f of sorted) {
    const parts = f.path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    let parent = index.get(parentPath);
    if (!parent) {
      // Make missing folders (the walk caps depth and count).
      parent = root;
      let acc = '';
      for (const p of parts.slice(0, -1)) {
        acc = acc ? `${acc}/${p}` : p;
        let n = index.get(acc);
        if (!n) {
          n = { name: p, path: acc, kind: 'folder', bytes: null, children: [] };
          parent.children.push(n);
          index.set(acc, n);
        }
        parent = n;
      }
    }
    const node: TreeNode = {
      name: parts[parts.length - 1]!,
      path: f.path,
      kind: f.kind,
      bytes: f.bytes,
      children: [],
    };
    parent.children.push(node);
    if (f.kind === 'folder') index.set(f.path, node);
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
    );
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function FileTree({
  nodes,
  selected,
  onSelect,
  depth = 0,
}: {
  nodes: TreeNode[];
  selected: string | null;
  onSelect: (p: string) => void;
  depth?: number;
}) {
  return (
    <ul
      className="lm-tree"
      role={depth === 0 ? 'tree' : 'group'}
      aria-label={depth === 0 ? 'Project files' : undefined}
    >
      {nodes.map((n) => (
        <TreeItem key={n.path} node={n} selected={selected} onSelect={onSelect} depth={depth} />
      ))}
    </ul>
  );
}

function TreeItem({
  node,
  selected,
  onSelect,
  depth,
}: {
  node: TreeNode;
  selected: string | null;
  onSelect: (p: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth < 1);
  const pad = { paddingLeft: `calc(${depth} * var(--lu-space-3) + var(--lu-space-2))` };
  if (node.kind === 'folder') {
    return (
      <li role="treeitem" aria-expanded={open}>
        <button type="button" className="lm-tree-row" style={pad} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          <Folder aria-hidden />
          <span>{node.name}</span>
        </button>
        {open && node.children.length > 0 && (
          <FileTree nodes={node.children} selected={selected} onSelect={onSelect} depth={depth + 1} />
        )}
      </li>
    );
  }
  return (
    <li role="treeitem" aria-selected={selected === node.path}>
      <button
        type="button"
        className="lm-tree-row"
        style={pad}
        aria-current={selected === node.path ? 'true' : undefined}
        onClick={() => onSelect(node.path)}
        title={`${node.path} · ${formatBytes(node.bytes)}`}
      >
        <span className="lm-tree-spacer" />
        <File aria-hidden />
        <span>{node.name}</span>
      </button>
    </li>
  );
}

export function ProjectView({ id }: { id: string }) {
  const app = useApp();
  const { projects } = useProjects();
  const project = projects?.find((p) => p.id === id) ?? null;
  const [files, setFiles] = useState<FileNode[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState('index.html');
  const [previewKey, setPreviewKey] = useState(0);
  const [tab, setTab] = useState('preview');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const dirty = selected !== null && content !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const loadFiles = useCallback(async () => {
    try {
      const f = await api.projectFiles(id);
      setFiles(f);
      setFilesError(null);
      return f;
    } catch (e) {
      setFilesError(errorMessage(e));
      return null;
    }
  }, [id]);

  const openFile = useCallback(
    async (path: string) => {
      setFileError(null);
      try {
        const text = await api.readProjectFile(id, path);
        setSelected(path);
        setContent(text);
        setSaved(text);
        if (/\.html?$/i.test(path)) setPreviewPath(path);
      } catch (e) {
        setSelected(path);
        setContent('');
        setSaved('');
        setFileError(errorMessage(e));
      }
    },
    [id],
  );

  // Initial load: files, and the conversation that belongs to this project.
  useEffect(() => {
    setSelected(null);
    setFiles(null);
    void loadFiles().then((f) => {
      const first = f?.find((x) => x.path === 'index.html') ?? f?.find((x) => x.kind === 'file');
      if (first) void openFile(first.path);
    });
  }, [id, loadFiles, openFile]);

  useEffect(() => {
    if (!project) return;
    if (project.conversationId) {
      setConversationId(project.conversationId);
      return;
    }
    api
      .listConversations(null, 500)
      .then((cs) => setConversationId(cs.find((c) => c.projectId === project.id)?.id ?? null))
      .catch(() => setConversationId(null));
  }, [project]);

  const refreshAfterChange = useCallback(async () => {
    await loadFiles();
    const sel = selectedRef.current;
    if (sel && !dirtyRef.current) {
      try {
        const text = await api.readProjectFile(id, sel);
        setContent(text);
        setSaved(text);
      } catch {
        /* the file may have been removed */
      }
    }
    setPreviewKey((k) => k + 1);
  }, [id, loadFiles]);

  useEffect(() => {
    const sub = on('projects-changed', (p) => p?.id === id && void refreshAfterChange());
    return () => void sub.then((u) => u());
  }, [id, refreshAfterChange]);

  const save = useCallback(async () => {
    if (!selectedRef.current) return;
    setSaving(true);
    try {
      await api.writeProjectFile(id, selectedRef.current, content);
      setSaved(content);
      setPreviewKey((k) => k + 1);
    } catch (e) {
      app.reportError(e, 'Couldn’t save the file');
    } finally {
      setSaving(false);
    }
  }, [app, content, id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirtyRef.current) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const tree = useMemo(() => buildTree(files ?? []), [files]);

  const select = (path: string) => {
    if (path === selected) return;
    if (dirty) setConfirmSwitch(path);
    else void openFile(path);
  };

  const startConversation = async (text: string, attachments: AttachmentInfo[]) => {
    const started = await api.startRun({ text, attachments: attachments.map((a) => a.token), projectId: id });
    markStartedHere(started.runId);
    rememberPendingSend(started.conversationId, text, attachments);
    setConversationId(started.conversationId);
    void app.reloadConversations();
  };

  if (projects !== null && !project) {
    return (
      <div className="lm-page">
        <EmptyState
          title="This project isn’t here anymore"
          description="It may have been removed."
          actions={<Button onClick={() => navigate({ name: 'projects' })}>All projects</Button>}
        />
      </div>
    );
  }

  return (
    <div className="lm-workspace">
      <header className="lm-workspace-header">
        <a className="lm-back" href={routeHref({ name: 'projects' })} aria-label="All projects">
          <ArrowLeft aria-hidden />
        </a>
        <div className="lm-workspace-title">
          <h1>{project?.name ?? ' '}</h1>
          {project && <Badge>{kindLabel(project.kind)}</Badge>}
        </div>
        <div className="lm-workspace-actions">
          {project?.siteUrl && (
            <a className="lm-link" href={project.siteUrl} target="_blank" rel="noreferrer">
              Live site <ExternalLink aria-hidden />
            </a>
          )}
          {project?.githubRepo && (
            <a
              className="lm-link"
              href={
                /^https?:/.test(project.githubRepo)
                  ? project.githubRepo
                  : `https://github.com/${project.githubRepo}`
              }
              target="_blank"
              rel="noreferrer"
            >
              Repository <ExternalLink aria-hidden />
            </a>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderOpen />}
            onClick={() =>
              void api.revealProject(id).catch((e) => app.reportError(e, 'Couldn’t show the folder'))
            }
          >
            Show in folder
          </Button>
          <Button size="sm" variant="ghost" icon={<History />} onClick={() => setHistoryOpen(true)}>
            Versions
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setSaveOpen(true)}>
            Save version
          </Button>
        </div>
      </header>
      <div className="lm-workspace-body">
        <aside className="lm-files" aria-label="Files">
          <div className="lm-pane-title">Files</div>
          {filesError && <p className="lm-inline-error">{filesError}</p>}
          {files === null && !filesError && <Spinner label="Loading files" />}
          {files && files.length === 0 && (
            <p className="lm-muted lm-files-empty">No files yet. Ask Lumo to build something here.</p>
          )}
          {files && files.length > 0 && <FileTree nodes={tree} selected={selected} onSelect={select} />}
        </aside>
        <section className="lm-editor-pane" aria-label="Editor">
          <div className="lm-editor-bar">
            <span className="lm-editor-path">
              {selected ?? 'No file open'}
              {dirty && (
                <span className="lm-dirty" aria-label="Unsaved changes" role="img">
                  ●
                </span>
              )}
            </span>
            <Button
              size="sm"
              variant={dirty ? 'primary' : 'ghost'}
              icon={<Save />}
              disabled={!dirty}
              loading={saving}
              onClick={() => void save()}
              aria-keyshortcuts="Control+S Meta+S"
            >
              Save
            </Button>
          </div>
          {fileError ? (
            <div className="lm-editor-empty">
              <Callout tone="neutral" title="Can’t edit this file here">
                {fileError}
              </Callout>
            </div>
          ) : selected ? (
            <Suspense
              fallback={
                <div className="lm-editor-empty">
                  <Spinner label="Loading the editor" />
                </div>
              }
            >
              <CodeEditor
                key={selected}
                path={selected}
                value={content}
                onChange={setContent}
                onSave={() => void save()}
              />
            </Suspense>
          ) : (
            <div className="lm-editor-empty">
              <p className="lm-muted">Choose a file to edit it.</p>
            </div>
          )}
        </section>
        <section className="lm-side-pane" aria-label="Preview and conversation">
          <Tabs value={tab} onValueChange={setTab} className="lm-side-tabs">
            <TabList
              label="Project panels"
              tabs={[
                { value: 'preview', label: 'Preview' },
                { value: 'chat', label: 'Conversation' },
              ]}
            />
            <TabPanel value="preview" className="lm-side-panel">
              <PreviewPane projectId={id} path={previewPath} reloadKey={previewKey} siteUrl={null} />
            </TabPanel>
            <TabPanel value="chat" className="lm-side-panel" forceMount hidden={tab !== 'chat'}>
              {conversationId ? (
                <ConversationView
                  conversationId={conversationId}
                  variant="panel"
                  onPreview={(_pid, url) => {
                    setPreviewPath(url || 'index.html');
                    setPreviewKey((k) => k + 1);
                    setTab('preview');
                  }}
                  onToolFinished={() => void refreshAfterChange()}
                />
              ) : (
                <div className="lm-panel-start">
                  <p className="lm-muted">
                    Ask Lumo to change this project. It works in the project folder and saves versions as it
                    goes.
                  </p>
                  <Composer
                    onSend={startConversation}
                    running={false}
                    size="compact"
                    placeholder="Describe what to build or change…"
                    voiceShortcut={false}
                  />
                </div>
              )}
            </TabPanel>
          </Tabs>
        </section>
      </div>

      <Dialog
        open={confirmSwitch !== null}
        onOpenChange={(o) => !o && setConfirmSwitch(null)}
        title="Discard unsaved changes?"
        description={`Your changes to ${selected ?? 'this file'} haven’t been saved.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmSwitch(null)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const p = confirmSwitch;
                setConfirmSwitch(null);
                if (p) void openFile(p);
              }}
            >
              Discard changes
            </Button>
          </>
        }
      />
      <SaveVersionDialog open={saveOpen} onOpenChange={setSaveOpen} projectId={id} />
      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        projectId={id}
        onRestored={() => void refreshAfterChange()}
      />
    </div>
  );
}

function SaveVersionDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
}) {
  const app = useApp();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const v = await api.saveProjectVersion(projectId, message.trim() || 'Saved by you');
      if (v === null) setNote('Nothing changed since the last version.');
      else {
        onOpenChange(false);
        setMessage('');
        app.announce('Version saved.');
      }
    } catch (e) {
      setNote(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save a version"
      description="A snapshot of every file in the project that you can return to."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save version
          </Button>
        </>
      }
    >
      <Field label="Description" description={note ?? undefined}>
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={200}
          placeholder="New opening hours"
          autoFocus
        />
      </Field>
    </Dialog>
  );
}

function HistoryDialog({
  open,
  onOpenChange,
  projectId,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setVersions(null);
    api.projectHistory(projectId).then(setVersions, (e) => setError(errorMessage(e)));
  }, [open, projectId]);
  const restore = async (v: Version) => {
    setBusy(true);
    try {
      await api.restoreProjectVersion(projectId, v.id);
      setConfirm(null);
      onOpenChange(false);
      onRestored();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open={open && !confirm}
        onOpenChange={onOpenChange}
        title="Versions"
        description="Restoring a version saves the current state first, so nothing is lost."
        size="lg"
      >
        {error && <Callout tone="danger">{error}</Callout>}
        {versions === null && !error && <Spinner label="Loading versions" />}
        {versions && versions.length === 0 && <p className="lm-muted">No versions saved yet.</p>}
        {versions && versions.length > 0 && (
          <ul className="lm-rows">
            {versions.map((v, i) => (
              <li key={v.id} className="lm-row">
                <div className="lm-row-main">
                  <span className="lm-row-title">{v.message || 'Untitled version'}</span>
                  <span className="lm-row-meta">
                    {dateTime(v.time)} · {v.id.slice(0, 8)}
                    {i === 0 ? ' · current' : ''}
                  </span>
                </div>
                {i > 0 && (
                  <Button size="sm" variant="secondary" onClick={() => setConfirm(v)}>
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <Dialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Restore this version?"
        description={
          confirm
            ? `Files go back to “${confirm.message || 'this version'}” from ${dateTime(confirm.time)}. The current state is saved as a version first.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => confirm && void restore(confirm)}>
              Restore
            </Button>
          </>
        }
      />
    </>
  );
}
