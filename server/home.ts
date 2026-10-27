import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Review, ReviewSummary } from "../shared/types";
import { parseFiles } from "../shared/diff";
import { resolveMap, reviewMapSchema, type ReviewMap } from "../shared/map";
import { hunkIds } from "../shared/read";
import { awaitingReply } from "../shared/progress";
import { currentBranch } from "./repository";
import { runState, type Shell, type ShellThread } from "./t3";
import type { ReviewStore } from "./store";
import { z } from "zod";

/** map.json of the review's branch or PR, or null; an invalid file throws with its errors. */
export async function readMap(store: ReviewStore, review: Pick<Review, "source">): Promise<ReviewMap | null> {
  const file = join(store.prDirectory(review), "map.json");
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try { return reviewMapSchema.parse(JSON.parse(text)); }
  catch (error) {
    throw new Error(`${file} is not a valid review map: ${error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : error}`);
  }
}

type Job = { threadId: string; title: string; requestedAt: string };

/**
 * What the agent threads are doing with what was sent to them: the last map
 * request (ready once map.json changed after it) and the questions still
 * owed a reply. T3 Code is only asked (`shell`) while something is pending.
 */
export async function agentProgress(store: ReviewStore, review: Review, shell: () => Promise<Shell>) {
  const directory = store.prDirectory(review);
  let job: Job | null = null;
  try { job = JSON.parse(await readFile(join(directory, "map-request.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let mapChanged = 0;
  try { mapChanged = (await stat(join(directory, "map.json"))).mtimeMs; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const mapReady = job !== null && mapChanged > Date.parse(job.requestedAt);
  const waiting = review.comments.flatMap((comment) => {
    const since = awaitingReply(comment);
    return since ? [{ id: comment.id, threadId: comment.thread!.id, since }] : [];
  });
  let threads = new Map<string, ShellThread>();
  let error: string | null = null;
  if ((job && !mapReady) || waiting.length) {
    try { threads = new Map((await shell()).threads.map((thread) => [thread.id, thread])); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }
  // Without T3 Code's answer, everything pending stays "requested" next to the error.
  const state = (threadId: string, since: string) => error ? "requested" as const : runState(threads.get(threadId), since);
  return {
    error,
    mapChanged: mapChanged ? new Date(mapChanged).toISOString() : null,
    map: job && { title: job.title, requestedAt: job.requestedAt, state: mapReady ? "ready" as const : state(job.threadId, job.requestedAt) },
    replies: Object.fromEntries(waiting.map((item) => [item.id, state(item.threadId, item.since)])),
  };
}

const commitScope = (summary: Pick<ReviewSummary, "source">) =>
  summary.source.kind === "local" && Boolean(summary.source.commit) && !summary.source.branchComparison;

/** The latest whole-branch or PR snapshot of each conversation folder. */
export async function latestSnapshots(store: ReviewStore) {
  const latest = new Map<string, ReviewSummary>();
  for (const summary of await store.list())
    if (!commitScope(summary)) {
      const directory = store.prDirectory(summary);
      if (!latest.has(directory)) latest.set(directory, summary);
    }
  return latest;
}

/**
 * Reading progress of a snapshot: chapters read when there is a valid map,
 * else files; plus open questions and the agent replies (for new-reply dots).
 */
export async function readingProgress(store: ReviewStore, review: Review) {
  const files = parseFiles(review.patch);
  const ids = hunkIds(files);
  const read = new Set(await store.readRead(review));
  const done = (keys: string[]) => keys.length > 0 && keys.every((key) => read.has(ids.get(key)!));
  let map: ReviewMap | null = null;
  try { map = await readMap(store, review); } catch { /* An invalid map shows its errors in the review itself. */ }
  const chapters = map ? resolveMap(map, files) : null;
  const fileKeys = files.map((file) => [...ids.keys()].filter((key) => key.slice(0, key.lastIndexOf("#")) === file.name));
  const local = review.comments.filter((comment) => !comment.github);
  return {
    id: review.id,
    url: review.source.url,
    chapters: chapters && { read: chapters.filter((chapter) => done(chapter.hunks)).length, total: chapters.length },
    files: { read: fileKeys.filter(done).length, total: files.length },
    open: review.comments.filter((comment) => comment.thread && !comment.resolved).length,
    replies: local.flatMap((comment) => (comment.replies ?? []).filter((reply) => reply.author !== "You").map((reply) => reply.id)),
    updatedAt: review.updatedAt,
  };
}

/**
 * Checkouts of `repo`'s repository that a T3 Code thread works in, with the
 * branch checked out there, most recently active thread first.
 */
export function agentCheckouts(shell: Shell, repo: string, limit = 12) {
  const commonDir = (path: string) => {
    try { return resolve(path, execFileSync("git", ["-C", path, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 5000 }).trim()); }
    catch { return null; }
  };
  const wanted = commonDir(repo);
  const projects = new Map(shell.projects.filter((project) => commonDir(project.workspaceRoot) === wanted).map((project) => [project.id, project.workspaceRoot]));
  const seen = new Set<string>();
  const rows: Array<{ checkout: string; branch: string; title: string; working: boolean; updatedAt: string }> = [];
  const threads = shell.threads
    .filter((thread) => !thread.archivedAt && !thread.deletedAt && projects.has(thread.projectId))
    .map((thread) => ({ thread, at: [thread.latestUserMessageAt, thread.latestRunStartedAt, thread.latestRunCompletedAt, thread.updatedAt].filter(Boolean).sort().at(-1)! }))
    .sort((a, b) => b.at.localeCompare(a.at));
  for (const { thread, at } of threads) {
    const checkout = thread.worktreePath ?? projects.get(thread.projectId)!;
    if (seen.has(checkout) || rows.length >= limit) continue;
    seen.add(checkout);
    const branch = currentBranch(checkout);
    if (branch) rows.push({ checkout, branch, title: thread.title, working: Boolean(thread.activeRunId), updatedAt: at });
  }
  return rows;
}
