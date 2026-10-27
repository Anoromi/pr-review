import { useEffect, useRef, type ReactNode } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { Keys } from "./components/ui/key-hint";
import { Markdown } from "./Markdown";
import { Dot, type Tone } from "./agentStatus";
import type { ThreadState } from "../shared/progress";
import type { Comment } from "../shared/types";

export const threadTone: Record<ThreadState, Tone> = { new: "new", working: "warn", waiting: "warn", open: "idle", answered: "ok", resolved: "idle" };
export const inboxOrder: ThreadState[] = ["new", "working", "waiting", "open", "answered", "resolved"];

/** One inbox entry: a thread, or the map job. */
export type InboxItem = {
  id: string;
  state: ThreadState;
  /** "finished" when the agent finished without replying. */
  finished?: boolean;
  title: string;
  location: string;
  time: string;
  /** For new replies: the latest reply, shortened. */
  preview?: string;
  timer?: string;
};

const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.replace(/^[#>\s]+|[*`]/g, "").trim() ?? "";
export const threadTitle = (comment: Comment) => firstLine(comment.body);

/**
 * The agent panel: which thread the review talks to and what it is doing,
 * the inbox of every question and comment grouped by state, and the open
 * conversation (or the composer for a new one).
 */
export function AgentPanel({ focused, title, state, tone, job, items, selected, open, onOpen, children }: {
  focused: boolean;
  /** The agent thread, or the reason there is none. */
  title: string;
  state: ReactNode;
  tone: Tone;
  /** The map job, while there is one to show. */
  job: { state: string; tone: Tone; timer: string; files: number } | null;
  items: InboxItem[];
  selected: number;
  /** The thread shown in the conversation. */
  open?: string;
  onOpen: (id: string) => void;
  /** The conversation or composer. */
  children: ReactNode;
}) {
  const t = useTranslations("app");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [focused, selected]);
  const groups = inboxOrder.map((state) => ({ state, items: items.filter((item) => item.state === state) }));
  return (
    <aside className="agent-panel" data-focused={focused} aria-label={t("agentPanel")} tabIndex={-1}>
      <div className="border-b px-3.5 py-2.5">
        <div className="flex items-center gap-2 font-semibold"><Dot tone={tone} /><span className="min-w-0 truncate" title={title}>{title}</span><Keys value="g A" className="ml-auto" /></div>
        <div className="mt-0.5 text-xs text-muted-foreground">{state}</div>
      </div>
      <div ref={list} className={`min-h-0 overflow-auto py-1 ${children ? "max-h-[38%] shrink-0" : "flex-1"}`} role="list" aria-label={t("inbox")}>
        {job && (
          <>
            <div className="inbox-group">{t("inboxJobs")}</div>
            <div className="inbox-item">
              <span className="pt-1"><Dot tone={job.tone} /></span>
              <div className="min-w-0 flex-1"><div className="truncate">{t("mapJob")}</div><div className="inbox-location">{t("mapJobFiles", { count: job.files })}</div></div>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">{job.state} {job.timer}</span>
            </div>
          </>
        )}
        {!items.length && <p className="px-3.5 py-3 text-[12.5px] leading-relaxed text-muted-foreground">{t.rich("inboxEmpty", { key: (chunks) => <Keys value={String(chunks)} /> })}</p>}
        {groups.map((group) => group.items.length > 0 && (
          <div key={group.state}>
            <div className="inbox-group">{t(`inboxGroup.${group.state}`)} {group.items.length}{group.state === "new" && <span className="ml-auto flex items-center gap-1 normal-case tracking-normal"><Keys value="i" />{t("inboxNext")}</span>}</div>
            {group.items.map((item) => {
              const index = items.indexOf(item);
              return (
                <div key={item.id}>
                  <div className="inbox-item" role="listitem" data-selected={focused && index === selected} data-open={item.id === open} data-state={item.state} onClick={() => onOpen(item.id)}>
                    <span className="pt-1"><Dot tone={item.finished ? "warn" : threadTone[item.state]} className={item.state === "working" ? "pulse" : ""} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate" title={item.title}>{item.title}</div>
                      <div className="inbox-location">{item.location}{item.finished ? ` · ${t("replyStatus.finished")}` : ""}</div>
                    </div>
                    <span className="shrink-0 text-[11.5px] text-muted-foreground">{item.timer ?? item.time}</span>
                  </div>
                  {item.preview && <div className="inbox-preview">{item.preview}</div>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {children}
    </aside>
  );
}

/** A thread in full: the quoted lines, every message and the reply composer. */
export function Conversation({ comment, state, location, earlier, deleting, saving, onDelete, onKeep, composer }: {
  comment: Comment;
  state: ThreadState;
  location: string;
  /** Set when the thread belongs to another snapshot, so its lines are not in this diff. */
  earlier: boolean;
  deleting: boolean;
  saving: boolean;
  onDelete: () => void;
  onKeep: () => void;
  composer: ReactNode;
}) {
  const t = useTranslations("app");
  const format = useFormatter();
  const sign = comment.side === "deletions" ? "-" : "+";
  const when = (iso: string) => format.relativeTime(new Date(iso), Date.now());
  return (
    <section className="conversation" aria-label={t("conversation")}>
      <header className="flex items-center gap-2 border-b px-3.5 py-2 text-xs">
        <Dot tone={threadTone[state]} />
        <b className="min-w-0 truncate font-mono">{location}</b>
        <span className="min-w-0 truncate text-muted-foreground">
          {comment.github
            ? <a className="underline" href={comment.github.url} target="_blank" rel="noreferrer">{comment.github.author} · {t(comment.github.deleted ? "githubDeleted" : comment.github.outdated ? "githubOutdated" : "publishedGitHub")}</a>
            : comment.destination === "github" ? t("queuedGitHub")
            : comment.thread ? t("askedAgo", { title: comment.thread.title, time: when(comment.createdAt) }) : t("commentedAgo", { time: when(comment.createdAt) })}
          {comment.resolved && ` · ${t("resolvedComment")}`}
          {earlier && ` · ${t("earlierSnapshot")}`}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground"><Keys value="r" />{t("reply")} <Keys value="x" />{t(comment.resolved ? "reopenComment" : "resolveComment")}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-3.5 pb-2">
        <pre className="conversation-quote">{comment.code.split("\n").slice(0, 12).map((line) => `${sign} ${line}`).join("\n")}{comment.code.split("\n").length > 12 ? "\n…" : ""}</pre>
        <article className="conversation-message">
          <div className="who">{comment.github?.author ?? t("you")}<span>{when(comment.createdAt)}</span></div>
          <Markdown text={comment.body} />
        </article>
        {(comment.replies ?? []).map((reply) => (
          <article key={reply.id} className="conversation-message">
            <div className="who">{reply.author}<span>{when(reply.createdAt)}{reply.deleted ? ` · ${t("githubReplyDeleted")}` : ""}</span></div>
            <Markdown text={reply.body} />
          </article>
        ))}
        {deleting && (
          <div className="mt-2 flex items-center gap-2 text-xs text-destructive">
            <span className="mr-auto">{t("deleteConfirm")}</span>
            <Button variant="destructive" size="xs" disabled={saving} onClick={onDelete}>{t("delete")}<Keys value="D" /></Button>
            <Button variant="ghost" size="xs" onClick={onKeep}>{t("keep")}<Keys value="Escape" /></Button>
          </div>
        )}
      </div>
      <div className="border-t px-3.5 py-2">{composer}</div>
    </section>
  );
}
