import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listBranches, listBranchAuthors, listBranchCommits, loadBranchCommit, loadBranchReview } from "./branches";
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
    assert.deepEqual((await listBranchCommits("feature", 0, repo)).commits.map(x => x.sha), [second, first]);
    assert.equal((await listBranches(repo)).length, 2);
    await assert.rejects(loadBranchCommit("feature", "HEAD", store, repo));
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test("author filters cover full history, deduplicate emails across names, match literal emails, and paginate filtered commits", async () => {
  const repo = await mkdtemp(join(tmpdir(), "branch-authors-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
  try {
    await git("init", "-b", "feature");
    await git("config", "user.name", "Reviewer");
    await git("config", "user.email", "reviewer@example.com");
    const alice = "Alice (QA) <alice+qa@example.com>";
    const bob = "Bob <bob@example.com>";
    const aliceEmail = "alice+qa@example.com";
    const bobEmail = "bob@example.com";
    await git("commit", "--allow-empty", "--author", alice, "-m", "older Alice commit");
    await git("commit", "--allow-empty", "--author", "Alice Alias <alice+qa@example.com>", "-m", "alias commit");
    for (let i = 0; i < 101; i++)
      await git("commit", "--allow-empty", "--author", bob, "-m", `Bob ${i}`);
    assert.deepEqual(await listBranchAuthors("feature", repo), [aliceEmail, bobEmail]);
    const filtered = await listBranchCommits("feature", 0, repo, aliceEmail);
    assert.equal(filtered.commits.length, 2);
    assert.equal(filtered.commits[1].subject, "older Alice commit");
    assert.equal(filtered.commits[1].author, alice);
    assert.equal(filtered.more, false);
    const search = await listBranchCommits("feature", 0, repo, undefined, "OLDER ALICE");
    assert.equal(search.commits.length, 1);
    assert.equal(search.commits[0].subject, "older Alice commit");
    assert.equal((await listBranchCommits("feature", 0, repo, bobEmail, "older Alice")).commits.length, 0);
    assert.equal((await listBranchCommits("feature", 0, repo, undefined, search.commits[0].sha.slice(0, 12))).commits[0].sha, search.commits[0].sha);
    assert.equal((await listBranchCommits("feature", 0, repo, undefined, ".*")).commits.length, 0);
    assert.equal((await listBranchCommits("feature", 0, repo, bobEmail, "Bob")).more, true);
    assert.equal((await listBranchCommits("feature", 100, repo, bobEmail, "Bob")).commits.length, 1);
    assert.equal((await listBranchCommits("feature", 0, repo, bobEmail)).more, true);
    const next = await listBranchCommits("feature", 100, repo, bobEmail);
    assert.equal(next.commits.length, 1);
    assert.equal(next.more, false);
    assert.equal((await listBranchCommits("feature", 0, repo, ".*")).commits.length, 0);
    assert.equal((await listBranchCommits("feature", 0, repo)).commits.length, 100);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});


test("merged branch commits appear in the list, search, and author filter without including unmerged branches", async () => {
  const repo = await mkdtemp(join(tmpdir(), "branch-merged-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args])).stdout.trim();
  try {
    await git("init", "-b", "main");
    await git("config", "user.name", "Reviewer");
    await git("config", "user.email", "reviewer@example.com");
    await git("commit", "--allow-empty", "-m", "root");
    await git("checkout", "-b", "topic");
    await git("commit", "--allow-empty", "--author", "Contributor <contributor@example.com>", "-m", "merged feature");
    const merged = await git("rev-parse", "HEAD");
    await git("checkout", "main");
    await git("merge", "--no-ff", "topic", "-m", "merge topic");
    await git("checkout", "-b", "unmerged");
    await git("commit", "--allow-empty", "--author", "Unmerged <unmerged@example.com>", "-m", "unmerged feature");
    const unmerged = await git("rev-parse", "HEAD");
    const commits = (await listBranchCommits("main", 0, repo)).commits;
    assert.equal(commits.length, 3);
    assert.ok(commits.some(commit => commit.sha === merged));
    assert.ok(!commits.some(commit => commit.sha === unmerged));
    assert.deepEqual(await listBranchAuthors("main", repo), ["contributor@example.com", "reviewer@example.com"]);
    const filtered = await listBranchCommits("main", 0, repo, "contributor@example.com", "merged feature");
    assert.deepEqual(filtered.commits.map(commit => commit.sha), [merged]);
    const bySha = await listBranchCommits("main", 0, repo, undefined, merged.slice(0, 12));
    assert.deepEqual(bySha.commits.map(commit => commit.sha), [merged]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
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
