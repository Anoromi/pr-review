import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Review } from "../shared/types";
import { parseFiles } from "../shared/diff";
import { writeContext } from "./context";
import { withGeneratedFiles } from "./local";
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
  await git(repo, "rev-parse", "--verify", `${ref}^{commit}`);
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

/** Where the review's branch points now, or null where no local branch has its name (a PR fetched from GitHub). */
export async function branchHead(review: Review) {
  if (review.source.kind !== "local") return null;
  try { return (await git(review.source.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${review.source.branch}^{commit}`)).trim(); }
  catch { return null; }
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
  const ref = await branchRef(repo, branch);
  const commit = (await git(repo, "rev-parse", "--verify", `${ref}^{commit}`)).trim();
  const main = await mainRef(repo);
  const baseBranch = main === "refs/remotes/origin/main" ? "origin/main" : "main";
  const base = (await git(repo, "merge-base", main, commit)).trim();
  return loadBranchSnapshot(repo, branch, commit, base, baseBranch, store);
}

// A branch review links to the branch on GitHub when the checkout has a
// GitHub remote; otherwise to the local checkout.
function branchUrl(repo: string, branch: string) {
  const github = githubRepoOrNull(repo);
  return github ? `https://github.com/${github.slug}/tree/${encodeURIComponent(branch)}` : `file://${repo}#${encodeURIComponent(branch)}`;
}

async function loadBranchSnapshot(repo: string, branch: string, commit: string, base: string, baseBranch: string, store: ReviewStore): Promise<Review> {
  const id = createHash("sha256").update(JSON.stringify([repo, branch, commit, base, ...(baseBranch ? [baseBranch] : [])])).digest("hex").slice(0, 24);
  const title = baseBranch ? `${branch} vs ${baseBranch}` : `${branch}: ${(await git(repo, "show", "-s", "--format=%s", commit)).trim()}`;
  const source = { kind: "local" as const, url: branchUrl(repo, branch), repo, branch, baseBranch, commit, branchReview: true, branchComparison: Boolean(baseBranch) };
  return loadSnapshot(repo, id, title, source, commit, base, store);
}

async function loadSnapshot(repo: string, id: string, title: string, source: Review["source"], commit: string, base: string, store: ReviewStore): Promise<Review> {
  const patch = await git(repo, ...diffArgs, base, commit, "--");
  const review: Review = { id, title, source, revision: commit, baseRevision: base, patch, comments: [], updatedAt: new Date().toISOString() };
  for (const file of parseFiles(patch)) {
    if (!file.hunks.length || !["change", "rename-changed", "rename-pure"].includes(file.type)) continue;
    const oldName = file.prevName ?? file.name;
    await writeContext(store.path(id), file.name, {
      oldFile: file.type === "rename-pure" ? null : { name: oldName, contents: await git(repo, "show", `${base}:${oldName}`) },
      newFile: { name: file.name, contents: await git(repo, "show", `${commit}:${file.name}`) },
    });
  }
  return withGeneratedFiles(review);
}
