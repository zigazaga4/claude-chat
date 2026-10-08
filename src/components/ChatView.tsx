'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Ghost, Loader2, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { forkConversation, notifyConversationsChanged } from '@/lib/conversationApi';
import type {
  AssistantMessage,
  ChatMessage,
  CompactBoundaryBlock,
  ContentBlock,
  SystemMessage,
  UserMessage,
} from '@/lib/types';
import { MODELS, getDefaultEffort } from '@/lib/models';
import { modelsForBackend, supportsBackend } from '@/lib/backends';
import { useInstances } from '@/state/instances';
import { useEffortSuggestion } from '@/hooks/useEffortSuggestion';
import { useStreamingChat } from '@/hooks/useStreamingChat';
import CompactBoundaryDivider from './CompactBoundaryDivider';
import Composer from './Composer';
import { CloudGlyph } from './Logo';
import ConversationPicker from './ConversationPicker';
import Markdown from './Markdown';
import RefusalBlockView from './RefusalBlockView';
import { StreamingTextView, ThinkingBlockView } from './MessageBlocks';
import { ToolUseBlockView } from './tools';
import { LatestToolProvider } from './tools/LatestToolContext';

export default function ChatView() {
  const {
    active,
    contextWindow,
    patch,
    prependMessages,
    openConversation,
    openNewConversation,
    discardThrowaway,
    keepThrowaway,
    stateRef,
  } = useInstances();
  // Model + thinking settings are per-instance now: each tab remembers its own
  // picks. The pickers below read/write the active instance via `patch`.
  const { model, effort, autoEffort } = active;
  const { suggest } = useEffortSuggestion();
  const { send, queue, unqueue, abort, compact, submitAnswer } = useStreamingChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottom = useRef(true);
  const isPrepending = useRef(false);
  const prevScrollHeight = useRef(0);
  // Guards the one-shot message re-fetch for a restored conversation instance,
  // keyed by `${instanceId}:${sessionId}` so each restored tab loads once.
  const rehydratedRef = useRef<Set<string>>(new Set());

  // When an instance is restored from localStorage it comes back pointing at a
  // conversation (view + sessionId) but with no messages — those aren't
  // persisted. The first time such an instance becomes active, re-fetch its
  // history from the server DB. If the conversation is gone, fall back to the
  // picker so the tab stays usable.
  useEffect(() => {
    if (
      active.view !== 'conversation' ||
      !active.sessionId ||
      !active.cwd ||
      active.messages.length > 0 ||
      active.streaming ||
      active.loadingOlder
    ) {
      return;
    }
    const sessionId = active.sessionId;
    const cwd = active.cwd;
    const instanceId = active.id;
    const key = `${instanceId}:${sessionId}`;
    if (rehydratedRef.current.has(key)) return;
    rehydratedRef.current.add(key);
    let cancelled = false;
    void (async () => {
      try {
        const url =
          `/api/conversations/${encodeURIComponent(sessionId)}/messages` +
          `?cwd=${encodeURIComponent(cwd)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          messages: ChatMessage[];
          oldestSeq: number | null;
          hasMoreOlder: boolean;
        };
        if (cancelled) return;
        openConversation(instanceId, sessionId, {
          messages: data.messages,
          oldestSeq: data.oldestSeq,
          hasMoreOlder: data.hasMoreOlder,
        });
      } catch {
        if (cancelled) return;
        patch(instanceId, { view: 'picker', sessionId: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    active.id,
    active.view,
    active.sessionId,
    active.cwd,
    active.messages.length,
    active.streaming,
    active.loadingOlder,
    openConversation,
    patch,
  ]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      wasNearBottom.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isPrepending.current) {
      el.scrollTop += el.scrollHeight - prevScrollHeight.current;
      isPrepending.current = false;
      return;
    }
    if (wasNearBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [active.messages.length, active.streamingMessageId]);

  const loadOlder = useCallback(async () => {
    if (
      !active.cwd ||
      !active.sessionId ||
      !active.hasMoreOlder ||
      active.loadingOlder ||
      active.oldestLoadedSeq == null
    ) {
      return;
    }
    const el = scrollRef.current;
    if (el) prevScrollHeight.current = el.scrollHeight;
    isPrepending.current = true;
    patch(active.id, { loadingOlder: true });
    try {
      const url =
        `/api/conversations/${encodeURIComponent(active.sessionId)}/messages` +
        `?cwd=${encodeURIComponent(active.cwd)}` +
        `&limit=37&beforeSeq=${active.oldestLoadedSeq}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('failed');
      const data = (await res.json()) as {
        messages: ChatMessage[];
        oldestSeq: number | null;
        hasMoreOlder: boolean;
      };
      if (data.messages.length === 0) {
        isPrepending.current = false;
        patch(active.id, { hasMoreOlder: false, loadingOlder: false });
        return;
      }
      prependMessages(active.id, data.messages, data.oldestSeq, data.hasMoreOlder);
    } catch {
      isPrepending.current = false;
    } finally {
      patch(active.id, { loadingOlder: false });
    }
  }, [
    active.id,
    active.cwd,
    active.sessionId,
    active.hasMoreOlder,
    active.loadingOlder,
    active.oldestLoadedSeq,
    patch,
    prependMessages,
  ]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 200 && active.hasMoreOlder && !active.loadingOlder) {
        void loadOlder();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [active.hasMoreOlder, active.loadingOlder, loadOlder]);

  // The queue UI is for messages that haven't been promoted into the chat
  // yet. Since `queue()` now lands the user bubble in the canvas immediately
  // (so the user sees it during the function-call loop, not after), the
  // matching queue entry would otherwise show as a duplicate down at the
  // composer until `turn_started` clears it. Filtering by id collapses the
  // two views into one — canvas wins.
  const visibleQueue = useMemo(
    () =>
      active.queuedMessages.filter(
        (q) => !active.messages.some((m) => m.id === q.userMessageId),
      ),
    [active.queuedMessages, active.messages],
  );

  // ===== Rewind to here =====
  // Which messages get the button. Stored messages carry the server's verdict;
  // ones created live during a stream have none and count as rewindable once
  // the stream is over — except a live user message right after a stored
  // answer that can't be forked at, since its fork point would be that answer.
  // Nothing is offered mid-stream: the turn being written is not forkable yet.
  const rewindableIds = useMemo(() => {
    const ids = new Set<string>();
    if (active.backend !== 'sdk' || !active.sessionId || active.streaming) return ids;
    let prevAssistantOk: boolean | null = null;
    for (const m of active.messages) {
      if (m.role === 'assistant') {
        const ok = m.rewindable ?? true;
        if (ok) ids.add(m.id);
        prevAssistantOk = ok;
      } else if (m.role === 'user') {
        if (m.rewindable ?? prevAssistantOk ?? true) ids.add(m.id);
      }
    }
    return ids;
  }, [active.backend, active.sessionId, active.streaming, active.messages]);

  /** The rewind in flight or the one that just failed, for one conversation. */
  const [rewind, setRewind] = useState<{
    sessionId: string;
    messageId: string;
    pending: boolean;
    error: string | null;
  } | null>(null);
  const rewindBusyRef = useRef(false);

  const onRewind = useCallback(
    async (messageId: string) => {
      const instanceId = active.id;
      const sessionId = active.sessionId;
      if (!sessionId || rewindBusyRef.current) return;
      rewindBusyRef.current = true;
      setRewind({ sessionId, messageId, pending: true, error: null });
      try {
        const result = await forkConversation(sessionId, messageId);
        // The copy exists whatever happens next, so the sidebar should list it.
        if (result.conversationId) notifyConversationsChanged(result.cwd);
        let page: { messages: ChatMessage[]; oldestSeq: number | null; hasMoreOlder: boolean } | null =
          null;
        if (result.conversationId) {
          const res = await fetch(
            `/api/conversations/${encodeURIComponent(result.conversationId)}/messages` +
              `?cwd=${encodeURIComponent(result.cwd)}`,
          );
          if (!res.ok) {
            throw new Error(
              `The copy was made and is in the folder's list, but could not be opened (HTTP ${res.status}).`,
            );
          }
          page = (await res.json()) as typeof page;
        }
        setRewind(null);
        // Only take the tab over if it is still where the user clicked. If
        // they moved on while the copy was being made, it stays in the list.
        const inst = stateRef.current.instances.find((i) => i.id === instanceId);
        if (!inst || inst.sessionId !== sessionId || inst.view !== 'conversation') return;
        // Land at the end of the copy — that is where the user carries on.
        wasNearBottom.current = true;
        patch(instanceId, { cwd: result.cwd });
        if (result.conversationId && page) {
          openConversation(instanceId, result.conversationId, page, result.backend);
        } else {
          // Rewinding the first message: nothing to copy, just start over.
          openNewConversation(instanceId, { backend: result.backend });
        }
        if (result.prefill != null) patch(instanceId, { draft: result.prefill });
      } catch (e) {
        setRewind({
          sessionId,
          messageId,
          pending: false,
          error: e instanceof Error ? e.message : 'The conversation could not be rewound.',
        });
      } finally {
        rewindBusyRef.current = false;
      }
    },
    [active.id, active.sessionId, openConversation, openNewConversation, patch, stateRef],
  );

  const rewindHere = rewind && rewind.sessionId === active.sessionId ? rewind : null;
  const rewindBusy = rewindHere?.pending === true;

  if (!active.cwd) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground">
        {/* The left panel does not exist below `md` — it lives behind the
            menu button — so the instruction has to change with the layout. */}
        <span className="md:hidden">
          Tap the menu at the top left to pick a folder and start a chat.
        </span>
        <span className="hidden md:inline">
          Select a folder in the left panel to start a chat.
        </span>
      </div>
    );
  }

  if (active.view === 'picker') {
    return (
      <div className="scrollbar-thin h-full overflow-y-auto">
        <ConversationPicker />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {active.ephemeral && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-400/25 bg-amber-500/[0.07] px-4 py-1.5 text-[11px] sm:px-8">
          <Ghost className="h-3.5 w-3.5 shrink-0 text-amber-300" />
          <span className="shrink-0 font-semibold tracking-tight text-amber-200">
            Throwaway chat
          </span>
          <span className="hidden truncate text-muted-foreground sm:inline">
            — kept out of your conversation list, and kept until you discard it
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => keepThrowaway(active.id)}
              title="Save this chat and show it in the conversation list"
              className="rounded-md border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-200 transition-colors hover:bg-emerald-500/20"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={() => {
                // "Forget it" mid-reply is a real intent — stop the turn first
                // so nothing keeps writing into a conversation we're deleting.
                if (active.streaming) abort();
                discardThrowaway(active.id);
              }}
              title="Delete this chat now and go back"
              className="inline-flex items-center gap-1 rounded-md border border-red-400/40 bg-red-500/10 px-2 py-0.5 font-medium text-red-200 transition-colors hover:bg-red-500/20"
            >
              <Trash2 className="h-3 w-3" />
              Discard
            </button>
          </div>
        </div>
      )}
      <div
        ref={scrollRef}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {active.loadingOlder && (
            <div className="flex items-center justify-center py-2 text-[11px] text-muted-foreground">
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              Loading older messages...
            </div>
          )}
          {active.messages.length === 0 ? (
            <div className="mt-24 flex flex-col items-center gap-3 text-center">
              <div className="flex items-center gap-2.5 text-3xl font-semibold tracking-tight text-primary">
                <CloudGlyph className="h-7 w-7" />
                <span>claude chat</span>
              </div>
              <div className="mt-4 text-xs text-muted-foreground/60">
                Start the conversation below.
              </div>
            </div>
          ) : (
            <LatestToolProvider messages={active.messages}>
              {active.messages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  canRewind={rewindableIds.has(m.id)}
                  rewindPending={rewindHere?.messageId === m.id && rewindHere.pending}
                  rewindError={rewindHere?.messageId === m.id ? rewindHere.error : null}
                  rewindBusy={rewindBusy}
                  onRewind={onRewind}
                />
              ))}
            </LatestToolProvider>
          )}
          {active.streaming && !active.streamingMessageId && (
            active.compacting ? (
              <div className="flex items-center gap-2 rounded-xl border border-violet-400/30 bg-violet-500/10 px-3 py-2 text-xs font-medium text-violet-200 shadow-[0_0_24px_-10px_rgba(167,139,250,0.7)]">
                <Sparkles className="h-3.5 w-3.5 animate-pulse text-violet-300" />
                <span>Compacting conversation...</span>
                <Loader2 className="ml-auto h-3 w-3 animate-spin text-violet-300/80" />
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                Thinking...
              </div>
            )
          )}
        </div>
      </div>
      {/* pb-safe keeps the send button clear of the iPhone home indicator,
          which otherwise sits directly on top of it. */}
      <div className="border-t border-border/70 bg-card/20 px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur-sm sm:px-6">
        <div className="mx-auto max-w-3xl">
          <Composer
            key={active.id}
            draft={active.draft}
            onDraftChange={(t) => patch(active.id, { draft: t })}
            mode={active.mode}
            onModeChange={(m) => patch(active.id, { mode: m })}
            model={model}
            onModelChange={(m) => patch(active.id, { model: m })}
            backend={active.backend}
            // Locked the moment a conversation exists: the engine owns that
            // conversation's session store and cannot be swapped under it.
            backendLocked={active.sessionId != null}
            onBackendChange={(b) =>
              patch(active.id, {
                backend: b,
                // Switching to an engine that cannot serve the current model
                // would leave an unusable pair, so move to one it can.
                ...(supportsBackend(model, b)
                  ? {}
                  : (() => {
                      const next = modelsForBackend(MODELS, b)[0];
                      return next
                        ? { model: next.id, effort: getDefaultEffort(next.id) }
                        : {};
                    })()),
              })
            }
            effort={effort}
            onEffortChange={(e) => patch(active.id, { effort: e })}
            autoEffort={autoEffort}
            onAutoEffortChange={(v) => patch(active.id, { autoEffort: v })}
            requestSuggestion={suggest}
            onSend={(text, images, eff) => send(text, images, eff)}
            onAbort={abort}
            onCompact={() => void compact()}
            canCompact={!!active.sessionId}
            tokensUsed={active.tokensUsed}
            cacheWarm={active.cacheWarm}
            contextWindow={contextWindow}
            disabled={!active.cwd}
            streaming={active.streaming}
            pendingQuestion={active.pendingQuestion}
            onSubmitAnswer={(toolUseId, answers) =>
              void submitAnswer(toolUseId, answers)
            }
            queuedMessages={visibleQueue}
            runningTasks={active.runningTasks}
            onQueue={(text, images) => {
              queue(text, images);
            }}
            onRemoveQueued={(msgId) => unqueue(msgId)}
          />
        </div>
      </div>
    </div>
  );
}

