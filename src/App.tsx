import { GitHubReviewDialog } from "./GitHubReviewDialog";
import { BranchView } from "./BranchView";
import { PullRequestsDialog } from "./PullRequestsDialog";
import { CommandPalette, KeyboardHelp, type PalettePage } from "./CommandPalette";
import { Toaster, toast } from "sonner";
import { orderStacks } from "../shared/stacks";
import type { MyPullRequest } from "../server/github";
import { Button } from "@/components/ui/button";
import { Keys } from "@/components/ui/key-hint";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { api, scope, setReviewParam } from "./api";
import type { Review } from "../shared/types";
import { Workspace } from "./Workspace";
import { MyPulls } from "./MyPulls";
import { installKeys, useCommands } from "./keys";

type View = "pulls" | "branches" | "review";

export class ErrorBoundary extends Component<
  { children: ReactNode; message: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className="px-4 py-3 text-[13px] text-destructive" role="alert">
        {this.props.message}
      </p>
    ) : (
      this.props.children
    );
  }
}

function ViewTab({ active, keys, onClick, children }: {
  active: boolean; keys?: string; onClick: () => void; children: ReactNode;
}) {
  return (
    <button className="view-tab" aria-current={active ? "page" : undefined} onClick={onClick}>
      {children}
      {keys && <Keys value={keys} />}
    </button>
  );
}

