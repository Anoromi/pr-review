import { useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { useTranslations } from "use-intl";
import type { Review } from "../shared/types";
import { api } from "./api";
import { Button } from "./components/ui/button";
import { Keys } from "./components/ui/key-hint";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";

export function GitHubReviewDialog({ open, onOpenChange: setOpen, review, busy, onSynced }: { open: boolean; onOpenChange: (open: boolean) => void; review: Review; busy: boolean; onSynced: (review: Review) => void }) {
  const t = useTranslations("app");
  const [url, setUrl] = useState("");
  const [body, setBody] = useState(() => localStorage.getItem(`pr-review:summary:${review.id}`) ?? "");
  const requestId = useRef(localStorage.getItem(`pr-review:submission:${review.id}`) ?? crypto.randomUUID());
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Array<{ id: string; error?: string }>>([]);
  const [checking, setChecking] = useState(false);
  const callback = useRef(onSynced); callback.current = onSynced;
  const paused = useRef(busy); paused.current = busy || sending;
  const linked = Boolean(review.github || /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(review.source.url));
  useEffect(() => {
    if (!linked) return;
    let stopped = false, running = false, failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (stopped || running) return;
      clearTimeout(timer);
      if (!document.hidden && !paused.current) {
        running = true;
        try {
          const next = await api.syncGitHub.mutate({ id: review.id });
          if (!stopped) {
            callback.current(next);
            failures = next.github?.error ? Math.min(failures + 1, 6) : 0;
          }
        } catch (err) { failures = Math.min(failures + 1, 6); if (!stopped) setError(err instanceof Error ? err.message : String(err)); }
        finally { running = false; }
      }
      if (!stopped) timer = setTimeout(poll, Math.min(300000, 5000 * 2 ** failures));
    }
    void poll();
    document.addEventListener("visibilitychange", poll);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", poll); };
  }, [review.id, linked]);
  const draftSignature = JSON.stringify(review.comments.filter(comment => comment.destination === "github" && !comment.github));
  useEffect(() => {
    if (!open || !linked) return;
    let stopped = false;
    setChecking(true);
    api.previewGitHubReview.query({ id: review.id }).then(result => { if (!stopped) setPreview(result); })
      .catch(err => { if (!stopped) { setError(err.message); setPreview([{ id: "", error: err.message }]); } })
      .finally(() => { if (!stopped) setChecking(false); });
    return () => { stopped = true; };
  }, [open, linked, review.id, draftSignature]);
  async function execute(operation: () => Promise<Review>) {
    if (sending) return false;
    setSending(true); setError("");
    try { callback.current(await operation()); return true; }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); return false; }
    finally { setSending(false); }
  }
  const state = review.github;
  const drafts = review.comments.filter(comment => comment.destination === "github" && !comment.github);
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><Button variant="ghost" size="xs">{t("githubReview")}{drafts.length ? ` (${drafts.length})` : ""}{state?.error || state?.pending ? " !" : ""}<Keys value="g s" /></Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(640px,95vw)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border bg-background p-5 shadow-lg">
        <div className="flex items-center justify-between gap-3"><Dialog.Title className="font-semibold">{t("githubReview")}</Dialog.Title><Dialog.Close asChild><Button variant="ghost" size="sm">{t("close")}</Button></Dialog.Close></div>
        <Dialog.Description className="my-3 text-sm text-muted-foreground">{t("githubReviewDescription")}</Dialog.Description>
        {!linked ? <form className="space-y-3" onSubmit={e => { e.preventDefault(); void execute(() => api.linkGitHub.mutate({ id: review.id, url })); }}>
          <label className="block text-sm">{t("githubPrUrl")}<Input autoFocus value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/owner/repo/pull/123" /></label>
          <Button disabled={sending || !url.trim()} type="submit">{t("linkGitHub")}</Button>
        </form> : <>
          {state && <div className="space-y-2 text-sm">
            <a className="underline" href={state.url} target="_blank" rel="noreferrer">{state.url}</a>
            <p>{t("githubAccount", { account: state.account ?? "…" })}</p>
            <p className="text-muted-foreground">{state.syncedAt ? t("githubLastSync", { time: new Date(state.syncedAt).toLocaleTimeString() }) : t("githubSyncing")}</p>
          </div>}
          <Button className="my-3" variant="outline" disabled={sending || busy} onClick={() => void execute(() => api.syncGitHub.mutate({ id: review.id, force: true }))}>{t("syncGitHub")}</Button>
          {state?.head && state.head !== review.revision && <p role="status" className="my-3 text-sm text-destructive">{t("githubHeadChanged")}</p>}
          {state?.pending && <div className="my-3 space-y-2 border p-3 text-sm">
            <p>{t("githubUncertain")}</p>
            <Button variant="outline" disabled={sending} onClick={() => {
              if (window.confirm(t("githubConfirmRetry"))) void execute(() => api.clearUncertainSubmission.mutate({ id: review.id }));
            }}>{t("githubAllowRetry")}</Button>
          </div>}
          <form className="space-y-3 border-t pt-3" onSubmit={e => { e.preventDefault(); localStorage.setItem(`pr-review:submission:${review.id}`, requestId.current); void execute(() => api.submitReview.mutate({ id: review.id, requestId: requestId.current, event, body })).then(ok => {
            if (ok) { setBody(""); localStorage.removeItem(`pr-review:summary:${review.id}`); localStorage.removeItem(`pr-review:submission:${review.id}`); requestId.current = crypto.randomUUID(); }
          }); }}>
            <label className="block text-sm">{t("reviewSummary")}<Textarea autoFocus value={body} disabled={sending} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} onChange={e => { setBody(e.target.value); localStorage.setItem(`pr-review:summary:${review.id}`, e.target.value); }} /></label>
            <label className="block text-sm">{t("reviewDecision")}<select className="ml-2 rounded border bg-background p-2" value={event} disabled={sending} onChange={e => setEvent(e.target.value as typeof event)}>
              <option value="COMMENT">{t("reviewComment")}</option>
              <option value="APPROVE" disabled={state?.account === state?.author}>{t("reviewApprove")}</option>
              <option value="REQUEST_CHANGES" disabled={state?.account === state?.author}>{t("reviewRequestChanges")}</option>
            </select></label>
            <p className="text-sm">{t("githubDraftCount", { count: drafts.length })}</p>
            <ul className="max-h-40 space-y-2 overflow-auto text-sm">{drafts.map(comment => <li key={comment.id}><span className="font-mono">{comment.file}:{comment.start}</span><p className="whitespace-pre-wrap">{comment.body}</p>{preview.find(item => item.id === comment.id)?.error && <p className="text-destructive">{preview.find(item => item.id === comment.id)!.error}</p>}</li>)}</ul>
            <Button type="submit" disabled={sending || busy || checking || preview.some(item => item.error) || !state?.account || Boolean(state.error || state.pending) || state.head !== review.revision}>{sending ? t("saving") : t("submitReview")}<Keys value="Ctrl+Enter" /></Button>
          </form>
          {Boolean(state?.reviews.length) && <div className="mt-4 space-y-3 border-t pt-3"><h3 className="text-sm font-medium">{t("githubReviewActivity")}</h3>{state!.reviews.map(item => <article key={`${item.state}-${item.id}`} className="text-sm"><a className="underline" href={item.url} target="_blank" rel="noreferrer">{item.author} · {item.state}</a><p className="whitespace-pre-wrap">{item.body}</p></article>)}</div>}
        </>}
        {(error || state?.error) && <p role="alert" className="mt-3 whitespace-pre-wrap text-sm text-destructive">{error || state?.error}</p>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
