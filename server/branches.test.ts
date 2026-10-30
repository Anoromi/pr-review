import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { branchHead, listBranches, loadBranchCommit, loadBranchReview, loadCommit, ownCommits, parseObjects, worktreeState } from "./branches";
import { mapOutdated } from "./home";
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

test("a rewritten branch shows its new head, and a map written for the old diff is flagged with the head it was asked for", async () => {
  const repo = await mkdtemp(join(tmpdir(), "branch-moved-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
  try {
    await git("init", "-b", "main");
    // The store lives in the checkout; uncommitted files are part of a checked-out branch's review.
    await writeFile(join(repo, ".git/info/exclude"), "reviews/\n");
    await git("config", "user.name", "Reviewer"); await git("config", "user.email", "reviewer@example.com");
    await writeFile(join(repo, "a.txt"), "base\n"); await git("add", "."); await git("commit", "-m", "base");
    await git("checkout", "-b", "feature");
    await writeFile(join(repo, "a.txt"), "one\n"); await git("commit", "-am", "one");
    const store = new ReviewStore(join(repo, "reviews"));
    const old = await store.save(await loadBranchReview("feature", store, repo));
    assert.equal(await branchHead(old), old.revision);
    const directory = store.prDirectory(old);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "map-diff.patch"), old.patch);
    await writeFile(join(directory, "map-request.json"), JSON.stringify({ threadId: "t", title: "T", requestedAt: new Date().toISOString(), revision: old.revision }));
    assert.equal(await mapOutdated(store, old), null);
    await git("commit", "--amend", "-m", "one, rewritten");
    await writeFile(join(repo, "b.txt"), "two\n"); await git("add", "."); await git("commit", "-m", "two");
    const head = await git("rev-parse", "HEAD");
    assert.equal(await branchHead(old), head);
    const fresh = await store.save(await loadBranchReview("feature", store, repo));
    assert.equal(fresh.revision, head);
    assert.equal((await ownCommits(fresh)).length, 2);
    assert.deepEqual(await mapOutdated(store, fresh), { revision: old.revision });
    assert.equal(await branchHead({ ...fresh, source: { ...fresh.source, branch: "gone" } as typeof fresh.source }), null);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("a checked-out branch is reviewed as its worktree is, without touching its index or refs; other branches stay commit-only", async () => {
  const repo = await mkdtemp(join(tmpdir(), "branch-worktree-"));
  const worktree = `${repo}-feature`;
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
  const inWorktree = async (...args: string[]) => (await exec("git", ["-C", worktree, ...args])).stdout.trim();
  try {
    await git("init", "-b", "main");
    await git("config", "user.name", "Reviewer"); await git("config", "user.email", "reviewer@example.com");
    await writeFile(join(repo, ".gitignore"), "*.log\n");
    await writeFile(join(repo, "a.txt"), "base\n"); await writeFile(join(repo, "b.txt"), "base\n");
    await git("add", "."); await git("commit", "-m", "base");
    await git("branch", "parked");
    await git("worktree", "add", "-b", "feature", worktree);
    await writeFile(join(worktree, "a.txt"), "committed\n"); await inWorktree("commit", "-am", "commit");
    const head = await inWorktree("rev-parse", "HEAD");
    const store = new ReviewStore(join(repo, "reviews"));
    const clean = await loadBranchReview("feature", store, repo);
    assert.equal(clean.revision, head);
    assert.equal(clean.source.kind === "local" && clean.source.uncommitted, undefined);

    await writeFile(join(worktree, "a.txt"), "staged\n"); await inWorktree("add", "a.txt");
    await writeFile(join(worktree, "b.txt"), "unstaged\n");
    await writeFile(join(worktree, "new.txt"), "untracked\n");
    await writeFile(join(worktree, "debug.log"), "ignored\n");
    const status = await inWorktree("status", "--porcelain");
    const index = await readFile(join(repo, ".git/worktrees", basename(worktree), "index"));
    const refs = await git("for-each-ref");
    const dirty = await store.save(await loadBranchReview("feature", store, repo));
    assert.deepEqual(dirty.source.kind === "local" && dirty.source.uncommitted, { head, files: 3 });
    assert.match(dirty.patch, /\+staged/); assert.match(dirty.patch, /\+unstaged/); assert.match(dirty.patch, /\+untracked/);
    assert.doesNotMatch(dirty.patch, /ignored/);
    assert.equal(await git("rev-parse", `${dirty.revision}^`), head);
    // Nothing of the worktree's own state moved.
    assert.deepEqual(await readFile(join(repo, ".git/worktrees", basename(worktree), "index")), index);
    assert.equal(await git("for-each-ref"), refs);
    assert.equal(await inWorktree("status", "--porcelain"), status);
    // The same state is the same snapshot, so nothing reads as moved until a file changes.
    assert.equal((await loadBranchReview("feature", store, repo)).id, dirty.id);
    assert.equal(await branchHead(dirty), dirty.revision);
    // The uncommitted files are the review's last commit, reviewable on their own.
    const commits = await ownCommits(dirty);
    assert.deepEqual(commits.map((commit) => commit.sha), [head, dirty.revision]);
    const uncommitted = await loadCommit(dirty, dirty.revision, store);
    assert.match(uncommitted.patch, /-committed\n\+staged/);
    assert.doesNotMatch(uncommitted.patch, /\+committed/);

    const directory = store.prDirectory(dirty);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "map-diff.patch"), dirty.patch);
    await writeFile(join(directory, "map-request.json"), JSON.stringify({ threadId: "t", title: "T", requestedAt: new Date().toISOString(), revision: dirty.revision }));
    await writeFile(join(worktree, "new.txt"), "edited\n");
    assert.notEqual(await branchHead(dirty), dirty.revision);
    const edited = await loadBranchReview("feature", store, repo);
    assert.notEqual(edited.id, dirty.id);
    assert.deepEqual(await mapOutdated(store, edited), { revision: dirty.revision });

    // A branch checked out nowhere shows its commits only.
    const parked = await loadBranchReview("parked", store, repo);
    assert.equal(parked.revision, await git("rev-parse", "parked"));
    await writeFile(join(worktree, "c.txt"), "<<<<<<<\n");
    await inWorktree("add", "c.txt"); await inWorktree("commit", "-m", "c");
    await inWorktree("checkout", "-b", "side", "HEAD^"); await writeFile(join(worktree, "c.txt"), "other\n");
    await inWorktree("add", "c.txt"); await inWorktree("commit", "-m", "other c");
    await exec("git", ["-C", worktree, "merge", "feature"]).catch(() => undefined);
    await assert.rejects(loadBranchReview("side", store, repo), /merge conflicts/);
  } finally { await rm(repo, { recursive: true, force: true }); await rm(worktree, { recursive: true, force: true }); }
});

test("batch output splits by the byte sizes in its headers and fails on a missing object", () => {
  const blob = (contents: Buffer) => Buffer.concat([Buffer.from(`${"a".repeat(40)} blob ${contents.length}\n`), contents, Buffer.from("\n")]);
  const output = Buffer.concat([blob(Buffer.from("héllo\nwörld\n")), blob(Buffer.from("")), blob(Buffer.from("x\n0 blob 9\n"))]);
  assert.deepEqual(parseObjects(output, ["a:1", "a:2", "a:3"]), ["héllo\nwörld\n", "", "x\n0 blob 9\n"]);
  assert.throws(() => parseObjects(Buffer.from("a:gone missing\n"), ["a:gone"]), /could not read a:gone: a:gone missing/);
  assert.throws(() => parseObjects(output.subarray(0, 30), ["a:1"]), /could not read a:1/);
  assert.throws(() => parseObjects(output.subarray(0, 55), ["a:1"]), /cut short/);
});

test("a worktree's state is reused until a listed file, the index or HEAD changes", async () => {
  const repo = await mkdtemp(join(tmpdir(), "worktree-state-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
  try {
    await git("init", "-b", "main");
    await git("config", "user.name", "Reviewer"); await git("config", "user.email", "reviewer@example.com");
    await writeFile(join(repo, "a.txt"), "base\n"); await git("add", "."); await git("commit", "-m", "base");
    await writeFile(join(repo, "a.txt"), "one\n");
    const first = await worktreeState(repo);
    assert.equal(await worktreeState(repo), first);
    // Same size, already modified: git status reads the same, the file does not.
    await writeFile(join(repo, "a.txt"), "two\n");
    const edited = await worktreeState(repo);
    assert.notEqual(edited.commit, first.commit);
    assert.equal(await worktreeState(repo), edited);
    await git("add", "a.txt"); await git("commit", "-m", "two");
    assert.deepEqual(await worktreeState(repo), { commit: await git("rev-parse", "HEAD"), head: await git("rev-parse", "HEAD"), files: 0 });
  } finally { await rm(repo, { recursive: true, force: true }); }
});
