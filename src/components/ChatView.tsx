'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import type {
  AssistantMessage,
  ChatMessage,
  CompactBoundaryBlock,
  ContentBlock,
  SystemMessage,
  UserMessage,
} from '@/lib/types';
import { useInstances } from '@/state/instances';
import { useEffortSuggestion } from '@/hooks/useEffortSuggestion';
import { useModelPreference } from '@/hooks/useModelPreference';
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
  const { active, contextWindow, patch, prependMessages } = useInstances();
  const { model, effort, autoEffort, setModel, setEffort, setAutoEffort } =
    useModelPreference();
  const { suggest } = useEffortSuggestion();
  const { send, queue, unqueue, abort, compact, submitAnswer } = useStreamingChat({
    model,
    effort,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottom = useRef(true);
  const isPrepending = useRef(false);
  const prevScrollHeight = useRef(0);

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

  if (!active.cwd) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground">
        Select a folder in the left panel to start a chat.
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
                <MessageRow key={m.id} message={m} />
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
      <div className="border-t border-border/70 bg-card/20 px-3 py-3 backdrop-blur-sm sm:px-6">
        <div className="mx-auto max-w-3xl">
          <Composer
            mode={active.mode}
            onModeChange={(m) => patch(active.id, { mode: m })}
            model={model}
            onModelChange={setModel}
            effort={effort}
            onEffortChange={setEffort}
            autoEffort={autoEffort}
            onAutoEffortChange={setAutoEffort}
            requestSuggestion={suggest}
            onSend={(text, images, eff) => send(text, images, eff)}
            onAbort={abort}
            onCompact={() => void compact()}
            canCompact={!!active.sessionId}
            tokensUsed={active.tokensUsed}
            contextWindow={contextWindow}
            disabled={!active.cwd}
            streaming={active.streaming}
            pendingQuestion={active.pendingQuestion}
            onSubmitAnswer={(toolUseId, answers) =>
              void submitAnswer(toolUseId, answers)
            }
            queuedMessages={visibleQueue}
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

const MessageRow = memo(function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === 'user') return <UserBubble message={message} />;
  if (message.role === 'system') return <SystemDivider message={message} />;
  return <AssistantBlocks message={message} />;
});

function UserBubble({ message }: { message: UserMessage }) {
  const hasImages = message.images && message.images.length > 0;
  return (
    <div className="flex w-full justify-end">
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

function AssistantBlocks({ message }: { message: AssistantMessage }) {
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
    <div className="flex w-full justify-start">
      <div className="flex w-full max-w-full flex-col gap-2">
        {message.blocks.map((block) => (
          <BlockRenderer key={block.id} block={block} />
        ))}
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
