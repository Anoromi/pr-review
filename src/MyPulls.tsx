import { useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { GitPullRequest, GitPullRequestDraft, CornerDownRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Keys } from "@/components/ui/key-hint";
import { api, scope } from "./api";
import type { MyPullRequest } from "../server/github";
import { orderStacks } from "../shared/stacks";
import { useListKeys } from "./useListKeys";

export function MyPulls({ visible, busy, currentUrl, onOpen, onLoaded }: {
  visible: boolean;
  busy: boolean;
  currentUrl?: string;
  onOpen: (url: string) => void;
  onLoaded: (pulls: MyPullRequest[]) => void;
}) {
  const t = useTranslations("app");
  const format = useFormatter();
  const [pulls, setPulls] = useState<MyPullRequest[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [order, setOrder] = useState<"stack" | "recent">("stack");
  const [index, setIndex] = useState(0);
  const filterInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const next = await api.myPulls.query(scope());
      setPulls(next);
      onLoaded(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("error"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (visible && !pulls && !loading) void refresh();
  }, [visible]);
  const stacks = pulls && orderStacks(pulls);
  const ordered =
    order === "stack"
      ? stacks
      : stacks?.toSorted((a, b) =>
          b.pull.updatedAt.localeCompare(a.pull.updatedAt),
        );
  const matching =
    ordered?.filter(({ pull }) =>
      `${pull.number} ${pull.title} ${pull.headRefName}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
    ) ?? [];
  const selected = Math.min(index, Math.max(0, matching.length - 1));
  function open(row = matching[selected]) {
    if (row && !busy) onOpen(row.pull.url);
  }
  useListKeys({
    active: visible,
    count: matching.length,
    index: selected,
    setIndex,
    onOpen: () => open(),
    container: list,
    extra: [
      { id: "listFilter", group: "list", keys: ["/"], run: () => filterInput.current?.select() },
      { id: "pullsOrder", group: "list", keys: ["o"], run: () => setOrder(order === "stack" ? "recent" : "stack") },
      { id: "pullsRefresh", group: "list", keys: ["r"], enabled: () => !loading, run: () => void refresh() },
    ],
  });
  return (
    <section hidden={!visible} className="flex min-h-0 flex-1 flex-col" aria-label={t("myPulls")}>
      <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <div className="relative w-80 max-w-full">
          <Input
            ref={filterInput}
            className="h-7 pr-8 text-[13px]"
            aria-label={t("filterPulls")}
            placeholder={t("filterPulls")}
            value={filter}
            spellCheck={false}
            onChange={(event) => { setFilter(event.target.value); setIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                if (filter) setFilter("");
                event.currentTarget.blur();
              } else if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
                open();
              } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setIndex(Math.max(0, Math.min(matching.length - 1, selected + (event.key === "ArrowDown" ? 1 : -1))));
              }
            }}
          />
          <Keys value="/" className="pointer-events-none absolute right-1.5 top-1" />
        </div>
        <span className="text-xs text-muted-foreground">
          {pulls ? t("visiblePulls", { count: matching.length }) : loading ? t("loadingPulls") : ""}
        </span>
        <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => setOrder(order === "stack" ? "recent" : "stack")}>
          {t(order === "stack" ? "stackOrder" : "recentOrder")}
          <Keys value="o" />
        </Button>
        <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={loading} onClick={() => void refresh()}>
          {t(loading ? "loadingPulls" : "refreshPulls")}
          <Keys value="r" />
        </Button>
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-3 border-b px-4 py-2 text-[13px] text-destructive">
          {error}
          <Button variant="outline" size="xs" className="ml-auto" disabled={loading} onClick={() => void refresh()}>
            {t("retry")}
          </Button>
        </div>
      )}
      <div ref={list} className="min-h-0 flex-1 overflow-auto" role="grid" aria-label={t("pullRequests")}>
        {matching.map((row, position) => {
          const { pull, depth, parent } = row;
          const active = position === selected;
          return (
            <div
              key={pull.number}
              role="row"
              aria-selected={active}
              className={`list-row grid-cols-[20px_64px_minmax(0,1fr)_minmax(0,280px)_120px_64px] ${busy ? "opacity-50" : "cursor-pointer"}`}
              onMouseDown={() => setIndex(position)}
              onClick={() => open(row)}
            >
              {pull.isDraft ? (
                <GitPullRequestDraft aria-label={t("draftPr")} className="size-3.5 text-muted-foreground" />
              ) : (
                <GitPullRequest aria-label={t("openStatus")} className="size-3.5 text-added" />
              )}
              <span className="tabular-nums text-muted-foreground">#{pull.number}</span>
              <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: order === "stack" ? depth * 18 : 0 }}>
                {order === "stack" && depth > 0 && <CornerDownRight className="size-3 shrink-0 text-muted-foreground" aria-label={t("stackParent", { number: parent ?? 0 })} />}
                <span className="truncate font-medium" title={pull.title}>{pull.title}</span>
                {pull.url === currentUrl && <span className="shrink-0 text-xs text-muted-foreground">{t("currentPullRequest")}</span>}
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground" title={pull.headRefName}>{pull.headRefName}</span>
              <span className="truncate text-xs text-muted-foreground" title={parent ? t("stackParent", { number: parent }) : pull.baseRefName}>
                {parent ? `#${parent}` : pull.baseRefName}
              </span>
              <time className="text-right text-xs text-muted-foreground" dateTime={pull.updatedAt} title={new Date(pull.updatedAt).toLocaleString()}>
                {format.dateTime(new Date(pull.updatedAt), { month: "short", day: "numeric" })}
              </time>
            </div>
          );
        })}
        {pulls && !matching.length && (
          <p className="px-4 py-8 text-[13px] text-muted-foreground">
            {t(pulls.length ? "noMatchingPulls" : "noMyPulls")}
          </p>
        )}
      </div>
    </section>
  );
}
