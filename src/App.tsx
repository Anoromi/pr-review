import { GitHubReviewDialog } from "./GitHubReviewDialog";
import { PullRequestsDialog } from "./PullRequestsDialog";
import { CommandPalette, KeyboardHelp, type PalettePage } from "./CommandPalette";
import { Toaster, toast } from "sonner";
import { orderStacks } from "../shared/stacks";
import type { MyPullRequest } from "../server/github";
import { Button } from "@/components/ui/button";
import { Keys } from "@/components/ui/key-hint";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { api, scope, setReviewParam, setCommitParam } from "./api";
import { commitOf, type Review } from "../shared/types";
import { Workspace } from "./Workspace";
import { Home, type HomeSection } from "./Home";
import { installKeys, useCommands } from "./keys";

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

export function App() {
  const t = useTranslations("app");
  const [palette, setPalette] = useState<PalettePage | null>(null);
  const [help, setHelp] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [review, setReview] = useState<Review>();
  // The commit a review opens scoped to (?commit=, or an old commit snapshot's URL).
  const [initialCommit, setInitialCommit] = useState(() => new URLSearchParams(location.search).get("commit") ?? undefined);
  const [stackPulls, setStackPulls] = useState<MyPullRequest[]>([]);
  const [view, setView] = useState<"home" | "review">(() => {
    const params = new URLSearchParams(location.search);
    return params.has("review") || params.has("checkout") ? "review" : "home";
  });
  const [homeSection, setHomeSection] = useState<{ section: HomeSection; n: number }>({ section: "agents", n: 0 });
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
    // repository: its open PR for the current branch, or else the whole
    // branch. The parameter stays put. A `review` next to it is kept on a
    // reload of the same checkout; arriving from another checkout, it is the
    // previous checkout's and is dropped.
    const checkout = params.get("checkout");
    const reviewId = params.get("review");
    let sameCheckout = false;
    try {
      sameCheckout = sessionStorage.getItem("pr-review:last-checkout") === checkout;
      if (checkout) sessionStorage.setItem("pr-review:last-checkout", checkout);
    } catch {}
    api.myPulls.query(scope()).then(setStackPulls).catch(report);
    if (checkout && !(reviewId && sameCheckout)) {
      if (reviewId) { setReviewParam(undefined); setCommitParam(undefined); setInitialCommit(undefined); }
      void openCheckout(checkout);
      return;
    }
    if (reviewId && /^[a-f0-9]{24}$/.test(reviewId)) void switchReview(reviewId);
    else setView("home");
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

  /** Runs an open; the newest request wins, and its review is shown. */
  async function load(operation: () => Promise<Review>, commit?: string) {
    const request = ++sequence.current;
    setBusy(true);
    toast.dismiss("app-error");
    try {
      const next = await operation();
      if (request !== sequence.current) return;
      if (review?.source.url === next.source.url && review.id !== next.id) toast.success(t("newRevision"));
      setInitialCommit(commit);
      setCommitParam(commit);
      setReview(next);
      setView("review");
    } catch (error) {
      if (request === sequence.current) { report(error); if (!review) setView("home"); }
    } finally {
      if (request === sequence.current) setBusy(false);
    }
  }
  const openPull = (url: string, checkout?: string) =>
    load(() => api.open.mutate({ ...(checkout ? { checkout } : scope()), url }));
  // A branch opens as a whole; its commits are a scope inside the review.
  const openBranch = (branch: string, checkout?: string, commit?: string) =>
    load(() => api.openBranch.mutate({ ...(checkout ? { checkout } : scope()), branch }), commit);
  async function openCheckout(path: string) {
    try {
      const target = await api.checkout.query({ path });
      if (target.pullError) toast.warning(t("checkoutPullUnknown", { branch: target.branch ?? "", error: target.pullError }), { id: "checkout-pull" });
      if (target.pull) await openPull(target.pull.url, path);
      else if (target.branch) await openBranch(target.branch, path);
      else { setView("home"); toast.error(t("checkoutDetached"), { id: "app-error" }); }
    } catch (error) { setView("home"); report(error); }
  }
  async function switchReview(id: string) {
    try {
      const saved = await api.get.query({ id });
      // A single commit's review opens as its branch or PR, scoped to the commit.
      const commit = commitOf(saved);
      if (commit && saved.source.kind === "local")
        return saved.source.branchReview
          ? openBranch(saved.source.branch, saved.source.repo, commit)
          : load(() => api.open.mutate({ checkout: saved.source.kind === "local" ? saved.source.repo : undefined, url: saved.source.url }), commit);
      await load(async () => saved, initialCommit);
    } catch (error) { report(error); setView("home"); }
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

  const reviewing = view === "review" && Boolean(review);
  const idle = !busy && !saving;
  function reload() {
    if (review?.source.kind !== "local") return review && void openPull(review.source.url);
    if (review.source.branchReview) void openBranch(review.source.branch, review.source.repo);
    else void openPull(review.source.url, review.source.repo);
  }
  async function copyAgentPath() {
    if (!review) return;
    try {
      const result = await api.comments.query({ id: review.id });
      await navigator.clipboard.writeText(`${result.directory}/comments.json`);
      toast.success(t("agentPathCopied"));
    } catch (error) { report(error); }
  }
  function goHome(section: HomeSection) {
    setHomeSection((old) => ({ section, n: old.n + 1 }));
    setView("home");
  }
  useCommands([
    { id: "palette", group: "app", keys: [":", "Ctrl+k"], hidden: true, run: () => setPalette("commands") },
    { id: "help", group: "app", keys: ["?"], run: () => setHelp(true) },
    { id: "goHome", group: "app", keys: ["g h"], run: () => goHome("agents") },
    { id: "goPulls", group: "app", keys: ["g p"], run: () => goHome("pulls") },
    { id: "goBranches", group: "app", keys: ["g b"], run: () => goHome("branches") },
    { id: "openBranchPicker", group: "app", keys: [], run: () => setPalette("branches") },
    { id: "backToReview", group: "app", keys: ["Escape", "g v"], enabled: () => view !== "review" && Boolean(review), run: () => setView("review") },
    { id: "openUrl", group: "app", keys: ["g u"], run: () => setPalette("url") },
    { id: "theme", group: "app", keys: ["g t"], run: () => setTheme(theme === "dark" ? "light" : "dark") },
    { id: "stack", group: "review", keys: ["p", "Alt+p"], enabled: () => reviewing && currentStack.length > 1, run: () => setStackOpen(true) },
    { id: "githubReview", group: "review", keys: ["g s"], enabled: () => reviewing, run: () => setGithubOpen(true) },
    { id: "reload", group: "review", keys: ["g r"], enabled: () => reviewing && idle, run: reload },
    { id: "openGithub", group: "review", keys: ["g o"], enabled: () => reviewing, run: () => window.open(review!.source.url, "_blank", "noreferrer") },
    { id: "copyMarkdown", group: "review", keys: ["g m"], enabled: () => reviewing && !saving, run: () => void exportReview(true) },
    { id: "downloadMarkdown", group: "review", keys: [], enabled: () => reviewing && !saving, run: () => void exportReview(false) },
    { id: "copyAgentPath", group: "review", keys: [], enabled: () => reviewing, run: () => void copyAgentPath() },
  ]);

  const appButtons = (
    <>
      <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setPalette("commands")}>{t("commands")}<Keys value=":" /></Button>
      <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setHelp(true)}>{t("keys")}<Keys value="?" /></Button>
    </>
  );
  return (
    <div className="app">
      <Toaster theme={theme} position="bottom-right" offset={36} toastOptions={{ style: { borderRadius: "8px" } }} />
      {view === "home" && (
        <Home key={homeSection.n} section={homeSection.section} busy={busy || saving} currentUrl={review?.source.url}
          onPulls={setStackPulls} onOpenPull={(url, checkout) => void openPull(url, checkout)}
          onOpenBranch={(branch, checkout) => void openBranch(branch, checkout)} onOpenCheckout={(checkout) => void openCheckout(checkout)}
          buttons={appButtons} />
      )}
      {view === "review" && (review ? (
        <ErrorBoundary key={review.id} message={t("reviewError")}>
          <Workspace
            review={review}
            change={change}
            saving={saving || busy}
            theme={theme}
            path={path}
            initialCommit={initialCommit}
            stack={currentStack.length > 1 ? { position: activeIndex - stackStart + 1, total: currentStack.length } : null}
            onStack={() => setStackOpen(true)}
            buttons={<>
              {busy && <span className="px-2 text-xs text-muted-foreground" role="status">{t("opening")}</span>}
              <GitHubReviewDialog key={review.id} open={githubOpen} onOpenChange={setGithubOpen} review={review} busy={busy || saving} onSynced={next => setReview(current => current?.id === next.id && current.updatedAt <= next.updatedAt ? next : current)} />
              {appButtons}
            </>}
          />
        </ErrorBoundary>
      ) : (
        <main className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
          {t("loading")}
        </main>
      ))}
      <PullRequestsDialog open={stackOpen} onOpenChange={setStackOpen} pulls={currentStack} currentUrl={review?.source.url ?? ""} busy={busy || saving} onOpen={(url) => void openPull(url)} />
      <CommandPalette page={palette} onClose={() => setPalette(null)} onOpenUrl={(url) => { if (idle) void openPull(url); }} onOpenBranch={(branch) => { if (idle) void openBranch(branch); }} />
      <KeyboardHelp open={help} onOpenChange={setHelp} />
    </div>
  );
}
