CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  tools_json TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  agent_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  project_id TEXT,
  origin TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  summary TEXT,
  usage_json TEXT,
  plan_json TEXT
);
CREATE INDEX runs_by_conversation ON runs(conversation_id, started_at);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  risk TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  output_text TEXT,
  approval TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX tool_calls_by_run ON tool_calls(run_id, started_at);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, target)
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  source_conversation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  agent_id TEXT,
  trigger_json TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  notify INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT,
  watch_state TEXT
);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  run_id TEXT,
  conversation_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  error TEXT,
  summary TEXT
);
CREATE INDEX automation_runs_by_automation ON automation_runs(automation_id, started_at);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  account_label TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  connected_at TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  conversation_id TEXT,
  netlify_site_id TEXT,
  site_url TEXT,
  github_repo TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE file_journal (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  tool_call_id TEXT,
  op TEXT NOT NULL,
  path TEXT NOT NULL,
  dest_path TEXT,
  backup_path TEXT,
  created_at TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX file_journal_by_run ON file_journal(run_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  outcome TEXT NOT NULL
);
CREATE INDEX audit_by_time ON audit_log(ts);
