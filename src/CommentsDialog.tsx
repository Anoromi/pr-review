import { HotkeyButton } from "./components/ui/hotkey-button";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { Dialog } from "radix-ui";
import { useRef, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { Button } from "./components/ui/button";
import type { Comment } from "../shared/types";

export function CommentsDialog({ open, onOpenChange: setOpen, comments, onJump, renderReply }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments: Comment[];
  onJump: (comment: Comment) => void;
  renderReply: (comment: Comment, selected: boolean) => ReactNode;
}) {
  const t = useTranslations("app");
  const content = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string>();
  const index = Math.max(0, comments.findIndex((comment) => comment.id === selected));
  const comment = comments[index];
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: comments.length,
    getScrollElement: () => list,
    estimateSize: () => 280,
    getItemKey: (index) => comments[index].id,
    overscan: 2,
    gap: 12,
    paddingStart: 12,
    paddingEnd: 12,
    enabled: open,
    rangeExtractor: (range) => [...new Set([...defaultRangeExtractor(range), index])].sort((a, b) => a - b),
  });
  function cycle(direction: number) {
    if (!comments.length) return;
    const next = (index + direction + comments.length) % comments.length;
    setSelected(comments[next].id);
    virtualizer.scrollToIndex(next, { align: "start" });
  }
  function jump() {
    if (!comment) return;
    setOpen(false);
    onJump(comment);
  }
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <Dialog.Content ref={content} onOpenAutoFocus={(event) => { event.preventDefault(); content.current?.focus(); }} aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 flex h-[85vh] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border bg-background text-foreground shadow-sm"
        onKeyDown={(event) => {
          if (event.isDefaultPrevented() || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
            (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
          if (event.key === "r") {
            event.preventDefault();
            virtualizer.scrollToIndex(index, { align: "start" });
            const thread = content.current?.querySelector('[data-selected="true"]');
            const editor = thread?.querySelector<HTMLTextAreaElement>("textarea");
            if (editor) editor.focus();
            else thread?.querySelector<HTMLButtonElement>("[data-reply-action]")?.click();
          } else if (event.key === "x") {
            event.preventDefault();
            content.current?.querySelector<HTMLButtonElement>('[data-selected="true"] [data-resolve-action]')?.click();
          } else if (["t", "n", "j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            cycle(["t", "j", "ArrowDown"].includes(event.key) ? 1 : -1);
          } else if (event.key === "Enter" && !(event.target instanceof Element && event.target.closest("button, a"))) {
            event.preventDefault(); jump();
          }
        }}>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Dialog.Title className="mr-auto font-semibold">{t("comments")}</Dialog.Title>
          <span className="text-sm text-muted-foreground" aria-live="polite">{comment ? index + 1 : 0} / {comments.length}</span>
          <HotkeyButton hotkey="n" disabled={!comment} onClick={() => cycle(-1)}>{t("previousComment")}</HotkeyButton>
          <HotkeyButton hotkey="t" disabled={!comment} onClick={() => cycle(1)}>{t("nextComment")}</HotkeyButton>
          <Dialog.Close asChild><Button variant="ghost" size="sm">{t("close")}</Button></Dialog.Close>
        </div>
        <div ref={setList} className="min-h-0 flex-1 overflow-auto bg-muted px-3" tabIndex={0}>
          {!comments.length ? <p className="p-4">{t("noComments")}</p> :
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const thread = comments[item.index];
                const active = item.index === index;
                return <article key={item.key} ref={virtualizer.measureElement} data-index={item.index} data-selected={active}
                  aria-current={active ? "true" : undefined}
                  className="comment-thread absolute left-0 top-0 w-full rounded-md border bg-background"
                  style={{ transform: `translateY(${item.start}px)` }}
                  onPointerDown={() => setSelected(thread.id)} onFocusCapture={() => setSelected(thread.id)}>
                  <header className="thread-heading flex items-start gap-3 border-b px-4 py-3">
                    <span className="font-mono text-sm text-muted-foreground">{item.index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="break-all font-mono text-sm">{thread.file}</p>
                    <p className="text-xs text-muted-foreground">{thread.github ? <a href={thread.github.url} target="_blank" rel="noreferrer">{thread.github.author} · {t(thread.github.deleted ? "githubDeleted" : thread.github.outdated ? "githubOutdated" : "publishedGitHub")}</a> : t(thread.destination === "github" ? "queuedGitHub" : "localOnly")}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{t(thread.side === "deletions" ? "commentOldSide" : "commentNewSide")} · {thread.start}{thread.end !== thread.start ? `–${thread.end}` : ""}</p>
                    </div>
                    {active && <span className="text-xs font-medium">{t("selectedThread")}</span>}
                  </header>
                  <pre className="overflow-auto border-b bg-muted/40 px-4 py-3 text-xs"><code>{thread.code}</code></pre>
                  <div className="px-4 py-3">
                    <strong className="text-sm">{t("yourComment")}</strong>
                    <p className="mt-1 whitespace-pre-wrap leading-relaxed">{thread.body}</p>
                    {(thread.replies ?? []).map((reply) => <div key={reply.id} className="mt-4 border-l-2 pl-3"><strong className="text-sm">{reply.author}</strong><p className="mt-1 whitespace-pre-wrap leading-relaxed">{reply.body}</p></div>)}
                  </div>
                  <footer className="border-t px-3 py-2">{renderReply(thread, active)}</footer>
                </article>;
              })}
            </div>}
        </div>
        <div className="flex justify-end border-t px-4 py-3"><HotkeyButton variant="default" hotkey="Enter" disabled={!comment} onClick={jump}>{t("jumpToComment")}</HotkeyButton></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
