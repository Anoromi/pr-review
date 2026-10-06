import { useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useTranslations } from "use-intl";
import type { MyPullRequest } from "../server/github";
import { Button } from "./components/ui/button";
import { HotkeyButton } from "./components/ui/hotkey-button";

export function PullRequestsDialog({ open, onOpenChange: setOpen, pulls, currentUrl, busy, onOpen }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pulls: Array<{ pull: MyPullRequest; depth: number }>;
  currentUrl: string;
  busy: boolean;
  onOpen: (url: string) => void;
}) {
  const t = useTranslations("app");
  const [selected, setSelected] = useState(currentUrl);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const index = Math.max(0, pulls.findIndex(({ pull }) => pull.url === selected));
  const selectedPull = pulls[index]?.pull;
  const virtualizer = useVirtualizer({
    count: pulls.length,
    getScrollElement: () => list,
    estimateSize: () => 84,
    getItemKey: (index) => pulls[index].pull.url,
    overscan: 3,
    enabled: open,
    rangeExtractor: (range) => [...new Set([...defaultRangeExtractor(range), index])].filter((index) => index < pulls.length).sort((a, b) => a - b),
  });
  useEffect(() => {
    if (open) setSelected(currentUrl);
  }, [open]);
  useEffect(() => {
    if (open && list && pulls.length) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [open, list, selected, pulls.length]);
  function cycle(direction: number) {
    if (!pulls.length) return;
    setSelected(pulls[(index + direction + pulls.length) % pulls.length].pull.url);
    content.current?.focus();
  }
  function jump(url = selectedPull?.url) {
    if (!url || busy) return;
    setOpen(false);
    if (url !== currentUrl) onOpen(url);
  }
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <Dialog.Content ref={content} aria-describedby={undefined}
        onOpenAutoFocus={(event) => { event.preventDefault(); content.current?.focus(); }}
        className="fixed left-1/2 top-1/2 z-50 flex h-[min(640px,85vh)] w-[min(760px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border bg-background text-foreground shadow-sm"
        onKeyDown={(event) => {
          if (event.isDefaultPrevented() || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
          if (["t", "n", "j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            cycle(["t", "j", "ArrowDown"].includes(event.key) ? 1 : -1);
          } else if (event.key === "Enter" && !(event.target instanceof Element && event.target.closest("button"))) {
            event.preventDefault(); jump();
          }
        }}>
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <Dialog.Title className="mr-auto font-semibold">{t("currentStack")}</Dialog.Title>
          <span className="text-sm text-muted-foreground" aria-live="polite">{selectedPull ? index + 1 : 0} / {pulls.length}</span>
          <HotkeyButton hotkey="n" disabled={!selectedPull} onClick={() => cycle(-1)}>{t("previousComment")}</HotkeyButton>
          <HotkeyButton hotkey="t" disabled={!selectedPull} onClick={() => cycle(1)}>{t("nextComment")}</HotkeyButton>
          <Dialog.Close asChild><Button variant="ghost" size="sm">{t("close")}</Button></Dialog.Close>
        </div>
        <div ref={setList} className="min-h-0 flex-1 overflow-auto" tabIndex={0}>
          {!pulls.length ? <p className="p-4 text-sm text-muted-foreground">{t("noStack")}</p> :
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const { pull, depth } = pulls[item.index];
                const active = item.index === index;
                return <button key={item.key} ref={virtualizer.measureElement} data-index={item.index} data-selected={active}
                  aria-current={pull.url === currentUrl ? "page" : undefined}
                  disabled={busy}
                  className="absolute left-0 top-0 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-b border-l-2 border-l-transparent px-4 py-4 text-left hover:bg-secondary/50 data-[selected=true]:border-l-foreground data-[selected=true]:bg-secondary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:opacity-50"
                  style={{ transform: `translateY(${item.start}px)` }}
                  onFocus={() => setSelected(pull.url)} onClick={() => jump(pull.url)}>
                  <span className="text-sm font-medium">{pull.title}</span>
                  <span className="text-sm tabular-nums text-muted-foreground" aria-label={t("reviewPosition", { number: depth + 1 })}>{depth + 1}</span>
                  <span className="truncate text-xs text-muted-foreground">#{pull.number} · {pull.headRefName}</span>
                  {pull.url === currentUrl && <span className="text-xs text-muted-foreground">{t("currentPullRequest")}</span>}
                </button>;
              })}
            </div>}
        </div>
        <div className="flex justify-end border-t px-4 py-3"><HotkeyButton hotkey="Enter" disabled={!selectedPull || busy} onClick={() => jump()}>{t("switchPullRequest")}</HotkeyButton></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
