import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseFiles } from "../shared/diff";
import type { Review } from "../shared/types";
import type { MyPullRequest } from "./github";
import { parsePullUrl } from "./github";
import { ReviewStore } from "./store";
import { localRepo } from "./repository";
import { branchWorktree, keepSnapshot, worktreeState } from "./branches";

const execute = promisify(execFile);
async function git(repo: string, args: string[]) {
  try {
    return (
      await execute("git", ["-C", repo, ...args], {
        maxBuffer: 60 * 1024 * 1024,
        timeout: 30_000,
      })
    ).stdout;
  } catch (error) {
    const failure = error as { stderr?: string };
    throw new Error(failure.stderr?.trim() || "Local Git command failed.");
  }
}

export async function withGeneratedFiles(review: Review): Promise<Review> {
  if (review.source.kind !== "local") return review;
  const paths = parseFiles(review.patch).map((file) => file.name);
  return { ...review, generatedFiles: await generatedFiles(review.source.worktree ?? review.source.repo, review.source.worktree ? undefined : review.revision, paths) };
}

/** Which of `paths` .gitattributes mark linguist-generated: as of `revision`, or as the checkout's files are without one. */
export async function generatedFiles(checkout: string, revision: string | undefined, paths: string[]) {
  if (!paths.length) return [];
  const run = execute("git", ["-C", checkout, "check-attr", "--stdin", "-z", ...(revision ? [`--source=${revision}`] : []), "linguist-generated"], { maxBuffer: 60 * 1024 * 1024, timeout: 30_000 });
  run.child.stdin!.end(paths.map((path) => `${path}\0`).join(""));
  const fields = (await run).stdout.split("\0");
  const generated: string[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3)
    if (fields[i + 2] === "true" || fields[i + 2] === "set")
      generated.push(fields[i]);
  return generated;
}

export async function loadLocalReview(
  pull: MyPullRequest,
  store: ReviewStore,
  repo = localRepo(),
): Promise<Review> {
  repo = resolve(repo);
  const source = parsePullUrl(pull.url);
  const remote = (await git(repo, ["config", "--get", "remote.origin.url"]))
    .trim()
    .replace(/\.git$/, "");
  if (
    !remote.endsWith(`github.com/${source.owner}/${source.repo}`) &&
    !remote.endsWith(`github.com:${source.owner}/${source.repo}`)
  )
    throw new Error(
      "This PR does not belong to the configured local repository.",
    );
  async function branch(name: string) {
    try {
      return (await git(repo, ["rev-parse", "--verify", `refs/heads/${name}^{commit}`])).trim();
    } catch { return undefined; }
  }
  const localHead = pull.isCrossRepository ? undefined : await branch(pull.headRefName);
  let head = localHead;
  // The base always comes from origin: a local base branch is often stale,
  // and diffing against an old `main` pulls everything merged since into
  // the review. Offline, a local base branch still works.
  const headRef = `refs/pr-review/${source.number}/head`;
  const baseRef = `refs/pr-review/${source.number}/base`;
  await git(repo, ["check-ref-format", `refs/heads/${pull.baseRefName}`]);
  let base: string | undefined;
  try {
    await git(repo, ["fetch", "--no-tags", "--no-write-fetch-head", "--atomic", "origin",
      ...(!head ? [`+refs/pull/${source.number}/head:${headRef}`] : []),
      `+refs/heads/${pull.baseRefName}:${baseRef}`,
    ]);
    base = (await git(repo, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
    head ??= (await git(repo, ["rev-parse", "--verify", `${headRef}^{commit}`])).trim();
  } catch (error) {
    base = await branch(pull.baseRefName);
    if (!head || !base) throw error;
  }
  const mergeBase = (await git(repo, ["merge-base", base, head])).trim();
  const worktree = localHead ? await branchWorktree(repo, pull.headRefName) : undefined;
  // A checked-out PR is diffed as its worktree is: commits plus uncommitted files (see worktreeState).
  const state = worktree ? await worktreeState(worktree) : undefined;
  if (state && state.head !== head)
    throw new Error(
      "The checked-out commit changed while loading. Refresh the local diff.",
    );
  const snapshot = state?.commit ?? head;
  const patch = await git(repo, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--full-index",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    mergeBase,
    snapshot,
    "--",
  ]);
  const id = createHash("sha256")
    .update(JSON.stringify([repo, pull.url, base, head, patch]))
    .digest("hex")
    .slice(0, 24);
  try {
    const cached = await store.read(id);
    return await withGeneratedFiles({
      ...cached,
      source: { kind: "local", url: pull.url, repo, branch: pull.headRefName, baseBranch: pull.baseRefName, worktree },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const review: Review = {
    id,
    source: {
      kind: "local",
      url: pull.url,
      repo,
      branch: pull.headRefName,
      baseBranch: pull.baseRefName,
      worktree,
    },
    title: `${source.owner}/${source.repo} #${pull.number}: ${pull.title}`,
    revision: head,
    baseRevision: mergeBase,
    patch,
    comments: [],
    updatedAt: new Date().toISOString(),
  };
  await keepSnapshot(repo, id, snapshot, mergeBase);
  return withGeneratedFiles(review);
}
