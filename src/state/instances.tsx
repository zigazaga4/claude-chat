'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type {
  AssistantMessage,
  ChatMessage,
  ChatTab,
  PendingQuestion,
  PermissionMode,
  QueuedMessage,
  RunningTask,
  UserMessage,
} from '@/lib/types';
import {
  discardConversation,
  keepConversation as keepConversationRequest,
} from '@/lib/conversationApi';
import {
  DEFAULT_BACKEND,
  isValidBackend,
  type ChatBackend,
} from '@/lib/backends';
import {
  DEFAULT_MODEL_ID,
  EFFORT_ORDER,
  getContextWindow,
  getDefaultEffort,
  migrateModelId,
  type EffortLevel,
  type ModelId,
} from '@/lib/models';


export type ChatView = 'picker' | 'conversation';

export type Instance = {
  id: string;
  name: string;
  cwd: string | null;
  mode: PermissionMode;
  tab: ChatTab;
  view: ChatView;
  /**
   * The composer's typed-but-unsent text for THIS instance. Lives in instance
   * state (not local component state) so every tab keeps its own draft and it
   * survives switching tabs and full app restarts. Persisted to localStorage.
   */
  draft: string;
  messages: ChatMessage[];
  sessionId: string | null;
  /**
   * Throwaway chat: hidden from every conversation listing and from the
   * workspace's "last conversation", but otherwise an ordinary conversation.
   * It is NOT deleted on navigation or on restart — it survives until the user
   * discards it explicitly, or until the server's long abandonment sweep.
   *
   * Describes the CURRENT `sessionId` — moving the instance to another
   * conversation clears it (see the `patch` reducer case). Persisted, so a
   * throwaway is still a throwaway after the app is closed and reopened.
   */
  ephemeral: boolean;
  tokensUsed: number;
  /**
   * Whether the last API call read from the prompt cache.
   *
   * Only meaningful for credit/token-priced models, where a cache hit bills
   * the conversation at a tenth of fresh input — the single biggest factor in
   * what the next message costs. Transient: a fresh session starts cold and
   * the first call reports the truth.
   */
  cacheWarm: boolean;
  streaming: boolean;
  streamingMessageId: string | null;
  compacting: boolean;
  oldestLoadedSeq: number | null;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  pendingQuestion: PendingQuestion | null;
  /**
   * Background subagents (Agent/Task tool) still running for this instance,
   * keyed by the SDK's task id. These outlive the turn that launched them, so
   * the UI can show "2 agents running" after the model has gone quiet.
   * Transient — never persisted.
   */
  runningTasks: RunningTask[];
  /**
   * FIFO of user messages typed while the agent was streaming. Drained by
   * useStreamingChat once the active turn finishes — oldest first.
   */
  queuedMessages: QueuedMessage[];
  shellId: string | null;
  shellCwd: string | null;
  /**
   * Per-instance model + effort + auto-effort. These travel with the instance
   * (and are persisted), so each tab keeps its own thinking settings and model
   * across switches and restarts — independent of every other instance.
   */
  model: ModelId;
  effort: EffortLevel;
  autoEffort: boolean;
  /**
   * Harness running this conversation. Describes the CURRENT `sessionId`, like
   * `ephemeral` does — once a conversation exists the server enforces whatever
   * was stored against it, and this is only a display of that. It is a live
   * choice solely while `sessionId` is null.
   */
  backend: ChatBackend;
};

type State = {
  instances: Instance[];
  activeId: string;
};

type MessagePatch = Partial<UserMessage> | Partial<AssistantMessage>;

type Action =
  | { type: 'add' }
  | { type: 'remove'; id: string }
  | { type: 'setActive'; id: string }
  | { type: 'reorder'; id: string; toIndex: number }
  | { type: 'hydrate'; state: State }
  | { type: 'patch'; id: string; patch: Partial<Instance> }
  | { type: 'appendMessage'; id: string; msg: ChatMessage }
  | { type: 'updateMessage'; id: string; msgId: string; patch: MessagePatch }
  | {
      type: 'prependMessages';
      id: string;
      messages: ChatMessage[];
      oldestSeq: number | null;
      hasMoreOlder: boolean;
    }
  | { type: 'enqueueMessage'; id: string; msg: QueuedMessage }
  | { type: 'removeQueuedMessage'; id: string; msgId: string }
  | { type: 'clearQueue'; id: string }
  | { type: 'taskStarted'; id: string; task: RunningTask }
  | { type: 'taskProgress'; id: string; taskId: string; lastToolName: string | null }
  | { type: 'taskFinished'; id: string; taskId: string }
  | { type: 'taskUpdated'; id: string; taskId: string; isBackgrounded: boolean }
  | { type: 'clearTasks'; id: string }
  | { type: 'settleMessages'; id: string };

