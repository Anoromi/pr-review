import { searchDiffs, paintSearch } from "./diffSearch";
import { toast } from "sonner";
import { selectedCharacters, wordColumn } from "./vimText";
import { Keys } from "./components/ui/key-hint";
import { CommentEditor, ReplyComposer } from "./Thread";
import {
  FileList,
  FilePicker,
  ThreadPicker,
  type AgentThread,
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { useFormatter, useTranslations } from "use-intl";
import { api } from "./api";
import { setCommitParam } from "./api";
import { FiltersDialog } from "./FiltersDialog";
import { filteredFiles, type FileFilter } from "../shared/filters";
import { fileStats, parseFiles, selectedCode } from "../shared/diff";
import { chapterPatch, hunkKey, resolveMap, type Note, type ReviewMap } from "../shared/map";
import { checkId, hunkIds } from "../shared/read";
import { Brief, MapList, skippable, type ChapterProgress } from "./ReviewMap";
import { awaitingReply, threadState, type ThreadState } from "../shared/progress";
import { Markdown } from "./Markdown";
import { AgentPanel, Conversation, inboxOrder, threadTitle, threadTone, type InboxItem } from "./AgentPanel";
import { GuideRail, CommitList, SearchList, railTabs, type CommitRow, type RailTab, type SearchRow } from "./GuideRail";
import { AgentPill, Dot, agentStatus, elapsed, type Progress } from "./agentStatus";
import { ChangesBrief, type Changes } from "./ChangesBrief";
import type { Comment, Review } from "../shared/types";

type Draft = Pick<Comment, "file" | "side" | "start" | "end" | "body"> & {
  commentId?: string;
  /** A question for the agent thread instead of a review comment. */
  ask?: boolean;
  destination?: "local" | "github";
  expectedBody?: string;
};
/** Thread markers at a line, and the map's notes on the lines ending there. */
type Annotation = { comments: Comment[]; notes: Note[] };
/**
 * What the reader shows of the review: the whole branch, one chapter of the
 * map, one commit (its own snapshot in the same conversation folder), or
 * the agent thread's changes since the user last looked (also a snapshot,
 * with its own map: `chapter` is one of its chapters).
 */
type Scope = { kind: "branch" } | { kind: "chapter"; index: number } | { kind: "commit"; sha: string } | { kind: "changes"; chapter: number | null };
type Focus = "guide" | "reader" | "panel";
type Props = {
  review: Review;
  change: (operation: () => Promise<Review>) => Promise<boolean>;
  saving: boolean;
  theme: "light" | "dark";
  path: string;
  /** The commit to open scoped to. */
  initialCommit?: string;
  /** Opens on this thread's changes since the user last looked (`g n` on Home). */
  initialChanges?: { threadId: string };
  /** Reopens the branch or PR at where it points now. */
  onReload: () => void;
  stack: { position: number; total: number } | null;
  onStack: () => void;
  /** Top bar buttons: GitHub review, commands, keys. */
  buttons: ReactNode;
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
function stored(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}
const afterRender = (run: () => void) => requestAnimationFrame(() => requestAnimationFrame(run));
const basename = (file: string) => file.slice(file.lastIndexOf("/") + 1);
const lineRange = (comment: Pick<Comment, "start" | "end">) => comment.start === comment.end ? `${comment.start}` : `${comment.start}–${comment.end}`;
const lastActivity = (comment: Comment) => [comment.createdAt, ...(comment.replies ?? []).map((reply) => reply.createdAt)].sort().at(-1)!;

export function Workspace({ review, change, saving, theme, path, initialCommit, initialChanges, onReload, stack, onStack, buttons }: Props) {
  const t = useTranslations("app");
  const format = useFormatter();
  const branchFiles = useMemo(() => reviewFiles(review), [review.id, review.patch]);

  // Scope: the whole branch, one chapter or one commit.
  const [scope, setScopeState] = useState<Scope>(initialChanges ? { kind: "changes", chapter: null } : initialCommit ? { kind: "commit", sha: initialCommit } : { kind: "branch" });
  const [commitReview, setCommitReview] = useState<Review>();
  const commitLoading = scope.kind === "commit" && !(commitReview?.source.kind === "local" && commitReview.source.commit === scope.sha);
  const scopedCommit = scope.kind === "commit" && !commitLoading ? commitReview : undefined;
  // The agent thread's changes since the user last looked (see `openChanges`), loaded with their scope.
  const [changes, setChanges] = useState<Changes | null>(null);
  const [changesError, setChangesError] = useState("");
  const inChanges = scope.kind === "changes";
  const scopedChanges = inChanges ? changes?.review ?? undefined : undefined;
  const scopedSnapshot = scopedCommit ?? scopedChanges;
  // The snapshot the reader shows; comments live in the shared folder, so the review's are its comments too.
  const shown: Review = scopedSnapshot ? { ...scopedSnapshot, comments: review.comments, github: review.github } : review;
  const shownFiles = useMemo(() => scopedSnapshot ? reviewFiles(scopedSnapshot) : branchFiles, [scopedSnapshot?.id, branchFiles]);
  useEffect(() => {
    setCommitParam(scope.kind === "commit" ? scope.sha : undefined);
    if (scope.kind !== "commit" || (commitReview?.source.kind === "local" && commitReview.source.commit === scope.sha)) return;
    let alive = true;
    api.openCommit.mutate({ id: review.id, commit: scope.sha })
      .then((next) => { if (alive) setCommitReview(next); })
      .catch((error) => { if (alive) { toast.error(error instanceof Error ? error.message : t("error"), { id: "workspace" }); setScopeState({ kind: "branch" }); } });
    return () => { alive = false; };
  }, [scope.kind === "commit" ? scope.sha : null]);

  // The review map (map.json, written by an agent): chapters of hunks in
  // reading order. The scope's: the branch's, or in the changes scope the
  // map of those changes to what the user asked.
  const mapReview = inChanges ? scopedChanges : review;
  const mapFiles = inChanges ? shownFiles : branchFiles;
  // `outdated` is set when the map was written for another diff (an older
  // head): it still shows, and what it names that this diff lacks is listed in its chapters.
  const [mapData, setMapData] = useState<{ id: string; map: ReviewMap | null; outdated: { revision: string | null } | null } | null>(null);
  const reviewMap = mapData && mapData.id === mapReview?.id ? mapData.map : null;
  const mapOutdated = mapData && mapData.id === mapReview?.id ? mapData.outdated : null;
  const [mapError, setMapError] = useState("");
  const [mapLoaded, setMapLoaded] = useState(false);
  useEffect(() => {
    setMapError("");
    const id = mapReview?.id;
    if (!id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let last = "";
    async function poll() {
      try {
        const next = await api.map.query({ id: id! });
        const text = JSON.stringify(next);
        if (!stopped && text !== last) { last = text; setMapData({ id: id!, ...next }); }
        if (!stopped) { setMapError(""); setMapLoaded(true); }
      } catch (error) {
        if (!stopped) { setMapError(error instanceof Error ? error.message : t("error")); setMapLoaded(true); }
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [mapReview?.id]);
  const chapters = useMemo(() => reviewMap ? resolveMap(reviewMap, mapFiles) : [], [reviewMap, mapFiles]);
  const chapterOfHunk = useMemo(() => new Map(chapters.flatMap((chapter, index) => chapter.hunks.map((key) => [key, index] as const))), [chapters]);
  const scopeChapter = scope.kind === "chapter" ? scope.index : scope.kind === "changes" ? scope.chapter : null;
  const shownChapter = scopeChapter !== null && scopeChapter < chapters.length ? scopeChapter : null;
  // The map's notes on lines of the branch diff.
  const notes = useMemo(() => chapters.flatMap((chapter) => chapter.notes), [chapters]);

  // What the agent threads are doing with the last map request and the
  // questions still owed a reply (see the `progress` query), while the tab is visible.
  const [progress, setProgress] = useState<Progress | null>(null);
  // Once a thread's changes are loaded, their map request is followed too.
  const changesOf = useRef<string | undefined>(undefined);
  changesOf.current = changes?.threadId;
  function refreshProgress() {
    return api.progress.query({ id: review.id, changesOf: changesOf.current }).then((next) => { setProgress(next); toast.dismiss("progress"); })
      .catch((error) => toast.error(error instanceof Error ? error.message : t("error"), { id: "progress" }));
  }
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (document.visibilityState === "visible") await refreshProgress();
      if (!stopped) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [review.id]);
  // "Map ready" stays in the pill until the map is opened; which request
  // that was is remembered per review (and per thread for its changes).
  const mapSeenKey = inChanges && changes ? `pr-review:map-seen:changes:${changes.threadId}` : `pr-review:map-seen:${review.source.url}`;
  const [mapSeenByKey, setMapSeenByKey] = useState<Record<string, string>>({});
  const mapSeen = mapSeenByKey[mapSeenKey] ?? stored(mapSeenKey, "");
  const mapJob = (inChanges ? progress?.changesMap : progress?.map) ?? null;
  const mapPending = mapJob?.state === "requested" || mapJob?.state === "working";
  function dismissMapJob() {
    if (!mapJob || mapPending) return;
    setMapSeenByKey((old) => ({ ...old, [mapSeenKey]: mapJob.requestedAt }));
    store(mapSeenKey, mapJob.requestedAt);
  }
  useEffect(() => { if (shownChapter !== null) dismissMapJob(); }, [shownChapter !== null, mapJob?.state]);
  // A clock for the timers, ticking only while the agent works on something.
  const [now, setNow] = useState(Date.now());
  const ticking = mapPending || Object.values(progress?.replies ?? {}).some((state) => state !== "finished");
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  // Read state of the branch or PR: hunk ids and ticked check items (shared/read.ts).
  const [read, setReadState] = useState<Set<string>>(new Set());
  const [readLoaded, setReadLoaded] = useState(false);
  useEffect(() => {
    api.read.query({ id: review.id }).then((keys) => { setReadState(new Set(keys)); setReadLoaded(true); })
      .catch((error) => toast.error(error instanceof Error ? error.message : t("error"), { id: "workspace" }));
  }, [review.id]);
  async function setRead(keys: string[], value: boolean) {
    if (!keys.length) return;
    try { setReadState(new Set(await api.setRead.mutate({ id: review.id, keys, read: value }))); }
    catch (error) { toast.error(error instanceof Error ? error.message : t("error"), { id: "workspace" }); }
  }
  const branchIds = useMemo(() => hunkIds(branchFiles), [branchFiles]);
  const shownIds = useMemo(() => scopedSnapshot ? hunkIds(shownFiles) : branchIds, [shownFiles, branchIds]);
  // Ids of the hunks the scope's map is about.
  const mapIds = inChanges ? shownIds : branchIds;
  const chapterIds = (index: number) => chapters[index].hunks.map((key) => mapIds.get(key)!);
  const chapterRead = (index: number) => chapterIds(index).every((id) => read.has(id));
  const fileIds = (name: string) => [...shownIds].filter(([key]) => key.slice(0, key.lastIndexOf("#")) === name).map(([, id]) => id);
  const readFiles = useMemo(() => new Set(shownFiles.filter((file) => fileIds(file.name).every((id) => read.has(id))).map((file) => file.name)), [shownFiles, shownIds, read]);
  // A review that already has a map opens on its first unread chapter.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !mapLoaded || !readLoaded) return;
    opened.current = true;
    if (!chapters.length) return;
    setRailTab("map");
    if (scope.kind !== "branch") return;
    const next = chapters.findIndex((chapter, index) => !skippable(chapter) && !chapterRead(index));
    setScope({ kind: "chapter", index: next < 0 ? 0 : next });
  }, [mapLoaded, readLoaded]);

  // The whole file at the cursor (`o`) or a search result: the head version
  // with this review's changes marked. Esc returns to the scope.
  const [wholeFile, setWholeFile] = useState<{ file: string; line: number; side: DiffCursor["side"]; contents?: string; back: DiffCursor | null } | null>(null);
  // When the reader shows everything read (Space past the last chapter).
  const [done, setDone] = useState(false);
  function setScope(next: Scope) {
    setDone(false);
    setWholeFile(null);
    setScopeState(next);
    afterRender(() => viewer.current?.scrollTo({ type: "position", position: 0, behavior: "instant" }));
  }

  // Files of which the chapter shows only some hunks: their unchanged context
  // must not load, or expanding it would show the other hunks' lines as
  // unchanged.
  const partialFiles = useRef(new Set<string>());
  const files = useMemo(() => {
    partialFiles.current = new Set();
    if (wholeFile) return shownFiles.filter((file) => file.name === wholeFile.file && !wholeFile.contents);
    if (commitLoading || (inChanges && !scopedChanges)) return [];
    if (shownChapter === null || !mapReview) return shownFiles;
    const keys = chapters[shownChapter].hunks;
    const cut = parseFiles(chapterPatch(mapReview.patch, mapFiles, new Set(keys)));
    cut.forEach((file, index) => {
      file.cacheKey = `${mapReview.id}:chapter${shownChapter}:${index}`;
      if (file.hunks.length < (mapFiles.find((full) => full.name === file.name)?.hunks.length ?? 0)) partialFiles.current.add(file.name);
    });
    return cut;
  }, [shownFiles, mapFiles, chapters, shownChapter, commitLoading, inChanges, scopedChanges?.id, wholeFile?.file, wholeFile?.contents]);
  // The repository's file filters: matching files stay in the review but
  // start collapsed, like generated files (see the effect below).
  const filterScope = review.source.kind === "local" ? { checkout: review.source.repo } : {};
  const [filters, setFilters] = useState<FileFilter[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    api.filters.query(filterScope).then((next) => { if (alive) setFilters(next); }).catch(() => {});
    return () => { alive = false; };
  }, [filterScope.checkout]);
  const filtered = useMemo(() => filteredFiles(shownFiles.map((file) => file.name), filters), [shownFiles, filters]);
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
  // A chapter may not contain the active file.
  useEffect(() => {
    if (files.length && !files.some((file) => file.name === active)) setActive(files[0].name);
  }, [files]);
  useEffect(() => { if (scopedSnapshot) setCollapsedFiles((old) => new Set([...old, ...(scopedSnapshot.generatedFiles ?? [])])); }, [scopedSnapshot?.id]);
  // Filters arrive after the first render and can be edited: collapse what
  // newly matches, and reopen what an earlier set collapsed but this one
  // no longer does. Files the reader toggled since keep their state.
  const appliedFilter = useRef<Set<string>>(new Set());
  useEffect(() => {
    const previous = appliedFilter.current;
    appliedFilter.current = filtered;
    setCollapsedFiles((current) => {
      const next = new Set(current);
      for (const name of filtered) if (!previous.has(name)) next.add(name);
      for (const name of previous) if (!filtered.has(name)) next.delete(name);
      return next;
    });
  }, [filtered]);

  // The three regions: guide rail, reader, agent panel. Tab moves between them.
  const [rail, setRail] = useState(() => stored("pr-review:sidebar", "on") !== "off");
  const [panel, setPanel] = useState(() => stored("pr-review:panel", "on") !== "off");
  const [focus, setFocusState] = useState<Focus>("reader");
  const [railTab, setRailTab] = useState<RailTab>("files");
  const [railIndex, setRailIndex] = useState(0);
  const [inboxIndex, setInboxIndex] = useState(0);
  const [picker, setPicker] = useState(false);
  // T3 Code threads working in this checkout, most recently active first;
  // questions (`a`, `A`) and map requests go to the chosen one.
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>(initialChanges?.threadId);
  const [threadsError, setThreadsError] = useState("");
  const [threadPicker, setThreadPicker] = useState(false);
  const thread = threads.find((item) => item.id === threadId) ?? threads[0];
  function loadThreads() {
    api.threads.query({ id: review.id })
      .then((next) => { setThreads(next); setThreadsError(""); })
      .catch((error) => setThreadsError(error instanceof Error ? error.message : t("error")));
  }
  useEffect(loadThreads, [review.id]);
  // The changes scope: the thread's turns since the user last looked. `g n`
  // enters it, or reloads it there; a thread picked with `gA` loads its own.
  function loadChanges(id: string) {
    setChangesError("");
    api.openChanges.mutate({ id: review.id, threadId: id })
      .then((next) => { setChanges({ ...next, threadId: id }); void refreshProgress(); })
      .catch((error) => setChangesError(error instanceof Error ? error.message : t("error")));
  }
  function openChanges() {
    if (!thread) return void setChangesError(threadsError || t("noAgentThread"));
    cursor.current = null;
    cursorPosition.set(null);
    setScope({ kind: "changes", chapter: null });
    loadChanges(thread.id);
  }
  useEffect(() => { if (inChanges && thread && changes?.threadId !== thread.id) loadChanges(thread.id); }, [inChanges, thread?.id]);
  useEffect(() => {
    if (!initialChanges) return;
    setThreadId(initialChanges.threadId);
    setScope({ kind: "changes", chapter: null });
    if (changes?.threadId === initialChanges.threadId) loadChanges(initialChanges.threadId);
  }, [initialChanges]);
  async function markChangesReviewed() {
    const range = scopedChanges?.source.kind === "local" ? scopedChanges.source.changes : undefined;
    if (!changes || !range) return;
    try {
      await api.markChangesReviewed.mutate({ threadId: changes.threadId, turn: range.to });
      toast.success(t("changes.marked", { turn: range.to }), { id: "workspace" });
      setDone(false);
      loadThreads();
      loadChanges(changes.threadId);
    } catch (error) { toast.error(error instanceof Error ? error.message : t("error"), { id: "workspace" }); }
  }
  function agentThread() {
    if (thread) return thread;
    toast.error(threadsError || t("noAgentThread"), { id: "workspace" });
  }
  // Split or unified, remembered separately for the reader beside the panel
  // (unified by default: the panel leaves it about 1100px) and without it.
  const layoutKey = panel ? "pr-review:layout:panel" : "pr-review:layout";
  const [layouts, setLayouts] = useState(() => ({
    "pr-review:layout:panel": stored("pr-review:layout:panel", "unified"),
    "pr-review:layout": stored("pr-review:layout", window.innerWidth < 850 ? "unified" : "split"),
  }));
  const layout: "split" | "unified" = wholeFile ? "unified" : layouts[layoutKey] === "split" ? "split" : "unified";
  function setLayout(next: "split" | "unified") {
    setLayouts((old) => ({ ...old, [layoutKey]: next }));
    store(layoutKey, next);
  }
  const [wrap, setWrap] = useState(false);
  const [selectionFile, setSelectionFile] = useState("");
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const cursor = useRef<DiffCursor | null>(null);
  const commentsRef = useRef(review.comments);
  commentsRef.current = review.comments;
  // Comments whose lines are in the snapshot shown (GitHub threads only on the PR's own head).
  const shownInline = (comment: Comment) =>
    !comment.github
      ? !comment.snapshotId || comment.snapshotId === shown.id
      : !scopedSnapshot && !comment.github.outdated && !comment.github.deleted && review.github?.head === review.revision;
  const [nearbyReply, setNearbyReply] = useState<string | null>(null);
  function nearbyThread(position: DiffCursor | null) {
    if (!position) return undefined;
    return commentsRef.current.filter((comment) =>
      comment.file === position.id && comment.side === position.side && shownInline(comment) &&
      position.line >= comment.start - 1 && position.line <= comment.end + 1
    ).sort((a, b) => Math.abs(a.end - position.line) - Math.abs(b.end - position.line))[0];
  }
  useEffect(() => { setNearbyReply(nearbyThread(cursor.current)?.id ?? null); }, [review.comments]);
  const visualAnchor = useRef<DiffCursor | null>(null);
  const [visual, setVisual] = useState(false);
  const visualKind = useRef<"character" | "line">("character");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const searchTerm = useRef("");
  const [searchMatches, setSearchMatches] = useState<Array<DiffCursor & { text: string }>>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  function jumpMatch(index: number, matches = searchMatches) {
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
    const matches = searchDiffs(files, searchInput);
    setSearchMatches(matches);
    setSearchOpen(false);
    setMatchIndex(0);
    for (const item of viewer.current?.getInstance()?.getRenderedItems() ?? []) {
      if (item.element.shadowRoot) paintSearch(item.element.shadowRoot, searchInput);
    }
    if (searchInput) {
      const current = cursor.current;
      const next = current ? matches.findIndex((match) => match.id === current.id && match.side === current.side &&
        (match.line > current.line || match.line === current.line && match.column > current.column)) : 0;
      jumpMatch(Math.max(0, next), matches);
    }
    scroll.current?.focus();
  }
  // `*`: the word under the cursor across the repository, at the head.
  const [repoSearch, setRepoSearch] = useState<{ word: string; matches: Array<{ file: string; line: number; text: string }>; state: string }>({ word: "", matches: [], state: "" });
  async function searchRepo() {
    if (!cursor.current) moveLine(0);
    const position = cursor.current;
    if (!position) return;
    const text = lineText(position);
    const at = Math.min(position.column, Math.max(0, text.length - 1));
    const word = [...text.matchAll(/\w+/g)].find((match) => match.index <= at && at < match.index + match[0].length)?.[0];
    if (!word) return void toast.message(t("noWordHere"), { id: "workspace" });
    setRepoSearch({ word, matches: [], state: t("searching") });
    openRail("search");
    try {
      const result = await api.grep.query({ id: shown.id, word });
      setRepoSearch({ word, matches: result.matches, state: result.more ? t("moreMatches", { count: result.matches.length }) : "" });
    } catch (error) {
      setRepoSearch({ word, matches: [], state: error instanceof Error ? error.message : t("error") });
    }
  }
  const searchRows: SearchRow[] = [
    ...searchMatches.map((match) => ({ file: match.id, line: match.line, side: match.side, text: match.text, kind: "diff" as const })),
    ...repoSearch.matches.map((match) => ({ ...match, side: "additions" as const, kind: "repo" as const })),
  ];
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
      expandUnchanged: Boolean(wholeFile),
      onLineClick: (props, context) => {
        if (!props.event.shiftKey) endVisual();
        moveCursor({
          id: context.item.id,
          line: props.lineNumber,
          side: "annotationSide" in props ? props.annotationSide : "additions",
          column: columnAtPoint(
            props.lineElement,
            props.event.clientX,
            props.event.clientY,
          ),
        });
        setFocus("reader");
      },
      onLineNumberClick: (props, context) => {
        moveCursor({
          id: context.item.id,
          line: props.lineNumber,
          side: "annotationSide" in props ? props.annotationSide : "additions",
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
      loadDiffFiles: async (file: FileDiffMetadata) => {
        if (partialFiles.current.has(file.name)) {
          toast.message(t("partialFileContext"), { id: "workspace" });
          throw new Error(t("partialFileContext"));
        }
        try {
          return await api.fileContext.query({
            id: shown.id,
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
    [theme, layout, wrap, shown.id, t, Boolean(wholeFile)],
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
  const index = files.findIndex((file) => file.name === active);
  const statsByFile = useMemo(
    () => new Map(shownFiles.map((file) => [file.name, fileStats(file)])),
    [shownFiles],
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
    ask = false,
  ) {
    const current = files.find((file) => file.name === filename);
    if (!range || !current || wholeFile) {
      setWarning(t(wholeFile ? "commentInWholeFile" : "selectionRequired"));
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
      setPanelOpen(true);
      updateDraft({ file: current.name, side, start, end, body: "", ...(ask ? { ask } : {}) });
      setFocus("panel");
      setWarning("");
    } catch (error) {
      setWarning(error instanceof Error ? error.message : t("error"));
    }
  }

  // Mutations on a commit's snapshot return it; the review keeps its own
  // snapshot and takes the shared comments.
  const changeShown = (operation: () => Promise<Review>) => change(async () => {
    const next = await operation();
    return next.id === review.id ? next : { ...review, comments: next.comments, github: next.github };
  });
  // A thread just created opens in the panel once the review has it.
  const openCreated = useRef<Set<string> | null>(null);
  useEffect(() => {
    const before = openCreated.current;
    const created = before && review.comments.find((comment) => !before.has(comment.id));
    if (created) { openCreated.current = null; setOpenThread(created.id); }
  }, [review.comments]);
  async function save(body: string, destination: "local" | "github") {
    if (!draft || !body.trim() || saving) return;
    if (!draft.commentId) openCreated.current = new Set(review.comments.map((comment) => comment.id));
    const target = draft.ask ? agentThread() : undefined;
    if (draft.ask && !target) return;
    if (
      await changeShown(() => {
        const { ask: _ask, ...fields } = draft!;
        return target
          ? api.ask.mutate({ id: shown.id, file: fields.file, side: fields.side, start: fields.start, end: fields.end, body, threadId: target.id })
          : api.saveComment.mutate({ id: shown.id, ...fields, body, destination });
      })
    ) {
      updateDraft();
      setSelection(null);
      setFocus("reader");
      if (target) void refreshProgress();
    } else openCreated.current = null;
  }

  function edit(comment: Comment) {
    if (draft) {
      focusDraftEditor();
      return;
    }
    setPanelOpen(true);
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
    setFocus("panel");
  }

  const itemCache = useRef(
    new Map<
      string,
      { signature: string; item: CodeViewItem<Annotation> }
    >(),
  );
  const items = useMemo(
    (): CodeViewItem<Annotation>[] => {
      if (wholeFile?.contents !== undefined)
        return [{ id: wholeFile.file, type: "file", file: { name: wholeFile.file, contents: wholeFile.contents } }];
      return files.map((file) => {
        const comments = review.comments.filter((comment) => comment.file === file.name && shownInline(comment));
        // Notes are on the lines of the map's diff: not in a commit's.
        const fileNotes = scope.kind === "commit" ? [] : notes.filter((note) => note.file === file.name);
        const signature = JSON.stringify([
          comments,
          fileNotes,
          Boolean(wholeFile),
          collapsedFiles.has(file.name),
          readFiles.has(file.name),
        ]);
        const previous = itemCache.current.get(file.name);
        if (
          previous?.signature === signature &&
          previous.item.type === "diff" &&
          previous.item.fileDiff === file
        )
          return previous.item;
        const map = new Map<string, DiffLineAnnotation<Annotation>>();
        const at = (side: Comment["side"], lineNumber: number) => {
          const key = `${side}:${lineNumber}`;
          const annotation = map.get(key) ?? { side, lineNumber, metadata: { comments: [], notes: [] } };
          map.set(key, annotation);
          return annotation.metadata;
        };
        for (const comment of comments) at(comment.side, comment.end).comments.push(comment);
        for (const note of fileNotes) at(note.side, note.end).notes.push(note);
        const item: CodeViewItem<Annotation> = {
          id: file.name,
          type: "diff",
          fileDiff: file,
          annotations: [...map.values()],
          collapsed: !wholeFile && collapsedFiles.has(file.name),
          version: (previous?.item.version ?? 0) + 1,
        };
        itemCache.current.set(file.name, { signature, item });
        return item;
      });
    },
    [files, review.comments, readFiles, collapsedFiles, notes, Boolean(wholeFile), wholeFile?.contents],
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

  const currentFile = () => cursor.current?.id ?? active;
  function goToComment(delta: 1 | -1) {
    const order = (comment: Comment) => files.findIndex((file) => file.name === comment.file);
    const threads = review.comments.filter((comment) => shownInline(comment) && order(comment) >= 0).sort((a, b) => order(a) - order(b) || a.end - b.end);
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
    setSearchMatches([]);
    setSearchQuery("");
    for (const item of viewer.current?.getInstance()?.getRenderedItems() ?? []) {
      if (item.element.shadowRoot) paintSearch(item.element.shadowRoot, "");
    }
  }
  function focusDraftEditor() {
    if (!draft) return;
    setPanelOpen(true);
    setFocusState("panel");
    let attempts = 0;
    const focus = () => {
      const editor = document.querySelector<HTMLTextAreaElement>("[data-draft-editor] textarea");
      if (editor) editor.focus();
      else if (attempts++ < 30) requestAnimationFrame(focus);
    };
    requestAnimationFrame(focus);
  }
  /** The selection, or else the cursor line. */
  function rangeHere(): [SelectedLineRange, string] | undefined {
    if (selection) return [selection, selectionFile];
    if (!cursor.current) moveLine(0);
    const position = cursor.current;
    if (position) return [{ start: position.line, end: position.line, side: position.side }, position.id];
  }
  function commentHere(ask = false) {
    if (draft) return focusDraftEditor();
    const here = rangeHere();
    if (here) startComment(here[0], here[1], ask);
  }
  // Sends the default question without opening the editor.
  async function explainHere() {
    const here = rangeHere();
    const target = agentThread();
    if (!here || !target) return;
    const [range, file] = here;
    if (range.endSide && range.endSide !== (range.side ?? "additions")) return setWarning(t("crossSide"));
    openCreated.current = new Set(review.comments.map((comment) => comment.id));
    if (await changeShown(() => api.ask.mutate({
      id: shown.id, file, side: range.side ?? "additions",
      start: Math.min(range.start, range.end), end: Math.max(range.start, range.end),
      body: t("explainQuestion"), threadId: target.id,
    }))) {
      endVisual();
      setSelection(null);
      void refreshProgress();
    } else openCreated.current = null;
  }
  function setAllCollapsed(collapse: boolean) {
    setCollapsedFiles(new Set(collapse ? files.map((file) => file.name) : []));
  }

  // Regions and focus.
  function setFocus(next: Focus) {
    setFocusState(next);
    if (next === "reader") scroll.current?.focus();
    else document.querySelector<HTMLElement>(next === "panel" ? ".agent-panel" : ".guide-rail")?.focus();
  }
  function setPanelOpen(open: boolean) {
    setPanel(open);
    store("pr-review:panel", open ? "on" : "off");
    if (!open && focus === "panel") setFocus("reader");
  }
  function setRailOpen(open: boolean) {
    setRail(open);
    store("pr-review:sidebar", open ? "on" : "off");
    if (!open && focus === "guide") setFocus("reader");
  }
  const regions = (): Focus[] => [...(rail ? ["guide" as const] : []), "reader", ...(panel ? ["panel" as const] : [])];
  function cycleFocus(delta: 1 | -1) {
    const list = regions();
    const next = list[(list.indexOf(focus) + delta + list.length) % list.length];
    if (next === "guide") setRailIndex(railCurrent());
    setFocus(next);
  }
  function openRail(tab: RailTab, focusIt = false) {
    setRailOpen(true);
    setRailTab(tab);
    if (tab === "commits") loadCommits();
    if (focusIt) { setRailIndex(railCurrent(tab)); requestAnimationFrame(() => setFocus("guide")); }
  }

  // Agent replies (anyone but "You" on a local comment) the reader has not
  // seen, kept per review in localStorage. The first visit counts what is
  // already there as seen; the cursor on a marker or opening the
  // conversation marks a thread's replies seen.
  const readKey = `pr-review:read:${review.source.url}`;
  const agentReplies = useMemo(() => review.comments.filter((comment) => !comment.github).flatMap((comment) =>
    (comment.replies ?? []).filter((reply) => reply.author !== "You").map((reply) => ({ comment, reply }))), [review.comments]);
  const [seen, setSeen] = useState(() => {
    try {
      const saved = localStorage.getItem(readKey);
      if (saved) return new Set<string>(JSON.parse(saved));
      const ids = agentReplies.map(({ reply }) => reply.id);
      localStorage.setItem(readKey, JSON.stringify(ids));
      return new Set(ids);
    } catch {
      return new Set(agentReplies.map(({ reply }) => reply.id));
    }
  });
  const unread = agentReplies.filter(({ reply }) => !seen.has(reply.id));
  const unreadOf = (id: string) => unread.filter(({ comment }) => comment.id === id).length;
  function markSeen(commentId: string) {
    const ids = unread.filter(({ comment }) => comment.id === commentId).map(({ reply }) => reply.id);
    if (!ids.length) return;
    const next = new Set([...seen, ...ids]);
    setSeen(next);
    store(readKey, JSON.stringify([...next]));
  }
  useEffect(() => { if (nearbyReply) markSeen(nearbyReply); }, [nearbyReply, agentReplies]);

  // Threads: their state, the chapter they belong to, the inbox.
  const run = (comment: Comment) => progress?.replies[comment.id] && awaitingReply(comment) ? progress.replies[comment.id] : undefined;
  const stateOf = (comment: Comment): ThreadState => threadState(comment, run(comment), unreadOf(comment.id));
  /** The map chapter of a thread on the snapshot the scope's map is of. */
  function chapterOf(comment: Comment) {
    if (comment.snapshotId && comment.snapshotId !== mapReview?.id) return null;
    const file = mapFiles.find((file) => file.name === comment.file);
    const prefix = comment.side === "additions" ? "addition" : "deletion";
    const hunk = file?.hunks.findIndex((hunk) => comment.end >= hunk[`${prefix}Start`] && comment.end < hunk[`${prefix}Start`] + Math.max(1, hunk[`${prefix}Count`])) ?? -1;
    return file && hunk >= 0 ? chapterOfHunk.get(hunkKey(file.name, hunk)) ?? null : null;
  }
  const location = (comment: Comment) => {
    const chapter = chapterOf(comment);
    return `${basename(comment.file)} ${lineRange(comment)}${comment.side === "deletions" ? ` ${t("old")}` : ""}${chapter !== null ? ` · ${t("chapterShort", { index: chapter + 1 })}` : ""}${shownInline(comment) ? "" : ` · ${t("earlierSnapshot")}`}`;
  };
  const inbox = useMemo(() => {
    const ordered = [...review.comments].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
    return inboxOrder.flatMap((state) => ordered.filter((comment) => stateOf(comment) === state));
  }, [review.comments, progress, seen]);
  const inboxItems: InboxItem[] = inbox.map((comment) => {
    const state = stateOf(comment);
    const latest = (comment.replies ?? []).filter((reply) => reply.author !== "You").at(-1);
    const since = awaitingReply(comment);
    return {
      id: comment.id, state, title: threadTitle(comment), location: location(comment),
      finished: run(comment) === "finished",
      time: format.relativeTime(new Date(lastActivity(comment)), now),
      timer: state === "working" && since ? elapsed(since, now) : undefined,
      preview: state === "new" && latest ? latest.body.replace(/```\w*/g, "").replace(/\s+/g, " ").trim().slice(0, 180) : undefined,
    };
  });
  const [openThread, setOpenThreadState] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<string | null>(null);
  function setOpenThread(id: string | null) {
    setOpenThreadState(id);
    if (id) { markSeen(id); setPanelOpen(true); setInboxIndex(Math.max(0, inbox.findIndex((comment) => comment.id === id))); }
  }
  const opened_ = review.comments.find((comment) => comment.id === openThread);
  /** Moves the reader to a thread's lines: into its chapter, or out of a chapter that lacks them. */
  function reveal(comment: Comment) {
    if (!shownInline(comment)) return;
    const visible = () => files.some((file) => file.name === comment.file) && !wholeFile;
    if (visible() && (shownChapter === null || chapterOf(comment) === shownChapter))
      return jumpTo({ id: comment.file, line: comment.end, side: comment.side, column: 0 });
    const chapter = chapterOf(comment);
    setScope(inChanges ? { kind: "changes", chapter: shownChapter !== null ? chapter : null }
      : chapter !== null && scope.kind === "chapter" ? { kind: "chapter", index: chapter } : scope.kind === "commit" ? scope : { kind: "branch" });
    afterRender(() => afterRender(() => jumpTo({ id: comment.file, line: comment.end, side: comment.side, column: 0 })));
  }
  // `i`: the next thread with a new reply: the reader jumps to it and the panel opens it.
  function goToUnread() {
    const targets = inbox.filter((comment) => stateOf(comment) === "new");
    if (!targets.length) return void toast.message(t("noNewReplies"), { id: "workspace" });
    const target = targets.find((comment) => comment.id !== openThread) ?? targets[0];
    setOpenThread(target.id);
    reveal(target);
  }
  function openInboxItem(id: string, jump: boolean) {
    const comment = review.comments.find((comment) => comment.id === id);
    if (!comment) return;
    setOpenThread(id);
    if (jump) reveal(comment);
  }
  const nearby = () => focus === "panel" ? inbox[inboxIndex] : nearbyThread(cursor.current);
  function replyTo(comment: Comment) {
    setOpenThread(comment.id);
    setReplyTarget(comment.id);
    setFocusState("panel");
  }
  function deleteThread(comment: Comment) {
    if (deleting !== comment.id) {
      setOpenThread(comment.id);
      setDeleting(comment.id);
      return;
    }
    void changeShown(() => api.deleteComment.mutate({ id: shown.id, commentId: comment.id }))
      .then((deleted) => { if (deleted) { setDeleting(undefined); setOpenThreadState(null); } });
  }

  // Chapters.
  function openChapter(index: number) {
    endVisual();
    setSelection(null);
    cursor.current = null;
    cursorPosition.set(null);
    setScope(inChanges ? { kind: "changes", chapter: index } : { kind: "chapter", index });
    dismissMapJob();
  }
  // The next chapter worth reading: skip-safe ones are passed over.
  function stepChapter(delta: 1 | -1) {
    if (!chapters.length) return void toast.message(t("noMap"), { id: "workspace" });
    const from = shownChapter ?? (delta > 0 ? -1 : chapters.length);
    for (let index = from + delta; index >= 0 && index < chapters.length; index += delta)
      if (!skippable(chapters[index])) return openChapter(index);
    toast.message(t(delta > 0 ? "lastChapter" : "firstChapter"), { id: "workspace" });
  }
  const firstUnread = (after = -1) => {
    const order = [...chapters.keys()].filter((index) => index > after).concat([...chapters.keys()].filter((index) => index <= after));
    return order.find((index) => !skippable(chapters[index]) && !chapterRead(index));
  };
  // Space: the chapter (or file) is read; on to the next unread one.
  async function readAndNext() {
    if (wholeFile) return;
    if (shownChapter !== null) {
      await setRead(chapterIds(shownChapter), true);
      const next = chapters.findIndex((chapter, index) => index > shownChapter && !skippable(chapter) && !chapterIds(index).every((id) => read.has(id)));
      const wrapped = next >= 0 ? next : chapters.findIndex((chapter, index) => index < shownChapter && !skippable(chapter) && !chapterIds(index).every((id) => read.has(id)));
      if (wrapped >= 0) openChapter(wrapped);
      else setDone(true);
      return;
    }
    const name = currentFile();
    const from = files.findIndex((file) => file.name === name);
    if (from < 0) return;
    await setRead(fileIds(name), true);
    toggleFile(name, true);
    const next = files.slice(from + 1).find((file) => !readFiles.has(file.name)) ??
      files.find((file) => file.name !== name && !readFiles.has(file.name));
    if (!next) return void setDone(true);
    // The collapse has to land before positions are measured.
    afterRender(() => openFile(next.name));
  }
  function toggleRead() {
    if (shownChapter !== null) return void setRead(chapterIds(shownChapter), !chapterRead(shownChapter));
    const name = currentFile();
    void setRead(fileIds(name), !readFiles.has(name));
  }
  // `x` off a thread ticks the brief's check items: a count picks the item, else the next unticked one.
  function tickCheck(item?: number) {
    if (shownChapter === null) return;
    const chapter = chapters[shownChapter];
    const ids = chapter.check.map((text) => checkId(chapter, text));
    const target = item ?? ids.findIndex((id) => !read.has(id));
    if (target < 0 || target >= ids.length) return;
    void setRead([ids[target]], !read.has(ids[target]));
  }

  // Commits: the review's own, oldest first, loaded when first needed.
  const [commits, setCommits] = useState<Awaited<ReturnType<typeof api.commits.query>> | null>(null);
  const [commitsError, setCommitsError] = useState("");
  const commitsRequested = useRef(false);
  function loadCommits() {
    if (commitsRequested.current) return;
    commitsRequested.current = true;
    api.commits.query({ id: review.id }).then(setCommits)
      .catch((error) => setCommitsError(error instanceof Error ? error.message : t("error")));
  }
  useEffect(() => { if (scope.kind === "commit") loadCommits(); }, [scope.kind]);
  useEffect(() => { commitsRequested.current = false; if (commits) loadCommits(); }, [reviewMap]);
  const commitRows: CommitRow[] | null = commits && commits.map((commit) => ({
    ...commit,
    read: commit.hunks.length > 0 && commit.hunks.every((hunk) => read.has(hunk.id)),
    chapters: [...new Set(commit.hunks.flatMap((hunk) => hunk.chapter === null ? [] : [hunk.chapter]))].sort((a, b) => a - b),
    uncovered: commit.hunks.filter((hunk) => hunk.chapter === null).length,
  }));
  const commitIndex = scope.kind === "commit" ? commits?.findIndex((commit) => commit.sha === scope.sha) ?? -1 : -1;
  function stepCommit(delta: 1 | -1) {
    if (!commits) { loadCommits(); return void toast.message(t("loadingCommits"), { id: "workspace" }); }
    const next = commitIndex < 0 ? (delta > 0 ? 0 : commits.length - 1) : commitIndex + delta;
    if (next < 0 || next >= commits.length) return void toast.message(t(delta > 0 ? "lastCommit" : "firstCommit"), { id: "workspace" });
    openCommit(commits[next].sha);
  }
  function openCommit(sha: string) {
    cursor.current = null;
    cursorPosition.set(null);
    setScope({ kind: "commit", sha });
  }

  // Whole files (`o`, search results).
  async function openWholeFile(file: string, line: number, side: DiffCursor["side"]) {
    const back = cursor.current;
    if (shownFiles.some((item) => item.name === file)) setWholeFile({ file, line, side, back });
    else {
      try { setWholeFile({ file, line, side, back, contents: await api.fileAt.query({ id: shown.id, file }) }); }
      catch (error) { return setWarning(error instanceof Error ? error.message : t("error")); }
    }
    setDone(false);
    endVisual();
    setSelection(null);
    cursor.current = null;
    setFocus("reader");
    // Context loads before every line is there.
    let attempts = 0;
    const land = () => {
      viewer.current?.scrollTo({ type: "line", id: file, lineNumber: line, side, align: "center", behavior: "instant" });
      const root = viewer.current?.getInstance()?.getRenderedItems().find((item) => item.id === file)?.element.shadowRoot;
      const node = [...root?.querySelectorAll<HTMLElement>(`[data-line="${line}"]`) ?? []].find((row) => cursorSide(row) === side);
      const view = scroll.current?.getBoundingClientRect();
      const top = node?.getBoundingClientRect().top;
      // Settled once the line is drawn inside the view.
      if (node && view && top !== undefined && top > view.top && top < view.bottom) moveCursor({ id: file, line, side, column: 0 });
      else if (attempts++ < 60) setTimeout(land, 50);
    };
    afterRender(land);
  }
  function closeWholeFile() {
    const back = wholeFile?.back;
    cursor.current = null;
    cursorPosition.set(null);
    setWholeFile(null);
    if (back) afterRender(() => jumpTo(back));
  }
  function openSearchRow(index: number) {
    const row = searchRows[index];
    if (!row) return;
    if (row.kind === "repo") return void openWholeFile(row.file, row.line, "additions");
    setFocus("reader");
    jumpMatch(index);
  }

  // A map request goes to the agent thread; its progress shows in the pill, the rail and the inbox.
  async function requestMap() {
    const target = agentThread();
    if (!target || !mapReview) return;
    try {
      await api.requestMap.mutate({ id: mapReview.id, threadId: target.id });
      void refreshProgress();
      setRailOpen(true);
    } catch (error) { toast.error(error instanceof Error ? error.message : t("error"), { id: "workspace" }); }
  }

  // The rail's list for the keyboard.
  const railCount = (tab = railTab) => tab === "map" ? chapters.length : tab === "files" ? shownFiles.length : tab === "commits" ? commits?.length ?? 0 : searchRows.length;
  const railCurrent = (tab = railTab) => Math.max(0, tab === "map" ? shownChapter ?? 0 : tab === "files" ? shownFiles.findIndex((file) => file.name === active) : tab === "commits" ? commitIndex : 0);
  function pickFile(name: string) {
    if (files.some((file) => file.name === name) && !wholeFile) return openFile(name);
    setScope(scope.kind === "commit" ? scope : inChanges ? { kind: "changes", chapter: null } : { kind: "branch" });
    afterRender(() => afterRender(() => openFile(name)));
  }
  function railOpenRow(index: number) {
    if (railTab === "map") openChapter(index);
    else if (railTab === "files") pickFile(shownFiles[index].name);
    else if (railTab === "commits" && commits?.[index]) openCommit(commits[index].sha);
    else if (railTab === "search") return openSearchRow(index);
    setFocus("reader");
  }

  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of review.comments) counts.set(comment.file, (counts.get(comment.file) ?? 0) + 1);
    return counts;
  }, [review.comments]);
  const unreadByFile = new Map<string, number>();
  for (const { comment } of unread) unreadByFile.set(comment.file, (unreadByFile.get(comment.file) ?? 0) + 1);
  const chapterProgress: ChapterProgress[] = chapters.map((chapter) => ({
    read: chapter.hunks.map((key) => read.has(mapIds.get(key)!)),
    newReplies: 0, working: 0,
  }));
  for (const comment of review.comments) {
    const chapter = chapterOf(comment);
    if (chapter === null) continue;
    const state = stateOf(comment);
    if (state === "new") chapterProgress[chapter].newReplies++;
    if (state === "working") chapterProgress[chapter].working++;
  }
  const chaptersRead = chapters.filter((_, index) => chapterRead(index)).length;
  const branchFilesRead = branchFiles.filter((file) => [...branchIds].filter(([key]) => key.slice(0, key.lastIndexOf("#")) === file.name).every(([, id]) => read.has(id))).length;
  const openQuestions = review.comments.filter((comment) => comment.thread && !comment.resolved).length;

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

    { id: "focusNext", group: "view", keys: ["Tab"], run: () => cycleFocus(1) },
    { id: "focusPrevious", group: "view", keys: ["Shift+Tab"], run: () => cycleFocus(-1) },
    { id: "fileNext", group: "jump", keys: ["]"], run: (times) => goToFile(times ?? 1) },
    { id: "filePrevious", group: "jump", keys: ["["], run: (times) => goToFile(-(times ?? 1)) },
    { id: "filePick", group: "jump", keys: ["f"], run: () => setPicker(true) },
    { id: "hunkNext", group: "jump", keys: ["}"], run: () => goToHunk(1) },
    { id: "hunkPrevious", group: "jump", keys: ["{"], run: () => goToHunk(-1) },
    { id: "commentNext", group: "jump", keys: [")"], run: () => goToComment(1) },
    { id: "commentPrevious", group: "jump", keys: ["("], run: () => goToComment(-1) },
    { id: "search", group: "jump", keys: ["/"], run: () => { setSearchInput(""); setSearchOpen(true); } },
    { id: "searchNext", group: "jump", keys: [";"], enabled: () => searchMatches.length > 0, run: () => jumpMatch(matchIndex + 1) },
    { id: "searchPrevious", group: "jump", keys: [","], enabled: () => searchMatches.length > 0, run: () => jumpMatch(matchIndex - 1) },
    { id: "wholeFile", group: "jump", keys: ["o"], run: () => {
      if (!cursor.current) moveLine(0);
      const position = cursor.current;
      if (position && !wholeFile) void openWholeFile(position.id, position.line, position.side);
    } },
    { id: "searchRepo", group: "jump", keys: ["*"], run: () => void searchRepo() },

    { id: "mapFocus", group: "scope", keys: ["M"], run: () => {
      openRail("map", true);
      if (!chapters.length) return void toast.message(t("noMap"), { id: "workspace" });
      if (shownChapter === null) openChapter(firstUnread() ?? 0);
    } },
    { id: "chapterNext", group: "scope", keys: [">"], run: () => stepChapter(1) },
    { id: "chapterPrevious", group: "scope", keys: ["<"], run: () => stepChapter(-1) },
    { id: "commitsFocus", group: "scope", keys: ["C"], run: () => openRail("commits", true) },
    { id: "commitNext", group: "scope", keys: ["g >"], enabled: () => review.source.kind === "local", run: () => stepCommit(1) },
    { id: "commitPrevious", group: "scope", keys: ["g <"], enabled: () => review.source.kind === "local", run: () => stepCommit(-1) },
    { id: "wholeBranch", group: "scope", keys: ["g B"], run: () => setScope({ kind: "branch" }) },
    { id: "changesOpen", group: "scope", keys: ["g n"], enabled: () => review.source.kind === "local", run: openChanges },
    { id: "changesReviewed", group: "scope", keys: ["g d"], enabled: () => Boolean(scopedChanges) && !saving, run: () => void markChangesReviewed() },
    { id: "readNext", group: "scope", keys: ["Space"], enabled: () => !saving, run: () => void readAndNext() },
    { id: "readToggle", group: "scope", keys: ["m"], enabled: () => !saving, run: toggleRead },
    { id: "requestMap", group: "scope", keys: ["g M"], enabled: () => !saving, run: () => void requestMap() },
    { id: "fileToggle", group: "files", keys: ["z a"], run: () => toggleFile(currentFile()) },
    { id: "fileCollapse", group: "files", keys: ["z c"], run: () => toggleFile(currentFile(), true) },
    { id: "fileExpand", group: "files", keys: ["z o"], run: () => toggleFile(currentFile(), false) },
    { id: "collapseAll", group: "files", keys: ["z M"], run: () => setAllCollapsed(true) },
    { id: "expandAll", group: "files", keys: ["z R"], run: () => setAllCollapsed(false) },

    { id: "comment", group: "comments", keys: ["c"], enabled: () => !saving, run: () => commentHere() },
    { id: "ask", group: "comments", keys: ["a"], enabled: () => !saving, run: () => commentHere(true) },
    { id: "explain", group: "comments", keys: ["A"], enabled: () => !saving, run: () => void explainHere() },
    { id: "agentThread", group: "comments", keys: ["g A"], run: () => { loadThreads(); setThreadPicker(true); } },
    { id: "threadOpen", group: "comments", keys: ["Enter"], enabled: () => Boolean(nearby()), run: () => { const comment = nearby()!; setOpenThread(comment.id); } },
    { id: "unreadNext", group: "comments", keys: ["i"], run: goToUnread },
    { id: "inboxFocus", group: "comments", keys: ["I"], run: () => { setPanelOpen(true); setInboxIndex(0); requestAnimationFrame(() => setFocus("panel")); } },
    { id: "commentsList", group: "comments", keys: ["g c"], run: () => { setPanelOpen(true); setOpenThreadState(null); setInboxIndex(0); requestAnimationFrame(() => setFocus("panel")); } },
    { id: "reply", group: "comments", keys: ["r"], enabled: () => Boolean(nearby()), run: () => replyTo(nearby()!) },
    { id: "resolve", group: "comments", keys: ["x"], enabled: () => { const comment = nearby(); return comment ? !saving && !(comment.github && !comment.github.canResolve) : shownChapter !== null; },
      run: (times) => {
        const comment = nearby();
        if (!comment) return tickCheck(times === undefined ? undefined : times - 1);
        void changeShown(() => api.resolveComment.mutate({ id: shown.id, commentId: comment.id, resolved: !comment.resolved }));
      } },
    { id: "commentEdit", group: "comments", keys: ["e"], enabled: () => { const comment = nearby(); return Boolean(comment) && !saving && !(comment!.github && !comment!.github.canEdit); }, run: () => edit(nearby()!) },
    { id: "commentDelete", group: "comments", keys: ["D"], enabled: () => { const comment = nearby(); return Boolean(comment) && !saving && !comment!.github; }, run: () => deleteThread(nearby()!) },

    { id: "visual", group: "select", keys: ["v"], hidden: true, run: () => toggleVisual("character") },
    { id: "visualLine", group: "select", keys: ["V"], hidden: true, run: () => toggleVisual("line") },
    { id: "yank", group: "select", keys: ["y"], hidden: true, enabled: () => Boolean(selection), run: () => void yankSelection() },
    { id: "cancel", group: "select", keys: ["Escape"], hidden: true, run: () => {
      if (deleting) setDeleting(undefined);
      else if (visualAnchor.current || selection) { endVisual(); setSelection(null); }
      else if (searchQuery) clearSearch();
      else if (wholeFile) closeWholeFile();
      else if (focus !== "reader") setFocus("reader");
    } },

    { id: "layoutToggle", group: "view", keys: ["u"], run: () => setLayout(layout === "split" ? "unified" : "split") },
    { id: "wrapToggle", group: "view", keys: ["g w"], run: () => setWrap(!wrap) },
    { id: "railToggle", group: "view", keys: ["\\"], run: () => setRailOpen(!rail) },
    { id: "panelToggle", group: "view", keys: ["|"], run: () => setPanelOpen(!panel) },
    { id: "filtersEdit", group: "files", keys: ["g f"], run: () => setFiltersOpen(true) },
    { id: "filtersToggle", group: "files", keys: ["z f"], enabled: () => filtered.size > 0, run: () => {
      // Expand the filtered files if all are collapsed, otherwise collapse them.
      const expand = [...filtered].every((name) => collapsedFiles.has(name));
      setCollapsedFiles((current) => {
        const next = new Set(current);
        for (const name of filtered) if (expand) next.delete(name); else next.add(name);
        return next;
      });
    } },

    // With the rail focused: its list.
    { id: "railDown", group: "rail", keys: ["t", "j", "ArrowDown"], hidden: true, enabled: () => focus === "guide", run: (times) => setRailIndex(Math.min(railCount() - 1, railIndex + (times ?? 1))) },
    { id: "railUp", group: "rail", keys: ["n", "k", "ArrowUp"], hidden: true, enabled: () => focus === "guide", run: (times) => setRailIndex(Math.max(0, railIndex - (times ?? 1))) },
    { id: "railOpen", group: "rail", keys: ["Enter"], enabled: () => focus === "guide" && railCount() > 0, run: () => railOpenRow(railIndex) },
    { id: "railTabNext", group: "rail", keys: ["s", "l", "ArrowRight"], enabled: () => focus === "guide", run: () => { const tab = railTabs[(railTabs.indexOf(railTab) + 1) % railTabs.length]; openRail(tab); setRailIndex(railCurrent(tab)); } },
    { id: "railTabPrevious", group: "rail", keys: ["h", "ArrowLeft"], enabled: () => focus === "guide", run: () => { const tab = railTabs[(railTabs.indexOf(railTab) + railTabs.length - 1) % railTabs.length]; openRail(tab); setRailIndex(railCurrent(tab)); } },
    // With the panel focused: the inbox.
    { id: "inboxDown", group: "panel", keys: ["t", "j", "ArrowDown"], hidden: true, enabled: () => focus === "panel", run: (times) => setInboxIndex(Math.min(inbox.length - 1, inboxIndex + (times ?? 1))) },
    { id: "inboxUp", group: "panel", keys: ["n", "k", "ArrowUp"], hidden: true, enabled: () => focus === "panel", run: (times) => setInboxIndex(Math.max(0, inboxIndex - (times ?? 1))) },
    { id: "inboxOpen", group: "panel", keys: ["Enter"], enabled: () => focus === "panel" && inbox.length > 0, run: () => openInboxItem(inbox[inboxIndex].id, true) },
  ];
  useCommands(commands);

  const rangeLabel = (value: Pick<Comment, "side" | "start" | "end">) =>
    t(value.side === "deletions" ? "oldLines" : "newLines", {
      start: value.start,
      end: value.end,
    });
  const status = agentStatus(progress && { ...progress, map: mapJob, error: progress.error ?? (threadsError || null) }, unread.length, now, !mapJob || mapJob.state !== "ready" || mapSeen === mapJob.requestedAt);
  const t3Error = progress?.error ?? (threadsError || null);
  const working = inbox.find((comment) => stateOf(comment) === "working");
  const lastReply = agentReplies.map(({ reply }) => reply.createdAt).sort().at(-1);
  const ago = (iso: string) => format.relativeTime(new Date(iso), now);
  const panelState: ReactNode = t3Error ? <span className="text-warn">{t("panel.unreachable", { error: t3Error })}</span>
    : mapPending ? t("panel.writingMap", { time: elapsed(mapJob!.requestedAt, now) })
    : working ? t("panel.answering", { question: threadTitle(working), time: elapsed(awaitingReply(working)!, now) })
    : Object.values(progress?.replies ?? {}).includes("requested") ? t("panel.sent")
    : [t(thread ? "panel.idle" : "panel.noThread"), lastReply && t("panel.lastAnswered", { time: ago(lastReply) }), progress?.mapChanged && t("panel.mapAt", { time: ago(progress.mapChanged) })].filter(Boolean).join(" · ");
  const mapCard = (railTab === "map" || railTab === "files") && (() => {
    if (mapError) return (
      <div className="rail-card" role="alert"><h4><Dot tone="warn" />{t("mapCard.invalid")}</h4><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{mapError}</pre></div>
    );
    const outdatedCard = reviewMap && mapOutdated && (
      <div className="rail-card" role="alert"><h4><Dot tone="warn" />{mapOutdated.revision ? t("mapCard.outdatedFor", { hash: mapOutdated.revision.slice(0, 7) }) : t("mapCard.outdated")}</h4>
        <p>{t("mapCard.outdatedWhy")}</p><p className="mt-1 flex items-center gap-1.5"><Keys value="g M" />{t("mapCard.update")}</p></div>
    );
    if (mapJob && mapPending) {
      const steps = [
        { done: true, text: t("mapCard.sent", { files: mapFiles.length }) },
        { done: mapJob.state === "working", text: t("mapCard.picked") },
        { now: mapJob.state === "working", text: t("mapCard.working", { time: elapsed(mapJob.requestedAt, now) }) },
        { text: t("mapCard.written") },
      ];
      return (
        <div className="rail-card" role="status">
          <h4><Dot tone="warn" className="pulse" />{t("mapCard.writing")}</h4>
          <p>{t.rich("mapCard.asked", { title: mapJob.title, time: elapsed(mapJob.requestedAt, now), b: (chunks) => <b className="text-foreground">{chunks}</b> })}</p>
          <ul className="steps">{steps.map((step, position) => <li key={position} data-done={step.done} data-now={step.now}>{step.done ? "✓" : step.now ? <Dot tone="warn" className="pulse" /> : "○"} {step.text}</li>)}</ul>
        </div>
      );
    }
    if (outdatedCard) return outdatedCard;
    if (mapJob?.state === "finished" && mapSeen !== mapJob.requestedAt) return (
      <div className="rail-card"><h4><Dot tone="warn" />{t("mapCard.finished", { title: mapJob.title })}</h4><p className="flex items-center gap-1.5"><Keys value="g M" />{t("mapCard.again")}<button className="ml-auto underline" onClick={dismissMapJob}>{t("dismiss")}</button></p></div>
    );
    if (!reviewMap && mapLoaded && mapReview) return (
      <div className="rail-card"><h4>{t("mapCard.none")}</h4><p className="flex flex-wrap items-center gap-1.5"><Keys value="g M" />{thread ? t(inChanges ? "mapCard.askChanges" : "mapCard.ask", { title: thread.title }) : threadsError || t("noAgentThread")}</p></div>
    );
    if (mapJob?.state === "ready" && mapSeen !== mapJob.requestedAt) return (
      <div className="rail-card"><h4><Dot tone="ok" />{t("mapCard.ready")}</h4><p className="flex items-center gap-1.5"><Keys value="M" />{t("mapCard.start")}</p></div>
    );
    return null;
  })();
  const pullNumber = /\/pull\/(\d+)/.exec(review.source.url)?.[1];
  const branch = review.source.kind === "local" ? review.source.branch : review.title;
  const base = review.source.kind === "local" ? review.source.baseBranch : "";
  const shownCommit = scope.kind === "commit" ? commitRows?.[commitIndex] : undefined;
  const focusedRail = focus === "guide";

  return (
    <>
      <header className="topbar gap-3.5 px-2.5">
        <div className="flex min-w-0 shrink items-center gap-2 overflow-hidden">
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">{t("home")}<Keys value="g h" /></span>
          <span className="text-muted-foreground">/</span>
          <b className="truncate font-semibold" title={review.title}>{branch}</b>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            {base && `→ ${base}`}{pullNumber && ` · PR #${pullNumber}`} · {review.revision.slice(0, 7)}
            {stack && <button className="flex items-center gap-1" onClick={onStack}> · {t("stackPosition", { position: stack.position, total: stack.total })}<Keys value="p" /></button>}
          </span>
        </div>
        <div className="scope-switch" role="group" aria-label={t("scope")}>
          <button aria-pressed={scope.kind === "branch" && !wholeFile} onClick={() => setScope({ kind: "branch" })}>{t("scopeBranch")}<Keys value="g B" /></button>
          <button aria-pressed={shownChapter !== null} disabled={!chapters.length} onClick={() => chapters.length && openChapter(shownChapter ?? firstUnread() ?? 0)}>
            {t("scopeChapter", { position: shownChapter === null ? "—" : `${shownChapter + 1}/${chapters.length}` })}<Keys value="<" /><Keys value=">" />
          </button>
          <button aria-pressed={scope.kind === "commit"} disabled={review.source.kind !== "local"} onClick={() => openRail("commits", true)}>
            {t("scopeCommit", { position: scope.kind === "commit" && commits ? `${commitIndex + 1}/${commits.length}` : "—" })}<Keys value="g <" /><Keys value="g >" />
          </button>
          <button aria-pressed={inChanges} disabled={review.source.kind !== "local"} onClick={openChanges}>
            {t("scopeChanges", { count: thread ? Math.max(0, thread.latestTurn - thread.reviewedTurn) : 0 })}<Keys value="g n" />
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="bar"><i style={{ width: `${(chapters.length ? chaptersRead / chapters.length : branchFilesRead / Math.max(1, branchFiles.length)) * 100}%` }} /></span>
          <span className="truncate">{chapters.length ? t("chaptersRead", { read: chaptersRead, total: chapters.length }) : t("filesRead", { read: branchFilesRead, total: branchFiles.length })} · {t("openQuestions", { count: openQuestions })}</span>
        </div>
        <span className="ml-auto" />
        {progress?.head && progress.head !== review.revision && (
          <button className="pill" data-tone="warn" role="status" onClick={onReload}><Dot tone="warn" />{t("branchMoved", { hash: progress.head.slice(0, 7) })}<Keys value="g r" /></button>
        )}
        {reviewMap && mapOutdated && (
          <button className="pill" data-tone="warn" title={t("mapCard.outdatedWhy")} onClick={() => openRail("map")}><Dot tone="warn" />{mapOutdated.revision ? t("mapCard.outdatedFor", { hash: mapOutdated.revision.slice(0, 7) }) : t("mapCard.outdated")}<Keys value="g M" /></button>
        )}
        <AgentPill status={status} fallback={t(thread ? "agent.idle" : "agent.noThread")} hint={status.parts[0]?.key === "newReplies" ? "i" : status.parts[0]?.key === "mapReady" || status.parts[0]?.key === "writingMap" ? "M" : "I"}
          onClick={() => { setPanelOpen(true); requestAnimationFrame(() => setFocus("panel")); }} />
        {buttons}
      </header>
      <div className="flex min-h-0 flex-1" aria-busy={saving}>
        {rail && (
          <GuideRail tab={railTab} onTab={(tab) => openRail(tab)} focused={focusedRail} mapDot={mapPending ? "warn" : mapJob?.state === "ready" && mapSeen !== mapJob.requestedAt ? "ok" : null}
            card={mapCard}
            header={railTab === "map" ? <>{chapters.length ? t("chaptersCount", { total: chapters.length, read: chaptersRead }) : ""}<span className="ml-auto flex items-center gap-1"><Keys value="<" /><Keys value=">" /><Keys value="Space" />{t("readAndNext")}</span></>
              : railTab === "files" ? <>{t("filesCount", { total: shownFiles.length, read: readFiles.size })}{filtered.size ? ` · ${t("filteredOut", { count: filtered.size })}` : ""}</>
              : railTab === "commits" ? <>{commits ? t("commitsCount", { count: commits.length }) : ""}<span className="ml-auto flex items-center gap-1"><Keys value="g <" /><Keys value="g >" /></span></>
              : <><Keys value="/" />{t("searchDiff")} <Keys value="*" />{t("searchRepo")}</>}>
            {railTab === "map" && (chapters.length
              ? <MapList chapters={chapters} current={shownChapter} selected={focusedRail ? railIndex : null} progress={chapterProgress} onPick={(index) => { openChapter(index); setFocus("reader"); }} />
              : <div className="flex-1" />)}
            {railTab === "files" && <FileList files={shownFiles} active={active} selected={focusedRail ? railIndex : null} read={readFiles} filtered={filtered} stats={statsByFile} comments={commentCounts} unread={unreadByFile} onPick={(name) => { pickFile(name); setFocus("reader"); }} />}
            {railTab === "commits" && <CommitList commits={commitRows} current={scope.kind === "commit" ? scope.sha : undefined} selected={focusedRail ? railIndex : null} error={commitsError} onPick={(sha) => { openCommit(sha); setFocus("reader"); }} />}
            {railTab === "search" && <SearchList rows={searchRows} diffQuery={searchQuery} repoWord={repoSearch.word} repoState={repoSearch.state} selected={focusedRail ? railIndex : null} onPick={openSearchRow} />}
          </GuideRail>
        )}
        <main className="reader" data-focused={focus === "reader"}>
          {wholeFile && (
            <div className="reader-banner">
              <b className="font-mono">{wholeFile.file}</b>
              <span className="text-muted-foreground">{t(wholeFile.contents === undefined ? "wholeFileChanged" : "wholeFileHead", { hash: shown.revision.slice(0, 7) })}</span>
              <span className="ml-auto flex items-center gap-1 text-muted-foreground"><Keys value="Escape" />{t("backToScope")}</span>
            </div>
          )}
          {!wholeFile && shownChapter !== null && !done && (() => {
            const chapter = chapters[shownChapter];
            const ids = chapterIds(shownChapter);
            return <Brief chapter={chapter} index={shownChapter} checked={chapter.check.map((item) => read.has(checkId(chapter, item)))}
              hunks={{ read: ids.filter((id) => read.has(id)).length, total: ids.length }} onCheck={tickCheck} />;
          })()}
          {!wholeFile && inChanges && shownChapter === null && !done && <ChangesBrief changes={changes?.threadId === thread?.id ? changes : null} error={changesError} thread={thread?.title ?? ""} now={now} />}
          {!wholeFile && scope.kind === "commit" && (
            <section className="brief">
              <div className="flex items-center gap-2.5 text-sm">
                <span className="shrink-0 text-muted-foreground">{t("commitPosition", { index: commitIndex + 1, total: commits?.length ?? 0 })}</span>
                <span className="font-mono text-xs text-muted-foreground">{scope.sha.slice(0, 7)}</span>
                <strong className="min-w-0 truncate">{shownCommit?.subject ?? (commitLoading ? t("loadingCommit") : "")}</strong>
                <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground"><Keys value="g <" /><Keys value="g >" />{t("commitSteps")} · <Keys value="g B" />{t("scopeBranch")}</span>
              </div>
              {shownCommit && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {shownCommit.chapters.length > 0 && t("touchesChapters")}
                  {shownCommit.chapters.map((index) => <button key={index} className="chip" onClick={() => openChapter(index)}>{index + 1}. {chapters[index]?.title}</button>)}
                  {shownCommit.uncovered > 0 && <span>· {t("uncoveredInCommit", { count: shownCommit.uncovered })}</span>}
                </div>
              )}
            </section>
          )}
          {done ? (
            <section className="done-summary" aria-label={t("doneTitle")}>
              <h2><Check className="size-4 text-added" />{t("doneTitle")}</h2>
              <ul>
                <li>{t("openQuestions", { count: openQuestions })}</li>
                <li>{t("unresolvedComments", { count: review.comments.filter((comment) => !comment.thread && !comment.github && !comment.resolved).length })}</li>
                <li>{t("githubDraftCount", { count: review.comments.filter((comment) => comment.destination === "github" && !comment.github).length })}</li>
              </ul>
              <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">{scopedChanges && <><Keys value="g d" />{t("changes.markReviewed")} · </>}<Keys value="g s" />{t("githubReview")} · <Keys value="g m" />{t("copy")} · <Keys value="I" />{t("inbox")}</p>
            </section>
          ) : (
          <CodeView<Annotation>
            ref={viewer}
            containerRef={scroll}
            className="relative min-h-0 flex-1 overflow-auto outline-none"
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
              const fileRead = readFiles.has(item.id);
              const stats = statsByFile.get(item.id);
              const slash = item.id.lastIndexOf("/") + 1;
              const inChapter = item.type === "diff" && shownChapter !== null && !wholeFile ? item.fileDiff.hunks.length : 0;
              return (
                <div className="file-heading" data-file-header={item.id} data-viewed={fileRead}>
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
                  {inChapter > 0 && <span className="text-xs text-muted-foreground">{t("hunksInChapter", { count: inChapter })}</span>}
                  {!wholeFile && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className={fileRead ? "text-added" : "text-muted-foreground"}
                      aria-pressed={fileRead}
                      disabled={saving}
                      onClick={() => void setRead(fileIds(item.id), !fileRead)}
                    >
                      {fileRead ? <Check /> : <Circle />}
                      {t("read")}
                    </Button>
                  )}
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
                {metadata.comments.map((comment) => {
                  const state = stateOf(comment);
                  const replies = comment.replies?.length ?? 0;
                  const since = awaitingReply(comment);
                  return (
                    <button key={comment.id} className="marker" data-near={nearbyReply === comment.id} data-open={openThread === comment.id} data-state={state}
                      onClick={() => setOpenThread(comment.id)}>
                      <Dot tone={run(comment) === "finished" ? "warn" : threadTone[state]} className={state === "working" ? "pulse" : ""} />
                      <span className="tag">{t(comment.github ? "tagGitHub" : comment.thread ? "tagAgent" : "tagComment")}</span>
                      <span className="min-w-0 flex-1 truncate text-left">{threadTitle(comment)}</span>
                      <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                        {state === "new" ? <b className="text-foreground">{t("newCount", { count: unreadOf(comment.id) })}</b>
                          : state === "working" && since ? t("markerWorking", { time: elapsed(since, now) })
                          : state === "waiting" ? t(run(comment) === "finished" ? "replyStatus.finished" : "replyStatus.requested")
                          : t("markerReplies", { count: replies, state: t(`inboxGroup.${state}`) })}
                        {nearbyReply === comment.id && <><Keys value="Enter" />{t("openThread")}</>}
                      </span>
                    </button>
                  );
                })}
                {metadata.notes.map((note, position) => (
                  <div key={position} className="map-note">
                    <span className="map-note-label">{t("noteLabel", { lines: lineRange(note) })}</span>
                    <Markdown text={note.why} />
                  </div>
                ))}
              </div>
            )}
          />
          )}
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
        {panel && (
          <AgentPanel focused={focus === "panel"} title={thread?.title ?? t("noAgentThreadShort")} tone={t3Error ? "warn" : status.tone} state={panelState}
            job={mapJob && mapPending ? { state: t(`mapJobState.${mapJob.state}`), tone: "warn", timer: elapsed(mapJob.requestedAt, now), files: mapFiles.length } : null}
            items={inboxItems} selected={inboxIndex} open={openThread ?? undefined} onOpen={(id) => openInboxItem(id, true)}>
            {draft ? (
              <section className="conversation">
                <div className="flex items-center gap-2 border-b px-3.5 py-2 text-xs">
                  <b>{t(draft.commentId ? "editingComment" : draft.ask ? "askingAgent" : "newComment")}</b>
                  <span className="chip">{basename(draft.file)} {lineRange(draft)}, {t(draft.side === "deletions" ? "old" : "new")}</span>
                </div>
                <div className="px-3.5 py-2">
                  <CommentEditor
                    key={`${draft.file}:${draft.side}:${draft.start}:${draft.end}:${draft.commentId ?? "new"}`}
                    initialBody={draftBody.current}
                    initialDestination={draft.destination}
                    ask={draft.ask ? thread?.title ?? "" : undefined}
                    published={Boolean(draft.expectedBody !== undefined)}
                    conflictBody={draft.expectedBody !== undefined && review.comments.find(c => c.id === draft.commentId)?.github?.body !== draft.expectedBody ? review.comments.find(c => c.id === draft.commentId)?.github?.body : undefined}
                    onResolveConflict={useRemote => {
                      const remote = review.comments.find(c => c.id === draft.commentId)?.github;
                      if (remote) updateDraft({ ...draft, body: useRemote ? remote.body : draftBody.current, expectedBody: remote.body });
                    }}
                    onDestinationChange={destination => updateDraft({ ...draft, body: draftBody.current, destination })}
                    label={rangeLabel(draft)}
                    saving={saving}
                    shouldFocus={() => {
                      const pending = focusDraft.current;
                      focusDraft.current = false;
                      return pending;
                    }}
                    onBodyChange={updateDraftBody}
                    onSave={save}
                    onDiscard={() => { updateDraft(); setFocus("reader"); }}
                    onLeave={() => {
                      (document.activeElement as HTMLElement | null)?.blur();
                      setFocus("reader");
                    }}
                  />
                </div>
              </section>
            ) : opened_ ? (
              <Conversation comment={opened_} state={stateOf(opened_)} location={`${opened_.file} ${lineRange(opened_)}`} earlier={!shownInline(opened_)}
                deleting={deleting === opened_.id} saving={saving}
                onDelete={() => deleteThread(opened_)} onKeep={() => setDeleting(undefined)}
                composer={<ReplyComposer key={opened_.id} comment={opened_} review={shown} change={changeShown} showHotkey requested={replyTarget === opened_.id}
                  onOpened={() => setReplyTarget(null)} onLeave={() => setFocus("reader")} />} />
            ) : null}
          </AgentPanel>
        )}
      </div>
      <StatusLine
        mode={wholeFile ? "file" : visual ? (visualKind.current === "line" ? "visualLine" : "visual") : "normal"}
        fallbackFile={active}
        fileIndex={index}
        fileCount={files.length}
        selection={selection ? rangeLabel({
          side: selection.side ?? "additions",
          start: Math.min(selection.start, selection.end),
          end: Math.max(selection.start, selection.end),
        }) : ""}
        search={searchQuery ? { query: searchQuery, index: matchIndex, total: searchMatches.length } : undefined}
        draft={draft?.file}
        saving={saving}
        path={path}
      />
      <ThreadPicker open={threadPicker} onOpenChange={setThreadPicker} threads={threads} current={thread?.id} error={threadsError} onPick={setThreadId} />
      <FilePicker
        open={picker}
        onOpenChange={setPicker}
        files={shownFiles}
        read={readFiles}
        comments={commentCounts}
        onPick={pickFile}
      />
      <FiltersDialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        filters={filters}
        files={shownFiles.map((file) => file.name)}
        onSave={async (next) => { setFilters(await api.saveFilters.mutate({ ...filterScope, filters: next })); }}
      />
    </>
  );
}
