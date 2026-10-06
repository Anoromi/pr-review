import { CommitFiltersDialog, type CommitFilterPage } from "./CommitFiltersDialog";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { toast } from "sonner";
import { GitBranch } from "lucide-react";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { Keys } from "./components/ui/key-hint";
import { useListKeys } from "./useListKeys";

export function BranchView({ visible, initialBranch, currentCommit, busy, onOpen }: {
  visible: boolean; initialBranch?: string; currentCommit?: string; busy: boolean;
  onOpen: (branch: string, commit?: string) => void;
}) {
  const t = useTranslations("app");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState(initialBranch ?? "");
  const [commits, setCommits] = useState<Array<{ sha: string; date: string; author: string; subject: string }>>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [author, setAuthor] = useState("");
  const [filtersPage, setFiltersPage] = useState<CommitFilterPage | null>(null);
  const [search, setSearch] = useState("");
  const [more, setMore] = useState(false);
  const [limit, setLimit] = useState(0);
  const [loading, setLoading] = useState(false);
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible || branches.length) return;
    let alive = true;
    api.branches.query().then((rows) => { if (alive) { setBranches(rows); setBranch((old) => rows.includes(old) ? old : rows[0] ?? ""); } }).catch((error) => toast.error(error.message));
    return () => { alive = false; };
  }, [visible]);
  useEffect(() => {
    if (!branch) return;
    let alive = true;
    setAuthors([]);
    api.branchAuthors.query({ branch }).then((rows) => { if (alive) setAuthors(rows); })
      .catch((error) => { if (alive) toast.error(error.message); });
    return () => { alive = false; };
  }, [branch]);
  useEffect(() => {
    if (!branch) return;
    let alive = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
    api.branchCommits.query({ branch, skip: limit, author: author || undefined, search }).then((result) => {
      if (alive) { setCommits((previous) => limit ? [...previous, ...result.commits] : result.commits); setMore(result.more); }
    }).catch((error) => { if (alive) toast.error(error.message); }).finally(() => { if (alive) setLoading(false); });
    }, search ? 250 : 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [branch, limit, author, search]);
  function resetPagination() {
    setCommits([]);
    setMore(false);
    setLimit(0);
    setIndex(0);
  }
  const selected = Math.min(index, Math.max(0, commits.length - 1));
  // Reaching the last loaded commit pulls in the next page.
  useEffect(() => {
    if (visible && more && !loading && commits.length && selected === commits.length - 1) setLimit(commits.length);
  }, [visible, selected, commits.length, more, loading]);
  useListKeys({
    active: visible,
    count: commits.length,
    index: selected,
    setIndex,
    onOpen: () => { if (!busy && commits[selected]) onOpen(branch, commits[selected].sha); },
    container: list,
    extra: [
      { id: "branchSwitch", group: "list", keys: ["b"], run: () => setFiltersPage("branch") },
      { id: "branchSearch", group: "list", keys: ["/"], run: () => setFiltersPage("search") },
      { id: "branchAuthor", group: "list", keys: ["a"], run: () => setFiltersPage("author") },
      { id: "branchFilters", group: "list", keys: ["f"], run: () => setFiltersPage("commands") },
      { id: "branchCompare", group: "list", keys: ["m"], enabled: () => !busy && Boolean(branch), run: () => onOpen(branch) },
      { id: "branchClear", group: "list", keys: ["x"], enabled: () => Boolean(search || author), run: () => { setAuthor(""); setSearch(""); resetPagination(); } },
    ],
  });
  return <section hidden={!visible} className="flex min-h-0 flex-1 flex-col" aria-label={t("branches")}>
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5">
      <Button variant="outline" size="xs" className="max-w-[40%] font-mono" title={branch} onClick={() => setFiltersPage("branch")}>
        <GitBranch /><span className="truncate">{branch || t("branch")}</span><Keys value="b" />
      </Button>
      <CommitFiltersDialog branch={branch} branches={branches} author={author} authors={authors}
        onReviewBranch={() => onOpen(branch)} search={search} busy={busy}
        open={filtersPage !== null} startPage={filtersPage ?? "commands"} onOpenPage={setFiltersPage}
        onOpenChange={(open) => { if (!open) setFiltersPage(null); }}
        onBranch={(next) => { if (next !== branch) { setBranch(next); setAuthor(""); resetPagination(); } }}
        onAuthor={(next) => { if (next !== author) { setAuthor(next); resetPagination(); } }}
        onSearch={(next) => { setSearch(next); resetPagination(); }}
        onClear={() => { setAuthor(""); setSearch(""); resetPagination(); }} />
      <Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => setFiltersPage("search")}>{t("commitSearchLabel")}<Keys value="/" /></Button>
      <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setFiltersPage("author")}>{t("filterByAuthor")}<Keys value="a" /></Button>
      <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={busy || !branch} onClick={() => onOpen(branch)}>{t("reviewBranchAgainstMain")}<Keys value="m" /></Button>
    </div>
    <div ref={list} className="min-h-0 flex-1 overflow-auto" role="grid" aria-label={t("commits")}>
      {commits.map((commit, position) => <div key={commit.sha} role="row" aria-selected={position === selected}
        className={`list-row grid-cols-[76px_minmax(0,1fr)_minmax(0,220px)_150px] ${busy ? "opacity-50" : "cursor-pointer"}`}
        onMouseDown={() => setIndex(position)} onClick={() => { if (!busy) onOpen(branch, commit.sha); }}>
        <span className="font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 8)}</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium" title={commit.subject}>{commit.subject}</span>
          {currentCommit === commit.sha && <span className="shrink-0 text-xs text-muted-foreground">{t("currentCommit")}</span>}
        </span>
        <span className="truncate text-xs text-muted-foreground" title={commit.author}>{commit.author}</span>
        <span className="text-right text-xs text-muted-foreground">{commit.date}</span>
      </div>)}
      {!loading && branch && !commits.length && <p className="px-4 py-8 text-[13px] text-muted-foreground">{t("noMatchingCommits")}</p>}
      {loading && <p className="px-4 py-2 text-xs text-muted-foreground">{t("loadingCommits")}</p>}
    </div>
  </section>;
}
