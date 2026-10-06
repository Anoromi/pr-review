import { searchDiffs, paintSearch } from "./diffSearch";
import { toast } from "sonner";
import { selectedCharacters, wordColumn } from "./vimText";
import { HotkeyButton } from "./components/ui/hotkey-button";
import { Keys } from "./components/ui/key-hint";
import { CommentsDialog } from "./CommentsDialog";
import { CommentEditor, ReplyComposer } from "./Thread";
import {
  FilePicker,
  FileSidebar,
  StatusLine,
  cursorPosition,
} from "./WorkspaceChrome";
import { useCommands, type Command } from "./keys";
import {
  type DiffCursor,
  columnAtPoint,
  paintCursor,
  lineSide as cursorSide,
} from "./diffCursor";
import { reviewFiles } from "./reviewFiles";
import { Check, ChevronDown, ChevronRight, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import type {
  CodeViewDiffItem,
  DiffLineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs";
import { useTranslations } from "use-intl";
import { api } from "./api";
import { fileStats, selectedCode } from "../shared/diff";
import type { Comment, Review } from "../shared/types";

type Draft = Pick<Comment, "file" | "side" | "start" | "end" | "body"> & {
  commentId?: string;
  destination?: "local" | "github";
  expectedBody?: string;
};
type Annotation = { comments: Comment[]; draft?: Draft };
type Props = {
  review: Review;
  change: (operation: () => Promise<Review>) => Promise<boolean>;
  saving: boolean;
  theme: "light" | "dark";
  path: string;
};

function readDraft(key: string): Draft | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      value &&
      typeof value.file === "string" &&
      typeof value.body === "string" &&
      ["additions", "deletions"].includes(value.side) &&
      Number.isInteger(value.start) &&
      Number.isInteger(value.end)
    )
      return value;
  } catch {
    /* A malformed browser draft must not prevent opening a review. */
  }
}


