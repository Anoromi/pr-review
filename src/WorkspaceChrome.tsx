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

/** Kept outside React state so moving the cursor repaints only the status line. */
export const cursorPosition = createStore<DiffCursor | null>(null);

type Stats = { added: number; removed: number };

function split(name: string) {
  const slash = name.lastIndexOf("/") + 1;
  return [name.slice(0, slash), name.slice(slash)];
}

export const FileSidebar = memo(function FileSidebar({ files, active, viewed, stats, comments, onPick }: {
  files: FileDiffMetadata[];
  active: string;
  viewed: string[];
  stats: Map<string, Stats>;
  comments: Map<string, number>;
  onPick: (file: string) => void;
}) {
  const t = useTranslations("app");
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const seen = new Set(viewed);
  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="font-semibold">{t("files")}</span>
        <span className="tabular-nums text-muted-foreground">{t("progress", { viewed: viewed.length, total: files.length })}</span>
        <Keys value="f" className="ml-auto" />
      </div>
      <div className="h-0.5 shrink-0 bg-border" role="progressbar" aria-label={t("viewed")} aria-valuemin={0} aria-valuemax={files.length} aria-valuenow={viewed.length}>
        <div className="h-full bg-added" style={{ width: `${(viewed.length / Math.max(1, files.length)) * 100}%` }} />
      </div>
      <nav ref={list} className="min-h-0 flex-1 overflow-auto py-1" aria-label={t("files")}>
        {files.map((file, index) => {
          const [directory, basename] = split(file.name);
          const previous = index > 0 ? split(files[index - 1].name)[0] : null;
          const count = comments.get(file.name) ?? 0;
          const fileStats = stats.get(file.name);
          const current = active === file.name;
          return (
            <div key={file.name}>
              {directory !== previous && directory && (
                <div className="truncate px-3 pb-0.5 pt-2 font-mono text-[11px] text-muted-foreground [direction:rtl] text-left" title={directory}>
                  <bdi>{directory}</bdi>
                </div>
              )}
              <button
                className="file-row"
                aria-current={current ? "true" : undefined}
                data-viewed={seen.has(file.name)}
                title={file.name}
                onClick={() => onPick(file.name)}
              >
                <span className="flex w-3.5 shrink-0 justify-center">
                  {seen.has(file.name) && <Check className="size-3 text-added" aria-label={t("viewed")} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{basename}</span>
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
    </aside>
  );
});

export function FilePicker({ open, onOpenChange, files, viewed, comments, onPick }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: FileDiffMetadata[];
  viewed: string[];
  comments: Map<string, number>;
  onPick: (file: string) => void;
}) {
  const t = useTranslations("app");
  const seen = new Set(viewed);
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

export function StatusLine({ mode, fallbackFile, fileIndex, fileCount, selection, search, draft, viewed, total, saving, path }: {
  mode: "normal" | "visual" | "visualLine";
  fallbackFile: string;
  fileIndex: number;
  fileCount: number;
  selection: string;
  search?: { query: string; index: number; total: number };
  draft?: string;
  viewed: number;
  total: Stats;
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
      <span className="shrink-0 text-muted-foreground">{t("progress", { viewed, total: fileCount })}</span>
      <span className="flex shrink-0 gap-1.5">
        <span className="text-added">+{total.added}</span>
        <span className="text-removed">−{total.removed}</span>
      </span>
      <span className="max-w-[26ch] shrink truncate text-muted-foreground [direction:rtl]" title={path}>
        <bdi>{saving ? t("saving") : path}</bdi>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground"><Keys value="?" /><Keys value=":" /></span>
    </footer>
  );
}
