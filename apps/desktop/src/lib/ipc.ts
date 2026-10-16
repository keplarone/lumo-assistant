/**
 * Typed bridge to the Rust core. Every command the UI calls and every event it listens to is
 * declared here, mirroring the serde shapes in src-tauri/src exactly. The webview never sees a
 * secret: it can only ask whether one is set.
 *
 * Tauri converts top-level argument names to camelCase; nested structs follow their serde
 * attributes (camelCase on every struct the UI sends).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ---- Errors -------------------------------------------------------------------------------------

/**
 * What every failing command returns (error.rs ApiError). `plan_limit` means the user's plan doesn't
 * include something or its monthly usage is used up; the message says which, and when it resets.
 */
export interface ApiError {
  code: 'plan_limit' | (string & {});
  message: string;
}

/** A refusal from the plan limits in Rust (plans.rs), shown with an Upgrade button. */
export function isPlanLimit(e: unknown): e is ApiError {
  return isApiError(e) && (e as ApiError).code === 'plan_limit';
}

export function isApiError(e: unknown): e is ApiError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'message' in e &&
    typeof (e as { message: unknown }).message === 'string'
  );
}

/** A message that is safe and useful to show the user. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}

/** True when running inside the Lumo app (the Tauri IPC bridge is present). */
export function hasBridge(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ---- Settings and app ---------------------------------------------------------------------------

export type ThemeSetting = 'system' | 'dark' | 'light';
export type Provider = 'anthropic' | 'openai_compatible' | 'local';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

export interface Location {
  label: string;
  lat: number;
  lon: number;
}

/** settings.rs Settings (camelCase). */
export interface Settings {
  onboarded: boolean;
  userName: string | null;
  theme: ThemeSetting;
  provider: Provider;
  model: string;
  effort: Effort;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  openaiModel: string;
  /** Catalog id of the chosen on-device model; empty until one is chosen. */
  localModel: string;
  memoryEnabled: boolean;
  webSearchEnabled: boolean;
  globalShortcut: string;
  closeToTray: boolean;
  retentionDays: number | null;
  location: Location | null;
  automationsPaused: boolean;
  maxToolCallsPerRun: number;
  sttBaseUrl: string;
  sttModel: string;
  ttsEnabled: boolean;
  mascotEnabled: boolean;
  reducedMotion: boolean;
  /** "free", "lite", "pro" or "unlimited". Set only by Rust's license check; saving settings keeps it. */
  plan: string;
  planCheckedAt: string | null;
}

export interface AppInfo {
  version: string;
  os: string;
  /** An error message when no system keychain is available; null when it works. */
  keychain: string | null;
  dataDir: string;
  logDir: string;
  /** [id, label] */
  models: [string, string][];
  updaterConfigured: boolean;
}

export interface SecretStatus {
  name: string;
  label: string;
  set: boolean;
}

export type SecretName =
  | 'anthropic_api_key'
  | 'openai_compatible_api_key'
  | 'brave_search_api_key'
  | 'github_token'
  | 'netlify_token'
  | 'google_client_secret'
  | 'google_tokens'
  | 'stt_api_key';

// ---- Conversations and runs ---------------------------------------------------------------------

export interface Conversation {
  id: string;
  title: string;
  agentId: string | null;
  provider: string;
  model: string;
  projectId: string | null;
  origin: string;
  createdAt: string;
  updatedAt: string;
}

/** A stored content block, verbatim from the model API (text, image, document, tool_use, tool_result, thinking…). */
export type ContentBlock = { type: string; [key: string]: unknown };

export interface StoredMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'system' | string;
  content: ContentBlock[];
  runId: string | null;
  createdAt: string;
}

export type RunStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'refused'
  | 'stopped'
  | 'needs_attention'
  | 'interrupted'
  /** The plan's monthly usage ran out between model calls; `error` says when it resets. */
  | 'limit_reached'
  | string;

export interface PlanStep {
  title: string;
  status: 'pending' | 'active' | 'done' | 'failed' | 'skipped' | string;
}

export interface RunRecord {
  id: string;
  conversationId: string;
  origin: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  summary: string | null;
  plan: PlanStep[] | null;
  title: string | null;
}

