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
  UserMessage,
} from '@/lib/types';

const CONTEXT_WINDOW = 1_000_000;

export type ChatView = 'picker' | 'conversation';

export type Instance = {
  id: string;
  name: string;
  cwd: string | null;
  mode: PermissionMode;
  tab: ChatTab;
  view: ChatView;
  messages: ChatMessage[];
  sessionId: string | null;
  tokensUsed: number;
  streaming: boolean;
  streamingMessageId: string | null;
  compacting: boolean;
  oldestLoadedSeq: number | null;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  pendingQuestion: PendingQuestion | null;
  /**
   * FIFO of user messages typed while the agent was streaming. Drained by
   * useStreamingChat once the active turn finishes — oldest first.
   */
  queuedMessages: QueuedMessage[];
  shellId: string | null;
  shellCwd: string | null;
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
  | { type: 'clearQueue'; id: string };

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
    messages: [],
    sessionId: null,
    tokensUsed: 0,
    streaming: false,
    streamingMessageId: null,
    compacting: false,
    oldestLoadedSeq: null,
    hasMoreOlder: false,
    loadingOlder: false,
    pendingQuestion: null,
    queuedMessages: [],
    shellId: null,
    shellCwd: null,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
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
    case 'patch':
      return {
        ...state,
        instances: state.instances.map((i) =>
          i.id === action.id ? { ...i, ...action.patch } : i,
        ),
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
    default:
      return state;
  }
}

function initial(): State {
  const first = makeInstance(1);
  return { instances: [first], activeId: first.id };
}

type Ctx = {
  instances: Instance[];
  activeId: string;
  active: Instance;
  contextWindow: number;
  addInstance: () => void;
  removeInstance: (id: string) => void;
  setActive: (id: string) => void;
  patch: (id: string, patch: Partial<Instance>) => void;
  appendMessage: (id: string, msg: ChatMessage) => void;
  updateMessage: (id: string, msgId: string, patch: MessagePatch) => void;
  openConversation: (
    id: string,
    conversationId: string,
    page: { messages: ChatMessage[]; oldestSeq: number | null; hasMoreOlder: boolean },
  ) => void;
  openNewConversation: (id: string) => void;
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

  const active = useMemo(
    () => state.instances.find((i) => i.id === state.activeId) ?? state.instances[0],
    [state.instances, state.activeId],
  );

  const addInstance = useCallback(() => dispatch({ type: 'add' }), []);
  const removeInstance = useCallback((id: string) => dispatch({ type: 'remove', id }), []);
  const setActive = useCallback((id: string) => dispatch({ type: 'setActive', id }), []);
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
    ) =>
      dispatch({
        type: 'patch',
        id,
        patch: {
          view: 'conversation',
          sessionId: conversationId,
          messages: page.messages,
          oldestLoadedSeq: page.oldestSeq,
          hasMoreOlder: page.hasMoreOlder,
          loadingOlder: false,
          tokensUsed: 0,
          streaming: false,
          streamingMessageId: null,
          compacting: false,
          pendingQuestion: null,
          queuedMessages: [],
        },
      }),
    [],
  );
  const openNewConversation = useCallback(
    (id: string) =>
      dispatch({
        type: 'patch',
        id,
        patch: {
          view: 'conversation',
          sessionId: null,
          messages: [],
          oldestLoadedSeq: null,
          hasMoreOlder: false,
          loadingOlder: false,
          tokensUsed: 0,
          streaming: false,
          streamingMessageId: null,
          compacting: false,
          pendingQuestion: null,
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
  const backToPicker = useCallback(
    (id: string) =>
      dispatch({
        type: 'patch',
        id,
        patch: {
          view: 'picker',
        },
      }),
    [],
  );

  const value: Ctx = {
    instances: state.instances,
    activeId: state.activeId,
    active,
    contextWindow: CONTEXT_WINDOW,
    addInstance,
    removeInstance,
    setActive,
    patch,
    appendMessage,
    updateMessage,
    openConversation,
    openNewConversation,
    backToPicker,
    prependMessages,
    enqueueMessage,
    removeQueuedMessage,
    clearQueue,
    stateRef,
  };

  return <InstancesContext.Provider value={value}>{children}</InstancesContext.Provider>;
}

export function useInstances() {
  const ctx = useContext(InstancesContext);
  if (!ctx) throw new Error('useInstances must be used inside <InstancesProvider>');
  return ctx;
}
