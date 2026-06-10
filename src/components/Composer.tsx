'use client';

import { type ChangeEvent, type KeyboardEvent, useRef, useState } from 'react';
import {
  ArrowUp,
  Clock,
  Image as ImageIcon,
  Loader2,
  Minimize2,
  Square,
  Wand2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type {
  ImageMediaType,
  PendingQuestion,
  PermissionMode,
  QueuedMessage,
} from '@/lib/types';
import type { EffortLevel, EffortSuggestion, ModelId } from '@/lib/models';
import type { SendImage } from '@/hooks/useStreamingChat';
import AskQuestionPicker from './AskQuestionPicker';
import AutoEffortToggle from './AutoEffortToggle';
import EffortPicker from './EffortPicker';
import EffortSuggestionPanel from './EffortSuggestionPanel';
import ModelPicker from './ModelPicker';
import ModePicker from './ModePicker';
import TokenCircle from './TokenCircle';

const ALLOWED_MEDIA: ImageMediaType[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];
// No client-side image size limit — the user asked for this restriction
// lifted explicitly. The Claude API will reject anything it can't handle
// and the error will surface in the chat just like any other upstream
// failure. We still cap the *media type* set above because Claude only
// understands those four mimetypes.

type Attachment = SendImage & { id: string };

function newAttachmentId() {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

type ComposerProps = {
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  model: ModelId;
  onModelChange: (model: ModelId) => void;
  effort: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  /** "Auto effort" feature toggle — suggest an effort for each first message. */
  autoEffort: boolean;
  onAutoEffortChange: (enabled: boolean) => void;
  /**
   * Ask the server classifier which effort the prompt warrants. Returns the
   * recommendation, or `null` to fall back to sending with the current effort.
   */
  requestSuggestion: (prompt: string) => Promise<EffortSuggestion | null>;
  onSend: (text: string, images?: SendImage[], effort?: EffortLevel) => void;
  onAbort: () => void;
  onCompact: () => void;
  canCompact?: boolean;
  tokensUsed: number;
  contextWindow: number;
  disabled?: boolean;
  streaming?: boolean;
  pendingQuestion?: PendingQuestion | null;
  onSubmitAnswer?: (toolUseId: string, answers: Record<string, string>) => void;
  /** FIFO of messages typed while the agent was busy. */
  queuedMessages?: QueuedMessage[];
  /**
   * Queue a message for later instead of sending immediately. Wired up when
   * the agent is streaming so Enter/click defers instead of being lost.
   */
  onQueue?: (text: string, images?: SendImage[]) => void;
  /** Drop a single queued message before it gets sent. */
  onRemoveQueued?: (msgId: string) => void;
};

export default function Composer({
  mode,
  onModeChange,
  model,
  onModelChange,
  effort,
  onEffortChange,
  autoEffort,
  onAutoEffortChange,
  requestSuggestion,
  onSend,
  onAbort,
  onCompact,
  canCompact = true,
  tokensUsed,
  contextWindow,
  disabled,
  streaming,
  pendingQuestion,
  onSubmitAnswer,
  queuedMessages,
  onQueue,
  onRemoveQueued,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  // Auto-effort flow: `suggesting` is true while the classifier runs; `pending`
  // holds the captured message + recommendation awaiting the user's choice.
  const [suggesting, setSuggesting] = useState(false);
  const [pending, setPending] = useState<{
    text: string;
    images: SendImage[];
    suggestion: EffortSuggestion;
  } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const clearInput = () => {
    setText('');
    setAttachments([]);
    setImageError(null);
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  // Send a first message through the auto-effort classifier before it starts
  // the turn. Only first messages reach here (the streaming branch queues
  // instead), so subsequent/appended messages are never gated by a suggestion.
  const runSuggestion = async (t: string, images: SendImage[]) => {
    setSuggesting(true);
    clearInput();
    let suggestion: EffortSuggestion | null = null;
    try {
      suggestion = await requestSuggestion(t);
    } finally {
      setSuggesting(false);
    }
    if (suggestion) {
      setPending({ text: t, images, suggestion });
    } else {
      // No usable recommendation — send straight away with the current effort.
      onSend(t, images.length ? images : undefined);
    }
  };

  const submit = () => {
    if (disabled || suggesting || pending) return;
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    const images: SendImage[] = attachments.map((a) => ({
      dataUrl: a.dataUrl,
      mediaType: a.mediaType,
      name: a.name,
    }));
    // While the agent is streaming, defer the message into the per-instance
    // queue. It will be drained automatically once the current turn finishes
    // (Claude Code's behaviour — keep typing, keep queueing).
    if (streaming && onQueue) {
      onQueue(t, images.length ? images : undefined);
      clearInput();
      return;
    }
    // First message of a turn. With auto-effort on (and actual text to judge),
    // ask the classifier first; otherwise send immediately.
    if (autoEffort && t) {
      void runSuggestion(t, images);
      return;
    }
    onSend(t, images.length ? images : undefined);
    clearInput();
  };

  const acceptSuggestion = () => {
    if (!pending) return;
    const { text: t, images, suggestion } = pending;
    setPending(null);
    // Reflect the accepted effort in the picker (persists) AND pass it as a
    // one-shot override so this very request uses it without waiting on state.
    onEffortChange(suggestion.effort);
    onSend(t, images.length ? images : undefined, suggestion.effort);
  };

  const rejectSuggestion = () => {
    if (!pending) return;
    const { text: t, images } = pending;
    setPending(null);
    onSend(t, images.length ? images : undefined);
  };

  const cancelSuggestion = () => {
    if (!pending) return;
    const { text: t, images } = pending;
    setPending(null);
    // Put the message back so the user can keep editing.
    setText(t);
    setAttachments(
      images.map((img) => ({ ...img, id: newAttachmentId() })),
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  };

  const onPickImages = () => {
    fileRef.current?.click();
  };

  const onFilesChosen = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setImageError(null);
    const next: Attachment[] = [];
    for (const file of Array.from(files)) {
      if (!ALLOWED_MEDIA.includes(file.type as ImageMediaType)) {
        setImageError(`Unsupported file type: ${file.name}`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        next.push({
          id: newAttachmentId(),
          dataUrl,
          mediaType: file.type as ImageMediaType,
          name: file.name,
        });
      } catch {
        setImageError(`Failed to read ${file.name}`);
      }
    }
    if (next.length > 0) setAttachments((prev) => [...prev, ...next]);
    if (fileRef.current) fileRef.current.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const ghostBtn =
    'inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50';

  const compactDisabled = !canCompact || streaming || disabled;
  const isAwaitingAnswer = !!pendingQuestion;
  const hasInput = text.trim().length > 0 || attachments.length > 0;
  const busyWithSuggestion = suggesting || !!pending;
  const sendEnabled =
    hasInput && !disabled && !isAwaitingAnswer && !busyWithSuggestion;
  const queue = queuedMessages ?? [];

  return (
    <div
      className={cn(
        'group/composer relative flex flex-col gap-1.5 overflow-hidden rounded-2xl border border-blue-400/30 bg-gradient-to-b from-blue-500/[0.06] via-card/60 to-card/40 p-2 shadow-[0_0_24px_-8px_rgba(80,150,255,0.45)] backdrop-blur-sm transition-all duration-200',
        'focus-within:border-blue-400/60 focus-within:from-blue-500/[0.10] focus-within:shadow-[0_0_32px_-6px_rgba(80,150,255,0.7)] focus-within:ring-1 focus-within:ring-blue-400/30',
        disabled && 'opacity-60',
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-400/60 to-transparent"
      />
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1 pt-1">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="relative h-16 w-16 overflow-hidden rounded-lg border border-blue-400/30 bg-muted/30 shadow-sm"
              title={att.name}
            >
              <img
                src={att.dataUrl}
                alt={att.name ?? 'attachment'}
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                onClick={() => removeAttachment(att.id)}
                className="absolute right-0.5 top-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-background/80 text-muted-foreground shadow-sm hover:text-foreground"
                aria-label="Remove attachment"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {imageError && (
        <div className="px-2 text-[11px] text-red-400">{imageError}</div>
      )}
      {suggesting && (
        <div className="flex items-center gap-2 rounded-lg border border-teal-400/30 bg-teal-500/[0.06] px-2.5 py-1.5 text-[12px] text-teal-200">
          <Wand2 className="h-3.5 w-3.5 animate-pulse text-teal-300" />
          <span>Choosing the right thinking effort…</span>
          <Loader2 className="ml-auto h-3 w-3 animate-spin text-teal-300/80" />
        </div>
      )}
      {pending && (
        <EffortSuggestionPanel
          suggestion={pending.suggestion}
          currentEffort={effort}
          onAccept={acceptSuggestion}
          onReject={rejectSuggestion}
          onCancel={cancelSuggestion}
        />
      )}
      {pendingQuestion && onSubmitAnswer && (
        <div className="px-1 pt-1">
          <AskQuestionPicker
            key={pendingQuestion.toolUseId}
            pending={pendingQuestion}
            onSubmit={onSubmitAnswer}
          />
        </div>
      )}
      {queue.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-amber-400/30 bg-amber-500/[0.06] px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-amber-200/80">
            <Clock className="h-3 w-3" />
            <span>
              {queue.length} message{queue.length === 1 ? '' : 's'} queued —
              will send after the current turn
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {queue.map((q) => {
              const summary = q.text || (q.images?.length ? '(images only)' : '');
              return (
                <li
                  key={q.id}
                  className="group/queue flex items-start gap-2 rounded-md bg-background/40 px-2 py-1"
                >
                  {q.images && q.images.length > 0 && (
                    <div className="flex shrink-0 -space-x-1">
                      {q.images.slice(0, 3).map((img) => (
                        <img
                          key={img.id}
                          src={img.dataUrl}
                          alt={img.name ?? 'queued attachment'}
                          className="h-5 w-5 rounded border border-border/50 object-cover"
                          title={img.name}
                        />
                      ))}
                      {q.images.length > 3 && (
                        <span className="inline-flex h-5 items-center rounded border border-border/50 bg-muted/50 px-1 text-[9px] text-muted-foreground">
                          +{q.images.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                  <span
                    className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-snug text-foreground/90"
                    title={summary}
                  >
                    {summary}
                  </span>
                  {onRemoveQueued && (
                    <button
                      type="button"
                      onClick={() => onRemoveQueued(q.id)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label="Remove from queue"
                      title="Remove from queue"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          autoGrow(e.currentTarget);
        }}
        onKeyDown={onKeyDown}
        placeholder={
          disabled
            ? 'Select a folder to start...'
            : isAwaitingAnswer
              ? 'Answer the question above to continue...'
              : pending
                ? 'Accept or reject the suggested effort above...'
                : suggesting
                  ? 'Choosing the right thinking effort…'
                  : 'Message Claude...'
        }
        rows={1}
        disabled={disabled || isAwaitingAnswer || busyWithSuggestion}
        className="w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
      />
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ModePicker mode={mode} onChange={onModeChange} />
          <ModelPicker
            model={model}
            onChange={onModelChange}
            disabled={disabled}
          />
          <EffortPicker
            effort={effort}
            onChange={onEffortChange}
            disabled={disabled}
          />
          <AutoEffortToggle
            enabled={autoEffort}
            onChange={onAutoEffortChange}
            disabled={disabled}
          />
          <button
            type="button"
            onClick={onPickImages}
            disabled={disabled || streaming}
            className={ghostBtn}
            title="Attach images"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Image</span>
          </button>
          <button
            type="button"
            onClick={onCompact}
            disabled={compactDisabled}
            className={ghostBtn}
            title={
              canCompact
                ? 'Compact conversation (summarize past turns)'
                : 'Compact requires an active conversation'
            }
          >
            <Minimize2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Compact</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ALLOWED_MEDIA.join(',')}
            multiple
            onChange={onFilesChosen}
            className="hidden"
          />
        </div>
        <div className="flex items-center gap-2.5">
          <TokenCircle used={tokensUsed} total={contextWindow} />
          {streaming && (
            <button
              type="button"
              onClick={onAbort}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-destructive/90 text-destructive-foreground transition-colors hover:bg-destructive"
              aria-label="Stop"
              title="Stop"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" />
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={!sendEnabled}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
              !sendEnabled
                ? 'cursor-not-allowed bg-muted text-muted-foreground'
                : streaming
                  ? 'bg-amber-500/80 text-amber-50 hover:bg-amber-500'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
            aria-label={streaming ? 'Queue message' : 'Send'}
            title={
              streaming
                ? 'Queue this message — sent when the agent finishes'
                : 'Send'
            }
          >
            {streaming ? (
              <Clock className="h-4 w-4" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