type RewindProps = {
  /** Show the button at all for this message. */
  canRewind: boolean;
  /** This message's rewind is in flight. */
  rewindPending: boolean;
  /** Why this message's last rewind failed, if it did. */
  rewindError: string | null;
  /** Some rewind is in flight — every button waits for it. */
  rewindBusy: boolean;
  onRewind: (messageId: string) => void;
};

const MessageRow = memo(function MessageRow({
  message,
  ...rewind
}: { message: ChatMessage } & RewindProps) {
  if (message.role === 'user') return <UserBubble message={message} rewind={rewind} />;
  if (message.role === 'system') return <SystemDivider message={message} />;
  return <AssistantBlocks message={message} rewind={rewind} />;
});

/**
 * "Rewind to here". Hover-revealed like the sidebar's row actions, always
 * visible on touch screens, and pinned visible while its own fork is running.
 */
function RewindButton({ messageId, rewind }: { messageId: string; rewind: RewindProps }) {
  return (
    <button
      type="button"
      onClick={() => rewind.onRewind(messageId)}
      disabled={rewind.rewindBusy}
      title="Rewind to here — opens a copy, original kept"
      aria-label="Rewind to here — opens a copy, original kept"
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition-all hover:bg-foreground/10 hover:text-blue-400 focus-visible:opacity-100 group-hover/msg:opacity-100 touch:opacity-100 disabled:cursor-not-allowed',
        rewind.rewindPending && 'text-blue-400 opacity-100',
        rewind.rewindBusy && !rewind.rewindPending && 'opacity-0 group-hover/msg:opacity-30 touch:opacity-30',
      )}
    >
      {rewind.rewindPending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RotateCcw className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function RewindError({ text }: { text: string | null }) {
  if (!text) return null;
  return <div className="max-w-full text-[11px] leading-snug text-red-300">{text}</div>;
}

function UserBubble({ message, rewind }: { message: UserMessage; rewind: RewindProps }) {
  const hasImages = message.images && message.images.length > 0;
  return (
    <div className="group/msg flex w-full items-end justify-end gap-1.5">
      {rewind.canRewind && <RewindButton messageId={message.id} rewind={rewind} />}
      <div className="flex max-w-[82%] flex-col items-end gap-1.5">
        {hasImages && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {message.images!.map((img) => (
              <div
                key={img.id}
                className="overflow-hidden rounded-xl border border-border/50 bg-card/40 shadow-sm"
                title={img.name}
              >
                <img
                  src={img.dataUrl}
                  alt={img.name ?? 'attachment'}
                  className="block max-h-64 max-w-xs object-contain"
                />
              </div>
            ))}
          </div>
        )}
        {message.text && (
          <div className="whitespace-pre-wrap rounded-2xl bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
            {message.text}
          </div>
        )}
        <RewindError text={rewind.rewindError} />
      </div>
    </div>
  );
}