export function Workspace({ review, change, saving, theme, path }: Props) {
  const t = useTranslations("app");
  const files = useMemo(() => reviewFiles(review), [review.id, review.patch]);
  const viewer = useRef<CodeViewHandle<Annotation, undefined>>(null);
  const focusDraft = useRef(false);
  const [active, setActive] = useState(() => {
    try {
      const saved = sessionStorage.getItem(`pr-review:file:${review.id}`);
      if (files.some((file) => file.name === saved)) return saved!;
    } catch {
      /* Storage is optional for navigation. */
    }
    return files[0]?.name ?? "";
  });
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(
    () => new Set(review.generatedFiles ?? []),
  );
  const collapsed = collapsedFiles.has(active);
  const [sidebar, setSidebar] = useState(() => {
    try {
      return localStorage.getItem("pr-review:sidebar") !== "off";
    } catch {
      return true;
    }
  });
  const [picker, setPicker] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [layout, setLayout] = useState<"split" | "unified">(() => {
    try {
      const saved = localStorage.getItem("pr-review:layout");
      if (saved === "split" || saved === "unified") return saved;
    } catch {}
    return window.innerWidth < 850 ? "unified" : "split";
  });
  useEffect(() => {
    try { localStorage.setItem("pr-review:layout", layout); } catch {}
  }, [layout]);
  const [wrap, setWrap] = useState(false);
  const [selectionFile, setSelectionFile] = useState("");
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const cursor = useRef<DiffCursor | null>(null);
  const commentsRef = useRef(review.comments);
  commentsRef.current = review.comments;
  const [nearbyReply, setNearbyReply] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<string | null>(null);
  function nearbyThread(position: DiffCursor | null) {
    if (!position) return undefined;
    return commentsRef.current.filter((comment) =>
      comment.file === position.id && comment.side === position.side &&
      (!comment.github ? (!comment.snapshotId || comment.snapshotId === review.id) : !comment.github.outdated && !comment.github.deleted && review.github?.head === review.revision) &&
      position.line >= comment.start - 1 && position.line <= comment.end + 1
    ).sort((a, b) => Math.abs(a.end - position.line) - Math.abs(b.end - position.line))[0];
  }
  function replyNearby() {
    const comment = nearbyThread(cursor.current);
    if (!comment) return;
    setReplyTarget(comment.id);
    viewer.current?.scrollTo({ type: "line", id: comment.file, lineNumber: comment.end, side: comment.side, align: "center", behavior: "instant" });
  }
  useEffect(() => { setNearbyReply(nearbyThread(cursor.current)?.id ?? null); }, [review.comments]);
  const visualAnchor = useRef<DiffCursor | null>(null);
  const [visual, setVisual] = useState(false);
  const visualKind = useRef<"character" | "line">("character");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const searchTerm = useRef("");
  const searchMatches = useRef<DiffCursor[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  function jumpMatch(index: number) {
    const matches = searchMatches.current;
    if (!matches.length) return;
    const next = (index + matches.length) % matches.length;
    setMatchIndex(next);
    const match = matches[next];
    endVisual();
    setSelection(null);
    toggleFile(match.id, false);
    moveCursor(match);
    requestAnimationFrame(() => viewer.current?.scrollTo({ type: "line", id: match.id, lineNumber: match.line, side: match.side, align: "center", behavior: "instant" }));
  }
  function submitSearch() {
    searchTerm.current = searchInput;
    setSearchQuery(searchInput);
    searchMatches.current = searchDiffs(files, searchInput);
    setSearchOpen(false);
    setMatchIndex(0);
    for (const item of viewer.current?.getInstance()?.getRenderedItems() ?? []) {
      if (item.element.shadowRoot) paintSearch(item.element.shadowRoot, searchInput);
    }
    if (searchInput) {
      const current = cursor.current;
      const next = current ? searchMatches.current.findIndex((match) => match.id === current.id && match.side === current.side &&
        (match.line > current.line || match.line === current.line && match.column > current.column)) : 0;
      jumpMatch(Math.max(0, next));
    }
    scroll.current?.focus();
  }
  const yanking = useRef(false);
  const pagingCursor = useRef(false);
  const expansionPending = useRef(false);
  async function yankSelection() {
    if (!selection || yanking.current) return;
    yanking.current = true;
    try {
      const side = selection.side ?? "additions";
      if (selection.endSide && selection.endSide !== side) throw new Error(t("crossSide"));
      const file = files.find((file) => file.name === selectionFile);
      if (!file) return;
      let text = selectedCode(file, side, Math.min(selection.start, selection.end), Math.max(selection.start, selection.end));
      if (visualAnchor.current && cursor.current && visualKind.current === "character")
        text = selectedCharacters(text, visualAnchor.current, cursor.current);
      await navigator.clipboard.writeText(text);
      endVisual();
      setSelection(null);
      toast.success(t("selectionCopied"));
    } catch (error) { toast.error(error instanceof Error ? error.message : t("error")); }
    finally { yanking.current = false; }
  }
  function endVisual() {
    visualAnchor.current = null;
    setVisual(false);
    for (const item of viewer.current?.getInstance()?.getRenderedItems() ?? []) {
      if (item.element.shadowRoot) paintCursor(item.element.shadowRoot, item.id, cursor.current);
    }
  }
  const vimMode = useRef(true);
  function moveCursor(next: DiffCursor) {
    const anchor = visualAnchor.current;
    if (anchor && (anchor.id !== next.id || anchor.side !== next.side)) return;
    cursor.current = next;
    cursorPosition.set(next);
    setNearbyReply(nearbyThread(next)?.id ?? null);
    if (anchor) {
      setSelectionFile(next.id);
      setSelection({ start: anchor.line, end: next.line, side: anchor.side });
    }
    setActive(next.id);
    for (const item of viewer.current?.getInstance()?.getRenderedItems() ??
      []) {
      if (item.element.shadowRoot)
        paintCursor(
          item.element.shadowRoot,
          item.id,
          vimMode.current ? next : null,
          visualKind.current === "character" ? visualAnchor.current : null,
        );
    }
  }
  const diffOptions = useMemo<CodeViewReactOptions<Annotation, undefined>>(
    () => ({
      theme: { light: "github-light", dark: "github-dark" },
      themeType: theme,
      diffStyle: layout,
      diffIndicators: "classic" as const,
      disableFileHeader: false,
      stickyHeaders: true,
      itemMetrics: { lineHeight: 22, diffHeaderHeight: 36 },
      layout: { paddingTop: 0, paddingBottom: 0, gap: 12 },
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      expansionLineCount: 20,
      onLineClick: (props, context) => {
        if (!props.event.shiftKey) endVisual();
        moveCursor({
          id: context.item.id,
          line: props.lineNumber,
          side: props.type === "diff-line" ? props.annotationSide : "additions",
          column: columnAtPoint(
            props.lineElement,
            props.event.clientX,
            props.event.clientY,
          ),
        });
      },
      onLineNumberClick: (props, context) => {
        moveCursor({
          id: context.item.id,
          line: props.lineNumber,
          side: props.type === "diff-line" ? props.annotationSide : "additions",
          column: 0,
        });
      },
      onPostRender: (node, _instance, _phase, context) => {
        if (node.shadowRoot) paintSearch(node.shadowRoot, searchTerm.current);
        if (node.shadowRoot)
          paintCursor(
            node.shadowRoot,
            context.item.id,
            vimMode.current ? cursor.current : null,
            visualKind.current === "character" ? visualAnchor.current : null,
          );
        node.shadowRoot
          ?.querySelectorAll<HTMLElement>("[data-expand-button]")
          .forEach((button) => {
            button.tabIndex = 0;
            const label = t(
              button.hasAttribute("data-expand-up")
                ? "expandAbove"
                : button.hasAttribute("data-expand-down")
                  ? "expandBelow"
                  : "expandGap",
            );
            button.setAttribute("aria-label", label);
            button.title = label;
            button.onkeydown = (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                button.click();
              }
            };
          });
      },
      loadDiffFiles: async (file: import("@pierre/diffs").FileDiffMetadata) => {
        try {
          return await api.fileContext.query({
            id: review.id,
            file: file.name,
          });
        } catch (error) {
          setWarning(error instanceof Error ? error.message : t("error"));
          throw error;
        }
      },
      enableLineSelection: true,
      enableGutterUtility: true,

      unsafeCSS:
        '[data-line] { position: relative; } [data-vim-selection] { position: absolute; pointer-events: none; background: currentColor; opacity: .2; } :host { --diffs-font-family: "DejaVu Sans Mono", monospace; --diffs-font-size: 12px; --diffs-line-height: 22px; } [data-line][data-vim-cursor] { position: relative; } [data-line][data-vim-cursor]::after { content: ""; position: absolute; left: var(--vim-x); top: var(--vim-y); width: var(--vim-width); height: 20px; background: currentColor; opacity: .4; outline: 1px solid currentColor; pointer-events: none; }',
    }),
    [theme, layout, wrap, review.id, t],
  );
  const [draft, setDraft] = useState<Draft | undefined>(() =>
    readDraft(`pr-review:draft:${review.id}`),
  );
  function setWarning(message: string) {
    if (message) toast.error(message, { id: "workspace" });
    else toast.dismiss("workspace");
  }
  const [deleting, setDeleting] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const draftBody = useRef(draft?.body ?? "");
  const pendingDraft = useRef<Draft | undefined>(undefined);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const current = files.find((file) => file.name === active);
  const index = files.findIndex((file) => file.name === active);
  const statsByFile = useMemo(
    () => new Map(files.map((file) => [file.name, fileStats(file)])),
    [files],
  );
  const total = useMemo(
    () =>
      files.reduce(
        (sum, file) => {
          const stats = statsByFile.get(file.name)!;
          return {
            added: sum.added + stats.added,
            removed: sum.removed + stats.removed,
          };
        },
        { added: 0, removed: 0 },
      ),
    [files],
  );

  function persistDraft(next?: Draft) {
    try {
      if (next)
        localStorage.setItem(
          `pr-review:draft:${review.id}`,
          JSON.stringify(next),
        );
      else localStorage.removeItem(`pr-review:draft:${review.id}`);
    } catch {
      setWarning(t("draftStorageError"));
    }
  }
  function updateDraft(next?: Draft) {
    clearTimeout(draftTimer.current);
    pendingDraft.current = undefined;
    draftBody.current = next?.body ?? "";
    focusDraft.current = true;
    setDraft(next);
    persistDraft(next);
  }
  function updateDraftBody(body: string) {
    draftBody.current = body;
    if (!draft) return;
    pendingDraft.current = { ...draft, body };
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      persistDraft(pendingDraft.current);
      pendingDraft.current = undefined;
    }, 250);
  }
  useEffect(() => {
    const flush = () => {
      clearTimeout(draftTimer.current);
      if (pendingDraft.current) {
        persistDraft(pendingDraft.current);
        pendingDraft.current = undefined;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [review.id]);

  function navigate(file: string) {
    endVisual();
    cursor.current = null;
    cursorPosition.set(null);
    setNearbyReply(null);
    setActive(file);
    viewer.current?.scrollTo({
      type: "item",
      id: file,
      align: "start",
      behavior: "instant",
    });
    setSelection(null);
    setWarning("");
    try {
      sessionStorage.setItem(`pr-review:file:${review.id}`, file);
    } catch {
      /* Storage is optional for navigation. */
    }
  }
  useEffect(() => {
    viewer.current?.scrollTo({
      type: "item",
      id: active,
      align: "start",
      behavior: "instant",
    });
  }, []);
  function startComment(
    range: SelectedLineRange | null,
    filename = selection ? selectionFile : active,
  ) {
    const current = files.find((file) => file.name === filename);
    if (!range || !current) {
      setWarning(t("selectionRequired"));
      return;
    }
    if (draft) {
      focusDraftEditor();
      return;
    }
    if (range.endSide && range.endSide !== (range.side ?? "additions")) {
      setWarning(t("crossSide"));
      return;
    }
    const side = range.side ?? "additions";
    const start = Math.min(range.start, range.end),
      end = Math.max(range.start, range.end);
    try {
      selectedCode(current, side, start, end);
      if (end - start >= 500) throw new Error("Select at most 500 lines.");
      endVisual();
      updateDraft({ file: current.name, side, start, end, body: "" });
      setWarning("");
      } catch (error) {
      setWarning(error instanceof Error ? error.message : t("error"));
    }
  }

  async function save(body: string, destination: "local" | "github") {
    if (!draft || !body.trim() || saving) return;
    if (
      await change(() =>
        api.saveComment.mutate({ id: review.id, ...draft!, body, destination }),
      )
    ) {
      updateDraft();
      setSelection(null);
      scroll.current?.focus();
    }
  }

  function edit(comment: Comment) {
    if (draft) {
      focusDraftEditor();
      return;
    }
    navigate(comment.file);
    updateDraft({
      file: comment.file,
      side: comment.side,
      start: comment.start,
      end: comment.end,
      body: comment.body,
      commentId: comment.id,
      destination: comment.destination ?? "local",
      expectedBody: comment.github?.body,
    });
  }

  const itemCache = useRef(
    new Map<
      string,
      { signature: string; item: CodeViewDiffItem<Annotation> }
    >(),
  );
  const items = useMemo(
    () =>
      files.map((file) => {
        const comments = review.comments.filter(
          (comment) => comment.file === file.name && (!comment.github ? (!comment.snapshotId || comment.snapshotId === review.id) : !comment.github.outdated && !comment.github.deleted && review.github?.head === review.revision),
        );
        const fileDraft = draft?.file === file.name ? draft : undefined;
        const signature = JSON.stringify([
          comments,
          fileDraft,
          collapsedFiles.has(file.name),
          review.viewed.includes(file.name),
        ]);
        const previous = itemCache.current.get(file.name);
        if (
          previous?.signature === signature &&
          previous.item.fileDiff === file
        )
          return previous.item;
        const map = new Map<string, DiffLineAnnotation<Annotation>>();
        for (const comment of comments) {
          const key = `${comment.side}:${comment.end}`;
          const annotation = map.get(key) ?? {
            side: comment.side,
            lineNumber: comment.end,
            metadata: { comments: [] },
          };
          annotation.metadata.comments.push(comment);
          map.set(key, annotation);
        }
        if (fileDraft) {
          const key = `${fileDraft.side}:${fileDraft.end}`;
          const annotation = map.get(key) ?? {
            side: fileDraft.side,
            lineNumber: fileDraft.end,
            metadata: { comments: [] },
          };
          annotation.metadata.draft = fileDraft;
          map.set(key, annotation);
        }
        const item: CodeViewDiffItem<Annotation> = {
          id: file.name,
          type: "diff",
          fileDiff: file,
          annotations: [...map.values()],
          collapsed: collapsedFiles.has(file.name),
          version: (previous?.item.version ?? 0) + 1,
        };
        itemCache.current.set(file.name, { signature, item });
        return item;
      }),
    [files, review.comments, review.viewed, draft, collapsedFiles],
  );
  function toggleFile(name: string, close?: boolean) {
    setCollapsedFiles((previous) => {
      const next = new Set(previous);
      if (close ?? !next.has(name)) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  function moveLine(direction: number, edge?: "first" | "last") {
    const instance = viewer.current?.getInstance();
    const previous = cursor.current;
    if (!instance || !scroll.current) return;
    const viewport = scroll.current.getBoundingClientRect();
    function renderedRows() {
      const candidates = instance!.getRenderedItems().flatMap((item) =>
        [...item.element.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? []].map((node) => {
          const line = Number(node.dataset.line);
          const side = cursorSide(node);
          return {
            id: item.id, line, side,
            top: node.getBoundingClientRect().top,
            fileIndex: files.findIndex((file) => file.name === item.id),
            lineIndex: item.type === "diff" ? item.instance.getLineIndex(line, side)?.[layout === "split" ? 1 : 0] ?? line : line,
          };
        }),
      ).filter((row) => Number.isInteger(row.line) && row.line > 0)
        .sort((a, b) => a.top - b.top ||
          Number(b.side === (previous?.side ?? "additions")) - Number(a.side === (previous?.side ?? "additions")));
      return candidates.filter((row, index) => index === 0 || row.id !== candidates[index - 1].id || Math.abs(row.top - candidates[index - 1].top) > 1);
    }
    const rows = renderedRows();
    if (!rows.length) return;
    const previousIndex = rows.findIndex(
      (row) =>
        row.id === previous?.id &&
        row.line === previous.line &&
        row.side === (previous.side ?? "additions"),
    );
    const firstVisible = Math.max(
      0,
      rows.findIndex((row) => row.top >= viewport.top + 36),
    );
    const index =
      edge === "first"
        ? firstVisible
        : edge === "last"
          ? rows.length - 1
          : previousIndex < 0
            ? firstVisible
            : Math.max(
                0,
                Math.min(rows.length - 1, previousIndex + direction),
              );
    if (pagingCursor.current) return;
    const desired = previousIndex + direction;
    if (!edge && previousIndex >= 0 && (desired < 0 || desired >= rows.length)) {
      const sign = direction > 0 ? 1 : -1;
      const boundary = sign > 0 ? rows[rows.length - 1] : rows[0];
      const remaining = sign > 0 ? desired - rows.length + 1 : -desired;
      void pageToNextRows(boundary, remaining, sign);
      return;
    }
    async function pageToNextRows(boundary: typeof rows[number], remaining: number, sign: number) {
      pagingCursor.current = true;
      const originalTop = instance!.getScrollTop();
      const origin = cursor.current;
      let target = boundary;
      const valid = () => vimMode.current && cursor.current === origin && viewer.current?.getInstance() === instance;
      try {
        const deadline = performance.now() + 5000;
        while (remaining > 0 && valid() && performance.now() < deadline) {
          const before = instance!.getScrollTop();
          viewer.current?.scrollTo({ type: "position", position: Math.max(0, before + sign * instance!.getHeight() * .6), behavior: "instant" });
          let candidates: typeof rows = [];
          const renderDeadline = performance.now() + 250;
          do {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            if (!valid()) return;
            candidates = renderedRows().filter((row) =>
              sign * (row.fileIndex - target.fileIndex || row.lineIndex - target.lineIndex) > 0,
            );
          } while (!candidates.length && performance.now() < renderDeadline);
          if (sign < 0) candidates.reverse();
          for (const row of candidates) {
            const anchor = visualAnchor.current;
            if (anchor && (anchor.id !== row.id || anchor.side !== row.side)) { remaining = 0; break; }
            target = row;
            if (--remaining === 0) break;
          }
          if (Math.abs(instance!.getScrollTop() - before) < 1) break;
        }
        if (!valid()) return;
        const anchor = visualAnchor.current;
        if (anchor && (anchor.id !== target.id || anchor.side !== target.side)) {
          viewer.current?.scrollTo({ type: "position", position: originalTop, behavior: "instant" });
          return;
        }
        if (!anchor) setSelection(null);
        moveCursor({ id: target.id, line: target.line, side: target.side, column: previous?.column ?? 0 });
        viewer.current?.scrollTo({ type: "line", id: target.id, lineNumber: target.line, side: target.side, align: "nearest", behavior: "instant" });
      } finally { pagingCursor.current = false; }
    }
    const row = rows[index];
    const anchor = visualAnchor.current;
    if (anchor && (anchor.id !== row.id || anchor.side !== row.side)) return;
    if (!visualAnchor.current) setSelection(null);
    moveCursor({
      id: row.id,
      line: row.line,
      side: row.side,
      column: previous?.column ?? 0,
    });
    viewer.current?.scrollTo({
      type: "line",
      id: row.id,
      lineNumber: row.line,
      side: row.side,
      align: "nearest",
      behavior: "instant",
    });
  }
  async function expandNearCursor(direction: 1 | -1) {
    if (expansionPending.current) return;
    if (!cursor.current) {
      moveLine(direction);
      return;
    }
    const current = cursor.current;
    const root = viewer.current?.getInstance()?.getRenderedItems()
      .find((item) => item.id === current.id)?.element.shadowRoot;
    if (!root) return;
    const line = [...root.querySelectorAll<HTMLElement>(`[data-line="${current.line}"]`)]
      .find((node) => cursorSide(node) === current.side);
    if (!line) return;
    const top = line.getBoundingClientRect().top;
    const next = [...root.querySelectorAll<HTMLElement>("[data-line], [data-separator-wrapper]")]
      .filter((node) => node.getBoundingClientRect().height > 0 &&
        (layout !== "split" || cursorSide(node) === current.side) &&
        direction * (node.getBoundingClientRect().top - top) > 1)
      .sort((a, b) => direction * (a.getBoundingClientRect().top - b.getBoundingClientRect().top))[0];
    const button = next?.matches("[data-separator-wrapper]")
      ? next.querySelector<HTMLElement>(direction === 1 ? "[data-expand-up], [data-expand-both]" : "[data-expand-down], [data-expand-both]")
      : null;
    if (!button) {
      moveLine(direction);
      return;
    }
    expansionPending.current = true;
    button.click();
    const deadline = Date.now() + 5000;
    try {
      while (vimMode.current && cursor.current === current && Date.now() < deadline) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const currentRoot = viewer.current?.getInstance()?.getRenderedItems()
          .find((item) => item.id === current.id)?.element.shadowRoot;
        const revealed = [...currentRoot?.querySelectorAll<HTMLElement>(`[data-line="${current.line + direction}"]`) ?? []]
          .some((node) => cursorSide(node) === current.side && node.getBoundingClientRect().height > 0);
        if (revealed && vimMode.current && cursor.current === current) {
          moveCursor({ ...current, line: current.line + direction });
          viewer.current?.scrollTo({ type: "line", id: current.id, lineNumber: current.line + direction, side: current.side, align: "nearest", behavior: "instant" });
          return;
        }
      }
    } finally {
      expansionPending.current = false;
    }
  }
  function switchSide(side: DiffCursor["side"]) {
    if (layout !== "split") return;
    if (!cursor.current) moveLine(0);
    const current = cursor.current;
    if (!current || current.side === side) return;
    const item = viewer.current?.getInstance()?.getRenderedItems().find((item) => item.id === current.id);
    if (!item || item.type !== "diff") return;
    const index = item.instance.getLineIndex(current.line, current.side)?.[1];
    if (index === undefined) return;
    const candidates = [...item.element.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? []]
      .filter((node) => cursorSide(node) === side && node.getBoundingClientRect().height > 0)
      .map((node) => ({ line: Number(node.dataset.line), index: item.instance.getLineIndex(Number(node.dataset.line), side)?.[1] }))
      .filter((row) => row.index !== undefined)
      .sort((a, b) => Math.abs(a.index! - index) - Math.abs(b.index! - index));
    const next = candidates[0];
    if (!next) return;
    endVisual();
    setSelection(null);
    moveCursor({ ...current, side, line: next.line });
    viewer.current?.scrollTo({ type: "line", id: current.id, lineNumber: next.line, side, align: "nearest", behavior: "instant" });
  }

  const currentFile = () => cursor.current?.id ?? active;
  const shownInline = (comment: Comment) =>
    !comment.github
      ? !comment.snapshotId || comment.snapshotId === review.id
      : !comment.github.outdated && !comment.github.deleted && review.github?.head === review.revision;

  function lineText(position: DiffCursor) {
    const root = viewer.current?.getInstance()?.getRenderedItems().find((item) => item.id === position.id)?.element.shadowRoot;
    return [...root?.querySelectorAll<HTMLElement>(`[data-line="${position.line}"]`) ?? []]
      .find((node) => cursorSide(node) === position.side)?.textContent?.replace(/\n$/, "") ?? "";
  }
  function moveWord(direction: 1 | -1, big: boolean) {
    if (!cursor.current) moveLine(0);
    const position = cursor.current;
    if (!position) return;
    const text = lineText(position);
    const column = wordColumn(text, Math.min(position.column, Math.max(0, text.length - 1)), direction, big);
    if (column !== null) {
      moveCursor({ ...position, column });
      return;
    }
    moveLine(direction);
    const next = cursor.current;
    if (next && (next.line !== position.line || next.id !== position.id)) {
      const text = lineText(next);
      moveCursor({ ...next, column: direction === 1 ? Math.max(0, text.search(/\S/)) : wordColumn(text, text.length, -1, big) ?? 0 });
    }
  }
  function moveColumn(target: "left" | "right" | "end" | "start", times = 1) {
    if (!cursor.current) moveLine(0);
    const position = cursor.current;
    if (!position) return;
    const text = lineText(position);
    const last = Math.max(0, text.length - 1);
    const firstNonblank = Math.max(0, text.search(/\S/));
    moveCursor({
      ...position,
      column:
        target === "end"
          ? last
          : target === "start"
            ? position.column === firstNonblank ? 0 : firstNonblank
            : Math.max(0, Math.min(last, position.column + (target === "right" ? times : -times))),
    });
  }
  function scrollToEdge(position: number, edge: "first" | "last") {
    viewer.current?.scrollTo({ type: "position", position, behavior: "instant" });
    setSelection(null);
    requestAnimationFrame(() => requestAnimationFrame(() => moveLine(0, edge)));
  }
  function halfPage(direction: 1 | -1) {
    const instance = viewer.current?.getInstance();
    if (instance) scrollToEdge(instance.getScrollTop() + (direction * instance.getHeight()) / 2, "first");
  }
  function toggleVisual(kind: "character" | "line") {
    if (visualAnchor.current) {
      endVisual();
      setSelection(null);
      return;
    }
    if (!cursor.current) moveLine(0);
    if (!cursor.current) return;
    visualKind.current = kind;
    visualAnchor.current = { ...cursor.current };
    setVisual(true);
    moveCursor(cursor.current);
  }
  function jumpTo(position: DiffCursor) {
    endVisual();
    setSelection(null);
    toggleFile(position.id, false);
    moveCursor(position);
    requestAnimationFrame(() => viewer.current?.scrollTo({ type: "line", id: position.id, lineNumber: position.line, side: position.side, align: "center", behavior: "instant" }));
  }
  function openFile(name: string) {
    navigate(name);
    if (!collapsedFiles.has(name))
      requestAnimationFrame(() => requestAnimationFrame(() => moveLine(0, "first")));
  }
  function goToFile(delta: number) {
    const from = files.findIndex((file) => file.name === currentFile());
    const next = files[Math.max(0, Math.min(files.length - 1, from + delta))];
    if (next && next.name !== files[from]?.name) openFile(next.name);
  }
  function goToHunk(delta: 1 | -1) {
    const hunks = files.flatMap((file, fileIndex) => file.hunks.map((hunk) => ({ fileIndex, file, hunk })));
    if (!hunks.length) return;
    const position = cursor.current;
    const fileIndex = files.findIndex((file) => file.name === currentFile());
    // Hunks at or above the cursor; the last of them is the one it sits in.
    const passed = hunks.filter((entry) =>
      entry.fileIndex < fileIndex ||
      (entry.fileIndex === fileIndex && position !== null &&
        (position.side === "additions" ? entry.hunk.additionStart : entry.hunk.deletionStart) <= position.line),
    ).length;
    const target = hunks[Math.max(0, Math.min(hunks.length - 1, delta > 0 ? passed : passed - 2))];
    const additions = target.hunk.additionCount > 0;
    jumpTo({
      id: target.file.name,
      side: additions ? "additions" : "deletions",
      line: additions ? target.hunk.additionStart : target.hunk.deletionStart,
      column: 0,
    });
  }
  function goToComment(delta: 1 | -1) {
    const order = (comment: Comment) => files.findIndex((file) => file.name === comment.file);
    const threads = review.comments.filter(shownInline).sort((a, b) => order(a) - order(b) || a.end - b.end);
    if (!threads.length) {
      toast.message(t("noComments"), { id: "workspace" });
      return;
    }
    const position = cursor.current;
    const fileIndex = files.findIndex((file) => file.name === currentFile());
    const line = position?.line ?? 0;
    const after = threads.filter((comment) => order(comment) > fileIndex || (order(comment) === fileIndex && comment.end > line));
    const before = threads.filter((comment) => order(comment) < fileIndex || (order(comment) === fileIndex && comment.end < line));
    const target = delta > 0 ? after[0] ?? threads[0] : before.at(-1) ?? threads.at(-1)!;
    jumpTo({ id: target.file, line: target.end, side: target.side, column: 0 });
  }
  function clearSearch() {
    searchTerm.current = "";
    searchMatches.current = [];
    setSearchQuery("");
    for (const item of viewer.current?.getInstance()?.getRenderedItems() ?? []) {
      if (item.element.shadowRoot) paintSearch(item.element.shadowRoot, "");
    }
  }
  function focusDraftEditor() {
    if (!draft) return;
    toggleFile(draft.file, false);
    viewer.current?.scrollTo({ type: "line", id: draft.file, lineNumber: draft.end, side: draft.side, align: "center", behavior: "instant" });
    let attempts = 0;
    const focus = () => {
      const editor = document.querySelector<HTMLTextAreaElement>("[data-draft-editor] textarea");
      if (editor) editor.focus();
      else if (attempts++ < 30) requestAnimationFrame(focus);
    };
    requestAnimationFrame(focus);
  }
  function commentHere() {
    if (draft) return focusDraftEditor();
    if (selection) return startComment(selection, selectionFile);
    if (!cursor.current) moveLine(0);
    const position = cursor.current;
    if (position) startComment({ start: position.line, end: position.line, side: position.side }, position.id);
  }
  function setViewed(file: string, viewed: boolean) {
    return change(() => api.viewed.mutate({ id: review.id, file, viewed }));
  }
  async function viewedAndNext() {
    const name = currentFile();
    const from = files.findIndex((file) => file.name === name);
    if (from < 0 || (!review.viewed.includes(name) && !(await setViewed(name, true)))) return;
    toggleFile(name, true);
    const next = files.slice(from + 1).find((file) => !review.viewed.includes(file.name)) ??
      files.find((file) => file.name !== name && !review.viewed.includes(file.name));
    if (!next) {
      toast.success(t("allViewed"), { id: "workspace" });
      return;
    }
    // The collapse has to land before positions are measured.
    requestAnimationFrame(() => requestAnimationFrame(() => openFile(next.name)));
  }
  function setAllCollapsed(collapse: boolean) {
    setCollapsedFiles(new Set(collapse ? files.map((file) => file.name) : []));
  }
  function deleteNearby() {
    const comment = nearbyThread(cursor.current);
    if (!comment) return;
    if (deleting !== comment.id) {
      setDeleting(comment.id);
      return;
    }
    void change(() => api.deleteComment.mutate({ id: review.id, commentId: comment.id }))
      .then((deleted) => { if (deleted) setDeleting(undefined); });
  }
  function toggleSidebar() {
    const next = !sidebar;
    setSidebar(next);
    try { localStorage.setItem("pr-review:sidebar", next ? "on" : "off"); } catch {}
  }

  const nearby = () => nearbyThread(cursor.current);
  const commands: Command[] = [
    { id: "cursorDown", group: "move", keys: ["t", "j", "ArrowDown"], hidden: true, run: (times) => moveLine(times ?? 1) },
    { id: "cursorUp", group: "move", keys: ["n", "k", "ArrowUp"], hidden: true, run: (times) => moveLine(-(times ?? 1)) },
    { id: "cursorDownFast", group: "move", keys: ["T", "J"], hidden: true, run: (times) => moveLine(8 * (times ?? 1)) },
    { id: "cursorUpFast", group: "move", keys: ["N", "K"], hidden: true, run: (times) => moveLine(-8 * (times ?? 1)) },
    { id: "cursorLeft", group: "move", keys: ["h", "ArrowLeft"], hidden: true, run: (times) => moveColumn("left", times) },
    { id: "cursorRight", group: "move", keys: ["s", "l", "ArrowRight"], hidden: true, run: (times) => moveColumn("right", times) },
    { id: "wordNext", group: "move", keys: ["w"], hidden: true, run: () => moveWord(1, false) },
    { id: "wordBack", group: "move", keys: ["b"], hidden: true, run: () => moveWord(-1, false) },
    { id: "wordNextBig", group: "move", keys: ["W"], hidden: true, run: () => moveWord(1, true) },
    { id: "wordBackBig", group: "move", keys: ["B"], hidden: true, run: () => moveWord(-1, true) },
    { id: "lineStart", group: "move", keys: ["_", "^"], hidden: true, run: () => moveColumn("start") },
    { id: "lineEnd", group: "move", keys: ["-", "$"], hidden: true, run: () => moveColumn("end") },
    { id: "halfPageDown", group: "move", keys: ["Ctrl+d"], hidden: true, run: () => halfPage(1) },
    { id: "halfPageUp", group: "move", keys: ["Ctrl+u"], hidden: true, run: () => halfPage(-1) },
    { id: "top", group: "move", keys: ["g g"], run: () => scrollToEdge(0, "first") },
    { id: "bottom", group: "move", keys: ["G"], run: () => scrollToEdge(viewer.current?.getInstance()?.getScrollHeight() ?? 0, "last") },
    { id: "sideOld", group: "move", keys: ["Alt+h", "Alt+ArrowLeft"], hidden: true, enabled: () => layout === "split", run: () => switchSide("deletions") },
    { id: "sideNew", group: "move", keys: ["Alt+s", "Alt+l", "Alt+ArrowRight"], hidden: true, enabled: () => layout === "split", run: () => switchSide("additions") },
    { id: "expandDown", group: "move", keys: ["Alt+t", "Alt+j", "Alt+ArrowDown"], hidden: true, run: () => void expandNearCursor(1) },
    { id: "expandUp", group: "move", keys: ["Alt+n", "Alt+k", "Alt+ArrowUp"], hidden: true, run: () => void expandNearCursor(-1) },

    { id: "fileNext", group: "jump", keys: ["]"], run: (times) => goToFile(times ?? 1) },
    { id: "filePrevious", group: "jump", keys: ["["], run: (times) => goToFile(-(times ?? 1)) },
    { id: "filePick", group: "jump", keys: ["f"], run: () => setPicker(true) },
    { id: "hunkNext", group: "jump", keys: ["}"], run: () => goToHunk(1) },
    { id: "hunkPrevious", group: "jump", keys: ["{"], run: () => goToHunk(-1) },
    { id: "commentNext", group: "jump", keys: [")"], run: () => goToComment(1) },
    { id: "commentPrevious", group: "jump", keys: ["("], run: () => goToComment(-1) },
    { id: "search", group: "jump", keys: ["/"], run: () => { setSearchInput(""); setSearchOpen(true); } },
    { id: "searchNext", group: "jump", keys: [";"], enabled: () => searchMatches.current.length > 0, run: () => jumpMatch(matchIndex + 1) },
    { id: "searchPrevious", group: "jump", keys: [","], enabled: () => searchMatches.current.length > 0, run: () => jumpMatch(matchIndex - 1) },

    { id: "viewedNext", group: "files", keys: ["Space"], enabled: () => !saving, run: () => void viewedAndNext() },
    { id: "viewedToggle", group: "files", keys: ["m"], enabled: () => !saving, run: () => void setViewed(currentFile(), !review.viewed.includes(currentFile())) },
    { id: "fileToggle", group: "files", keys: ["z a"], run: () => toggleFile(currentFile()) },
    { id: "fileCollapse", group: "files", keys: ["z c"], run: () => toggleFile(currentFile(), true) },
    { id: "fileExpand", group: "files", keys: ["z o"], run: () => toggleFile(currentFile(), false) },
    { id: "collapseAll", group: "files", keys: ["z M"], run: () => setAllCollapsed(true) },
    { id: "expandAll", group: "files", keys: ["z R"], run: () => setAllCollapsed(false) },

    { id: "comment", group: "comments", keys: ["c"], enabled: () => !saving, run: commentHere },
    { id: "reply", group: "comments", keys: ["r"], enabled: () => Boolean(nearby()), run: replyNearby },
    { id: "resolve", group: "comments", keys: ["x"], enabled: () => { const comment = nearby(); return Boolean(comment) && !saving && !(comment!.github && !comment!.github.canResolve); },
      run: () => { const comment = nearby()!; void change(() => api.resolveComment.mutate({ id: review.id, commentId: comment.id, resolved: !comment.resolved })); } },
    { id: "commentEdit", group: "comments", keys: ["e"], enabled: () => { const comment = nearby(); return Boolean(comment) && !saving && !(comment!.github && !comment!.github.canEdit); }, run: () => edit(nearby()!) },
    { id: "commentDelete", group: "comments", keys: ["D"], enabled: () => { const comment = nearby(); return Boolean(comment) && !saving && !comment!.github; }, run: deleteNearby },
    { id: "commentsList", group: "comments", keys: ["g c", "Alt+c"], run: () => setCommentsOpen(true) },

    { id: "visual", group: "select", keys: ["v"], hidden: true, run: () => toggleVisual("character") },
    { id: "visualLine", group: "select", keys: ["V"], hidden: true, run: () => toggleVisual("line") },
    { id: "yank", group: "select", keys: ["y"], hidden: true, enabled: () => Boolean(selection), run: () => void yankSelection() },
    { id: "cancel", group: "select", keys: ["Escape"], hidden: true, run: () => {
      if (deleting) setDeleting(undefined);
      else if (visualAnchor.current || selection) { endVisual(); setSelection(null); }
      else if (searchQuery) clearSearch();
    } },

    { id: "layoutToggle", group: "view", keys: ["u"], run: () => setLayout(layout === "split" ? "unified" : "split") },
    { id: "wrapToggle", group: "view", keys: ["g w"], run: () => setWrap(!wrap) },
    { id: "sidebarToggle", group: "view", keys: ["\\"], run: toggleSidebar },
  ];
  useCommands(commands);

  const rangeLabel = (value: Pick<Comment, "side" | "start" | "end">) =>
    t(value.side === "deletions" ? "oldLines" : "newLines", {
      start: value.start,
      end: value.end,
    });
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of review.comments) counts.set(comment.file, (counts.get(comment.file) ?? 0) + 1);
    return counts;
  }, [review.comments]);

  function renderComment(comment: Comment) {
    const near = nearbyReply === comment.id;
    return (
      <article className="comment" key={comment.id} data-nearby={near}>
        <header className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
          <strong className="font-semibold text-foreground">{rangeLabel(comment)}</strong>
          {comment.github
            ? <a className="underline" href={comment.github.url} target="_blank" rel="noreferrer">{comment.github.author} · {t(comment.github.deleted ? "githubDeleted" : comment.github.outdated ? "githubOutdated" : "publishedGitHub")}</a>
            : <span>{t(comment.destination === "github" ? "queuedGitHub" : "localOnly")}</span>}
          {comment.resolved && <span>· {t("resolvedComment")}</span>}
          <span className="ml-auto flex gap-1">
            <HotkeyButton size="xs" hotkey="e" showHotkey={near} disabled={saving || Boolean(comment.github && !comment.github.canEdit)} onClick={() => edit(comment)}>
              {t("edit")}
            </HotkeyButton>
            <HotkeyButton size="xs" hotkey="D" showHotkey={near} disabled={saving || Boolean(comment.github)} onClick={() => setDeleting(comment.id)}>
              {t("delete")}
            </HotkeyButton>
          </span>
        </header>
        <p className="comment-body">{comment.body}</p>
        {(comment.replies ?? []).map((reply) => (
          <div key={reply.id} className="mt-2 border-t pt-2">
            <strong className="text-xs">{reply.author}{reply.deleted ? ` · ${t("githubReplyDeleted")}` : ""}</strong>
            <p className="comment-body">{reply.body}</p>
          </div>
        ))}
        <div className="mt-2">
          <ReplyComposer comment={comment} review={review} change={change} showHotkey={near} requested={replyTarget === comment.id} onOpened={() => setReplyTarget(null)} onLeave={() => scroll.current?.focus()} />
        </div>
        {deleting === comment.id && (
          <div className="mt-2 flex items-center gap-2 border-t pt-2 text-xs text-destructive">
            <span className="mr-auto">{t("deleteConfirm")}</span>
            <Button
              variant="destructive"
              size="xs"
              disabled={saving}
              onClick={async () => {
                if (await change(() => api.deleteComment.mutate({ id: review.id, commentId: comment.id })))
                  setDeleting(undefined);
              }}
            >
              {t("delete")}
              <Keys value="D" />
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setDeleting(undefined)}>{t("keep")}<Keys value="Escape" /></Button>
          </div>
        )}
      </article>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy={saving}>
      <div className="flex min-h-0 flex-1">
        {sidebar && (
          <FileSidebar
            files={files}
            active={active}
            viewed={review.viewed}
            stats={statsByFile}
            comments={commentCounts}
            onPick={openFile}
          />
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <CodeView<Annotation>
            ref={viewer}
            containerRef={scroll}
            className="relative min-h-0 flex-1 overflow-auto"
            items={items}
            options={diffOptions}
            selectedLines={
              selection && !(visual && visualKind.current === "character") ? { id: selectionFile, range: selection } : null
            }
            onSelectedLinesChange={(next) => {
              if (visualAnchor.current) return;
              setSelection(next?.range ?? null);
              if (next) {
                setSelectionFile(next.id);
                setActive(next.id);
              }
            }}
            onScroll={(top, instance) => {
              let low = 0,
                high = files.length - 1;
              while (low < high) {
                const middle = Math.ceil((low + high) / 2);
                if (
                  (instance.getTopForItem(files[middle].name) ?? Infinity) <=
                  top + 1
                )
                  low = middle;
                else high = middle - 1;
              }
              if (files[low])
                setActive((previous) =>
                  previous === files[low].name ? previous : files[low].name,
                );
            }}
            renderCustomHeader={(item) => {
              const viewed = review.viewed.includes(item.id);
              const stats = statsByFile.get(item.id);
              const slash = item.id.lastIndexOf("/") + 1;
              return (
                <div className="file-heading" data-file-header={item.id} data-viewed={viewed}>
                  <Button
                    variant="ghost"
                    className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-none p-0 text-left hover:bg-transparent dark:hover:bg-transparent"
                    aria-expanded={!item.collapsed}
                    aria-label={t(item.collapsed ? "expandFile" : "collapseFile", {
                      file: item.id,
                    })}
                    onClick={() => {
                      cursor.current = null;
                      cursorPosition.set(null);
                      setActive(item.id);
                      toggleFile(item.id);
                    }}
                  >
                    {item.collapsed ? (
                      <ChevronRight className="shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="shrink-0 text-muted-foreground" />
                    )}
                    <code className="truncate font-normal" title={item.id}>
                      <span className="text-muted-foreground">{item.id.slice(0, slash)}</span>
                      <span className="font-semibold">{item.id.slice(slash)}</span>
                    </code>
                  </Button>
                  {item.type === "diff" && !item.fileDiff.hunks.length && (
                    <span className="text-xs text-muted-foreground">
                      {t("binary")}
                    </span>
                  )}
                  {stats && (
                    <span className="flex gap-2 font-mono text-[11px]">
                      <span className="text-added">+{stats.added}</span>
                      <span className="text-removed">−{stats.removed}</span>
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    className={viewed ? "text-added" : "text-muted-foreground"}
                    aria-pressed={viewed}
                    disabled={saving}
                    onClick={() => void setViewed(item.id, !viewed)}
                  >
                    {viewed ? <Check /> : <Circle />}
                    {t("viewed")}
                  </Button>
                </div>
              );
            }}
            renderGutterUtility={(getLine, item) => (
              <button
                className="gutter-add"
                aria-label={t("addComment")}
                disabled={saving || !!draft}
                onClick={(event) => {
                  event.stopPropagation();
                  const line = getLine();
                  if (line)
                    startComment(
                      selection && selectionFile === item.id
                        ? selection
                        : {
                            start: line.lineNumber,
                            end: line.lineNumber,
                            side:
                              "side" in line && line.side === "deletions"
                                ? "deletions"
                                : "additions",
                          },
                      item.id,
                    );
                }}
              >
                +
              </button>
            )}
            renderAnnotation={({ metadata }) => (
              <div className="annotation">
                {metadata.comments
                  .filter((comment) => comment.id !== draft?.commentId)
                  .map(renderComment)}
                {metadata.draft && (
                  <CommentEditor
                    key={`${metadata.draft.file}:${metadata.draft.side}:${metadata.draft.start}:${metadata.draft.end}:${metadata.draft.commentId ?? "new"}`}
                    initialBody={draftBody.current}
                    initialDestination={metadata.draft.destination}
                    published={Boolean(metadata.draft.expectedBody !== undefined)}
                    conflictBody={metadata.draft.expectedBody !== undefined && review.comments.find(c => c.id === metadata.draft!.commentId)?.github?.body !== metadata.draft.expectedBody ? review.comments.find(c => c.id === metadata.draft!.commentId)?.github?.body : undefined}
                    onResolveConflict={useRemote => {
                      const remote = review.comments.find(c => c.id === metadata.draft!.commentId)?.github;
                      if (remote) updateDraft({ ...draft!, body: useRemote ? remote.body : draftBody.current, expectedBody: remote.body });
                    }}
                    onDestinationChange={destination => updateDraft({ ...draft!, body: draftBody.current, destination })}
                    label={rangeLabel(metadata.draft)}
                    saving={saving}
                    shouldFocus={() => {
                      const pending = focusDraft.current;
                      focusDraft.current = false;
                      return pending;
                    }}
                    onBodyChange={updateDraftBody}
                    onSave={save}
                    onDiscard={() => { updateDraft(); scroll.current?.focus(); }}
                    onLeave={() => {
                      (document.activeElement as HTMLElement | null)?.blur();
                      scroll.current?.focus();
                    }}
                  />
                )}
              </div>
            )}
          />
          {searchOpen && (
            <form className="flex h-9 shrink-0 items-center gap-2 border-t px-3" onSubmit={(event) => { event.preventDefault(); submitSearch(); }}>
              <span className="font-mono text-xs text-muted-foreground">/</span>
              <Input autoFocus aria-label={t("searchDiff")} placeholder={t("searchDiff")} value={searchInput} spellCheck={false}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setSearchOpen(false); scroll.current?.focus(); } }}
                className="h-6 max-w-md border-0 px-0 font-mono text-xs shadow-none focus-visible:ring-0 dark:bg-transparent" />
              <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><Keys value="Enter" />{t("searchDiff")}</span>
            </form>
          )}
        </main>
      </div>
      <StatusLine
        mode={visual ? (visualKind.current === "line" ? "visualLine" : "visual") : "normal"}
        fallbackFile={active}
        fileIndex={index}
        fileCount={files.length}
        selection={selection ? rangeLabel({
          side: selection.side ?? "additions",
          start: Math.min(selection.start, selection.end),
          end: Math.max(selection.start, selection.end),
        }) : ""}
        search={searchQuery ? { query: searchQuery, index: matchIndex, total: searchMatches.current.length } : undefined}
        draft={draft?.file}
        viewed={review.viewed.length}
        total={total}
        saving={saving}
        path={path}
      />
      <FilePicker
        open={picker}
        onOpenChange={setPicker}
        files={files}
        viewed={review.viewed}
        comments={commentCounts}
        onPick={openFile}
      />
      <CommentsDialog open={commentsOpen} onOpenChange={setCommentsOpen} comments={review.comments} renderReply={(comment, selected) => <ReplyComposer key={comment.id} comment={comment} review={review} change={change} showHotkey={selected} hotkey="r" />} onJump={(comment) => {
        if (comment.snapshotId && comment.snapshotId !== review.id) {
          location.href = `?review=${comment.snapshotId}`;
          return;
        }
        jumpTo({ id: comment.file, line: comment.end, side: comment.side, column: 0 });
      }} />
    </div>
  );
}
