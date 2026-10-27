import { memo, useEffect, useRef } from "react";
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

export const MapSidebar = memo(function MapSidebar({ chapters, current, onPick }: {
  chapters: Chapter[];
  current: number;
  onPick: (index: number) => void;
}) {
  const t = useTranslations("app");
  const list = useRef<HTMLElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current]);
  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="font-semibold">{t("map")}</span>
        <span className="truncate tabular-nums text-muted-foreground">{t("chapterPosition", { index: current + 1, total: chapters.length })}</span>
        <span className="ml-auto flex gap-1"><Keys value="<" /><Keys value=">" /></span>
      </div>
      <nav ref={list} className="min-h-0 flex-1 overflow-auto py-1" aria-label={t("map")}>
        {chapters.map((chapter, index) => (
          <button key={index} className="file-row h-auto items-start py-1" aria-current={index === current ? "true" : undefined} data-viewed={skippable(chapter)} onClick={() => onPick(index)}>
            <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">{index + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate" title={chapter.uncovered ? t("uncovered") : chapter.title}>{chapter.uncovered ? t("uncovered") : chapter.title}</span>
              {chapter.skipSafe && <span className="block truncate text-[11px] font-normal"><SkipNote chapter={chapter} /></span>}
            </span>
            {!skippable(chapter) && <Risk chapter={chapter} />}
          </button>
        ))}
      </nav>
    </aside>
  );
});

/** The current chapter's why and check points, above its hunks. */
export function ChapterHeader({ chapter, index }: { chapter: Chapter; index: number }) {
  const t = useTranslations("app");
  return (
    <section className="shrink-0 space-y-1 border-b px-4 py-2 text-[13px]" aria-label={t("chapter")}>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
        <strong className="min-w-0 truncate">{chapter.uncovered ? t("uncovered") : chapter.title}</strong>
        <Risk chapter={chapter} />
        <span className="ml-auto text-xs"><SkipNote chapter={chapter} /></span>
      </div>
      {chapter.uncovered ? <p>{t("uncoveredWhy")}</p> : <Markdown text={chapter.why} />}
      {chapter.check.length > 0 && (
        <ul className="list-disc pl-5 text-muted-foreground">
          {chapter.check.map((item, position) => <li key={position}><Markdown text={item} /></li>)}
        </ul>
      )}
      {chapter.missing.length > 0 && (
        <p className="text-xs text-removed">{t("staleHunks", { count: chapter.missing.length, hunks: chapter.missing.map((ref) => `${ref.file}${ref.newStart ?? ref.oldStart ? `:${ref.newStart ?? ref.oldStart}` : ""}`).join(", ") })}</p>
      )}
    </section>
  );
}
