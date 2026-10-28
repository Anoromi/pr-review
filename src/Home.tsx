import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { CornerDownRight, GitBranch } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Keys } from "@/components/ui/key-hint";
import { api, scope } from "./api";
import type { MyPullRequest } from "../server/github";
import { orderStacks } from "../shared/stacks";
import { useListKeys } from "./useListKeys";
import { AgentPill, Dot, agentStatus, seenReplies, type Tone } from "./agentStatus";

export type HomeSection = "agents" | "pulls" | "branches";
type Row = {
  key: string;
  section: HomeSection;
  title: ReactNode;
  /** Text the filter matches. */
  text: string;
  detail: string;
  depth?: number;
  thread?: { title: string; working: boolean; newTurns: number };
  /** Opens the review on the thread's changes since the user last looked. */
  openChanges?: () => void;
  /** Where its review's progress lives: a PR, or a branch of a checkout. */
  target: { url: string } | { repo: string; branch: string };
  time: string;
  open: () => void;
};
type RowProgress = Awaited<ReturnType<typeof api.reviewProgress.query>>[number];

/**
 * Where reviews start: checkouts an agent thread works in, your PRs (in
 * stack order) and local branches, each with its reading progress and what
 * its agent is doing. `?checkout=` skips this and opens the review.
 */
