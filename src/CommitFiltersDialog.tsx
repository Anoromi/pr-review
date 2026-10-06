import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { ArrowLeft, Check, GitBranch, Search, User, X } from "lucide-react";
import { CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator } from "./components/ui/command";

type Page = "commands" | "search" | "author" | "branch";

export type CommitFilterPage = Page;

export function CommitFiltersDialog({ startPage, branch, branches, author, authors, search, busy, onBranch, onAuthor, onSearch, onClear, onReviewBranch, open, onOpenChange, onOpenPage }: {
  branch: string; branches: string[]; author: string; authors: string[]; search: string; busy: boolean;
  onBranch: (branch: string) => void; onAuthor: (author: string) => void;
  onSearch: (search: string) => void; onClear: () => void; onReviewBranch: () => void;
  open: boolean; onOpenChange: (open: boolean) => void; startPage: Page; onOpenPage: (page: Page) => void;
}) {
  const t = useTranslations("app");
  const [page, setPage] = useState<Page>("commands");
  const [query, setQuery] = useState("");
  function navigate(next: Page) {
    setPage(next);
    setQuery(next === "search" ? search : "");
  }
  function execute(action: () => void) {
    action();
    onOpenChange(false);
  }
  useEffect(() => {
    if (open) navigate(startPage);
  }, [open]);

  const pageLabel = page === "author" ? t("filterByAuthor") : page === "branch" ? t("branch") : t("commitSearchLabel");
  return <>
    {(search || author) && <div className="flex flex-wrap gap-1.5">
      {([
        { page: "search" as const, label: t("commitSearchLabel"), value: search, clear: () => onSearch("") },
        { page: "author" as const, label: t("filterByAuthor"), value: author, clear: () => onAuthor("") },
      ]).filter(filter => filter.value).map(filter => <div key={filter.page} className="flex min-w-0 max-w-full items-center rounded-md border text-xs">
        <button className="min-w-0 truncate px-2 py-1 text-left hover:bg-secondary" title={filter.value}
          onClick={() => onOpenPage(filter.page)}>{filter.label}: {filter.value}</button>
        <button className="shrink-0 px-1.5 py-1 hover:bg-secondary" aria-label={t("removeCommitFilter", { filter: filter.label })}
          onClick={filter.clear}><X className="size-3" /></button>
      </div>)}
    </div>}
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t("commitFilters")} description={t("filterCommandDescription")}
      showCloseButton={false} onEscapeKeyDown={(event) => {
        if (page !== "commands") { event.preventDefault(); navigate("commands"); }
      }}>
      {page !== "commands" && <button className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground hover:bg-secondary"
        onClick={() => navigate("commands")}><ArrowLeft className="size-3" />{pageLabel}</button>}
      <CommandInput key={page} aria-label={page === "commands" ? t("searchFilterCommands") : pageLabel} autoFocus value={query} onValueChange={setQuery}
        placeholder={page === "commands" ? t("searchFilterCommands") : page === "search" ? t("searchCommits") : page === "author" ? t("allAuthors") : t("searchBranches")}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if ((event.key === "Backspace" && !query) && page !== "commands") {
            event.preventDefault(); event.stopPropagation(); navigate("commands");
          }
        }} />
      <CommandList>
        <CommandEmpty>{t("noFilterCommands")}</CommandEmpty>
        {page === "commands" && <>
          <CommandGroup heading={t("commitFilters")}>
            <CommandItem disabled={busy || !branch} onSelect={() => execute(onReviewBranch)}><GitBranch />{t("reviewBranchAgainstMain")}</CommandItem>
            <CommandItem onSelect={() => navigate("search")}><Search />{t("commitSearchLabel")}</CommandItem>
            <CommandItem disabled={busy} onSelect={() => navigate("author")}><User />{t("filterByAuthor")}</CommandItem>
            <CommandItem disabled={busy} onSelect={() => navigate("branch")}><GitBranch />{t("switchCommitBranch")}</CommandItem>
          </CommandGroup>
          {(search || author) && <><CommandSeparator /><CommandGroup>
            {search && <CommandItem onSelect={() => execute(() => onSearch(""))}><X />{t("clearCommitSearch")}</CommandItem>}
            {author && <CommandItem onSelect={() => execute(() => onAuthor(""))}><X />{t("allAuthors")}</CommandItem>}
            <CommandItem onSelect={() => execute(onClear)}><X />{t("clearCommitFilters")}</CommandItem>
          </CommandGroup></>}
        </>}
        {page === "search" && <CommandGroup>
          <CommandItem value={query || t("clearCommitSearch")} onSelect={() => execute(() => onSearch(query.trim()))}>
            <Search />{query.trim() ? t("applyCommitSearch", { query: query.trim() }) : t("clearCommitSearch")}
          </CommandItem>
        </CommandGroup>}
        {page === "author" && <CommandGroup heading={t("filterByAuthor")}>
          <CommandItem value={t("allAuthors")} onSelect={() => execute(() => onAuthor(""))}>{t("allAuthors")}{!author && <Check className="ml-auto" />}</CommandItem>
          {authors.map(email => <CommandItem key={email} value={email} onSelect={() => execute(() => onAuthor(email))}>
            {email}{author === email && <Check className="ml-auto" />}
          </CommandItem>)}
        </CommandGroup>}
        {page === "branch" && <CommandGroup heading={t("branch")}>
          {branches.map(name => <CommandItem key={name} value={name} onSelect={() => execute(() => onBranch(name))}>
            {name}{branch === name && <Check className="ml-auto" />}
          </CommandItem>)}
        </CommandGroup>}
      </CommandList>
    </CommandDialog>
  </>;
}