/** get_conversation's toolCalls rows (built with json! in commands.rs). */
export interface ToolCallRecord {
  id: string;
  runId: string;
  name: string;
  risk: string;
  status: string;
  summary: string | null;
  approval: string | null;
  startedAt: string;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: StoredMessage[];
  runs: RunRecord[];
  toolCalls: ToolCallRecord[];
}

export interface StartRequest {
  conversationId?: string | null;
  text: string;
  attachments?: string[];
  agentId?: string | null;
  projectId?: string | null;
}

export interface Started {
  runId: string;
  conversationId: string;
}

export interface ActiveRunInfo {
  runId: string;
  conversationId: string;
  origin: string;
  title: string;
  startedAt: string;
}

export interface AttachmentInfo {
  token: string;
  name: string;
  bytes: number;
  kind: 'image' | 'pdf' | 'file' | string;
}

export type ApprovalAnswer = 'deny' | 'once' | 'conversation';

// ---- Permissions, changes, memory ---------------------------------------------------------------

export interface Grant {
  id: string;
  kind: 'folder' | 'capability' | string;
  target: string;
  label: string;
  createdAt: string;
}

export interface JournalEntry {
  id: string;
  runId: string | null;
  op: string;
  path: string;
  destPath: string | null;
  backupPath: string | null;
  createdAt: string;
  undone: boolean;
}

export interface UndoReport {
  undone: number;
  skipped: string[];
}

export type MemoryCategory = 'preference' | 'fact' | 'person' | 'place' | 'general';

export interface MemoryItem {
  id: string;
  content: string;
  category: MemoryCategory | string;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- Automations and agents ---------------------------------------------------------------------

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** automations.rs Trigger: `#[serde(tag = "type", rename_all = "snake_case")]`. */
export type Trigger =
  | { type: 'daily'; time: string; days: Weekday[] }
  | { type: 'interval'; minutes: number }
  | { type: 'cron'; expression: string };

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  agentId: string | null;
  trigger: Trigger;
  allowedTools: string[];
  enabled: boolean;
  notify: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
}

export interface AutomationInput {
  name: string;
  prompt: string;
  agentId?: string | null;
  trigger: Trigger;
  allowedTools: string[];
  enabled: boolean;
  notify: boolean;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  runId: string | null;
  conversationId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  error: string | null;
  summary: string | null;
}

export interface AgentDef {
  id?: string | null;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  model?: string | null;
  updatedAt?: string | null;
}

export interface ToolInfo {
  name: string;
  description: string;
}

// ---- Projects -----------------------------------------------------------------------------------

export type ProjectKind = 'website' | 'document' | 'code' | 'other';

export interface Project {
  id: string;
  name: string;
  path: string;
  kind: ProjectKind | string;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Added by the publishing integrations; optional until every build returns them. */
  siteUrl?: string | null;
  githubRepo?: string | null;
}

export interface FileNode {
  path: string;
  kind: 'file' | 'folder';
  bytes: number | null;
}

export interface Version {
  id: string;
  message: string;
  time: string;
}

// ---- Audit and integrations ---------------------------------------------------------------------

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
  outcome: string;
}

export type IntegrationState = 'connected' | 'not_connected' | 'built_in' | 'handoff' | 'upcoming';

export interface IntegrationStatus {
  id: string;
  name: string;
  status: IntegrationState | string;
  account: string | null;
  detail: string;
  secret: string | null;
}

export type OrderingCategory = 'food' | 'groceries' | 'shopping' | 'rides' | 'tables';

/** An app Lumo can order with in the user's browser (integrations/apps.rs). */
export interface OrderingApp {
  id: string;
  name: string;
  category: OrderingCategory | string;
  home: string;
  regions: string;
  /** The user said they are signed in there. */
  connected: boolean;
  /** Which saved payment method to pick at checkout, e.g. "Apple Pay". A label only. */
  payment: string | null;
}

export interface RecentOrder {
  id: string;
  app: string;
  appName: string;
  store: string | null;
  items: { name: string; quantity: number }[];
  createdAt: string;
}

// ---- Agent events (agent/events.rs) -------------------------------------------------------------

export type Mood = 'neutral' | 'warm' | 'happy' | 'calm' | 'concerned' | 'celebrating' | (string & {});

export type Phase = 'understanding' | 'planning' | 'executing' | 'verifying' | 'reporting';

/** ActionPreview: `details` serializes as an array of [label, value] tuples. */
export interface ActionPreview {
  title: string;
  details: [string, string][];
  warning: string | null;
}

