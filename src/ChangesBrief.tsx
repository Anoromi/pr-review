import { useFormatter, useTranslations } from "use-intl";
import type { api } from "./api";
import { Keys } from "./components/ui/key-hint";
import { Markdown } from "./Markdown";

export type Changes = Awaited<ReturnType<typeof api.openChanges.mutate>> & { threadId: string };

/**
 * The top of the "since you looked" scope: the thread's turns since the last
 * one reviewed, each with what the user wrote in it, and the keys to map the
 * changes to those asks and to mark them reviewed.
 */
export function ChangesBrief({ changes, error, thread, now }: { changes: Changes | null; error: string; thread: string; now: number }) {
  const t = useTranslations("app");
  const format = useFormatter();
  const range = changes?.review?.source.kind === "local" ? changes.review.source.changes : undefined;
  return (
    <section className="brief max-h-[45vh] overflow-auto" aria-label={t("changes.title")}>
      <div className="flex items-center gap-2.5 text-sm">
        <strong className="shrink-0">{t("changes.title")}</strong>
        {range && <span className="shrink-0 text-muted-foreground">{range.from === range.to ? t("changes.turn", { turn: range.to }) : t("changes.range", range)}</span>}
        <span className="min-w-0 truncate text-muted-foreground">{t("changes.by", { title: thread })}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
          {range && <><Keys value="g M" />{t("changes.askMap")} · <Keys value="g d" />{t("changes.markReviewed")} · </>}<Keys value="g n" />{t("changes.refresh")}
        </span>
      </div>
      {error ? <p className="mt-1 text-xs text-removed" role="alert">{error}</p>
        : !changes ? <p className="mt-1 text-xs text-muted-foreground">{t("changes.loading")}</p>
        : !changes.turns.length ? <p className="mt-1 text-xs text-muted-foreground">{changes.reviewedTurn ? t("changes.none", { turn: changes.reviewedTurn }) : t("changes.noTurns")}</p>
        : <>
          {!range && <p className="mt-1 text-xs text-muted-foreground">{t("changes.unfinished", { turn: changes.reviewedTurn })}</p>}
          {range && <p className="mt-1 text-xs text-muted-foreground">{t("changes.excluded")}</p>}
          <ol className="mt-1.5 flex flex-col gap-2">
            {changes.turns.map((turn) => (
              <li key={turn.ordinal} className="border-l-2 pl-2.5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <b className="text-foreground">{t("changes.turn", { turn: turn.ordinal })}</b>
                  <time dateTime={turn.at} title={new Date(turn.at).toLocaleString()}>{format.relativeTime(new Date(turn.at), now)}</time>
                  {!turn.end && <span className="chip">{t("changes.noSnapshot", { status: turn.status })}</span>}
                </div>
                {turn.messages.map((message, index) => <Markdown key={index} className="mt-0.5 line-clamp-6" text={message} />)}
              </li>
            ))}
          </ol>
        </>}
    </section>
  );
}
