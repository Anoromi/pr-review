import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listBranches, loadBranchCommit, loadBranchReview, loadCommit, ownCommits } from "./branches";
import { ReviewStore } from "./store";
const exec = promisify(execFile);

test("commit reviews share branch comments and preserve original snapshots, including root commits", async () => {
  const repo = await mkdtemp(join(tmpdir(), "branch-review-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
  try {
    await git("init", "-b", "feature");
    await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.com");
    await writeFile(join(repo, "a.txt"), "first\n"); await git("add", "."); await git("commit", "-m", "first");
    const first = await git("rev-parse", "HEAD");
    await writeFile(join(repo, "a.txt"), "second\n"); await git("commit", "-am", "second");
    const second = await git("rev-parse", "HEAD");
    const store = new ReviewStore(join(repo, "reviews"));
    const a = await loadBranchCommit("feature", first, store, repo);
    assert.match(a.patch, /\+first/);
    await store.save({ ...a, comments: [{ id: "test", snapshotId: a.id, file: "a.txt", side: "additions", start: 1, end: 1, code: "first", body: "request", createdAt: new Date().toISOString() }] }, true);
    const b = await store.save(await loadBranchCommit("feature", second, store, repo));
    assert.match(b.patch, /-first\n\+second/);
    assert.equal(b.comments[0].snapshotId, a.id);
    assert.equal(store.prDirectory(a), store.prDirectory(b));
    await git("branch", "other");
    assert.notEqual(store.prDirectory(await loadBranchCommit("other", second, store, repo)), store.prDirectory(a));
    assert.equal((await listBranches(repo)).length, 2);
    await assert.rejects(loadBranchCommit("feature", "HEAD", store, repo));
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("combined branch reviews use the main merge base, refresh snapshots, and share branch comments", async () => {
  const repo = await mkdtemp(join(tmpdir(), "branch-combined-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
  try {
    await git("init", "-b", "main");
    await git("config", "user.name", "Reviewer");
    await git("config", "user.email", "reviewer@example.com");
    await writeFile(join(repo, "a.txt"), "base\n");
    await git("add", "."); await git("commit", "-m", "base");
    const base = await git("rev-parse", "HEAD");
    await git("checkout", "-b", "feature");
    await writeFile(join(repo, "a.txt"), "intermediate\n");
    await git("commit", "-am", "first change");
    const first = await git("rev-parse", "HEAD");
    await writeFile(join(repo, "a.txt"), "final\n");
    await git("commit", "-am", "second change");
    const head = await git("rev-parse", "HEAD");
    await git("checkout", "main");
    await writeFile(join(repo, "main-only.txt"), "upstream\n");
    await git("add", "."); await git("commit", "-m", "main advanced");
    const store = new ReviewStore(join(repo, "reviews"));
    const combined = await loadBranchReview("feature", store, repo);
    assert.equal(combined.baseRevision, base);
    assert.equal(combined.revision, head);
    assert.match(combined.patch, /-base\n\+final/);
    assert.doesNotMatch(combined.patch, /intermediate|main-only/);
    assert.equal(combined.source.kind === "local" && combined.source.branchComparison, true);
    assert.equal(combined.source.kind === "local" && combined.source.baseBranch, "main");
    const single = await loadBranchCommit("feature", first, store, repo);
    await store.save({ ...single, comments: [{ id: "note", snapshotId: single.id, file: "a.txt", side: "additions", start: 1, end: 1, code: "intermediate", body: "review", createdAt: new Date().toISOString() }] }, true);
    assert.equal((await store.save(combined)).comments[0].snapshotId, single.id);
    assert.notEqual(single.id, combined.id);
    assert.equal((await loadBranchReview("feature", store, repo)).id, combined.id);
    // The remote main is preferred even when the local main has moved onto the feature.
    await git("update-ref", "refs/remotes/origin/main", base);
    await git("reset", "--hard", head);
    const remote = await loadBranchReview("feature", store, repo);
    assert.equal(remote.source.kind === "local" && remote.source.baseBranch, "origin/main");
    assert.match(remote.patch, /-base\n\+final/);
    await git("checkout", "feature");
    await writeFile(join(repo, "a.txt"), "updated\n");
    await git("commit", "-am", "update");
    assert.notEqual((await loadBranchReview("feature", store, repo)).id, remote.id);
    await assert.rejects(loadBranchReview("missing", store, repo));
    await assert.rejects(loadBranchReview("../bad", store, repo));
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("a review's own commits stop at its base and skip merges; commit snapshots share its folder", async () => {
  const repo = await mkdtemp(join(tmpdir(), "branch-own-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
  try {
    await git("init", "-b", "main");
    await git("config", "user.name", "Reviewer"); await git("config", "user.email", "reviewer@example.com");
    await writeFile(join(repo, "a.txt"), "base\n"); await git("add", "."); await git("commit", "-m", "base");
    await git("checkout", "-b", "feature");
    await writeFile(join(repo, "a.txt"), "one\n"); await git("commit", "-am", "one");
    const one = await git("rev-parse", "HEAD");
    await git("checkout", "main");
    await writeFile(join(repo, "b.txt"), "main\n"); await git("add", "."); await git("commit", "-m", "main advanced");
    await git("checkout", "feature");
    await git("merge", "--no-ff", "main", "-m", "merge main");
    await writeFile(join(repo, "a.txt"), "two\n"); await git("commit", "-am", "two");
    const two = await git("rev-parse", "HEAD");
    const store = new ReviewStore(join(repo, "reviews"));
    const branch = await store.save(await loadBranchReview("feature", store, repo));
    assert.deepEqual((await ownCommits(branch)).map((commit) => [commit.sha, commit.subject]), [[one, "one"], [two, "two"]]);
    const commit = await loadCommit(branch, one, store);
    assert.equal(store.prDirectory(commit), store.prDirectory(branch));
    assert.match(commit.patch, /-base\n\+one/);
    // A PR's commit keeps the PR's source, so its comments stay with the PR.
    const pull = { ...branch, id: "f".repeat(24), source: { kind: "local" as const, url: "https://github.com/o/r/pull/1", repo, branch: "feature", baseBranch: "main" } };
    const pullCommit = await loadCommit(pull, two, store);
    assert.equal(store.prDirectory(pullCommit), store.prDirectory(pull));
    assert.equal(pullCommit.source.kind === "local" && pullCommit.source.commit, two);
    await assert.rejects(loadCommit(branch, "0".repeat(40), store));
  } finally { await rm(repo, { recursive: true, force: true }); }
});