export interface OptionItem {
  title: string;
  subtitle?: string;
  details?: string[];
  price?: string;
  url?: string;
  source: string;
}

/**
 * `#[serde(tag = "type", rename_all = "snake_case")]`. Variants with `#[serde(rename_all = "camelCase")]`
 * have camelCase fields; the others (phase, text_delta, progress_note, plan, options, privacy) have
 * single-word fields, so the casing is the same either way.
 */
export type AgentEvent =
  | { type: 'run_started'; runId: string; conversationId: string }
  | { type: 'phase'; phase: Phase }
  | { type: 'text_delta'; text: string }
  | { type: 'progress_note'; text: string }
  | { type: 'plan'; steps: PlanStep[] }
  | { type: 'tool_started'; callId: string; name: string; label: string; risk: string; input: unknown }
  | { type: 'tool_finished'; callId: string; name: string; ok: boolean; summary: string; data: unknown }
  | {
      type: 'approval_requested';
      approvalId: string;
      callId: string;
      tier: 'write' | 'sensitive' | string;
      native: boolean;
      preview: ActionPreview;
    }
  | { type: 'approval_resolved'; approvalId: string; approved: boolean }
  | { type: 'question'; questionId: string; question: string; options: string[]; allowFreeText: boolean }
  | { type: 'options'; title: string; items: OptionItem[] }
  | { type: 'open_preview'; projectId: string; url: string }
  | { type: 'privacy'; kind: string; detail: string }
  /** The mascot's expression for the conversation's tone (set_mood tool). Never a timeline step. */
  | { type: 'mood'; mood: Mood }
  | { type: 'assistant_message'; messageId: string }
  | { type: 'run_finished'; runId: string; status: RunStatus; summary: string | null; error: string | null };

/** The `agent-event` payload (commands.rs AppSink). */
export interface AgentEventEnvelope {
  runId: string;
  conversationId: string;
  event: AgentEvent;
}

// ---- Commands -----------------------------------------------------------------------------------

/** license.rs LicenseStatus. */
export interface LicenseStatus {
  plan: string;
  hasKey: boolean;
  licensingConfigured: boolean;
  checkoutLite: string | null;
  checkoutPro: string | null;
  checkoutUnlimited: string | null;
  checkedAt: string | null;
}

export type PlanId = 'free' | 'lite' | 'pro' | 'unlimited';

/** plans.rs PlanInfo: one row of the plans table. */
export interface PlanInfo {
  id: PlanId;
  name: string;
  /** Model tokens per calendar month; null means unlimited. */
  monthlyTokens: number | null;
  /** Display names of the on-device models the plan includes. */
  localModels: string[];
  cloudModels: boolean;
  /** Active automations; null means no limit. */
  automations: number | null;
  computerControl: boolean;
}

/** plans.rs PlanUsage. Display only: Rust enforces every limit. */
export interface PlanUsage {
  plan: PlanId;
  /** Input + output model tokens this calendar month. */
  tokensUsed: number;
  /** null on a plan with unlimited usage. */
  tokensLimit: number | null;
  /** 0 to 100; null on a plan with unlimited usage. */
  percentUsed: number | null;
  /** Local midnight on the 1st of next month. */
  resetsAt: string;
  /** Runtime tags of the catalog's on-device models this plan may use. */
  allowedModels: string[];
  cloudModels: boolean;
  automationsAllowed: number | null;
  computerControl: boolean;
  plans: PlanInfo[];
}

// ---- On-device models (local_models.rs) -----------------------------------------------------------

export interface LocalModel {
  /** Catalog id, e.g. "qwen3:8b". */
  id: string;
  tier: string;
  /** The underlying open model; always shown for attribution. */
  baseModel: string;
  license: string;
  licenseUrl: string;
  /** The Hugging Face repository the weights come from. */
  sourceRepo: string;
  downloadGb: number;
  minMemoryGb: number;
  summary: string;
  displayName: string;
  installed: boolean;
  /** Bytes of an unfinished download that continues next time (0 if none). */
  partialBytes: number;
  fits: boolean;
  selected: boolean;
  /** The cheapest plan that includes this model when the current plan doesn't, else null. */
  requiredPlan: PlanId | null;
}

