'use client';

import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { Highlight, themes } from 'prism-react-renderer';
import { cn } from '@/lib/cn';
import {
  FOLDER_COLOR,
  FolderIcon,
  FolderOpenIcon,
  getFileMeta,
} from '@/lib/fileIcons';
import { useInstances } from '@/state/instances';

type Entry = { name: string; path: string; kind: 'dir' | 'file' };
type TreeResult = { path: string; parent: string | null; entries: Entry[] };
type ReadResult = {
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string;
};

type DirState = {
  loading: boolean;
  error: string | null;
  entries: Entry[] | null;
};

type UploadState = {
  /** Absolute directory the upload is targeting. */
  destPath: string;
  /** Files in flight. */
  count: number;
  /** Total bytes (best-effort — we sum `File.size` before posting). */
  bytes: number;
};

type UploadResponse = {
  ok: true;
  dest: string;
  uploaded: { name: string; path: string; size: number }[];
  errors?: { name: string; error: string }[];
};

export default function FilesView() {
  const { active } = useInstances();
  const cwd = active.cwd;

  // Per-directory expansion + cache. Keyed by absolute path.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dirCache, setDirCache] = useState<Record<string, DirState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<ReadResult | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  /** In-flight upload (one at a time — keeps the UX legible). */
  const [upload, setUpload] = useState<UploadState | null>(null);
  /** Last upload outcome — banner shown until the user kicks off another. */
  const [uploadResult, setUploadResult] = useState<
    | { kind: 'success'; dest: string; count: number; errors?: number }
    | { kind: 'error'; message: string }
    | null
  >(null);
  /**
   * Which folder is currently being targeted by a drag-over. Drives the
   * blue ring around the row so the user can see where files will land
   * before they release the mouse.
   */
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  /**
   * One hidden <input type="file"> per render is enough — we set
   * `currentUploadDestRef` right before triggering the click so the change
   * handler knows which folder to upload to.
   */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentUploadDestRef = useRef<string | null>(null);

  const loadDir = useCallback(
    async (path: string) => {
      if (!cwd) return;
      setDirCache((prev) => ({
        ...prev,
        [path]: { loading: true, error: null, entries: prev[path]?.entries ?? null },
      }));
      try {
        const params = new URLSearchParams({ cwd, path });
        const res = await fetch(`/api/fs/tree?${params.toString()}`);
        const data = (await res.json()) as TreeResult & { error?: string };
        if (!res.ok || data.error) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        setDirCache((prev) => ({
          ...prev,
          [path]: { loading: false, error: null, entries: data.entries },
        }));
      } catch (e) {
        setDirCache((prev) => ({
          ...prev,
          [path]: {
            loading: false,
            error: e instanceof Error ? e.message : 'Read failed',
            entries: prev[path]?.entries ?? null,
          },
        }));
      }
    },
    [cwd],
  );

  // Auto-load + expand the workspace root when it changes.
  useEffect(() => {
    if (!cwd) return;
    const root = workspaceRootPath(cwd);
    if (!root) return;
    setExpanded(new Set([root]));
    setSelected(null);
    setFile(null);
    setFileError(null);
    void loadDir(root);
  }, [cwd, loadDir]);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!dirCache[path]?.entries) void loadDir(path);
        }
        return next;
      });
    },
    [dirCache, loadDir],
  );

  const openFile = useCallback(
    async (path: string) => {
      if (!cwd) return;
      setSelected(path);
      setFileLoading(true);
      setFileError(null);
      setFile(null);
      try {
        const params = new URLSearchParams({ cwd, path });
        const res = await fetch(`/api/fs/read?${params.toString()}`);
        const data = (await res.json()) as ReadResult & { error?: string };
        if (!res.ok || data.error) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        setFile(data);
      } catch (e) {
        setFileError(e instanceof Error ? e.message : 'Read failed');
      } finally {
        setFileLoading(false);
      }
    },
    [cwd],
  );

  const refresh = useCallback(() => {
    if (!cwd) return;
    // Reload every currently-expanded directory so newly created files
    // show up without forcing the user to collapse/expand.
    for (const p of expanded) void loadDir(p);
    if (selected) void openFile(selected);
  }, [cwd, expanded, loadDir, openFile, selected]);

  /**
   * POST the files to /api/fs/upload. Works for both local and SSH
   * workspaces — the server routes by `cwd`. After completion we reload
   * the target dir so the new entries appear without a manual refresh.
   */
  const uploadFiles = useCallback(
    async (destPath: string, files: File[]) => {
      if (!cwd || files.length === 0) return;
      const totalBytes = files.reduce((n, f) => n + f.size, 0);
      setUpload({ destPath, count: files.length, bytes: totalBytes });
      setUploadResult(null);
      try {
        const form = new FormData();
        form.set('cwd', cwd);
        form.set('dest', destPath);
        for (const f of files) form.append('files', f, f.name);
        const res = await fetch('/api/fs/upload', {
          method: 'POST',
          body: form,
        });
        const data = (await res.json()) as
          | UploadResponse
          | { error: string };
        if (!res.ok || 'error' in data) {
          throw new Error(
            'error' in data ? data.error : `HTTP ${res.status}`,
          );
        }
        setUploadResult({
          kind: 'success',
          dest: data.dest,
          count: data.uploaded.length,
          errors: data.errors?.length,
        });
        // Make sure the target dir is visible and re-load it.
        setExpanded((prev) => {
          if (prev.has(destPath)) return prev;
          const next = new Set(prev);
          next.add(destPath);
          return next;
        });
        await loadDir(destPath);
      } catch (e) {
        setUploadResult({
          kind: 'error',
          message: e instanceof Error ? e.message : 'Upload failed',
        });
      } finally {
        setUpload(null);
      }
    },
    [cwd, loadDir],
  );

  /**
   * Trigger the hidden file input so the OS picker opens. We stash the
   * target folder on a ref because `<input type="file">` only knows about
   * its `onChange` — it can't carry per-click metadata otherwise.
   */
  const promptUpload = useCallback((destPath: string) => {
    currentUploadDestRef.current = destPath;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }, []);

  const onFileInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const dest = currentUploadDestRef.current;
      currentUploadDestRef.current = null;
      const files = e.target.files;
      if (!dest || !files || files.length === 0) return;
      void uploadFiles(dest, Array.from(files));
    },
    [uploadFiles],
  );

  /**
   * Drag-and-drop onto a folder row. The drop target carries the absolute
   * dir path so the upload lands exactly where the user dropped — no
   * guessing based on selection.
   */
  const onFolderDrop = useCallback(
    (destPath: string, e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOverPath(null);
      const items = e.dataTransfer?.files;
      if (!items || items.length === 0) return;
      void uploadFiles(destPath, Array.from(items));
    },
    [uploadFiles],
  );

  const onFolderDragOver = useCallback(
    (destPath: string, e: DragEvent<HTMLElement>) => {
      // Only react if the drag actually has files — ignore in-app drags
      // like text selection that happen to cross a folder row.
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDragOverPath(destPath);
    },
    [],
  );

  const onFolderDragLeave = useCallback(
    (destPath: string, e: DragEvent<HTMLElement>) => {
      // Only clear the highlight when leaving the target's bounds entirely,
      // not when crossing into a nested child.
      if ((e.currentTarget as HTMLElement).contains(
          e.relatedTarget as Node | null,
        )) {
        return;
      }
      setDragOverPath((prev) => (prev === destPath ? null : prev));
    },
    [],
  );

  if (!cwd) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground">
        Select a folder in the left panel to browse files.
      </div>
    );
  }

  const root = workspaceRootPath(cwd);

  return (
    <div className="flex h-full min-h-0">
      <aside className="scrollbar-thin flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border/60 bg-card/30 text-sm">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-1 border-b border-border/40 bg-card/80 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur-sm">
          <span className="truncate">Files</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => root && promptUpload(root)}
              disabled={!root || !!upload}
              className="inline-flex items-center gap-1 rounded-md border border-blue-400/40 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-200 transition-colors hover:border-blue-400/70 hover:bg-blue-500/20 hover:text-blue-100 disabled:opacity-40"
              title={root ? `Upload files to ${root}` : 'Upload files'}
              aria-label="Upload files to workspace root"
            >
              <Upload className="h-3 w-3" />
              <span>Upload</span>
            </button>
            <button
              type="button"
              onClick={refresh}
              className="rounded p-1 text-muted-foreground/80 hover:bg-secondary hover:text-foreground"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
        </div>
        <div className="border-b border-border/40 bg-blue-500/[0.04] px-2 py-1.5 text-[10.5px] leading-tight text-muted-foreground">
          Drop files on any folder below, click the <Upload className="-mt-px inline h-3 w-3 align-middle text-blue-300" /> icon
          on a folder row, or hit <span className="font-semibold text-blue-200">Upload</span> above to send to{' '}
          <span className="font-mono">{root}</span>.
        </div>
        {(upload || uploadResult) && (
          <div className="border-b border-border/40 bg-card/60 px-2 py-1.5 text-[11px]">
            {upload ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
                <span className="min-w-0 flex-1 truncate">
                  Uploading {upload.count} file
                  {upload.count === 1 ? '' : 's'} ({humanBytes(upload.bytes)})
                  to{' '}
                  <span className="font-mono text-foreground/80">
                    {upload.destPath}
                  </span>
                </span>
              </div>
            ) : uploadResult?.kind === 'success' ? (
              <div className="text-emerald-300/90">
                Uploaded {uploadResult.count} file
                {uploadResult.count === 1 ? '' : 's'} to{' '}
                <span className="font-mono">{uploadResult.dest}</span>
                {uploadResult.errors ? (
                  <span className="ml-1 text-amber-300">
                    ({uploadResult.errors} failed)
                  </span>
                ) : null}
              </div>
            ) : uploadResult?.kind === 'error' ? (
              <div className="text-destructive">{uploadResult.message}</div>
            ) : null}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={onFileInputChange}
          className="hidden"
        />
        {root && (
          <DirNode
            path={root}
            depth={0}
            expanded={expanded}
            dirCache={dirCache}
            selected={selected}
            uploadingPath={upload?.destPath ?? null}
            dragOverPath={dragOverPath}
            onToggle={toggleDir}
            onOpenFile={openFile}
            onUpload={promptUpload}
            onFolderDrop={onFolderDrop}
            onFolderDragOver={onFolderDragOver}
            onFolderDragLeave={onFolderDragLeave}
          />
        )}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-card/30 px-3 py-1.5 text-[11px] text-muted-foreground">
          {selected ? (
            <>
              {(() => {
                const meta = getFileMeta(basename(selected));
                return (
                  <meta.Icon
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: meta.color }}
                    aria-hidden="true"
                  />
                );
              })()}
              <span className="min-w-0 flex-1 truncate font-mono">{selected}</span>
              {file && (
                <span className="shrink-0 text-[10.5px] text-muted-foreground/70">
                  {humanBytes(file.size)}
                  {file.truncated && ' (truncated)'}
                </span>
              )}
            </>
          ) : (
            <span>Select a file from the tree.</span>
          )}
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto bg-background">
          {fileLoading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : fileError ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">
              {fileError}
            </div>
          ) : !file ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {selected ? '' : 'No file selected.'}
            </div>
          ) : file.binary ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
              {(() => {
                const meta = getFileMeta(basename(file.path));
                return (
                  <meta.Icon
                    className="h-10 w-10"
                    style={{ color: meta.color }}
                    aria-hidden="true"
                  />
                );
              })()}
              <div>
                Binary file ({humanBytes(file.size)}) — preview not available.
              </div>
            </div>
          ) : (
            <CodeViewer path={file.path} content={file.content} />
          )}
        </div>
      </section>
    </div>
  );
}