export function Home({ section, busy, currentUrl, onPulls, onOpenPull, onOpenBranch, onOpenCheckout, buttons }: {
  section: HomeSection;
  busy: boolean;
  currentUrl?: string;
  onPulls: (pulls: MyPullRequest[]) => void;
  onOpenPull: (url: string, checkout?: string) => void;
  onOpenBranch: (branch: string, checkout?: string) => void;
  onOpenCheckout: (checkout: string, changesOf?: string) => void;
  buttons: ReactNode;
}) {
  const t = useTranslations("app");
  const format = useFormatter();
  const [pulls, setPulls] = useState<MyPullRequest[]>();
  const [home, setHome] = useState<Awaited<ReturnType<typeof api.home.query>>>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [order, setOrder] = useState<"stack" | "recent">("stack");
  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState<RowProgress[]>([]);
  const [now, setNow] = useState(Date.now());
  const filterInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [nextPulls, nextHome] = await Promise.all([api.myPulls.query(scope()), api.home.query(scope())]);
      setPulls(nextPulls);
      onPulls(nextPulls);
      setHome(nextHome);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("error"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  const stacks = pulls && orderStacks(pulls);
  const ordered = order === "stack" ? stacks : stacks?.toSorted((a, b) => b.pull.updatedAt.localeCompare(a.pull.updatedAt));
  const pullFor = (branch: string) => pulls?.find((pull) => pull.headRefName === branch);
  const agentBranches = new Set(home?.agents.map((agent) => agent.branch));
  const rows: Row[] = [
    ...(home?.agents ?? []).map((agent): Row => {
      const pull = pullFor(agent.branch);
      return {
        key: `agent:${agent.checkout}`, section: "agents",
        title: pull ? <><b>#{pull.number}</b> {pull.title}</> : agent.branch,
        text: `${pull?.number ?? ""} ${pull?.title ?? ""} ${agent.branch} ${agent.title}`, detail: agent.branch,
        thread: { ...agent, newTurns: Math.max(0, agent.latestTurn - agent.reviewedTurn) },
        target: pull ? { url: pull.url } : { repo: agent.checkout, branch: agent.branch }, time: agent.updatedAt,
        open: () => onOpenCheckout(agent.checkout), openChanges: () => onOpenCheckout(agent.checkout, agent.threadId),
      };
    }),
    ...(ordered ?? []).filter(({ pull }) => !agentBranches.has(pull.headRefName)).map(({ pull, depth, parent }): Row => ({
      key: pull.url, section: "pulls",
      title: <><b>#{pull.number}</b> {pull.title}{pull.isDraft && <span className="text-muted-foreground"> · {t("draftPr")}</span>}{order === "stack" && parent ? <span className="text-muted-foreground"> <CornerDownRight className="inline size-3" /> {t("onPull", { number: parent })}</span> : null}{pull.url === currentUrl && <span className="text-muted-foreground"> · {t("currentPullRequest")}</span>}</>,
      text: `${pull.number} ${pull.title} ${pull.headRefName}`, detail: pull.headRefName, depth: order === "stack" ? depth : 0,
      target: { url: pull.url }, time: pull.updatedAt, open: () => onOpenPull(pull.url),
    })),
    ...(home?.branches ?? []).filter((branch) => !agentBranches.has(branch.name) && !pullFor(branch.name)).map((branch): Row => ({
      key: `branch:${branch.name}`, section: "branches",
      title: branch.name, text: branch.name, detail: t("commitsAhead", { count: branch.ahead }),
      target: { repo: home!.repo, branch: branch.name }, time: branch.date, open: () => onOpenBranch(branch.name),
    })),
  ];
  const targets = JSON.stringify(rows.map((row) => row.target));
  // Progress and agent states, refreshed while Home is open.
  useEffect(() => {
    if (!rows.length) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const next = await api.reviewProgress.query({ targets: JSON.parse(targets) }); if (!stopped) setProgress(next); }
      catch (error) { if (!stopped) setError(error instanceof Error ? error.message : t("error")); }
      if (!stopped) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [targets]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const byRow = new Map(rows.map((row, position) => [row.key, progress[position]]));
  const matching = rows.filter((row) => row.text.toLowerCase().includes(filter.toLowerCase()));
  // Start on the requested section (gp, gb) once its rows are there.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !home || !pulls) return;
    started.current = true;
    setIndex(Math.max(0, matching.findIndex((row) => row.section === section)));
  }, [home, pulls]);
  const selected = Math.min(index, Math.max(0, matching.length - 1));
  function open(row = matching[selected]) {
    if (row && !busy) row.open();
  }
  useListKeys({
    active: true,
    count: matching.length,
    index: selected,
    setIndex,
    onOpen: () => open(),
    container: list,
    extra: [
      { id: "listFilter", group: "list", keys: ["/"], run: () => filterInput.current?.select() },
      { id: "pullsOrder", group: "list", keys: ["o"], run: () => setOrder(order === "stack" ? "recent" : "stack") },
      { id: "pullsRefresh", group: "list", keys: ["r"], enabled: () => !loading, run: () => void refresh() },
      { id: "changesOpen", group: "list", keys: ["g n"], enabled: () => Boolean(matching[selected]?.openChanges) && !busy, run: () => matching[selected].openChanges!() },
    ],
  });
  function newReplies(item: RowProgress | undefined) {
    const seen = item && seenReplies(item.url);
    return item && seen ? item.replies.filter((id) => !seen.has(id)).length : 0;
  }
  const withNew = rows.map((row) => ({ row, count: newReplies(byRow.get(row.key)) })).filter((item) => item.count > 0);
  const sections: Array<{ id: HomeSection; title: string; keys?: string; note?: string }> = [
    { id: "agents", title: t("homeAgents"), note: home?.agentError ? t("homeAgentsError", { error: home.agentError }) : t("homeAgentsNote") },
    { id: "pulls", title: t("homePulls"), keys: "g p" },
    { id: "branches", title: t("homeBranches"), keys: "g b", note: t("homeBranchesNote") },
  ];
  return (
    <>
      <header className="topbar gap-3 px-3">
        <b className="text-[13px]">{t("name")}</b>
        <span className="ml-auto" />
        {withNew.length > 0 && (
          <AgentPill status={{ tone: "new", parts: [] }} fallback={t("newRepliesIn", { count: withNew.reduce((sum, item) => sum + item.count, 0), where: withNew[0].row.detail })} />
        )}
        {buttons}
      </header>
      <main className="flex min-h-0 flex-1 justify-center overflow-auto">
        <div className="w-[min(1240px,100%)] px-4 py-5">
          <div className="flex items-center gap-3">
            <span className="text-base font-semibold">{t("reviews")}</span>
            <span className="truncate text-muted-foreground">{home?.repo}</span>
            <div className="relative ml-auto w-72">
              <Input ref={filterInput} className="h-7 pr-8 text-[13px]" aria-label={t("filterPulls")} placeholder={t("filterPulls")} value={filter} spellCheck={false}
                onChange={(event) => { setFilter(event.target.value); setIndex(0); }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { event.preventDefault(); if (filter) setFilter(""); event.currentTarget.blur(); }
                  else if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); open(); }
                }} />
              <Keys value="/" className="pointer-events-none absolute right-1.5 top-1.5" />
            </div>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">{t(order === "stack" ? "stackOrder" : "recentOrder")}<Keys value="o" /></span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">{t(loading ? "loadingPulls" : "refreshPulls")}<Keys value="r" /></span>
          </div>
          {error && <p role="alert" className="mt-3 text-[13px] text-destructive">{error}</p>}
          <div ref={list} role="grid" aria-label={t("reviews")}>
            {sections.map((group) => {
              const items = matching.filter((row) => row.section === group.id);
              return (
                <section key={group.id}>
                  <h2 className="home-section">{group.title}{group.keys && <Keys value={group.keys} className="normal-case" />}{group.note && <span className={`normal-case tracking-normal ${home?.agentError && group.id === "agents" ? "text-destructive" : ""}`}>· {group.note}</span>}</h2>
                  {items.map((row) => {
                    const position = matching.indexOf(row);
                    const item = byRow.get(row.key);
                    const fresh = newReplies(item);
                    const status = agentStatus(item?.agent, fresh, now);
                    const unit = item?.chapters ?? item?.files;
                    const done = unit && unit.total > 0 && unit.read === unit.total;
                    const tone: Tone | null = row.thread ? (row.thread.working ? "warn" : status.tone) : null;
                    return (
                      <div key={row.key} role="row" aria-selected={position === selected} className={`home-row ${busy ? "opacity-50" : ""}`}
                        onMouseDown={() => setIndex(position)} onClick={() => open(row)}>
                        <span>{tone ? <Dot tone={tone} /> : row.section === "branches" ? <GitBranch className="size-3.5 text-muted-foreground" /> : <Dot tone={status.tone} />}</span>
                        <span className="truncate" style={{ paddingLeft: (row.depth ?? 0) * 18 }}>{row.title}{row.thread && row.thread.newTurns > 0 && <button className="chip ml-2" onClick={(event) => { event.stopPropagation(); if (!busy) row.openChanges?.(); }}>{t("homeNewTurns", { count: row.thread.newTurns })}</button>}</span>
                        <span className="truncate font-mono text-[11.5px] text-muted-foreground">{row.detail}</span>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="bar"><i style={{ width: `${unit ? (unit.read / Math.max(1, unit.total)) * 100 : 0}%` }} /></span>
                          {!item ? t("notStarted")
                            : done ? t("homeDone", { open: item.open })
                            : item.chapters ? t("chaptersRead", { read: item.chapters.read, total: item.chapters.total })
                            : item.agent.map && item.agent.map.state !== "ready" && item.agent.map.state !== "finished" ? t("mapComing")
                            : t("filesRead", { read: item.files.read, total: item.files.total })}
                        </span>
                        <span className="flex min-w-0 items-center gap-2 text-xs">
                          {status.parts.length ? <><Dot tone={status.tone} /><span className="truncate">{status.parts.map((part) => t(`agent.${part.key}`, part.values)).join(" · ")}</span></>
                            : row.thread ? <><Dot tone={row.thread.working ? "warn" : "idle"} /><span className="truncate" title={row.thread.title}>{row.thread.working ? t("agent.working") : t("agent.idle")}</span></>
                            : <span className="text-muted-foreground">{t("noThread")}</span>}
                        </span>
                        <time className="text-right text-xs text-muted-foreground" dateTime={row.time} title={new Date(row.time).toLocaleString()}>
                          {format.relativeTime(new Date(row.time), now)}
                        </time>
                      </div>
                    );
                  })}
                  {!items.length && <p className="px-3 py-2 text-xs text-muted-foreground">{loading ? t("loadingPulls") : t("homeEmpty")}</p>}
                </section>
              );
            })}
          </div>
        </div>
      </main>
      <footer className="statusline">
        <span className="statusline-mode" data-mode="home">{t("mode.home")}</span>
        <span className="text-muted-foreground">{t("homeHelp")}</span>
      </footer>
    </>
  );
}
