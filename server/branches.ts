import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Review } from "../shared/types";
import { generatedFiles } from "./local";
import { parseFiles } from "../shared/diff";
import { ReviewStore } from "./store";
import { githubRepoOrNull, localRepo } from "./repository";

const execute = promisify(execFile);
export const branchRepo = localRepo;
async function git(repo: string, ...args: string[]) {
  return (await execute("git", ["-C", repo, ...args], { maxBuffer: 60 * 1024 * 1024, timeout: 30000 })).stdout;
}
async function branchRef(repo: string, branch: string) {
  const ref = `refs/heads/${branch}`;
  await git(repo, "check-ref-format", ref);
  // Not peeled to ^{commit}: that reads the object, slow in a repository with many packs.
  await git(repo, "rev-parse", "--verify", ref);
  return ref;
}
export async function listBranches(repo = branchRepo()) {
  return (await git(repo, "for-each-ref", "--sort=-committerdate", "--format=%(refname:strip=2)", "refs/heads/")).trim().split("\n").filter(Boolean);
}
/** Local branches, most recent first, with how many commits each has that main has not. */
export async function branchRows(repo = branchRepo(), limit = 15) {
  const main = await mainRef(repo);
  const rows = (await git(repo, "for-each-ref", "--sort=-committerdate", `--count=${limit}`, "--format=%(refname:strip=2)%09%(committerdate:iso-strict)", "refs/heads/")).trim().split("\n").filter(Boolean);
  return Promise.all(rows.map(async (row) => {
    const [name, date] = row.split("\t");
    const ahead = Number((await git(repo, "rev-list", "--count", `${main}..refs/heads/${name}`)).trim());
    return { name, date, ahead };
  }));
}
async function mainRef(repo: string) {
  const remoteMain = (await git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/main")).trim();
  return remoteMain || await branchRef(repo, "main");
}

/** What the review's branch is based on, as it is now: main for a branch, the base branch for a PR. */
export async function upstreamRef(review: Review) {
  if (review.source.kind !== "local") throw new Error("Only reviews of a local checkout have an upstream.");
  if (review.source.branchReview) return mainRef(review.source.repo);
  const number = /\/pull\/(\d+)/.exec(review.source.url)?.[1];
  for (const ref of [`refs/pr-review/${number}/base`, `refs/heads/${review.source.baseBranch}`])
    if (await git(review.source.repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`).then(() => true, () => false)) return ref;
  throw new Error(`The PR's base branch ${review.source.baseBranch} is not in the local repository.`);
}

/**
 * The review's own commits, oldest first: first-parent history from its base
 * to its head, without merges (a merge's diff would bring in the base's changes).
 */
export async function ownCommits(review: Review) {
  if (review.source.kind !== "local") throw new Error("Only reviews of a local checkout have commits.");
  const rows = (await git(review.source.repo, "log", "--first-parent", "--no-merges", "--reverse", "--max-count=200", "--format=%H%x09%cs%x09%an%x09%s", `${review.baseRevision}..${review.revision}`, "--")).trim().split("\n").filter(Boolean);
  return rows.map((row) => {
    const [sha, date, author, ...subject] = row.split("\t");
    return { sha, date, author, subject: subject.join("\t") };
  });
}

/**
 * Where the review's branch points now, or null where no local branch has its
 * name (a PR fetched from GitHub). For a branch review whose branch is checked
 * out, the commit of its worktree as it is now (see worktreeState).
 */
export async function branchHead(review: Review) {
  if (review.source.kind !== "local") return null;
  const [head, worktree] = await Promise.all([
    git(review.source.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${review.source.branch}`).then((head) => head.trim(), () => null),
    review.source.branchReview && branchWorktree(review.source.repo, review.source.branch),
  ]);
  if (!head) return null;
  return worktree ? (await worktreeState(worktree)).commit : head;
}

/** The worktree `branch` is checked out in, or undefined. */
export async function branchWorktree(repo: string, branch: string) {
  return (await git(repo, "worktree", "list", "--porcelain", "-z")).split("\0\0")
    .map((block) => block.split("\0"))
    .find((fields) => fields.includes(`branch refs/heads/${branch}`))
    ?.find((field) => field.startsWith("worktree "))?.slice(9);
}

/**
 * What git status sees in `worktree` (HEAD, index entries, changed and
 * untracked paths) plus the size and times of each listed path, so an edit
 * to an already modified file changes it too. Reading it touches nothing.
 */
async function worktreeFingerprint(worktree: string) {
  const status = await git(worktree, "--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--no-renames");
  const stats = await Promise.all(status.split("\0").filter((record) => /^[1u?] /.test(record)).map(async (record) => {
    const path = record[0] === "?" ? record.slice(2) : record.split(" ").slice(record[0] === "1" ? 8 : 10).join(" ");
    const stat = await lstat(join(worktree, path)).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    return stat && [stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode];
  }));
  return JSON.stringify([status, stats]);
}

const worktreeStates = new Map<string, { fingerprint: string; state: Awaited<ReturnType<typeof snapshotWorktree>> }>();
/** The worktree as a commit (see snapshotWorktree), taken again only when its fingerprint changed. */
export async function worktreeState(worktree: string) {
  const fingerprint = await worktreeFingerprint(worktree);
  const known = worktreeStates.get(worktree);
  if (known?.fingerprint === fingerprint) return known.state;
  const state = await snapshotWorktree(worktree);
  worktreeStates.set(worktree, { fingerprint, state });
  return state;
}

/**
 * What is in `worktree` now, as a commit: HEAD plus every staged, unstaged
 * and untracked (not ignored) file, with HEAD as its parent. It is written
 * through a copy of the index, so the worktree's own index and refs are never
 * touched, and with HEAD's dates, so the same state always gets the same id.
 * `files` counts the files it changes against HEAD; with none, `commit` is HEAD.
 */
async function snapshotWorktree(worktree: string) {
  const temporary = await mkdtemp(join(tmpdir(), "pr-review-index-"));
  const env = {
    ...process.env, GIT_INDEX_FILE: join(temporary, "index"),
    GIT_AUTHOR_NAME: "pr-review", GIT_AUTHOR_EMAIL: "pr-review@localhost",
    GIT_COMMITTER_NAME: "pr-review", GIT_COMMITTER_EMAIL: "pr-review@localhost",
  };
  const run = async (...args: string[]) => (await execute("git", ["-C", worktree, ...args], { env, maxBuffer: 60 * 1024 * 1024, timeout: 30000 })).stdout.trim();
  try {
    const [unmerged, [head, headTree, date], tree] = await Promise.all([
      git(worktree, "ls-files", "--unmerged"),
      git(worktree, "log", "-1", "--format=%H%n%T%n%cI", "HEAD").then((log) => log.trim().split("\n")),
      (async () => {
        // Without an index (nothing ever staged), `add -A` builds one from the files.
        const index = (await git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index")).trim();
        await copyFile(index, env.GIT_INDEX_FILE).catch((error) => { if (error.code !== "ENOENT") throw error; });
        await run("add", "-A");
        return run("write-tree");
      })(),
    ]);
    if (unmerged.trim()) throw new Error(`Resolve merge conflicts in ${worktree} before reviewing.`);
    if (tree === headTree) return { commit: head, head, files: 0 };
    Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    const [files, commit] = await Promise.all([
      run("diff-tree", "-r", "-z", "--name-only", "--no-renames", headTree, tree).then((names) => names.split("\0").filter(Boolean).length),
      run("commit-tree", tree, "-p", head, "-m", "Uncommitted changes"),
    ]);
    return { commit, head, files };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
async function firstParent(repo: string, commit: string) {
  return (await git(repo, "rev-list", "--parents", "-n", "1", commit)).trim().split(" ")[1] ?? emptyTree;
}
const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--full-index", "--src-prefix=a/", "--dst-prefix=b/"];
/** What `commit` changed against its first parent. */
export async function commitPatch(repo: string, commit: string) {
  return git(repo, ...diffArgs, await firstParent(repo, commit), commit, "--");
}

/**
 * A commit of `parent` (a branch or PR review) as its own snapshot, sharing
 * the parent's conversation folder: comments, read state and the map carry
 * over. Branch commits keep the snapshots (and ids) they always had.
 */
export async function loadCommit(parent: Review, commit: string, store: ReviewStore): Promise<Review> {
  if (parent.source.kind !== "local") throw new Error("Only reviews of a local checkout have commits.");
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Select a commit of this review.");
  const { repo } = parent.source;
  // The review's head, not the branch: the branch may have moved or been rewritten since.
  await git(repo, "merge-base", "--is-ancestor", commit, parent.revision);
  if (parent.source.branchReview) return loadBranchCommit(parent.source.branch, commit, store, repo, parent.revision);
  const base = await firstParent(repo, commit);
  const source = { ...parent.source, commit };
  const id = createHash("sha256").update(JSON.stringify([repo, parent.source.url, commit, base])).digest("hex").slice(0, 24);
  const title = `${parent.title}: ${(await git(repo, "show", "-s", "--format=%s", commit)).trim()}`;
  return loadSnapshot(repo, id, title, source, commit, base, store);
}

/** A commit of `branch` (an ancestor of `head`, by default the branch itself) as its own snapshot. */
export async function loadBranchCommit(branch: string, commit: string, store: ReviewStore, repo = branchRepo(), head?: string): Promise<Review> {
  repo = resolve(repo);
  const ref = await branchRef(repo, branch);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Select a commit from this branch.");
  await git(repo, "merge-base", "--is-ancestor", commit, head ?? ref);
  return loadBranchSnapshot(repo, branch, commit, await firstParent(repo, commit), "", store);
}

export async function loadBranchReview(branch: string, store: ReviewStore, repo = branchRepo()): Promise<Review> {
  repo = resolve(repo);
  const [ref, worktree, main] = await Promise.all([branchRef(repo, branch), branchWorktree(repo, branch), mainRef(repo)]);
  const head = (await git(repo, "rev-parse", "--verify", ref)).trim();
  // A checked-out branch is reviewed as its worktree is: commits plus uncommitted
  // files, a commit on top of HEAD with the same merge base with main.
  const [state, headBase] = await Promise.all([worktree ? worktreeState(worktree) : undefined, git(repo, "merge-base", main, head)]);
  const commit = state?.commit ?? head;
  const baseBranch = main === "refs/remotes/origin/main" ? "origin/main" : "main";
  const base = !state || state.head === head ? headBase.trim() : (await git(repo, "merge-base", main, commit)).trim();
  return loadBranchSnapshot(repo, branch, commit, base, baseBranch, store, state?.files ? { head: state.head, files: state.files } : undefined);
}

// A branch review links to the branch on GitHub when the checkout has a
// GitHub remote; otherwise to the local checkout.
function branchUrl(repo: string, branch: string) {
  const github = githubRepoOrNull(repo);
  return github ? `https://github.com/${github.slug}/tree/${encodeURIComponent(branch)}` : `file://${repo}#${encodeURIComponent(branch)}`;
}

async function loadBranchSnapshot(repo: string, branch: string, commit: string, base: string, baseBranch: string, store: ReviewStore, uncommitted?: { head: string; files: number }): Promise<Review> {
  const id = createHash("sha256").update(JSON.stringify([repo, branch, commit, base, ...(baseBranch ? [baseBranch] : [])])).digest("hex").slice(0, 24);
  const title = baseBranch ? `${branch} vs ${baseBranch}` : `${branch}: ${(await git(repo, "show", "-s", "--format=%s", commit)).trim()}`;
  const source = { kind: "local" as const, url: branchUrl(repo, branch), repo, branch, baseBranch, commit, branchReview: true, branchComparison: Boolean(baseBranch), ...(uncommitted && { uncommitted }) };
  return loadSnapshot(repo, id, title, source, commit, base, store);
}

/**
 * A snapshot of `base` (a commit or tree) to `commit`: the saved one when
 * `id` exists, otherwise diffed now (`patch` when already diffed). The
 * context to expand its hunks is read from Git when asked for (see readContext).
 */
export async function loadSnapshot(repo: string, id: string, title: string, source: Review["source"], commit: string, base: string, store: ReviewStore, patch?: string): Promise<Review> {
  try { return await store.read(id); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // The changed paths' attributes are read while the full diff runs.
  const paths = patch ? Promise.resolve(parseFiles(patch).map((file) => file.name)) : git(repo, ...diffArgs, "--name-only", "-z", base, commit, "--").then((names) => names.split("\0").filter(Boolean));
  const [diff, generated] = await Promise.all([patch ?? git(repo, ...diffArgs, base, commit, "--"), paths.then((paths) => generatedFiles(repo, commit, paths)), keepSnapshot(repo, id, commit, base)]);
  return { id, title, source, revision: commit, baseRevision: base, patch: diff, generatedFiles: generated, comments: [], updatedAt: new Date().toISOString() };
}

/**
 * Refs to both sides of snapshot `id` under refs/pr-review/snapshots/, so
 * `git gc` keeps the objects its context is read from (an uncommitted
 * worktree snapshot or a rewritten branch is otherwise unreachable).
 */
export async function keepSnapshot(repo: string, id: string, revision: string, base: string) {
  const run = execute("git", ["-C", repo, "update-ref", "--stdin"], { timeout: 30000 });
  run.child.stdin!.end(`update refs/pr-review/snapshots/${id}/revision ${revision}\nupdate refs/pr-review/snapshots/${id}/base ${base}\n`);
  await run;
}

/** The contents of each object (`revision:path` or an object id) in `objects`, read through one `git cat-file --batch`. */
export async function readObjects(repo: string, objects: string[]) {
  if (!objects.length) return [];
  const run = execute("git", ["-C", repo, "cat-file", "--batch", "-z"], { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, timeout: 30000 });
  run.child.stdin!.end(objects.map((object) => `${object}\0`).join(""));
  return parseObjects((await run).stdout, objects);
}

/** Splits `git cat-file --batch` output by the size in each header; a missing object fails. */
export function parseObjects(output: Buffer, objects: string[]) {
  let offset = 0;
  return objects.map((object) => {
    const end = output.indexOf(10, offset);
    const header = output.toString("utf8", offset, end < 0 ? output.length : end);
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1];
    if (end < 0 || !size) throw new Error(`Git could not read ${object}: ${header || "no output"}`);
    offset = end + 1 + Number(size) + 1;
    if (offset > output.length) throw new Error(`Git output for ${object} is cut short.`);
    return output.toString("utf8", end + 1, end + 1 + Number(size));
  });
}
