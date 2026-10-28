import { memo, useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { useTranslations } from "use-intl";
import type { Chapter } from "../shared/map";
import { Keys } from "./components/ui/key-hint";
import { Markdown } from "./Markdown";

/** Skip-safe chapters a reader can pass over: all but moved code that failed verification. */
export const skippable = (chapter: Chapter) => Boolean(chapter.skipSafe) && chapter.verified !== false;

function Risk({ chapter }: { chapter: Chapter }) {
  const t = useTranslations("app");
  return (
    <span className={`shrink-0 rounded-sm border px-1 font-mono text-[10.5px] ${chapter.risk === "high" ? "border-removed text-removed" : chapter.risk === "medium" ? "text-foreground" : "text-muted-foreground"}`}>
      {t(`risk.${chapter.risk}`)}
    </span>
  );
}

function SkipNote({ chapter }: { chapter: Chapter }) {
  const t = useTranslations("app");
  if (!chapter.skipSafe) return null;
  return (
    <span className={chapter.verified === false ? "text-removed" : "text-muted-foreground"}>
      {t(`skipSafe.${chapter.skipSafe.reason}`)}
      {chapter.verified !== undefined && ` · ${t(chapter.verified ? "moveVerified" : "moveNotVerified")}`}
    </span>
  );
}

/** How far the reader is in one chapter, for its row in the rail. */
export type ChapterProgress = { read: boolean[]; newReplies: number; working: number };

/** The map's chapters in reading order: the rail's Map tab. */
export const MapList = memo(function MapList({ chapters, current, selected, progress, onPick }: {
  chapters: Chapter[];
  /** The chapter shown in the reader, if any. */
  current: number | null;
  /** The keyboard selection while the rail has focus. */
  selected: number | null;
  progress: ChapterProgress[];
  onPick: (index: number) => void;
}) {
  const t = useTranslations("app");
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"], [aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, selected]);
  return (
    <nav ref={list} className="min-h-0 flex-1 overflow-auto py-1" aria-label={t("map")}>
      {chapters.map((chapter, index) => {
        const { read, newReplies, working } = progress[index];
        const done = read.length > 0 && read.every(Boolean);
        return (
          <button key={index} className="chapter-row" aria-current={index === current ? "true" : undefined} aria-selected={index === selected}
            data-read={done} data-skip={skippable(chapter)} onClick={() => onPick(index)}>
            <span className="w-[18px] shrink-0 text-right tabular-nums text-muted-foreground">{index + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate" title={chapter.uncovered ? t("uncovered") : chapter.title}>{chapter.uncovered ? t("uncovered") : chapter.title}</span>
              <span className="mt-px flex items-center gap-2 whitespace-nowrap text-[11px] text-muted-foreground">
                <span className="hunk-bar">{read.slice(0, 16).map((value, hunk) => <i key={hunk} data-read={value} />)}</span>
                {chapter.skipSafe && <SkipNote chapter={chapter} />}
                {newReplies > 0 && <span className="flex items-center gap-1 text-foreground"><span className="dot" data-tone="new" />{t("newCount", { count: newReplies })}</span>}
                {working > 0 && <span className="flex items-center gap-1"><span className="dot pulse" data-tone="warn" />{t("workingCount", { count: working })}</span>}
              </span>
            </span>
            {done && <Check className="mt-0.5 size-3 shrink-0 text-added" aria-label={t("read")} />}
            {!skippable(chapter) && <Risk chapter={chapter} />}
          </button>
        );
      })}
    </nav>
  );
});

/** The current chapter's why and check list, pinned above its hunks; `x` ticks the check items. */
export function Brief({ chapter, index, checked, hunks, onCheck }: {
  chapter: Chapter;
  index: number;
  checked: boolean[];
  hunks: { read: number; total: number };
  onCheck: (item: number) => void;
}) {
  const t = useTranslations("app");
  return (
    <section className="brief" aria-label={t("chapter")}>
      <div className="flex items-center gap-2.5 text-sm">
        <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
        <strong className="min-w-0 truncate">{chapter.uncovered ? t("uncovered") : chapter.title}</strong>
        <Risk chapter={chapter} />
        <span className="text-xs"><SkipNote chapter={chapter} /></span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {t("hunksRead", hunks)}{chapter.check.length > 0 && <> · <Keys value="x" />{t("ticksCheck")}</>}
        </span>
      </div>
      {chapter.uncovered ? <p className="mt-1">{t("uncoveredWhy")}</p> : <Markdown className="mt-1" text={chapter.why} />}
      {chapter.check.length > 0 && (
        <ul className="brief-checks">
          {chapter.check.map((item, position) => (
            <li key={position}>
              <button className="check-box" role="checkbox" aria-checked={checked[position]} aria-label={t("checkItem", { index: position + 1 })} onClick={() => onCheck(position)}>
                {checked[position] && <Check className="size-2.5" />}
              </button>
              <Markdown text={item} />
            </li>
          ))}
        </ul>
      )}
      {chapter.notDone.length > 0 && (
        <div className="mt-1.5 text-xs">
          <b className="text-removed">{t("notDone")}</b>
          <ul className="ml-4 list-disc">{chapter.notDone.map((item, position) => <li key={position}><Markdown text={item} /></li>)}</ul>
        </div>
      )}
      {chapter.badNotes.length > 0 && (
        <p className="mt-1 text-xs text-removed" role="alert">{t("badNotes", { count: chapter.badNotes.length, notes: chapter.badNotes.map((note) => `${note.file}:${note.start}${note.end && note.end !== note.start ? `-${note.end}` : ""}${note.side === "old" ? ` (${t("old")})` : ""}`).join(", ") })}</p>
      )}
      {chapter.missing.length > 0 && (
        <p className="mt-1 text-xs text-removed">{t("staleHunks", { count: chapter.missing.length, hunks: chapter.missing.map((ref) => `${ref.file}${ref.newStart ?? ref.oldStart ? `:${ref.newStart ?? ref.oldStart}` : ""}`).join(", ") })}</p>
      )}
    </section>
  );
}
