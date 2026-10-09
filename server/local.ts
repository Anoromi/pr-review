import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { parseFiles } from "../shared/diff";
import type { Review } from "../shared/types";
import type { MyPullRequest } from "./github";
import { parsePullUrl } from "./github";
import { ReviewStore } from "./store";
import { writeContext } from "./context";
import { localRepo } from "./repository";

const execute = promisify(execFile);
async function git(repo: string, args: string[], diffExit = false) {
  try {
    return (
      await execute("git", ["-C", repo, ...args], {
        maxBuffer: 60 * 1024 * 1024,
        timeout: 30_000,
      })
    ).stdout;
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    if (diffExit && failure.code === 1) return failure.stdout ?? "";
    throw new Error(failure.stderr?.trim() || "Local Git command failed.");
  }
}

export async function withGeneratedFiles(review: Review): Promise<Review> {
  if (review.source.kind !== "local") return review;
  const paths = parseFiles(review.patch).map((file) => file.name);
  const generatedFiles: string[] = [];
  for (let offset = 0; offset < paths.length; offset += 100) {
    const output = await git(review.source.worktree ?? review.source.repo, [
      "check-attr", "-z",
      ...(review.source.worktree ? [] : [`--source=${review.revision}`]),
      "linguist-generated", "--", ...paths.slice(offset, offset + 100),
    ]);
    const fields = output.split("\0");
    for (let i = 0; i + 2 < fields.length; i += 3)
      if (fields[i + 2] === "true" || fields[i + 2] === "set")
        generatedFiles.push(fields[i]);
  }
  return { ...review, generatedFiles };
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
  const worktrees = (
    await git(repo, ["worktree", "list", "--porcelain", "-z"])
  ).split("\0\0");
  const worktree = localHead ? worktrees
    .map((block) => block.split("\0"))
    .find((fields) => fields.includes(`branch refs/heads/${pull.headRefName}`))
    ?.find((field) => field.startsWith("worktree "))
    ?.slice(9) : undefined;
  if (worktree && (await git(worktree, ["ls-files", "--unmerged"])).trim())
    throw new Error(
      "Resolve merge conflicts in this worktree before reviewing.",
    );
  const diffArgs = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--full-index",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    mergeBase,
  ];
  let patch = await git(worktree ?? repo, [
    ...diffArgs,
    ...(worktree ? [] : [head]),
    "--",
  ]);
  if (worktree) {
    const untracked = (
      await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
    )
      .split("\0")
      .filter(Boolean);
    for (const file of untracked)
      patch += await git(
        worktree,
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--full-index",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--",
          "/dev/null",
          file,
        ],
        true,
      );
  }
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
  const files = parseFiles(patch);
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
    viewed: [],
    updatedAt: new Date().toISOString(),
  };
  for (const file of files) {
    if (
      !file.hunks.length ||
      !["change", "rename-changed", "rename-pure"].includes(file.type)
    )
      continue;
    const oldName = file.prevName ?? file.name;
    const oldContents = await git(repo, ["show", `${mergeBase}:${oldName}`]);
    let newContents: string;
    if (worktree) {
      const path = resolve(worktree, file.name);
      if (!path.startsWith(resolve(worktree) + "/"))
        throw new Error("Invalid diff path.");
      newContents = (await lstat(path)).isSymbolicLink()
        ? await readlink(path)
        : await readFile(path, "utf8");
    } else newContents = await git(repo, ["show", `${head}:${file.name}`]);
    for (const [contents, expected] of [
      [oldContents, file.prevObjectId],
      [newContents, file.newObjectId],
    ] as const) {
      const hash = createHash("sha1")
        .update(`blob ${Buffer.byteLength(contents)}\0`)
        .update(contents)
        .digest("hex");
      if (!expected || !hash.startsWith(expected))
        throw new Error(
          "Local files changed while loading. Refresh to take a new snapshot.",
        );
    }
    await writeContext(store.path(id), file.name, {
      oldFile:
        file.type === "rename-pure"
          ? null
          : { name: oldName, contents: oldContents },
      newFile: { name: file.name, contents: newContents },
    });
  }
  if (worktree && (await git(worktree, ["rev-parse", "HEAD"])).trim() !== head)
    throw new Error(
      "The checked-out commit changed while loading. Refresh the local diff.",
    );
  return withGeneratedFiles(review);
}