function newId() {
  return `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeInstance(seq: number): Instance {
  return {
    id: newId(),
    name: `Instance ${seq}`,
    cwd: null,
    mode: 'bypassPermissions',
    tab: 'chat',
    view: 'picker',
    draft: '',
    messages: [],
    sessionId: null,
    ephemeral: false,
    tokensUsed: 0,
    cacheWarm: false,
    streaming: false,
    streamingMessageId: null,
    compacting: false,
    oldestLoadedSeq: null,
    hasMoreOlder: false,
    loadingOlder: false,
    pendingQuestion: null,
    runningTasks: [],
    queuedMessages: [],
    shellId: null,
    shellCwd: null,
    // New instances start on the default model + its default effort. Each
    // instance is then independent — switching model/effort in one tab does
    // not touch any other.
    model: DEFAULT_MODEL_ID,
    effort: getDefaultEffort(DEFAULT_MODEL_ID),
    autoEffort: false,
    // The Agent SDK is the conservative default: it can serve every model,
    // whereas OpenCode cannot run Claude. Choosing it is an explicit act.
    backend: DEFAULT_BACKEND,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'hydrate':
      // Wholesale swap-in of the persisted instance set on mount. The incoming
      // state is already reconstructed with safe defaults for every transient
      // field, so we adopt it verbatim.
      return action.state;
    case 'add': {
      const seq = state.instances.length + 1;
      const inst = makeInstance(seq);
      return { instances: [...state.instances, inst], activeId: inst.id };
    }
    case 'remove': {
      const idx = state.instances.findIndex((i) => i.id === action.id);
      if (idx < 0) return state;
      const next = state.instances.filter((i) => i.id !== action.id);
      if (next.length === 0) {
        const fresh = makeInstance(1);
        return { instances: [fresh], activeId: fresh.id };
      }
      let activeId = state.activeId;
      if (activeId === action.id) {
        const neighbor = next[Math.min(idx, next.length - 1)];
        activeId = neighbor.id;
      }
      return { instances: next, activeId };
    }
    case 'setActive':
      return state.instances.some((i) => i.id === action.id)
        ? { ...state, activeId: action.id }
        : state;
    case 'reorder': {
      // Tab drag-and-drop. Only the order of the array changes — the instance
      // objects are reused by reference, so a live stream writing into one is
      // unaffected by a reorder happening around it.
      const from = state.instances.findIndex((i) => i.id === action.id);
      if (from < 0) return state;
      const to = Math.max(0, Math.min(state.instances.length - 1, action.toIndex));
      if (from === to) return state;
      const next = [...state.instances];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...state, instances: next };
    }
    case 'patch':
      return {
        ...state,
        instances: state.instances.map((i) => {
          if (i.id !== action.id) return i;
          const next: Instance = { ...i, ...action.patch };
          // `ephemeral` belongs to the session the instance is on. Any patch
          // that moves it OFF a session it already had (folder switch, "new
          // chat" from the sidebar) drops the flag unless it says otherwise,
          // so a throwaway can never leak onto the next conversation. First
          // assignment (null → id, when the SDK hands back the session id)
          // is not a move and keeps the flag.
          if (
            'sessionId' in action.patch &&
            !('ephemeral' in action.patch) &&
            i.sessionId != null &&
            action.patch.sessionId !== i.sessionId
          ) {
            next.ephemeral = false;
          }
          // `backend` belongs to the session too, and for the same reason:
          // carrying the previous conversation's engine onto the next one
          // would mislabel it. Callers that know the real value (opening a
          // stored conversation) pass it in the same patch.
          if (
            'sessionId' in action.patch &&
            !('backend' in action.patch) &&
            i.sessionId != null &&
            action.patch.sessionId !== i.sessionId
          ) {
            next.backend = DEFAULT_BACKEND;
          }
          return next;
        }),
      };
    case 'appendMessage':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id ? { ...i, messages: [...i.messages, action.msg] } : i,
        ),
      };
    case 'updateMessage':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id
            ? {
                ...i,
                messages: i.messages.map((m) =>
                  m.id === action.msgId
                    ? ({ ...m, ...action.patch } as ChatMessage)
                    : m,
                ),
              }
            : i,
        ),
      };
    case 'prependMessages':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id
            ? {
                ...i,
                messages: [...action.messages, ...i.messages],
                oldestLoadedSeq: action.oldestSeq ?? i.oldestLoadedSeq,
                hasMoreOlder: action.hasMoreOlder,
              }
            : i,
        ),
      };
    case 'enqueueMessage':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id
            ? { ...i, queuedMessages: [...i.queuedMessages, action.msg] }
            : i,
        ),
      };
    case 'removeQueuedMessage':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id
            ? {
                ...i,
                queuedMessages: i.queuedMessages.filter(
                  (q) => q.id !== action.msgId,
                ),
              }
            : i,
        ),
      };
    case 'clearQueue':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id ? { ...i, queuedMessages: [] } : i,
        ),
      };
    case 'taskStarted':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id
            ? {
                ...i,
                // Re-launching the same id replaces rather than duplicates.
                runningTasks: [
                  ...i.runningTasks.filter((t) => t.taskId !== action.task.taskId),
                  action.task,
                ],
              }
            : i,
        ),
      };
    case 'taskUpdated':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id
            ? {
                ...i,
                runningTasks: i.runningTasks.map((t) =>
                  t.taskId === action.taskId
                    ? { ...t, isBackgrounded: action.isBackgrounded }
                    : t,
                ),
              }
            : i,
        ),
      };
    case 'taskProgress':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id
            ? {
                ...i,
                runningTasks: i.runningTasks.map((t) =>
                  t.taskId === action.taskId
                    ? { ...t, lastToolName: action.lastToolName }
                    : t,
                ),
              }
            : i,
        ),
      };
    case 'taskFinished':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id
            ? {
                ...i,
                runningTasks: i.runningTasks.filter(
                  (t) => t.taskId !== action.taskId,
                ),
              }
            : i,
        ),
      };
    case 'clearTasks':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id && i.runningTasks.length > 0
            ? { ...i, runningTasks: [] }
            : i,
        ),
      };
    case 'settleMessages':
      return {
        ...state,
        instances: state.instances.map((i) => {
          if (i.id !== action.id) return i;
          // Only rebuild what actually still claims to be live — a no-op
          // sweep must not hand React a new array for every finished stream.
          let touched = false;
          const messages = i.messages.map((m) => {
            if (m.role !== 'assistant') return m;
            const staleBlocks = m.blocks.some(
              (b) =>
                (b.type === 'text' ||
                  b.type === 'thinking' ||
                  b.type === 'tool_use') &&
                b.streaming,
            );
            if (!m.streaming && !staleBlocks) return m;
            touched = true;
            return {
              ...m,
              streaming: false,
              blocks: staleBlocks
                ? m.blocks.map((b) =>
                    (b.type === 'text' ||
                      b.type === 'thinking' ||
                      b.type === 'tool_use') &&
                    b.streaming
                      ? { ...b, streaming: false }
                      : b,
                  )
                : m.blocks,
            };
          });
          return touched ? { ...i, messages } : i;
        }),
      };
    default:
      return state;
  }
}

function initial(): State {
  const first = makeInstance(1);
  return { instances: [first], activeId: first.id };
}

// ───────────────────────── persistence (localStorage) ──────────────────────
//
// Only the durable, cheap-to-store slice of each instance is written: the
// identity, which folder/conversation it points at, its mode/tab/view and the
// unsent draft. Everything else (messages, streaming flags, queues, shell ids)
// is transient and re-derived on load — messages are re-fetched from the
// server DB when a restored conversation instance becomes active, so we never
// blow the storage quota by persisting full histories or image data URLs.

const PERSIST_KEY = 'claude-chat:instances';
const PERSIST_VERSION = 1;

type PersistedInstance = {
  id: string;
  name: string;
  cwd: string | null;
  mode: PermissionMode;
  tab: ChatTab;
  view: ChatView;
  sessionId: string | null;
  draft: string;
  model?: string;
  effort?: string;
  autoEffort?: boolean;
  /**
   * Persisted so a restored tab still knows its conversation is a throwaway —
   * otherwise it would come back as a normal chat that no listing shows.
   */
  ephemeral?: boolean;
  /**
   * Persisted so a restored tab shows the right engine immediately, without
   * waiting on a round-trip. Absent on pre-upgrade entries, which correctly
   * fall back to the Agent SDK — that is what every conversation predating
   * this field ran on.
   */
  backend?: string;
};

type PersistedShape = {
  v: number;
  activeId: string;
  instances: PersistedInstance[];
};

function coerceView(v: unknown): ChatView {
  return v === 'conversation' ? 'conversation' : 'picker';
}

function coerceTab(t: unknown): ChatTab {
  return t === 'shell' || t === 'files' ? t : 'chat';
}

const VALID_MODES: PermissionMode[] = [
  'default',
  'auto',
  'acceptEdits',
  'bypassPermissions',
];

function coerceMode(m: unknown): PermissionMode {
  return typeof m === 'string' && (VALID_MODES as string[]).includes(m)
    ? (m as PermissionMode)
    : 'bypassPermissions';
}

/**
 * Coerce a persisted model id, carrying retired ids to their successor and
 * falling back to the default only when it is genuinely unrecognised.
 */
function coerceModel(m: unknown): ModelId {
  if (typeof m !== 'string') return DEFAULT_MODEL_ID;
  return migrateModelId(m) ?? DEFAULT_MODEL_ID;
}

/** Coerce a persisted effort, falling back to the model's default when unknown. */
function coerceEffort(e: unknown, model: ModelId): EffortLevel {
  return typeof e === 'string' && (EFFORT_ORDER as string[]).includes(e)
    ? (e as EffortLevel)
    : getDefaultEffort(model);
}

/** Rebuild a full in-memory Instance from its persisted slice + fresh defaults. */
function hydrateInstance(p: PersistedInstance): Instance {
  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name : 'Instance',
    cwd: typeof p.cwd === 'string' ? p.cwd : null,
    mode: coerceMode(p.mode),
    tab: coerceTab(p.tab),
    view: coerceView(p.view),
    draft: typeof p.draft === 'string' ? p.draft : '',
    messages: [],
    sessionId: typeof p.sessionId === 'string' ? p.sessionId : null,
    ephemeral: p.ephemeral === true,
    backend: isValidBackend(p.backend) ? p.backend : DEFAULT_BACKEND,
    tokensUsed: 0,
    cacheWarm: false,
    streaming: false,
    streamingMessageId: null,
    compacting: false,
    oldestLoadedSeq: null,
    hasMoreOlder: false,
    loadingOlder: false,
    pendingQuestion: null,
    runningTasks: [],
    queuedMessages: [],
    shellId: null,
    shellCwd: null,
    // Per-instance thinking settings (persisted). Effort is coerced against
    // the resolved model so a restored tab lands on a valid pair; pre-upgrade
    // values (absent here) fall back to the defaults.
    ...(() => {
      const model = coerceModel(p.model);
      return {
        model,
        effort: coerceEffort(p.effort, model),
        autoEffort: p.autoEffort === true,
      };
    })(),
  };
}

/** Read + validate the persisted instance set. Returns null when absent/garbage. */
function loadPersisted(): State | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedShape;
    if (!parsed || parsed.v !== PERSIST_VERSION || !Array.isArray(parsed.instances)) {
      return null;
    }
    const instances = parsed.instances
      .filter((p): p is PersistedInstance => !!p && typeof p.id === 'string')
      .map(hydrateInstance);
    if (instances.length === 0) return null;
    const activeId = instances.some((i) => i.id === parsed.activeId)
      ? parsed.activeId
      : instances[0].id;
    return { instances, activeId };
  } catch {
    return null;
  }
}

function toPersisted(state: State): PersistedShape {
  return {
    v: PERSIST_VERSION,
    activeId: state.activeId,
    instances: state.instances.map((i) => ({
      id: i.id,
      name: i.name,
      cwd: i.cwd,
      mode: i.mode,
      tab: i.tab,
      view: i.view,
      sessionId: i.sessionId,
      draft: i.draft,
      ephemeral: i.ephemeral,
      backend: i.backend,
      model: i.model,
      effort: i.effort,
      autoEffort: i.autoEffort,
    })),
  };
}

function savePersisted(state: State): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PERSIST_KEY, JSON.stringify(toPersisted(state)));
  } catch {
    /* quota exceeded or storage unavailable — nothing we can do, drop it */
  }
}

type Ctx = {
  instances: Instance[];
  activeId: string;
  active: Instance;
  contextWindow: number;
  addInstance: () => void;
  removeInstance: (id: string) => void;
  setActive: (id: string) => void;
  /** Move an instance to a new position in the tab strip. */
  reorderInstance: (id: string, toIndex: number) => void;
  patch: (id: string, patch: Partial<Instance>) => void;
  appendMessage: (id: string, msg: ChatMessage) => void;
  updateMessage: (id: string, msgId: string, patch: MessagePatch) => void;
  openConversation: (
    id: string,
    conversationId: string,
    page: { messages: ChatMessage[]; oldestSeq: number | null; hasMoreOlder: boolean },
    /** Engine stored against the conversation. Defaults to the Agent SDK. */
    backend?: ChatBackend,
  ) => void;
  /**
   * Start a fresh conversation in this instance. `ephemeral: true` makes it a
   * throwaway — hidden from every listing and deleted as soon as the instance
   * moves on (see the reaper in the provider).
   */
  openNewConversation: (
    id: string,
    opts?: { ephemeral?: boolean; backend?: ChatBackend },
  ) => void;
  /** Drop a throwaway now and go back to the picker. */
  discardThrowaway: (id: string) => void;
  /** Promote the instance's throwaway into a normal, saved conversation. */
  keepThrowaway: (id: string) => void;
  backToPicker: (id: string) => void;
  prependMessages: (
    id: string,
    messages: ChatMessage[],
    oldestSeq: number | null,
    hasMoreOlder: boolean,
  ) => void;
  enqueueMessage: (id: string, msg: QueuedMessage) => void;
  removeQueuedMessage: (id: string, msgId: string) => void;
  clearQueue: (id: string) => void;
  /** Background subagent lifecycle — see Instance.runningTasks. */
  taskStarted: (id: string, task: RunningTask) => void;
  taskProgress: (id: string, taskId: string, lastToolName: string | null) => void;
  /** Flip a task between foreground and background (Ctrl+B / auto-background). */
  taskUpdated: (id: string, taskId: string, isBackgrounded: boolean) => void;
  taskFinished: (id: string, taskId: string) => void;
  /**
   * Drop every tracked task at once. Called when a stream ends: `task_finished`
   * only ever arrives over that stream, so anything still open at teardown can
   * never be resolved and would otherwise show as running forever.
   */
  clearTasks: (id: string) => void;
  /**
   * Clear every leftover `streaming` flag on this instance's messages and
   * their blocks. The stream is the only thing that can ever turn those off,
   * so once it is gone anything still set is stranded — it renders as a
   * blinking caret or a "Working..." spinner that waits for tokens which will
   * never arrive. Called at teardown so that state cannot outlive its stream.
   */
  settleMessages: (id: string) => void;
  /** Mutable ref pointing at latest state — useful for callbacks that should read fresh state. */
  stateRef: { current: State };
};

const InstancesContext = createContext<Ctx | null>(null);

export function InstancesProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initial);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Adopt the persisted instance set on mount. Mirrors the SSR-safe pattern in
  // useModelPreference: the server render and the first client render both use
  // the default single instance (so hydration matches), then this effect swaps
  // in whatever was saved. `hydratedRef` gates the writer below so the initial
  // default render can't clobber storage before we've read it.
  const hydratedRef = useRef(false);
  useEffect(() => {
    const persisted = loadPersisted();
    // External-store adoption on mount (same shape as useModelPreference).
    if (persisted) dispatch({ type: 'hydrate', state: persisted });
    hydratedRef.current = true;
  }, []);

  // Persist the durable slice whenever state changes (debounced). The debounce
  // also protects the hydrate race: the fresh-default write scheduled on mount
  // is cancelled by this effect's cleanup as soon as the hydrate dispatch lands.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const t = setTimeout(() => savePersisted(state), 250);
    return () => clearTimeout(t);
  }, [state]);

  const active = useMemo(
    () => state.instances.find((i) => i.id === state.activeId) ?? state.instances[0],
    [state.instances, state.activeId],
  );

  const addInstance = useCallback(() => dispatch({ type: 'add' }), []);
  const removeInstance = useCallback((id: string) => dispatch({ type: 'remove', id }), []);
  const setActive = useCallback((id: string) => dispatch({ type: 'setActive', id }), []);
  const reorderInstance = useCallback(
    (id: string, toIndex: number) => dispatch({ type: 'reorder', id, toIndex }),
    [],
  );
  const patch = useCallback(
    (id: string, p: Partial<Instance>) => dispatch({ type: 'patch', id, patch: p }),
    [],
  );
  const appendMessage = useCallback(
    (id: string, msg: ChatMessage) => dispatch({ type: 'appendMessage', id, msg }),
    [],
  );
  const updateMessage = useCallback(
    (id: string, msgId: string, p: MessagePatch) =>
      dispatch({ type: 'updateMessage', id, msgId, patch: p }),
    [],
  );
  const openConversation = useCallback(
    (
      id: string,
      conversationId: string,
      page: { messages: ChatMessage[]; oldestSeq: number | null; hasMoreOlder: boolean },
      backend?: ChatBackend,
    ) =>
      dispatch({
        type: 'patch',
        id,
        patch: {
          view: 'conversation',
          sessionId: conversationId,
          // Anything opened from a listing is a saved conversation by
          // definition — throwaways are never listed.
          ephemeral: false,
          // Comes from the stored conversation. The server enforces the same
          // value regardless, so this only keeps the UI honest about which
          // engine the user is talking to. Omitted when the caller is merely
          // re-hydrating the session it is already on — the instance already
          // holds the right value and overwriting it would be a downgrade.
          ...(backend ? { backend } : {}),
          messages: page.messages,
          oldestLoadedSeq: page.oldestSeq,
          hasMoreOlder: page.hasMoreOlder,
          loadingOlder: false,
          tokensUsed: 0,
          cacheWarm: false,
          streaming: false,
          streamingMessageId: null,
          compacting: false,
          pendingQuestion: null,
          runningTasks: [],
          queuedMessages: [],
        },
      }),
    [],
  );
  const openNewConversation = useCallback(
    (id: string, opts?: { ephemeral?: boolean; backend?: ChatBackend }) =>
      dispatch({
        type: 'patch',
        id,
        patch: {
          view: 'conversation',
          sessionId: null,
          ephemeral: opts?.ephemeral === true,
          // The one moment the engine is actually a choice: no session exists
          // yet, so nothing is pinned. It freezes on the first turn.
          backend: opts?.backend ?? DEFAULT_BACKEND,
          messages: [],
          oldestLoadedSeq: null,
          hasMoreOlder: false,
          loadingOlder: false,
          tokensUsed: 0,
          cacheWarm: false,
          streaming: false,
          streamingMessageId: null,
          compacting: false,
          pendingQuestion: null,
          runningTasks: [],
          queuedMessages: [],
        },
      }),
    [],
  );
  const prependMessages = useCallback(
    (
      id: string,
      messages: ChatMessage[],
      oldestSeq: number | null,
      hasMoreOlder: boolean,
    ) => dispatch({ type: 'prependMessages', id, messages, oldestSeq, hasMoreOlder }),
    [],
  );
  const enqueueMessage = useCallback(
    (id: string, msg: QueuedMessage) =>
      dispatch({ type: 'enqueueMessage', id, msg }),
    [],
  );
  const removeQueuedMessage = useCallback(
    (id: string, msgId: string) =>
      dispatch({ type: 'removeQueuedMessage', id, msgId }),
    [],
  );
  const clearQueue = useCallback(
    (id: string) => dispatch({ type: 'clearQueue', id }),
    [],
  );
  const taskStarted = useCallback(
    (id: string, task: RunningTask) => dispatch({ type: 'taskStarted', id, task }),
    [],
  );
  const taskUpdated = useCallback(
    (id: string, taskId: string, isBackgrounded: boolean) =>
      dispatch({ type: 'taskUpdated', id, taskId, isBackgrounded }),
    [],
  );
  const taskProgress = useCallback(
    (id: string, taskId: string, lastToolName: string | null) =>
      dispatch({ type: 'taskProgress', id, taskId, lastToolName }),
    [],
  );
  const taskFinished = useCallback(
    (id: string, taskId: string) => dispatch({ type: 'taskFinished', id, taskId }),
    [],
  );
  const clearTasks = useCallback(
    (id: string) => dispatch({ type: 'clearTasks', id }),
    [],
  );
  const settleMessages = useCallback(
    (id: string) => dispatch({ type: 'settleMessages', id }),
    [],
  );
  // Discard is pure state: dropping the session id is what makes the reaper
  // below delete the conversation, so there's exactly one code path that ever
  // issues the DELETE — no matter how the user leaves.
  const discardThrowaway = useCallback((id: string) => {
    const inst = stateRef.current.instances.find((i) => i.id === id);
    // Actually delete it. This used to be handled by the reaper watching for
    // an unreferenced throwaway; now that leaving one keeps it, Discard is the
    // only thing that removes it and has to do the deletion itself.
    if (inst?.ephemeral && inst.sessionId) void discardConversation(inst.sessionId);
    dispatch({
      type: 'patch',
      id,
      patch: {
        view: 'picker',
        sessionId: null,
        ephemeral: false,
        messages: [],
        oldestLoadedSeq: null,
        hasMoreOlder: false,
        loadingOlder: false,
        tokensUsed: 0,
        cacheWarm: false,
        streaming: false,
        streamingMessageId: null,
        compacting: false,
        pendingQuestion: null,
        runningTasks: [],
        queuedMessages: [],
      },
    });
  }, []);
  const keepThrowaway = useCallback((id: string) => {
    const inst = stateRef.current.instances.find((i) => i.id === id);
    if (!inst?.ephemeral) return;
    // Clear the flag server-side first so a reap racing this can't win, then
    // locally so the instance stops sending `ephemeral` on later turns.
    if (inst.sessionId) void keepConversationRequest(inst.sessionId);
    dispatch({ type: 'patch', id, patch: { ephemeral: false } });
  }, []);
  const backToPicker = useCallback((id: string) => {
    // Leaving a throwaway no longer destroys it. A throwaway means "keep this
    // out of my saved conversations", not "delete this the moment I look
    // away" — losing the thread by navigating out of it, or by restarting the
    // app, made the feature unusable for anything that took more than one
    // sitting. Discarding is now only ever explicit, via the banner.
    dispatch({ type: 'patch', id, patch: { view: 'picker' } });
  }, []);

  /*
   * There is deliberately no throwaway reaper here any more.
   *
   * It used to delete a throwaway the instant no instance pointed at it, which
   * fired on every ordinary navigation — switching the tab to another
   * conversation, closing the tab, or simply reloading before the persisted
   * state had rehydrated. The result was that a throwaway could not survive a
   * restart at all, and in practice none ever did: the database held 168
   * conversations and zero throwaways.
   *
   * A throwaway is now durable and simply hidden from the saved lists. It goes
   * away when the user says so (the banner's Discard), and the server sweeps
   * genuinely abandoned ones on a long timer as a backstop.
   */

  const value: Ctx = {
    instances: state.instances,
    activeId: state.activeId,
    active,
    // Follows the ACTIVE instance's model rather than a flat constant: the
    // gauge is a fullness reading, and measuring GLM's 204,800-token window
    // against 1M drew it at a fifth of the truth with no warning before the
    // context actually ran out.
    contextWindow: getContextWindow(active.model),
    addInstance,
    removeInstance,
    setActive,
    reorderInstance,
    patch,
    appendMessage,
    updateMessage,
    openConversation,
    openNewConversation,
    discardThrowaway,
    keepThrowaway,
    backToPicker,
    prependMessages,
    enqueueMessage,
    removeQueuedMessage,
    clearQueue,
    taskStarted,
    taskProgress,
    taskUpdated,
    taskFinished,
    clearTasks,
    settleMessages,
    stateRef,
  };

  return <InstancesContext.Provider value={value}>{children}</InstancesContext.Provider>;
}

export function useInstances() {
  const ctx = useContext(InstancesContext);
  if (!ctx) throw new Error('useInstances must be used inside <InstancesProvider>');
  return ctx;
}
