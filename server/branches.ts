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
export async function listBranchAuthors(branch: string, repo = branchRepo()) {
  const ref = await branchRef(repo, branch);
  const rows = (await git(repo, "log", "--format=%ae", ref, "--")).trim().split("\n").filter(Boolean);
  return [...new Set(rows)].sort((a, b) => a.localeCompare(b));
}
export async function listBranchCommits(branch: string, skip = 0, repo = branchRepo(), author?: string, search = "") {
  const ref = await branchRef(repo, branch);
  const filter = author ? ["--extended-regexp", `--author=<${author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>$`] : [];
  const pagination = search ? [] : ["--max-count=101", `--skip=${skip}`];
  const rows = (await git(repo, "log", ...filter, "--format=%H%x09%cs%x09%an <%ae>%x09%s", ...pagination, ref, "--")).trim().split("\n").filter(Boolean);
  const commits = rows.map((row) => {
    const [sha, date, author, ...subject] = row.split("\t");
    return { sha, date, author, subject: subject.join("\t") };
  });
  const query = search.toLowerCase();
  const matches = search
    ? commits.filter((commit) => commit.sha.includes(query) || commit.subject.toLowerCase().includes(query)).slice(skip, skip + 101)
    : commits;
  return { more: matches.length > 100, commits: matches.slice(0, 100) };
}
export async function loadBranchCommit(branch: string, commit: string, store: ReviewStore, repo = branchRepo()): Promise<Review> {
  repo = resolve(repo);
  const ref = await branchRef(repo, branch);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Select a commit from this branch.");
  await git(repo, "merge-base", "--is-ancestor", commit, ref);
  const parents = (await git(repo, "rev-list", "--parents", "-n", "1", commit)).trim().split(" ");
  const base = parents[1] ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  return loadBranchSnapshot(repo, branch, commit, base, "", store);
}

export async function loadBranchReview(branch: string, store: ReviewStore, repo = branchRepo()): Promise<Review> {
  repo = resolve(repo);
  const ref = await branchRef(repo, branch);
  const commit = (await git(repo, "rev-parse", "--verify", `${ref}^{commit}`)).trim();
  const remoteMain = (await git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/main")).trim();
  const baseBranch = remoteMain ? "origin/main" : "main";
  const main = remoteMain || await branchRef(repo, "main");
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
  const patch = await git(repo, "diff", "--no-ext-diff", "--no-textconv", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", base, commit, "--");
  const id = createHash("sha256").update(JSON.stringify([repo, branch, commit, base, ...(baseBranch ? [baseBranch] : [])])).digest("hex").slice(0, 24);
  const review: Review = {
    id, title: baseBranch ? `${branch} vs ${baseBranch}` : `${branch}: ${(await git(repo, "show", "-s", "--format=%s", commit)).trim()}`,
    source: { kind: "local", url: branchUrl(repo, branch), repo, branch, baseBranch, commit, branchReview: true, branchComparison: Boolean(baseBranch) },
    revision: commit, baseRevision: base, patch, comments: [], viewed: [], updatedAt: new Date().toISOString(),
  };
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
