import { memo, useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import { Check, MessageSquare } from "lucide-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command";
import { Keys } from "./components/ui/key-hint";
import type { DiffCursor } from "./diffCursor";
import { createStore, pendingKeys, useStore } from "./keys";
import type { api } from "./api";

/** Kept outside React state so moving the cursor repaints only the status line. */
export const cursorPosition = createStore<DiffCursor | null>(null);

type Stats = { added: number; removed: number };

function split(name: string) {
  const slash = name.lastIndexOf("/") + 1;
  return [name.slice(0, slash), name.slice(slash)];
}

/** The review's files by directory with read ticks, comment counts and new replies: the rail's Files tab. */
export const FileList = memo(function FileList({ files, active, selected, read, filtered, stats, comments, unread, onPick }: {
  files: FileDiffMetadata[];
  active: string;
  /** The keyboard selection while the rail has focus. */
  selected: number | null;
  read: Set<string>;
  /** Files matching the repository's filters: collapsed by default, dimmed here. */
  filtered?: Set<string>;
  stats: Map<string, Stats>;
  comments: Map<string, number>;
  /** Unread agent replies per file. */
  unread: Map<string, number>;
  onPick: (file: string) => void;
}) {
  const t = useTranslations("app");
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"], [aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, selected]);
  return (
    <nav ref={list} className="min-h-0 flex-1 overflow-auto py-1" aria-label={t("files")}>
      {files.map((file, index) => {
        const [directory, basename] = split(file.name);
        const previous = index > 0 ? split(files[index - 1].name)[0] : null;
        const count = comments.get(file.name) ?? 0;
        const fresh = unread.get(file.name) ?? 0;
        const fileStats = stats.get(file.name);
        return (
          <div key={file.name}>
            {directory !== previous && directory && (
              <div className="truncate px-3 pb-0.5 pt-2 font-mono text-[11px] text-muted-foreground [direction:rtl] text-left" title={directory}>
                <bdi>{directory}</bdi>
              </div>
            )}
            <button
              className="file-row"
              aria-current={active === file.name ? "true" : undefined}
              aria-selected={index === selected}
              data-viewed={read.has(file.name)}
              title={file.name}
              onClick={() => onPick(file.name)}
            >
              <span className="flex w-3.5 shrink-0 justify-center">
                {read.has(file.name) && <Check className="size-3 text-added" aria-label={t("read")} />}
              </span>
              <span className={`min-w-0 flex-1 truncate ${filtered?.has(file.name) ? "text-muted-foreground" : ""}`}>{basename}</span>
              {fresh > 0 && (
                <span className="flex shrink-0 items-center gap-1 font-semibold" title={t("newReplies", { count: fresh })}>
                  <span className="dot" data-tone="new" />{fresh}
                </span>
              )}
              {count > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground" title={t("commentCount", { count })}>
                  <MessageSquare className="size-3" />{count}
                </span>
              )}
              {fileStats && (
                <span className="flex shrink-0 gap-1.5 font-mono text-[10.5px]">
                  <span className="text-added">+{fileStats.added}</span>
                  <span className="text-removed">−{fileStats.removed}</span>
                </span>
              )}
            </button>
          </div>
        );
      })}
      {!files.length && <p className="px-3 py-4 text-xs text-muted-foreground">{t("emptyDiff")}</p>}
    </nav>
  );
});