export interface LocalStatus {
  /** Product name for on-device models; never hardcode it. */
  brand: string;
  /** The engine built into Lumo ("llama.cpp"); always available, nothing to install. */
  engine: string;
  /** What runs the models: "Metal", "Vulkan" or "CPU". */
  accelerator: string;
  /** Total memory in GB; 0 when unknown. */
  memoryGb: number;
  models: LocalModel[];
}

export interface LocalModelProgress {
  model: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
}

const call = <T>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args);

export const api = {
  // App and settings
  appInfo: () => call<AppInfo>('app_info'),
  getSettings: () => call<Settings>('get_settings'),
  saveSettings: (settings: Settings) => call<Settings>('save_settings', { settings }),
  secretsStatus: () => call<SecretStatus[]>('secrets_status'),
  setSecret: (name: SecretName | string, value: string) => call<void>('set_secret', { name, value }),
  deleteSecret: (name: SecretName | string) => call<void>('delete_secret', { name }),
  testModelConnection: () => call<string>('test_model_connection'),

  // Conversations and runs
  listConversations: (query?: string | null, limit?: number) =>
    call<Conversation[]>('list_conversations', { query: query ?? null, limit: limit ?? null }),
  getConversation: (id: string) => call<ConversationDetail>('get_conversation', { id }),
  renameConversation: (id: string, title: string) => call<void>('rename_conversation', { id, title }),
  deleteConversation: (id: string) => call<void>('delete_conversation', { id }),
  exportConversation: (id: string) => call<string | null>('export_conversation', { id }),
  startRun: (request: StartRequest) => call<Started>('start_run', { request }),
  cancelRun: (runId: string) => call<boolean>('cancel_run', { runId }),
  stopAllRuns: () => call<number>('stop_all_runs'),
  resolveApproval: (approvalId: string, answer: ApprovalAnswer) =>
    call<boolean>('resolve_approval', { approvalId, answer }),
  answerQuestion: (questionId: string, answer: string) =>
    call<boolean>('answer_question', { questionId, answer }),
  listActiveRuns: () => call<ActiveRunInfo[]>('list_active_runs'),
  listRuns: (limit?: number) => call<RunRecord[]>('list_runs', { limit: limit ?? null }),
  attachFiles: () => call<AttachmentInfo[]>('attach_files'),

  // Permissions
  listGrants: () => call<Grant[]>('list_grants'),
  listCapabilities: () => call<[string, string][]>('list_capabilities'),
  grantFolder: () => call<Grant | null>('grant_folder'),
  grantCapability: (capability: string) => call<Grant>('grant_capability', { capability }),
  revokeGrant: (id: string) => call<void>('revoke_grant', { id }),

  // File changes
  listChanges: (runId?: string | null, limit?: number) =>
    call<JournalEntry[]>('list_changes', { runId: runId ?? null, limit: limit ?? null }),
  undoRun: (runId: string) => call<UndoReport>('undo_run', { runId }),

  // Memory
  listMemories: () => call<MemoryItem[]>('list_memories'),
  addMemory: (content: string, category?: MemoryCategory | null) =>
    call<MemoryItem>('add_memory', { content, category: category ?? null }),
  updateMemory: (id: string, content: string) => call<void>('update_memory', { id, content }),
  deleteMemory: (id: string) => call<void>('delete_memory', { id }),
  deleteAllMemories: () => call<number>('delete_all_memories'),
  exportMemories: () => call<string | null>('export_memories'),

  // Automations and agents
  listAutomations: () => call<Automation[]>('list_automations'),
  saveAutomation: (id: string | null, input: AutomationInput) =>
    call<Automation>('save_automation', { id, input }),
  deleteAutomation: (id: string) => call<void>('delete_automation', { id }),
  runAutomation: (id: string) => call<void>('run_automation', { id }),
  listAutomationRuns: (id: string) => call<AutomationRun[]>('list_automation_runs', { id }),
  allowableAutomationTools: () => call<string[]>('allowable_automation_tools'),
  listAgents: () => call<AgentDef[]>('list_agents'),
  saveAgent: (agent: AgentDef) => call<string>('save_agent', { agent }),
  deleteAgent: (id: string) => call<void>('delete_agent', { id }),
  listTools: () => call<ToolInfo[]>('list_tools'),

  // Projects
  listProjects: () => call<Project[]>('list_projects'),
  createProject: (name: string, kind: ProjectKind) => call<Project>('create_project', { name, kind }),
  projectFiles: (id: string) => call<FileNode[]>('project_files', { id }),
  readProjectFile: (id: string, path: string) => call<string>('read_project_file', { id, path }),
  writeProjectFile: (id: string, path: string, content: string) =>
    call<void>('write_project_file', { id, path, content }),
  projectHistory: (id: string) => call<Version[]>('project_history', { id }),
  saveProjectVersion: (id: string, message: string) =>
    call<string | null>('save_project_version', { id, message }),
  restoreProjectVersion: (id: string, version: string) =>
    call<string>('restore_project_version', { id, version }),
  revealProject: (id: string) => call<void>('reveal_project', { id }),

  // Audit, logs, windows, updates
  listAudit: (limit?: number, beforeId?: number | null) =>
    call<AuditEntry[]>('list_audit', { limit: limit ?? null, beforeId: beforeId ?? null }),
  openLogs: () => call<void>('open_logs'),
  showMainWindow: () => call<void>('show_main_window'),
  toggleCompactWindow: () => call<void>('toggle_compact_window'),
  checkForUpdates: () => call<string | null>('check_for_updates'),
  installUpdate: () => call<void>('install_update'),

  // Voice: the recording goes to the user's speech-to-text endpoint; Rust attaches the key.
  transcribeAudio: (audioBase64: string, mimeType: string) =>
    call<string>('transcribe_audio', { audioBase64, mimeType }),

  // Plans and licenses
  licenseStatus: () => call<LicenseStatus>('license_status'),
  activateLicense: (licenseKey: string) => call<LicenseStatus>('activate_license', { licenseKey }),
  removeLicense: () => call<LicenseStatus>('remove_license'),
  planUsage: () => call<PlanUsage>('plan_usage'),

  // On-device models. download resolves when finished; progress arrives as 'local-model-progress'.
  localModelsStatus: () => call<LocalStatus>('local_models_status'),
  downloadLocalModel: (id: string) => call<void>('download_local_model', { id }),
  cancelLocalDownload: () => call<void>('cancel_local_download'),
  deleteLocalModel: (id: string) => call<void>('delete_local_model', { id }),
  selectLocalModel: (id: string) => call<void>('select_local_model', { id }),

  /** Open an https link in the default browser. Rust checks the scheme before opening it. */
  openExternal: (url: string) => call<void>('open_external_url', { url }),

  // Integrations
  integrationsStatus: () => call<IntegrationStatus[]>('integrations_status'),
  verifyIntegration: (id: string) => call<string>('verify_integration', { id }),
  disconnectIntegration: (id: string) => call<void>('disconnect_integration', { id }),

  // Ordering apps
  orderingApps: () => call<OrderingApp[]>('ordering_apps'),
  openOrderingApp: (id: string) => call<void>('open_ordering_app', { id }),
  setOrderingAppConnected: (id: string, connected: boolean) =>
    call<void>('set_ordering_app_connected', { id, connected }),
  setOrderingAppPayment: (id: string, label: string) => call<void>('set_ordering_app_payment', { id, label }),
  recentOrders: () => call<RecentOrder[]>('recent_orders'),
  forgetRecentOrder: (id: string) => call<void>('forget_recent_order', { id }),
};

export type Api = typeof api;

// ---- Events -------------------------------------------------------------------------------------

export interface AppEvents {
  'agent-event': AgentEventEnvelope;
  /** Attachments registered by Rust for files dropped on the main window. */
  'files-dropped': AttachmentInfo[];
  'runs-changed': { status: string };
  'settings-changed': null;
  'automations-changed': { id: string };
  'projects-changed': { id: string };
  /** Something privacy-relevant outside a run (e.g. a recording sent for transcription). */
  privacy: { kind: string; detail: string };
  /** Lumo is (or stopped) controlling the mouse and keyboard. */
  'input-control': { active: boolean; stopShortcut: string };
  /** This month's model usage changed (after every model call). */
  'plan-usage-changed': PlanUsage;
  /** Download progress for an on-device model. */
  'local-model-progress': LocalModelProgress;
  /** Sent by the compact window ("Open in Lumo") to the main window. */
  'open-conversation': string;
}

export function on<K extends keyof AppEvents>(
  event: K,
  handler: (payload: AppEvents[K]) => void,
): Promise<UnlistenFn> {
  return listen<AppEvents[K]>(event, (e) => handler(e.payload));
}
