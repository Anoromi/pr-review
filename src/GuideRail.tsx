import { useEffect, useRef, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { Check } from "lucide-react";
import { Keys } from "./components/ui/key-hint";
import { Dot } from "./agentStatus";

export type RailTab = "map" | "files" | "commits" | "search";
export const railTabs: RailTab[] = ["map", "files", "commits", "search"];
const tabKeys: Record<RailTab, string> = { map: "M", files: "f", commits: "C", search: "*" };

/** The left rail: what to read next (map, files, commits) and search results. */
export function GuideRail({ tab, onTab, focused, mapDot, header, card, children }: {
  tab: RailTab;
  onTab: (tab: RailTab) => void;
  focused: boolean;
  /** A dot on the Map tab: the map is being written or just arrived. */
  mapDot: "warn" | "ok" | null;
  /** A line above the list: counts and keys. */
  header: ReactNode;
  /** The map job or map state card. */
  card: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("app");
  return (
    <aside className="guide-rail" data-focused={focused} aria-label={t("guide")} tabIndex={-1}>
      <div className="rail-tabs" role="tablist">
        {railTabs.map((name) => (
          <button key={name} role="tab" aria-selected={tab === name} onClick={() => onTab(name)}>
            {t(`railTab.${name}`)}
            {name === "map" && mapDot && <Dot tone={mapDot} className={mapDot === "warn" ? "pulse" : ""} />}
            <Keys value={tabKeys[name]} />
          </button>
        ))}
      </div>
      {card}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2 text-[11.5px] text-muted-foreground">{header}</div>
      {children}
    </aside>
  );
}

export type CommitRow = { sha: string; subject: string; date: string; author: string; read: boolean; chapters: number[]; uncovered: number };

/** The review's own commits, oldest first, with read ticks and the chapters they touch. */
export function CommitList({ commits, current, selected, error, onPick }: {
  commits: CommitRow[] | null;
  current?: string;
  selected: number | null;
  error: string;
  onPick: (sha: string) => void;
}) {
  const t = useTranslations("app");
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"], [aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, selected]);
  if (error) return <p className="px-3 py-2 text-xs text-destructive" role="alert">{error}</p>;
  if (!commits) return <p className="px-3 py-2 text-xs text-muted-foreground">{t("loadingCommits")}</p>;
  return (
    <nav ref={list} className="min-h-0 flex-1 overflow-auto py-1" aria-label={t("commits")}>
      {commits.map((commit, index) => (
        <button key={commit.sha} className="chapter-row" aria-current={commit.sha === current ? "true" : undefined} aria-selected={index === selected} data-read={commit.read} onClick={() => onPick(commit.sha)}>
          <span className="w-[18px] shrink-0 text-right tabular-nums text-muted-foreground">{index + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate" title={commit.subject}>{commit.subject}</span>
            <span className="mt-px flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              <span className="font-mono">{commit.sha.slice(0, 7)}</span>
              {commit.chapters.map((chapter) => <span key={chapter} className="chip">{t("chapterChip", { index: chapter + 1 })}</span>)}
              {commit.uncovered > 0 && <span className="chip">{t("uncoveredChip", { count: commit.uncovered })}</span>}
            </span>
          </span>
          {commit.read && <Check className="mt-0.5 size-3 shrink-0 text-added" aria-label={t("read")} />}
        </button>
      ))}
      {!commits.length && <p className="px-3 py-2 text-xs text-muted-foreground">{t("noCommits")}</p>}
    </nav>
  );
}

export type SearchRow = { file: string; line: number; text: string; kind: "diff" | "repo"; side: "additions" | "deletions" };

/** Matches of `/` in the diff and `*` across the repository. */
export function SearchList({ rows, diffQuery, repoWord, repoState, selected, onPick }: {
  rows: SearchRow[];
  diffQuery: string;
  repoWord: string;
  repoState: string;
  selected: number | null;
  onPick: (index: number) => void;
}) {
  const t = useTranslations("app");
  const list = useRef<HTMLElement>(null);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const section = (kind: SearchRow["kind"], title: string, empty: string) => {
    const items = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.kind === kind);
    return (
      <>
        <div className="inbox-group normal-case tracking-normal">{title}</div>
        {items.map(({ row, index }) => (
          <button key={index} className="search-row" aria-selected={index === selected} onClick={() => onPick(index)} title={`${row.file}:${row.line}`}>
            <span className="w-full truncate font-mono text-[11px] text-muted-foreground">{row.file.slice(row.file.lastIndexOf("/") + 1)}:{row.line}{row.side === "deletions" ? ` · ${t("old")}` : ""}</span>
            <span className="w-full truncate font-mono text-[11.5px]">{row.text.trim()}</span>
          </button>
        ))}
        {!items.length && <p className="px-3 py-1 text-xs text-muted-foreground">{empty}</p>}
      </>
    );
  };
  return (
    <nav ref={list} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-2" aria-label={t("railTab.search")}>
      {section("diff", diffQuery ? t("searchDiffTitle", { query: diffQuery }) : t("searchDiffNone"), diffQuery ? t("noSearchMatches") : t("searchDiffHint"))}
      {section("repo", repoWord ? t("searchRepoTitle", { word: repoWord }) : t("searchRepoNone"), repoState || (repoWord ? t("noSearchMatches") : t("searchRepoHint")))}
    </nav>
  );
}