export function App() {
  const t = useTranslations("app");
  const [palette, setPalette] = useState<PalettePage | null>(null);
  const [help, setHelp] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [review, setReview] = useState<Review>();
  const [stackPulls, setStackPulls] = useState<MyPullRequest[]>([]);
  const [view, setView] = useState<View>(() => {
    const params = new URLSearchParams(location.search);
    return params.has("review") ? "review" : "pulls";
  });
  // Bumped to remount the branch view on a branch (a checkout without a PR).
  const [branchFocus, setBranchFocus] = useState<{ branch: string; n: number }>();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [path, setPath] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("pr-review:theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {}
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => installKeys(), []);
  const sequence = useRef(0);

  function report(error: unknown) {
    toast.error(error instanceof Error ? error.message : t("error"), { id: "app-error" });
  }
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    // `?checkout=` comes from hyprnav: a T3 thread's slot points this tab at
    // the directory the thread works in, and the tab reviews that checkout's
    // repository: its open PR for the current branch, or else the branch's
    // commits. The parameter stays put. A `review` next to it is kept on a
    // reload of the same checkout; arriving from another checkout, it is the
    // previous checkout's and is dropped.
    const checkout = params.get("checkout");
    const reviewId = params.get("review");
    let sameCheckout = false;
    try {
      sameCheckout = sessionStorage.getItem("pr-review:last-checkout") === checkout;
      if (checkout) sessionStorage.setItem("pr-review:last-checkout", checkout);
    } catch {}
    if (checkout && reviewId && sameCheckout && /^[a-f0-9]{24}$/.test(reviewId)) {
      api.myPulls.query(scope()).then(setStackPulls).catch(report);
      void switchReview(reviewId);
      return;
    }
    if (checkout) {
      if (reviewId) setReviewParam(undefined);
      setView("pulls");
      api.myPulls.query(scope()).then(setStackPulls).catch(report);
      api.checkout.query({ path: checkout }).then((target) => {
        if (target.pullError) toast.warning(t("checkoutPullUnknown", { branch: target.branch ?? "", error: target.pullError }), { id: "checkout-pull" });
        if (target.pull) void open(target.pull.url);
        else if (target.branch) { setBranchFocus((old) => ({ branch: target.branch!, n: (old?.n ?? 0) + 1 })); setView("branches"); }
        else setView("pulls");
      }).catch((error) => { setView("pulls"); report(error); });
      return;
    }
    api.myPulls.query(scope()).then(setStackPulls).catch(report);
    const id = params.get("review");
    if (id && /^[a-f0-9]{24}$/.test(id)) void switchReview(id);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("pr-review:theme", theme); } catch {}
  }, [theme]);
  useEffect(() => {
    if (!review) return;
    setReviewParam(review.id);
    let cancelled = false;
    api.export
      .query({ id: review.id })
      .then((result) => {
        if (!cancelled) setPath(result.path);
      })
      .catch(report);
    return () => {
      cancelled = true;
    };
  }, [review?.id]);
  useEffect(() => {
    if (!review || saving || busy) return;
    const id = review.id;
    const request = sequence.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function sync() {
      try {
        const next = await api.comments.query({ id });
        if (!stopped && request === sequence.current) setReview((current) =>
          current?.id === id && JSON.stringify(current.comments) !== JSON.stringify(next.comments)
            ? { ...current, comments: next.comments, github: next.github } : current);
      } catch (error) { if (!stopped) report(error); }
      if (!stopped) timer = setTimeout(sync, 2000);
    }
    void sync();
    return () => { stopped = true; clearTimeout(timer); };
  }, [review?.id, saving, busy]);

  async function openCommit(branch: string, commit?: string) {
    const request = ++sequence.current;
    setBusy(true);
    try {
      const next = commit ? await api.openCommit.mutate({ ...scope(), branch, commit }) : await api.openBranch.mutate({ ...scope(), branch });
      if (request !== sequence.current) return;
      setReview(next); setView("review");
    } catch (error) { if (request === sequence.current) report(error); }
    finally { if (request === sequence.current) setBusy(false); }
  }
  async function open(target: string) {
    const request = ++sequence.current;
    setBusy(true);
    toast.dismiss("app-error");
    try {
      const next = await api.open.mutate({ ...scope(), url: target });
      if (request !== sequence.current) return;
      if (review?.source.url === next.source.url)
        toast.success(t(review.id === next.id ? "upToDate" : "newRevision"));
      setReview(next);
      setView("review");
    } catch (error) {
      if (request === sequence.current) report(error);
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }

  async function switchReview(id: string) {
    if (!id) return;
    const request = ++sequence.current;
    setBusy(true);
    toast.dismiss("app-error");
    try {
      const next = await api.get.query({ id });
      if (request === sequence.current) {
        setReview(next);
        setView("review");
      }
    } catch (error) {
      if (request === sequence.current) report(error);
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }

  async function change(operation: () => Promise<Review>) {
    setSaving(true);
    toast.dismiss("app-error");
    try {
      const next = await operation();
      setReview(next);
      return true;
    } catch (error) {
      report(error);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function exportReview(copy: boolean) {
    if (!review) return;
    try {
      const result = await api.export.query({ id: review.id });
      if (copy) await navigator.clipboard.writeText(result.markdown);
      else {
        const blob = URL.createObjectURL(
          new Blob([result.markdown], { type: "text/markdown;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = blob;
        link.download = `review-${new URL(review.source.url).pathname.split("/").filter(Boolean).join("-")}-${(review.source.kind === "local" ? review.id : review.revision).slice(0, 7)}.md`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(blob), 1000);
      }
      toast.success(t(copy ? "copied" : "exported"));
    } catch (error) {
      report(error);
    }
  }

  const orderedStackPulls = orderStacks(stackPulls);
  const activeIndex = orderedStackPulls.findIndex(
    ({ pull }) => pull.url === review?.source.url,
  );
  let stackStart = activeIndex;
  while (stackStart > 0 && orderedStackPulls[stackStart].depth > 0)
    stackStart--;
  let stackEnd = activeIndex + 1;
  while (
    stackEnd < orderedStackPulls.length &&
    orderedStackPulls[stackEnd].depth > 0
  )
    stackEnd++;
  const currentStack =
    activeIndex < 0 ? [] : orderedStackPulls.slice(stackStart, stackEnd);

  const branchReview = review?.source.kind === "local" && Boolean(review.source.branchReview);
  const reviewing = view === "review" && Boolean(review);
  const idle = !busy && !saving;
  function reload() {
    if (!review) return;
    if (review.source.kind === "local" && review.source.branchReview)
      void openCommit(review.source.branch, review.source.branchComparison ? undefined : review.revision);
    else void open(review.source.url);
  }
  const githubUrl = !review
    ? ""
    : review.source.kind === "local" && review.source.branchReview && !review.source.branchComparison
      ? `${review.source.url.replace(/^(https:\/\/github\.com\/[^/]+\/[^/]+).*$/, "$1")}/commit/${review.revision}`
      : review.source.url;
  async function copyAgentPath() {
    if (!review) return;
    try {
      const result = await api.comments.query({ id: review.id });
      await navigator.clipboard.writeText(`${result.directory}/comments.json`);
      toast.success(t("agentPathCopied"));
    } catch (error) { report(error); }
  }
  useCommands([
    { id: "palette", group: "app", keys: [":", "Ctrl+k"], hidden: true, run: () => setPalette("commands") },
    { id: "help", group: "app", keys: ["?"], run: () => setHelp(true) },
    { id: "goPulls", group: "app", keys: ["g p"], run: () => setView("pulls") },
    { id: "goBranches", group: "app", keys: ["g b"], run: () => setView("branches") },
    { id: "backToReview", group: "app", keys: ["Escape", "g v"], enabled: () => view !== "review" && Boolean(review), run: () => setView("review") },
    { id: "openUrl", group: "app", keys: ["g u"], run: () => setPalette("url") },
    { id: "theme", group: "app", keys: ["g t"], run: () => setTheme(theme === "dark" ? "light" : "dark") },
    { id: "stack", group: "review", keys: ["p", "Alt+p"], enabled: () => reviewing && !branchReview, run: () => setStackOpen(true) },
    { id: "githubReview", group: "review", keys: ["g s"], enabled: () => reviewing, run: () => setGithubOpen(true) },
    { id: "reload", group: "review", keys: ["g r"], enabled: () => reviewing && idle, run: reload },
    { id: "openGithub", group: "review", keys: ["g o"], enabled: () => reviewing, run: () => window.open(githubUrl, "_blank", "noreferrer") },
    { id: "copyMarkdown", group: "review", keys: ["g m"], enabled: () => reviewing && !saving, run: () => void exportReview(true) },
    { id: "downloadMarkdown", group: "review", keys: ["g d"], enabled: () => reviewing && !saving, run: () => void exportReview(false) },
    { id: "copyAgentPath", group: "review", keys: ["g a"], enabled: () => reviewing, run: () => void copyAgentPath() },
  ]);

  return (
    <div className="app">
      <Toaster theme={theme} position="bottom-right" offset={36} toastOptions={{ style: { borderRadius: "8px" } }} />
      <header className="topbar">
        <nav className="flex min-w-0 items-stretch self-stretch" aria-label={t("navigation")}>
          <ViewTab active={view === "pulls"} keys="g p" onClick={() => setView("pulls")}>{t("pullRequests")}</ViewTab>
          <ViewTab active={view === "branches"} keys="g b" onClick={() => setView("branches")}>{t("branches")}</ViewTab>
          {review && (
            <ViewTab active={view === "review"} onClick={() => setView("review")}>
              <span className="truncate" title={review.title}>{review.title}</span>
              <span className="shrink-0 font-normal text-muted-foreground">
                {review.source.kind === "local"
                  ? t("localRevision", { branch: review.source.branch, hash: review.id.slice(0, 7) })
                  : t("revision", { hash: review.revision.slice(0, 7) })}
              </span>
            </ViewTab>
          )}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {busy && <span className="px-2 text-xs text-muted-foreground" role="status">{t("opening")}</span>}
          {reviewing && review && (
            <>
              {!branchReview && currentStack.length > 1 && (
                <Button variant="ghost" size="xs" onClick={() => setStackOpen(true)}>
                  {t("stackPosition", { position: activeIndex - stackStart + 1, total: currentStack.length })}
                  <Keys value="p" />
                </Button>
              )}
              <GitHubReviewDialog key={review.id} open={githubOpen} onOpenChange={setGithubOpen} review={review} busy={busy || saving} onSynced={next => setReview(current => current?.id === next.id && current.updatedAt <= next.updatedAt ? next : current)} />
            </>
          )}
          <Button variant="ghost" size="xs" onClick={() => setPalette("commands")}>{t("commands")}<Keys value=":" /></Button>
          <Button variant="ghost" size="xs" onClick={() => setHelp(true)}>{t("keys")}<Keys value="?" /></Button>
        </div>
      </header>
      <MyPulls
        onLoaded={setStackPulls}
        visible={view === "pulls"}
        busy={busy || saving}
        currentUrl={review?.source.url}
        onOpen={(url) => void open(url)}
      />
      <BranchView
        key={branchFocus?.n ?? 0}
        visible={view === "branches"}
        initialBranch={branchFocus?.branch ?? (review?.source.kind === "local" ? review.source.branch : undefined)}
        currentCommit={review?.source.kind === "local" && review.source.branchReview && !review.source.branchComparison ? review.revision : undefined}
        busy={busy || saving}
        onOpen={(branch, commit) => void openCommit(branch, commit)}
      />
      {view === "review" && (review ? (
        <ErrorBoundary key={review.id} message={t("reviewError")}>
          <Workspace
            review={review}
            change={change}
            saving={saving || busy}
            theme={theme}
            path={path}
          />
        </ErrorBoundary>
      ) : (
        <main className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
          {t(busy ? "loading" : "choosePull")}
        </main>
      ))}
      <PullRequestsDialog open={stackOpen} onOpenChange={setStackOpen} pulls={currentStack} currentUrl={review?.source.url ?? ""} busy={busy || saving} onOpen={(url) => void open(url)} />
      <CommandPalette page={palette} onClose={() => setPalette(null)} onOpenUrl={(url) => { if (idle) void open(url); }} />
      <KeyboardHelp open={help} onOpenChange={setHelp} />
    </div>
  );
}
