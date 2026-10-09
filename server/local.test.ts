import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalReview } from "./local";
import { ReviewStore } from "./store";
import { parseFiles } from "../shared/diff";
import { readContext } from "./context";

const execute = promisify(execFile);
async function fixture(
  run: (
    repo: string,
    store: ReviewStore,
    git: (...args: string[]) => Promise<string>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "local-review-"));
  const repo = join(root, "repo");
  const git = async (...args: string[]) =>
    (await execute("git", ["-C", repo, ...args])).stdout;
  try {
    await execute("git", ["init", "-b", "main", repo]);
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.com");
    await git(
      "remote",
      "add",
      "origin",
      "git@github.com:acme/widgets.git",
    );
    await writeFile(
      join(repo, "example.txt"),
      Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join(""),
    );
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    await git("checkout", "-b", "feature");
    await writeFile(
      join(repo, "example.txt"),
      (await readFile(join(repo, "example.txt"), "utf8")).replace(
        "line 20",
        "unpushed",
      ),
    );
    await git("commit", "-am", "local commit");
    await run(repo, new ReviewStore(join(root, "reviews")), git);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const pull = {
  number: 1,
  title: "Local PR",
  url: "https://github.com/acme/widgets/pull/1",
  headRefName: "feature",
  baseRefName: "main",
  isCrossRepository: false,
  isDraft: false,
  updatedAt: "",
};

test("local snapshots include unpushed, staged, unstaged and untracked changes without modifying the index", async () =>
  fixture(async (repo, store, git) => {
    await writeFile(join(repo, "staged.txt"), "staged\n");
    await git("add", "staged.txt");
    await writeFile(
      join(repo, "example.txt"),
      (await readFile(join(repo, "example.txt"), "utf8")).replace(
        "line 21",
        "unstaged",
      ),
    );
    await writeFile(join(repo, "new file.txt"), "untracked\n");
    await writeFile(join(repo, "ignored.txt"), "ignored\n");
    const before = await git("status", "--porcelain");
    const review = await loadLocalReview(pull, store, repo);
    assert.equal(review.source.kind, "local");
    assert.match(review.patch, /\+unpushed/);
    assert.match(review.patch, /\+unstaged/);
    assert.deepEqual(
      parseFiles(review.patch)
        .map((file) => file.name)
        .sort(),
      ["example.txt", "new file.txt", "staged.txt"],
    );
    assert.equal(await git("status", "--porcelain"), before);
    const context = await readContext(store.path(review.id), "example.txt");
    assert.match(context!.newFile.contents, /unstaged/);
    await store.save(review);
    assert.equal((await loadLocalReview(pull, store, repo)).id, review.id);
    await writeFile(join(repo, "example.txt"), "later changes\n");
    assert.notEqual((await loadLocalReview(pull, store, repo)).id, review.id);
    assert.match(
      (await readContext(store.path(review.id), "example.txt"))!.newFile
        .contents,
      /unstaged/,
    );
  }));

test("a branch without a worktree uses committed changes and does not include another checkout's edits", async () =>
  fixture(async (repo, store, git) => {
    await git("checkout", "main");
    await writeFile(join(repo, "unrelated.txt"), "other checkout\n");
    const review = await loadLocalReview(pull, store, repo);
    assert.match(review.patch, /\+unpushed/);
    assert.doesNotMatch(review.patch, /unrelated/);
    assert.equal(
      review.source.kind === "local" && review.source.worktree,
      undefined,
    );
    assert.equal((await git("branch", "--show-current")).trim(), "main");
  }));

test("local review finds the matching linked worktree", async () =>
  fixture(async (repo, store, git) => {
    await git("checkout", "main");
    const linked = join(repo, "..", "linked");
    await git("worktree", "add", linked, "feature");
    await writeFile(
      join(linked, "example.txt"),
      (await readFile(join(linked, "example.txt"), "utf8")).replace(
        "line 21",
        "linked edit",
      ),
    );
    const review = await loadLocalReview(pull, store, repo);
    assert.match(review.patch, /linked edit/);
    assert.equal(
      review.source.kind === "local" && review.source.worktree,
      linked,
    );
    assert.doesNotMatch(
      await readFile(join(repo, "example.txt"), "utf8"),
      /linked edit/,
    );
  }));

test("generated-file rules respect overrides and the reviewed branch's attributes", async () =>
  fixture(async (repo, store, git) => {
    await writeFile(join(repo, ".gitattributes"), "*.txt linguist-generated=true\nexample.txt linguist-generated=false\n");
    await writeFile(join(repo, "generated.txt"), "generated\n");
    await git("add", ".");
    await git("commit", "-m", "generated rules");
    const committed = await loadLocalReview(pull, store, repo);
    assert.deepEqual(committed.generatedFiles, ["generated.txt"]);
    await store.save(committed);
    await writeFile(join(repo, ".gitattributes"), "*.txt linguist-generated=false\nexample.txt linguist-generated\n");
    const working = await loadLocalReview(pull, store, repo);
    assert.deepEqual(working.generatedFiles, ["example.txt"]);
    await git("restore", ".gitattributes");
    await git("checkout", "main");
    await writeFile(join(repo, ".gitattributes"), "*.txt linguist-generated=false\n");
    const cached = await loadLocalReview(pull, store, repo);
    assert.equal(cached.id, committed.id);
    assert.deepEqual(cached.generatedFiles, ["generated.txt"]);
  }));

test("fetches another PR without local branches, refreshes its refs, and leaves the checkout alone", async () =>
  fixture(async (repo, store, git) => {
    const remote = join(repo, "..", "remote.git");
    await execute("git", ["clone", "--bare", repo, remote]);
    const head = (await git("rev-parse", "feature")).trim();
    await execute("git", ["--git-dir", remote, "update-ref", "refs/pull/1/head", head]);
    await git("config", `url.${remote}.insteadOf`, "git@github.com:acme/widgets.git");
    await git("checkout", "--detach");
    await git("branch", "-D", "feature", "main");
    await writeFile(join(repo, "untouched.txt"), "local edits\n");
    const before = await git("status", "--porcelain");
    const review = await loadLocalReview(pull, store, repo);
    assert.equal(review.revision, head);
    assert.equal(review.source.kind === "local" && review.source.worktree, undefined);
    assert.match(review.patch, /\+unpushed/);
    assert.doesNotMatch(review.patch, /local edits/);
    assert.equal(await git("status", "--porcelain"), before);
    assert.equal((await git("rev-parse", "HEAD")).trim(), head);
    assert.equal((await loadLocalReview(pull, store, repo)).id, review.id);
    await writeFile(join(repo, "example.txt"), "updated PR\n");
    await git("commit", "-am", "next remote commit");
    await git("push", remote, "HEAD:refs/pull/1/head");
    const newer = await loadLocalReview(pull, store, repo);
    assert.notEqual(newer.id, review.id);
    assert.match(newer.patch, /\+updated PR/);
    const fork = await loadLocalReview({ ...pull, isCrossRepository: true }, store, repo);
    assert.equal(fork.id, newer.id);
  }));

test("the base comes from origin, so a stale local main does not pull merged work into the review", async () =>
  fixture(async (repo, store, git) => {
    const base = (await git("rev-parse", "main")).trim();
    await git("checkout", "main");
    await writeFile(join(repo, "merged.txt"), "merged elsewhere\n");
    await git("add", ".");
    await git("commit", "-m", "merged to main");
    await git("checkout", "feature");
    await git("merge", "--no-edit", "main");
    const remote = join(repo, "..", "remote.git");
    await execute("git", ["clone", "--bare", repo, remote]);
    await git("config", `url.${remote}.insteadOf`, "git@github.com:acme/widgets.git");
    await git("branch", "-f", "main", base);
    const review = await loadLocalReview(pull, store, repo);
    assert.match(review.patch, /\+unpushed/);
    assert.doesNotMatch(review.patch, /merged elsewhere/);
  }));