export function FilePicker({ open, onOpenChange, files, read: seen, comments, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: FileDiffMetadata[];
  read: Set<string>;
  comments: Map<string, number>;
  onPick: (file: string) => void;
}) {
  const t = useTranslations("app");
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t("files")} description={t("filterLabel")} showCloseButton={false} className="top-[18%] translate-y-0 sm:max-w-2xl">
      <CommandInput placeholder={t("filter")} spellCheck={false} />
      <CommandList className="max-h-[min(460px,60vh)]">
        <CommandEmpty>{t("noMatches")}</CommandEmpty>
        {open && files.map((file) => {
          const [directory, basename] = split(file.name);
          const count = comments.get(file.name) ?? 0;
          return (
            <CommandItem key={file.name} value={file.name} className="mx-1 gap-2 py-1.5 text-[13px]"
              onSelect={() => { onOpenChange(false); setTimeout(() => onPick(file.name), 60); }}>
              <span className="flex w-3.5 shrink-0 justify-center">{seen.has(file.name) && <Check className="size-3 text-added" />}</span>
              <span className="shrink-0 font-medium">{basename}</span>
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{directory}</span>
              {count > 0 && <span className="ml-auto flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"><MessageSquare className="size-3" />{count}</span>}
            </CommandItem>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}

export type AgentThread = Awaited<ReturnType<typeof api.threads.query>>[number];

/** Picks the T3 Code thread that questions go to. */
export function ThreadPicker({ open, onOpenChange, threads, current, error, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threads: AgentThread[];
  current?: string;
  error: string;
  onPick: (id: string) => void;
}) {
  const t = useTranslations("app");
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t("agentThreads")} description={t("agentThreadsDescription")} showCloseButton={false} className="top-[18%] translate-y-0 sm:max-w-2xl">
      <CommandInput placeholder={t("filterThreads")} spellCheck={false} />
      <CommandList className="max-h-[min(460px,60vh)]">
        <CommandEmpty>{error || t("noAgentThread")}</CommandEmpty>
        {open && threads.map((thread) => (
          <CommandItem key={thread.id} value={`${thread.title} ${thread.id}`} className="mx-1 gap-2 py-1.5 text-[13px]"
            onSelect={() => { onPick(thread.id); onOpenChange(false); }}>
            <span className="flex w-3.5 shrink-0 justify-center">{thread.id === current && <Check className="size-3" />}</span>
            <span className="min-w-0 truncate font-medium">{thread.title}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{new Date(thread.updatedAt).toLocaleString()}</span>
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

export function StatusLine({ mode, fallbackFile, fileIndex, fileCount, selection, search, draft, saving, path }: {
  mode: "normal" | "visual" | "visualLine" | "file";
  fallbackFile: string;
  fileIndex: number;
  fileCount: number;
  selection: string;
  search?: { query: string; index: number; total: number };
  draft?: string;
  saving: boolean;
  path: string;
}) {
  const t = useTranslations("app");
  const position = useStore(cursorPosition);
  const pending = useStore(pendingKeys);
  return (
    <footer className="statusline">
      <span className="statusline-mode" data-mode={mode}>{t(`mode.${mode}`)}</span>
      <span className="min-w-0 truncate" title={position?.id ?? fallbackFile}>
        {position?.id ?? fallbackFile}
        {position && <span className="text-muted-foreground">:{position.line} · {t(position.side === "deletions" ? "old" : "new")}</span>}
      </span>
      {fileCount > 0 && <span className="shrink-0 text-muted-foreground">{fileIndex + 1}/{fileCount}</span>}
      {selection && <span className="shrink-0">{selection}</span>}
      {search && (
        <span className="shrink-0">
          /{search.query}{" "}
          <span className="text-muted-foreground">{search.total ? `${search.index + 1}/${search.total}` : t("noSearchMatches")}</span>
        </span>
      )}
      {draft && <span className="flex shrink-0 items-center gap-1.5">{t("draft")}<Keys value="c" /></span>}
      <span className="ml-auto shrink-0 font-semibold" aria-live="polite">{pending}</span>
      <span className="shrink-0 text-muted-foreground">{saving ? t("saving") : t("savedState")}</span>
      <span className="max-w-[40ch] shrink truncate text-muted-foreground [direction:rtl]" title={path}>
        <bdi>{path}</bdi>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground"><Keys value="?" /><Keys value=":" /></span>
    </footer>
  );
}
