import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Review, ReviewSummary } from "../shared/types";
import { parseFiles } from "../shared/diff";
import { resolveMap, reviewMapSchema, type ReviewMap } from "../shared/map";
import { hunkIds } from "../shared/read";
import { awaitingReply } from "../shared/progress";
import { currentBranch } from "./repository";
import { latestTurn, providerSubagent, runState, type Shell, type ShellThread } from "./t3";
import type { ReviewStore } from "./store";
import { z } from "zod";

/**
 * map.json of the review's branch or PR (or of another `directory`, such as
 * a thread's changes), or null; an invalid file throws with its errors.
 */
export async function readMap(store: ReviewStore, review: Pick<Review, "source">, directory = store.prDirectory(review)): Promise<ReviewMap | null> {
  const file = join(directory, "map.json");
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try { return reviewMapSchema.parse(JSON.parse(text)); }
  catch (error) {
    throw new Error(`${file} is not a valid review map: ${error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : error}`);
  }
}

type Job = { threadId: string; title: string; requestedAt: string; revision?: string };

/**
 * Whether map.json was written for another diff than the review's: the diff
 * last sent to the agent (map-diff.patch) is not the review's patch. Then the
 * head it was asked for, when the request recorded it. A map written without
 * a request has no recorded diff and counts as current.
 */
export async function mapOutdated(store: ReviewStore, review: Review, directory = store.prDirectory(review)): Promise<{ revision: string | null } | null> {
  let diff: string;
  try { diff = await readFile(join(directory, "map-diff.patch"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (diff === review.patch) return null;
  let job: Job | null = null;
  try { job = JSON.parse(await readFile(join(directory, "map-request.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { revision: job?.revision ?? null };
}

/** The last map request in `directory` and when map.json last changed; the map is ready once it changed after the request. */
async function mapJob(directory: string) {
  let job: Job | null = null;
  try { job = JSON.parse(await readFile(join(directory, "map-request.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let changed = 0;
  try { changed = (await stat(join(directory, "map.json"))).mtimeMs; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { job, changed, ready: job !== null && changed > Date.parse(job.requestedAt) };
}

/**
 * What the agent threads are doing with what was sent to them: the last map
 * request (and the last one for a thread's changes in `changesDirectory`)
 * and the questions still owed a reply. T3 Code is only asked (`shell`)
 * while something is pending.
 */
export async function agentProgress(store: ReviewStore, review: Review, shell: () => Promise<Shell>, changesDirectory?: string) {
  const { job, changed: mapChanged, ready: mapReady } = await mapJob(store.prDirectory(review));
  const changes = changesDirectory ? await mapJob(changesDirectory) : null;
  const waiting = review.comments.flatMap((comment) => {
    const since = awaitingReply(comment);
    return since ? [{ id: comment.id, threadId: comment.thread!.id, since }] : [];
  });
  let threads = new Map<string, ShellThread>();
  let error: string | null = null;
  if ((job && !mapReady) || (changes?.job && !changes.ready) || waiting.length) {
    try { threads = new Map((await shell()).threads.map((thread) => [thread.id, thread])); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }
  // Without T3 Code's answer, everything pending stays "requested" next to the error.
  const state = (threadId: string, since: string) => error ? "requested" as const : runState(threads.get(threadId), since);
  return {
    error,
    mapChanged: mapChanged ? new Date(mapChanged).toISOString() : null,
    map: job && { title: job.title, requestedAt: job.requestedAt, state: mapReady ? "ready" as const : state(job.threadId, job.requestedAt) },
    changesMap: changes?.job ? { title: changes.job.title, requestedAt: changes.job.requestedAt, state: changes.ready ? "ready" as const : state(changes.job.threadId, changes.job.requestedAt) } : null,
    replies: Object.fromEntries(waiting.map((item) => [item.id, state(item.threadId, item.since)])),
  };
}

const commitScope = (summary: Pick<ReviewSummary, "source">) =>
  summary.source.kind === "local" && (Boolean(summary.source.commit) && !summary.source.branchComparison || Boolean(summary.source.changes));

/** The latest whole-branch or PR snapshot of each conversation folder (not a commit's or a thread's changes). */
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
  const rows: Array<{ checkout: string; branch: string; threadId: string; title: string; working: boolean; latestTurn: number; updatedAt: string }> = [];
  const threads = shell.threads
    .filter((thread) => !thread.archivedAt && !thread.deletedAt && !providerSubagent(thread) && projects.has(thread.projectId))
    .map((thread) => ({ thread, at: [thread.latestUserMessageAt, thread.latestRunStartedAt, thread.latestRunCompletedAt, thread.updatedAt].filter(Boolean).sort().at(-1)! }))
    .sort((a, b) => b.at.localeCompare(a.at));
  for (const { thread, at } of threads) {
    const checkout = thread.worktreePath ?? projects.get(thread.projectId)!;
    if (seen.has(checkout) || rows.length >= limit) continue;
    seen.add(checkout);
    const branch = currentBranch(checkout);
    if (branch) rows.push({ checkout, branch, threadId: thread.id, title: thread.title, working: Boolean(thread.activeRunId), latestTurn: latestTurn(thread), updatedAt: at });
  }
  return rows;
}
