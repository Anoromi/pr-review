import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { HotkeyButton } from "./components/ui/hotkey-button";
import { Keys } from "./components/ui/key-hint";
import { api } from "./api";
import type { Comment, Review } from "../shared/types";

export type Destination = "local" | "github";
type Change = (operation: () => Promise<Review>) => Promise<boolean>;

const submitKey = (event: React.KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) && event.key === "Enter";

export function CommentEditor({
  initialBody,
  initialDestination = "local",
  published = false,
  conflictBody,
  onResolveConflict,
  onDestinationChange,
  label,
  saving,
  onBodyChange,
  onSave,
  onDiscard,
  onLeave,
  shouldFocus,
}: {
  initialBody: string;
  initialDestination?: Destination;
  published?: boolean;
  conflictBody?: string;
  onResolveConflict: (useRemote: boolean) => void;
  onDestinationChange: (value: Destination) => void;
  label: string;
  saving: boolean;
  onBodyChange: (body: string) => void;
  onSave: (body: string, destination: Destination) => Promise<void>;
  onDiscard: () => void;
  /** Keeps the draft and hands the keyboard back to the diff. */
  onLeave: () => void;
  shouldFocus: () => boolean;
}) {
  const t = useTranslations("app");
  const [body, setBody] = useState(initialBody);
  const [destination, setDestination] = useState(initialDestination);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!shouldFocus()) return;
    const timer = setTimeout(() => {
      editor.current?.focus();
      editor.current?.scrollIntoView({ block: "center" });
    }, 100);
    return () => clearTimeout(timer);
  }, []);
  function toggleDestination() {
    if (saving || published) return;
    const value = destination === "local" ? "github" : "local";
    setDestination(value);
    onDestinationChange(value);
  }
  return (
    <form
      className="comment-editor"
      data-draft-editor
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(body, destination);
      }}
    >
      <label htmlFor="comment-body" className="mb-2 block text-xs font-semibold">{label}</label>
      <Textarea
        id="comment-body"
        ref={editor}
        aria-label={t("commentLabel")}
        placeholder={t("commentPlaceholder")}
        className="min-h-24 leading-relaxed"
        value={body}
        disabled={saving}
        onChange={(event) => {
          setBody(event.target.value);
          onBodyChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (submitKey(event)) {
            event.preventDefault();
            void onSave(body, destination);
          } else if (event.key === "Escape") {
            event.preventDefault();
            if (body.trim()) onLeave();
            else onDiscard();
          } else if (event.ctrlKey && event.key === "g") {
            event.preventDefault();
            toggleDestination();
          }
        }}
      />
      {conflictBody !== undefined && <div className="mt-2 space-y-2 rounded-md border p-2">
        <p>{t("githubEditConflict")}</p><pre className="whitespace-pre-wrap">{conflictBody}</pre>
        <Button type="button" variant="outline" size="xs" onClick={() => { setBody(conflictBody); onBodyChange(conflictBody); onResolveConflict(true); }}>{t("githubUseRemote")}</Button>
        <Button type="button" variant="outline" size="xs" className="ml-2" onClick={() => onResolveConflict(false)}>{t("githubKeepEdit")}</Button>
      </div>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" disabled={saving || published} aria-label={t("commentDestination")} onClick={toggleDestination}>
          {t(destination === "github" ? "localAndGitHub" : "localOnly")}
          <Keys value="Ctrl+g" />
        </Button>
        <Button variant="ghost" size="xs" type="button" className="ml-auto text-muted-foreground" disabled={saving} onClick={onDiscard}>
          {t("cancel")}
          {!body.trim() && <Keys value="Escape" />}
        </Button>
        <Button type="submit" size="xs" disabled={saving || !body.trim()}>
          {saving ? t("saving") : t("saveComment")}
          <Keys value="Ctrl+Enter" />
        </Button>
      </div>
    </form>
  );
}

export function ReplyComposer({ comment, review, change, requested = false, onOpened, onLeave, showHotkey = false, hotkey = "r" }: {
  hotkey?: string;
  showHotkey?: boolean;
  requested?: boolean;
  onOpened?: () => void;
  onLeave?: () => void;
  comment: Comment;
  review: Review;
  change: Change;
}) {
  const t = useTranslations("app");
  const key = `pr-review:reply:${review.source.url}:${comment.id}`;
  const [body, setBody] = useState(() => {
    try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
  });
  const requestId = useRef(localStorage.getItem(`${key}:submission`) ?? crypto.randomUUID());
  const [open, setOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (requested) { setOpen(true); textarea.current?.focus(); onOpened?.(); }
  }, [requested]);
  useEffect(() => { if (open) textarea.current?.focus(); }, [open]);
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  function update(value: string) {
    setBody(value);
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {}
  }
  function close() {
    setOpen(false);
    onLeave?.();
  }
  async function send() {
    if (!body.trim() || pending.current) return;
    pending.current = true;
    setSending(true);
    try {
      localStorage.setItem(`${key}:submission`, requestId.current);
      if (await change(() => api.reply.mutate({ id: review.id, commentId: comment.id, requestId: requestId.current, github: Boolean(comment.github), author: "You", body }))) {
        localStorage.removeItem(`${key}:submission`); requestId.current = crypto.randomUUID();
        update("");
        close();
      }
    } finally { pending.current = false; setSending(false); }
  }
  if (!open) return (
    <div className="flex items-center gap-1">
    <HotkeyButton size="xs" hotkey={hotkey} showHotkey={showHotkey} data-reply-action disabled={Boolean(comment.github?.deleted) || (comment.destination === "github" && !comment.github)} onClick={() => setOpen(true)}>
      {t("reply")}
    </HotkeyButton>
    <HotkeyButton size="xs" hotkey="x" showHotkey={showHotkey} data-resolve-action disabled={sending || Boolean(comment.github && !comment.github.canResolve)} onClick={async () => {
      if (pending.current) return;
      pending.current = true;
      setSending(true);
      try { await change(() => api.resolveComment.mutate({ id: review.id, commentId: comment.id, resolved: !comment.resolved })); }
      finally { pending.current = false; setSending(false); }
    }}>{t(comment.resolved ? "reopenComment" : "resolveComment")}</HotkeyButton>
    {comment.destination === "github" && !comment.github && <span className="text-xs text-muted-foreground">{t("submitBeforeReply")}</span>}
    </div>
  );
  return (
    <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      {comment.github && <p className="text-xs text-muted-foreground">{t("replySyncsGitHub")}</p>}
      <Textarea ref={textarea} autoFocus aria-label={t("replyBody")} placeholder={t("replyBody")} value={body} disabled={sending}
        onChange={(event) => update(event.target.value)}
        onKeyDown={(event) => {
          if (submitKey(event)) {
            event.preventDefault();
            void send();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }} />
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={sending || !body.trim()}>{t(sending ? "saving" : "sendReply")}<Keys value="Ctrl+Enter" /></Button>
        <Button type="button" variant="ghost" size="xs" disabled={sending} onClick={close}>{t("close")}<Keys value="Escape" /></Button>
      </div>
    </form>
  );
}