function SystemDivider({ message }: { message: SystemMessage }) {
  const compactBlock = message.blocks.find(
    (b): b is CompactBoundaryBlock => b.type === 'compact_boundary',
  );
  if (!compactBlock) return null;
  return (
    <CompactBoundaryDivider
      trigger={compactBlock.trigger}
      preTokens={compactBlock.preTokens}
      postTokens={compactBlock.postTokens}
      durationMs={compactBlock.durationMs}
    />
  );
}

function AssistantBlocks({
  message,
  rewind,
}: {
  message: AssistantMessage;
  rewind: RewindProps;
}) {
  if (message.blocks.length === 0 && message.streaming) {
    return (
      <div className="flex w-full justify-start">
        <div className="text-xs text-muted-foreground">
          <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
          Working...
        </div>
      </div>
    );
  }

  return (
    <div className="group/msg flex w-full justify-start">
      <div className="flex w-full max-w-full flex-col gap-2">
        {message.blocks.map((block) => (
          <BlockRenderer key={block.id} block={block} />
        ))}
        {rewind.canRewind && (
          <div className="-mt-1 flex items-center gap-2">
            <RewindButton messageId={message.id} rewind={rewind} />
            <RewindError text={rewind.rewindError} />
          </div>
        )}
      </div>
    </div>
  );
}

const BlockRenderer = memo(function BlockRenderer({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      if (!block.text && !block.streaming) return null;
      return (
        <div
          className={cn(
            'max-w-full rounded-2xl border border-border/50 bg-card/60 px-3.5 py-2',
          )}
        >
          <StreamingTextView text={block.text} streaming={block.streaming} />
        </div>
      );
    case 'thinking':
      return <ThinkingBlockView block={block} />;
    case 'tool_use':
      return <ToolUseBlockView block={block} />;
    case 'error':
      return (
        <div className="max-w-full rounded-2xl border border-red-500/40 bg-red-500/10 px-3.5 py-2 text-sm text-red-300">
          <Markdown>{block.text}</Markdown>
        </div>
      );
    case 'refusal':
      return <RefusalBlockView block={block} />;
    case 'image':
    case 'compact_boundary':
      return null;
  }
});
