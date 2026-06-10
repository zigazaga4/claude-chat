'use client';

import type { ComponentType } from 'react';
import {
  Bot,
  Box,
  FileEdit,
  FilePlus2,
  FileSearch,
  FileText,
  FolderTree,
  Globe,
  HelpCircle,
  ListTodo,
  NotebookPen,
  PencilLine,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ToolUseBlock } from '@/lib/types';
import { AskUserQuestionToolView } from './AskUserQuestionToolView';
import { BashToolView } from './BashToolView';
import { EditToolView } from './EditToolView';
import { ExitPlanModeToolView } from './ExitPlanModeToolView';
import { GenericToolView } from './GenericToolView';
import { GlobToolView } from './GlobToolView';
import { GrepToolView } from './GrepToolView';
import { LSToolView } from './LSToolView';
import { NotebookEditToolView } from './NotebookEditToolView';
import { ReadToolView } from './ReadToolView';
import { TaskToolView } from './TaskToolView';
import { TodoWriteToolView } from './TodoWriteToolView';
import { WebFetchToolView } from './WebFetchToolView';
import { WebSearchToolView } from './WebSearchToolView';
import { WriteToolView } from './WriteToolView';
import { ToolShell, type ToolTone } from './ToolShell';

const REGISTRY: Record<string, ComponentType<{ block: ToolUseBlock }>> = {
  Bash: BashToolView,
  BashOutput: GenericToolView,
  KillShell: GenericToolView,
  Read: ReadToolView,
  Write: WriteToolView,
  Edit: EditToolView,
  NotebookEdit: NotebookEditToolView,
  Glob: GlobToolView,
  Grep: GrepToolView,
  LS: LSToolView,
  Ls: LSToolView,
  TodoWrite: TodoWriteToolView,
  WebFetch: WebFetchToolView,
  WebSearch: WebSearchToolView,
  Task: TaskToolView,
  Agent: TaskToolView,
  ExitPlanMode: ExitPlanModeToolView,
  AskUserQuestion: AskUserQuestionToolView,
  // Remote (SSH) equivalents — same views, the input shape mostly aligns.
  mcp__remote__bash: BashToolView,
  mcp__remote__read: ReadToolView,
  mcp__remote__write: WriteToolView,
  mcp__remote__edit: EditToolView,
  mcp__remote__glob: GlobToolView,
  mcp__remote__grep: GrepToolView,
  mcp__remote__ls: LSToolView,
};

type Preview = { label: string; Icon: LucideIcon; tone: ToolTone };

const FALLBACK_PREVIEW: Preview = {
  label: 'Tool',
  Icon: Wrench,
  tone: { stripe: 'bg-muted-foreground/40', icon: 'text-muted-foreground' },
};

const PREVIEW: Record<string, Preview> = {
  Bash: { label: 'Bash', Icon: Terminal, tone: { stripe: 'bg-emerald-400/70', icon: 'text-emerald-400' } },
  Read: { label: 'Read', Icon: FileText, tone: { stripe: 'bg-sky-400/70', icon: 'text-sky-400' } },
  Write: { label: 'Write', Icon: FilePlus2, tone: { stripe: 'bg-violet-400/70', icon: 'text-violet-400' } },
  Edit: { label: 'Edit', Icon: PencilLine, tone: { stripe: 'bg-amber-400/70', icon: 'text-amber-400' } },
  NotebookEdit: { label: 'NotebookEdit', Icon: NotebookPen, tone: { stripe: 'bg-orange-400/70', icon: 'text-orange-400' } },
  Glob: { label: 'Glob', Icon: FileSearch, tone: { stripe: 'bg-cyan-400/70', icon: 'text-cyan-400' } },
  Grep: { label: 'Grep', Icon: Search, tone: { stripe: 'bg-teal-400/70', icon: 'text-teal-400' } },
  LS: { label: 'LS', Icon: FolderTree, tone: { stripe: 'bg-blue-400/70', icon: 'text-blue-400' } },
  Ls: { label: 'LS', Icon: FolderTree, tone: { stripe: 'bg-blue-400/70', icon: 'text-blue-400' } },
  TodoWrite: { label: 'TodoWrite', Icon: ListTodo, tone: { stripe: 'bg-pink-400/70', icon: 'text-pink-400' } },
  WebFetch: { label: 'WebFetch', Icon: Globe, tone: { stripe: 'bg-indigo-400/70', icon: 'text-indigo-400' } },
  WebSearch: { label: 'WebSearch', Icon: Search, tone: { stripe: 'bg-fuchsia-400/70', icon: 'text-fuchsia-400' } },
  Task: { label: 'Task', Icon: Bot, tone: { stripe: 'bg-purple-400/70', icon: 'text-purple-400' } },
  Agent: { label: 'Agent', Icon: Bot, tone: { stripe: 'bg-purple-400/70', icon: 'text-purple-400' } },
  ExitPlanMode: { label: 'ExitPlanMode', Icon: ShieldCheck, tone: { stripe: 'bg-emerald-400/70', icon: 'text-emerald-400' } },
  AskUserQuestion: { label: 'AskUserQuestion', Icon: HelpCircle, tone: { stripe: 'bg-yellow-400/70', icon: 'text-yellow-400' } },
  mcp__remote__bash: { label: 'Bash (ssh)', Icon: Terminal, tone: { stripe: 'bg-emerald-400/70', icon: 'text-emerald-400' } },
  mcp__remote__read: { label: 'Read (ssh)', Icon: FileText, tone: { stripe: 'bg-sky-400/70', icon: 'text-sky-400' } },
  mcp__remote__write: { label: 'Write (ssh)', Icon: FilePlus2, tone: { stripe: 'bg-violet-400/70', icon: 'text-violet-400' } },
  mcp__remote__edit: { label: 'Edit (ssh)', Icon: FileEdit, tone: { stripe: 'bg-amber-400/70', icon: 'text-amber-400' } },
  mcp__remote__glob: { label: 'Glob (ssh)', Icon: FileSearch, tone: { stripe: 'bg-cyan-400/70', icon: 'text-cyan-400' } },
  mcp__remote__grep: { label: 'Grep (ssh)', Icon: Search, tone: { stripe: 'bg-teal-400/70', icon: 'text-teal-400' } },
  mcp__remote__ls: { label: 'LS (ssh)', Icon: FolderTree, tone: { stripe: 'bg-blue-400/70', icon: 'text-blue-400' } },
};

function PendingToolView({ block }: { block: ToolUseBlock }) {
  const meta = PREVIEW[block.name] ?? { ...FALLBACK_PREVIEW, label: block.name || FALLBACK_PREVIEW.label };
  return (
    <ToolShell
      name={meta.label}
      Icon={meta.Icon}
      tone={meta.tone}
      status="pending"
      streaming
      summary={
        <span className="inline-flex items-center gap-1.5 text-muted-foreground/80">
          <span className="inline-flex gap-0.5">
            <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:0ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:140ms]" />
            <span className="h-1 w-1 animate-pulse rounded-full bg-current [animation-delay:280ms]" />
          </span>
          <span className="font-mono text-[11px]">preparing input…</span>
        </span>
      }
      statusLabel={
        <span className="inline-flex items-center gap-1 text-blue-400">
          <Box className="h-2.5 w-2.5 animate-pulse" />
          streaming
        </span>
      }
    />
  );
}

export function ToolUseBlockView({ block }: { block: ToolUseBlock }) {
  if (block.streaming) {
    return <PendingToolView block={block} />;
  }
  const View = REGISTRY[block.name] ?? GenericToolView;
  return <View block={block} />;
}