type DirNodeProps = {
  path: string;
  depth: number;
  expanded: Set<string>;
  dirCache: Record<string, DirState>;
  selected: string | null;
  /** Folder currently receiving an upload (shows a spinner instead of icon). */
  uploadingPath: string | null;
  /** Folder currently being dragged over (highlights the drop target). */
  dragOverPath: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onUpload: (destPath: string) => void;
  onFolderDrop: (destPath: string, e: DragEvent<HTMLElement>) => void;
  onFolderDragOver: (destPath: string, e: DragEvent<HTMLElement>) => void;
  onFolderDragLeave: (destPath: string, e: DragEvent<HTMLElement>) => void;
};

function DirNode({
  path,
  depth,
  expanded,
  dirCache,
  selected,
  uploadingPath,
  dragOverPath,
  onToggle,
  onOpenFile,
  onUpload,
  onFolderDrop,
  onFolderDragOver,
  onFolderDragLeave,
}: DirNodeProps) {
  const open = expanded.has(path);
  const state = dirCache[path];
  const name = depth === 0 ? path : basename(path);
  const isUploading = uploadingPath === path;
  const isDragOver = dragOverPath === path;
  return (
    <div
      onDrop={(e) => onFolderDrop(path, e)}
      onDragOver={(e) => onFolderDragOver(path, e)}
      onDragEnter={(e) => onFolderDragOver(path, e)}
      onDragLeave={(e) => onFolderDragLeave(path, e)}
    >
      <div
        className={cn(
          'group/dir flex w-full items-center hover:bg-secondary/60',
          depth === 0 && 'sticky top-[28px] z-[5] bg-card/60 font-semibold',
          isDragOver && 'bg-blue-500/15 ring-1 ring-inset ring-blue-400/60',
        )}
      >
        <button
          type="button"
          onClick={() => onToggle(path)}
          className="flex min-w-0 flex-1 items-center gap-1 truncate py-1 text-left"
          style={{ paddingLeft: `${4 + depth * 12}px` }}
          title={path}
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          {open ? (
            <FolderOpenIcon
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: FOLDER_COLOR }}
              aria-hidden="true"
            />
          ) : (
            <FolderIcon
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: FOLDER_COLOR }}
              aria-hidden="true"
            />
          )}
          <span className="min-w-0 truncate font-mono text-[12px]">{name}</span>
          {state?.loading && (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onUpload(path);
          }}
          disabled={isUploading}
          className={cn(
            'mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-blue-300/70 hover:bg-blue-500/20 hover:text-blue-100',
            // Always visible at low opacity so the user can see where they
            // can upload. Brightens on row hover, full on drag/upload.
            'opacity-60 transition-opacity group-hover/dir:opacity-100 focus-visible:opacity-100',
            (isUploading || isDragOver) && 'opacity-100',
          )}
          title={`Upload files to ${path}`}
          aria-label={`Upload files to ${path}`}
        >
          {isUploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {open && state?.error && (
        <div
          className="px-2 py-1 text-[11px] text-destructive"
          style={{ paddingLeft: `${4 + (depth + 1) * 12}px` }}
        >
          {state.error}
        </div>
      )}
      {open && state?.entries && (
        <div>
          {state.entries.length === 0 && (
            <div
              className="px-2 py-1 text-[11px] italic text-muted-foreground/70"
              style={{ paddingLeft: `${4 + (depth + 1) * 12}px` }}
            >
              empty
            </div>
          )}
          {state.entries.map((e) =>
            e.kind === 'dir' ? (
              <DirNode
                key={e.path}
                path={e.path}
                depth={depth + 1}
                expanded={expanded}
                dirCache={dirCache}
                selected={selected}
                uploadingPath={uploadingPath}
                dragOverPath={dragOverPath}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onUpload={onUpload}
                onFolderDrop={onFolderDrop}
                onFolderDragOver={onFolderDragOver}
                onFolderDragLeave={onFolderDragLeave}
              />
            ) : (
              <FileNode
                key={e.path}
                entry={e}
                depth={depth + 1}
                selected={selected === e.path}
                onOpen={onOpenFile}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function FileNode({
  entry,
  depth,
  selected,
  onOpen,
}: {
  entry: Entry;
  depth: number;
  selected: boolean;
  onOpen: (path: string) => void;
}) {
  const meta = getFileMeta(entry.name);
  return (
    <button
      type="button"
      onClick={() => onOpen(entry.path)}
      className={cn(
        'flex w-full items-center gap-1.5 truncate px-1.5 py-1 text-left hover:bg-secondary/60',
        selected && 'bg-blue-500/15 text-blue-100 hover:bg-blue-500/20',
      )}
      style={{ paddingLeft: `${4 + depth * 12 + 16}px` }}
      title={`${entry.path} — ${meta.label}`}
    >
      <meta.Icon
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: meta.color }}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate font-mono text-[12px]">{entry.name}</span>
    </button>
  );
}

function CodeViewer({ path, content }: { path: string; content: string }) {
  const meta = useMemo(() => getFileMeta(basename(path)), [path]);
  const language = meta.lang ?? 'text';
  return (
    <Highlight code={content} language={language} theme={themes.vsDark}>
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={cn(className, 'm-0 min-h-full overflow-visible p-3 font-mono text-[12px] leading-[1.55]')}
          style={style}
        >
          {tokens.map((line, i) => {
            const { key: _lineKey, ...lineProps } = getLineProps({ line });
            return (
              <div key={i} {...lineProps} className="table-row">
                <span className="table-cell select-none pr-3 text-right text-[10.5px] text-muted-foreground/60">
                  {i + 1}
                </span>
                <span className="table-cell whitespace-pre-wrap break-all">
                  {line.map((token, j) => {
                    const { key: _tokenKey, ...tokenProps } = getTokenProps({ token });
                    return <span key={j} {...tokenProps} />;
                  })}
                </span>
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
}

function basename(p: string): string {
  const norm = p.replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1);
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Pull the absolute working path out of a workspace `cwd`. For local
 * workspaces this is the cwd itself; for SSH (`ssh://user@host:port/path`)
 * we strip the URL prefix.
 */
function workspaceRootPath(cwd: string): string | null {
  if (cwd.startsWith('ssh://')) {
    try {
      const u = new URL(cwd);
      return u.pathname || '/';
    } catch {
      return null;
    }
  }
  return cwd;
}
